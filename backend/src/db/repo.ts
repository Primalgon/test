import type { Client } from '@libsql/client/web';
import { all, one, run, batch, nowSec, newId } from './client';
import { conflict, notFound } from '../lib/errors';

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------
export interface UserRow {
  id: string; email: string; email_canonical: string; email_verified: number;
  password_hash: string | null; name: string | null; role: string; status: string;
  stripe_customer_id: string | null; failed_logins: number; locked_until: number | null;
  last_login_at: number | null; metadata: string; created_at: number; updated_at: number;
}

export const canonicalEmail = (e: string) => e.trim().toLowerCase();

export const findUserByEmail = (db: Client, email: string) =>
  one<UserRow>(db, 'SELECT * FROM users WHERE email_canonical = ? AND status != ?', [canonicalEmail(email), 'deleted']);

export const findUserById = (db: Client, id: string) =>
  one<UserRow>(db, 'SELECT * FROM users WHERE id = ? AND status != ?', [id, 'deleted']);

export async function createUser(
  db: Client,
  input: { email: string; passwordHash?: string | null; name?: string | null; role?: string },
): Promise<UserRow> {
  const existing = await findUserByEmail(db, input.email);
  if (existing) throw conflict('An account with that email already exists.');
  const id = newId('usr');
  const ts = nowSec();
  await run(
    db,
    `INSERT INTO users (id,email,email_canonical,password_hash,name,role,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [id, input.email.trim(), canonicalEmail(input.email), input.passwordHash ?? null,
     input.name ?? null, input.role ?? 'customer', ts, ts],
  );
  const created = await findUserById(db, id);
  if (!created) throw notFound('User creation failed.');
  return created;
}

/** Progressive lockout: 5 strikes, then a doubling backoff capped at 15 minutes. */
export async function recordFailedLogin(db: Client, userId: string) {
  const user = await findUserById(db, userId);
  const attempts = (user?.failed_logins ?? 0) + 1;
  const lockUntil = attempts >= 5
    ? nowSec() + Math.min(900, 2 ** (attempts - 5) * 30)
    : null;
  await run(db, 'UPDATE users SET failed_logins = ?, locked_until = ?, updated_at = ? WHERE id = ?',
    [attempts, lockUntil, nowSec(), userId]);
  return { attempts, lockUntil };
}

export const clearFailedLogins = (db: Client, userId: string) =>
  run(db, 'UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?',
    [nowSec(), nowSec(), userId]);

export const setPasswordHash = (db: Client, userId: string, hash: string) =>
  run(db, 'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [hash, nowSec(), userId]);

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------
export interface SessionRow {
  id: string; user_id: string; token_hash: string; csrf_hash: string;
  expires_at: number; absolute_expires_at: number; revoked_at: number | null;
  created_at: number; last_seen_at: number;
}

export const findSessionByTokenHash = (db: Client, tokenHash: string) =>
  one<SessionRow>(db, 'SELECT * FROM sessions WHERE token_hash = ? AND revoked_at IS NULL', [tokenHash]);

export async function insertSession(db: Client, s: {
  userId: string; tokenHash: string; csrfHash: string; ipHash: string | null;
  userAgent: string | null; ttlSec: number; absoluteTtlSec: number;
}) {
  const id = newId('ses');
  const ts = nowSec();
  await run(
    db,
    `INSERT INTO sessions (id,user_id,token_hash,csrf_hash,ip_hash,user_agent,expires_at,absolute_expires_at,created_at,last_seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [id, s.userId, s.tokenHash, s.csrfHash, s.ipHash, s.userAgent,
     ts + s.ttlSec, ts + s.absoluteTtlSec, ts, ts],
  );
  return id;
}

export const touchSession = (db: Client, id: string, newExpiry: number) =>
  run(db, 'UPDATE sessions SET last_seen_at = ?, expires_at = MIN(?, absolute_expires_at) WHERE id = ?',
    [nowSec(), newExpiry, id]);

export const revokeSession = (db: Client, id: string) =>
  run(db, 'UPDATE sessions SET revoked_at = ? WHERE id = ?', [nowSec(), id]);

export const revokeAllUserSessions = (db: Client, userId: string) =>
  run(db, 'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [nowSec(), userId]);

export const listUserSessions = (db: Client, userId: string) =>
  all<SessionRow>(db, 'SELECT * FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC',
    [userId, nowSec()]);

// ---------------------------------------------------------------------------
// webhook idempotency
// ---------------------------------------------------------------------------
/**
 * Returns false when this event id was already claimed. The uniqueness of the
 * INSERT is the lock, so two concurrent deliveries of the same Stripe event
 * cannot both proceed — important because Stripe retries aggressively and a
 * double-processed `checkout.session.completed` means a double fulfilment.
 */
export async function claimWebhookEvent(
  db: Client, id: string, provider: string, type: string, payloadHash: string,
): Promise<boolean> {
  try {
    await run(
      db,
      'INSERT INTO webhook_events (id,provider,type,status,payload_hash,received_at) VALUES (?,?,?,?,?,?)',
      [id, provider, type, 'processing', payloadHash, nowSec()],
    );
    return true;
  } catch (e) {
    const msg = String(e);
    if (msg.includes('UNIQUE') || msg.includes('PRIMARY KEY')) return false;
    throw e;
  }
}

export const completeWebhookEvent = (db: Client, id: string) =>
  run(db, 'UPDATE webhook_events SET status = ?, completed_at = ? WHERE id = ?', ['done', nowSec(), id]);

export const failWebhookEvent = (db: Client, id: string, error: string) =>
  run(db, 'UPDATE webhook_events SET status = ?, last_error = ?, attempts = attempts + 1 WHERE id = ?',
    ['failed', error.slice(0, 500), id]);

// ---------------------------------------------------------------------------
// orders
// ---------------------------------------------------------------------------
export interface OrderRow {
  id: string; user_id: string | null; email: string; status: string;
  amount_cents: number; amount_refunded_cents: number; currency: string;
  stripe_session_id: string | null; stripe_payment_intent: string | null;
  stripe_subscription_id: string | null; items: string; created_at: number; updated_at: number;
}

export async function upsertOrderFromSession(db: Client, o: {
  sessionId: string; email: string; userId: string | null; amountCents: number;
  currency: string; paymentIntent: string | null; subscriptionId: string | null;
  status: string; items: unknown;
}) {
  const ts = nowSec();
  await run(
    db,
    `INSERT INTO orders (id,user_id,email,status,amount_cents,currency,stripe_session_id,stripe_payment_intent,stripe_subscription_id,items,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(stripe_session_id) DO UPDATE SET
       status = excluded.status,
       stripe_payment_intent = COALESCE(excluded.stripe_payment_intent, orders.stripe_payment_intent),
       stripe_subscription_id = COALESCE(excluded.stripe_subscription_id, orders.stripe_subscription_id),
       user_id = COALESCE(orders.user_id, excluded.user_id),
       updated_at = excluded.updated_at`,
    [newId('ord'), o.userId, o.email, o.status, o.amountCents, o.currency, o.sessionId,
     o.paymentIntent, o.subscriptionId, JSON.stringify(o.items ?? []), ts, ts],
  );
  return one<OrderRow>(db, 'SELECT * FROM orders WHERE stripe_session_id = ?', [o.sessionId]);
}

export const setOrderStatusByPaymentIntent = (db: Client, pi: string, status: string, refunded = 0) =>
  run(db, 'UPDATE orders SET status = ?, amount_refunded_cents = ?, updated_at = ? WHERE stripe_payment_intent = ?',
    [status, refunded, nowSec(), pi]);

export const listOrders = (db: Client, limit: number, offset: number, status?: string) =>
  status
    ? all<OrderRow>(db, 'SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?', [status, limit, offset])
    : all<OrderRow>(db, 'SELECT * FROM orders ORDER BY created_at DESC LIMIT ? OFFSET ?', [limit, offset]);

// ---------------------------------------------------------------------------
// audit + outbox
// ---------------------------------------------------------------------------
export const audit = (db: Client, a: {
  actorId?: string | null; actorType?: string; action: string; entity?: string;
  entityId?: string; ipHash?: string | null; before?: unknown; after?: unknown; requestId?: string;
}) =>
  run(
    db,
    `INSERT INTO audit_log (id,actor_id,actor_type,action,entity,entity_id,ip_hash,before_json,after_json,request_id,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [newId('aud'), a.actorId ?? null, a.actorType ?? 'user', a.action, a.entity ?? null,
     a.entityId ?? null, a.ipHash ?? null,
     a.before ? JSON.stringify(a.before) : null,
     a.after ? JSON.stringify(a.after) : null,
     a.requestId ?? null, nowSec()],
  );

export const enqueueOutbox = (db: Client, destination: string, eventType: string, payload: unknown) =>
  run(db, 'INSERT INTO outbox (id,destination,event_type,payload,next_retry_at,created_at) VALUES (?,?,?,?,?,?)',
    [newId('obx'), destination, eventType, JSON.stringify(payload), nowSec(), nowSec()]);

export const dueOutbox = (db: Client, limit = 25) =>
  all(db, `SELECT * FROM outbox WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= ?)
           ORDER BY created_at LIMIT ?`, [nowSec(), limit]);

export const markOutboxSent = (db: Client, id: string) =>
  run(db, 'UPDATE outbox SET status = ?, sent_at = ? WHERE id = ?', ['sent', nowSec(), id]);

/** Exponential backoff, capped, with a dead-letter state after 8 attempts. */
export const markOutboxFailed = (db: Client, id: string, attempts: number, error: string) => {
  const dead = attempts >= 8;
  const delay = Math.min(3600, 2 ** attempts * 5);
  return run(db, 'UPDATE outbox SET status = ?, attempts = ?, last_error = ?, next_retry_at = ? WHERE id = ?',
    [dead ? 'dead' : 'pending', attempts, error.slice(0, 500), nowSec() + delay, id]);
};

export { batch, nowSec, newId };
