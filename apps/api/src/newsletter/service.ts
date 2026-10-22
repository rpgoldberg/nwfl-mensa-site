// ============================================================================
// NewsletterService (R12, P20): the newsletter agent's read API. Only the
// agent client reaches this service (auth/caller.ts admits nothing else here),
// with its read scope enforced when the token is verified. Its audience is
// members: it builds the issue members receive.
//
//   ListEditions        every edition, optionally by status
//   ListEditionItems    approved items with the newsletter target in the
//                       edition: the pinned versions once it is frozen, the
//                       live versions before. Drafts and ready items never.
//   GetEditionCalendar  the series and the occurrences in its calendar grids
//   GetEditionRoster    the roster as of the first day of its first grid
//   ExportEdition       the generator's content JSON for MEMBERS or PUBLIC,
//                       the one RPC that takes an audience; audited as
//                       export_read with the audience.
// ============================================================================
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError, type ConnectRouter, type HandlerContext } from '@connectrpc/connect';
import { recordAudit } from '../audit/audit.js';
import { callerOf } from '../auth/caller.js';
import { EDITION_SELECT, type EditionRow, editionMessages } from '../content/editions.js';
import { EDITION_STATUSES, KINDS, namesOf } from '../content/enums.js';
import { rosterAsOf } from '../content/service.js';
import { filterForPublic, normalizeTree } from '../content/tree.js';
import type { Db } from '../db/pool.js';
import { inTransaction } from '../db/tx.js';
import { type Entry, calendarSource, occurrenceMessage, seriesMessage } from '../events/service.js';
import { Audience } from '../gen/nwfl/mensa/v1/common_pb.js';
import { EditionItemSchema } from '../gen/nwfl/mensa/v1/content_pb.js';
import { NewsletterService } from '../gen/nwfl/mensa/v1/newsletter_pb.js';
import { TermStatus } from '../gen/nwfl/mensa/v1/roster_pb.js';
import type { StructuredLogger } from '../platform/logger.js';
import { CONTRACT_VERSION, type ExportAudience, type ExportInput, buildContentJson, exportEvent, monthsBetween } from './content-json.js';

