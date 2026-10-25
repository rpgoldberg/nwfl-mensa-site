// ============================================================================
// One audit row per workflow step (R25, P18), written in the same transaction
// as the step. audit_event is append-only; the database numbers and times each
// row (0007). The row names the actor by subject and carries the actor's nwfl-
// groups as they were, the trace id of the call, and the subject. Bodies never
// go here (R15), and the payload CHECK refuses membership inputs.
// ============================================================================
import { trace } from '@opentelemetry/api';
import type { Caller } from '../auth/caller.js';
import type { TxClient } from '../db/tx.js';

export interface AuditRecord {
  action: string;
  subjectKind: string;
  subjectId: string;
  itemId?: string | null;
  versionId?: string | null;
  contentHash?: Buffer | null;
  fromState?: string | null;
  toState?: string | null;
  note?: string | null;
  payload?: Record<string, unknown>;
  actingOfficeId?: string | null;
}

const ACTOR_KIND = { user: 'user', agent: 'agent', verifier: 'verifier', anonymous: 'system' } as const;

/** The active span's trace id for an audit row, or null. Also passed to the redaction functions (0013). */
export function traceId(): string | null {
  const context = trace.getActiveSpan()?.spanContext();
  return context !== undefined && /^[0-9a-f]{32}$/.test(context.traceId) && !/^0+$/.test(context.traceId) ? context.traceId : null;
}

export async function recordAudit(client: TxClient, caller: Caller, record: AuditRecord): Promise<void> {
  await client.query(
    `INSERT INTO audit_event (trace_id, actor_kind, actor_sub, acting_office_id, actor_groups, action, subject_kind, subject_id,
       item_id, version_id, content_hash, from_state, to_state, note, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      traceId(),
      ACTOR_KIND[caller.kind],
      caller.subject,
      record.actingOfficeId ?? null,
      [...caller.groups],
      record.action,
      record.subjectKind,
      record.subjectId,
      record.itemId ?? null,
      record.versionId ?? null,
      record.contentHash ?? null,
      record.fromState ?? null,
      record.toState ?? null,
      record.note ?? null,
      JSON.stringify(record.payload ?? {}),
    ],
  );
}
