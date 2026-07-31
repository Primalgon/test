#!/usr/bin/env tsx
/**
 * Loads .dev.vars-style secrets into a deployed Worker via wrangler.
 * Uses `wrangler secret bulk`, which is one API call instead of N prompts.
 *
 *   tsx scripts/push-secrets.ts --env production --file .dev.vars
 */
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const file = args[args.indexOf('--file') + 1] ?? '.dev.vars';
const envName = args.includes('--env') ? args[args.indexOf('--env') + 1] : undefined;

// Only these are pushed as Worker secrets. Anything else in the file is
// provisioning-only (Namecheap, Turso platform token) and must never reach the
// edge, where a compromised Worker could then buy domains.
const WORKER_SECRETS = [
  'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN', 'SESSION_SECRET', 'SESSION_SECRET_PREVIOUS',
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PUBLISHABLE_KEY',
  'ZEPTOMAIL_TOKEN', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_ZONE_ID',
  'CLOUDFLARE_TURNSTILE_SECRET',
  'PLATFORM_INGEST_URL', 'PLATFORM_INGEST_SECRET',
  'DATA_ENCRYPTION_KEYS', 'BLIND_INDEX_KEY', 'SECURITY_CONTACT', 'SITE_DOMAIN',
];

const raw = await readFile(file, 'utf8');
const parsed: Record<string, string> = {};
for (const line of raw.split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (!m) continue;
  const value = m[2]!.trim().replace(/^["']|["']$/g, '');
  if (value && WORKER_SECRETS.includes(m[1]!)) parsed[m[1]!] = value;
}

const skipped = WORKER_SECRETS.filter((k) => !parsed[k]);
console.log(`Pushing ${Object.keys(parsed).length} secrets${envName ? ` to env ${envName}` : ''}.`);
if (skipped.length) console.log(`Not set (feature will report as unavailable): ${skipped.join(', ')}`);

const child = spawn('npx', ['wrangler', 'secret', 'bulk', ...(envName ? ['--env', envName] : [])], {
  stdio: ['pipe', 'inherit', 'inherit'],
});
child.stdin.write(JSON.stringify(parsed));
child.stdin.end();
child.on('exit', (code) => process.exit(code ?? 1));
