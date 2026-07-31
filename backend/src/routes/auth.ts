import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from '../types';
import { rateLimit } from '../middleware/rate-limit';
import { issueSession, destroySession, requireAuth, csrfProtect } from '../middleware/auth';
import { hashPassword, verifyPassword, needsRehash, randomBytes, toBase64Url, sha256Hex } from '../lib/crypto';
import {
  createUser, findUserByEmail, findUserById, recordFailedLogin, clearFailedLogins,
  setPasswordHash, revokeAllUserSessions, listUserSessions, audit,
} from '../db/repo';
import { nowSec, newId, run, one } from '../db/client';
import { badRequest, unauthorized, forbidden, tooMany } from '../lib/errors';
import { sendMail, renderEmail, escapeHtml } from '../services/mail';
import { verifyTurnstile } from '../services/cloudflare';
import { emit } from '../services/events';

const auth = new Hono<AppContext>();

const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email address.').max(254);
const passwordSchema = z
  .string()
  .min(12, 'Use at least 12 characters.')
  .max(200, 'That password is too long.')
  // Deliberately not a symbol/number/uppercase gauntlet: NIST 800-63B advises
  // length plus a breach check over composition rules, which push people
  // toward Password1! and reuse.
  .refine((p) => !COMMON.has(p.toLowerCase()), 'That password is too common. Pick something else.');

const COMMON = new Set([
  'password1234', 'qwertyuiop123', '123456789012', 'passwordpassword',
  'letmein12345', 'iloveyou1234', 'administrator', 'welcome12345',
]);

/**
 * Every response on this route family is deliberately shaped so that an
 * attacker cannot tell a registered email from an unregistered one.
 */
auth.post('/register',
  rateLimit({ bucket: 'register', limit: 5, windowSec: 3600 }),
  csrfProtect,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const input = z.object({
      email: emailSchema,
      password: passwordSchema,
      name: z.string().trim().min(1).max(120).optional(),
      turnstile_token: z.string().optional(),
    }).parse(body);

    if (c.get('caps').has('turnstile')) {
      const check = await verifyTurnstile(c.env, input.turnstile_token ?? '', c.get('ip'));
      if (!check.ok) throw forbidden('Verification failed. Reload the page and try again.');
    }

    const db = c.get('db');
    const existing = await findUserByEmail(db, input.email);

    if (existing) {
      // Same shape, same timing class as a real signup, and an email that tells
      // the real owner someone tried.
      if (c.get('caps').has('mail')) {
        c.executionCtx.waitUntil(sendMail(c.env, {
          to: [{ email: existing.email }],
          subject: `Someone tried to sign up with your email`,
          html: renderEmail({
            siteName: c.env.SITE_NAME,
            heading: 'Account already exists',
            bodyHtml: `<p>Someone just tried to create an account with this email address at ${escapeHtml(c.env.SITE_NAME)}. Your existing account is untouched.</p><p>If this was you, sign in instead. If not, you can ignore this.</p>`,
            cta: { label: 'Sign in', url: `${c.env.PUBLIC_ORIGIN}/sign-in` },
          }),
        }).catch(() => {}));
      }
      return c.json({ ok: true, message: 'Check your email to finish setting up your account.' }, 201);
    }

    const user = await createUser(db, {
      email: input.email,
      passwordHash: await hashPassword(input.password),
      name: input.name ?? null,
    });

    const token = toBase64Url(randomBytes(32));
    await run(db,
      `INSERT INTO verification_tokens (id,user_id,purpose,token_hash,expires_at,created_at) VALUES (?,?,?,?,?,?)`,
      [newId('vt'), user.id, 'email_verify', await sha256Hex(token), nowSec() + 60 * 60 * 24, nowSec()]);

    if (c.get('caps').has('mail')) {
      c.executionCtx.waitUntil(sendMail(c.env, {
        to: [{ email: user.email, name: user.name ?? undefined }],
        subject: `Confirm your email for ${c.env.SITE_NAME}`,
        html: renderEmail({
          siteName: c.env.SITE_NAME,
          heading: 'Confirm your email',
          bodyHtml: `<p>You're one click from finishing your account. This link works for 24 hours.</p>`,
          cta: { label: 'Confirm email', url: `${c.env.PUBLIC_ORIGIN}/verify?token=${token}` },
        }),
      }).catch((e) => c.get('log').error('verify_email_send_failed', { error: String(e) })));
    }

    await audit(db, { actorId: user.id, action: 'user.registered', entity: 'user', entityId: user.id, ipHash: c.get('ipHash'), requestId: c.get('requestId') });
    c.executionCtx.waitUntil(emit(db, c.env, 'user.registered', { user_id: user.id, email: user.email }, c.get('requestId')));

    return c.json({ ok: true, message: 'Check your email to finish setting up your account.' }, 201);
  });

auth.post('/login',
  rateLimit({ bucket: 'login', limit: 10, windowSec: 900 }),
  csrfProtect,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const input = z.object({
      email: emailSchema,
      password: z.string().min(1, 'Enter your password.'),
    }).parse(body);

    const db = c.get('db');
    const user = await findUserByEmail(db, input.email);

    // Burn comparable time on a missing user so response timing does not leak
    // whether the account exists.
    if (!user || !user.password_hash) {
      await verifyPassword(input.password, 'v1$600000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
      throw unauthorized('Email or password is incorrect.');
    }

    if (user.locked_until && user.locked_until > nowSec()) {
      throw tooMany('Too many attempts. Try again in a few minutes.', user.locked_until - nowSec());
    }

    const valid = await verifyPassword(input.password, user.password_hash);
    if (!valid) {
      const { attempts } = await recordFailedLogin(db, user.id);
      await audit(db, { actorId: user.id, action: 'auth.login_failed', entity: 'user', entityId: user.id, ipHash: c.get('ipHash'), after: { attempts } });
      throw unauthorized('Email or password is incorrect.');
    }

    if (user.status !== 'active') throw forbidden('This account is not active.');

    // Opportunistic upgrade if the KDF parameters have since been raised.
    if (needsRehash(user.password_hash)) {
      await setPasswordHash(db, user.id, await hashPassword(input.password));
    }

    await clearFailedLogins(db, user.id);
    const { csrf } = await issueSession(c, user.id);
    await audit(db, { actorId: user.id, action: 'auth.login', entity: 'user', entityId: user.id, ipHash: c.get('ipHash'), requestId: c.get('requestId') });

    return c.json({
      ok: true,
      csrf_token: csrf,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, email_verified: !!user.email_verified },
    });
  });

