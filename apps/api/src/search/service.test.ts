// ARCHIVE-SEARCH S3: the search handler against a stand-in database, for what a real one cannot be made to do on
// demand: which statements run and in what order, which index a caller's role reads, and what a failure becomes.
// The reads themselves are tested against a real Postgres in test/search/search.test.ts.
import { Code, ConnectError, createClient, createRouterTransport } from '@connectrpc/connect';
import { describe, expect, it } from 'vitest';
import { type TokenVerifier, authInterceptor } from '../auth/caller.js';
import type { Db } from '../db/pool.js';
import { ContentKind } from '../gen/nwfl/mensa/v1/content_pb.js';
import { SearchService } from '../gen/nwfl/mensa/v1/search_pb.js';
import type { StructuredLogger } from '../platform/logger.js';
import type { SearchLimits } from './limits.js';
import { MAX_ROWS, searchRoutes } from './service.js';
import { searchSql, snippetSql } from './sql.js';

const ITEM = '11111111-1111-4111-8111-111111111111';
const VERSION = '22222222-2222-4222-8222-222222222222';
const FILE = '33333333-3333-4333-8333-333333333333';

const verifier: TokenVerifier = {
  verify: (token) => {
    if (token === 'member') return Promise.resolve({ client: 'site', subject: 'sub-member', groups: ['nwfl-members'], scopes: [] });
    if (token === 'officer') return Promise.resolve({ client: 'site', subject: 'sub-officer', groups: ['nwfl-members', 'nwfl-officers'], scopes: [] });
    if (token === 'lapsed') return Promise.resolve({ client: 'site', subject: 'sub-lapsed', groups: ['nwfl-members'], scopes: [] });
    return Promise.reject(new Error('unknown token'));
  },
};

type Answer = { rows: unknown[] } | Error;

function harness(answer: (text: string, values: unknown[] | undefined) => Answer = () => ({ rows: [] }), limits?: Partial<SearchLimits>, clock?: () => number) {
  const statements: Array<{ text: string; values: unknown[] | undefined }> = [];
  const logs: Array<{ level: string; fields: Record<string, unknown>; message: string }> = [];
  let released = 0;
  const query = (text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> => {
    statements.push({ text, values });
    const said = answer(text, values);
    return said instanceof Error ? Promise.reject(said) : Promise.resolve({ rows: said.rows, rowCount: said.rows.length });
  };
  const db = { query, connect: () => Promise.resolve({ query, release: () => void released++ }) } as unknown as Db;
  const logger = {
    info: (fields: Record<string, unknown>, message: string) => void logs.push({ level: 'info', fields, message }),
    warn: (fields: Record<string, unknown>, message: string) => void logs.push({ level: 'warn', fields, message }),
  } as unknown as StructuredLogger;
  const transport = createRouterTransport(searchRoutes({ db, logger, ...(limits === undefined ? {} : { limits }), ...(clock === undefined ? {} : { clock }) }), {
    router: { interceptors: [authInterceptor({ verifier, standing: { isMember: (subject) => Promise.resolve(subject !== 'sub-lapsed') } })] },
  });
  const client = createClient(SearchService, transport);
  const search = (query_: string, token?: string, page = 0) => client.search({ query: query_, page }, token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } });
  const refusal = async (run: () => Promise<unknown>): Promise<ConnectError> => {
    try {
      await run();
    } catch (error) {
      return ConnectError.from(error);
    }
    throw new Error('expected a refusal');
  };
  return { statements, logs, search, refusal, released: () => released };
}

