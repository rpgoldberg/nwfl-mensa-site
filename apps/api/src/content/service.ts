// ============================================================================
// ContentService reads (R2, R5, R22, R26): the roster, published items and
// published editions. The officer workflow RPCs arrive with A4b; until then
// they answer UNIMPLEMENTED.
//
// The body a caller gets is decided HERE, from the audience the verified token
// gave (auth/caller.ts), in one place: itemMessage().
//   public   reads public_ast ONLY (the column body_ast is never selected for
//            it), filtered again on the way out; a members item gives just its
//            title, summary and one placeholder; an officers item is NOT_FOUND.
//   members  reads body_ast with members passages kept (marked, not hidden).
//   officers as members, plus officers items and the content hash.
// The content hash covers members passages, so it is returned to officers
// only: with the public text and the canonical form in a public repository, a
// short members passage (a gate code) could be recovered from it by trial.
// ============================================================================
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, type ConnectRouter, type HandlerContext } from '@connectrpc/connect';
import { type Audience, callerOf } from '../auth/caller.js';
import type { Db } from '../db/pool.js';
import {
  ContentItemSchema,
  ContentKind,
  type ContentItem,
  ContentService,
  ContentVersionSchema,
  FileAudience,
  FileRole,
  ItemState,
  ItemVisibility,
  StoredFileSchema,
  VersionStatus,
} from '../gen/nwfl/mensa/v1/content_pb.js';
import { EditionKind, EditionSchema, EditionStatus } from '../gen/nwfl/mensa/v1/edition_pb.js';
import { OfficeKind, OfficeSchema, TermStatus } from '../gen/nwfl/mensa/v1/roster_pb.js';
import { protoDate, todayIn } from '../events/zone.js';
import { decodeToken, encodeToken, pageSize } from '../grpc/paging.js';
import { type Tree, filterForPublic, normalizeTree, toProtoDocument } from './tree.js';

export interface ContentDeps {
  db: Db;
  now: () => Date;
}

const KINDS: Record<string, ContentKind> = {
  article: ContentKind.ARTICLE,
  president_report: ContentKind.PRESIDENT_REPORT,
  announcement: ContentKind.ANNOUNCEMENT,
  minutes: ContentKind.MINUTES,
  treasurer_summary: ContentKind.TREASURER_SUMMARY,
  document: ContentKind.DOCUMENT,
  page: ContentKind.PAGE,
};
const KIND_NAMES = new Map(Object.entries(KINDS).map(([name, kind]) => [kind, name]));
const STATES: Record<string, ItemState> = {
  draft: ItemState.DRAFT,
  ready: ItemState.READY,
  published: ItemState.PUBLISHED,
  withdrawn: ItemState.WITHDRAWN,
};
const VERSION_STATUSES: Record<string, VersionStatus> = {
  draft: VersionStatus.DRAFT,
  ready: VersionStatus.READY,
  approved: VersionStatus.APPROVED,
  superseded: VersionStatus.SUPERSEDED,
  discarded: VersionStatus.DISCARDED,
};
const ITEM_VISIBILITIES: Record<string, ItemVisibility> = {
  public: ItemVisibility.PUBLIC,
  members: ItemVisibility.MEMBERS,
  officers: ItemVisibility.OFFICERS,
};
const FILE_AUDIENCES: Record<string, FileAudience> = {
  public: FileAudience.PUBLIC,
  members: FileAudience.MEMBERS,
  officers: FileAudience.OFFICERS,
};
const FILE_ROLES: Record<string, FileRole> = {
  primary: FileRole.PRIMARY,
  public_copy: FileRole.PUBLIC_COPY,
  source: FileRole.SOURCE,
};
const OFFICE_KINDS: Record<string, OfficeKind> = {
  elected: OfficeKind.ELECTED,
  appointed: OfficeKind.APPOINTED,
  ex_officio: OfficeKind.EX_OFFICIO,
  committee: OfficeKind.COMMITTEE,
  regional_external: OfficeKind.REGIONAL_EXTERNAL,
};
const TERM_STATUSES: Record<string, TermStatus> = {
  active: TermStatus.ACTIVE,
  acting: TermStatus.ACTING,
  vacant: TermStatus.VACANT,
};
const EDITION_KINDS: Record<string, EditionKind> = { regular: EditionKind.REGULAR, xtra: EditionKind.XTRA };
const EDITION_STATUSES: Record<string, EditionStatus> = {
  planning: EditionStatus.PLANNING,
  collecting: EditionStatus.COLLECTING,
  drafting: EditionStatus.DRAFTING,
  proof: EditionStatus.PROOF,
  published: EditionStatus.PUBLISHED,
};

