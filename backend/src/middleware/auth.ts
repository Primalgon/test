import type { MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { AppContext, SessionUser } from '../types';
import { forbidden, unauthorized } from '../lib/errors';
import { randomBytes, sha256Hex, timingSafeEqual, toBase64Url, textEncoder } from '../lib/crypto';
import {
  findSessionByTokenHash, findUserById, insertSession, revokeSession, touchSession,
} from '../db/repo';
import { nowSec } from '../db/client';

const SESSION_COOKIE = '__Host-sid';
const CSRF_COOKIE = '__Host-csrf';
const IDLE_TTL_SEC = 60 * 60 * 12;        // sliding: 12h of inactivity ends it
const ABSOLUTE_TTL_SEC = 60 * 60 * 24 * 14; // hard ceiling: 14 days regardless of activity

/**
 * `__Host-` prefixed cookies cannot be set by a subdomain or over http and are
 * always path=/. That closes off subdomain-injection attacks on the session,
 * which matters here because every generated site has an admin subdomain.
 */
const cookieOpts = (maxAge: number) => ({
  path: '/', httpOnly: true, secure: true, sameSite: 'Lax' as const, maxAge,
});

export async function issueSession(
  c: Parameters<MiddlewareHandler<AppContext>>[0],
  userId: string,
) {
  const token = toBase64Url(randomBytes(32));
  const csrf = toBase64Url(randomBytes(32));
  const tokenHash = await sha256Hex(token);
  const csrfHash = await sha256Hex(csrf);

  await insertSession(c.get('db'), {
    userId, tokenHash, csrfHash,
    ipHash: c.get('ipHash'),
    userAgent: (c.req.header('user-agent') ?? '').slice(0, 300),
    ttlSec: IDLE_TTL_SEC, absoluteTtlSec: ABSOLUTE_TTL_SEC,
  });

  setCookie(c, SESSION_COOKIE, token, cookieOpts(IDLE_TTL_SEC));
  // Readable by JS on purpose: this is the double-submit half of CSRF defence.
  setCookie(c, CSRF_COOKIE, csrf, { ...cookieOpts(IDLE_TTL_SEC), httpOnly: false });
  return { token, csrf };
}

export async function destroySession(c: Parameters<MiddlewareHandler<AppContext>>[0]) {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const session = await findSessionByTokenHash(c.get('db'), await sha256Hex(token));
    if (session) await revokeSession(c.get('db'), session.id);
  }
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  deleteCookie(c, CSRF_COOKIE, { path: '/' });
}

/** Attaches the user when a valid session exists. Never rejects. */
export const loadSession: MiddlewareHandler<AppContext> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return next();

  const db = c.get('db');
  const session = await findSessionByTokenHash(db, await sha256Hex(token));
  if (!session) return next();

  const now = nowSec();
  if (session.expires_at <= now || session.absolute_expires_at <= now) {
    await revokeSession(db, session.id);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return next();
  }

  const user = await findUserById(db, session.user_id);
  if (!user || user.status !== 'active') return next();

  // Sliding renewal, but never past the absolute ceiling.
  if (now - session.last_seen_at > 300) {
    await touchSession(db, session.id, now + IDLE_TTL_SEC);
    setCookie(c, SESSION_COOKIE, token, cookieOpts(IDLE_TTL_SEC));
  }

  const sessionUser: SessionUser = {
    id: user.id, email: user.email, name: user.name, role: user.role,
    emailVerified: !!user.email_verified, sessionId: session.id, csrfHash: session.csrf_hash,
  };
  c.set('user', sessionUser);
  c.set('log', c.get('log').child({ user_id: user.id }));
  await next();
};

export const requireAuth: MiddlewareHandler<AppContext> = async (c, next) => {
  if (!c.get('user')) throw unauthorized();
  await next();
};

export const requireVerifiedEmail: MiddlewareHandler<AppContext> = async (c, next) => {
  const user = c.get('user');
  if (!user) throw unauthorized();
  if (!user.emailVerified) throw forbidden('Confirm your email address to continue.');
  await next();
};

const RANK: Record<string, number> = { customer: 0, staff: 1, admin: 2, owner: 3 };

export function requireRole(min: 'staff' | 'admin' | 'owner'): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    const user = c.get('user');
    if (!user) throw unauthorized();
    if ((RANK[user.role] ?? -1) < (RANK[min] ?? 99)) throw forbidden('This area is restricted.');
    await next();
  };
}

/**
 * Double-submit CSRF plus a strict Origin check. SameSite=Lax alone leaves
 * top-level POST navigations exposed, and Origin alone breaks on some
 * privacy tooling — so both, and either failing rejects.
 */
export const csrfProtect: MiddlewareHandler<AppContext> = async (c, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return next();

  const origin = c.req.header('origin') ?? c.req.header('referer');
  if (origin) {
    const allowed = [c.env.PUBLIC_ORIGIN, c.env.ADMIN_ORIGIN].filter(Boolean);
    const ok = allowed.some((a) => origin.startsWith(a)) ||
      (c.env.ENVIRONMENT !== 'production' && origin.startsWith('http://localhost'));
    if (!ok) throw forbidden('Request origin not allowed.');
  }

  const user = c.get('user');
  if (!user) return next(); // unauthenticated POSTs are guarded by rate limit + Turnstile

  const header = c.req.header('x-csrf-token');
  if (!header) throw forbidden('Missing CSRF token.');
  const provided = textEncoder.encode(await sha256Hex(header));
  const expected = textEncoder.encode(user.csrfHash);
  if (!timingSafeEqual(provided, expected)) throw forbidden('Invalid CSRF token.');

  await next();
};

export { SESSION_COOKIE, CSRF_COOKIE, IDLE_TTL_SEC, ABSOLUTE_TTL_SEC };
