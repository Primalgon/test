import type { Client } from '@libsql/client/web';
import type { Bindings } from '../env';
import { signPayload } from '../lib/crypto';
import { enqueueOutbox, dueOutbox, markOutboxSent, markOutboxFailed } from '../db/repo';
import { guardedFetch, DEFAULT_EGRESS } from '../lib/ssrf';
import type { Logger } from '../lib/logger';

/**
 * Outbound event delivery. One direction only.
 *
 * This used to be a two-way bridge with an inbound control surface. It is not
 * any more, and the reason is worth recording: the build pipeline generates the
 * site, and once the site is deployed the pipeline has no business reaching into
 * it at runtime. An always-open, HMAC-authenticated write endpoint on every
 * production site is an attack surface that exists purely for a convenience the
 * build already provides — anything the pipeline needs to change, it changes
 * before deploy, from a host that holds the database credentials directly.
 *
 * What remains is a site reporting *outward*: order paid, deployment healthy,
 * QA verdict. That is a real runtime function (the owner's dashboard depends on
 * it), it carries no authority into the site, and a compromise of the receiving
 * end cannot write anything back.
 *
 * Delivery is via an outbox: events are written to the database inside the
 * request, then flushed by cron. Firing a webhook inline would mean a slow
 * receiver turns into a failed checkout for the client's customer.
 */

export type SiteEvent =
  | 'site.deployed'
  | 'site.health_failed'
  | 'order.paid'
  | 'order.refunded'
  | 'order.disputed'
  | 'subscription.changed'
  | 'submission.received'
  | 'user.registered'
  | 'security.new_device'
  | 'security.mfa_disabled'
  | 'security.lockdown'
  | 'security.audit_anchor'
  | 'security.anomaly';

export interface EventEnvelope {
  event: SiteEvent;
  site_slug: string;
  environment: string;
  occurred_at: string;
  request_id?: string;
  data: Record<string, unknown>;
}

/**
 * Queue an event. Never throws into the request path — a reporting failure must
 * not fail the customer's action.
 */
export async function emit(
  db: Client, env: Bindings, event: SiteEvent, data: Record<string, unknown>, requestId?: string,
) {
  const envelope: EventEnvelope = {
    event,
    site_slug: env.SITE_SLUG,
    environment: env.ENVIRONMENT,
    occurred_at: new Date().toISOString(),
    request_id: requestId,
    data,
  };
  try {
    await enqueueOutbox(db, 'platform', event, envelope);
  } catch {
    // Swallowed deliberately. If the outbox insert fails the event is lost,
    // which is bad; failing the checkout that triggered it is worse.
  }
}

interface OutboxRow {
  id: string; destination: string; event_type: string; payload: string; attempts: number;
}

/**
 * Flush due events. Called by the scheduled handler.
 *
 * Signed with the platform secret and sent through the egress guard, so a
 * misconfigured or attacker-modified PLATFORM_INGEST_URL cannot be pointed at
 * an internal address to turn this into an SSRF primitive.
 */
export async function flushOutbox(db: Client, env: Bindings, log: Logger, limit = 25) {
  const rows = (await dueOutbox(db, limit)) as unknown as OutboxRow[];
  let sent = 0, failed = 0, skipped = 0;

  if (!env.PLATFORM_INGEST_URL || !env.PLATFORM_INGEST_SECRET) {
    if (rows.length) log.warn('outbox_no_destination', { pending: rows.length });
    return { total: rows.length, sent: 0, failed: 0, skipped: rows.length };
  }

  // The configured destination is added to the allowlist for this call only.
  // Everything else the guard blocks stays blocked.
  const policy = {
    ...DEFAULT_EGRESS,
    allowHosts: [...DEFAULT_EGRESS.allowHosts, new URL(env.PLATFORM_INGEST_URL).hostname],
  };

  for (const row of rows) {
    if (row.destination === 'mail') { skipped++; continue; } // handled by the mail flusher

    try {
      const { timestamp, signature } = await signPayload(env.PLATFORM_INGEST_SECRET, row.payload);
      const res = await guardedFetch(env.PLATFORM_INGEST_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forge-timestamp': timestamp,
          'x-forge-signature': signature,
          'x-forge-event': row.event_type,
          'x-forge-site': env.SITE_SLUG,
          // Lets the receiver deduplicate. Retries are guaranteed; duplicate
          // side effects on the receiving end are not acceptable.
          'x-forge-delivery': row.id,
        },
        body: row.payload,
      }, policy);

      if (res.ok) { await markOutboxSent(db, row.id); sent++; }
      else { await markOutboxFailed(db, row.id, row.attempts + 1, `http_${res.status}`); failed++; }
    } catch (err) {
      await markOutboxFailed(db, row.id, row.attempts + 1, String(err).slice(0, 300));
      failed++;
    }
  }

  if (rows.length) log.info('outbox_flushed', { total: rows.length, sent, failed, skipped });
  return { total: rows.length, sent, failed, skipped };
}
