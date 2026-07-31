/**
 * TOTP (RFC 6238) and recovery codes, on WebCrypto only.
 *
 * Authenticator apps are hardcoded to HMAC-SHA1, 6 digits, 30-second steps.
 * SHA-1 here is not a weakness — TOTP's security comes from the shared secret
 * and the 30-second window, not from collision resistance, and every other
 * algorithm breaks compatibility with Google Authenticator, Authy, and 1Password.
 * Do not "improve" this to SHA-256 unless you control the enrolment app.
 *
 * Three things here that most implementations get wrong, in order of how badly
 * they get exploited:
 *
 *  1. **Replay.** A valid code stays valid for its whole 30-second window. Without
 *     tracking the last accepted counter, an attacker who shoulder-surfs or
 *     intercepts one code can reuse it. `lastCounter` makes each code single-use.
 *  2. **Drift window.** ±1 step (90 seconds total) covers real clock skew. Wider
 *     windows are common and each extra step linearly multiplies an online
 *     brute-force attacker's odds.
 *  3. **Timing.** Comparing the computed code to the submitted one with `===`
 *     leaks digit-by-digit. Constant-time only.
 */

import { textEncoder, timingSafeEqual, randomBytes, toBase64Url, sha256Hex } from './crypto';

const DIGITS = 6;
const STEP_SEC = 30;
const DRIFT_STEPS = 1;

/* ------------------------------------------------------------------ *
 * Base32 (RFC 4648, no padding) — the format authenticator apps expect
 * ------------------------------------------------------------------ */

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Uint8Array {
  // Users retype these by hand off a screen. Strip spaces and padding, and
  // accept lowercase — rejecting "jbsw y3dp" as invalid is a support ticket,
  // not a security control.
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/* ------------------------------------------------------------------ *
 * Secret generation and enrolment
 * ------------------------------------------------------------------ */

/**
 * 20 bytes = 160 bits, the RFC 4226 recommended length and what every
 * authenticator app is tested against.
 */
export function generateTotpSecret(): { secret: Uint8Array; base32: string } {
  const secret = randomBytes(20);
  return { secret, base32: base32Encode(secret) };
}

/**
 * The otpauth:// URI a QR code encodes.
 *
 * `issuer` appears twice on purpose: once as a label prefix for older apps,
 * once as a parameter for current ones. Apps that support only one of the two
 * otherwise show the account as "Unknown", and a user with several TOTP entries
 * cannot tell which code belongs to which site.
 */
export function totpUri(opts: { secretBase32: string; account: string; issuer: string }): string {
  const label = encodeURIComponent(`${opts.issuer}:${opts.account}`);
  const params = new URLSearchParams({
    secret: opts.secretBase32,
    issuer: opts.issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SEC),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/* ------------------------------------------------------------------ *
 * Code generation and verification
 * ------------------------------------------------------------------ */

async function hotp(secret: Uint8Array, counter: number): Promise<string> {
  // 8-byte big-endian counter. JS bitwise operators are 32-bit, so the high
  // word is written by division rather than by shifting — a `>>> 32` would
  // silently produce the low word again and every code past 2^32 steps
  // (year 6053) would be wrong. Cheap to get right, impossible to debug later.
  const buf = new Uint8Array(8);
  let high = Math.floor(counter / 0x100000000);
  let low = counter >>> 0;
  for (let i = 3; i >= 0; i--) { buf[i] = high & 0xff; high >>>= 8; }
  for (let i = 7; i >= 4; i--) { buf[i] = low & 0xff; low >>>= 8; }

  const key = await crypto.subtle.importKey(
    'raw', secret as BufferSource, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf as BufferSource));

  // Dynamic truncation, RFC 4226 §5.3.
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) |
    ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) |
    (mac[offset + 3]! & 0xff);

  return (binary % 10 ** DIGITS).toString().padStart(DIGITS, '0');
}

export function currentCounter(atMs = Date.now()): number {
  return Math.floor(atMs / 1000 / STEP_SEC);
}

/**
 * Verify a submitted code.
 *
 * Returns the counter that matched so the caller can persist it. Refusing any
 * counter at or below `lastCounter` is what makes a code single-use — without
 * it, the same six digits work for the remainder of their window and for the
 * full drift window on either side.
 */
export async function verifyTotp(opts: {
  secret: Uint8Array;
  code: string;
  lastCounter?: number | null;
  atMs?: number;
}): Promise<{ ok: true; counter: number } | { ok: false; reason: 'format' | 'replay' | 'mismatch' }> {
  const submitted = opts.code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(submitted)) return { ok: false, reason: 'format' };

  const now = currentCounter(opts.atMs);
  const submittedBytes = textEncoder.encode(submitted);

  // Walk the whole window even after a match. Returning early on the first hit
  // makes verification time depend on which step matched, which tells an
  // attacker how far their clock is off — small, but free to avoid.
  let matched: number | null = null;
  for (let d = -DRIFT_STEPS; d <= DRIFT_STEPS; d++) {
    const counter = now + d;
    if (counter < 0) continue;
    const expected = await hotp(opts.secret, counter);
    if (timingSafeEqual(textEncoder.encode(expected), submittedBytes)) matched = counter;
  }

  if (matched === null) return { ok: false, reason: 'mismatch' };
  if (opts.lastCounter != null && matched <= opts.lastCounter) return { ok: false, reason: 'replay' };
  return { ok: true, counter: matched };
}

/* ------------------------------------------------------------------ *
 * Recovery codes
 * ------------------------------------------------------------------ */

/**
 * Ten single-use codes, shown once at enrolment.
 *
 * Stored as SHA-256 rather than PBKDF2 deliberately: these are 80 bits of
 * uniform randomness, not human-chosen passwords, so there is no dictionary to
 * defend against and no reason to pay 600k iterations on every attempt. That
 * reasoning does not transfer to passwords.
 */
export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    // Grouped for legibility — people transcribe these off a printout under
    // stress, having already lost their phone.
    const raw = toBase64Url(randomBytes(10)).replace(/[^a-zA-Z0-9]/g, '').slice(0, 10).toLowerCase();
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5, 10)}`);
  }
  return codes;
}

export async function hashRecoveryCode(code: string): Promise<string> {
  return sha256Hex(code.toLowerCase().replace(/[\s-]/g, ''));
}

/**
 * Match a submitted recovery code against stored hashes.
 *
 * Every stored hash is compared even after a hit, for the same timing reason as
 * above. The caller must delete the matched hash — a recovery code that
 * survives its own use is just a second password.
 */
export async function matchRecoveryCode(
  submitted: string,
  storedHashes: string[],
): Promise<string | null> {
  const hash = await hashRecoveryCode(submitted);
  const hashBytes = textEncoder.encode(hash);
  let found: string | null = null;
  for (const stored of storedHashes) {
    if (timingSafeEqual(textEncoder.encode(stored), hashBytes)) found = stored;
  }
  return found;
}

export { DIGITS, STEP_SEC, DRIFT_STEPS };