describe('search: the handler', () => {
  it('runs one read-only snapshot: the isolation level, the two-second limit, then the search, with the query bound', async () => {
    const h = harness();
    const response = await h.search('  Spring \n picnic ');
    expect(response.hits).toEqual([]);
    expect(response.hasMore).toBe(false);
    expect(h.statements.slice(0, 4)).toEqual([
      { text: 'BEGIN', values: undefined },
      { text: 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY', values: undefined },
      { text: `SELECT set_config('statement_timeout', $1, true)`, values: ['2000'] },
      { text: searchSql('public'), values: ['Spring picnic', MAX_ROWS] },
    ]);
    expect(h.statements.at(-1)?.text).toBe('COMMIT');
    // Nothing found: no snippet is made.
    expect(h.statements.some((statement) => statement.text.includes('ts_headline'))).toBe(false);
    expect(h.released()).toBe(1);
    for (const statement of h.statements) expect(statement.text).not.toMatch(/Spring|picnic/);
  });

  it('reads the index the caller\'s verified role says: the public\'s with no token or no standing, the members\' for a member and for an officer', async () => {
    const read = async (token?: string): Promise<string> => {
      const h = harness();
      await h.search('picnic', token);
      return h.statements.find((statement) => statement.text.includes('websearch_to_tsquery'))!.text;
    };
    expect(await read()).toBe(searchSql('public'));
    expect(await read('lapsed')).toBe(searchSql('public'));
    expect(await read('member')).toBe(searchSql('members'));
    expect(await read('officer')).toBe(searchSql('members'));
    expect(searchSql('public')).not.toBe(searchSql('members'));
  });

  it('refuses a token it cannot verify rather than searching as the public', async () => {
    const h = harness();
    expect((await h.refusal(() => h.search('picnic', 'forged'))).code).toBe(Code.Unauthenticated);
    expect(h.statements).toEqual([]);
  });

  it('makes snippets for the page answered alone, by key, and answers each hit as the lens gives it', async () => {
    const rows = [
      { kind: 'item', id: ITEM, page: 0, slug: 'spring-picnic', title: 'Spring picnic', item_kind: 'announcement', version_id: VERSION, on_behalf_of: null, published_at: new Date('2026-03-08T02:30:00Z') },
      { kind: 'page', id: FILE, page: 4, slug: null, title: null, item_kind: null, version_id: null, on_behalf_of: null, published_at: null },
    ];
    const h = harness((text) => {
      if (text === searchSql('public')) return { rows };
      // An edition's file, and one whose title is not set.
      if (text.includes('FROM stored_file f')) return { rows: [{ item_id: null, version_id: null, title: null, on_behalf_of: null, edition_title: null }] };
      if (text === snippetSql('public')) return { rows: [{ kind: 'item', id: ITEM, page: 0, snippet: 'a \uE000picnic\uE001' }] };
      return { rows: [] };
    });
    const response = await h.search('picnic');
    expect(response.hits.map((hit) => hit.hit)).toMatchObject([
      // 02:30 UTC on the 8th is the evening of the 7th in the chapter's zone.
      { case: 'newsItem', value: { slug: 'spring-picnic', title: 'Spring picnic', kind: ContentKind.ANNOUNCEMENT, snippet: 'a \uE000picnic\uE001', publishedOn: { year: 2026, month: 3, day: 7 } } },
      // A hit whose row has gone by the time its snippet is made has an empty one.
      { case: 'issuePage', value: { fileId: FILE, issueLabel: '', page: 4, snippet: '' } },
    ]);
    const snippet = h.statements.find((statement) => statement.text === snippetSql('public'))!;
    expect(snippet.values).toEqual(['picnic', ['item', 'page'], [ITEM, FILE], [0, 4]]);
    expect(h.logs).toEqual([{ level: 'info', fields: { audience: 'public', query_chars: 6, words: 1, hits: 2, ms: expect.any(Number) as number }, message: 'search' }]);
  });

  it('leaves out a page whose file the served read would not give, before the page of hits is cut', async () => {
    const page = (n: number) => ({ kind: 'page', id: FILE, page: n, slug: null, title: null, item_kind: null, version_id: null, on_behalf_of: null, published_at: null });
    // servableFile finds no row for the file: every page of it is hidden, however many matched.
    const h = harness((text) => (text === searchSql('members') ? { rows: Array.from({ length: 40 }, (_unused, n) => page(n + 1)) } : { rows: [] }));
    const response = await h.search('picnic', 'member');
    expect(response.hits).toEqual([]);
    expect(response.hasMore).toBe(false);
    // The file was asked about once, not forty times.
    expect(h.statements.filter((statement) => statement.text.includes('FROM stored_file f'))).toHaveLength(1);
  });

  it('reads no further down the ranking than the page asked for needs', async () => {
    const item = (n: number) => ({ kind: 'item', id: `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`, page: 0, slug: `item-${n}`, title: `Item ${n}`, item_kind: 'article', version_id: VERSION, on_behalf_of: null, published_at: new Date('2026-01-01T12:00:00Z') });
    const rows = Array.from({ length: 35 }, (_unused, n) => item(n + 1));
    const answer = (text: string) => (text === searchSql('public') ? { rows } : { rows: [] });
    const titles = async (page: number) => {
      const h = harness(answer);
      const response = await h.search('item', undefined, page);
      // Snippets are made for the hits answered, never for the rest of what was found.
      const snippets = h.statements.filter((statement) => statement.text === snippetSql('public'));
      expect(snippets.map((statement) => (statement.values?.[2] as string[]).length)).toEqual(response.hits.length === 0 ? [] : [response.hits.length]);
      return { titles: response.hits.map((hit) => (hit.hit.value as { title: string }).title), hasMore: response.hasMore };
    };
    expect(await titles(1)).toEqual({ titles: rows.slice(0, 10).map((row) => row.title), hasMore: true });
    expect(await titles(3)).toEqual({ titles: rows.slice(20, 30).map((row) => row.title), hasMore: true });
    expect(await titles(4)).toEqual({ titles: rows.slice(30).map((row) => row.title), hasMore: false });
    expect(await titles(5)).toEqual({ titles: [], hasMore: false });
  });

  it('never says more follow on the last page', async () => {
    const rows = Array.from({ length: 150 }, (_unused, n) => ({ kind: 'item', id: `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`, page: 0, slug: `item-${n}`, title: `Item ${n}`, item_kind: 'article', version_id: VERSION, on_behalf_of: null, published_at: new Date('2026-01-01T12:00:00Z') }));
    const answer = (text: string) => (text === searchSql('public') ? { rows } : { rows: [] });
    expect((await harness(answer).search('item', undefined, 9)).hasMore).toBe(true);
    const last = await harness(answer).search('item', undefined, 10);
    expect(last.hits).toHaveLength(10);
    expect(last.hasMore).toBe(false);
  });

  it('answers a statement the database ended for running over its time DEADLINE_EXCEEDED, and logs it without the query', async () => {
    const h = harness((text) => (text.includes('websearch_to_tsquery') ? Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }) : { rows: [] }), { timeoutMs: 50 });
    const error = await h.refusal(() => h.search('zzcanaryzz picnic', 'officer'));
    expect(error.code).toBe(Code.DeadlineExceeded);
    expect(error.message).not.toContain('zzcanaryzz');
    expect(h.statements.find((statement) => statement.text.includes('set_config'))?.values).toEqual(['50']);
    expect(h.statements.at(-1)?.text).toBe('ROLLBACK');
    expect(h.logs).toEqual([{ level: 'warn', fields: { audience: 'officers', query_chars: 17, words: 2, ms: expect.any(Number) as number }, message: 'search timed out' }]);
    expect(h.released()).toBe(1);
  });

  it('starts no further statement once its two seconds have gone, though each statement was quick: DEADLINE_EXCEEDED', async () => {
    let now = 0;
    const file = (n: number) => ({ kind: 'page', id: `${String(n).padStart(8, '0')}-3333-4333-8333-333333333333`, page: 1, slug: null, title: null, item_kind: null, version_id: null, on_behalf_of: null, published_at: null });
    const answer = (text: string): Answer => {
      if (text === searchSql('public')) return { rows: Array.from({ length: 40 }, (_unused, n) => file(n)) };
      // Each look at a file takes 300 ms, and finds a file the public may not have.
      if (text.includes('FROM stored_file f')) now += 300;
      return { rows: [] };
    };
    const h = harness(answer, undefined, () => now);
    const error = await h.refusal(() => h.search('picnic'));
    expect(error.code).toBe(Code.DeadlineExceeded);
    // 2000 ms at 300 ms a file: the seventh look ends at 2100 ms, and no eighth begins.
    expect(h.statements.filter((statement) => statement.text.includes('FROM stored_file f'))).toHaveLength(7);
    expect(h.statements.at(-1)?.text).toBe('ROLLBACK');
    expect(h.logs).toEqual([{ level: 'warn', fields: { audience: 'public', query_chars: 6, words: 1, ms: 2100 }, message: 'search timed out' }]);
  });

  it('makes no snippets once its time has gone', async () => {
    let now = 0;
    const answer = (text: string): Answer => {
      if (text === searchSql('public')) {
        now += 2001;
        return { rows: [{ kind: 'item', id: ITEM, page: 0, slug: 'spring-picnic', title: 'Spring picnic', item_kind: 'article', version_id: VERSION, on_behalf_of: null, published_at: new Date('2026-03-08T12:00:00Z') }] };
      }
      return { rows: [] };
    };
    const h = harness(answer, undefined, () => now);
    expect((await h.refusal(() => h.search('picnic'))).code).toBe(Code.DeadlineExceeded);
    expect(h.statements.some((statement) => statement.text === snippetSql('public'))).toBe(false);
    // A search with nothing to answer is not late for having been slow.
    now = 0;
    const empty = harness((text) => (text === searchSql('public') ? ((now += 5000), { rows: [] }) : { rows: [] }), undefined, () => now);
    expect((await empty.search('picnic')).hits).toEqual([]);
  });

  it('passes any other failure on as it is, for the access log to answer INTERNAL, and gives its place back', async () => {
    const h = harness((text) => (text.includes('websearch_to_tsquery') ? Object.assign(new Error('relation does not exist'), { code: '42P01' }) : { rows: [] }), { concurrent: 1 });
    for (let n = 0; n < 3; n++) {
      const error = await h.refusal(() => h.search('picnic'));
      expect([Code.DeadlineExceeded, Code.ResourceExhausted, Code.InvalidArgument]).not.toContain(error.code);
    }
    expect(h.statements.filter((statement) => statement.text.includes('websearch_to_tsquery'))).toHaveLength(3);
    expect(h.logs).toEqual([]);
  });

  it('checks the query before it takes a place or a token, and takes both before it touches the database', async () => {
    const h = harness(undefined, { burst: 1 });
    expect((await h.refusal(() => h.search('a'))).code).toBe(Code.InvalidArgument);
    expect((await h.refusal(() => h.search('picnic', undefined, 11))).code).toBe(Code.InvalidArgument);
    expect(h.statements).toEqual([]);
    // The one token is still there.
    await h.search('picnic');
    const count = h.statements.length;
    expect((await h.refusal(() => h.search('picnic'))).code).toBe(Code.ResourceExhausted);
    expect(h.statements).toHaveLength(count);
  });
});
