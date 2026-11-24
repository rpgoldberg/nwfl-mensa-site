// ============================================================================
// ARCHIVE-SEARCH S3: the two statements a search runs.
//
// Each is built from the AUDIENCE alone, a closed set of two (tables.ts), and
// holds no word a visitor typed: the query and the limit are bound parameters,
// and the query is read only by websearch_to_tsquery.
//
// searchSql finds the hits, best first. A row is a hit only when all of this
// holds, here in the statement, whatever the index tables contain (plan
// section 1, read rules b and c):
//   b. the publication ledger's CURRENT output for the row's subject and THIS
//      audience is the sha the row was written for; for a page, the ledger
//      also says the audience is served a copy (never the original, whose
//      text is not redacted). A row left behind by a change the worker has
//      not caught up with, or planted in the wrong table, matches nothing.
//   c. the served reads' own conditions (content/files.ts servableFile,
//      content/service.ts): the live version of a published item that is not
//      officers-only, or, for a file, a published edition. Officers read the
//      members' index, so officers-only items are in no one's results.
//   A page must also have been read under this TEXT_VERSION (text.ts): a row
//   of another join rule is not current (P1d), and the worker's sweep reads
//   the copy again (0034 search_page_lacking).
//   And no row counts while its item has an active mark, in a category the
//   audience is not shown, written after the row: for an item, after the app
//   last re-recorded its version for the audience (0035 version_rerecorded.at;
//   search_item_put stamps it, changed or not); for a page, after the file's
//   newest ready copy was made. A mark written by SQL with no re-record (D7a)
//   leaves such a row standing; it is refused here, in the statement, so the
//   live check (service.ts) never runs for it and a search's time cannot say
//   that a word the mark withholds matched (challenge S3-1, S1).
// Each hit also carries its row's own sha, for service.ts to ask the live
// code whether the row is still what the served read gives (P1d, D7a).
//
// For members, an issue's hits come from the members' file alone: a public
// file's pages are left out while the same version has a members' file the
// ledger says members are served a copy of.
//
// snippetSql makes the snippets, for the hits of the one page answered and no
// others: ts_headline over the row's own text in the audience's own table,
// read by the keys searchSql gave in the same snapshot (service.ts).
// ============================================================================
import { TENANT } from '../redaction/policy.js';
import { SEARCH_AUDIENCES, SEARCH_TABLES, type SearchAudience } from './tables.js';
import { TEXT_VERSION } from './text.js';

/** Private-use characters around each word found. The site escapes the snippet, then turns only these into a highlight. */
export const SNIPPET_START = '';
export const SNIPPET_STOP = '';

export interface SearchRow {
  kind: 'page' | 'item';
  /** A page's file, or an item. */
  id: string;
  /** 1-based; 0 on an item. */
  page: number;
  /** An item's own columns; null on a page. */
  slug: string | null;
  title: string | null;
  item_kind: string | null;
  version_id: string | null;
  on_behalf_of: string | null;
  published_at: Date | null;
  /** The sha the row was put with: a page's copy, an item's render (the ledger's output then). */
  sha: Buffer;
}

export interface SnippetRow {
  kind: 'page' | 'item';
  id: string;
  page: number;
  snippet: string;
}

const current = (audience: SearchAudience, kind: 'stored_file' | 'content_version', subject: string, sha: string): string =>
  `l.tenant_id = '${TENANT}' AND l.subject_kind = '${kind}' AND l.subject_id = ${subject} AND l.audience = '${audience}' AND l.current_to IS NULL AND l.output_sha256 = ${sha}`;

/**
 * Whether an active mark on `itemId` that this audience is not shown (its policy cell is not 'show', as resolveAction
 * reads it) was written after `since`. Such a mark is not in the row: the row is not the item as read now, and is no
 * row of the statement, so no live check runs for it and the time a search takes cannot say that it matched.
 */
const markSince = (audience: SearchAudience, itemId: string, since: string): string =>
  `EXISTS (SELECT 1 FROM redaction_mark m
            WHERE m.tenant_id = '${TENANT}' AND m.content_item_id = ${itemId} AND m.status = 'active'
              AND m.created_at > coalesce(${since}, '-infinity'::timestamptz)
              AND NOT EXISTS (SELECT 1 FROM redaction_policy r
                               WHERE r.tenant_id = '${TENANT}' AND r.audience = '${audience}' AND r.category = m.category AND r.action = 'show'))`;

const QUERY = `websearch_to_tsquery('english', $1)`;

function tablesOf(audience: SearchAudience): { item: string; page: string } {
  if (!SEARCH_AUDIENCES.includes(audience)) throw new Error('no such search audience');
  return SEARCH_TABLES[audience];
}