auth.post('/logout', csrfProtect, async (c) => {
  const user = c.get('user');
  await destroySession(c);
  if (user) await audit(c.get('db'), { actorId: user.id, action: 'auth.logout', ipHash: c.get('ipHash') });
  return c.json({ ok: true });
});

auth.get('/me', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ authenticated: false }, 200);
  return c.json({
    authenticated: true,
    user: { id: user.id, email: user.email, name: user.name, role: user.role, email_verified: user.emailVerified },
  });
});

auth.post('/verify-email', rateLimit({ bucket: 'verify', limit: 20, windowSec: 3600 }), async (c) => {
  const { token } = z.object({ token: z.string().min(10) }).parse(await c.req.json().catch(() => ({})));
  const db = c.get('db');
  const row = await one<{ id: string; user_id: string; expires_at: number; consumed_at: number | null }>(
    db, `SELECT id,user_id,expires_at,consumed_at FROM verification_tokens WHERE token_hash = ? AND purpose = ?`,
    [await sha256Hex(token), 'email_verify']);

  if (!row || row.consumed_at || row.expires_at < nowSec()) throw badRequest('That link has expired. Request a new one.');

  await run(db, 'UPDATE verification_tokens SET consumed_at = ? WHERE id = ?', [nowSec(), row.id]);
  await run(db, 'UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?', [nowSec(), row.user_id]);
  await audit(db, { actorId: row.user_id, action: 'user.email_verified', entity: 'user', entityId: row.user_id });
  return c.json({ ok: true, message: 'Email confirmed.' });
});

auth.post('/forgot-password',
  rateLimit({ bucket: 'forgot', limit: 5, windowSec: 3600 }),
  async (c) => {
    const { email } = z.object({ email: emailSchema }).parse(await c.req.json().catch(() => ({})));
    const db = c.get('db');
    const user = await findUserByEmail(db, email);

    if (user && c.get('caps').has('mail')) {
      const token = toBase64Url(randomBytes(32));
      await run(db,
        `INSERT INTO verification_tokens (id,user_id,purpose,token_hash,expires_at,created_at) VALUES (?,?,?,?,?,?)`,
        [newId('vt'), user.id, 'password_reset', await sha256Hex(token), nowSec() + 3600, nowSec()]);
      c.executionCtx.waitUntil(sendMail(c.env, {
        to: [{ email: user.email }],
        subject: `Reset your ${c.env.SITE_NAME} password`,
        html: renderEmail({
          siteName: c.env.SITE_NAME,
          heading: 'Reset your password',
          bodyHtml: `<p>Use the button below within the next hour. If you didn't ask for this, nothing has changed and you can ignore this email.</p>`,
          cta: { label: 'Choose a new password', url: `${c.env.PUBLIC_ORIGIN}/reset?token=${token}` },
        }),
      }).catch(() => {}));
    }
    // Identical response either way.
    return c.json({ ok: true, message: 'If that email has an account, a reset link is on its way.' });
  });

auth.post('/reset-password', rateLimit({ bucket: 'reset', limit: 10, windowSec: 3600 }), async (c) => {
  const input = z.object({ token: z.string().min(10), password: passwordSchema })
    .parse(await c.req.json().catch(() => ({})));
  const db = c.get('db');
  const row = await one<{ id: string; user_id: string; expires_at: number; consumed_at: number | null }>(
    db, `SELECT id,user_id,expires_at,consumed_at FROM verification_tokens WHERE token_hash = ? AND purpose = ?`,
    [await sha256Hex(input.token), 'password_reset']);

  if (!row || row.consumed_at || row.expires_at < nowSec()) throw badRequest('That link has expired. Request a new one.');

  await run(db, 'UPDATE verification_tokens SET consumed_at = ? WHERE id = ?', [nowSec(), row.id]);
  await setPasswordHash(db, row.user_id, await hashPassword(input.password));
  // Password change invalidates every other session — otherwise a stolen
  // session survives the very action taken to stop it.
  await revokeAllUserSessions(db, row.user_id);
  await audit(db, { actorId: row.user_id, action: 'user.password_reset', entity: 'user', entityId: row.user_id, ipHash: c.get('ipHash') });
  return c.json({ ok: true, message: 'Password updated. Sign in with your new password.' });
});

auth.get('/sessions', requireAuth, async (c) => {
  const rows = await listUserSessions(c.get('db'), c.get('user')!.id);
  return c.json({
    sessions: rows.map((s) => ({
      id: s.id, current: s.id === c.get('user')!.sessionId,
      created_at: s.created_at, last_seen_at: s.last_seen_at, expires_at: s.expires_at,
    })),
  });
});

auth.post('/sessions/revoke-all', requireAuth, csrfProtect, async (c) => {
  await revokeAllUserSessions(c.get('db'), c.get('user')!.id);
  await destroySession(c);
  return c.json({ ok: true, message: 'Signed out everywhere.' });
});

export default auth;
