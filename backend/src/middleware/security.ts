import type { MiddlewareHandler } from 'hono';
import type { AppContext } from '../types';
import { toBase64Url, randomBytes } from '../lib/crypto';

/**
 * Security headers. The CSP is nonce-based rather than 'unsafe-inline':
 * the frontend template is built to consume the nonce, so there is no reason
 * to weaken it. If you add a third-party script, add its origin here rather
 * than dropping the directive.
 *
 * Note the WebGL-specific allowances: blob: in worker-src and script-src is
 * required by the Draco/KTX2 decoders, which instantiate workers from blobs.
 * Removing them silently breaks 3D on the generated site.
 */
export const securityHeaders: MiddlewareHandler<AppContext> = async (c, next) => {
  const nonce = toBase64Url(randomBytes(16));
  c.set('cspNonce', nonce);

  await next();

  const isProd = c.env.ENVIRONMENT === 'production';
  const connectSrc = [
    "'self'",
    'https://api.stripe.com',
    'https://*.turso.io',
    'https://cloudflareinsights.com',
    c.env.PUBLIC_ORIGIN,
  ].join(' ');

  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' blob: https://js.stripe.com https://challenges.cloudflare.com https://static.cloudflareinsights.com`,
    "style-src 'self' 'unsafe-inline'", // CSS-in-JS and Tailwind's injected layer need this; scripts do not.
    "img-src 'self' data: blob: https:",
    // 'self' only. Fonts are self-hosted from /fonts — see frontend/index.html.
    // Allowing a third-party font origin here would also permit exfiltration
    // through a crafted font request, which is a real technique.
    "font-src 'self' data:",
    `connect-src ${connectSrc}`,
    "worker-src 'self' blob:",
    "media-src 'self' https: blob:",
    "frame-src https://js.stripe.com https://hooks.stripe.com https://challenges.cloudflare.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    // Trusted Types eliminates DOM-based XSS as a class rather than case by
    // case: assigning a raw string to innerHTML, or to a script src, throws
    // instead of executing. Chromium-only today, and the single most effective
    // thing available against the injection paths a CSP nonce does not cover.
    "require-trusted-types-for 'script'",
    "trusted-types default dompurify",
    // Reports go somewhere. A CSP with no reporting endpoint is a policy nobody
    // can tell is misconfigured until a user files a support ticket.
    `report-uri ${c.env.PUBLIC_ORIGIN}/api/security/csp-report`,
    'report-to csp-endpoint',
    isProd ? 'upgrade-insecure-requests' : '',
  ].filter(Boolean).join('; ');

  c.header('content-security-policy', csp);
  c.header('reporting-endpoints',
    `csp-endpoint="${c.env.PUBLIC_ORIGIN}/api/security/csp-report"`);
  c.header('x-content-type-options', 'nosniff');
  c.header('referrer-policy', 'strict-origin-when-cross-origin');
  c.header('x-frame-options', 'DENY');
  c.header('cross-origin-opener-policy', 'same-origin');
  c.header('cross-origin-resource-policy', 'same-site');
  // COEP completes cross-origin isolation, which is what actually mitigates
  // Spectre-class cross-origin reads. `credentialless` rather than
  // `require-corp` because require-corp breaks every third-party asset that
  // does not send CORP headers — including, in practice, most CDN-hosted GLB
  // and HDRI files, which would take the 3D out on every generated site.
  c.header('cross-origin-embedder-policy', 'credentialless');
  c.header('permissions-policy',
    'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(self "https://js.stripe.com"), usb=(), interest-cohort=()');
  if (isProd) c.header('strict-transport-security', 'max-age=63072000; includeSubDomains; preload');

  // Never let a browser, proxy, or CDN cache an authenticated response. The
  // classic failure is a shared-computer or corporate-proxy scenario where the
  // next person's request is served the previous user's account page.
  if (c.get('user')) {
    c.header('cache-control', 'no-store, no-cache, must-revalidate, private');
    c.header('pragma', 'no-cache');
    c.header('vary', 'cookie, origin');
  }

  // Server fingerprinting is free reconnaissance. Nothing here needs to
  // advertise its stack.
  c.header('x-powered-by', '');
  c.header('server', '');
  c.header('x-dns-prefetch-control', 'off');
  c.header('origin-agent-cluster', '?1');
};

/**
 * Strict CORS. Only the site's own origins are allowed; a generated site has
 * no reason to be callable from anywhere else. Reflecting the Origin header
 * unconditionally (what most templates do) is equivalent to no CORS at all.
 */
export const cors: MiddlewareHandler<AppContext> = async (c, next) => {
  const origin = c.req.header('origin');
  const allowed = [c.env.PUBLIC_ORIGIN, c.env.ADMIN_ORIGIN].filter(Boolean);
  if (c.env.ENVIRONMENT !== 'production') {
    allowed.push('http://localhost:5173', 'http://localhost:4173', 'http://127.0.0.1:5173');
  }

  if (origin && allowed.includes(origin)) {
    c.header('access-control-allow-origin', origin);
    c.header('access-control-allow-credentials', 'true');
    c.header('vary', 'origin');
  }

  if (c.req.method === 'OPTIONS') {
    c.header('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    c.header('access-control-allow-headers', 'content-type,authorization,x-csrf-token,idempotency-key');
    c.header('access-control-max-age', '86400');
    return c.body(null, 204);
  }
  await next();
};
