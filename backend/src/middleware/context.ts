import type { MiddlewareHandler } from 'hono';
import { createLogger } from '../lib/logger';
import { sha256Hex } from '../lib/crypto';
import { getDb } from '../db/client';
import { assertEnv, capabilities } from '../env';
import type { AppContext } from '../types';

/**
 * Runs first. Establishes a request id, a scoped logger, the db handle, the
 * capability map, and a hashed client IP (we never store or log raw IPs).
 */
export const requestContext: MiddlewareHandler<AppContext> = async (c, next) => {
  const started = Date.now();
  const requestId = c.req.header('cf-ray') ?? crypto.randomUUID();
  assertEnv(c.env);

  const ip = c.req.header('cf-connecting-ip') ?? '0.0.0.0';
  const ipHash = (await sha256Hex(`${c.env.SESSION_SECRET}:${ip}`)).slice(0, 32);

  const log = createLogger(c.env.LOG_LEVEL, {
    request_id: requestId,
    site: c.env.SITE_SLUG,
    method: c.req.method,
    path: new URL(c.req.url).pathname,
  });

  c.set('requestId', requestId);
  c.set('log', log);
  c.set('db', getDb(c.env));
  c.set('caps', capabilities(c.env));
  c.set('ipHash', ipHash);
  c.set('ip', ip);

  c.header('x-request-id', requestId);

  await next();

  const ms = Date.now() - started;
  c.header('server-timing', `total;dur=${ms}`);
  log.info('request', { status: c.res.status, duration_ms: ms, country: c.req.header('cf-ipcountry') });
};
