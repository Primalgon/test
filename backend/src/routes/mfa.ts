import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from '../types';
import { requireAuth, csrfProtect } from '../middleware/auth';
import { requireStepUp, markReauthenticated, SENSITIVE } from '../middleware/step-up';
import { rateLimit } from '../middleware/rate-limit';
import { one, all, run, nowSec, newId } from '../db/client';
import { badRequest, forbidden, unauthorized, conflict, notImplemented } from '../lib/errors';
import { verifyPassword } from '../lib/crypto';
import { createCipher } from '../lib/encryption';
import {
  generateTotpSecret, totpUri, verifyTotp, base32Decode,
  generateRecoveryCodes, hashRecoveryCode, matchRecoveryCode,
} from '../lib/totp';
import { appendAudit } from '../lib/audit-chain';

/**
 * Two-factor authentication and step-up re-authentication.
 *
 * Enrolment is deliberately two-phase: `/setup` generates a secret and stores it
 * as *pending*, `/activate` requires a working code before MFA is switched on.
 * Enabling in one step is the classic way to lock a user out of their own
 * account — they scan a QR into an app that silently failed, log out, and now
 * neither they nor you can get back in.
 *
 * The TOTP secret is encrypted at rest. A shared secret sitting in plaintext
 * next to the password hash means a single database read hands over both factors
 * at once, which reduces MFA to decoration.
 */

const mfa = new Hono<AppContext>();

mfa.use('*', requireAuth);
mfa.use('*', csrfProtect);

/** AAD binds each ciphertext to its row and column — see lib/encryption.ts. */
const aadFor = (userId: string) => `users:${userId}:totp_secret`;

function cipherOrFail(env: { DATA_ENCRYPTION_KEYS?: string; BLIND_INDEX_KEY?: string }) {
  try {
    return createCipher(env);
  } catch {
    throw notImplemented('Two-factor authentication is not configured on this site (DATA_ENCRYPTION_KEYS missing).');
  }
}

/* ------------------------------------------------------------------ *
 * Status
 * ------------------------------------------------------------------ */

mfa.get('/status', async (c) => {
  const user = c.get('user')!;
  const row = await one<{ mfa_enabled: number; mfa_activated_at: number | null }>(
    c.get('db'), 'SELECT mfa_enabled, mfa_activated_at FROM users WHERE id = ?', [user.id],
  );
  const remaining = await one<{ n: number }>(
    c.get('db'), 'SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL', [user.id],
  );
  return c.json({
    enabled: !!row?.mfa_enabled,
    activated_at: row?.mfa_activated_at ?? null,
    recovery_codes_remaining: remaining?.n ?? 0,
  });
});

/* ------------------------------------------------------------------ *
 * Enrolment — phase 1
 * ------------------------------------------------------------------ */

mfa.post('/setup',
  rateLimit({ bucket: 'mfa_setup', limit: 5, windowSec: 900 }),
  requireStepUp({ action: 'set up two-factor authentication' }),
  async (c) => {
    const user = c.get('user')!;
    const db = c.get('db');
    const cipher = cipherOrFail(c.env);

    const existing = await one<{ mfa_enabled: number }>(db, 'SELECT mfa_enabled FROM users WHERE id = ?', [user.id]);
    if (existing?.mfa_enabled) {
      throw conflict('Two-factor authentication is already on. Turn it off before enrolling a new device.');
    }

    const { base32 } = generateTotpSecret();
    const encrypted = await cipher.encrypt(base32, aadFor(user.id));

    // Pending, not active. Nothing about login changes until /activate succeeds.
    await run(db,
      `UPDATE users SET mfa_pending_secret = ?, mfa_pending_at = ?, mfa_pending_counter = NULL WHERE id = ?`,
      [encrypted, nowSec(), user.id],
    );

    await appendAudit(db, {
      actorType: 'user', actorId: user.id, action: 'mfa.setup_started',
      entity: 'user', entityId: user.id, ipHash: c.get('ipHash'), requestId: c.get('requestId'),
    });

    return c.json({
      // The client renders the QR. Returning a pre-rendered image would mean
      // the secret transits an image pipeline and lands in a browser cache.
      otpauth_uri: totpUri({
        secretBase32: base32,
        account: user.email,
        issuer: c.env.SITE_NAME || 'Account',
      }),
      // For users whose authenticator cannot scan.
      manual_key: base32.match(/.{1,4}/g)?.join(' ') ?? base32,
      next: 'Enter the 6-digit code from your app to finish turning this on.',
    });
  },
);

/* ------------------------------------------------------------------ *
 * Enrolment — phase 2
 * ------------------------------------------------------------------ */

const codeSchema = z.object({ code: z.string().min(6).max(12) });

