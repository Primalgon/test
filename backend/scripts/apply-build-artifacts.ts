#!/usr/bin/env tsx
/**
 * Applies build artifacts to a site's database, from the build host.
 *
 * This replaces what used to be a set of HMAC-authenticated runtime routes at
 * `/api/_n8n/*`. Those routes are gone, and their removal is the point.
 *
 * The pipeline builds the site. Once the site is deployed, the pipeline has no
 * business reaching into it — an always-open write endpoint on every production
 * site is a permanent attack surface serving a purpose the build already covers.
 * Every argument for keeping it ("we might need to push a fix", "it's signed")
 * applies equally to a rebuild, which is cheap, leaves a git history, and needs
 * no endpoint at all.
 *
 * So this runs from the build host, which already holds the Turso credentials,
 * and it runs *before* traffic reaches the new deploy. Nothing about the running
 * site can be changed by anything except a deploy.
 *
 *   tsx scripts/apply-build-artifacts.ts --assets ./higgsfield-output.json
 *   tsx scripts/apply-build-artifacts.ts --content ./copy.json
 *   tsx scripts/apply-build-artifacts.ts --qa ./verify-result.json
 *   tsx scripts/apply-build-artifacts.ts --manifest ../frontend/src/data/assets.manifest.json
 */
import { createClient } from '@libsql/client';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import 'dotenv/config';

const args = process.argv.slice(2);
const arg = (n: string) => { const i = args.indexOf(`--${n}`); return i === -1 ? undefined : args[i + 1]; };

const url = process.env.TURSO_DATABASE_URL;
if (!url) { console.error('TURSO_DATABASE_URL is not set.'); process.exit(1); }
const db = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });

const now = () => Math.floor(Date.now() / 1000);
const id = (p: string) => `${p}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

const summary: Record<string, unknown> = { ok: true };

/* ------------------------------------------------------------------ *
 * Audit entries
 *
 * The audit log is a hash chain, so appending has to preserve it. Writing rows
 * straight into the table with a null prev_hash breaks verification for
 * everything after — which then looks exactly like tampering, and nobody can
 * tell the difference six months later.
 * ------------------------------------------------------------------ */

function canonical(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

async function appendAudit(entry: {
  action: string; entity?: string; entityId?: string; after?: unknown;
}) {
  const head = await db.execute('SELECT seq, entry_hash FROM audit_log ORDER BY seq DESC LIMIT 1');
  const prevHash = (head.rows[0]?.entry_hash as string) ?? '0'.repeat(64);
  const seq = Number(head.rows[0]?.seq ?? 0) + 1;
  const createdAt = now();

  const hash = createHash('sha256').update([
    prevHash, seq, createdAt, 'build', '', entry.action,
    entry.entity ?? '', entry.entityId ?? '', canonical(undefined), canonical(entry.after),
  ].join('|')).digest('hex');

  await db.execute({
    sql: `INSERT INTO audit_log
            (id, seq, prev_hash, entry_hash, actor_type, actor_id, action, entity, entity_id,
             before_json, after_json, ip_hash, user_agent, request_id, created_at)
          VALUES (?,?,?,?,'build',NULL,?,?,?,NULL,?,NULL,NULL,NULL,?)`,
    args: [id('aud'), seq, prevHash, hash, entry.action,
           entry.entity ?? null, entry.entityId ?? null,
           entry.after === undefined ? null : JSON.stringify(entry.after), createdAt],
  });
}

/* ------------------------------------------------------------------ *
 * Assets — the step-4 swap
 * ------------------------------------------------------------------ */

interface AssetResult {
  key: string;
  status: 'placeholder' | 'generating' | 'ready' | 'failed';
  source: 'primitive' | 'higgsfield' | 'client_supplied';
  url?: string | null;
  poster?: string | null;
  bytes?: number;
  triangles?: number;
  higgsfield_job_id?: string;
  prompt?: string;
  error?: string;
}

async function applyAssets(path: string) {
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  const assets: AssetResult[] = parsed.assets ?? parsed;
  if (!Array.isArray(assets)) throw new Error('Expected { assets: [...] } or a bare array.');

  const problems: string[] = [];
  let ready = 0;

  for (const a of assets) {
    if (!/^[a-z0-9_]+$/.test(a.key)) { problems.push(`bad key "${a.key}"`); continue; }

    // Refuse a "ready" asset with no URL. Left unchecked this writes a state the
    // frontend reads as "load the model" with nothing to load, and the section
    // renders empty on a live client site.
    if (a.status === 'ready' && !a.url) {
      problems.push(`${a.key}: status ready but no url — downgraded to failed`);
      a.status = 'failed';
    }

    // A model with no poster has no fallback for visitors without WebGL. Ship it
    // and those visitors get an empty box.
    if (a.status === 'ready' && !a.poster) problems.push(`${a.key}: no poster image — no-WebGL visitors see nothing`);

    if (a.status === 'ready') ready++;

    await db.execute({
      sql: `INSERT INTO assets
              (id,asset_key,status,source,url,poster_url,bytes,triangles,higgsfield_job_id,prompt,attempts,last_error,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)
            ON CONFLICT(asset_key) DO UPDATE SET
              status=excluded.status, source=excluded.source,
              url=COALESCE(excluded.url, assets.url),
              poster_url=COALESCE(excluded.poster_url, assets.poster_url),
              bytes=excluded.bytes, triangles=excluded.triangles,
              higgsfield_job_id=COALESCE(excluded.higgsfield_job_id, assets.higgsfield_job_id),
              attempts=assets.attempts+1, last_error=excluded.last_error,
              regenerate_requested_at=NULL, updated_at=excluded.updated_at`,
      args: [id('ast'), a.key, a.status, a.source, a.url ?? null, a.poster ?? null,
             a.bytes ?? null, a.triangles ?? null, a.higgsfield_job_id ?? null,
             a.prompt ?? null, a.error ?? null, now()],
    });
  }

  await appendAudit({ action: 'assets.applied', entity: 'build',
    after: { count: assets.length, ready, problems } });

  summary.assets = { total: assets.length, ready, problems };
  if (problems.length) summary.ok = false;
  console.log(`assets: ${ready}/${assets.length} ready${problems.length ? `, ${problems.length} problem(s)` : ''}`);
  for (const p of problems) console.log(`  ! ${p}`);
}

/* ------------------------------------------------------------------ *
 * Frontend manifest — keep it in step with the database
 * ------------------------------------------------------------------ */

async function checkManifest(path: string) {
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  const rows = await db.execute('SELECT asset_key, status, url, poster_url FROM assets');
  const byKey = new Map(rows.rows.map((r) => [String(r.asset_key), r]));

  const drift: string[] = [];
  for (const [key, entry] of Object.entries<Record<string, unknown>>(manifest.assets ?? {})) {
    const row = byKey.get(key);
    if (!row) { drift.push(`${key}: in the manifest, absent from the database`); continue; }
    if (row.status !== entry.status) drift.push(`${key}: manifest says ${entry.status}, database says ${row.status}`);
  }
  for (const key of byKey.keys()) {
    if (!(manifest.assets ?? {})[key]) drift.push(`${key}: in the database, absent from the manifest`);
  }

  summary.manifest = { drift };
  if (drift.length) {
    summary.ok = false;
    console.log(`manifest: ${drift.length} mismatch(es) against the database`);
    for (const d of drift) console.log(`  ! ${d}`);
    console.log('  The frontend reads the manifest at build time and the database at runtime.');
    console.log('  Drift means the two disagree about what exists — rebuild after applying assets.');
  } else {
    console.log('manifest: in step with the database');
  }
}

/* ------------------------------------------------------------------ *
 * Content
 * ------------------------------------------------------------------ */

async function applyContent(path: string) {
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  const pages: Array<{ page: string; locale?: string; blocks: Record<string, string> }> =
    Array.isArray(parsed) ? parsed : [parsed];

  let count = 0;
  for (const page of pages) {
    for (const [key, value] of Object.entries(page.blocks)) {
      if (value.length > 20000) throw new Error(`Block ${page.page}.${key} exceeds 20000 characters.`);
      await db.execute({
        sql: `INSERT INTO content_blocks (id,page_slug,block_key,locale,value,updated_at) VALUES (?,?,?,?,?,?)
              ON CONFLICT(page_slug,block_key,locale) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
        args: [id('cnt'), page.page, key, page.locale ?? 'en-US', value, now()],
      });
      count++;
    }
  }

  await appendAudit({ action: 'content.applied', entity: 'build', after: { blocks: count } });
  summary.content = { blocks: count };
  console.log(`content: ${count} block(s) written`);
}

