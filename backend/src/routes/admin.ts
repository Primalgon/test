import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext } from '../types';
import { requireAuth, requireRole, csrfProtect } from '../middleware/auth';
import { rateLimit } from '../middleware/rate-limit';
import { all, one, run, nowSec, newId } from '../db/client';
import { listOrders, audit } from '../db/repo';
import { notFound, badRequest } from '../lib/errors';
import { purgeCache } from '../services/cloudflare';

/**
 * Admin API for the generated site's own dashboard. Every route requires an
 * authenticated session with role >= staff, plus CSRF on writes, plus a
 * rate limit — defence in depth, because this is the highest-value surface
 * on a site you do not operate day to day.
 */
const admin = new Hono<AppContext>();

admin.use('*', requireAuth, requireRole('staff'), rateLimit({ bucket: 'admin', limit: 300, windowSec: 60, by: 'user' }));

admin.get('/overview', async (c) => {
  const db = c.get('db');
  const since = nowSec() - 30 * 86400;

  const [revenue, orderCount, newUsers, submissions, failedWebhooks, assets] = await Promise.all([
    one<{ total: number }>(db, `SELECT COALESCE(SUM(amount_cents - amount_refunded_cents),0) AS total FROM orders WHERE status IN ('paid','fulfilled') AND created_at >= ?`, [since]),
    one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM orders WHERE created_at >= ?`, [since]),
    one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM users WHERE created_at >= ?`, [since]),
    one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM submissions WHERE status = 'new'`),
    one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM webhook_events WHERE status = 'failed'`),
    all<{ status: string; n: number }>(db, `SELECT status, COUNT(*) AS n FROM assets GROUP BY status`),
  ]);

  const daily = await all<{ day: string; revenue: number; orders: number }>(db,
    `SELECT date(created_at,'unixepoch') AS day,
            COALESCE(SUM(amount_cents - amount_refunded_cents),0) AS revenue,
            COUNT(*) AS orders
     FROM orders WHERE created_at >= ? AND status IN ('paid','fulfilled')
     GROUP BY day ORDER BY day`, [since]);

  return c.json({
    window_days: 30,
    revenue_cents: revenue?.total ?? 0,
    orders: orderCount?.n ?? 0,
    new_users: newUsers?.n ?? 0,
    unread_submissions: submissions?.n ?? 0,
    failed_webhooks: failedWebhooks?.n ?? 0,
    assets_by_status: Object.fromEntries(assets.map((a) => [a.status, a.n])),
    daily,
  });
});

const page = (c: any) => {
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 25)));
  const offset = Math.max(0, Number(c.req.query('offset') ?? 0));
  return { limit, offset };
};

admin.get('/orders', async (c) => {
  const { limit, offset } = page(c);
  const status = c.req.query('status');
  const rows = await listOrders(c.get('db'), limit, offset, status);
  const total = await one<{ n: number }>(c.get('db'),
    status ? 'SELECT COUNT(*) AS n FROM orders WHERE status = ?' : 'SELECT COUNT(*) AS n FROM orders',
    status ? [status] : []);
  return c.json({ orders: rows.map((o) => ({ ...o, items: safeJson(o.items) })), total: total?.n ?? 0, limit, offset });
});

