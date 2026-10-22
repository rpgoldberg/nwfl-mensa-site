// ============================================================================
// Editions (R5, R25): the read shape, edition setup, and the freeze for print.
// Setup and the freeze belong to the Editor (nwfl-office-editor) and the
// Admin. An edition is named by its period, never by its printed Vol/No.
// Moving an edition to proof pins, in edition_item, the live version of each
// published item that targets the newsletter in this edition; a revision
// approved afterwards does not change the printed issue. Proof and published
// are reached only through the freeze (and, later, the PDF upload), never by
// editing.
// ============================================================================
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from '@connectrpc/connect';
import { recordAudit } from '../audit/audit.js';
import { type Caller, callerOf } from '../auth/caller.js';
import { requireUser } from '../auth/roles.js';
import { dbError } from '../db/errors.js';
import type { Db } from '../db/pool.js';
import { type TxClient, inTransaction } from '../db/tx.js';
import { isoDate, protoDate } from '../events/zone.js';
import type { ContentService } from '../gen/nwfl/mensa/v1/content_pb.js';
import type { Date as ProtoDate } from '../gen/nwfl/mensa/v1/common_pb.js';
import { type Edition, EditionKind, EditionSchema, EditionStatus } from '../gen/nwfl/mensa/v1/edition_pb.js';
import { EDITION_KINDS, EDITION_STATUSES, namesOf } from './enums.js';

