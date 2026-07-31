/**
 * Field-level encryption for personal data at rest.
 *
 * The threat this addresses is specific and worth stating, because encryption
 * at rest is often deployed against a threat it does not stop. Turso already
 * encrypts its storage volumes; that protects against someone walking out with
 * a disk. It does **not** protect against a leaked `TURSO_AUTH_TOKEN`, a
 * mis-scoped read replica, an SQL injection that reaches SELECT, or a database
 * dump shared with a contractor — in all of those the attacker is a legitimate
 * client and the volume encryption is transparently undone for them.
 *
 * This layer means the rows they get back read as ciphertext, and the key that
 * decrypts it lives in the Worker's secret store, not the database.
 *
 * AES-256-GCM, envelope-encrypted, with versioned keys so rotation does not
 * require a rewrite of every historical row.
 *
 *   v1.<keyId>.<iv>.<ciphertext+tag>
 *
 * ## The searchability problem
 *
 * Encrypting a column destroys `WHERE email = ?`, because the same plaintext
 * encrypts to different bytes each time (which is the point — deterministic
 * encryption leaks equality, and equality on an email column is most of what an
 * attacker wants). The answer is a blind index: a keyed hash stored alongside
 * the ciphertext, which supports exact-match lookup and nothing else. No range
 * queries, no LIKE, no sorting. Design the schema knowing that.
 */

import { textEncoder, textDecoder, randomBytes, toBase64Url, fromBase64Url, toHex } from './crypto';

const FORMAT_VERSION = 'v1';
const IV_BYTES = 12; // GCM standard; 96 bits is what the NIST guidance specifies

type KeyCache = Map<string, CryptoKey>;
const keyCache: KeyCache = new Map();

/**
 * Keyring parsed from the DATA_ENCRYPTION_KEYS secret.
 *
 * Format: `keyId:base64key,keyId:base64key`. The **first** entry is the active
 * key used for all new writes; the rest exist only to decrypt older rows. To
 * rotate, prepend a new key — nothing needs re-encrypting immediately, and a
 * background job can walk old rows at leisure.
 */
function parseKeyring(raw: string): Array<{ id: string; material: Uint8Array }> {
  const entries = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!entries.length) throw new Error('DATA_ENCRYPTION_KEYS is empty');
  return entries.map((entry) => {
    const idx = entry.indexOf(':');
    if (idx === -1) throw new Error('Keyring entry must be "keyId:base64key"');
    const id = entry.slice(0, idx);
    const material = fromBase64Url(entry.slice(idx + 1));
    if (material.length !== 32) throw new Error(`Key ${id} is not 32 bytes (AES-256)`);
    return { id, material };
  });
}

async function importKey(id: string, material: Uint8Array): Promise<CryptoKey> {
  const cached = keyCache.get(id);
  if (cached) return cached;
  const key = await crypto.subtle.importKey(
    'raw', material as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'],
  );
  keyCache.set(id, key);
  return key;
}

export interface Cipher {
  encrypt(plaintext: string, aad?: string): Promise<string>;
  decrypt(payload: string, aad?: string): Promise<string>;
  blindIndex(plaintext: string): Promise<string>;
  activeKeyId: string;
}

/**
 * Build a cipher from environment secrets.
 *
 * `aad` (additional authenticated data) binds a ciphertext to its context —
 * pass the row id and column name. Without it, an attacker with UPDATE access
 * can move a ciphertext from one row to another: copy the admin's encrypted
 * phone number into their own row, or swap two users' encrypted addresses. GCM
 * will happily decrypt a validly-encrypted blob in the wrong place. With AAD it
 * fails authentication, because the context no longer matches.
 */
