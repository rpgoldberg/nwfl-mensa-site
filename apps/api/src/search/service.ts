// ============================================================================
// ARCHIVE-SEARCH S3: SearchService.Search, the archive search's one read.
//
// THE AUDIENCE comes from the verified caller (auth/caller.ts) and from
// nothing in the request: no token reads the public's index, a member or an
// officer reads the members' index, and officers have none of their own. The
// tables are chosen by that audience (tables.ts); none has an audience column,
// so no condition can cross from one to the other.
//
// What makes a row a hit is in the statement (sql.ts): the ledger stands
// behind it for this audience now, and its item or edition is one the served
// reads would give. Then the lens is asked what the served reads ask it
// (content/files.ts servableFile, content/service.ts): a hit it hides is left
// out, an issue's label is its title as the lens gives it, and an item's slug
// is its id where the audience is not given the slug. That is not only a
// second check: a PDF of an item written for a named member has a copy and a
// ledger row for an audience whose policy hides the item itself, and only the
// lens says so, exactly as it does for ContentService.ReadFile.
//
// Hidden hits are left out BEFORE the page is cut, so neither the number of
// hits on a page nor has_more can say that something withheld matched. A
// search reads at most MAX_ROWS rows of the ranking to fill its page.
//
// One REPEATABLE READ, read-only transaction: the hits, the lens and the
// snippets are read from one snapshot.
//
// The answer has no total and does not repeat the query. The log line is the
// audience, the query's length and word count, the hits and the time: NEVER
// the query. No audit row: readers are not logged (0016).
//
// Limits: query.ts (what may be asked) and limits.ts (how often). Each search
// is one read-only transaction whose statements the database ends after two
// seconds, and the search itself starts no further statement once two seconds
// have gone; either is answered DEADLINE_EXCEEDED.
// ============================================================================
import { Code, ConnectError, type ConnectRouter, type HandlerContext } from '@connectrpc/connect';
import type { MessageInitShape } from '@bufbuild/protobuf';
import { callerOf } from '../auth/caller.js';
import { KINDS } from '../content/enums.js';
import { servableFile } from '../content/files.js';
import { itemHidden, slugFor } from '../content/redact.js';
import type { Db } from '../db/pool.js';
import { inTransaction } from '../db/tx.js';
import { localDateOf, protoDate } from '../events/zone.js';
import { type SearchHitSchema, type SearchResponseSchema, SearchService } from '../gen/nwfl/mensa/v1/search_pb.js';
import type { StructuredLogger } from '../platform/logger.js';
import { loadLens } from '../redaction/lens.js';
import { type SearchLimits, admission, limitsFrom } from './limits.js';
import { PAGE_SIZE, MAX_PAGE, pageNumber, parseQuery } from './query.js';
import { type SearchRow, type SnippetRow, searchSql, snippetSql } from './sql.js';
import type { SearchAudience } from './tables.js';

export interface SearchDeps {
  db: Db;
  logger: StructuredLogger;
  /** The limits to run with; production's (limits.ts) when not given. Tests lift the rate. */
  limits?: Partial<SearchLimits>;
  /** Milliseconds, for the limits and the log line. Tests pin it. */
  clock?: () => number;
}

type Hit = MessageInitShape<typeof SearchHitSchema>;
type Response = MessageInitShape<typeof SearchResponseSchema>;
type Query = Pick<Db, 'query'>;

/** Postgres's query_canceled: statement_timeout ended the statement. */
const CANCELED = '57014';
/** The search's own stop, between statements, read by the handler as the database's is. */
const overtime = (): Error => Object.assign(new Error('search ran over its time'), { code: CANCELED });
/** The most rows of the ranking one search reads: three times what ten full pages hold, for the hits the lens leaves out. */
export const MAX_ROWS = 3 * MAX_PAGE * PAGE_SIZE;

interface Shown {
  row: SearchRow;
  /** An issue's title, or an item's slug, as the lens gives it to this audience. */
  label: string;
}