/** Which file audiences each caller audience may list. */
const FILE_AUDIENCES_FOR: Record<Audience, string[]> = {
  public: ['public'],
  members: ['public', 'members'],
  officers: ['public', 'members', 'officers'],
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface ItemRow {
  id: string;
  slug: string;
  kind: string;
  office_id: string;
  state: string;
  withdrawn_at: Date | null;
  version_id: string;
  n: number;
  status: string;
  title: string;
  summary: string | null;
  visibility: string;
  body: unknown;
  content_hash: Buffer | null;
  target_website: boolean;
  target_newsletter: boolean;
  target_email: boolean;
  edition_id: string | null;
  print_as_is: boolean;
  on_behalf_of: string | null;
  ready_at: Date | null;
  approved_at: Date;
}

interface FileRow {
  id: string;
  version_id: string;
  filename: string;
  mime_type: string;
  size_bytes: string;
  sha256: Buffer;
  audience: string;
  role: string;
  public_copy_of: string | null;
}

/**
 * The SELECT for published items, by audience. The body column is chosen here
 * and nowhere else: the public never selects body_ast, and never loads a
 * members item's body at all.
 */
function itemQuery(audience: Audience): { select: string; visible: string } {
  const body = audience === 'public' ? `CASE WHEN v.visibility = 'public' THEN v.public_ast END` : 'v.body_ast';
  return {
    select: `SELECT i.id, i.slug, i.kind, i.office_id, i.state, i.withdrawn_at,
       v.id AS version_id, v.n, v.status, v.title, v.summary, v.visibility, ${body} AS body, v.content_hash,
       v.target_website, v.target_newsletter, v.target_email, v.edition_id, v.print_as_is, v.on_behalf_of,
       v.ready_at, v.approved_at
     FROM content_item i JOIN content_version v ON v.id = i.live_version_id`,
    visible: audience === 'officers' ? 'true' : `v.visibility <> 'officers'`,
  };
}

const PLACEHOLDER: Tree = { blocks: [{ type: 'redacted' }] };

/** THE body decision for a caller (see the header). */
export function bodyFor(audience: Audience, visibility: string, stored: unknown): Tree {
  if (audience !== 'public') return normalizeTree(stored);
  if (visibility !== 'public') return PLACEHOLDER;
  return filterForPublic(normalizeTree(stored));
}

function itemMessage(row: ItemRow, audience: Audience, files: FileRow[]): ContentItem {
  if (row.state === 'withdrawn') {
    return create(ContentItemSchema, {
      id: row.id,
      slug: row.slug,
      kind: KINDS[row.kind],
      officeId: row.office_id,
      state: ItemState.WITHDRAWN,
      ...(row.withdrawn_at !== null ? { withdrawnAt: timestampFromDate(row.withdrawn_at) } : {}),
    });
  }
  return create(ContentItemSchema, {
    id: row.id,
    slug: row.slug,
    kind: KINDS[row.kind],
    officeId: row.office_id,
    state: STATES[row.state],
    live: create(ContentVersionSchema, {
      id: row.version_id,
      itemId: row.id,
      number: row.n,
      status: VERSION_STATUSES[row.status],
      title: row.title,
      summary: row.summary ?? '',
      visibility: ITEM_VISIBILITIES[row.visibility],
      body: toProtoDocument(bodyFor(audience, row.visibility, row.body)),
      ...(audience === 'officers' && row.content_hash !== null ? { contentHash: row.content_hash } : {}),
      targets: { website: row.target_website, newsletter: row.target_newsletter, email: row.target_email },
      editionId: row.edition_id ?? '',
      printAsIs: row.print_as_is,
      onBehalfOf: row.on_behalf_of ?? '',
      ...(row.ready_at !== null ? { readyAt: timestampFromDate(row.ready_at) } : {}),
      approvedAt: timestampFromDate(row.approved_at),
      files: files
        .filter((file) => file.version_id === row.version_id)
        .map((file) =>
          create(StoredFileSchema, {
            id: file.id,
            filename: file.filename,
            mimeType: file.mime_type,
            sizeBytes: BigInt(file.size_bytes),
            sha256: file.sha256,
            audience: FILE_AUDIENCES[file.audience],
            role: FILE_ROLES[file.role],
            publicCopyOf: file.public_copy_of ?? '',
          }),
        ),
    }),
  });
}

export function contentRoutes(deps: ContentDeps): (router: ConnectRouter) => void {
  const { db } = deps;
  const audienceOf = (ctx: HandlerContext): Audience => callerOf(ctx.values).audience;

  const filesFor = async (rows: ItemRow[], audience: Audience): Promise<FileRow[]> => {
    const versions = rows.filter((row) => row.state !== 'withdrawn').map((row) => row.version_id);
    if (versions.length === 0) return [];
    const { rows: files } = await db.query<FileRow>(
      `SELECT id, version_id, filename, mime_type, size_bytes::text AS size_bytes, sha256, audience, role, public_copy_of
       FROM stored_file WHERE version_id = ANY($1) AND audience = ANY($2) ORDER BY filename, id`,
      [versions, FILE_AUDIENCES_FOR[audience]],
    );
    return files;
  };

  return (router) => {
    router.service(ContentService, {
      getRoster: async () => {
        const today = todayIn(deps.now());
        const [offices, terms] = await Promise.all([
          db.query<{ id: string; slug: string; title: string; kind: string; sort_order: number; role_alias: string | null; active: boolean }>(
            `SELECT id, slug, title, kind, sort_order, active,
               CASE WHEN role_alias_verified_on IS NOT NULL THEN role_alias END AS role_alias
             FROM office WHERE active ORDER BY sort_order, title`,
          ),
          db.query<{ id: string; office_id: string; holder_display_name: string | null; starts_on: string; ends_on: string | null; status: string }>(
            `SELECT id, office_id, holder_display_name, starts_on::text AS starts_on, ends_on::text AS ends_on, status
             FROM office_term WHERE starts_on <= $1 AND (ends_on IS NULL OR ends_on >= $1) ORDER BY starts_on, id`,
            [today],
          ),
        ]);
        return {
          offices: offices.rows.map((office) =>
            create(OfficeSchema, {
              id: office.id,
              slug: office.slug,
              title: office.title,
              kind: OFFICE_KINDS[office.kind],
              sortOrder: office.sort_order,
              roleAlias: office.role_alias ?? '',
              active: office.active,
              terms: terms.rows
                .filter((term) => term.office_id === office.id)
                .map((term) => ({
                  id: term.id,
                  officeId: term.office_id,
                  holderDisplayName: term.holder_display_name ?? '',
                  startsOn: protoDate(term.starts_on),
                  ...(term.ends_on !== null ? { endsOn: protoDate(term.ends_on) } : {}),
                  status: TERM_STATUSES[term.status],
                })),
            }),
          ),
        };
      },

      getPublishedItem: async (request, ctx) => {
        const audience = audienceOf(ctx);
        const query = itemQuery(audience);
        const { rows } = await db.query<ItemRow>(
          `${query.select} WHERE i.slug = $1 AND i.state IN ('published', 'withdrawn') AND ${query.visible}`,
          [request.slug],
        );
        const row = rows[0];
        if (row === undefined) throw new ConnectError('item not found', Code.NotFound);
        return { item: itemMessage(row, audience, await filesFor(rows, audience)) };
      },

      listPublishedItems: async (request, ctx) => {
        const audience = audienceOf(ctx);
        const size = pageSize(request.pageSize);
        const after = decodeToken('items', request.pageToken, 2);
        if (after !== undefined && (Number.isNaN(Date.parse(after[0] as string)) || !UUID.test(after[1] as string))) {
          throw new ConnectError('invalid page_token', Code.InvalidArgument);
        }
        if (request.officeId !== '' && !UUID.test(request.officeId)) throw new ConnectError('office_id is not an id', Code.InvalidArgument);
        const query = itemQuery(audience);
        const { rows } = await db.query<ItemRow>(
          `${query.select}
           WHERE i.state = 'published' AND ${query.visible}
             AND ($1::text IS NULL OR i.kind = $1)
             AND ($2::uuid IS NULL OR i.office_id = $2)
             AND ($3::timestamptz IS NULL OR (v.approved_at, i.id) < ($3, $4::uuid))
           ORDER BY v.approved_at DESC, i.id DESC
           LIMIT $5`,
          [
            KIND_NAMES.get(request.kind) ?? null,
            request.officeId === '' ? null : request.officeId,
            after?.[0] ?? null,
            after?.[1] ?? null,
            size + 1,
          ],
        );
        const page = rows.slice(0, size);
        const last = page.at(-1);
        const files = await filesFor(page, audience);
        return {
          items: page.map((row) => itemMessage(row, audience, files)),
          nextPageToken: rows.length > size && last !== undefined ? encodeToken('items', [last.approved_at.toISOString(), last.id]) : '',
        };
      },

      listPublishedEditions: async (request) => {
        const size = pageSize(request.pageSize);
        const after = decodeToken('editions', request.pageToken, 2);
        if (after !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(after[0] as string) || !UUID.test(after[1] as string))) {
          throw new ConnectError('invalid page_token', Code.InvalidArgument);
        }
        const { rows } = await db.query<{
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
        }>(
          `SELECT e.id, e.slug, e.volume, e.issue_number, e.title, e.kind, e.period_start::text AS period_start,
             e.period_end::text AS period_end, e.submission_deadline::text AS submission_deadline, e.status, e.frozen_at,
             CASE WHEN f.audience = 'public' THEN f.id END AS public_pdf_file_id
           FROM edition e LEFT JOIN stored_file f ON f.id = e.public_pdf_file_id
           WHERE e.status = 'published' AND ($1::date IS NULL OR (e.period_start, e.id) < ($1, $2::uuid))
           ORDER BY e.period_start DESC, e.id DESC
           LIMIT $3`,
          [after?.[0] ?? null, after?.[1] ?? null, size + 1],
        );
        const page = rows.slice(0, size);
        const ranges =
          page.length === 0
            ? []
            : (
                await db.query<{ edition_id: string; starts_on: string; ends_on: string }>(
                  `SELECT edition_id, starts_on::text AS starts_on, ends_on::text AS ends_on FROM edition_calendar_range
                   WHERE edition_id = ANY($1) ORDER BY starts_on`,
                  [page.map((row) => row.id)],
                )
              ).rows;
        const last = page.at(-1);
        return {
          editions: page.map((row) =>
            create(EditionSchema, {
              id: row.id,
              slug: row.slug,
              volume: row.volume ?? 0,
              issueNumber: row.issue_number ?? 0,
              title: row.title,
              kind: EDITION_KINDS[row.kind],
              periodStart: protoDate(row.period_start),
              periodEnd: protoDate(row.period_end),
              calendarRanges: ranges
                .filter((range) => range.edition_id === row.id)
                .map((range) => ({ start: protoDate(range.starts_on), end: protoDate(range.ends_on) })),
              ...(row.submission_deadline !== null ? { submissionDeadline: protoDate(row.submission_deadline) } : {}),
              status: EDITION_STATUSES[row.status],
              ...(row.frozen_at !== null ? { frozenAt: timestampFromDate(row.frozen_at) } : {}),
              publicPdfFileId: row.public_pdf_file_id ?? '',
            }),
          ),
          nextPageToken: rows.length > size && last !== undefined ? encodeToken('editions', [last.period_start, last.id]) : '',
        };
      },
    });
  };
}