export function createCipher(env: {
  DATA_ENCRYPTION_KEYS?: string;
  BLIND_INDEX_KEY?: string;
}): Cipher {
  if (!env.DATA_ENCRYPTION_KEYS) {
    throw new Error('DATA_ENCRYPTION_KEYS is not configured — PII columns cannot be written.');
  }
  const keyring = parseKeyring(env.DATA_ENCRYPTION_KEYS);
  const active = keyring[0]!;

  return {
    activeKeyId: active.id,

    async encrypt(plaintext: string, aad?: string): Promise<string> {
      const key = await importKey(active.id, active.material);
      // A repeated IV under the same key is catastrophic for GCM — it leaks the
      // XOR of two plaintexts and, worse, allows forging the authentication tag.
      // Random 96-bit IVs are safe up to ~2^32 messages per key, which is why
      // key rotation is built in rather than optional.
      const iv = randomBytes(IV_BYTES);
      const ct = new Uint8Array(await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv as BufferSource, ...(aad ? { additionalData: textEncoder.encode(aad) } : {}) },
        key,
        textEncoder.encode(plaintext) as BufferSource,
      ));
      return `${FORMAT_VERSION}.${active.id}.${toBase64Url(iv)}.${toBase64Url(ct)}`;
    },

    async decrypt(payload: string, aad?: string): Promise<string> {
      const [version, keyId, ivB64, ctB64] = payload.split('.');
      if (version !== FORMAT_VERSION || !keyId || !ivB64 || !ctB64) {
        throw new Error('Malformed ciphertext');
      }
      const entry = keyring.find((k) => k.id === keyId);
      if (!entry) {
        // The most likely cause is a key removed from the keyring before its
        // rows were re-encrypted. Say so plainly; a generic "decryption failed"
        // here has cost people days.
        throw new Error(`No key "${keyId}" in the keyring — it was retired before its rows were migrated.`);
      }
      const key = await importKey(entry.id, entry.material);
      const pt = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: fromBase64Url(ivB64) as BufferSource,
          ...(aad ? { additionalData: textEncoder.encode(aad) } : {}),
        },
        key,
        fromBase64Url(ctB64) as BufferSource,
      );
      return textDecoder.decode(pt);
    },

    /**
     * Keyed hash for exact-match lookup on an encrypted column.
     *
     * Keyed, not plain SHA-256: an unkeyed hash of an email address is trivially
     * reversible by anyone with a wordlist, so an unkeyed "blind" index leaks the
     * entire column. Normalised to lowercase so lookup matches how people type.
     *
     * The index is truncated to 128 bits. Full width adds nothing — the search
     * space is the user population, not 2^256 — and shorter indexes cost less on
     * every row.
     */
    async blindIndex(plaintext: string): Promise<string> {
      const secret = env.BLIND_INDEX_KEY;
      if (!secret) throw new Error('BLIND_INDEX_KEY is not configured');
      const key = await crypto.subtle.importKey(
        'raw', textEncoder.encode(secret) as BufferSource,
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
      );
      const mac = new Uint8Array(await crypto.subtle.sign(
        'HMAC', key, textEncoder.encode(plaintext.trim().toLowerCase()) as BufferSource,
      ));
      return toHex(mac.slice(0, 16));
    },
  };
}

/**
 * Generate a fresh keyring entry. Run at provisioning:
 *   node -e "import('./dist/encryption.js').then(m => console.log(m.newKeyringEntry()))"
 */
export function newKeyringEntry(): string {
  const id = `k${new Date().toISOString().slice(0, 7).replace('-', '')}`;
  return `${id}:${toBase64Url(randomBytes(32))}`;
}

/**
 * Masking for anything that reaches a log, an admin list view, or a support
 * screen. Decrypting a column and then printing it in full undoes the reason it
 * was encrypted; most operational tasks need only enough to confirm identity.
 */
export function mask(value: string, kind: 'email' | 'phone' | 'generic' = 'generic'): string {
  if (!value) return '';
  if (kind === 'email') {
    const [local = '', domain = ''] = value.split('@');
    const head = local.slice(0, 2);
    return `${head}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`;
  }
  if (kind === 'phone') {
    return `${'*'.repeat(Math.max(0, value.length - 4))}${value.slice(-4)}`;
  }
  return value.length <= 4 ? '*'.repeat(value.length) : `${'*'.repeat(value.length - 4)}${value.slice(-4)}`;
}
