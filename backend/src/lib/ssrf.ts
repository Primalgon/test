/**
 * Outbound request guard (SSRF defence).
 *
 * Any time this backend fetches a URL that a user, a brief, or an uploaded file
 * had a hand in, it becomes a proxy that runs inside your network with your
 * credentials. That is SSRF, and it is on the OWASP Top Ten because the payoff
 * is large: cloud instance metadata endpoints, internal admin panels, databases
 * that trust the network, and — on Cloudflare specifically — other Workers and
 * private services bound to the same account.
 *
 * Rules here, in the order they matter:
 *
 *  1. **Allowlist, never blocklist.** Enumerating bad destinations is a losing
 *     game; there is always another encoding, another redirect, another alias.
 *     Enumerate the handful of hosts this service legitimately calls instead.
 *  2. **Re-validate after every redirect.** An allowed host returning a 302 to
 *     169.254.169.254 defeats a check done only on the original URL. This is the
 *     single most common way a "validated" fetch is bypassed, so redirects are
 *     followed manually.
 *  3. **Reject credentials, non-standard ports, and non-HTTPS.** `https://
 *     allowed.com@evil.com/` parses with host `evil.com`; plenty of hand-rolled
 *     checks read the string instead of the parsed host and get this wrong.
 *  4. **Bound size and time.** An allowed host can still return ten gigabytes or
 *     hang forever, and either takes the Worker down without any SSRF involved.
 */

export interface EgressPolicy {
  allowHosts: string[];
  maxRedirects?: number;
  timeoutMs?: number;
  maxBytes?: number;
  allowHttp?: boolean;   // localhost development only
}

export class EgressBlocked extends Error {
  constructor(public readonly url: string, public readonly rule: string) {
    super(`Outbound request blocked (${rule}): ${url}`);
    this.name = 'EgressBlocked';
  }
}

/**
 * Literal IP forms that must never be reachable.
 *
 * Workers resolve DNS at the edge, so a classic DNS-rebinding attack against
 * this specific runtime is not the main risk — but a raw literal in a URL is,
 * and blocking these costs nothing. Note `0x7f.1`, `2130706433`, and `[::ffff:
 * 127.0.0.1]` are all valid ways to write localhost that a naive `=== '127.0.0.1'`
 * check misses entirely.
 */
const BLOCKED_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,          // link-local — cloud instance metadata lives here
  /^0\.0\.0\.0$/,
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i, // unique local IPv6
  /^\[?fe80:/i,             // link-local IPv6
  /^\d+$/,                  // bare integer form of an IPv4 address
  /^0x/i,                   // hex form
  /\.internal$/i,
  /\.local$/i,
  /^metadata\./i,
];

export function assertUrlAllowed(rawUrl: string, policy: EgressPolicy): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new EgressBlocked(rawUrl, 'unparseable');
  }

  if (url.protocol !== 'https:' && !(policy.allowHttp && url.protocol === 'http:')) {
    throw new EgressBlocked(rawUrl, 'scheme_not_https');
  }

  // Credentials in the authority are almost always an attempt to confuse a
  // string-based host check. There is no legitimate use here.
  if (url.username || url.password) throw new EgressBlocked(rawUrl, 'credentials_in_url');

  // Explicit non-standard ports are how internal services get reached.
  if (url.port && !['443', '80'].includes(url.port)) {
    throw new EgressBlocked(rawUrl, `non_standard_port_${url.port}`);
  }

  const host = url.hostname.toLowerCase();
  for (const pattern of BLOCKED_HOST_PATTERNS) {
    if (pattern.test(host)) throw new EgressBlocked(rawUrl, 'private_or_loopback_address');
  }

  // Allowlist. An entry of "example.com" also permits its subdomains; an entry
  // beginning with "." permits subdomains only.
  const allowed = policy.allowHosts.some((entry) => {
    const e = entry.toLowerCase();
    return e.startsWith('.') ? host.endsWith(e) : host === e || host.endsWith(`.${e}`);
  });
  if (!allowed) throw new EgressBlocked(rawUrl, 'host_not_in_allowlist');

  return url;
}

/**
 * Fetch with the policy enforced at every hop.
 *
 * `redirect: 'manual'` is the important part. The default `follow` hands the
 * redirect to the runtime, which will not re-run your checks — so a single
 * allowed host that redirects anywhere becomes a fully general proxy.
 */
export async function guardedFetch(
  rawUrl: string,
  init: RequestInit,
  policy: EgressPolicy,
): Promise<Response> {
  const maxRedirects = policy.maxRedirects ?? 3;
  const timeoutMs = policy.timeoutMs ?? 10_000;

  let current = assertUrlAllowed(rawUrl, policy);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const res = await fetch(current.toString(), {
        ...init,
        redirect: 'manual',
        signal: controller.signal,
      });

      if (![301, 302, 303, 307, 308].includes(res.status)) {
        const declared = Number(res.headers.get('content-length') ?? '0');
        if (policy.maxBytes && declared > policy.maxBytes) {
          throw new EgressBlocked(current.toString(), `response_too_large_${declared}`);
        }
        return res;
      }

      const location = res.headers.get('location');
      if (!location) throw new EgressBlocked(current.toString(), 'redirect_without_location');

      // Resolve relative redirects against the current URL, then re-validate.
      current = assertUrlAllowed(new URL(location, current).toString(), policy);
    }
    throw new EgressBlocked(rawUrl, `too_many_redirects_${maxRedirects}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read a response body with a hard ceiling.
 *
 * `Content-Length` is a claim, not a fact — a hostile or broken server can omit
 * it or lie. Counting bytes as they arrive is the only version that holds.
 */
export async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new EgressBlocked(res.url, `body_exceeded_${maxBytes}_bytes`);
    }
    chunks.push(value);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

/**
 * The only hosts this backend has any reason to contact. Everything outbound
 * goes through here — adding a destination should be a deliberate edit that
 * shows up in review, not something a route does inline.
 */
export const DEFAULT_EGRESS: EgressPolicy = {
  allowHosts: [
    'api.stripe.com',
    'api.zeptomail.com',
    'api.zeptomail.eu',
    'api.cloudflare.com',
    'challenges.cloudflare.com',
    'api.pwnedpasswords.com',
  ],
  maxRedirects: 2,
  timeoutMs: 10_000,
  maxBytes: 5_000_000,
};
