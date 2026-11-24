// ARCHIVE-SEARCH S3, after S1 and S2 merged: the read side's answers to what the write side handed over.
//
//   P1d  a deploy that changes the lens or the text rule leaves index rows that the ledger still stands
//        behind, because nothing re-recorded them: the read must not count them as current, and the
//        boot backfill (news) and the worker (pages) must bring them back.
//   D7a  a passage mark written by SQL with no re-record: the epoch does not cover it.
//   D6a  ALTER SEQUENCE rerecord_seq RESTART defeats the page writer's stamp check.
//   S2-N1 the sweep keeps rows of a file a mark hides; the read must refuse them.
//
// Each refusal has its positive control beside it. Real gRPC, real Postgres, the real engine and the
// real reader. The PDFs are synthetic, made here; every person and place is made up.
import { type Client } from '@connectrpc/connect';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContentKind, ContentService } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { type SearchResponse, SearchService } from '../../src/gen/nwfl/mensa/v1/search_pb.js';
import { TEXT_ENGINE, recordItems } from '../../src/ledger/ledger.js';
import { textReply } from '../../src/pdf/gate-text.js';
import { drain, sweepCopies } from '../../src/pdf/regenerate.js';
import { storeOriginal } from '../../src/pdf/store.js';
import { backfillItems } from '../../src/search/backfill.js';
import { type Texter, indexFile, indexSweeper } from '../../src/search/pages.js';
import { parseQuery } from '../../src/search/query.js';
import { type SearchRow, searchSql } from '../../src/search/sql.js';
import { TEXT_VERSION } from '../../src/search/text.js';
import { type Api, MEMBER, OFFICER, as, dump, insertId, startApi } from '../helpers/api.js';
import { paragraph, publishItem, text } from '../helpers/content.js';
import { live, url, urlFor } from '../helpers/pg.js';
import { pagesPdf } from './synthetic.js';

const PUB = as('pub-token');
const WEBMASTER = as('webmaster-token');
const TREASURER = as('treasurer-token');
const ANYONE = {};
const STORER = { sub: 'sub-officer', groups: ['nwfl-members', 'nwfl-officers'] };
const reader: Texter = ({ copy, quotes }) => textReply({ kind: 'text', copy, quotes });
type Who = { headers?: Record<string, string> };

const pagesOf = (response: SearchResponse): Array<[string, number]> =>
  response.hits.flatMap((hit) => (hit.hit.case === 'issuePage' ? [[hit.hit.value.fileId, hit.hit.value.page] as [string, number]] : []));
const slugsOf = (response: SearchResponse): string[] => response.hits.flatMap((hit) => (hit.hit.case === 'newsItem' ? [hit.hit.value.slug] : []));
const said = (response: SearchResponse): string => dump(response).replaceAll('', '').replaceAll('', '');

