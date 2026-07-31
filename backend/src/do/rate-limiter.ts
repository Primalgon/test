/**
 * Durable Object sliding-window rate limiter.
 *
 * Why a DO and not KV: KV is eventually consistent across colos, so a limit
 * enforced there can be exceeded by a factor of the number of edge locations
 * an attacker can reach. A DO is a single-threaded actor pinned to one
 * instance per key, so the count is authoritative.
 *
 * The window is a two-bucket approximation: the current fixed window plus a
 * weighted share of the previous one. It is within a few percent of a true
 * sliding log at a fraction of the storage cost.
 */
export class RateLimiter implements DurableObject {
  constructor(private state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const { limit, windowSec, cost } = (await request.json()) as {
      limit: number; windowSec: number; cost?: number;
    };
    const weight = cost ?? 1;
    const now = Date.now();
    const windowMs = windowSec * 1000;
    const currentStart = Math.floor(now / windowMs) * windowMs;

    const stored = (await this.state.storage.get<{
      currentStart: number; current: number; previous: number;
    }>('w')) ?? { currentStart, current: 0, previous: 0 };

    let { current, previous } = stored;
    if (stored.currentStart !== currentStart) {
      previous = stored.currentStart === currentStart - windowMs ? stored.current : 0;
      current = 0;
    }

    const elapsed = (now - currentStart) / windowMs;
    const estimate = previous * (1 - elapsed) + current;

    if (estimate + weight > limit) {
      const retryAfter = Math.ceil((currentStart + windowMs - now) / 1000);
      return Response.json(
        { allowed: false, remaining: 0, retryAfter },
        { status: 200, headers: { 'cache-control': 'no-store' } },
      );
    }

    current += weight;
    await this.state.storage.put('w', { currentStart, current, previous });
    // Self-clean so idle keys do not accumulate storage cost forever.
    await this.state.storage.setAlarm(now + windowMs * 2);

    return Response.json({
      allowed: true,
      remaining: Math.max(0, Math.floor(limit - estimate - weight)),
      retryAfter: 0,
    });
  }

  async alarm() {
    await this.state.storage.deleteAll();
  }
}
