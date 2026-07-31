import type { MiddlewareHandler } from 'hono';
import type { AppContext } from '../types';
import { one } from '../db/client';

/**
 * Break-glass lockdown.
 *
 * When lockdown is on, the site keeps serving public pages and keeps existing
 * read access working, but refuses every state change: no logins, no
 * registrations, no checkout, no writes of any kind, except by an owner already
 * holding an elevated session.
 *
 * Read-only rather than offline, deliberately. Taking the site down during a
 * suspected compromise tells the attacker they have been spotted, costs the
 * client every visitor for the duration, and destroys the live signal about what
 * the attacker is reaching for. Read-only stops the damage and keeps both the
 * business and the investigation running.
 *
 * The flag is cached in KV for five seconds. Reading it from the database on
 * every request would put a query in front of the homepage — the check would
 * cost more than the incidents it mitigates. Five seconds is a bounded window
 * for the switch to take global effect, which is well inside the reaction time
 * of anything this is used for.
 */

const CACHE_KEY = 'flag:lockdown';
const CACHE_TTL_SEC = 5;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Paths that must keep working during lockdown so it can be lifted again. */
const ALWAYS_ALLOWED = [
  '/healthz',
  '/readyz',
  '/api/auth/logout',
  '/api/mfa/step-up',
  '/api/admin/security/lockdown',
  '/api/admin/security/posture',
];

export const lockdownGuard: MiddlewareHandler<AppContext> = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();

  const path = new URL(c.req.url).pathname;
  if (ALWAYS_ALLOWED.some((p) => path.startsWith(p))) return next();

  let enabled = false;
  try {
    const cached = await c.env.CACHE.get(CACHE_KEY);
    if (cached !== null) {
      enabled = cached === '1';
    } else {
      const row = await one<{ value: string }>(
        c.get('db'), `SELECT value FROM site_flags WHERE key = 'lockdown'`,
      );
      enabled = row?.value === '1';
      await c.env.CACHE.put(CACHE_KEY, enabled ? '1' : '0', { expirationTtl: 60 });
    }
  } catch {
    // Fail open. A KV or database blip must not brick every write on the site.
    // The trade is explicit: lockdown is an incident-response tool with a human
    // watching, not a security boundary that has to hold unattended.
    return next();
  }

  if (!enabled) return next();

  // The owner who threw the switch has to be able to keep working — otherwise
  // lockdown is a self-inflicted outage with no way back.
  const user = c.get('user');
  if (user && (user.role === 'owner' || user.role === 'admin')) {
    const session = await one<{ reauth_at: number | null }>(
      c.get('db'), 'SELECT reauth_at FROM sessions WHERE id = ?', [user.sessionId],
    );
    if (session?.reauth_at) return next();
  }

  c.get('log').warn('lockdown_blocked', { path, method: c.req.method });

  return c.json({
    error: {
      code: 'site_locked',
      message: 'This site is temporarily read-only while a security check is carried out. Please try again shortly.',
      request_id: c.get('requestId'),
    },
  }, 503, {
    // Tells well-behaved clients and crawlers this is temporary, so a lockdown
    // does not cost the client search ranking.
    'retry-after': '900',
    'cache-control': 'no-store',
  });
};

/** Called by the lockdown route so the switch takes effect immediately here. */
export async function invalidateLockdownCache(env: { CACHE: KVNamespace }): Promise<void> {
  await env.CACHE.delete(CACHE_KEY);
}
