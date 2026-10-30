// ============================================================================
// Redaction marks (REDACT R2a), part of RedactionPolicyService.
//
//   AddRedactionMark    an officer, or a person who wrote a version of the
//                       content item, marks a passage (its exact text, in one
//                       field) or the whole item; it applies at once
//   ListRedactionMarks  officers: one item's or event's marks, and any
//                       removal waiting
//   ProposeMarkRemoval  an officer proposes lifting a mark
//   ApproveMarkRemoval  a different officer approves; only then is it lifted
//
// Every write goes through 0014's SECURITY DEFINER functions, the app role's
// only way to write marks; they hold four-eyes and write the audit rows. The
// checks here only give a clear refusal first.
// ============================================================================
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from '@connectrpc/connect';
import { traceId } from '../audit/audit.js';
import { type Caller, callerOf } from '../auth/caller.js';
import { requireOfficer, requireUser } from '../auth/roles.js';
import { dbError } from '../db/errors.js';
import type { Db } from '../db/pool.js';
import { type TxClient, inTransaction } from '../db/tx.js';
import { recordItems } from '../ledger/ledger.js';
import {
  type MarkRemoval,
  MarkField,
  MarkRemovalSchema,
  MarkStatus,
  MarkSubjectKind,
  type RedactionMark,
  RedactionCategory,
  RedactionMarkSchema,
  type RedactionPolicyService,
} from '../gen/nwfl/mensa/v1/redaction_pb.js';
import { TENANT } from './policy.js';
import type { SubjectKind } from './render.js';

const KIND_OUT: Record<SubjectKind, MarkSubjectKind> = {
  content_item: MarkSubjectKind.CONTENT_ITEM,
  event_series: MarkSubjectKind.EVENT_SERIES,
  event_occurrence: MarkSubjectKind.EVENT_OCCURRENCE,
};
const COLUMN: Record<SubjectKind, string> = { content_item: 'content_item_id', event_series: 'series_id', event_occurrence: 'occurrence_id' };

type Field = 'title' | 'summary' | 'body' | 'on_behalf_of' | 'description' | 'cadence_label' | 'detail' | 'status_note' | 'url' | 'file';
const FIELD_OUT: Record<Field, MarkField> = {
  title: MarkField.TITLE,
  summary: MarkField.SUMMARY,
  body: MarkField.BODY,
  on_behalf_of: MarkField.ON_BEHALF_OF,
  description: MarkField.DESCRIPTION,
  cadence_label: MarkField.CADENCE_LABEL,
  detail: MarkField.DETAIL,
  status_note: MarkField.STATUS_NOTE,
  url: MarkField.URL,
  file: MarkField.FILE,
};
/** The text fields each kind of subject has: 0014's redaction_mark_field_of_subject (a content item's file marks, 0020, are added by the issue loader only). */
const FIELDS: Record<SubjectKind, readonly Field[]> = {
  content_item: ['title', 'summary', 'body', 'on_behalf_of'],
  event_series: ['title', 'description', 'cadence_label'],
  event_occurrence: ['title', 'detail', 'status_note', 'url'],
};

type TextCategory = 'member_name' | 'member_address' | 'member_phone' | 'member_email' | 'private_venue' | 'business_venue' | 'officer_contact';
const CATEGORY_OUT: Record<TextCategory, RedactionCategory> = {
  member_name: RedactionCategory.MEMBER_NAME,
  member_address: RedactionCategory.MEMBER_ADDRESS,
  member_phone: RedactionCategory.MEMBER_PHONE,
  member_email: RedactionCategory.MEMBER_EMAIL,
  private_venue: RedactionCategory.PRIVATE_VENUE,
  business_venue: RedactionCategory.BUSINESS_VENUE,
  officer_contact: RedactionCategory.OFFICER_CONTACT,
};

