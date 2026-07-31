import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from '../types';
import { requireAuth, requireRole, csrfProtect } from '../middleware/auth';
import { requireStepUp, SENSITIVE } from '../middleware/step-up';
import { rateLimit } from '../middleware/rate-limit';
import { all, one, run, nowSec, newId } from '../db/client';
import { appendAudit, verifyChain, currentHead } from '../lib/audit-chain';
import { createCipher, mask } from '../lib/encryption';
import { badRequest, notFound } from '../lib/errors';

/**
 * Security operations: reporting, transparency, subject rights, and the
 * break-glass switch.
 *
 * The theme is that a control nobody can see the output of is a control nobody
 * maintains. CSP violations go nowhere by default, audit chains go unverified,
 * and "we can lock the site down" is only true if someone has tested the button.
 */

const security = new Hono<AppContext>();

/* ------------------------------------------------------------------ *
 * security.txt — RFC 9116
 * ------------------------------------------------------------------ */

/**
 * The cheapest security control that exists. A researcher who finds a flaw needs
 * somewhere to send it; without this they either give up or post it publicly.
 * Served from the API and also worth serving at /.well-known/security.txt on the
 * static host.
 */
security.get('/.well-known/security.txt', (c) => {
  const expires = new Date(Date.now() + 365 * 86400_000).toISOString().replace(/\.\d{3}/, '');
  const contact = c.env.SECURITY_CONTACT || `security@${c.env.SITE_DOMAIN}`;
  const body = [
    `Contact: mailto:${contact}`,
    `Expires: ${expires}`,
    'Preferred-Languages: en',
    `Canonical: https://${c.env.SITE_DOMAIN}/.well-known/security.txt`,
    `Policy: https://${c.env.SITE_DOMAIN}/security-policy`,
    '',
    '# Reports are read. Please include steps to reproduce.',
    '# Please do not run automated scanners against production.',
  ].join('\n');

  return c.body(body, 200, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'public, max-age=86400',
  });
});

/* ------------------------------------------------------------------ *
 * CSP violation reports
 * ------------------------------------------------------------------ */

/**
 * A CSP with no report endpoint tells you nothing about what it is blocking. The
 * usual result is that a legitimate script gets blocked in production, someone
 * notices weeks later via a support ticket, and the fix is to weaken the policy.
 * With reports you see it the same day and fix the actual cause.
 *
 * Unauthenticated by necessity — the browser sends these, not the user. So it is
 * rate limited hard, capped in size, and aggregated rather than stored per event:
 * a single misbehaving extension can otherwise generate tens of thousands of
 * reports an hour and fill the database.
 */
security.post('/api/security/csp-report',
  rateLimit({ bucket: 'csp_report', limit: 60, windowSec: 60 }),
  async (c) => {
    const raw = await c.req.text();
    if (raw.length > 8000) return c.body(null, 204);

    let report: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(raw);
      report = parsed['csp-report'] ?? parsed.body ?? parsed;
    } catch {
      return c.body(null, 204);
    }
    if (!report) return c.body(null, 204);

    const directive = String(report['effective-directive'] ?? report['violated-directive'] ?? report.effectiveDirective ?? 'unknown').slice(0, 80);
    const blocked = String(report['blocked-uri'] ?? report.blockedURL ?? '').slice(0, 300);
    const docUri = String(report['document-uri'] ?? report.documentURL ?? '').slice(0, 300);

    // Browser extensions inject scripts into every page and generate a constant
    // stream of violations that say nothing about your site. Filtering them at
    // the door is the difference between a usable report table and noise.
    if (/^(chrome|moz|safari|webkit)-extension:|^about:|^data:text\/html/.test(blocked)) {
      return c.body(null, 204);
    }

    const now = nowSec();
    // Aggregate on the shape of the violation, not the individual event.
    await run(c.get('db'),
      `INSERT INTO csp_reports (id, directive, blocked_uri, document_uri, count, first_seen_at, last_seen_at)
       VALUES (?,?,?,?,1,?,?)
       ON CONFLICT(directive, blocked_uri) DO UPDATE SET
         count = csp_reports.count + 1, last_seen_at = excluded.last_seen_at`,
      [newId('csp'), directive, blocked, docUri, now, now],
    );

    // 204 always. A browser that gets an error here retries, and the endpoint
    // becomes a self-amplifying load source.
    return c.body(null, 204);
  },
);

