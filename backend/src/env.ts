import { z } from 'zod';

/**
 * Worker bindings. Anything added to wrangler.toml must appear here or it is
 * invisible to TypeScript.
 */
export interface Bindings {
  // KV / DO / R2
  CACHE: KVNamespace;
  RATE_LIMITER: DurableObjectNamespace;
  MEDIA: R2Bucket;

  // vars
  SITE_SLUG: string;
  SITE_NAME: string;
  PUBLIC_ORIGIN: string;
  ADMIN_ORIGIN: string;
  ENVIRONMENT: string;
  MAIL_FROM: string;
  MAIL_FROM_NAME: string;
  STRIPE_ENABLED: string;
  LOG_LEVEL: string;

  // secrets
  TURSO_DATABASE_URL: string;
  TURSO_AUTH_TOKEN: string;
  SESSION_SECRET: string;
  SESSION_SECRET_PREVIOUS?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PUBLISHABLE_KEY?: string;
  ZEPTOMAIL_TOKEN?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_ZONE_ID?: string;
  CLOUDFLARE_TURNSTILE_SECRET?: string;
  PLATFORM_INGEST_URL?: string;
  PLATFORM_INGEST_SECRET?: string;

  // Security. DATA_ENCRYPTION_KEYS is a comma-separated keyring, newest first:
  //   k202607:<base64url 32 bytes>,k202601:<base64url 32 bytes>
  // Rotating means prepending a new key; old rows keep decrypting.
  DATA_ENCRYPTION_KEYS?: string;
  BLIND_INDEX_KEY?: string;
  SECURITY_CONTACT?: string;
  SITE_DOMAIN?: string;
}

/**
 * Anything in this schema is required for the Worker to serve a single request.
 * Optional integrations degrade: if Stripe keys are absent, /api/checkout
 * returns 501 with an explicit message instead of throwing at import time.
 */
const RequiredSchema = z.object({
  SITE_SLUG: z.string().min(1),
  SITE_NAME: z.string().min(1),
  PUBLIC_ORIGIN: z.string().url(),
  ENVIRONMENT: z.enum(['development', 'staging', 'production']),
  TURSO_DATABASE_URL: z.string().min(1),
  TURSO_AUTH_TOKEN: z.string().min(1),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 chars'),
});

export type Capability =
  | 'stripe'
  | 'mail'
  | 'turnstile'
  | 'platform_ingest'
  | 'cloudflare_admin'
  | 'field_encryption'
  | 'mfa';

export interface Capabilities {
  has(cap: Capability): boolean;
  list(): Record<Capability, boolean>;
}

let validated: WeakSet<object> = new WeakSet();

/**
 * Validate once per isolate. Throws a ConfigError that the error middleware
 * renders as a 500 naming the exact missing keys — the failure mode you want
 * at 3am, not `Cannot read properties of undefined`.
 */
export function assertEnv(env: Bindings): void {
  if (validated.has(env as unknown as object)) return;
  const result = RequiredSchema.safeParse(env);
  if (!result.success) {
    const missing = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new ConfigError(`Worker misconfigured -> ${missing}`);
  }
  validated.add(env as unknown as object);
}

export function capabilities(env: Bindings): Capabilities {
  const map: Record<Capability, boolean> = {
    stripe: env.STRIPE_ENABLED === 'true' && !!env.STRIPE_SECRET_KEY && !!env.STRIPE_WEBHOOK_SECRET,
    mail: !!env.ZEPTOMAIL_TOKEN && !!env.MAIL_FROM,
    turnstile: !!env.CLOUDFLARE_TURNSTILE_SECRET,
    platform_ingest: !!env.PLATFORM_INGEST_URL && !!env.PLATFORM_INGEST_SECRET,
    cloudflare_admin: !!env.CLOUDFLARE_API_TOKEN && !!env.CLOUDFLARE_ZONE_ID,
    field_encryption: !!env.DATA_ENCRYPTION_KEYS && !!env.BLIND_INDEX_KEY,
    // MFA depends on field encryption: storing a TOTP shared secret in plaintext
    // beside the password hash means one database read yields both factors,
    // which reduces two-factor authentication to decoration.
    mfa: !!env.DATA_ENCRYPTION_KEYS,
  };
  return { has: (c) => map[c], list: () => map };
}

export class ConfigError extends Error {
  readonly status = 500;
  readonly code = 'misconfigured';
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const isProd = (env: Bindings) => env.ENVIRONMENT === 'production';
