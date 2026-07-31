import type { Bindings } from '../env';
import { upstream, notImplemented } from '../lib/errors';

/**
 * Cloudflare API v4 wrapper. Used at runtime only for cache purging and
 * Turnstile; zone creation, DNS, WAF and TLS settings happen once at
 * provisioning time (scripts/provision.ts) using the same helpers.
 */
const API = 'https://api.cloudflare.com/client/v4';

interface CfEnvelope<T> { success: boolean; errors: Array<{ code: number; message: string }>; result: T }

export async function cf<T>(env: Bindings, path: string, init: RequestInit = {}): Promise<T> {
  if (!env.CLOUDFLARE_API_TOKEN) throw notImplemented('Cloudflare management');
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const json = (await res.json()) as CfEnvelope<T>;
  if (!res.ok || !json.success) {
    throw upstream('Cloudflare API', json.errors?.map((e) => `${e.code}: ${e.message}`).join('; ') ?? res.status);
  }
  return json.result;
}

export const purgeCache = (env: Bindings, files?: string[]) =>
  cf(env, `/zones/${env.CLOUDFLARE_ZONE_ID}/purge_cache`, {
    method: 'POST',
    body: JSON.stringify(files?.length ? { files } : { purge_everything: true }),
  });

/**
 * Turnstile is Cloudflare's CAPTCHA alternative. Verified server-side only —
 * a client-side "success" callback proves nothing.
 */
export async function verifyTurnstile(
  env: Bindings, token: string, remoteIp?: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (!env.CLOUDFLARE_TURNSTILE_SECRET) return { ok: true, reason: 'not_configured' };
  const form = new FormData();
  form.append('secret', env.CLOUDFLARE_TURNSTILE_SECRET);
  form.append('response', token);
  if (remoteIp) form.append('remoteip', remoteIp);

  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST', body: form,
  });
  const json = (await res.json()) as { success: boolean; 'error-codes'?: string[] };
  return json.success ? { ok: true } : { ok: false, reason: json['error-codes']?.join(',') ?? 'failed' };
}

// --- provisioning-time helpers (called from scripts, not from request path) ---

export const createZone = (env: Bindings, name: string, accountId: string) =>
  cf<{ id: string; name_servers: string[] }>(env, '/zones', {
    method: 'POST',
    body: JSON.stringify({ name, account: { id: accountId }, type: 'full', jump_start: false }),
  });

export const upsertDnsRecord = (env: Bindings, zoneId: string, rec: {
  type: string; name: string; content: string; proxied?: boolean; ttl?: number; priority?: number;
}) =>
  cf(env, `/zones/${zoneId}/dns_records`, {
    method: 'POST',
    body: JSON.stringify({ ttl: 1, proxied: rec.proxied ?? true, ...rec }),
  });

/** Baseline hardening applied to every generated site's zone. */
export async function applyZoneBaseline(env: Bindings, zoneId: string) {
  const settings: Array<[string, unknown]> = [
    ['ssl', 'strict'],
    ['always_use_https', 'on'],
    ['min_tls_version', '1.2'],
    ['tls_1_3', 'on'],
    ['automatic_https_rewrites', 'on'],
    ['opportunistic_encryption', 'on'],
    ['brotli', 'on'],
    ['early_hints', 'on'],
    ['http3', 'on'],
    ['0rtt', 'on'],
    ['security_level', 'medium'],
    ['browser_check', 'on'],
    ['challenge_ttl', 1800],
  ];
  const results: Array<{ setting: string; ok: boolean; error?: string }> = [];
  for (const [id, value] of settings) {
    try {
      await cf(env, `/zones/${zoneId}/settings/${id}`, { method: 'PATCH', body: JSON.stringify({ value }) });
      results.push({ setting: id, ok: true });
    } catch (e) {
      // Some settings are plan-gated; a failure here should not abort provisioning.
      results.push({ setting: id, ok: false, error: String(e).slice(0, 200) });
    }
  }
  return results;
}

/** WAF custom rules: block obvious probing, rate-limit the auth surface. */
export const applyWafBaseline = (env: Bindings, zoneId: string) =>
  cf(env, `/zones/${zoneId}/rulesets`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'forge-baseline',
      kind: 'zone',
      phase: 'http_request_firewall_custom',
      rules: [
        {
          description: 'Block common CMS and env-file probes',
          expression: '(http.request.uri.path contains "/wp-admin") or (http.request.uri.path contains "/wp-login") or (http.request.uri.path contains "/.env") or (http.request.uri.path contains "/.git/") or (http.request.uri.path contains "/phpmyadmin")',
          action: 'block',
        },
        {
          description: 'Managed challenge on auth endpoints for suspicious clients',
          expression: '(http.request.uri.path contains "/api/auth/") and (cf.threat_score gt 14)',
          action: 'managed_challenge',
        },
        {
          description: 'Block requests with no user agent to write endpoints',
          expression: '(http.request.method in {"POST" "PATCH" "DELETE"}) and (http.user_agent eq "")',
          action: 'block',
        },
      ],
    }),
  });
