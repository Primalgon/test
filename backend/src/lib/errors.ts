/**
 * One error shape for the whole API. Clients can branch on `code`, humans read
 * `message`, and `request_id` is the join key into the logs.
 */
export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown; request_id?: string };
}

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly expose = true,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (m: string, d?: unknown) => new AppError(400, 'bad_request', m, d);
export const unauthorized = (m = 'Sign in to continue.') => new AppError(401, 'unauthorized', m);
export const forbidden = (m = 'You do not have access to this.') => new AppError(403, 'forbidden', m);
export const notFound = (m = 'Not found.') => new AppError(404, 'not_found', m);
export const conflict = (m: string) => new AppError(409, 'conflict', m);
export const unprocessable = (m: string, d?: unknown) => new AppError(422, 'unprocessable', m, d);
export const tooMany = (m = 'Too many requests. Try again shortly.', retryAfter?: number) =>
  new AppError(429, 'rate_limited', m, { retry_after: retryAfter });
export const notImplemented = (feature: string) =>
  new AppError(501, 'not_configured', `${feature} is not configured for this site.`);
export const upstream = (service: string, detail?: unknown) =>
  new AppError(502, 'upstream_failed', `${service} did not respond correctly.`, detail, false);
