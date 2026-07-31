import type { MiddlewareHandler } from 'hono';
import type { AppContext } from '../types';
import { one, run, nowSec, newId } from '../db/client';
import { sha256Hex } from '../lib/crypto';
import { appendAudit } from '../lib/audit-chain';

/**
 * Session binding and anomaly detection.
 *
 * Everything above this file assumes a session cookie in the request belongs to
 * the person it was issued to. This is the layer that questions that assumption.
 *
 * A stolen cookie is indistinguishable from a legitimate one by definition —
 * that is what makes it valuable. What is *not* identical is the context it
 * arrives in: a different device, a different country, a different network, all
 * within seconds of the last legitimate request. None of those signals is proof.
 * Each one is evidence.
 *
 * ## The calibration problem, and why this errs toward not logging people out
 *
 * The naive version binds the session to the IP address and kills it on change.
 * It is very effective against cookie theft and completely unusable in practice:
 * mobile users change IP walking between cells, corporate networks rotate egress
 * addresses, VPNs shift mid-session, and CGNAT means thousands of unrelated
 * people share one address anyway. Deployed as written, it logs out a large
 * fraction of legitimate users every day, they turn "remember me" into a support
 * burden, and eventually someone disables the whole control.
 *
 * So the response is graded:
 *
 *   - **User-agent change** → revoke. Browsers do not change engine mid-session.
 *     This one is close to a true positive, and the false-positive path (a
 *     browser auto-updating between requests) is rare and recoverable.
 *   - **ASN/country change** → do not revoke. Drop step-up elevation, notify the
 *     owner, record it. The attacker loses access to dangerous operations; the
 *     traveller stays logged in.
 *   - **New device on the account** → email the owner. Never silent. The
 *     notification is the control here, not the block.
 *
 * The value is in the record even when nothing is blocked: a compromise
 * investigated later is answerable from this table.
 */

const ANOMALY_NOTIFY_COOLDOWN_SEC = 3600;

export interface SessionSignals {
  ipHash: string;
  asn: string | null;
  country: string | null;
  uaHash: string;
}

async function fingerprint(c: Parameters<MiddlewareHandler<AppContext>>[0]): Promise<SessionSignals> {
  const cf = (c.req.raw as { cf?: Record<string, unknown> }).cf ?? {};
  const ua = c.req.header('user-agent') ?? '';

  // Hash the user-agent rather than storing it, and normalise the version number
  // out of it first. Chrome ships a new build every few weeks and a raw string
  // comparison would fire on every one of them — which is exactly the kind of
  // noise that gets a control switched off.
  const uaNormalised = ua
    .replace(/\d+\.\d+(\.\d+)*/g, 'V')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);

  return {
    ipHash: c.get('ipHash'),
    asn: cf.asn != null ? String(cf.asn) : null,
    country: typeof cf.country === 'string' ? cf.country : null,
    uaHash: await sha256Hex(uaNormalised),
  };
}

export type AnomalyVerdict =
  | { action: 'ok' }
  | { action: 'notify'; signals: string[] }
  | { action: 'revoke'; signals: string[]; reason: string };

/**
 * Runs after loadSession. Silent on the happy path.
 */