/** The stored name for a wire value, or undefined for UNSPECIFIED and unknown numbers. */
function nameOf<K extends string, V>(table: Record<K, V>, value: V): K | undefined {
  return (Object.keys(table) as K[]).find((key) => table[key] === value);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const invalid = (message: string): ConnectError => new ConnectError(message, Code.InvalidArgument);
const precondition = (message: string): ConnectError => new ConnectError(message, Code.FailedPrecondition);
const denied = (message: string): ConnectError => new ConnectError(message, Code.PermissionDenied);

interface MarkRow {
  id: string;
  content_item_id: string | null;
  series_id: string | null;
  occurrence_id: string | null;
  field: Field | null;
  quote: string | null;
  category: TextCategory;
  status: 'active' | 'removed';
  created_by_sub: string;
  created_at: Date;
  pending_removal_id?: string | null;
  removal_proposed_by?: string | null;
}

interface RemovalRow {
  id: string;
  mark_id: string;
  status: 'pending' | 'applied';
  proposed_by_sub: string;
  proposed_at: Date;
  approved_by_sub: string | null;
  approved_at: Date | null;
}

const MARK_COLUMNS = 'id, content_item_id, series_id, occurrence_id, field, quote, category, status, created_by_sub, created_at';
const REMOVAL_COLUMNS = 'id, mark_id, status, proposed_by_sub, proposed_at, approved_by_sub, approved_at';

function markMessage(row: MarkRow): RedactionMark {
  const [kind, subject] =
    row.content_item_id !== null
      ? (['content_item', row.content_item_id] as const)
      : row.series_id !== null
        ? (['event_series', row.series_id] as const)
        : (['event_occurrence', row.occurrence_id as string] as const);
  return create(RedactionMarkSchema, {
    markId: row.id,
    subjectKind: KIND_OUT[kind],
    subjectId: subject,
    field: row.field === null ? MarkField.UNSPECIFIED : FIELD_OUT[row.field],
    quote: row.quote ?? '',
    category: CATEGORY_OUT[row.category],
    status: row.status === 'active' ? MarkStatus.ACTIVE : MarkStatus.REMOVED,
    createdBy: row.created_by_sub,
    createdAt: timestampFromDate(row.created_at),
    pendingRemovalId: row.pending_removal_id ?? '',
    removalProposedBy: row.removal_proposed_by ?? '',
  });
}

function removalMessage(row: RemovalRow): MarkRemoval {
  return create(MarkRemovalSchema, {
    removalId: row.id,
    markId: row.mark_id,
    applied: row.status === 'applied',
    proposedBy: row.proposed_by_sub,
    proposedAt: timestampFromDate(row.proposed_at),
    approvedBy: row.approved_by_sub ?? '',
    ...(row.approved_at !== null ? { approvedAt: timestampFromDate(row.approved_at) } : {}),
  });
}

function subjectOf(request: { subjectKind: MarkSubjectKind; subjectId: string }): [SubjectKind, string] {
  const kind = nameOf(KIND_OUT, request.subjectKind);
  if (kind === undefined) throw invalid('choose what the mark is on');
  const id = request.subjectId.trim().toLowerCase();
  if (!UUID.test(id)) throw invalid('a subject id is a UUID');
  return [kind, id];
}

const idOf = (value: string, what: string): string => {
  const id = value.trim().toLowerCase();
  if (!UUID.test(id)) throw invalid(`a ${what} id is a UUID`);
  return id;
};

export function markHandlers(deps: { db: Db }): Partial<ServiceImpl<typeof RedactionPolicyService>> {
  const { db } = deps;
  const callerIn = (ctx: HandlerContext): Caller => callerOf(ctx.values);
  const tx = async <T>(fn: (client: TxClient) => Promise<T>): Promise<T> => {
    try {
      return await inTransaction(db, fn);
    } catch (error) {
      throw dbError(error);
    }
  };
  /** The caller as 0014's functions record and check them. */
  const actor = (caller: Caller): [string | null, string[], string | null] => [caller.subject, [...caller.groups], traceId()];

  return {
    addRedactionMark: async (request, ctx) => {
      const caller = callerIn(ctx);
      const roles = requireUser(caller);
      const [kind, subject] = subjectOf(request);
      const category = nameOf(CATEGORY_OUT, request.category);
      if (category === undefined) throw invalid('choose a text category: an image is shown, blurred or hidden whole');
      const quote = request.quote.trim();
      const field = nameOf(FIELD_OUT, request.field);
      if (field === 'file') throw invalid('a file mark is added with the files its quote is found in, by the issue loader');
      if (quote === '' && field !== undefined) throw invalid('a whole-item mark has no field; a passage needs its text');
      if (quote !== '' && field === undefined) throw invalid('a marked passage needs the field it is in');
      if (quote !== '' && (quote.length < 3 || quote.length > 500)) throw invalid('a marked passage is 3 to 500 characters');
      if (field !== undefined && !FIELDS[kind].includes(field)) throw invalid(`a ${kind.replace('_', ' ')} has no ${field.replace('_', ' ')} field`);
      return tx(async (client) => {
        const found = await client.query(`SELECT 1 FROM ${kind} WHERE id = $1`, [subject]);
        if (found.rows.length === 0) throw new ConnectError('nothing to mark', Code.NotFound);
        if (!roles.officer) {
          const wrote = kind === 'content_item' && (await client.query(`SELECT 1 FROM content_version WHERE item_id = $1 AND created_by_sub = $2`, [subject, caller.subject])).rows.length > 0;
          if (!wrote) throw denied('an officer, or the person who wrote the item, marks it');
        }
        const { rows } = await client.query<MarkRow>(`SELECT ${MARK_COLUMNS} FROM redaction_mark_add($1, $2, $3, $4, $5, $6, $7, $8)`, [
          kind,
          subject,
          field ?? null,
          quote === '' ? null : quote,
          category,
          ...actor(caller),
        ]);
        // The ledger covers content versions and PDFs; event renderings are a follow-up (R-LEDGER).
        if (kind === 'content_item') await recordItems(client, [subject]);
        return { mark: markMessage(rows[0] as MarkRow) };
      });
    },

    listRedactionMarks: async (request, ctx) => {
      requireOfficer(callerIn(ctx));
      const [kind, subject] = subjectOf(request);
      const { rows } = await db.query<MarkRow>(
        `SELECT m.id, m.content_item_id, m.series_id, m.occurrence_id, m.field, m.quote, m.category, m.status, m.created_by_sub, m.created_at,
           r.id AS pending_removal_id, r.proposed_by_sub AS removal_proposed_by
         FROM redaction_mark m LEFT JOIN redaction_mark_removal r ON r.mark_id = m.id AND r.status = 'pending'
         WHERE m.tenant_id = $1 AND m.${COLUMN[kind]} = $2 ORDER BY m.created_at, m.id`,
        [TENANT, subject],
      );
      return { marks: rows.map(markMessage) };
    },

    proposeMarkRemoval: async (request, ctx) => {
      const caller = callerIn(ctx);
      requireOfficer(caller);
      const id = idOf(request.markId, 'mark');
      return tx(async (client) => {
        const mark = (await client.query<{ status: string }>(`SELECT status FROM redaction_mark WHERE id = $1 AND tenant_id = $2`, [id, TENANT])).rows[0];
        if (mark === undefined) throw new ConnectError('mark not found', Code.NotFound);
        if (mark.status !== 'active') throw precondition('this mark is already removed');
        const waiting = await client.query(`SELECT 1 FROM redaction_mark_removal WHERE mark_id = $1 AND status = 'pending'`, [id]);
        if (waiting.rows.length > 0) throw precondition('a removal of this mark is already waiting for approval');
        const { rows } = await client.query<RemovalRow>(`SELECT ${REMOVAL_COLUMNS} FROM redaction_mark_propose_removal($1, $2, $3, $4)`, [id, ...actor(caller)]);
        return { removal: removalMessage(rows[0] as RemovalRow) };
      });
    },

    approveMarkRemoval: async (request, ctx) => {
      const caller = callerIn(ctx);
      requireOfficer(caller);
      const id = idOf(request.removalId, 'removal');
      return tx(async (client) => {
        const found = (await client.query<{ status: string; proposed_by_sub: string }>(`SELECT status, proposed_by_sub FROM redaction_mark_removal WHERE id = $1 AND tenant_id = $2`, [id, TENANT]))
          .rows[0];
        if (found === undefined) throw new ConnectError('removal not found', Code.NotFound);
        if (found.status !== 'pending') throw precondition('this removal is not waiting for approval');
        if (found.proposed_by_sub === caller.subject) throw denied('a second officer approves this removal');
        const { rows } = await client.query<RemovalRow>(`SELECT ${REMOVAL_COLUMNS} FROM redaction_mark_approve_removal($1, $2, $3, $4)`, [id, ...actor(caller)]);
        const removal = rows[0] as RemovalRow;
        const item = (await client.query<{ content_item_id: string | null }>(`SELECT content_item_id FROM redaction_mark WHERE id = $1`, [removal.mark_id])).rows[0];
        if (item?.content_item_id) await recordItems(client, [item.content_item_id]);
        return { removal: removalMessage(removal) };
      });
    },
  };
}