admin.get('/submissions', async (c) => {
  const { limit, offset } = page(c);
  const status = c.req.query('status') ?? 'new';
  const rows = await all<{ id: string; payload: string; [k: string]: unknown }>(c.get('db'),
    'SELECT * FROM submissions WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    [status, limit, offset]);
  return c.json({ submissions: rows.map((r) => ({ ...r, payload: safeJson(r.payload) })), limit, offset });
});

admin.patch('/submissions/:id', csrfProtect, async (c) => {
  const { status } = z.object({ status: z.enum(['new', 'read', 'archived', 'spam']) })
    .parse(await c.req.json().catch(() => ({})));
  const res = await run(c.get('db'), 'UPDATE submissions SET status = ? WHERE id = ?', [status, c.req.param('id')]);
  if (!res.rowsAffected) throw notFound('Submission not found.');
  await audit(c.get('db'), { actorId: c.get('user')!.id, action: 'submission.status_changed',
    entity: 'submission', entityId: c.req.param('id'), after: { status } });
  return c.json({ ok: true, status });
});

admin.get('/users', requireRole('admin'), async (c) => {
  const { limit, offset } = page(c);
  const q = c.req.query('q');
  const rows = q
    ? await all(c.get('db'),
        `SELECT id,email,name,role,status,email_verified,created_at,last_login_at FROM users
         WHERE email_canonical LIKE ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [`%${q.toLowerCase()}%`, limit, offset])
    : await all(c.get('db'),
        `SELECT id,email,name,role,status,email_verified,created_at,last_login_at FROM users
         ORDER BY created_at DESC LIMIT ? OFFSET ?`, [limit, offset]);
  return c.json({ users: rows, limit, offset });
});

admin.patch('/users/:id', requireRole('owner'), csrfProtect, async (c) => {
  const input = z.object({
    role: z.enum(['customer', 'staff', 'admin', 'owner']).optional(),
    status: z.enum(['active', 'suspended']).optional(),
  }).parse(await c.req.json().catch(() => ({})));
  if (!input.role && !input.status) throw badRequest('Nothing to change.');

  const target = c.req.param('id');
  if (target === c.get('user')!.id && input.status === 'suspended') {
    throw badRequest('You cannot suspend your own account.');
  }
  const before = await one(c.get('db'), 'SELECT role,status FROM users WHERE id = ?', [target]);
  if (!before) throw notFound('User not found.');

  await run(c.get('db'),
    'UPDATE users SET role = COALESCE(?, role), status = COALESCE(?, status), updated_at = ? WHERE id = ?',
    [input.role ?? null, input.status ?? null, nowSec(), target]);
  if (input.status === 'suspended') {
    await run(c.get('db'), 'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [nowSec(), target]);
  }
  await audit(c.get('db'), { actorId: c.get('user')!.id, action: 'user.updated', entity: 'user',
    entityId: target, before, after: input, requestId: c.get('requestId') });
  return c.json({ ok: true });
});

admin.get('/content/:page{.*}', async (c) => {
  const rows = await all(c.get('db'),
    'SELECT block_key,locale,value,updated_at FROM content_blocks WHERE page_slug = ?', [c.req.param('page')]);
  return c.json({ page: c.req.param('page'), blocks: rows });
});

admin.put('/content/:page{.*}', csrfProtect, async (c) => {
  const input = z.object({
    locale: z.string().max(12).default('en-US'),
    blocks: z.record(z.string().max(80), z.string().max(20000)),
  }).parse(await c.req.json().catch(() => ({})));

  const pageSlug = c.req.param('page');
  const ts = nowSec();
  for (const [key, value] of Object.entries(input.blocks)) {
    await run(c.get('db'),
      `INSERT INTO content_blocks (id,page_slug,block_key,locale,value,updated_by,updated_at) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(page_slug,block_key,locale) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
      [newId('cnt'), pageSlug, key, input.locale, value, c.get('user')!.id, ts]);
  }
  await audit(c.get('db'), { actorId: c.get('user')!.id, action: 'content.updated', entity: 'page', entityId: pageSlug });
  if (c.get('caps').has('cloudflare_admin')) {
    c.executionCtx.waitUntil(purgeCache(c.env).catch(() => {}));
  }
  return c.json({ ok: true, updated: Object.keys(input.blocks).length });
});

admin.get('/assets', async (c) => c.json({ assets: await all(c.get('db'), 'SELECT * FROM assets ORDER BY asset_key') }));

/**
 * Flag one 3D asset for regeneration.
 *
 * This only records the request. Regeneration itself happens in the build
 * pipeline, off this site, and lands via a rebuild — the site has no runtime
 * path to overwrite its own assets, which is the point. The site owner sees the
 * flag; the pipeline picks it up on its next pass.
 */
admin.post('/assets/:key/regenerate', requireRole('admin'), csrfProtect, async (c) => {
  const key = c.req.param('key');
  const asset = await one<{ asset_key: string; prompt: string | null }>(c.get('db'),
    'SELECT asset_key,prompt FROM assets WHERE asset_key = ?', [key]);
  if (!asset) throw notFound('No asset with that key.');

  const { prompt } = z.object({ prompt: z.string().max(600).optional() })
    .parse(await c.req.json().catch(() => ({})));

  await run(c.get('db'),
    'UPDATE assets SET regenerate_requested_at = ?, regenerate_prompt = ?, updated_at = ? WHERE asset_key = ?',
    [nowSec(), prompt ?? asset.prompt, nowSec(), key]);

  return c.json({
    ok: true,
    queued: true,
    note: 'Flagged for the next build. The live model is unchanged until then.',
  });
});

admin.get('/audit', requireRole('admin'), async (c) => {
  const { limit, offset } = page(c);
  return c.json({
    entries: await all(c.get('db'), 'SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ? OFFSET ?', [limit, offset]),
    limit, offset,
  });
});

admin.get('/webhooks', requireRole('admin'), async (c) => {
  const { limit, offset } = page(c);
  return c.json({
    events: await all(c.get('db'),
      'SELECT id,provider,type,status,attempts,last_error,received_at,completed_at FROM webhook_events ORDER BY received_at DESC LIMIT ? OFFSET ?',
      [limit, offset]),
    limit, offset,
  });
});

admin.get('/outbox', requireRole('admin'), async (c) =>
  c.json({ pending: await all(c.get('db'), `SELECT * FROM outbox WHERE status IN ('pending','failed','dead') ORDER BY created_at DESC LIMIT 100`) }));

admin.post('/cache/purge', requireRole('admin'), csrfProtect, async (c) => {
  await purgeCache(c.env);
  await audit(c.get('db'), { actorId: c.get('user')!.id, action: 'cache.purged' });
  return c.json({ ok: true });
});

const safeJson = (s: unknown) => {
  try { return JSON.parse(String(s)); } catch { return s; }
};

export default admin;