export const EDITOR_OFFICE = 'editor';
const KIND_NAMES = namesOf(EDITION_KINDS);
const STATUS_NAMES = namesOf(EDITION_STATUSES);
const OPEN = new Set(['planning', 'collecting', 'drafting']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface EditionRow {
  id: string;
  slug: string;
  volume: number | null;
  issue_number: number | null;
  title: string;
  kind: string;
  period_start: string;
  period_end: string;
  submission_deadline: string | null;
  status: string;
  frozen_at: Date | null;
  public_pdf_file_id: string | null;
}

/** The SELECT list for an edition read; the hosted PDF only when that file is public. */
export const EDITION_SELECT = `SELECT e.id, e.slug, e.volume, e.issue_number, e.title, e.kind, e.period_start::text AS period_start,
     e.period_end::text AS period_end, e.submission_deadline::text AS submission_deadline, e.status, e.frozen_at,
     CASE WHEN f.audience = 'public' THEN f.id END AS public_pdf_file_id
   FROM edition e LEFT JOIN stored_file f ON f.id = e.public_pdf_file_id`;

type Queryable = Pick<Db, 'query'>;

/** Editions with their calendar ranges. */
export async function editionMessages(db: Queryable, rows: EditionRow[]): Promise<Edition[]> {
  const ranges =
    rows.length === 0
      ? []
      : (
          await db.query<{ edition_id: string; starts_on: string; ends_on: string }>(
            `SELECT edition_id, starts_on::text AS starts_on, ends_on::text AS ends_on FROM edition_calendar_range WHERE edition_id = ANY($1) ORDER BY starts_on`,
            [rows.map((row) => row.id)],
          )
        ).rows;
  return rows.map((row) =>
    create(EditionSchema, {
      id: row.id,
      slug: row.slug,
      volume: row.volume ?? 0,
      issueNumber: row.issue_number ?? 0,
      title: row.title,
      kind: EDITION_KINDS[row.kind],
      periodStart: protoDate(row.period_start),
      periodEnd: protoDate(row.period_end),
      calendarRanges: ranges.filter((range) => range.edition_id === row.id).map((range) => ({ start: protoDate(range.starts_on), end: protoDate(range.ends_on) })),
      ...(row.submission_deadline !== null ? { submissionDeadline: protoDate(row.submission_deadline) } : {}),
      status: EDITION_STATUSES[row.status],
      ...(row.frozen_at !== null ? { frozenAt: timestampFromDate(row.frozen_at) } : {}),
      publicPdfFileId: row.public_pdf_file_id ?? '',
    }),
  );
}

const invalid = (message: string): ConnectError => new ConnectError(message, Code.InvalidArgument);

function requireEditor(caller: Caller): void {
  const roles = requireUser(caller);
  if (!roles.admin && !roles.offices.includes(EDITOR_OFFICE)) throw new ConnectError('not permitted', Code.PermissionDenied);
}

function date(value: ProtoDate | undefined, field: string, need: boolean): string | null {
  if (value === undefined) {
    if (need) throw invalid(`${field} is required`);
    return null;
  }
  try {
    return isoDate(value);
  } catch {
    throw invalid(`${field} is not a calendar date`);
  }
}

async function load(client: TxClient, id: string): Promise<EditionRow> {
  if (!UUID.test(id)) throw invalid('edition_id is not an id');
  const { rows } = await client.query<EditionRow>(`${EDITION_SELECT} WHERE e.id = $1 FOR UPDATE OF e`, [id]);
  const row = rows[0];
  if (row === undefined) throw new ConnectError('edition not found', Code.NotFound);
  return row;
}

export function editionHandlers(deps: { db: Db }): Partial<ServiceImpl<typeof ContentService>> {
  const callerIn = (ctx: HandlerContext): Caller => callerOf(ctx.values);
  const tx = async <T>(fn: (client: TxClient) => Promise<T>): Promise<T> => {
    try {
      return await inTransaction(deps.db, fn);
    } catch (error) {
      throw dbError(error);
    }
  };

  return {
    saveEdition: async (request, ctx) => {
      const caller = callerIn(ctx);
      requireEditor(caller);
      const edition = request.edition;
      if (edition === undefined) throw invalid('edition is required');
      const kind = KIND_NAMES.get(edition.kind);
      if (kind === undefined || edition.kind === EditionKind.UNSPECIFIED) throw invalid('kind is required');
      const status = edition.status === EditionStatus.UNSPECIFIED ? undefined : STATUS_NAMES.get(edition.status);
      if (status !== undefined && !OPEN.has(status)) throw invalid('proof and published are reached by the freeze, not by editing');
      const ranges = edition.calendarRanges.map((range) => [date(range.start, 'calendar range start', true), date(range.end, 'calendar range end', true)]);
      const values = [
        edition.slug,
        edition.volume === 0 ? null : edition.volume,
        edition.issueNumber === 0 ? null : edition.issueNumber,
        edition.title.trim(),
        kind,
        date(edition.periodStart, 'period_start', true),
        date(edition.periodEnd, 'period_end', true),
        date(edition.submissionDeadline, 'submission_deadline', false),
        status ?? 'planning',
      ];
      return tx(async (client) => {
        let id: string;
        if (edition.id === '') {
          id = (
            await client.query<{ id: string }>(
              `INSERT INTO edition (slug, volume, issue_number, title, kind, period_start, period_end, submission_deadline, status)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
              values,
            )
          ).rows[0]?.id as string;
        } else {
          const existing = await load(client, edition.id);
          if (!OPEN.has(existing.status)) throw new ConnectError('a frozen edition cannot be edited', Code.FailedPrecondition);
          id = existing.id;
          await client.query(
            `UPDATE edition SET slug = $1, volume = $2, issue_number = $3, title = $4, kind = $5, period_start = $6, period_end = $7,
               submission_deadline = $8, status = $9, updated_at = now() WHERE id = $10`,
            [...values, id],
          );
          await client.query(`DELETE FROM edition_calendar_range WHERE edition_id = $1`, [id]);
        }
        for (const [start, end] of ranges) {
          await client.query(`INSERT INTO edition_calendar_range (edition_id, starts_on, ends_on) VALUES ($1, $2, $3)`, [id, start, end]);
        }
        await recordAudit(client, caller, { action: edition.id === '' ? 'create' : 'save', subjectKind: 'edition', subjectId: id });
        const [message] = await editionMessages(client, [await load(client, id)]);
        return { edition: message };
      });
    },

    freezeEdition: async (request, ctx) => {
      const caller = callerIn(ctx);
      requireEditor(caller);
      return tx(async (client) => {
        const edition = await load(client, request.editionId);
        if (!OPEN.has(edition.status)) throw new ConnectError('the edition is already frozen', Code.FailedPrecondition);
        // Pin while the edition is still open, then freeze it: a frozen edition's pins are frozen (0011).
        const pinned = await client.query(
          `INSERT INTO edition_item (edition_id, item_id, version_id)
           SELECT $1, i.id, i.live_version_id FROM content_item i JOIN content_version v ON v.id = i.live_version_id
           WHERE i.state = 'published' AND v.target_newsletter AND v.edition_id = $1`,
          [edition.id],
        );
        await client.query(`UPDATE edition SET status = 'proof', frozen_at = now(), updated_at = now() WHERE id = $1`, [edition.id]);
        const pinnedItems = pinned.rowCount ?? 0;
        await recordAudit(client, caller, { action: 'freeze', subjectKind: 'edition', subjectId: edition.id, fromState: edition.status, toState: 'proof', payload: { pinned_items: pinnedItems } });
        const [message] = await editionMessages(client, [await load(client, edition.id)]);
        return { edition: message, pinnedItems };
      });
    },
  };
}