/** The hits, best first, then newest first. $1 the query as parsed (query.ts), $2 the most rows to give. */
export function searchSql(audience: SearchAudience): string {
  const { item, page } = tablesOf(audience);
  const textVersion = String(Math.trunc(TEXT_VERSION));
  // Members only: the public file of a version that also has a members' file they are served a copy of.
  const membersCopyOnly =
    audience === 'public'
      ? ''
      : `AND NOT (f.audience <> 'members' AND EXISTS (
               SELECT 1 FROM stored_file m JOIN publication_ledger l ON l.tenant_id = '${TENANT}' AND l.subject_kind = 'stored_file'
                  AND l.subject_id = m.id AND l.audience = '${audience}' AND l.current_to IS NULL AND l.output_sha256 IS NOT NULL AND l.inputs ->> 'served' = 'copy'
                WHERE m.version_id = f.version_id AND m.audience = 'members' AND m.mime_type = 'application/pdf'))`;
  return `WITH q AS (
    -- No row when the query has nothing to look for (only stop words) or only leaves words out: then nothing is a hit.
    SELECT t.q FROM (SELECT ${QUERY} AS q) t WHERE numnode(t.q) > 0 AND querytree(t.q) <> 'T'
  )
  SELECT 'page' AS kind, p.file_id AS id, p.page AS page, ts_rank_cd(p.tsv, q.q) AS rank, coalesce(v.published_at, e.period_start::timestamptz) AS dated,
         NULL::text AS slug, NULL::text AS title, NULL::text AS item_kind, NULL::uuid AS version_id, NULL::text AS on_behalf_of, NULL::timestamptz AS published_at,
         p.served_sha256 AS sha
    FROM q
    JOIN ${page} p ON p.tsv @@ q.q
    JOIN stored_file f ON f.id = p.file_id AND f.mime_type = 'application/pdf'
    LEFT JOIN content_version v ON v.id = f.version_id
    LEFT JOIN content_item i ON i.live_version_id = v.id AND i.state = 'published' AND v.visibility <> 'officers'
    LEFT JOIN edition e ON e.id = f.edition_id AND e.status = 'published'
   WHERE (i.id IS NOT NULL OR e.id IS NOT NULL) AND p.text_version = ${textVersion}
     AND EXISTS (SELECT 1 FROM publication_ledger l WHERE ${current(audience, 'stored_file', 'p.file_id', 'p.served_sha256')} AND l.inputs ->> 'served' = 'copy')
     ${membersCopyOnly}
     AND NOT ${markSince(audience, 'v.item_id', `(SELECT max(c.created_at) FROM pdf_copy c WHERE c.file_id = p.file_id AND c.status = 'ready')`)}
  UNION ALL
  SELECT 'item' AS kind, s.item_id AS id, 0 AS page, ts_rank_cd(s.tsv, q.q) AS rank, v.published_at AS dated,
         i.slug, s.title, i.kind AS item_kind, s.version_id, v.on_behalf_of, v.published_at, s.rendered_sha256 AS sha
    FROM q
    JOIN ${item} s ON s.tsv @@ q.q
    JOIN content_item i ON i.id = s.item_id AND i.live_version_id = s.version_id AND i.state = 'published'
    JOIN content_version v ON v.id = s.version_id AND v.visibility <> 'officers'
   WHERE EXISTS (SELECT 1 FROM publication_ledger l WHERE ${current(audience, 'content_version', 's.version_id', 's.rendered_sha256')})
     AND NOT ${markSince(audience, 's.item_id', `(SELECT c.at FROM version_rerecorded c WHERE c.version_id = s.version_id AND c.audience = '${audience}')`)}
   ORDER BY rank DESC, dated DESC NULLS LAST, kind, id, page
   LIMIT $2`;
}

/**
 * A snippet for each hit named: $1 the query, then the hits' kinds, ids and pages as three arrays of one length.
 * The row is read by its key in this audience's table; marker characters already in its text are taken out first.
 */
export function snippetSql(audience: SearchAudience): string {
  const { item, page } = tablesOf(audience);
  const headline = (text: string): string =>
    `ts_headline('english', translate(${text}, '${SNIPPET_START}${SNIPPET_STOP}', ''), q.q, 'StartSel=${SNIPPET_START}, StopSel=${SNIPPET_STOP}, MaxFragments=2, MinWords=12, MaxWords=30')`;
  return `SELECT h.kind, h.id, h.page,
         CASE h.kind
           WHEN 'page' THEN (SELECT ${headline('p.text')} FROM ${page} p WHERE p.file_id = h.id AND p.page = h.page)
           ELSE (SELECT ${headline('s.text')} FROM ${item} s WHERE s.item_id = h.id)
         END AS snippet
    FROM unnest($2::text[], $3::uuid[], $4::integer[]) AS h(kind, id, page)
   CROSS JOIN (SELECT ${QUERY} AS q) q`;
}
