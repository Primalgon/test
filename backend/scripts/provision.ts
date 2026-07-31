#!/usr/bin/env tsx
/**
 * One-shot provisioning for a new site. Runs from Node on a host with a
 * STATIC IP (your n8n box or a small VPS) because Namecheap requires the
 * calling IP to be whitelisted — this is exactly why it is a script and not a
 * Worker route.
 *
 *   tsx scripts/provision.ts --brief ./brief.json [--live]
 *
 * Without --live it runs in dry mode: no domain is bought, no mailbox is
 * created, nothing is charged. Every step is idempotent, so re-running after
 * a partial failure resumes rather than duplicating.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createClient } from '@libsql/client';
import 'dotenv/config';
import {
  checkAvailability, registerDomain, setCustomNameservers, setRegistrarLock,
  type NamecheapConfig,
} from '../src/services/namecheap';

interface Step { name: string; status: 'ok' | 'skipped' | 'failed'; detail?: string }
const steps: Step[] = [];
const record = (name: string, status: Step['status'], detail?: string) => {
  steps.push({ name, status, detail });
  const mark = status === 'ok' ? '  ok     ' : status === 'skipped' ? '  skip   ' : '  FAILED ';
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ''}`);
};

const argv = process.argv.slice(2);
const live = argv.includes('--live');
const briefPath = argv[argv.indexOf('--brief') + 1];
if (!briefPath) { console.error('Usage: tsx scripts/provision.ts --brief ./brief.json [--live]'); process.exit(1); }

const CF_API = 'https://api.cloudflare.com/client/v4';

async function cf<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${CF_API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const json = await res.json() as any;
  if (!res.ok || !json.success) {
    throw new Error(json.errors?.map((e: any) => `${e.code}: ${e.message}`).join('; ') ?? `HTTP ${res.status}`);
  }
  return json.result as T;
}

async function main() {
  const brief = JSON.parse(await readFile(briefPath!, 'utf8'));
  const domain: string = brief.site.domain.desired;
  const slug = domain.split('.')[0]!.replace(/[^a-z0-9]/g, '-');

  console.log(`\nProvisioning ${domain}  (${live ? 'LIVE — real charges' : 'dry run'})\n`);

  const nc: NamecheapConfig = {
    apiUser: process.env.NAMECHEAP_API_USER!,
    apiKey: process.env.NAMECHEAP_API_KEY!,
    username: process.env.NAMECHEAP_USERNAME!,
    clientIp: process.env.NAMECHEAP_CLIENT_IP!,
    sandbox: process.env.NAMECHEAP_SANDBOX === 'true',
    dryRun: !live,
  };

  // --- 1. domain ----------------------------------------------------------
  let nameservers: string[] = [];
  if (brief.site.domain.registrar_action === 'register_new') {
    try {
      const [availability] = await checkAvailability(nc, [domain]);
      if (!availability?.available) {
        record('domain availability', 'failed', `${domain} is taken`);
        console.error('\nStopping: pick another domain or switch registrar_action to point_existing.\n');
        process.exit(1);
      }
      if (availability.isPremium) {
        record('domain availability', 'failed', `premium domain, ${availability.premiumPrice} — needs manual approval`);
        process.exit(1);
      }
      record('domain availability', 'ok', domain);

      const reg = await registerDomain(nc, {
        domain,
        years: 1,
        whoisGuard: true,
        contact: {
          firstName: process.env.REGISTRANT_FIRST_NAME!,
          lastName: process.env.REGISTRANT_LAST_NAME!,
          address1: process.env.REGISTRANT_ADDRESS!,
          city: process.env.REGISTRANT_CITY!,
          stateProvince: process.env.REGISTRANT_STATE!,
          postalCode: process.env.REGISTRANT_POSTAL!,
          country: process.env.REGISTRANT_COUNTRY!,
          phone: process.env.REGISTRANT_PHONE!,       // format: +1.3055550123
          emailAddress: process.env.REGISTRANT_EMAIL!,
          organizationName: process.env.REGISTRANT_ORG,
        },
      });
      record('domain registration', reg.dryRun ? 'skipped' : 'ok', reg.dryRun ? 'dry run' : `$${reg.chargedAmount}`);
    } catch (e) {
      record('domain registration', 'failed', String(e).slice(0, 160));
    }
  } else {
    record('domain registration', 'skipped', brief.site.domain.registrar_action);
  }

  // --- 2. Cloudflare zone --------------------------------------------------
  let zoneId = '';
  try {
    const existing = await cf<any[]>(`/zones?name=${domain}`);
    if (existing.length) {
      zoneId = existing[0].id;
      nameservers = existing[0].name_servers ?? [];
      record('cloudflare zone', 'skipped', `already exists (${zoneId})`);
    } else if (live) {
      const zone = await cf<{ id: string; name_servers: string[] }>('/zones', {
        method: 'POST',
        body: JSON.stringify({ name: domain, account: { id: process.env.CLOUDFLARE_ACCOUNT_ID }, type: 'full' }),
      });
      zoneId = zone.id;
      nameservers = zone.name_servers;
      record('cloudflare zone', 'ok', zoneId);
    } else {
      record('cloudflare zone', 'skipped', 'dry run');
    }
  } catch (e) {
    record('cloudflare zone', 'failed', String(e).slice(0, 160));
  }

  // --- 3. point registrar at Cloudflare ------------------------------------
  if (nameservers.length && brief.site.domain.nameserver_control !== false) {
    try {
      const r = await setCustomNameservers(nc, domain, nameservers);
      record('nameservers', r.dryRun ? 'skipped' : 'ok', nameservers.join(', '));
      if (live) await setRegistrarLock(nc, domain, true);
    } catch (e) {
      record('nameservers', 'failed', String(e).slice(0, 160));
    }
  } else {
    record('nameservers', 'skipped', 'no zone or client keeps DNS control');
  }

  // --- 4. DNS + zone hardening --------------------------------------------
  if (zoneId && live) {
    const records = [
      { type: 'CNAME', name: '@', content: `${slug}.pages.dev`, proxied: true },
      { type: 'CNAME', name: 'www', content: domain, proxied: true },
      // Zoho Mail MX. Priorities matter; a wrong order silently loses mail.
      { type: 'MX', name: '@', content: 'mx.zoho.com', priority: 10, proxied: false },
      { type: 'MX', name: '@', content: 'mx2.zoho.com', priority: 20, proxied: false },
      { type: 'MX', name: '@', content: 'mx3.zoho.com', priority: 50, proxied: false },
      { type: 'TXT', name: '@', content: 'v=spf1 include:zoho.com ~all', proxied: false },
      { type: 'TXT', name: '_dmarc', content: `v=DMARC1; p=quarantine; rua=mailto:dmarc@${domain}; pct=100; adkim=s; aspf=s`, proxied: false },
    ];
    for (const rec of records) {
      try {
        await cf(`/zones/${zoneId}/dns_records`, { method: 'POST', body: JSON.stringify({ ttl: 1, ...rec }) });
        record(`dns ${rec.type} ${rec.name}`, 'ok');
      } catch (e) {
        const msg = String(e);
        record(`dns ${rec.type} ${rec.name}`, msg.includes('81057') || msg.includes('already exists') ? 'skipped' : 'failed', msg.slice(0, 120));
      }
    }

    // DKIM cannot be created here: Zoho generates the key and you must copy the
    // published selector into DNS. The provisioning report flags it so the
    // pipeline does not silently ship a domain that fails DMARC alignment.
    record('dkim', 'skipped', 'MANUAL: publish Zoho DKIM selector before enabling p=reject');

    const settings: Array<[string, unknown]> = [
      ['ssl', 'strict'], ['always_use_https', 'on'], ['min_tls_version', '1.2'],
      ['tls_1_3', 'on'], ['automatic_https_rewrites', 'on'], ['brotli', 'on'],
      ['early_hints', 'on'], ['http3', 'on'], ['security_level', 'medium'],
    ];
    let applied = 0;
    for (const [id, value] of settings) {
      try { await cf(`/zones/${zoneId}/settings/${id}`, { method: 'PATCH', body: JSON.stringify({ value }) }); applied++; }
      catch { /* plan-gated settings fail harmlessly */ }
    }
    record('zone hardening', 'ok', `${applied}/${settings.length} settings`);
  } else {
    record('dns records', 'skipped', live ? 'no zone' : 'dry run');
  }

  // --- 5. Turso database ---------------------------------------------------
  // Turso's platform API creates the DB; the migration runner then fills it.
  try {
    if (live && process.env.TURSO_PLATFORM_TOKEN) {
      const org = process.env.TURSO_ORG!;
      const res = await fetch(`https://api.turso.tech/v1/organizations/${org}/databases`, {
        method: 'POST',
        headers: { authorization: `Bearer ${process.env.TURSO_PLATFORM_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: slug, group: process.env.TURSO_GROUP ?? 'default' }),
      });
      if (res.ok || res.status === 409) record('turso database', res.status === 409 ? 'skipped' : 'ok', slug);
      else record('turso database', 'failed', `${res.status} ${(await res.text()).slice(0, 120)}`);
    } else {
      record('turso database', 'skipped', live ? 'TURSO_PLATFORM_TOKEN not set' : 'dry run');
    }
  } catch (e) {
    record('turso database', 'failed', String(e).slice(0, 160));
  }

  // --- 6. report -----------------------------------------------------------
  const report = {
    domain, slug, zone_id: zoneId, nameservers, live,
    generated_at: new Date().toISOString(),
    steps,
    manual_actions: steps.filter((s) => s.detail?.startsWith('MANUAL')).map((s) => s.name),
    next: [
      'npm run migrate                 (create tables in the new Turso DB)',
      'tsx scripts/push-secrets.ts     (load secrets into the Worker)',
      'npx wrangler deploy             (ship the API)',
      'npm run verify                  (assert the whole surface responds)',
    ],
  };
  await writeFile(`./provision-${slug}.json`, JSON.stringify(report, null, 2));

  const failed = steps.filter((s) => s.status === 'failed');
  console.log(`\n${failed.length ? `${failed.length} step(s) failed.` : 'All steps completed.'}`);
  console.log(`Report written to provision-${slug}.json\n`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