security.get('/api/admin/security/csp-reports', requireAuth, requireRole('admin'), async (c) => {
  const rows = await all(c.get('db'),
    `SELECT directive, blocked_uri, document_uri, count, first_seen_at, last_seen_at
     FROM csp_reports ORDER BY count DESC, last_seen_at DESC LIMIT 200`);
  return c.json({ reports: rows });
});

/* ------------------------------------------------------------------ *
 * Audit chain verification
 * ------------------------------------------------------------------ */

security.get('/api/admin/security/audit-integrity', requireAuth, requireRole('admin'), async (c) => {
  const db = c.get('db');
  const result = await verifyChain(db, { limit: 20000 });
  const head = await currentHead(db);
  const anchors = await all<{ seq: number; hash: string; anchored_at: number; destination: string }>(db,
    'SELECT seq, hash, anchored_at, destination FROM audit_anchors ORDER BY seq DESC LIMIT 10');

  return c.json({
    ...result,
    head,
    anchors,
    // Say plainly what the guarantee is worth. An operator who thinks an
    // unanchored chain is tamper-proof will not notice when it matters.
    note: anchors.length
      ? 'Entries at or before the newest anchor cannot be rewritten without contradicting a copy held outside this database.'
      : 'No external anchors recorded. The chain detects casual tampering but an attacker with write access can recompute it. Configure PLATFORM_INGEST_URL so the daily job can ship the head off-site.',
  });
});

/* ------------------------------------------------------------------ *
 * Subject rights — export and erasure
 * ------------------------------------------------------------------ */

/**
 * GDPR Articles 15 and 17, CCPA equivalents. These are legal obligations in most
 * of the markets a generated site will operate in, and they are far cheaper to
 * build in now than to retrofit under a thirty-day statutory deadline.
 */
security.get('/api/account/export',
  requireAuth, rateLimit({ bucket: 'data_export', limit: 3, windowSec: 86400 }),
  requireStepUp(SENSITIVE.exportData),
  async (c) => {
    const user = c.get('user')!;
    const db = c.get('db');

    const profile = await one<Record<string, unknown>>(db,
      `SELECT id, email, name, role, email_verified, mfa_enabled, created_at, updated_at
       FROM users WHERE id = ?`, [user.id]);
    const orders = await all(db,
      `SELECT id, status, amount_cents, currency, created_at, paid_at FROM orders WHERE user_id = ?`, [user.id]);
    const submissions = await all(db,
      `SELECT id, page, message, created_at FROM submissions WHERE email = ?`, [user.email]);
    const sessions = await all(db,
      `SELECT id, created_at, last_seen_at, country FROM sessions WHERE user_id = ?`, [user.id]);
    const devices = await all(db,
      `SELECT country, first_seen_at, last_seen_at, seen_count FROM known_devices WHERE user_id = ?`, [user.id]);

    await appendAudit(db, {
      actorType: 'user', actorId: user.id, action: 'account.data_exported',
      entity: 'user', entityId: user.id, ipHash: c.get('ipHash'), requestId: c.get('requestId'),
    });

    // Machine-readable and portable, per Article 20. A PDF would not satisfy it.
    return c.json({
      exported_at: new Date().toISOString(),
      format: 'application/json',
      profile,
      orders,
      contact_submissions: submissions,
      sessions,
      devices,
      note: 'Payment card details are held by Stripe and never by this site. Request those from Stripe directly.',
    }, 200, {
      'content-disposition': `attachment; filename="export-${user.id}.json"`,
      'cache-control': 'no-store',
    });
  },
);

const erasureSchema = z.object({ confirm: z.literal('DELETE') });

