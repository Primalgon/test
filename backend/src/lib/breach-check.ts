/**
 * Breached-password screening, via the Have I Been Pwned range API.
 *
 * This is the single highest-value password control there is, and it is not
 * close. Credential stuffing — replaying username/password pairs from other
 * services' breaches — is how the large majority of account takeovers actually
 * happen. Complexity rules ("one uppercase, one symbol") do nothing against it;
 * `Password1!` satisfies every such rule and appears in breach corpora millions
 * of times over. NIST SP 800-63B says the same thing: drop composition rules,
 * check against a breach list.
 *
 * ## k-anonymity
 *
 * The password never leaves this Worker. SHA-1 the password, send the first
 * five hex characters, receive every suffix sharing that prefix (~800 of them),
 * and match locally. The API learns a bucket containing hundreds of candidate
 * hashes and cannot tell which — or whether the password was even present.
 *
 * SHA-1 is required by the protocol and is not a weakness here: it is a lookup
 * key against a public corpus, not a stored credential.
 */

import { textEncoder, toHex } from './crypto';

const RANGE_ENDPOINT = 'https://api.pwnedpasswords.com/range/';
const TIMEOUT_MS = 2500;

export interface BreachResult {
  breached: boolean;
  count: number;
  checked: boolean;   // false when the service was unreachable
  reason?: string;
}

export async function checkPasswordBreached(
  password: string,
  opts: { threshold?: number; timeoutMs?: number } = {},
): Promise<BreachResult> {
  // A password seen once may be a coincidence in a corpus of a billion. Seen
  // ten or more times, it is in every stuffing list in circulation. Tune this
  // if support load is a problem; do not set it to zero.
  const threshold = opts.threshold ?? 10;

  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-1', textEncoder.encode(password) as BufferSource),
  );
  const hash = toHex(digest).toUpperCase();
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? TIMEOUT_MS);

  try {
    const res = await fetch(RANGE_ENDPOINT + prefix, {
      signal: controller.signal,
      headers: {
        // Padding asks the API to return a variable number of decoy hashes, so
        // the *response size* stops being a side channel. Without it, an observer
        // on the wire can narrow the bucket by length alone.
        'Add-Padding': 'true',
        'User-Agent': 'forge-site-backend',
      },
      // Buckets are stable and public; caching them at the edge removes almost
      // all of this latency from the signup path.
      cf: { cacheTtl: 86400, cacheEverything: true },
    } as RequestInit);

    if (!res.ok) return { breached: false, count: 0, checked: false, reason: `http_${res.status}` };

    const body = await res.text();
    for (const line of body.split('\n')) {
      const sep = line.indexOf(':');
      if (sep === -1) continue;
      if (line.slice(0, sep).trim().toUpperCase() !== suffix) continue;
      const count = Number(line.slice(sep + 1).trim());
      // Padding entries come back with a count of 0. They are decoys, not hits.
      if (count === 0) return { breached: false, count: 0, checked: true };
      return { breached: count >= threshold, count, checked: true };
    }
    return { breached: false, count: 0, checked: true };
  } catch (err) {
    // Fail open, and say so in the return value.
    //
    // This is a deliberate trade and worth defending: failing closed would mean
    // that an HIBP outage blocks every signup and every password reset on every
    // site you have generated. The control is a strong filter, not an
    // authentication boundary — password hashing, rate limiting, lockout and MFA
    // are all still in force. Availability wins here. The caller records
    // `checked: false` so the gap is visible in the audit log rather than silent.
    return {
      breached: false, count: 0, checked: false,
      reason: (err as Error).name === 'AbortError' ? 'timeout' : String(err).slice(0, 120),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Local checks that need no network — run these first so an obviously bad
 * password never costs an HTTP round trip.
 *
 * Length-based, per NIST 800-63B. Composition rules are absent on purpose: they
 * measurably push people toward predictable substitutions and reuse, and they
 * are what produced `Password1!` as a cultural artifact.
 */
export function localPasswordProblems(
  password: string,
  context: { email?: string; name?: string; siteName?: string } = {},
): string[] {
  const problems: string[] = [];
  const pw = password.trim();

  if (pw.length < 12) problems.push('Use at least 12 characters.');
  // Upper bound guards against a PBKDF2 denial-of-service: a megabyte password
  // costs real CPU per attempt. 128 is far past any real passphrase.
  if (pw.length > 128) problems.push('Use at most 128 characters.');

  const lower = pw.toLowerCase();

  // Context-specific terms never appear in a generic breach list but are the
  // first thing a targeted attacker tries.
  const terms = [
    context.email?.split('@')[0],
    context.name,
    context.siteName,
  ].filter((t): t is string => !!t && t.length >= 3);
  for (const term of terms) {
    if (lower.includes(term.toLowerCase())) {
      problems.push('Avoid using your name, email, or this site\'s name in the password.');
      break;
    }
  }

  if (/^(.)\1+$/.test(pw)) problems.push('Avoid a single repeated character.');
  if (/^(0123456789|1234567890|qwertyuiop|abcdefghij)/.test(lower)) {
    problems.push('Avoid keyboard or number sequences.');
  }

  return problems;
}
