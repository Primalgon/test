type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Keys whose values never reach the log sink, at any depth. */
const REDACT = new Set([
  'password', 'password_hash', 'token', 'authorization', 'cookie', 'set-cookie',
  'secret', 'api_key', 'apikey', 'client_secret', 'refresh_token', 'access_token',
  'card', 'cvc', 'ssn', 'session', 'stripe-signature', 'x-n8n-signature',
]);

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT.has(k.toLowerCase()) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export class Logger {
  constructor(
    private readonly min: Level,
    private readonly base: Record<string, unknown> = {},
  ) {}

  child(extra: Record<string, unknown>) {
    return new Logger(this.min, { ...this.base, ...extra });
  }

  private emit(level: Level, msg: string, extra?: Record<string, unknown>) {
    if (ORDER[level] < ORDER[this.min]) return;
    const line = JSON.stringify({
      level,
      msg,
      ts: new Date().toISOString(),
      ...this.base,
      ...(extra ? (redact(extra) as Record<string, unknown>) : {}),
    });
    // Workers ships console output to Logpush / Tail. Structured JSON keeps it queryable.
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }

  debug = (m: string, e?: Record<string, unknown>) => this.emit('debug', m, e);
  info  = (m: string, e?: Record<string, unknown>) => this.emit('info', m, e);
  warn  = (m: string, e?: Record<string, unknown>) => this.emit('warn', m, e);
  error = (m: string, e?: Record<string, unknown>) => this.emit('error', m, e);
}

export const createLogger = (level: string, base: Record<string, unknown> = {}) =>
  new Logger((['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info') as Level, base);