/* ------------------------------------------------------------------ *
 * QA verdict
 * ------------------------------------------------------------------ */

async function applyQa(path: string) {
  const result = JSON.parse(await readFile(path, 'utf8'));
  await appendAudit({
    action: result.passed ? 'qa.passed' : 'qa.failed',
    entity: 'qa_run', entityId: String(result.run_id ?? 'unknown'),
    after: { passed: result.passed, score: result.score, failures: result.failures ?? [] },
  });

  const blockers = (result.failures ?? []).filter((f: { severity: string }) => f.severity === 'blocker');
  summary.qa = { passed: !!result.passed, blockers: blockers.length };
  if (!result.passed) summary.ok = false;
  console.log(`qa: ${result.passed ? 'passed' : 'FAILED'}${blockers.length ? `, ${blockers.length} blocker(s)` : ''}`);
}

/* ------------------------------------------------------------------ *

 * ------------------------------------------------------------------ */

try {
  const assetsPath = arg('assets');
  const contentPath = arg('content');
  const qaPath = arg('qa');
  const manifestPath = arg('manifest');

  if (!assetsPath && !contentPath && !qaPath && !manifestPath) {
    console.error('Nothing to do. Pass at least one of --assets --content --qa --manifest.');
    process.exit(1);
  }

  if (assetsPath) await applyAssets(assetsPath);
  if (contentPath) await applyContent(contentPath);
  if (qaPath) await applyQa(qaPath);
  if (manifestPath) await checkManifest(manifestPath);
} catch (err) {
  summary.ok = false;
  summary.error = (err as Error).message;
  console.error(`FAILED: ${(err as Error).message}`);
}

console.log('::result::' + JSON.stringify(summary));
process.exit(summary.ok ? 0 : 1);
