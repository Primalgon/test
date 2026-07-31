import { Hono } from 'hono';
import type { AppContext } from '../types';
import { one } from '../db/client';

const health = new Hono<AppContext>();

/** Liveness. No dependencies — answers even when Turso is down. */
health.get('/healthz', (c) => c.json({ ok: true, service: c.env.SITE_SLUG, ts: Date.now() }));

/**
 * Readiness. Actually touches every dependency, so the n8n QA workflow in
 * step 6 can assert on it rather than guessing from a 200 on the homepage.
 */
health.get('/readyz', async (c) => {
  const caps = c.get('caps').list();
  const checks: Record<string, { ok: boolean; ms?: number; detail?: string }> = {};

  const t0 = Date.now();
  try {
    await one(c.get('db'), 'SELECT 1 AS ok');
    checks.database = { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    checks.database = { ok: false, ms: Date.now() - t0, detail: String(e).slice(0, 200) };
  }

  try {
    await c.env.CACHE.get('__probe');
    checks.kv = { ok: true };
  } catch (e) {
    checks.kv = { ok: false, detail: String(e).slice(0, 200) };
  }

  const migrations = await one<{ n: number }>(c.get('db'),
    'SELECT COUNT(*) AS n FROM schema_migrations').catch(() => null);
  checks.migrations = { ok: !!migrations && migrations.n > 0, detail: `${migrations?.n ?? 0} applied` };

  const assetRow = await one<{ pending: number }>(c.get('db'),
    `SELECT COUNT(*) AS pending FROM assets WHERE status IN ('placeholder','generating','failed')`).catch(() => null);
  checks.assets_upgraded = {
    ok: (assetRow?.pending ?? 0) === 0,
    detail: `${assetRow?.pending ?? 0} not yet on final 3D`,
  };

  const required = ['database', 'kv', 'migrations'];
  const ok = required.every((k) => checks[k]?.ok);

  return c.json({
    ok,
    site: c.env.SITE_SLUG,
    environment: c.env.ENVIRONMENT,
    capabilities: caps,
    checks,
  }, ok ? 200 : 503);
});

export default health;