export const sessionAnomaly: MiddlewareHandler<AppContext> = async (c, next) => {
  const user = c.get('user');
  if (!user) return next();

  const db = c.get('db');
  const fp = await fingerprint(c);

  const stored = await one<{
    ip_hash: string | null; asn: string | null; country: string | null;
    ua_hash: string | null; anomaly_notified_at: number | null;
  }>(db,
    'SELECT ip_hash, asn, country, ua_hash, anomaly_notified_at FROM sessions WHERE id = ?',
    [user.sessionId],
  );

  // First request on a fresh session — record the baseline and move on.
  if (!stored?.ua_hash) {
    await run(db,
      'UPDATE sessions SET ip_hash = ?, asn = ?, country = ?, ua_hash = ? WHERE id = ?',
      [fp.ipHash, fp.asn, fp.country, fp.uaHash, user.sessionId],
    );
    await recordDevice(c, fp);
    return next();
  }

  const signals: string[] = [];
  let verdict: AnomalyVerdict = { action: 'ok' };

  if (stored.ua_hash !== fp.uaHash) {
    signals.push('user_agent_changed');
    verdict = {
      action: 'revoke', signals,
      reason: 'The browser presenting this session is not the one it was issued to.',
    };
  } else {
    if (stored.asn && fp.asn && stored.asn !== fp.asn) signals.push('network_changed');
    if (stored.country && fp.country && stored.country !== fp.country) signals.push('country_changed');
    if (stored.ip_hash !== fp.ipHash) signals.push('ip_changed');

    // An IP change on its own is background noise. A country change is worth
    // telling the account owner about, without breaking their session.
    if (signals.includes('country_changed')) verdict = { action: 'notify', signals };
  }

  if (verdict.action === 'revoke') {
    await run(db, 'UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ?',
      [nowSec(), 'anomaly:user_agent', user.sessionId]);
    await appendAudit(db, {
      actorType: 'system', actorId: user.id, action: 'session.revoked_anomaly',
      entity: 'session', entityId: user.sessionId,
      after: { signals, country: fp.country, asn: fp.asn },
      ipHash: fp.ipHash, requestId: c.get('requestId'),
    });
    c.get('log').warn('session_revoked_anomaly', { signals });

    // Deliberately not a specific error. Telling the caller *which* signal
    // tripped teaches an attacker exactly what to clone next time.
    return c.json({
      error: { code: 'session_invalid', message: 'Please sign in again.', request_id: c.get('requestId') },
    }, 401);
  }

  if (verdict.action === 'notify') {
    const last = stored.anomaly_notified_at ?? 0;
    // Rate-limited. A user on a train crossing a border repeatedly should not
    // receive forty emails, and an attacker should not be able to use the
    // notification path to flood the owner's inbox and bury the real alert.
    if (nowSec() - last > ANOMALY_NOTIFY_COOLDOWN_SEC) {
      await run(db, 'UPDATE sessions SET anomaly_notified_at = ? WHERE id = ?', [nowSec(), user.sessionId]);
      await appendAudit(db, {
        actorType: 'system', actorId: user.id, action: 'session.anomaly_notified',
        entity: 'session', entityId: user.sessionId,
        after: { signals, country: fp.country }, ipHash: fp.ipHash,
      });
      // Elevation does not survive a location change. The session continues;
      // its ability to refund money or change the email does not.
      await run(db, 'UPDATE sessions SET reauth_at = NULL, reauth_method = NULL WHERE id = ?', [user.sessionId]);
      c.get('log').info('session_anomaly_notify', { signals, country: fp.country });
    }
  }

  // Keep the moving signals current so a slow drift does not accumulate into a
  // spurious alert; the user-agent hash is left alone, since that is the one
  // that must not silently re-baseline.
  if (signals.length) {
    await run(db, 'UPDATE sessions SET ip_hash = ?, asn = ?, country = ? WHERE id = ?',
      [fp.ipHash, fp.asn, fp.country, user.sessionId]);
  }

  await next();
};

/**
 * Track distinct devices per account.
 *
 * The genuinely useful output is the "new device signed in" email — the control
 * users act on themselves, and often the first thing that tells someone their
 * password is out.
 */
async function recordDevice(
  c: Parameters<MiddlewareHandler<AppContext>>[0],
  fp: SessionSignals,
): Promise<void> {
  const user = c.get('user');
  if (!user) return;
  const db = c.get('db');
  const now = nowSec();

  const existing = await one<{ id: string; first_seen_at: number }>(db,
    'SELECT id, first_seen_at FROM known_devices WHERE user_id = ? AND ua_hash = ?',
    [user.id, fp.uaHash],
  );

  if (existing) {
    await run(db, 'UPDATE known_devices SET last_seen_at = ?, seen_count = seen_count + 1, country = ? WHERE id = ?',
      [now, fp.country, existing.id]);
    return;
  }

  await run(db,
    `INSERT INTO known_devices (id, user_id, ua_hash, country, asn, first_seen_at, last_seen_at, seen_count)
     VALUES (?,?,?,?,?,?,?,1)`,
    [newId('dev'), user.id, fp.uaHash, fp.country, fp.asn, now, now],
  );

  await appendAudit(db, {
    actorType: 'system', actorId: user.id, action: 'device.first_seen',
    entity: 'user', entityId: user.id,
    after: { country: fp.country, asn: fp.asn }, ipHash: fp.ipHash,
  });

  // The email is queued through the outbox rather than sent inline — a slow
  // mail provider must not add latency to a request the user is waiting on.
  await run(db,
    `INSERT INTO outbox (id, destination, event_type, payload, status, attempts, next_attempt_at, created_at)
     VALUES (?,?,?,?,'pending',0,?,?)`,
    [newId('obx'), 'mail', 'security.new_device',
     JSON.stringify({ user_id: user.id, email: user.email, country: fp.country, at: now }),
     now, now],
  );
}

export { fingerprint };
