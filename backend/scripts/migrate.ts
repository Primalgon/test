#!/usr/bin/env tsx
/**
 * Migration runner. Runs from Node (not the Worker) against a site's Turso DB.
 * Checksums every applied file so an edited-after-the-fact migration is caught
 * instead of silently diverging between sites.
 *
 *   npm run migrate                 # apply pending
 *   npm run migrate:status          # show state, change nothing
 */
import { createClient } from '@libsql/client';
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', 'migrations');

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url) { console.error('TURSO_DATABASE_URL is not set.'); process.exit(1); }

const db = createClient({ url, authToken });
const statusOnly = process.argv.includes('--status');

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/**
 * Splits on semicolons at statement level. Naive splitting breaks on triggers
 * and on semicolons inside string literals, so those two cases are handled.
 */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inString = false;
  let inLineComment = false;
  let depth = 0; // BEGIN...END blocks (triggers)

  const lines = sql.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('--')) continue;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (inLineComment) continue;
      if (ch === "'" ) inString = !inString;
      if (!inString && ch === '-' && line[i + 1] === '-') { inLineComment = true; continue; }
      buf += ch;
      if (!inString && ch === ';' && depth === 0) { out.push(buf.trim()); buf = ''; }
    }
    inLineComment = false;
    buf += '\n';
    if (/\bBEGIN\b/i.test(trimmed) && !/\bBEGIN\s+TRANSACTION\b/i.test(trimmed)) depth++;
    if (/^END\s*;?$/i.test(trimmed) && depth > 0) { depth--; if (depth === 0) { out.push(buf.trim()); buf = ''; } }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.map((s) => s.replace(/;$/, '').trim()).filter(Boolean);
}

async function main() {
  await db.execute(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL, checksum TEXT NOT NULL)`);

  const applied = new Map<string, string>();
  for (const row of (await db.execute('SELECT version, checksum FROM schema_migrations')).rows) {
    applied.set(String(row.version), String(row.checksum));
  }

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  let pending = 0;

  for (const file of files) {
    const version = file.replace('.sql', '');
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    const checksum = sha(sql);
    const priorChecksum = applied.get(version);

    if (priorChecksum) {
      if (priorChecksum !== checksum) {
        console.error(`\n  ${version} was modified after being applied.`);
        console.error(`  Applied checksum ${priorChecksum}, file is now ${checksum}.`);
        console.error(`  Write a new migration instead of editing this one.\n`);
        process.exit(1);
      }
      console.log(`  ok       ${version}`);
      continue;
    }

    pending++;
    if (statusOnly) { console.log(`  pending  ${version}`); continue; }

    process.stdout.write(`  applying ${version} ... `);
    const statements = splitStatements(sql);
    try {
      await db.batch(statements, 'write');
      await db.execute({
        sql: 'INSERT INTO schema_migrations (version, applied_at, checksum) VALUES (?,?,?)',
        args: [version, Math.floor(Date.now() / 1000), checksum],
      });
      console.log(`done (${statements.length} statements)`);
    } catch (err) {
      console.log('FAILED');
      console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  }

  console.log(statusOnly
    ? `\n${pending} pending, ${applied.size} applied.\n`
    : pending ? `\nApplied ${pending} migration(s).\n` : '\nAlready up to date.\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
