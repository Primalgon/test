import type { ErrorHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';
import type { AppContext } from '../types';
import { AppError, type ApiErrorBody } from '../lib/errors';
import { ConfigError } from '../env';

/**
 * Single exit point for every failure. Two rules: clients never see an
 * internal stack, and every response carries the request id so a user can
 * quote it in a support message and you can find the exact log line.
 */
export const onError: ErrorHandler<AppContext> = (err, c) => {
  const requestId = c.get('requestId') ?? 'unknown';
  const log = c.get('log');

  if (err instanceof ZodError) {
    const details = err.issues.map((i) => ({ field: i.path.join('.') || '(root)', message: i.message }));
    log?.info('validation_failed', { details });
    return c.json<ApiErrorBody>(
      { error: { code: 'validation_failed', message: 'Some fields need attention.', details, request_id: requestId } },
      400,
    );
  }

  if (err instanceof AppError) {
    log?.[err.status >= 500 ? 'error' : 'info']('app_error', {
      code: err.code, status: err.status, message: err.message, details: err.details,
    });
    return c.json<ApiErrorBody>(
      {
        error: {
          code: err.code,
          message: err.expose ? err.message : 'Something went wrong on our side.',
          ...(err.expose && err.details ? { details: err.details } : {}),
          request_id: requestId,
        },
      },
      err.status as 400,
    );
  }

  if (err instanceof ConfigError) {
    log?.error('config_error', { message: err.message });
    return c.json<ApiErrorBody>(
      { error: { code: 'misconfigured', message: 'This site is not fully configured yet.', request_id: requestId } },
      500,
    );
  }

  if (err instanceof HTTPException) {
    return c.json<ApiErrorBody>(
      { error: { code: 'http_error', message: err.message, request_id: requestId } },
      err.status,
    );
  }

  log?.error('unhandled_exception', {
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack?.slice(0, 2000) : undefined,
  });
  return c.json<ApiErrorBody>(
    { error: { code: 'internal_error', message: 'Something went wrong on our side.', request_id: requestId } },
    500,
  );
};

export const onNotFound: NotFoundHandler<AppContext> = (c) =>
  c.json<ApiErrorBody>(
    { error: { code: 'not_found', message: 'No route matches that path.', request_id: c.get('requestId') } },
    404,
  );
