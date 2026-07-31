import type { MiddlewareHandler } from 'hono';
import type { AppContext } from '../types';
import { run, nowSec, newId } from '../db/client';
import { appendAudit } from '../lib/audit-chain';
import { emit } from '../services/events';

/**
 * Honeytokens.
 *
 * Almost every control in this backend tries to stop an attacker getting in.
 * This one assumes they already have, and answers a different question: how
 * would you find out?
 *
 * That question is the weak point of most security programmes. Median dwell time
 * — the gap between compromise and detection — is measured in weeks. Not because
 * the controls were absent, but because nothing in a normal system is
 * *surprising* when touched. Logs fill with legitimate traffic and the one
 * anomalous request is indistinguishable from noise.
 *
 * A honeytoken is a thing with no legitimate reason to ever be accessed. There
 * is no false positive: a request for `/wp-admin` on a site with no WordPress,
 * or a login attempt against an account that exists only as bait, was not
 * someone clicking the wrong link. Signal-to-noise is effectively perfect, which
 * is what makes this worth its very small cost.
 *
 * Two categories here:
 *
 *  1. **Reconnaissance decoys** — paths every automated scanner probes. High
 *     volume, low value individually; useful as a rate signal and for putting a
 *     scanner's IP into the log before it finds something real.
 *  2. **Post-compromise canaries** — an admin account and an API key that appear
 *     in the database but are never issued to anyone. If either is used, someone
 *     has read your database. That is the alert you actually want, and nothing
 *     else in this codebase would tell you.
 */

/**
 * Paths that only a scanner asks for. Not exhaustive on purpose — the aim is a
 * reliable signal, not to enumerate every scanner signature, which is a losing
 * game.
 */
const DECOY_PATHS = [
  '/wp-admin', '/wp-login.php', '/wordpress',
  '/.env', '/.env.local', '/.env.production',
  '/.git/config', '/.git/HEAD',
  '/config.json', '/config.php', '/configuration.php',
  '/admin.php', '/administrator', '/phpmyadmin', '/pma',
  '/.aws/credentials', '/.ssh/id_rsa',
  '/backup.sql', '/dump.sql', '/database.sql',
  '/api/v1/users/export', '/api/internal', '/api/debug',
  '/actuator/env', '/server-status',
  '/vendor/phpunit', '/cgi-bin',
];

/**
 * Severity, so a scanner hitting `/wp-admin` does not page anyone, while a
 * request for `/.env` — which only matters if it succeeds — is treated as the
 * more serious signal it is.
 */
function severityFor(path: string): 'low' | 'high' {
  return /\.env|\.git|\.aws|\.ssh|\.sql|credentials|id_rsa/.test(path) ? 'high' : 'low';
}

export const honeytokenGuard: MiddlewareHandler<AppContext> = async (c, next) => {
  const path = new URL(c.req.url).pathname.toLowerCase();

  const hit = DECOY_PATHS.find((p) => path === p || path.startsWith(`${p}/`));
  if (!hit) return next();

  const severity = severityFor(hit);
  const db = c.get('db');
  const now = nowSec();

  c.get('log').warn('honeytoken_triggered', {
    kind: 'decoy_path', path: hit, severity,
    ua: (c.req.header('user-agent') ?? '').slice(0, 120),
  });

  await run(db,
    `INSERT INTO honeytoken_hits (id, kind, token, path, ip_hash, user_agent, country, severity, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [newId('hny'), 'decoy_path', hit, path, c.get('ipHash'),
     (c.req.header('user-agent') ?? '').slice(0, 300),
     (c.req.raw as { cf?: { country?: string } }).cf?.country ?? null, severity, now],
  ).catch(() => {});

  if (severity === 'high') {
    await emit(db, c.env, 'security.anomaly', {
      kind: 'honeytoken', token: hit, severity, ip_hash: c.get('ipHash'),
    }, c.get('requestId')).catch(() => {});
  }

  /**
   * Answer exactly as a real 404 does.
   *
   * A distinctive response — a delay, a different body, a 403 — tells the
   * scanner it found something, which is the opposite of the goal. The point is
   * that the attacker learns nothing and you learn everything.
   */
  return c.json({
    error: { code: 'not_found', message: 'No route matches that path.', request_id: c.get('requestId') },
  }, 404);
};

/**
 * Check a submitted credential against the canary set.
 *
 * Called from the login path *before* the real lookup. A canary account's
 * credentials exist only in the database — they are never issued, never
 * documented, never in a password manager. Use of one is unambiguous proof that
 * someone has read the database, and it is frequently the only signal that
 * exists after a successful data theft.
 *
 * Returns true when it was a canary, and the caller should then behave exactly
 * as it would for any other failed login. Nothing must distinguish the two.
 */
export async function checkCanaryCredential(
  c: Parameters<MiddlewareHandler<AppContext>>[0],
  email: string,
): Promise<boolean> {
  const db = c.get('db');
  const normalised = email.trim().toLowerCase();

  const isCanary = await db.execute({
    sql: `SELECT 1 FROM honeytokens WHERE kind = 'canary_account' AND token = ? AND active = 1 LIMIT 1`,
    args: [normalised],
  }).then((r) => r.rows.length > 0).catch(() => false);

  if (!isCanary) return false;

  const now = nowSec();
  c.get('log').error('canary_account_used', { severity: 'critical' });

  await run(db,
    `INSERT INTO honeytoken_hits (id, kind, token, path, ip_hash, user_agent, country, severity, created_at)
     VALUES (?,?,?,?,?,?,?,'critical',?)`,
    [newId('hny'), 'canary_account', normalised, '/api/auth/login', c.get('ipHash'),
     (c.req.header('user-agent') ?? '').slice(0, 300),
     (c.req.raw as { cf?: { country?: string } }).cf?.country ?? null, now],
  ).catch(() => {});

  await appendAudit(db, {
    actorType: 'system', action: 'security.canary_triggered',
    entity: 'honeytoken', entityId: normalised,
    after: { severity: 'critical', meaning: 'A credential that exists only in the database was used. Assume the database has been read.' },
    ipHash: c.get('ipHash'), requestId: c.get('requestId'),
  }).catch(() => {});

  await emit(db, c.env, 'security.anomaly', {
    kind: 'canary_account', severity: 'critical', ip_hash: c.get('ipHash'),
    action_required: 'Rotate all credentials and review recent database access.',
  }, c.get('requestId')).catch(() => {});

  return true;
}

/**
 * Seed the canary set. Run once at provisioning.
 *
 * The account must look ordinary in a database dump — `admin@`, `backup@` and
 * similar are exactly what an attacker greps for, which is the point, but the
 * password hash has to be a real hash of a real random password so it does not
 * stand out as obviously fake.
 */
export const CANARY_SEED_SQL = `
-- Bait credentials. Never issued, never documented, never used legitimately.
-- Any use means the database has been read.
INSERT OR IGNORE INTO honeytokens (id, kind, token, note, active, created_at) VALUES
  ('hny_seed_1', 'canary_account', 'admin@{{SITE_DOMAIN}}',        'Bait admin account', 1, unixepoch()),
  ('hny_seed_2', 'canary_account', 'backup@{{SITE_DOMAIN}}',       'Bait service account', 1, unixepoch()),
  ('hny_seed_3', 'canary_api_key', 'sk_live_{{RANDOM_32}}',        'Bait key, looks like Stripe', 1, unixepoch());
`.trim();