mfa.post('/activate',
  rateLimit({ bucket: 'mfa_activate', limit: 10, windowSec: 900 }),
  async (c) => {
    const user = c.get('user')!;
    const db = c.get('db');
    const cipher = cipherOrFail(c.env);
    const { code } = codeSchema.parse(await c.req.json());

    const row = await one<{ mfa_pending_secret: string | null; mfa_pending_at: number | null }>(
      db, 'SELECT mfa_pending_secret, mfa_pending_at FROM users WHERE id = ?', [user.id],
    );
    if (!row?.mfa_pending_secret) throw badRequest('Start enrolment first.');

    // An abandoned enrolment should not stay activatable forever.
    if (row.mfa_pending_at && nowSec() - row.mfa_pending_at > 900) {
      await run(db, 'UPDATE users SET mfa_pending_secret = NULL, mfa_pending_at = NULL WHERE id = ?', [user.id]);
      throw badRequest('Enrolment expired. Start again.');
    }

    const base32 = await cipher.decrypt(row.mfa_pending_secret, aadFor(user.id));
    const result = await verifyTotp({ secret: base32Decode(base32), code });

    if (!result.ok) {
      await appendAudit(db, {
        actorType: 'user', actorId: user.id, action: 'mfa.activate_failed',
        entity: 'user', entityId: user.id, after: { reason: result.reason }, ipHash: c.get('ipHash'),
      });
      throw badRequest(
        result.reason === 'format'
          ? 'Enter the 6 digits shown in your app.'
          : 'That code did not match. Check your phone\'s clock is set automatically, then try the next code.',
      );
    }

    // Recovery codes are generated here, at activation, and shown exactly once.
    const codes = generateRecoveryCodes(10);
    const now = nowSec();

    await run(db,
      `UPDATE users SET
         mfa_enabled = 1, mfa_secret = mfa_pending_secret, mfa_activated_at = ?,
         mfa_last_counter = ?, mfa_pending_secret = NULL, mfa_pending_at = NULL
       WHERE id = ?`,
      [now, result.counter, user.id],
    );
    await run(db, 'DELETE FROM recovery_codes WHERE user_id = ?', [user.id]);
    for (const rc of codes) {
      await run(db,
        'INSERT INTO recovery_codes (id, user_id, code_hash, created_at) VALUES (?,?,?,?)',
        [newId('rec'), user.id, await hashRecoveryCode(rc), now],
      );
    }

    // Enabling MFA invalidates other sessions. If the reason for enabling it is
    // that the account may already be compromised, leaving the attacker's
    // session alive makes the whole exercise pointless.
    await run(db,
      'UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL',
      [now, 'mfa_enabled', user.id, user.sessionId],
    );

    await appendAudit(db, {
      actorType: 'user', actorId: user.id, action: 'mfa.enabled',
      entity: 'user', entityId: user.id, ipHash: c.get('ipHash'), requestId: c.get('requestId'),
    });

    return c.json({
      enabled: true,
      recovery_codes: codes,
      warning: 'Save these now. Each works once, and they are the only way in if you lose your device. They will not be shown again.',
    });
  },
);

/* ------------------------------------------------------------------ *
 * Disable
 * ------------------------------------------------------------------ */

mfa.post('/disable',
  rateLimit({ bucket: 'mfa_disable', limit: 5, windowSec: 900 }),
  requireStepUp(SENSITIVE.disableMfa),
  async (c) => {
    const user = c.get('user')!;
    const db = c.get('db');

    await run(db,
      `UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, mfa_last_counter = NULL,
                        mfa_activated_at = NULL, mfa_pending_secret = NULL WHERE id = ?`,
      [user.id],
    );
    await run(db, 'DELETE FROM recovery_codes WHERE user_id = ?', [user.id]);

    await appendAudit(db, {
      actorType: 'user', actorId: user.id, action: 'mfa.disabled',
      entity: 'user', entityId: user.id, ipHash: c.get('ipHash'), requestId: c.get('requestId'),
    });

    // Turning MFA off is exactly what an attacker does after taking an account.
    // The owner gets told, whether or not it was them.
    await run(db,
      `INSERT INTO outbox (id, destination, event_type, payload, status, attempts, next_attempt_at, created_at)
       VALUES (?,?,?,?,'pending',0,?,?)`,
      [newId('obx'), 'mail', 'security.mfa_disabled',
       JSON.stringify({ user_id: user.id, email: user.email, at: nowSec() }), nowSec(), nowSec()],
    );

    return c.json({ enabled: false });
  },
);

/* ------------------------------------------------------------------ *
 * Recovery codes
 * ------------------------------------------------------------------ */