export interface NewsletterDeps {
  db: Db;
  logger: StructuredLogger;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATUS_NAMES = namesOf(EDITION_STATUSES);
const FROZEN = new Set(['proof', 'published']);
// Print order: the President first, minutes last; by title within a kind.
const KIND_ORDER = ['president_report', 'announcement', 'article', 'treasurer_summary', 'document', 'page', 'minutes'];
const PRINT_ORDER = 'ORDER BY array_position($2::text[], i.kind::text), v.title, i.id';
interface PinnedRow {
  item_id: string;
  version_id: string;
  kind: string;
  office_id: string;
  title: string;
  summary: string | null;
  visibility: 'public' | 'members';
  n: number;
  content_hash: Buffer;
  body_ast: unknown;
  public_ast: unknown;
}

/**
 * The edition's items in print order: pinned versions once frozen, live ones
 * before; only approved versions either way. A withdrawn item is left out even
 * when pinned, as the site's edition listing does: withdrawal is the takedown.
 */
async function editionItems(db: Pick<Db, 'query'>, edition: EditionRow): Promise<PinnedRow[]> {
  const columns = `i.id AS item_id, v.id AS version_id, i.kind, i.office_id, v.title, v.summary, v.visibility, v.n, v.content_hash, v.body_ast, v.public_ast`;
  const { rows } = FROZEN.has(edition.status)
    ? await db.query<PinnedRow>(
        `SELECT ${columns} FROM edition_item ei JOIN content_item i ON i.id = ei.item_id JOIN content_version v ON v.id = ei.version_id
         WHERE ei.edition_id = $1 AND i.state = 'published' AND v.status IN ('approved', 'superseded') ${PRINT_ORDER}`,
        [edition.id, KIND_ORDER],
      )
    : await db.query<PinnedRow>(
        `SELECT ${columns} FROM content_item i JOIN content_version v ON v.id = i.live_version_id
         WHERE i.state = 'published' AND v.status = 'approved' AND v.target_newsletter AND v.edition_id = $1 ${PRINT_ORDER}`,
        [edition.id, KIND_ORDER],
      );
  return rows;
}

/** The dates the edition's calendar grids cover, from its ranges or else its period. */
async function gridRange(db: Pick<Db, 'query'>, edition: EditionRow): Promise<{ from: string; to: string }> {
  const { rows } = await db.query<{ from: string | null; to: string | null }>(
    `SELECT min(starts_on)::text AS from, max(ends_on)::text AS to FROM edition_calendar_range WHERE edition_id = $1`,
    [edition.id],
  );
  const range = rows[0];
  return range?.from != null && range.to != null ? { from: range.from, to: range.to } : { from: edition.period_start, to: edition.period_end };
}

export function newsletterRoutes(deps: NewsletterDeps): (router: ConnectRouter) => void {
  const { db } = deps;
  const calendar = calendarSource(db, deps.logger);

  const loadEdition = async (id: string): Promise<EditionRow> => {
    if (!UUID.test(id)) throw new ConnectError('edition_id is not an id', Code.InvalidArgument);
    const { rows } = await db.query<EditionRow>(`${EDITION_SELECT} WHERE e.id = $1`, [id]);
    const row = rows[0];
    if (row === undefined) throw new ConnectError('edition not found', Code.NotFound);
    return row;
  };

  /** The day the printed roster is "as of": the first day of the first grid month. */
  const rosterDay = async (edition: EditionRow): Promise<string> => `${(await gridRange(db, edition)).from.slice(0, 7)}-01`;

  const entriesOf = async (edition: EditionRow): Promise<Entry[]> => {
    const { from, to } = await gridRange(db, edition);
    return calendar.calendar(from, to);
  };

  return (router) => {
    router.service(NewsletterService, {
      listEditions: async (request) => {
        const statuses = request.statuses.map((status) => STATUS_NAMES.get(status)).filter((status) => status !== undefined);
        const { rows } = await db.query<EditionRow>(
          `${EDITION_SELECT} WHERE cardinality($1::text[]) = 0 OR e.status = ANY($1) ORDER BY e.period_start DESC, e.id DESC`,
          [statuses],
        );
        return { editions: await editionMessages(db, rows) };
      },

      listEditionItems: async (request) => {
        const edition = await loadEdition(request.editionId);
        const rows = await editionItems(db, edition);
        return {
          items: rows.map((row) =>
            create(EditionItemSchema, {
              editionId: edition.id,
              itemId: row.item_id,
              versionId: row.version_id,
              kind: KINDS[row.kind],
              officeId: row.office_id,
              title: row.title,
              versionNumber: row.n,
              contentHash: row.content_hash,
            }),
          ),
        };
      },

      getEditionCalendar: async (request) => {
        const edition = await loadEdition(request.editionId);
        const [entries, series] = await Promise.all([entriesOf(edition), calendar.loadSeries(false)]);
        return { series: series.map(seriesMessage), occurrences: entries.map((entry) => occurrenceMessage(entry, 'members')) };
      },

      getEditionRoster: async (request) => {
        const edition = await loadEdition(request.editionId);
        return { offices: await rosterAsOf(db, await rosterDay(edition)) };
      },

      exportEdition: async (request, ctx: HandlerContext) => {
        const audience: ExportAudience | undefined =
          request.audience === Audience.MEMBERS ? 'members' : request.audience === Audience.PUBLIC ? 'public' : undefined;
        if (audience === undefined) throw new ConnectError('audience must be MEMBERS or PUBLIC', Code.InvalidArgument);
        const edition = await loadEdition(request.editionId);
        const [items, offices, entries, grid] = await Promise.all([
          editionItems(db, edition),
          rosterAsOf(db, await rosterDay(edition)),
          entriesOf(edition),
          gridRange(db, edition),
        ]);
        const aliasOf = new Map(offices.map((office) => [office.id, office.roleAlias]));
        const input: ExportInput = {
          audience,
          edition: { slug: edition.slug, title: edition.title, volume: edition.volume, issueNumber: edition.issue_number, calendarMonths: monthsBetween(grid.from, grid.to) },
          items: items.map((row) => ({
            kind: row.kind,
            title: row.title,
            summary: row.summary,
            visibility: row.visibility,
            // The public export reads the public tree only, filtered again; the members export the full tree.
            tree: audience === 'public' ? filterForPublic(normalizeTree(row.public_ast)) : normalizeTree(row.body_ast),
          })),
          offices: offices.map((office) => ({
            slug: office.slug,
            title: office.title,
            holders: office.terms.filter((term) => term.status !== TermStatus.VACANT && term.holderDisplayName !== '').map((term) => term.holderDisplayName),
            roleAlias: office.roleAlias,
          })),
          events: entries.map((entry) => exportEvent(entry, aliasOf)),
        };
        const content = buildContentJson(input);
        // Recorded before the content is returned: an export that cannot be audited is not given.
        await inTransaction(db, (client) =>
          recordAudit(client, callerOf(ctx.values), { action: 'export_read', subjectKind: 'edition', subjectId: edition.id, payload: { audience } }),
        );
        return { contentJson: JSON.stringify(content, null, 2), contractVersion: CONTRACT_VERSION };
      },
    });
  };
}

