import { Hono } from 'hono';
import type { AppContext } from './types';
import type { Bindings } from './env';

import { requestContext } from './middleware/context';
import { securityHeaders, cors } from './middleware/security';
import { loadSession } from './middleware/auth';
import { sessionAnomaly } from './middleware/anomaly';
import { lockdownGuard } from './middleware/lockdown';
import { honeytokenGuard } from './middleware/honeytokens';
import { onError, onNotFound } from './middleware/error-handler';

import authRoutes from './routes/auth';
import commerceRoutes from './routes/commerce';
import siteRoutes from './routes/site';
import adminRoutes from './routes/admin';
import mfaRoutes from './routes/mfa';
import securityRoutes from './routes/security';
import healthRoutes from './routes/health';

import { flushOutbox } from './services/events';
import { verifyChain, currentHead } from './lib/audit-chain';
import { getDb } from './db/client';
import { createLogger } from './lib/logger';
import { run, nowSec } from './db/client';

export { RateLimiter } from './do/rate-limiter';

const app = new Hono<AppContext>();

/**
 * Middleware order is load-bearing. Each of these depends on the one above it
 * having already run, and reordering any pair breaks something quietly:
 *
 *   requestContext  — must be first; everything downstream reads c.get('log'),
 *                     c.get('db'), c.get('ipHash')
 *   securityHeaders — sets the CSP nonce before any handler renders, and reads
 *                     c.get('user') afterwards to decide on no-store
 *   cors            — answers OPTIONS before session lookup wastes a DB round trip
 *   loadSession     — attaches the user; never rejects on its own
 *   sessionAnomaly  — needs the user loaded; may revoke the session
 *   lockdownGuard   — needs the user and their elevation state, so it can let an
 *                     owner keep working during a lockdown they declared
 *   honeytokenGuard — last, so a decoy hit is recorded with full request context
 *                     and answers with a 404 identical to any other
 *
 * Rate limiting is applied per route rather than globally: a single global limit
 * either throttles the homepage or fails to protect /login, and there is no
 * number that does both.
 */
app.use('*', requestContext);
app.use('*', securityHeaders);
app.use('*', cors);
app.use('*', loadSession);
app.use('*', sessionAnomaly);
app.use('*', lockdownGuard);
app.use('*', honeytokenGuard);

app.route('/', healthRoutes);
app.route('/api/auth', authRoutes);
app.route('/api', commerceRoutes);
app.route('/api', siteRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api/mfa', mfaRoutes);
// Mounted at the root: it owns /.well-known/security.txt as well as /api paths.
app.route('/', securityRoutes);

/**
 * API index.
 *
 * In production this returns almost nothing on purpose. The original version
 * listed every route in the application — which is a free reconnaissance map for
 * anyone who opens devtools. Route enumeration is normally the slow part of
 * attacking an unfamiliar API; publishing it skips that work entirely, and it
 * tells an attacker which optional integrations are switched on.
 *
 * The full listing stays in development, where it is genuinely useful.
 */
app.get('/api', (c) => {
  if (c.env.ENVIRONMENT === 'production') {
    return c.json({ service: 'api', status: 'ok' });
  }
  return c.json({
    service: `${c.env.SITE_NAME} API`,
    version: '1.0.0',
    environment: c.env.ENVIRONMENT,
    capabilities: c.get('caps').list(),
    endpoints: [
      'GET  /healthz', 'GET  /readyz',
      'GET  /api/config', 'GET  /api/content/:page', 'GET  /api/assets', 'POST /api/contact',
      'POST /api/auth/register', 'POST /api/auth/login', 'POST /api/auth/logout', 'GET  /api/auth/me',
      'GET  /api/products', 'POST /api/checkout', 'POST /api/billing-portal',
      'POST /api/webhooks/stripe',
      'GET  /api/admin/overview', 'GET /api/admin/orders', 'GET /api/admin/submissions',
      'GET  /api/mfa/status', 'POST /api/mfa/setup', 'POST /api/mfa/activate',
      'POST /api/mfa/step-up', 'GET  /api/mfa/devices',
      'GET  /api/account/export', 'POST /api/account/erase',
      'GET  /.well-known/security.txt',
    ],
  });
});

app.onError(onError);
app.notFound(onNotFound);

export default {
  fetch: app.fetch,

  /**
   * Cron. Configure in wrangler.toml:
   *   [triggers] crons = ["*\/2 * * * *", "17 4 * * *"]
   * The 2-minute tick flushes the outbox so event delivery is retried
   * independently of request traffic. The daily tick does housekeeping that
   * would otherwise grow unbounded and slowly degrade every query.
   */
  async scheduled(event: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    const log = createLogger(env.LOG_LEVEL, { site: env.SITE_SLUG, cron: event.cron });
    const db = getDb(env);

    ctx.waitUntil((async () => {
      try {
        await flushOutbox(db, env, log);

        // Daily housekeeping.
        if (event.cron.startsWith('17')) {
          const now = nowSec();
          const results = await Promise.allSettled([
            run(db, 'DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)', [now, now - 86400 * 7]),
            run(db, 'DELETE FROM verification_tokens WHERE expires_at < ? OR consumed_at IS NOT NULL', [now - 86400]),
            run(db, 'DELETE FROM idempotency_keys WHERE expires_at < ?', [now]),
            run(db, `DELETE FROM webhook_events WHERE status = 'done' AND received_at < ?`, [now - 86400 * 30]),
            run(db, `DELETE FROM outbox WHERE status = 'sent' AND sent_at < ?`, [now - 86400 * 14]),
            run(db, 'DELETE FROM audit_log WHERE created_at < ?', [now - 86400 * 365]),
            run(db, `DELETE FROM submissions WHERE status = 'spam' AND created_at < ?`, [now - 86400 * 30]),
          ]);
          log.info('housekeeping', {
            ok: results.filter((r) => r.status === 'fulfilled').length,
            failed: results.filter((r) => r.status === 'rejected').length,
          });

          /**
           * Audit chain: verify, then anchor the head off-site.
           *
           * Verification catches tampering that has already happened. Anchoring
           * is what makes future tampering hard — once yesterday's head is
           * recorded somewhere this site cannot write to, an attacker inside the
           * site can no longer rewrite history without contradicting a copy
           * beyond their reach. Without the anchor step, the chain is only a
           * speed bump: an attacker with write access recomputes it and it
           * verifies clean.
           */
          const integrity = await verifyChain(db, { limit: 50000 });
          if (!integrity.ok) {
            log.error('audit_chain_broken', {
              broken_at: integrity.brokenAt, detail: integrity.detail, checked: integrity.checked,
            });
          }
          const head = await currentHead(db);
          if (head.seq > 0) {
            await run(db,
              `INSERT INTO audit_anchors (id, seq, hash, destination, anchored_at)
               VALUES (?,?,?,?,?)`,
              [`anc_${head.seq}_${now}`, head.seq, head.hash, 'platform', now]);
            await run(db,
              `INSERT INTO outbox (id, destination, event_type, payload, status, attempts, next_attempt_at, created_at)
               VALUES (?,?,?,?,'pending',0,?,?)`,
              [`obx_anchor_${now}`, 'platform', 'security.audit_anchor',
               JSON.stringify({ seq: head.seq, hash: head.hash, integrity_ok: integrity.ok, at: now }),
               now, now]);
          }
        }
      } catch (err) {
        log.error('cron_failed', { error: String(err) });
      }
    })());
  },
};