security.post('/api/account/erase',
  requireAuth, csrfProtect,
  rateLimit({ bucket: 'erasure', limit: 3, windowSec: 86400 }),
  requireStepUp(SENSITIVE.deleteAccount),
  async (c) => {
    const user = c.get('user')!;
    const db = c.get('db');
    erasureSchema.parse(await c.req.json());
    const now = nowSec();

    /**
     * Anonymise rather than delete, and be honest about why.
     *
     * Article 17 is not absolute — Article 17(3) preserves data needed for legal
     * obligations, and tax law in most jurisdictions requires transaction records
     * to be retained for six to ten years. Hard-deleting the order rows would
     * break that, and would also corrupt the site's own revenue history.
     *
     * So the personal data goes and the financial record stays, with the link
     * between them severed. This is the standard, defensible reading, and it is
     * what an auditor will expect to see.
     */
    const tombstone = `deleted-${user.id.slice(-8)}@invalid`;

    await run(db,
      `UPDATE users SET
         email = ?, name = NULL, password_hash = 'DELETED', status = 'erased',
         mfa_enabled = 0, mfa_secret = NULL, email_verified = 0,
         erased_at = ?, updated_at = ?
       WHERE id = ?`,
      [tombstone, now, now, user.id],
    );
    await run(db, 'UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL',
      [now, 'account_erased', user.id]);
    await run(db, 'DELETE FROM recovery_codes WHERE user_id = ?', [user.id]);
    await run(db, 'DELETE FROM known_devices WHERE user_id = ?', [user.id]);
    await run(db, `UPDATE submissions SET email = ?, name = NULL, message = '[erased]' WHERE email = ?`,
      [tombstone, user.email]);
    // Orders keep amount, currency, and dates; they lose the identity.
    await run(db, 'UPDATE orders SET customer_email = ?, customer_name = NULL WHERE user_id = ?',
      [tombstone, user.id]);

    await appendAudit(db, {
      actorType: 'user', actorId: user.id, action: 'account.erased',
      entity: 'user', entityId: user.id,
      after: { retained: 'order amounts and dates, for tax record-keeping' },
      ipHash: c.get('ipHash'), requestId: c.get('requestId'),
    });

    return c.json({
      erased: true,
      retained: ['order amounts, currency and dates — required for statutory financial record-keeping'],
      note: 'Personal identifiers have been removed and all sessions ended.',
    });
  },
);

/* ------------------------------------------------------------------ *
 * Break-glass lockdown
 * ------------------------------------------------------------------ */

const lockdownSchema = z.object({
  enabled: z.boolean(),
  reason: z.string().min(3).max(500),
});

/**
 * The switch you want to already exist at 3am.
 *
 * During a suspected compromise the useful action is to stop new sessions and
 * writes while keeping the site readable, so you can investigate without either
 * losing the business or letting the attacker keep working. Building this under
 * pressure, in production, is how outages become incidents.
 *
 * Deliberately does not take the site down: a dark site tells the attacker they
 * have been noticed and destroys evidence about what they were reaching for.
 */
