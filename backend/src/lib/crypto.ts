/**
 * All crypto here runs on WebCrypto only. Node-only libraries (bcrypt, argon2,
 * node:crypto's scrypt) do not work on Workers, which is why password hashing
 * uses PBKDF2-SHA256 at the OWASP-recommended iteration count rather than a
 * memory-hard KDF. If you move this backend to a Node runtime, swap
 * hashPassword/verifyPassword for argon2id and bump PWD_VERSION to 2 — the
 * stored format is versioned specifically so that migration is non-breaking.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export const PWD_VERSION = 1;
const PBKDF2_ITERATIONS = 600_000; // OWASP 2023 guidance for PBKDF2-HMAC-SHA256
const SALT_BYTES = 16;
const KEY_BITS = 256;

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s: string): Uint8Array {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.length % 2 ? '0' + hex : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

/** Length-independent constant-time compare. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const bits = await deriveBits(password, salt, PBKDF2_ITERATIONS);
  return `v${PWD_VERSION}$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [ver, iterStr, saltB64, hashB64] = stored.split('$');
    if (ver !== `v${PWD_VERSION}` || !iterStr || !saltB64 || !hashB64) return false;
    const bits = await deriveBits(password, fromBase64Url(saltB64), Number(iterStr));
    return timingSafeEqual(new Uint8Array(bits), fromBase64Url(hashB64));
  } catch {
    return false;
  }
}

/** True when a stored hash used weaker params and should be re-hashed on next login. */
export function needsRehash(stored: string): boolean {
  const [ver, iterStr] = stored.split('$');
  return ver !== `v${PWD_VERSION}` || Number(iterStr) < PBKDF2_ITERATIONS;
}

async function deriveBits(password: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, KEY_BITS);
}

export async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

export async function sha256Hex(input: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(input))));
}

/**
 * Verify an HMAC signature with a replay window. `timestamp` is seconds since
 * epoch; anything older than `toleranceSec` is rejected so a captured request
 * cannot be replayed later.
 */
export async function verifySignedPayload(opts: {
  secret: string;
  body: string;
  signatureHeader: string;
  timestampHeader: string;
  toleranceSec?: number;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const tolerance = opts.toleranceSec ?? 300;
  const ts = Number(opts.timestampHeader);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'missing_or_invalid_timestamp' };
  const skew = Math.abs(Date.now() / 1000 - ts);
  if (skew > tolerance) return { ok: false, reason: `timestamp_outside_tolerance(${Math.round(skew)}s)` };

  const expected = await hmacSha256(opts.secret, `${ts}.${opts.body}`);
  const provided = opts.signatureHeader.startsWith('sha256=')
    ? opts.signatureHeader.slice(7)
    : opts.signatureHeader;

  let providedBytes: Uint8Array;
  try {
    providedBytes = /^[0-9a-f]+$/i.test(provided) ? fromHex(provided) : fromBase64Url(provided);
  } catch {
    return { ok: false, reason: 'malformed_signature' };
  }
  return timingSafeEqual(expected, providedBytes) ? { ok: true } : { ok: false, reason: 'signature_mismatch' };
}

/** Sign an outbound payload in the same format this service verifies. */
export async function signPayload(secret: string, body: string) {
  const ts = Math.floor(Date.now() / 1000);
  const sig = await hmacSha256(secret, `${ts}.${body}`);
  return { timestamp: String(ts), signature: `sha256=${toHex(sig)}` };
}

export { enc as textEncoder, dec as textDecoder };