describe.skipIf(!live)('SearchService.Search: the write side\'s handoffs, closed on the read side', () => {
  let api: Api;
  let search: Client<typeof SearchService>;
  let content: Client<typeof ContentService>;
  let owner: pg.Client;
  let office: string;
  let counter = 0;

  const find = (query: string, who: Who = ANYONE): Promise<SearchResponse> => search.search({ query, page: 0 }, who);
  const inTx = async <T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> => {
    const client = await api.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };
  const publish = async (slug: string, title: string, body: string): Promise<{ itemId: string; versionId: string }> => {
    const item = (await content.createItem({ kind: ContentKind.ARTICLE, officeId: office, slug, title }, PUB)).item!;
    await content.saveDraft({ itemId: item.id, title, bodyMarkup: body }, PUB);
    const hash = (await content.markReady({ itemId: item.id, targets: { website: true, newsletter: false, email: false } }, PUB)).item?.working?.contentHash as Uint8Array;
    await content.approve({ itemId: item.id, contentHash: hash }, TREASURER);
    return { itemId: item.id, versionId: (await content.publish({ itemId: item.id, contentHash: hash }, WEBMASTER)).item?.live?.id as string };
  };
  const issue = async (title: string, files: Partial<Record<'public' | 'members', ReadonlyArray<readonly string[]>>>, body: string): Promise<{ itemId: string; versionId: string; files: Record<string, string> }> => {
    const n = ++counter;
    const made = await Promise.all(Object.entries(files).map(async ([audience, pages]) => ({ audience: audience as 'public' | 'members', bytes: await pagesPdf(pages) })));
    const { itemId, versionId } = await publishItem(api.pool, {
      slug: `handoff-issue-${n}`,
      kind: 'document',
      officeId: office,
      title,
      body: { blocks: [paragraph(text(body))] },
      files: made.map((file) => ({ objectKey: `handoff-issue-${n}-${file.audience}.pdf`, audience: file.audience, bytes: file.bytes })),
    });
    const ids: Record<string, string> = {};
    for (const file of made) {
      const fileId = (await api.pool.query<{ id: string }>(`SELECT id FROM stored_file WHERE version_id = $1 AND audience = $2`, [versionId, file.audience])).rows[0]!.id;
      await storeOriginal(api.pool, { fileId, bytes: file.bytes, ...STORER });
      ids[file.audience] = fileId;
    }
    await inTx((client) => recordItems(client, [itemId]));
    return { itemId, versionId, files: ids };
  };
  /** A passage mark written by SQL, as redaction/marks.ts writes it, but with NO re-record after it (D7a). */
  const sqlMark = (itemId: string, quote: string, category: string): Promise<unknown> =>
    api.pool.query(`SELECT redaction_mark_add('content_item', $1, 'body', $2, $3, $4, $5, NULL)`, [itemId, quote, category, STORER.sub, STORER.groups]);
  const work = (): Promise<number> => drain(api.worker, { index: (fileId) => indexFile(api.worker, fileId, { text: reader }) });
  /** What the search statement itself gives (sql.ts), before any live check runs: the ids of its rows. */
  const matched = async (audience: 'public' | 'members', query: string): Promise<string[]> =>
    (await api.pool.query<SearchRow>(searchSql(audience), [parseQuery(query).text, 300])).rows.map((row) => row.id);
  const rows = async (table: string, fileId: string): Promise<number> => (await owner.query(`SELECT 1 FROM ${table} WHERE file_id = $1`, [fileId])).rowCount ?? 0;

  beforeAll(async () => {
    api = await startApi('nwfl_search_handoffs', { search: { perSecond: 100_000, burst: 100_000 } });
    search = api.client(SearchService);
    content = api.client(ContentService);
    office = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ('publications', 'Publications Officer', 'appointed') RETURNING id`);
    const database = (await api.pool.query<{ db: string }>(`SELECT current_database() AS db`)).rows[0]!.db;
    owner = new pg.Client({ connectionString: urlFor('postgres', new URL(url as string).password, database) });
    await owner.connect();
  }, 120_000);

  afterAll(async () => {
    await owner?.end();
    await api?.close();
  });

  describe('news rows', () => {
    it('D7a: gives no one the old text of an item after a passage mark written by SQL with no re-record, until the item is re-recorded', async () => {
      const made = await publish('handoff-kayak', 'Kayak trip', 'The kayak trip leaves the jetty at nine. Call Tamsin Oddvar at 850-555-0161 for a paddle.');
      // Before the mark the public is given the number: nothing marks it.
      expect(slugsOf(await find('"850-555-0161"'))).toEqual(['handoff-kayak']);
      await sqlMark(made.itemId, '850-555-0161', 'member_phone');
      // The rows and the ledger's rows are as they were: the ledger still stands behind the public row, which holds the number.
      expect((await owner.query(`SELECT 1 FROM search_item_public s JOIN publication_ledger l ON l.subject_kind = 'content_version' AND l.subject_id = s.version_id
                                   AND l.audience = 'public' AND l.current_to IS NULL AND l.output_sha256 = s.rendered_sha256
                                  WHERE s.item_id = $1 AND s.text LIKE '%850-555-0161%'`, [made.itemId])).rowCount).toBe(1);
      // The public is not shown phones (0012): the item as read now withholds the number, so the row is not the item as read now.
      for (const query of ['"850-555-0161"', '0161', 'kayak', 'jetty']) {
        const response = await find(query);
        expect(response.hits, query).toEqual([]);
        expect(response.hasMore).toBe(false);
      }
      // Members are shown phones: the mark changes nothing they read, and their row stands.
      expect(slugsOf(await find('"850-555-0161"', MEMBER))).toEqual(['handoff-kayak']);
      // The re-record a mark through the API makes (redaction/marks.ts), here after the fact: the item comes back, the number does not.
      await inTx((client) => recordItems(client, [made.itemId]));
      expect(slugsOf(await find('jetty'))).toEqual([made.itemId]);
      expect(said(await find('jetty'))).not.toContain('0161');
      expect((await find('"850-555-0161"')).hits).toEqual([]);
    });

    it('P1d: does not count a row the ledger recorded under another lens as current, and the boot backfill re-records it', async () => {
      const made = await publish('handoff-lens', 'Bird walk', 'The bird walk meets at the heron pond.');
      expect(slugsOf(await find('heron'))).toEqual(['handoff-lens']);
      // The row and the ledger row as an older lens wrote them (another TEXT_ENGINE): the row holds a word the lens now withholds.
      await owner.query(`SELECT publication_ledger_record('content_version', $1, 'public', sha256('older lens'), $2::jsonb, 0)`, [made.versionId, JSON.stringify({ v: 1, engine: 'lens-older', version_id: made.versionId })]);
      await owner.query(`UPDATE search_item_public SET rendered_sha256 = sha256('older lens'), text = text || ' Ask for Quillbrook Fenn.' WHERE item_id = $1`, [made.itemId]);
      for (const query of ['Quillbrook', 'heron']) expect((await find(query)).hits, query).toEqual([]);
      // Members' rows were recorded under this lens: theirs stand.
      expect(slugsOf(await find('heron', MEMBER))).toEqual(['handoff-lens']);
      const result = await backfillItems(api.pool);
      expect(result.ran).toBe(true);
      expect(result.rerecorded).toBeGreaterThanOrEqual(1);
      const ledger = await owner.query<{ engine: string }>(`SELECT inputs ->> 'engine' AS engine FROM publication_ledger WHERE subject_kind = 'content_version' AND subject_id = $1 AND audience = 'public' AND current_to IS NULL`, [made.versionId]);
      expect(ledger.rows.map((row) => row.engine)).not.toContain('lens-older');
      expect(slugsOf(await find('heron'))).toEqual(['handoff-lens']);
      expect((await find('Quillbrook')).hits).toEqual([]);
      // A second boot finds nothing more to re-record for another lens.
      expect((await backfillItems(api.pool)).rerecorded).toBe(0);
    });
  });

  describe('issue pages', () => {
    let march: { itemId: string; versionId: string; files: Record<string, string> };

    beforeAll(async () => {
      march = await issue('Handoff issue, March', { public: [['The regatta starts at the boathouse'], ['Lanterns line the causeway at dusk']] }, 'Regatta and lanterns.');
      expect(await work()).toBe(1);
    }, 180_000);

    it('P1d: does not count a page whose copy the audience is not served now (a new engine\'s copy not yet made), and the worker\'s boot sweep brings it back', async () => {
      const fileId = march.files['public']!;
      expect(pagesOf(await find('regatta'))).toEqual([[fileId, 1]]);
      // After a deploy that changes ENGINE_VERSION every input hash is new, and no copy of the new hash is made yet: the read
      // of the file says not ready. The ledger's rows and the index rows are as the former engine left them. Here the copy of
      // the running engine's hash is taken away, which leaves the read in that very state.
      await owner.query(`DELETE FROM pdf_copy WHERE file_id = $1`, [fileId]);
      const behind = await owner.query(
        `SELECT 1 FROM search_page_public p JOIN publication_ledger l ON l.subject_kind = 'stored_file' AND l.subject_id = p.file_id AND l.audience = 'public'
            AND l.current_to IS NULL AND l.output_sha256 = p.served_sha256 AND l.inputs ->> 'served' = 'copy' WHERE p.file_id = $1`,
        [fileId],
      );
      expect(behind.rowCount).toBe(2);
      // The issue's news row (its body names both words) is not this file's: only its pages are asked about.
      for (const query of ['regatta', 'lanterns']) expect(pagesOf(await find(query)), query).toEqual([]);
      // The worker's boot sweep queues each file with no copy of its audiences' current hash, then makes, records and reads it.
      expect(await sweepCopies(api.worker)).toContain(fileId);
      expect(await work()).toBe(1);
      expect(pagesOf(await find('regatta'))).toEqual([[fileId, 1]]);
      expect(pagesOf(await find('lanterns'))).toEqual([[fileId, 2]]);
    });

    it('P1d: does not count a page read under another TEXT_VERSION as current, and the worker\'s sweep reads it again', async () => {
      const fileId = march.files['public']!;
      expect(pagesOf(await find('causeway'))).toEqual([[fileId, 2]]);
      await owner.query(`UPDATE search_page_public SET text_version = $2 WHERE file_id = $1`, [fileId, TEXT_VERSION + 1]);
      expect(pagesOf(await find('causeway'))).toEqual([]);
      const step = indexSweeper(api.worker, { text: reader });
      expect((await step()).indexed).toBeGreaterThanOrEqual(1);
      expect((await owner.query<{ v: number }>(`SELECT DISTINCT text_version AS v FROM search_page_public WHERE file_id = $1`, [fileId])).rows).toEqual([{ v: TEXT_VERSION }]);
      expect(pagesOf(await find('causeway'))).toEqual([[fileId, 2]]);
    });

    it('P1d: does not count a page whose row and ledger row name a copy other than the one the audience is served now', async () => {
      const fileId = march.files['public']!;
      expect(pagesOf(await find('causeway'))).toEqual([[fileId, 2]]);
      const kept = (await owner.query<{ output: Buffer; inputs: Record<string, unknown> }>(
        `SELECT output_sha256 AS output, inputs FROM publication_ledger WHERE subject_kind = 'stored_file' AND subject_id = $1 AND audience = 'public' AND current_to IS NULL`,
        [fileId],
      )).rows[0]!;
      // A former copy's: the ledger's row and the index rows both name it, while the copy of the current hash, made and ready, is another.
      await owner.query(`SELECT publication_ledger_record('stored_file', $1, 'public', sha256('a former copy'), $2::jsonb, 0)`, [fileId, JSON.stringify(kept.inputs)]);
      await owner.query(`UPDATE search_page_public SET served_sha256 = sha256('a former copy') WHERE file_id = $1`, [fileId]);
      expect(pagesOf(await find('causeway'))).toEqual([]);
      // Put back as they were: the ledger's row of the copy served now, and the rows read from it.
      await owner.query(`SELECT publication_ledger_record('stored_file', $1, 'public', $2, $3::jsonb, 0)`, [fileId, kept.output, JSON.stringify(kept.inputs)]);
      await owner.query(`UPDATE search_page_public SET served_sha256 = $2 WHERE file_id = $1`, [fileId, kept.output]);
      expect(pagesOf(await find('causeway'))).toEqual([[fileId, 2]]);
    });

    it('S2-N1 and D7a: gives no one a page or an item a mark hides, though rows for it stand with the ledger behind them and survive the sweep', async () => {
      const made = await issue('Handoff issue, hidden', { public: [['The quilting bee meets in the orangery']], members: [['The quilting bee meets in the orangery']] }, 'Quilting bee news.');
      expect(await work()).toBe(2);
      expect(pagesOf(await find('orangery'))).toEqual([[made.files['public']!, 1]]);
      expect(pagesOf(await find('orangery', MEMBER))).toEqual([[made.files['members']!, 1]]);
      type PageRow = { file_id: string; item_id: string; page: number; served_sha256: Buffer; text_version: number; text: string; extra: string };
      const columns = 'file_id, item_id, page, served_sha256, text_version, text, extra';
      const kept = {
        public: (await owner.query<PageRow>(`SELECT ${columns} FROM search_page_public WHERE file_id = $1`, [made.files['public']])).rows,
        members: (await owner.query<PageRow>(`SELECT ${columns} FROM search_page_members WHERE file_id = $1`, [made.files['members']])).rows,
      };
      // An address mark whose passage is in no text of the item, written by SQL: both audiences redact addresses, and the lens
      // fails closed on a passage it cannot find, so the item is hidden from both. No re-record follows.
      await sqlMark(made.itemId, '3 Nonesuch Row', 'member_address');
      // The mark's own trigger dropped the page rows (pdf_regen_request); they are put back as a put that slipped through would leave them.
      for (const audience of ['public', 'members'] as const) {
        for (const row of kept[audience]) {
          await owner.query(`INSERT INTO search_page_${audience} (file_id, item_id, page, served_sha256, text_version, text, extra) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
            row.file_id, row.item_id, row.page, row.served_sha256, row.text_version, row.text, row.extra,
          ]);
        }
      }
      // The ledger still stands behind them: the file's row is current with that sha, and the version's row still has an output.
      const behind = await owner.query(
        `SELECT 1 FROM search_page_public p JOIN publication_ledger l ON l.subject_kind = 'stored_file' AND l.subject_id = p.file_id AND l.audience = 'public'
            AND l.current_to IS NULL AND l.output_sha256 = p.served_sha256 AND l.inputs ->> 'served' = 'copy' WHERE p.file_id = $1`,
        [made.files['public']],
      );
      expect(behind.rowCount).toBe(1);
      // S2-N1: the sweep asks only the ledger and search_page_servable, so the rows stay.
      await indexSweeper(api.worker, { text: reader })();
      expect(await rows('search_page_public', made.files['public']!)).toBe(1);
      expect(await rows('search_page_members', made.files['members']!)).toBe(1);
      for (const who of [ANYONE, MEMBER, OFFICER]) {
        for (const query of ['orangery', 'quilting']) {
          const response = await find(query, who);
          expect(response.hits, query).toEqual([]);
          expect(response.hasMore).toBe(false);
        }
      }
    });

    it('D7a: a policy cell written by SQL with no re-record: members are not given the old text of an item until the backfill re-records it', async () => {
      const made = await publish('handoff-ferry', 'Ferry outing', 'The ferry outing sails from the wharf. Ring Corwin Ashgrove on 850-555-0133 to book.');
      await inTx(async (client) => {
        await client.query(`SELECT redaction_mark_add('content_item', $1, 'body', '850-555-0133', 'member_phone', $2, $3, NULL)`, [made.itemId, STORER.sub, STORER.groups]);
        await recordItems(client, [made.itemId]);
      });
      expect(slugsOf(await find('"850-555-0133"', MEMBER))).toEqual(['handoff-ferry']);
      // As 0022 wrote its change: the cell alone, no re-record. Members now redact phones.
      await owner.query(`UPDATE redaction_policy SET action = 'redact' WHERE tenant_id = 'nwflorida' AND audience = 'members' AND category = 'member_phone'`);
      for (const who of [MEMBER, OFFICER]) {
        for (const query of ['"850-555-0133"', '0133', 'wharf']) expect((await find(query, who)).hits, query).toEqual([]);
      }
      // The boot backfill re-records each item with a passage mark not re-recorded since the policy changed.
      expect((await backfillItems(api.pool)).rerecorded).toBeGreaterThanOrEqual(1);
      expect(slugsOf(await find('wharf', MEMBER))).toEqual([made.itemId]);
      expect(said(await find('wharf', MEMBER))).not.toContain('0133');
      expect((await find('"850-555-0133"', MEMBER)).hits).toEqual([]);
    });

    it('D6a: no role the app or the worker holds can reset the stamps\' sequence, and a reset one still gives no one a page the lens hides', async () => {
      for (const [role, pool] of [['nwfl', api.pool], ['nwfl_worker', api.worker]] as const) {
        for (const statement of [`ALTER SEQUENCE rerecord_seq RESTART`, `SELECT setval('rerecord_seq', 1)`, `SELECT nextval('rerecord_seq')`]) {
          const code = await pool.query(statement).then(() => 'ok', (error: { code?: string }) => error.code);
          expect(code, `${role}: ${statement}`).toBe('42501');
        }
      }
      // A mark whose passage is in no text of the item, in a category the public is shown (0012): it hides nothing yet.
      const made = await issue('Handoff issue, venue', { public: [['The chess club meets in the solarium']], members: [['The chess club meets in the solarium']] }, 'Chess club news.');
      await inTx(async (client) => {
        await client.query(`SELECT redaction_mark_add('content_item', $1, 'body', 'Pemberly Hall', 'business_venue', $2, $3, NULL)`, [made.itemId, STORER.sub, STORER.groups]);
        await recordItems(client, [made.itemId]);
      });
      // Every file the cell written by SQL above queued is made again too.
      expect(await work()).toBeGreaterThanOrEqual(2);
      expect(pagesOf(await find('solarium'))).toEqual([[made.files['public']!, 1]]);
      // The owner resets the sequence (as a restore that does not carry it would), then tightens the public's cell by SQL.
      await owner.query(`ALTER SEQUENCE rerecord_seq RESTART`);
      await owner.query(`UPDATE redaction_policy SET action = 'redact' WHERE tenant_id = 'nwflorida' AND audience = 'public' AND category = 'business_venue'`);
      const stamps = (await owner.query<{ stamp: string; epoch: string }>(
        `SELECT (SELECT seq FROM version_rerecorded WHERE version_id = $1 AND audience = 'public')::text AS stamp, (SELECT seq FROM policy_change_epoch)::text AS epoch`,
        [made.versionId],
      )).rows[0]!;
      expect(BigInt(stamps.stamp)).toBeGreaterThan(BigInt(stamps.epoch));
      // The worker makes the public's copy again and its put trusts the stale stamp: the rows of a file the public may not open are written.
      await work();
      expect(await rows('search_page_public', made.files['public']!)).toBe(1);
      const response = await find('solarium');
      expect(response.hits).toEqual([]);
      expect(response.hasMore).toBe(false);
      // Members are shown venues: their page stands.
      expect(pagesOf(await find('solarium', MEMBER))).toEqual([[made.files['members']!, 1]]);
    });
  });
  // Challenge S3-1. A stale row the read refuses only after its live check (a render, a copy's sha) costs that check, so
  // "no hits, but slow" said a withheld word matched (S1); and the boot backfill must bring such rows back, and stop (S2).
  describe('stale rows: refused by the statement itself, and re-recorded at boot (challenge S1, S2)', () => {
    // An earlier test here tightened members' phones by SQL; these tests read the policy as 0012 seeds it: members are shown phones.
    beforeAll(async () => {
      await owner.query(`UPDATE redaction_policy SET action = 'show' WHERE tenant_id = 'nwflorida' AND audience = 'members' AND category = 'member_phone'`);
      await backfillItems(api.pool);
    });

    it('S1 (A1, D7a): after a passage mark written by SQL with no re-record, the public\'s statement gives no row of the item, so no live check runs', async () => {
      const made = await publish('stale-canoe', 'Canoe club', 'The canoe club meets at the marina. Call Ondine Paxley at 850-555-0171 or 850-555-0172 for a seat.');
      expect(await matched('public', '"850-555-0171"')).toEqual([made.itemId]);
      await sqlMark(made.itemId, '850-555-0171', 'member_phone');
      // The public is not shown phones: a mark newer than the item's last re-record for the public refuses its row here.
      for (const query of ['"850-555-0171"', 'marina', 'canoe']) expect(await matched('public', query), query).toEqual([]);
      // Members are shown phones: the mark changes nothing they read, and their row is still a row of the statement.
      expect(await matched('members', '"850-555-0171"')).toEqual([made.itemId]);
      expect(slugsOf(await find('"850-555-0171"', MEMBER))).toEqual(['stale-canoe']);
      // Re-recorded: the row is the item as read now, and the statement gives it again, without the number.
      await inTx((client) => recordItems(client, [made.itemId]));
      expect(await matched('public', 'marina')).toEqual([made.itemId]);
      expect(await matched('public', '"850-555-0171"')).toEqual([]);
      // A mark made as the API makes it, with its re-record in the same transaction, refuses nothing it should not.
      await inTx(async (client) => {
        await client.query(`SELECT redaction_mark_add('content_item', $1, 'body', '850-555-0172', 'member_phone', $2, $3, NULL)`, [made.itemId, STORER.sub, STORER.groups]);
        await recordItems(client, [made.itemId]);
      });
      expect(await matched('public', 'marina')).toEqual([made.itemId]);
      expect(await matched('public', '"850-555-0172"')).toEqual([]);
      expect(slugsOf(await find('marina'))).toEqual([made.itemId]);
    });

    it('S1 (pages): a page of an item given a hiding mark by SQL after its copy was made is no row of the statement; a mark the audience is shown leaves the row', async () => {
      const made = await issue('Handoff issue, kiln', { public: [['The glassblowers meet at the kiln yard']], members: [['The glassblowers meet at the kiln yard']] }, 'Glassblowers news.');
      // Its two files, and any the policy write above queued again.
      expect(await work()).toBeGreaterThanOrEqual(2);
      expect(await matched('public', 'kiln')).toContain(made.files['public']);
      expect(await matched('members', 'kiln')).toContain(made.files['members']);
      type PageRow = { file_id: string; item_id: string; page: number; served_sha256: Buffer; text_version: number; text: string; extra: string };
      const columns = 'file_id, item_id, page, served_sha256, text_version, text, extra';
      const kept = {
        public: (await owner.query<PageRow>(`SELECT ${columns} FROM search_page_public WHERE file_id = $1`, [made.files['public']])).rows,
        members: (await owner.query<PageRow>(`SELECT ${columns} FROM search_page_members WHERE file_id = $1`, [made.files['members']])).rows,
      };
      // A phone mark whose passage is in no text of the item: the public redacts phones and the lens fails closed on it,
      // members are shown phones. No re-record follows.
      await sqlMark(made.itemId, '850-555-0188', 'member_phone');
      for (const audience of ['public', 'members'] as const) {
        await owner.query(`DELETE FROM search_page_${audience} WHERE file_id = $1`, [made.files[audience]]);
        for (const row of kept[audience]) {
          await owner.query(`INSERT INTO search_page_${audience} (file_id, item_id, page, served_sha256, text_version, text, extra) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
            row.file_id, row.item_id, row.page, row.served_sha256, row.text_version, row.text, row.extra,
          ]);
        }
      }
      expect(await matched('public', 'kiln')).not.toContain(made.files['public']);
      expect(await matched('public', 'glassblowers')).not.toContain(made.files['public']);
      expect(await matched('members', 'kiln')).toContain(made.files['members']);
      // With every copy of the file gone (as after a deploy, before the sweep makes them again), the mark is after any copy.
      await owner.query(`DELETE FROM pdf_copy WHERE file_id = $1`, [made.files['public']]);
      expect(await matched('public', 'kiln')).not.toContain(made.files['public']);
    });

    it('S1 (A2): a lens change deployed with no TEXT_ENGINE bump: the boot backfill re-records the item, and the former lens\'s row leaves the index', async () => {
      const made = await publish('stale-lens', 'Owl prowl', 'The owl prowl meets at the cedar gate.');
      expect(slugsOf(await find('cedar'))).toEqual(['stale-lens']);
      // As such a deploy leaves them: the ledger row and the index row of the former lens, naming THIS engine, holding a
      // word the lens now withholds.
      await owner.query(`SELECT publication_ledger_record('content_version', $1, 'public', sha256('former lens same engine'), $2::jsonb, 0)`, [made.versionId, JSON.stringify({ v: 1, engine: TEXT_ENGINE, version_id: made.versionId })]);
      await owner.query(`UPDATE search_item_public SET rendered_sha256 = sha256('former lens same engine'), text = text || ' Ask for Wrenna Thistlecombe.' WHERE item_id = $1`, [made.itemId]);
      for (const query of ['Thistlecombe', 'cedar']) expect((await find(query)).hits, query).toEqual([]);
      expect((await backfillItems(api.pool)).rerecorded).toBeGreaterThanOrEqual(1);
      expect((await owner.query(`SELECT 1 FROM search_item_public WHERE item_id = $1 AND text LIKE '%Thistlecombe%'`, [made.itemId])).rowCount).toBe(0);
      const current = await owner.query<{ same: boolean }>(
        `SELECT l.output_sha256 = s.rendered_sha256 AND l.output_sha256 <> sha256('former lens same engine') AS same FROM publication_ledger l JOIN search_item_public s ON s.version_id = l.subject_id
          WHERE l.subject_kind = 'content_version' AND l.subject_id = $1 AND l.audience = 'public' AND l.current_to IS NULL`,
        [made.versionId],
      );
      expect(current.rows).toEqual([{ same: true }]);
      expect(slugsOf(await find('cedar'))).toEqual(['stale-lens']);
      expect(await matched('public', 'Thistlecombe')).toEqual([]);
    });

    it('S1 (A2, members, in batches): a drift in members\' render alone is re-recorded too, whichever batch its item falls in', async () => {
      const made = [await publish('stale-kite-day', 'Kite day', 'Kite day is on the bluff.'), await publish('stale-kite-repair', 'Kite repair', 'Kite repair is in the barn.')];
      for (const [n, item] of made.entries()) {
        const former = `former members lens ${n}`;
        await owner.query(`SELECT publication_ledger_record('content_version', $1, 'members', sha256(convert_to($2, 'UTF8')), $3::jsonb, 0)`, [item.versionId, former, JSON.stringify({ v: 1, engine: TEXT_ENGINE, version_id: item.versionId })]);
        await owner.query(`UPDATE search_item_members SET rendered_sha256 = sha256(convert_to($2, 'UTF8')), text = text || ' Ask for Peregrine Oddleaf.' WHERE item_id = $1`, [item.itemId, former]);
      }
      expect((await find('Oddleaf', MEMBER)).hits).toEqual([]);
      // Batches of one item: two drifted items cannot both be in the first.
      expect((await backfillItems(api.pool, { batch: 1 })).rerecorded).toBeGreaterThanOrEqual(2);
      expect((await owner.query(`SELECT 1 FROM search_item_members WHERE text LIKE '%Oddleaf%'`)).rowCount).toBe(0);
      expect(slugsOf(await find('kite', MEMBER)).sort()).toEqual(['stale-kite-day', 'stale-kite-repair']);
    });

    it('S2 (A3): a TEXT_ENGINE bump whose render is unchanged: the backfill re-records nothing for it, and a second run nothing at all', async () => {
      const made = await publish('stale-engine', 'Star party', 'The star party meets on the levee.');
      const cur = (await owner.query<{ output: Buffer; inputs: Record<string, unknown>; w: number }>(
        `SELECT output_sha256 AS output, inputs, passages_withheld AS w FROM publication_ledger WHERE subject_kind = 'content_version' AND subject_id = $1 AND audience = 'public' AND current_to IS NULL`,
        [made.versionId],
      )).rows[0]!;
      // The former build recorded the same output under its engine's name (an interim row first: the ledger appends a change only).
      const older = JSON.stringify({ ...cur.inputs, engine: 'lens-older' });
      await owner.query(`SELECT publication_ledger_record('content_version', $1, 'public', sha256('interim'), $2::jsonb, $3)`, [made.versionId, older, cur.w]);
      await owner.query(`SELECT publication_ledger_record('content_version', $1, 'public', $2, $3::jsonb, $4)`, [made.versionId, cur.output, older, cur.w]);
      expect(slugsOf(await find('levee'))).toEqual(['stale-engine']);
      const ledgerRows = async (): Promise<number> =>
        (await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM publication_ledger WHERE subject_kind = 'content_version' AND subject_id = $1`, [made.versionId])).rows[0]!.n;
      const before = await ledgerRows();
      await backfillItems(api.pool);
      expect((await backfillItems(api.pool)).rerecorded).toBe(0);
      expect(await ledgerRows()).toBe(before);
      expect(slugsOf(await find('levee'))).toEqual(['stale-engine']);
    });
  });
});