security.post('/api/admin/security/lockdown',
  requireAuth, requireRole('owner'), csrfProtect,
  requireStepUp({ action: 'change the site lockdown state', requireMfa: true }),
  async (c) => {
    const user = c.get('user')!;
    const db = c.get('db');
    const input = lockdownSchema.parse(await c.req.json());
    const now = nowSec();

    await run(db,
      `INSERT INTO site_flags (key, value, updated_by, updated_at) VALUES ('lockdown', ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      [input.enabled ? '1' : '0', user.id, now],
    );

    if (input.enabled) {
      // Every session but the one turning the switch. Including, if the guess is
      // right, the attacker's.
      await run(db,
        'UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE id != ? AND revoked_at IS NULL',
        [now, 'lockdown', user.sessionId],
      );
    }

    await appendAudit(db, {
      actorType: 'admin', actorId: user.id,
      action: input.enabled ? 'site.lockdown_enabled' : 'site.lockdown_lifted',
      entity: 'site', entityId: c.env.SITE_SLUG,
      after: { reason: input.reason }, ipHash: c.get('ipHash'), requestId: c.get('requestId'),
    });

    return c.json({
      lockdown: input.enabled,
      sessions_revoked: input.enabled,
      effect: input.enabled
        ? 'Public pages still serve. Logins, registrations, checkout and all writes are refused.'
        : 'Normal operation restored.',
    });
  },
);

security.get('/api/admin/security/posture', requireAuth, requireRole('admin'), async (c) => {
  const db = c.get('db');
  const caps = c.get('caps');

  const [mfaAdmins, totalAdmins, staleSessions, lockdown, recentFailures] = await Promise.all([
    one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM users WHERE role IN ('admin','owner') AND mfa_enabled = 1`),
    one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM users WHERE role IN ('admin','owner')`),
    one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL AND last_seen_at < ?`, [nowSec() - 86400 * 7]),
    one<{ value: string }>(db, `SELECT value FROM site_flags WHERE key = 'lockdown'`),
    one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'auth.%failed' AND created_at > ?`, [nowSec() - 86400]),
  ]);

  const findings: Array<{ level: 'ok' | 'warn' | 'critical'; item: string; detail: string }> = [];

  const withMfa = mfaAdmins?.n ?? 0;
  const admins = totalAdmins?.n ?? 0;
  if (admins > 0 && withMfa < admins) {
    findings.push({
      level: 'critical', item: 'admin_mfa',
      detail: `${admins - withMfa} of ${admins} privileged accounts have no second factor. This is the highest-value gap on the list.`,
    });
  } else if (admins > 0) {
    findings.push({ level: 'ok', item: 'admin_mfa', detail: 'All privileged accounts have MFA.' });
  }

  if (!c.env.DATA_ENCRYPTION_KEYS) {
    findings.push({ level: 'warn', item: 'field_encryption', detail: 'DATA_ENCRYPTION_KEYS is unset — PII columns are stored in plaintext and MFA cannot be enabled.' });
  }
  if (!caps.has('turnstile')) {
    findings.push({ level: 'warn', item: 'bot_protection', detail: 'Turnstile is not configured; the contact form relies on heuristics alone.' });
  }
  if (c.env.ENVIRONMENT !== 'production') {
    findings.push({ level: 'warn', item: 'environment', detail: 'ENVIRONMENT is not "production" — HSTS is not being sent and CORS accepts localhost.' });
  }
  if ((staleSessions?.n ?? 0) > 0) {
    findings.push({ level: 'warn', item: 'stale_sessions', detail: `${staleSessions!.n} sessions idle over 7 days are still valid.` });
  }
  if ((recentFailures?.n ?? 0) > 50) {
    findings.push({ level: 'warn', item: 'auth_failures', detail: `${recentFailures!.n} failed authentications in 24h — consistent with credential stuffing.` });
  }

  return c.json({
    lockdown: lockdown?.value === '1',
    checked_at: new Date().toISOString(),
    findings,
    score: findings.some((f) => f.level === 'critical') ? 'action_required'
      : findings.some((f) => f.level === 'warn') ? 'attention' : 'good',
  });
});

/* ------------------------------------------------------------------ *
 * Admin: look up an encrypted field, with the access recorded
 * ------------------------------------------------------------------ */

security.get('/api/admin/security/reveal/:entity/:id/:field',
  requireAuth, requireRole('admin'),
  rateLimit({ bucket: 'pii_reveal', limit: 30, windowSec: 3600 }),
  requireStepUp({ action: 'view unmasked personal data', requireMfa: true }),
  async (c) => {
    const user = c.get('user')!;
    const db = c.get('db');
    const { entity, id, field } = c.req.param();

    // Allowlist, because this parameter reaches a column name. Interpolating it
    // would be SQL injection with extra steps, and parameter binding does not
    // work for identifiers.
    const ALLOWED: Record<string, string[]> = {
      users: ['phone_encrypted', 'address_encrypted'],
      orders: ['shipping_address_encrypted'],
    };
    if (!ALLOWED[entity]?.includes(field)) throw badRequest('That field is not revealable.');

    const row = await one<Record<string, string | null>>(db,
      `SELECT ${field} AS value FROM ${entity} WHERE id = ?`, [id]);
    if (!row?.value) throw notFound('No value stored.');

    const cipher = createCipher(c.env);
    const plaintext = await cipher.decrypt(row.value, `${entity}:${id}:${field.replace('_encrypted', '')}`);

    // Every reveal is logged, with who and why. An admin who reads a hundred
    // customer addresses leaves a hundred entries, and the audit chain means
    // they cannot quietly remove them afterwards.
    await appendAudit(db, {
      actorType: 'admin', actorId: user.id, action: 'pii.revealed',
      entity, entityId: id, after: { field }, ipHash: c.get('ipHash'), requestId: c.get('requestId'),
    });

    return c.json({ field, value: plaintext, masked: mask(plaintext) }, 200, { 'cache-control': 'no-store' });
  },
);

export default security;
