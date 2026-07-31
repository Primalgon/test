/**
 * Typed API client for the Worker backend.
 *
 * Handles the two things that bite every hand-rolled fetch wrapper: CSRF token
 * plumbing on writes, and turning the backend's structured error envelope into
 * something a form can actually render next to the right field.
 */
export interface ApiError {
  code: string;
  message: string;
  details?: Array<{ field: string; message: string }>;
  requestId?: string;
  status: number;
}

export class ApiRequestError extends Error implements ApiError {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Array<{ field: string; message: string }>,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }

  /** Field-keyed messages, ready to drop into form state. */
  get fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const d of this.details ?? []) out[d.field] = d.message;
    return out;
  }
}

const readCookie = (name: string) =>
  document.cookie.split('; ').find((c) => c.startsWith(`${name}=`))?.split('=')[1];

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  timeoutMs?: number;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, timeoutMs = 15_000, headers, ...rest } = options;
  const method = (rest.method ?? (body ? 'POST' : 'GET')).toUpperCase();

  const finalHeaders: Record<string, string> = {
    accept: 'application/json',
    ...(body ? { 'content-type': 'application/json' } : {}),
    ...(headers as Record<string, string>),
  };

  // The backend expects the raw CSRF value; it hashes and compares server-side.
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const csrf = readCookie('__Host-csrf');
    if (csrf) finalHeaders['x-csrf-token'] = decodeURIComponent(csrf);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(path, {
      ...rest,
      method,
      headers: finalHeaders,
      // Required for the __Host- session cookie to travel.
      credentials: 'include',
      signal: rest.signal ?? controller.signal,
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    const json = text ? safeParse(text) : null;

    if (!res.ok) {
      const err = (json as { error?: Record<string, unknown> })?.error;
      throw new ApiRequestError(
        res.status,
        String(err?.code ?? 'request_failed'),
        String(err?.message ?? 'Something went wrong. Try again.'),
        err?.details as Array<{ field: string; message: string }> | undefined,
        String(err?.request_id ?? res.headers.get('x-request-id') ?? ''),
      );
    }
    return json as T;
  } catch (e) {
    if (e instanceof ApiRequestError) throw e;
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new ApiRequestError(0, 'timeout', 'That took too long. Check your connection and try again.');
    }
    throw new ApiRequestError(0, 'network', 'Could not reach the server. Check your connection.');
  } finally {
    clearTimeout(timer);
  }
}

const safeParse = (t: string) => { try { return JSON.parse(t); } catch { return null; } };

/* ------------------------------- endpoints ------------------------------- */

export interface SiteConfig {
  site: { name: string; slug: string; origin: string };
  features: { payments: boolean; contact_form: boolean; accounts: boolean; turnstile: boolean };
  stripe_publishable_key: string | null;
}

export const api = {
  config: () => request<SiteConfig>('/api/config'),

  content: (page: string, locale = 'en-US') =>
    request<{ page: string; blocks: Record<string, string> }>(`/api/content/${page}?locale=${locale}`),

  contact: (input: {
    name: string; email: string; message: string;
    phone?: string; subject?: string; turnstile_token?: string;
  }) => request<{ ok: true; message: string }>('/api/contact', { body: input }),

  products: () => request<{ products: Array<{
    id: string; sku: string; name: string; description: string | null;
    amount_cents: number; currency: string; recurring: string;
  }> }>('/api/products'),

  checkout: (items: Array<{ sku: string; quantity: number }>, email?: string) =>
    request<{ ok: true; checkout_url: string; session_id: string }>('/api/checkout', {
      body: { items, email },
    }),

  /** Stripe customer billing portal — where a member changes or cancels the
   *  subscription. Requires an authenticated session; 404s until the user has
   *  a Stripe customer record. */
  billingPortal: () =>
    request<{ ok: true; url: string }>('/api/billing-portal', { method: 'POST' }),

  auth: {
    me: () => request<{ authenticated: boolean; user?: { id: string; email: string; name: string | null; role: string; email_verified: boolean } }>('/api/auth/me'),
    login: (email: string, password: string) =>
      request<{ ok: true; csrf_token: string; user: unknown }>('/api/auth/login', { body: { email, password } }),
    register: (input: { email: string; password: string; name?: string; turnstile_token?: string }) =>
      request<{ ok: true; message: string }>('/api/auth/register', { body: input }),
    logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
    forgotPassword: (email: string) =>
      request<{ ok: true; message: string }>('/api/auth/forgot-password', { body: { email } }),
  },

  assets: () => request<{ assets: Array<{ asset_key: string; status: string; url: string | null }> }>('/api/assets'),
};
