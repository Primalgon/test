#!/usr/bin/env tsx
/**
 * Post-deploy assertion suite. This is what the step-6 n8n workflow calls
 * instead of "did the homepage return 200". Exit code 0 means the site is
 * genuinely wired; anything else means do not mark the order complete.
 *
 *   tsx scripts/verify-deployment.ts --origin https://acme.com
 */
import 'dotenv/config';
import { createHmac } from 'node:crypto';

const origin = process.argv[process.argv.indexOf('--origin') + 1] ?? process.env.PUBLIC_ORIGIN;
if (!origin) { console.error('Pass --origin https://the-site.com'); process.exit(1); }

interface Check { name: string; pass: boolean; detail: string; severity: 'blocker' | 'warn' }
const checks: Check[] = [];
const add = (name: string, pass: boolean, detail = '', severity: Check['severity'] = 'blocker') =>
  checks.push({ name, pass, detail, severity });

async function main() {
  // 1. liveness + readiness
  try {
    const r = await fetch(`${origin}/healthz`);
    add('healthz responds', r.ok, `HTTP ${r.status}`);
  } catch (e) { add('healthz responds', false, String(e)); }

  try {
    const r = await fetch(`${origin}/readyz`);
    const body = await r.json() as any;
    add('all dependencies ready', r.ok && body.ok,
      Object.entries(body.checks ?? {}).filter(([, v]: any) => !v.ok).map(([k]) => k).join(', ') || 'all green');
    add('3D assets upgraded past placeholders', body.checks?.assets_upgraded?.ok ?? false,
      body.checks?.assets_upgraded?.detail ?? 'unknown', 'blocker');
  } catch (e) { add('all dependencies ready', false, String(e)); }

  // 2. security headers — the ones that silently go missing behind a proxy
  try {
    const r = await fetch(`${origin}/api/config`);
    const h = r.headers;
    add('CSP present and nonce-based',
      (h.get('content-security-policy') ?? '').includes("'nonce-"), h.get('content-security-policy')?.slice(0, 60) ?? 'missing');
    add('HSTS present', (h.get('strict-transport-security') ?? '').includes('max-age=63072000'), h.get('strict-transport-security') ?? 'missing');
    add('nosniff present', h.get('x-content-type-options') === 'nosniff', h.get('x-content-type-options') ?? 'missing');
    add('framing denied', h.get('x-frame-options') === 'DENY', h.get('x-frame-options') ?? 'missing');
    add('referrer policy set', !!h.get('referrer-policy'), h.get('referrer-policy') ?? 'missing', 'warn');
    add('no server fingerprint', !h.get('x-powered-by'), h.get('x-powered-by') ?? 'clean', 'warn');
  } catch (e) { add('security headers', false, String(e)); }

  // 3. the surface that must NOT be reachable
  for (const path of ['/api/admin/overview', '/api/admin/users', '/api/admin/audit']) {
    try {
      const r = await fetch(`${origin}${path}`);
      add(`${path} rejects anonymous`, r.status === 401 || r.status === 403, `HTTP ${r.status}`);
    } catch (e) { add(`${path} rejects anonymous`, false, String(e)); }
  }

  // 4. webhook and integration surfaces reject unsigned calls
  try {
    const r = await fetch(`${origin}/api/webhooks/stripe`, { method: 'POST', body: '{}' });
    add('stripe webhook rejects unsigned', r.status >= 400, `HTTP ${r.status}`);
  } catch (e) { add('stripe webhook rejects unsigned', false, String(e)); }

  try {
    const r = await fetch(`${origin}/api/_n8n/ping`, { method: 'POST', body: '{}' });
    add('n8n surface rejects unsigned', r.status === 403, `HTTP ${r.status}`);
  } catch (e) { add('n8n surface rejects unsigned', false, String(e)); }

  // 5. n8n surface ACCEPTS a correctly signed call
  if (process.env.N8N_INBOUND_SECRET) {
    try {
      const payload = JSON.stringify({ probe: true });
      const ts = Math.floor(Date.now() / 1000).toString();
      const sig = createHmac('sha256', process.env.N8N_INBOUND_SECRET).update(`${ts}.${payload}`).digest('hex');
      const r = await fetch(`${origin}/api/_n8n/ping`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forge-timestamp': ts, 'x-forge-signature': `sha256=${sig}` },
        body: payload,
      });
      add('n8n surface accepts signed', r.ok, `HTTP ${r.status}`);
    } catch (e) { add('n8n surface accepts signed', false, String(e)); }
  }

  // 6. rate limiting actually engages
  try {
    const burst = await Promise.all(Array.from({ length: 14 }, () =>
      fetch(`${origin}/api/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'ratelimit-probe@example.invalid', password: 'x' }),
      })));
    add('login is rate limited', burst.some((r) => r.status === 429),
      `statuses: ${[...new Set(burst.map((r) => r.status))].join(',')}`);
  } catch (e) { add('login is rate limited', false, String(e)); }

  // 7. public config does not leak secrets
  try {
    const text = await (await fetch(`${origin}/api/config`)).text();
    const leaks = ['sk_live', 'sk_test', 'whsec_', 'Zoho-enczapikey', 'TURSO_AUTH'].filter((s) => text.includes(s));
    add('no secrets in public config', leaks.length === 0, leaks.join(',') || 'clean');
  } catch (e) { add('no secrets in public config', false, String(e)); }

  const blockers = checks.filter((c) => !c.pass && c.severity === 'blocker');
  const warnings = checks.filter((c) => !c.pass && c.severity === 'warn');

  for (const c of checks) {
    console.log(`${c.pass ? '  pass  ' : c.severity === 'warn' ? '  warn  ' : '  FAIL  '} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  console.log(`\n${checks.filter((c) => c.pass).length}/${checks.length} passed, ${blockers.length} blockers, ${warnings.length} warnings\n`);

  // Machine-readable line for n8n to parse without scraping stdout.
  console.log(`::result::${JSON.stringify({
    passed: blockers.length === 0,
    score: Math.round((checks.filter((c) => c.pass).length / checks.length) * 100),
    failures: [...blockers, ...warnings].map((c) => ({ check: c.name, severity: c.severity === 'warn' ? 'warn' : 'blocker', detail: c.detail })),
  })}`);

  process.exit(blockers.length ? 1 : 0);
}

main();
