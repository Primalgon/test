/**
 * Tamper-evident audit log.
 *
 * An ordinary audit table answers "what happened" only if you trust whoever had
 * write access to it. That is precisely the party you are auditing. An attacker
 * who reaches the database deletes the rows describing how they got in, and the
 * table looks completely normal afterwards — there is no gap to notice, because
 * a plain table has nothing that says how many rows there should be.
 *
 * A hash chain fixes the detection half of that problem. Each entry commits to
 * the previous entry's hash, so removing or editing any row breaks every hash
 * after it. The attacker must then recompute the whole tail — which they can do,
 * unless the chain head has been published somewhere they do not control.
 *
 * So: this makes tampering **detectable**, not impossible. It is worth the small
 * cost anyway, because it converts silent deletion into a loud, obvious failure,
 * and because periodically shipping the head elsewhere then makes tampering
 * genuinely hard for very little extra work.
 *
 * External anchoring is where the real strength comes from — see `anchorHead()`.
 */

import type { Client } from '@libsql/client/web';
import { sha256Hex } from './crypto';
import { all, one, run, nowSec, newId } from '../db/client';

const GENESIS = '0'.repeat(64);

export interface AuditEntry {
  actorType: 'user' | 'system' | 'admin' | 'build' | 'stripe';
  actorId?: string | null;
  action: string;
  entity?: string | null;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ipHash?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

/**
 * Canonical serialisation. Object key order must not affect the hash, or a
 * verifier that reserialises differently reports false tampering. Sorted keys,
 * recursively.
 */
function canonical(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

async function entryHash(input: {
  prevHash: string; seq: number; createdAt: number; entry: AuditEntry;
}): Promise<string> {
  return sha256Hex([
    input.prevHash,
    input.seq,
    input.createdAt,
    input.entry.actorType,
    input.entry.actorId ?? '',
    input.entry.action,
    input.entry.entity ?? '',
    input.entry.entityId ?? '',
    canonical(input.entry.before),
    canonical(input.entry.after),
  ].join('|'));
}

/**
 * Append one entry.
 *
 * The conditional INSERT ... WHERE is the concurrency control. libSQL over HTTP
 * has no interactive transactions, so two simultaneous appends could otherwise
 * read the same head and both claim the same sequence number, forking the chain.
 * The insert only succeeds if the head is still what we read; on a miss we
 * re-read and retry.
 */
export async function appendAudit(db: Client, entry: AuditEntry): Promise<{ seq: number; hash: string }> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const head = await one<{ seq: number; entry_hash: string }>(
      db, 'SELECT seq, entry_hash FROM audit_log ORDER BY seq DESC LIMIT 1',
    );
    const prevHash = head?.entry_hash ?? GENESIS;
    const seq = (head?.seq ?? 0) + 1;
    const createdAt = nowSec();
    const hash = await entryHash({ prevHash, seq, createdAt, entry });

    const res = await run(db,
      `INSERT INTO audit_log
         (id, seq, prev_hash, entry_hash, actor_type, actor_id, action, entity, entity_id,
          before_json, after_json, ip_hash, user_agent, request_id, created_at)
       SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
       WHERE NOT EXISTS (SELECT 1 FROM audit_log WHERE seq = ?)`,
      [
        newId('aud'), seq, prevHash, hash,
        entry.actorType, entry.actorId ?? null, entry.action,
        entry.entity ?? null, entry.entityId ?? null,
        entry.before === undefined ? null : JSON.stringify(entry.before),
        entry.after === undefined ? null : JSON.stringify(entry.after),
        entry.ipHash ?? null, (entry.userAgent ?? '').slice(0, 300) || null,
        entry.requestId ?? null, createdAt,
        seq,
      ],
    );

    if (res.rowsAffected > 0) return { seq, hash };
  }
  // Never swallow this. An audit entry that fails to write is a security event
  // in its own right, and the caller must decide whether to fail the operation.
  throw new Error('audit_append_contention: could not append after 4 attempts');
}

/**
 * Walk the chain and report the first break.
 *
 * Run it from the admin dashboard and from a scheduled job. An unverified chain
 * provides exactly as much assurance as no chain.
 */
export async function verifyChain(
  db: Client, opts: { fromSeq?: number; limit?: number } = {},
): Promise<{ ok: boolean; checked: number; brokenAt?: number; detail?: string }> {
  const fromSeq = opts.fromSeq ?? 0;
  const limit = opts.limit ?? 5000;

  const rows = await all<{
    seq: number; prev_hash: string; entry_hash: string; created_at: number;
    actor_type: string; actor_id: string | null; action: string;
    entity: string | null; entity_id: string | null;
    before_json: string | null; after_json: string | null;
  }>(db,
    `SELECT seq, prev_hash, entry_hash, created_at, actor_type, actor_id, action,
            entity, entity_id, before_json, after_json
     FROM audit_log WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
    [fromSeq, limit],
  );

  let expectedPrev: string | null = null;
  let checked = 0;

  for (const row of rows) {
    if (expectedPrev !== null && row.prev_hash !== expectedPrev) {
      return { ok: false, checked, brokenAt: row.seq, detail: 'prev_hash does not match the preceding entry — a row was removed or reordered' };
    }
    const recomputed = await entryHash({
      prevHash: row.prev_hash,
      seq: row.seq,
      createdAt: row.created_at,
      entry: {
        actorType: row.actor_type as AuditEntry['actorType'],
        actorId: row.actor_id,
        action: row.action,
        entity: row.entity,
        entityId: row.entity_id,
        before: row.before_json ? JSON.parse(row.before_json) : undefined,
        after: row.after_json ? JSON.parse(row.after_json) : undefined,
      },
    });
    if (recomputed !== row.entry_hash) {
      return { ok: false, checked, brokenAt: row.seq, detail: 'entry contents do not match its hash — the row was edited in place' };
    }
    expectedPrev = row.entry_hash;
    checked++;
  }

  // Gaps in the sequence are their own signal: the chain can be internally
  // consistent while rows are missing from the end.
  if (rows.length) {
    const expectedSpan = rows[rows.length - 1]!.seq - rows[0]!.seq + 1;
    if (expectedSpan !== rows.length) {
      return { ok: false, checked, detail: 'sequence numbers are not contiguous — entries were deleted' };
    }
  }

  return { ok: true, checked };
}

/**
 * Current chain head, for external anchoring.
 *
 * This is what turns detection into prevention. Ship the head somewhere the site
 * cannot write — your platform database, an email to the owner, an object-lock
 * bucket, a log sink with append-only retention. Once yesterday's head is
 * recorded outside the site, an attacker inside the site can no longer rewrite
 * history without contradicting a copy they cannot reach.
 *
 * The daily cron calls this. If you do nothing with the result, the chain is a
 * speed bump.
 */
export async function currentHead(db: Client): Promise<{ seq: number; hash: string; at: number }> {
  const head = await one<{ seq: number; entry_hash: string; created_at: number }>(
    db, 'SELECT seq, entry_hash, created_at FROM audit_log ORDER BY seq DESC LIMIT 1',
  );
  return { seq: head?.seq ?? 0, hash: head?.entry_hash ?? GENESIS, at: head?.created_at ?? nowSec() };
}

export { GENESIS, canonical };
