import type { MiddlewareHandler } from 'hono';
import type { AppContext } from '../types';
import { tooMany } from '../lib/errors';

export interface LimitSpec {
  /** Requests permitted per window. */
  limit: number;
  windowSec: number;
  /** Distinguishes buckets, e.g. 'login' vs 'contact'. */
  bucket: string;
  /** Key by hashed IP (default), by authenticated user, or both. */
  by?: 'ip' | 'user' | 'ip+user';
  /** Weight of this request. Expensive endpoints can charge more than 1. */
  cost?: number;
}

/**
 * Fails open on limiter error. A DO outage should not take the site offline;
 * it is logged loudly instead so the gap is visible.
 */
export function rateLimit(spec: LimitSpec): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    const parts = [spec.bucket];
    const by = spec.by ?? 'ip';
    if (by !== 'user') parts.push(c.get('ipHash'));
    if (by !== 'ip') parts.push(c.get('user')?.id ?? 'anon');
    const key = parts.join(':');

    try {
      const id = c.env.RATE_LIMITER.idFromName(key);
      const stub = c.env.RATE_LIMITER.get(id);
      const res = await stub.fetch('https://limiter/check', {
        method: 'POST',
        body: JSON.stringify({ limit: spec.limit, windowSec: spec.windowSec, cost: spec.cost ?? 1 }),
      });
      const verdict = (await res.json()) as { allowed: boolean; remaining: number; retryAfter: number };

      c.header('x-ratelimit-limit', String(spec.limit));
      c.header('x-ratelimit-remaining', String(verdict.remaining));

      if (!verdict.allowed) {
        c.header('retry-after', String(verdict.retryAfter));
        c.get('log').warn('rate_limited', { bucket: spec.bucket, key_kind: by });
        throw tooMany('Too many requests. Try again shortly.', verdict.retryAfter);
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AppError') throw err;
      c.get('log').error('rate_limiter_unavailable', { bucket: spec.bucket, error: String(err) });
    }
    await next();
  };
}