mfa.post('/recovery-codes/regenerate',
  rateLimit({ bucket: 'mfa_recovery', limit: 3, windowSec: 3600 }),
  requireStepUp(SENSITIVE.viewRecoveryCodes),
  async (c) => {
    const user = c.get('user')!;
    const db = c.get('db');
    const now = nowSec();

    const codes = generateRecoveryCodes(10);
    // Replace, never append. Codes the user has already printed and lost must
    // stop working, otherwise "regenerate" widens the attack surface instead of
    // narrowing it.
    await run(db, 'DELETE FROM recovery_codes WHERE user_id = ?', [user.id]);
    for (const rc of codes) {
      await run(db, 'INSERT INTO recovery_codes (id, user_id, code_hash, created_at) VALUES (?,?,?,?)',
        [newId('rec'), user.id, await hashRecoveryCode(rc), now]);
    }

    await appendAudit(db, {
      actorType: 'user', actorId: user.id, action: 'mfa.recovery_codes_regenerated',
      entity: 'user', entityId: user.id, ipHash: c.get('ipHash'),
    });

    return c.json({ recovery_codes: codes, replaced: true });
  },
);

/* ------------------------------------------------------------------ *
 * Step-up re-authentication
 * ------------------------------------------------------------------ */

const stepUpSchema = z.object({
  method: z.enum(['password', 'totp', 'recovery']),
  secret: z.string().min(1).max(200),
});

/**
 * Proves identity again inside an existing session. The frontend calls this when
 * any route answers 403 `step_up_required`, then retries the original request.
 */
mfa.post('/step-up',
  // Tight limit. This endpoint accepts a password and a TOTP code, so it is the
  // most attractive brute-force target in the whole API.
  rateLimit({ bucket: 'step_up', limit: 8, windowSec: 900 }),
  async (c) => {
    const user = c.get('user')!;
    const db = c.get('db');
    const input = stepUpSchema.parse(await c.req.json());

    const row = await one<{
      password_hash: string; mfa_enabled: number; mfa_secret: string | null; mfa_last_counter: number | null;
    }>(db,
      'SELECT password_hash, mfa_enabled, mfa_secret, mfa_last_counter FROM users WHERE id = ?', [user.id],
    );
    if (!row) throw unauthorized();

    let ok = false;

    if (input.method === 'password') {
      ok = await verifyPassword(input.secret, row.password_hash);
    } else if (input.method === 'totp') {
      if (!row.mfa_enabled || !row.mfa_secret) throw badRequest('Two-factor authentication is not enabled.');
      const cipher = cipherOrFail(c.env);
      const base32 = await cipher.decrypt(row.mfa_secret, aadFor(user.id));
      const result = await verifyTotp({
        secret: base32Decode(base32),
        code: input.secret,
        lastCounter: row.mfa_last_counter,
      });
      ok = result.ok;
      // Persisting the counter is what makes a code single-use.
      if (result.ok) {
        await run(db, 'UPDATE users SET mfa_last_counter = ? WHERE id = ?', [result.counter, user.id]);
      }
    } else {
      if (!row.mfa_enabled) throw badRequest('Two-factor authentication is not enabled.');
      const stored = await all<{ code_hash: string }>(db,
        'SELECT code_hash FROM recovery_codes WHERE user_id = ? AND used_at IS NULL', [user.id]);
      const matched = await matchRecoveryCode(input.secret, stored.map((r) => r.code_hash));
      if (matched) {
        await run(db, 'UPDATE recovery_codes SET used_at = ?, used_ip_hash = ? WHERE user_id = ? AND code_hash = ?',
          [nowSec(), c.get('ipHash'), user.id, matched]);
        ok = true;
      }
    }

    await appendAudit(db, {
      actorType: 'user', actorId: user.id,
      action: ok ? 'auth.step_up_succeeded' : 'auth.step_up_failed',
      entity: 'user', entityId: user.id, after: { method: input.method },
      ipHash: c.get('ipHash'), requestId: c.get('requestId'),
    });

    if (!ok) {
      c.get('log').warn('step_up_failed', { method: input.method });
      throw forbidden('That did not match.');
    }

    await markReauthenticated(c, input.method);

    const remaining = input.method === 'recovery'
      ? (await one<{ n: number }>(db,
          'SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL', [user.id]))?.n ?? 0
      : undefined;

    return c.json({
      confirmed: true,
      method: input.method,
      valid_for_seconds: 600,
      ...(remaining !== undefined ? {
        recovery_codes_remaining: remaining,
        ...(remaining <= 2 ? { warning: 'You are almost out of recovery codes. Generate a new set.' } : {}),
      } : {}),
    });
  },
);

/* ------------------------------------------------------------------ *
 * Devices
 * ------------------------------------------------------------------ */

mfa.get('/devices', async (c) => {
  const user = c.get('user')!;
  const rows = await all<{
    id: string; country: string | null; first_seen_at: number; last_seen_at: number; seen_count: number;
  }>(c.get('db'),
    `SELECT id, country, first_seen_at, last_seen_at, seen_count
     FROM known_devices WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT 50`,
    [user.id],
  );
  // No user-agent string returned — it is a fingerprinting vector and adds
  // nothing the user cannot get from the dates and locations.
  return c.json({ devices: rows });
});

export default mfa;