/** The first `need` rows the lens does not hide from this audience, in order. Asks about no further file once `late` says the time is up. */
async function shownTo(db: Query, audience: SearchAudience, rows: readonly SearchRow[], need: number, late: () => boolean): Promise<Shown[]> {
  const items = rows.filter((row) => row.kind === 'item');
  const lens = await loadLens(db, audience, { items: items.map((row) => row.id), versions: items.map((row) => row.version_id as string) });
  const files = new Map<string, { title: string | null } | null>();
  const shown: Shown[] = [];
  for (const row of rows) {
    if (shown.length >= need) break;
    if (row.kind === 'page') {
      if (!files.has(row.id)) {
        if (late()) throw overtime();
        files.set(row.id, await servableFile(db, row.id, audience));
      }
      const file = files.get(row.id) ?? null;
      if (file !== null) shown.push({ row, label: file.title ?? '' });
    } else if (!itemHidden({ id: row.id, on_behalf_of: row.on_behalf_of }, row.version_id as string, lens)) {
      shown.push({ row, label: slugFor({ id: row.id, slug: row.slug as string }, lens) });
    }
  }
  return shown;
}

const keyOf = (row: { kind: string; id: string; page: number }): string => `${row.kind}:${row.id}:${row.page}`;

function hitOf({ row, label }: Shown, snippet: string): Hit {
  if (row.kind === 'page') return { hit: { case: 'issuePage', value: { fileId: row.id, issueLabel: label, page: row.page, snippet } } };
  return {
    hit: {
      case: 'newsItem',
      value: { slug: label, title: row.title as string, publishedOn: protoDate(localDateOf(row.published_at as Date)), snippet, kind: KINDS[row.item_kind as string] as number },
    },
  };
}

/** One page of hits for the audience, and whether a hit follows it. `late` says the search's time is up. */
async function searchPage(db: Query, audience: SearchAudience, text: string, page: number, late: () => boolean): Promise<{ hits: Hit[]; hasMore: boolean }> {
  const { rows } = await db.query<SearchRow>(searchSql(audience), [text, MAX_ROWS]);
  const shown = await shownTo(db, audience, rows, page * PAGE_SIZE + 1, late);
  const onPage = shown.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  if (onPage.length === 0) return { hits: [], hasMore: false };
  if (late()) throw overtime();
  const made = await db.query<SnippetRow>(snippetSql(audience), [text, onPage.map((hit) => hit.row.kind), onPage.map((hit) => hit.row.id), onPage.map((hit) => hit.row.page)]);
  const snippets = new Map(made.rows.map((row) => [keyOf(row), row.snippet]));
  return { hits: onPage.map((hit) => hitOf(hit, snippets.get(keyOf(hit.row)) ?? '')), hasMore: shown.length > page * PAGE_SIZE && page < MAX_PAGE };
}

export function searchHandlers(deps: SearchDeps): { search: (request: { query: string; page: number }, ctx: HandlerContext) => Promise<Response> } {
  const limits = limitsFrom(deps.limits);
  const clock = deps.clock ?? ((): number => performance.now());
  const gate = admission(limits, clock);
  return {
    async search(request, ctx) {
      const caller = callerOf(ctx.values).audience;
      // Officers have no index: their search reads what members are given.
      const audience: SearchAudience = caller === 'public' ? 'public' : 'members';
      const query = parseQuery(request.query);
      const page = pageNumber(request.page);
      const leave = gate.enter();
      const started = clock();
      const sizes = { audience: caller, query_chars: query.chars, words: query.words };
      const ms = (): number => Math.round(clock() - started);
      try {
        const answer = await inTransaction(deps.db, async (tx) => {
          await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
          await tx.query(`SELECT set_config('statement_timeout', $1, true)`, [String(limits.timeoutMs)]);
          return searchPage(tx, audience, query.text, page, () => clock() - started > limits.timeoutMs);
        });
        deps.logger.info({ ...sizes, hits: answer.hits.length, ms: ms() }, 'search');
        return answer;
      } catch (error) {
        if ((error as { code?: unknown }).code !== CANCELED) throw error;
        deps.logger.warn({ ...sizes, ms: ms() }, 'search timed out');
        throw new ConnectError('the search took too long', Code.DeadlineExceeded);
      } finally {
        leave();
      }
    },
  };
}

export function searchRoutes(deps: SearchDeps): (router: ConnectRouter) => void {
  return (router) => {
    router.service(SearchService, searchHandlers(deps));
  };
}
