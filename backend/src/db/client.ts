import { createClient, type Client, type InArgs } from '@libsql/client/web';
import type { Bindings } from '../env';

/**
 * `@libsql/client/web` is the HTTP-only build. The default export opens a
 * WebSocket and uses node:fs for embedded replicas — neither exists on
 * Workers, and importing it is the single most common reason a Turso-backed
 * Worker fails to deploy. Do not change this import path.
 */
let cached: { url: string; client: Client } | null = null;

export function getDb(env: Bindings): Client {
  if (cached && cached.url === env.TURSO_DATABASE_URL) return cached.client;
  const client = createClient({
    url: env.TURSO_DATABASE_URL,
    authToken: env.TURSO_AUTH_TOKEN,
    // Keep an isolate-local connection; Workers reuses isolates across requests.
    concurrency: 20,
  });
  cached = { url: env.TURSO_DATABASE_URL, client };
  return client;
}

export type Row = Record<string, unknown>;

export async function all<T = Row>(db: Client, sql: string, args: InArgs = []): Promise<T[]> {
  const rs = await db.execute({ sql, args });
  return rs.rows as unknown as T[];
}

export async function one<T = Row>(db: Client, sql: string, args: InArgs = []): Promise<T | null> {
  const rows = await all<T>(db, sql, args);
  return rows.length ? (rows[0] as T) : null;
}

export async function run(db: Client, sql: string, args: InArgs = []) {
  return db.execute({ sql, args });
}

/**
 * libSQL over HTTP has no interactive transactions in the Workers build, so a
 * "transaction" is a single batched round trip. All-or-nothing still holds;
 * what you cannot do is read a value mid-transaction and branch on it. Where
 * you need read-then-write atomicity, use a conditional UPDATE ... WHERE and
 * check rowsAffected instead — see markWebhookProcessing().
 */
export async function batch(db: Client, statements: Array<{ sql: string; args?: InArgs }>) {
  return db.batch(
    statements.map((s) => ({ sql: s.sql, args: s.args ?? [] })),
    'write',
  );
}

export const nowSec = () => Math.floor(Date.now() / 1000);
export const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
