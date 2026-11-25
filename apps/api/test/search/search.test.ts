// ARCHIVE-SEARCH S3: SearchService.Search over real gRPC, against a real Postgres, with the index
// filled the way production fills it: news rows by the workflow and the ledger (S1), issue pages by
// the worker's job with the real engine and the real reader (S2).
//
// The point of most of it is what an audience must NOT be given: the public never a members-only
// passage, a redacted one or an officers-only item, in a hit, a title, a snippet or the number of
// hits; members never an officers-only item or what their own lens withholds. Each of those has its
// positive control beside it, so a search that finds nothing for everyone cannot pass.
//
// The PDFs are synthetic, made here with pdf-lib: never a real issue. Every person is made up.
import { createHash } from 'node:crypto';
import { Code, ConnectError, type Client } from '@connectrpc/connect';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContentKind, ContentService } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { MarkField, MarkSubjectKind, RedactionAction, RedactionAudience, RedactionCategory, RedactionPolicyService } from '../../src/gen/nwfl/mensa/v1/redaction_pb.js';
import { type SearchHit, type SearchResponse, SearchService } from '../../src/gen/nwfl/mensa/v1/search_pb.js';
import { recordItems } from '../../src/ledger/ledger.js';
import { textReply } from '../../src/pdf/gate-text.js';
import { drain } from '../../src/pdf/regenerate.js';
import { storeOriginal } from '../../src/pdf/store.js';
import { type Texter, indexFile } from '../../src/search/pages.js';
import { type Api, MEMBER, OFFICER, as, dump, insertId, startApi } from '../helpers/api.js';
import { paragraph, publishItem, text } from '../helpers/content.js';
import { live, url, urlFor } from '../helpers/pg.js';
import { pagesPdf } from './synthetic.js';

const PUB = as('pub-token');
const WEBMASTER = as('webmaster-token');
const TREASURER = as('treasurer-token');
const ANYONE = {};
const STORER = { sub: 'sub-officer', groups: ['nwfl-members', 'nwfl-officers'] };
const START = '';
const STOP = '';

// News. A phone the public is not shown and members are (0012), an address neither is, a word in a
// members-only passage, and a plain word everyone is given.
const PHONE = '850-555-0177';
const ADDRESS = '7 Wobblestone Court';
const SECRET = 'zephyrine';
const PLAIN = 'potluck';
// Issues. The same again, in a PDF.
const PDF_PHONE = '850-555-0142';
const PDF_ADDRESS = '12 Orchard Lane';
// An officers-only item's word, and a members-only FILE's.
const BOARD = 'xylograph';
const MARMALADE = 'marmalade';

type Who = { headers?: Record<string, string> };
const reader: Texter = ({ copy, quotes }) => textReply({ kind: 'text', copy, quotes });

const issuePages = (response: SearchResponse): Array<{ fileId: string; issueLabel: string; page: number; snippet: string }> =>
  response.hits.flatMap((hit) => (hit.hit.case === 'issuePage' ? [hit.hit.value] : []));
const newsItems = (response: SearchResponse): Array<{ slug: string; title: string; snippet: string; kind: ContentKind }> =>
  response.hits.flatMap((hit) => (hit.hit.case === 'newsItem' ? [hit.hit.value] : []));
const keyOf = (hit: SearchHit): string => (hit.hit.case === 'issuePage' ? `${hit.hit.value.fileId}#${hit.hit.value.page}` : hit.hit.case === 'newsItem' ? hit.hit.value.slug : 'none');
/** Everything a response carries, as text, without the snippet markers: so a withheld word cannot hide behind one. */
const said = (response: unknown): string => dump(response).replaceAll(START, '').replaceAll(STOP, '');
const marked = (snippet: string): string[] => [...snippet.matchAll(/([^]*)/g)].map((found) => found[1] as string);

describe.skipIf(!live)('SearchService.Search', () => {
  let api: Api;
  let search: Client<typeof SearchService>;
  let content: Client<typeof ContentService>;
  let redaction: Client<typeof RedactionPolicyService>;
  let owner: pg.Client;
  let blocker: pg.Client;
  let office: string;
  let counter = 0;
  // The picnic item carries marks, so every audience they change the reading of is given its id for a slug (content/redact.ts slugFor).
  let picnic: { itemId: string; versionId: string };

  const find = (query: string, who: Who = ANYONE, page = 0): Promise<SearchResponse> => search.search({ query, page }, who);
  const refusal = async (run: () => Promise<unknown>): Promise<ConnectError> => {
    try {
      await run();
    } catch (error) {
      return ConnectError.from(error);
    }
    throw new Error('expected a refusal');
  };
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
  /** A seeded item, then the ledger's rows and the index rows for it, as the next change to it would write them. */
  const seed = async (options: Parameters<typeof publishItem>[1]): Promise<{ itemId: string; versionId: string }> => {
    const made = await publishItem(api.pool, options);
    await inTx((client) => recordItems(client, [made.itemId]));
    return made;
  };
  /** An item published through the workflow, so the publication writes its ledger rows and its search rows. */
  const publish = async (slug: string, title: string, body: string): Promise<{ itemId: string; versionId: string }> => {
    const item = (await content.createItem({ kind: ContentKind.ARTICLE, officeId: office, slug, title }, PUB)).item!;
    await content.saveDraft({ itemId: item.id, title, bodyMarkup: body }, PUB);
    const hash = (await content.markReady({ itemId: item.id, targets: { website: true, newsletter: false, email: false } }, PUB)).item?.working?.contentHash as Uint8Array;
    await content.approve({ itemId: item.id, contentHash: hash }, TREASURER);
    return { itemId: item.id, versionId: (await content.publish({ itemId: item.id, contentHash: hash }, WEBMASTER)).item?.live?.id as string };
  };
  /** A document item with one PDF per audience given, each stored as the loader stores it. */
  const issue = async (title: string, files: Partial<Record<'public' | 'members', ReadonlyArray<readonly string[]>>>, onBehalfOf?: string, body = ''): Promise<{ itemId: string; versionId: string; files: Record<string, string> }> => {
    const n = ++counter;
    const made = await Promise.all(Object.entries(files).map(async ([audience, pages]) => ({ audience: audience as 'public' | 'members', bytes: await pagesPdf(pages) })));
    const { itemId, versionId } = await publishItem(api.pool, {
      slug: `issue-${n}`,
      kind: 'document',
      officeId: office,
      title,
      body: { blocks: body === '' ? [] : [paragraph(text(body))] },
      ...(onBehalfOf === undefined ? {} : { onBehalfOf }),
      files: made.map((file) => ({ objectKey: `issue-${n}-${file.audience}.pdf`, audience: file.audience, bytes: file.bytes })),
    });
    const ids: Record<string, string> = {};
    for (const file of made) {
      const fileId = (await api.pool.query<{ id: string }>(`SELECT id FROM stored_file WHERE version_id = $1 AND audience = $2`, [versionId, file.audience])).rows[0]!.id;
      await storeOriginal(api.pool, { fileId, bytes: file.bytes, ...STORER });
      ids[file.audience] = fileId;
    }
    return { itemId, versionId, files: ids };
  };
  /** A mark as the API adds one (redaction/marks.ts): the mark and the ledger's rows in one transaction. */
  const mark = (itemId: string, quote: string, category: string): Promise<void> =>
    inTx(async (client) => {
      await client.query(`SELECT redaction_mark_add('content_item', $1, 'body', $2, $3, $4, $5, NULL)`, [itemId, quote, category, STORER.sub, STORER.groups]);
      await recordItems(client, [itemId]);
    });
  /** The worker's job: every queued copy made by the real engine, then its text read and indexed. */
  const work = (): Promise<number> => drain(api.worker, { index: (fileId) => indexFile(api.worker, fileId, { text: reader }) });
  const waiting = async (): Promise<number> =>
    (await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)).rows[0]!.n;
  const until = async (ready: () => Promise<boolean>): Promise<void> => {
    for (let tries = 0; tries < 200; tries++) {
      if (await ready()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('never ready');
  };

  beforeAll(async () => {
    // The rate is lifted for the suite, which searches faster than ten a second; the tests of the limits say so where they need the real ones.
    api = await startApi('nwfl_search', { search: { perSecond: 100_000, burst: 100_000 } });
    search = api.client(SearchService);
    content = api.client(ContentService);
    redaction = api.client(RedactionPolicyService);
    office = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ('publications', 'Publications Officer', 'appointed') RETURNING id`);
    const database = (await api.pool.query<{ db: string }>(`SELECT current_database() AS db`)).rows[0]!.db;
    const superuser = urlFor('postgres', new URL(url as string).password, database);
    owner = new pg.Client({ connectionString: superuser });
    blocker = new pg.Client({ connectionString: superuser });
    await owner.connect();
    await blocker.connect();
  }, 120_000);

  afterAll(async () => {
    await blocker?.end();
    await owner?.end();
    await api?.close();
  });

  describe('news: each audience is given its own index', () => {

    beforeAll(async () => {
      picnic = await publish('search-picnic', 'Spring picnic', `Bring a ${PLAIN} dish to the pavilion. Call Quillon Brask at ${PHONE} or come to ${ADDRESS}. :members[The gate code is ${SECRET}.]`);
      await redaction.addRedactionMark({ subjectKind: MarkSubjectKind.CONTENT_ITEM, subjectId: picnic.itemId, field: MarkField.BODY, quote: PHONE, category: RedactionCategory.MEMBER_PHONE }, OFFICER);
      await redaction.addRedactionMark({ subjectKind: MarkSubjectKind.CONTENT_ITEM, subjectId: picnic.itemId, field: MarkField.BODY, quote: ADDRESS, category: RedactionCategory.MEMBER_ADDRESS }, OFFICER);
      await seed({ slug: 'search-board', officeId: office, title: `Board notes ${BOARD}`, summary: `The ${BOARD} budget.`, visibility: 'officers', body: { blocks: [paragraph(text(`Officers discussed the ${BOARD} at length.`))] } });
      await seed({ slug: 'search-members-night', officeId: office, title: 'Members night', summary: 'An evening of dominoes.', visibility: 'members', body: { blocks: [paragraph(text(`The door code is ${SECRET}. Bring a trombone.`))] } });
    });

    it('finds a plain word for everyone, as a news item with its slug, title, kind, day and a snippet that marks the word', async () => {
      for (const who of [ANYONE, MEMBER, OFFICER]) {
        const response = await find(PLAIN, who);
        expect(response.hasMore).toBe(false);
        expect(response.hits).toHaveLength(1);
        const [hit] = newsItems(response);
        expect(hit).toMatchObject({ slug: picnic.itemId, title: 'Spring picnic', kind: ContentKind.ARTICLE });
        expect(marked(hit!.snippet)).toEqual([PLAIN]);
        expect(hit!.snippet.replaceAll(START, '').replaceAll(STOP, '')).toContain(`Bring a ${PLAIN} dish to the pavilion.`);
        const day = (response.hits[0]!.hit.value as { publishedOn?: { year: number; month: number; day: number } }).publishedOn!;
        expect(day.year).toBeGreaterThanOrEqual(2026);
        expect(day.month).toBeGreaterThanOrEqual(1);
        expect(day.day).toBeGreaterThanOrEqual(1);
      }
    });

    it('gives an item\'s slug where the audience is given it, and the item\'s id where a mark changes what that audience reads', async () => {
      const made = await publish('search-slug', 'Trivia night', 'Trivia at the boathouse. Ask for Marlow Finch.');
      for (const who of [ANYONE, MEMBER, OFFICER]) expect(newsItems(await find('boathouse', who)).map((hit) => hit.slug)).toEqual(['search-slug']);
      // Marked as a phone, which the public is not shown and members are (0012).
      await redaction.addRedactionMark({ subjectKind: MarkSubjectKind.CONTENT_ITEM, subjectId: made.itemId, field: MarkField.BODY, quote: 'Marlow Finch', category: RedactionCategory.MEMBER_PHONE }, OFFICER);
      expect(newsItems(await find('boathouse')).map((hit) => hit.slug)).toEqual([made.itemId]);
      expect(newsItems(await find('boathouse', MEMBER)).map((hit) => hit.slug)).toEqual(['search-slug']);
      expect((await find('Marlow')).hits).toEqual([]);
    });

    it('asks the lens again for the page of hits: an item it hides is in no answer, even with a row in the index and the ledger behind the row', async () => {
      const made = await seed({ slug: 'search-byline', officeId: office, title: 'Garden tour', onBehalfOf: 'Perrin Vale', body: { blocks: [paragraph(text('Tour the arboretum at noon.'))] } });
      expect(newsItems(await find('arboretum')).map((hit) => hit.slug)).toEqual(['search-byline']);
      // A tightening applies at once: the public is no longer given a piece written for a named member.
      await redaction.proposeRedactionChange({ audience: RedactionAudience.PUBLIC, category: RedactionCategory.MEMBER_NAME, action: RedactionAction.HIDE }, OFFICER);
      expect((await owner.query(`SELECT 1 FROM search_item_public WHERE item_id = $1`, [made.itemId])).rowCount).toBe(0);
      expect((await find('arboretum')).hits).toEqual([]);
      await owner.query(`SELECT publication_ledger_record('content_version', $1, 'public', sha256('planted'), '{"v":1}', 0)`, [made.versionId]);
      await owner.query(`INSERT INTO search_item_public (item_id, version_id, rendered_sha256, title, text) VALUES ($1, $2, sha256('planted'), 'Garden tour', 'Tour the arboretum at noon.')`, [made.itemId, made.versionId]);
      const response = await find('arboretum');
      expect(response.hits).toEqual([]);
      expect(response.hasMore).toBe(false);
      // Members are still given it.
      expect(newsItems(await find('arboretum', MEMBER)).map((hit) => hit.slug)).toEqual(['search-byline']);
    });

    it('never gives the public a members-only passage: no hit for its word, and no snippet of another hit holds it', async () => {
      expect((await find(SECRET)).hits).toEqual([]);
      expect((await find(`"gate code"`)).hits).toEqual([]);
      for (const query of [PLAIN, 'picnic', 'pavilion', 'Quillon', 'dominoes', 'members']) {
        const text = said(await find(query));
        for (const canary of [SECRET, 'gate code', 'door code', 'trombone']) expect(text, `${query}: ${canary}`).not.toContain(canary);
      }
      // The positive control: a member finds the word, in both items that hold it, marked in each snippet.
      const members = await find(SECRET, MEMBER);
      expect(new Set(newsItems(members).map((hit) => hit.slug))).toEqual(new Set(['search-members-night', picnic.itemId]));
      expect(members.hits).toHaveLength(2);
      for (const hit of newsItems(members)) expect(marked(hit.snippet)).toEqual([SECRET]);
    });

    it('gives the public a members-only item by its title and summary alone', async () => {
      const [hit] = newsItems(await find('dominoes'));
      expect(hit).toMatchObject({ slug: 'search-members-night', title: 'Members night' });
      expect(hit!.snippet).not.toContain('trombone');
      expect((await find('trombone')).hits).toEqual([]);
      expect(newsItems(await find('trombone', MEMBER)).map((found) => found.slug)).toEqual(['search-members-night']);
    });

    it('never gives the public a redacted passage, whole or in part, and gives members what their lens shows', async () => {
      for (const query of [PHONE, `"${PHONE}"`, '0177', '555-0177', ADDRESS, 'Wobblestone', `"${ADDRESS}"`]) expect((await find(query)).hits, query).toEqual([]);
      for (const query of [PLAIN, 'Quillon', 'pavilion', 'Call', 'picnic']) {
        const text = said(await find(query));
        for (const canary of [PHONE, '0177', ADDRESS, 'Wobblestone']) expect(text, `${query}: ${canary}`).not.toContain(canary);
      }
      // Members are shown phones and not addresses (0012).
      const [phone] = newsItems(await find(`"${PHONE}"`, MEMBER));
      expect(phone?.slug).toBe(picnic.itemId);
      expect(phone!.snippet.replaceAll(START, '').replaceAll(STOP, '')).toContain(PHONE);
      for (const who of [MEMBER, OFFICER]) {
        expect((await find('Wobblestone', who)).hits).toEqual([]);
        for (const query of [PLAIN, 'Quillon', SECRET]) expect(said(await find(query, who)), query).not.toContain('Wobblestone');
      }
    });

    it('gives no one an officers-only item: not the public, not a member, and not an officer, whose search is the members\' own', async () => {
      for (const who of [ANYONE, MEMBER, OFFICER]) {
        for (const query of [BOARD, 'Board notes', 'budget', 'Officers discussed']) {
          const response = await find(query, who);
          expect(response.hits, query).toEqual([]);
          expect(response.hasMore).toBe(false);
        }
      }
    });

    it('still gives no one that item when a row for it sits in an index and the ledger stands behind the row (read rule c)', async () => {
      const board = (await owner.query<{ item_id: string; version_id: string }>(`SELECT i.id AS item_id, i.live_version_id AS version_id FROM content_item i WHERE i.slug = 'search-board'`)).rows[0]!;
      for (const audience of ['public', 'members'] as const) {
        await owner.query(`SELECT publication_ledger_record('content_version', $1, $2, sha256('planted'), '{"v":1}', 0)`, [board.version_id, audience]);
        await owner.query(`INSERT INTO search_item_${audience} (item_id, version_id, rendered_sha256, title, text) VALUES ($1, $2, sha256('planted'), 'Board notes', $3)`, [
          board.item_id,
          board.version_id,
          `Officers discussed the ${BOARD} at length.`,
        ]);
      }
      // The control: the rows are there and match the query.
      expect((await owner.query(`SELECT 1 FROM search_item_public WHERE tsv @@ websearch_to_tsquery('english', $1)`, [BOARD])).rowCount).toBe(1);
      for (const who of [ANYONE, MEMBER, OFFICER]) expect((await find(BOARD, who)).hits).toEqual([]);
    });

    it('returns a row only while the ledger\'s current output is the row\'s own (read rule b)', async () => {
      const made = await publish('search-ledger', 'Kite day', 'Fly a kite at the marina on Sunday.');
      expect(newsItems(await find('marina')).map((hit) => hit.slug)).toEqual(['search-ledger']);
      // The row is left as it was while the ledger moves on: what a missed put would leave.
      await owner.query(`SELECT publication_ledger_record('content_version', $1, 'public', sha256('moved on'), '{"v":1}', 0)`, [made.versionId]);
      expect((await owner.query(`SELECT 1 FROM search_item_public WHERE item_id = $1`, [made.itemId])).rowCount).toBe(1);
      expect((await find('marina')).hits).toEqual([]);
      // Members' ledger row did not move: their hit stands.
      expect(newsItems(await find('marina', MEMBER)).map((hit) => hit.slug)).toEqual(['search-ledger']);
    });

    it('drops an item from search when it is withdrawn, and a row left behind for it is not returned', async () => {
      const made = await publish('search-withdrawn', 'Chess evening', 'Chess at the gazebo on Friday.');
      const kept = (await owner.query<{ version_id: string; rendered_sha256: Buffer; title: string; text: string }>(`SELECT version_id, rendered_sha256, title, text FROM search_item_public WHERE item_id = $1`, [made.itemId])).rows[0]!;
      expect(newsItems(await find('gazebo')).map((hit) => hit.slug)).toEqual(['search-withdrawn']);
      await content.withdraw({ itemId: made.itemId }, WEBMASTER);
      expect((await find('gazebo')).hits).toEqual([]);
      // The old row put back, with the sha the ledger now holds for the stub: only the item's state stands in the way.
      await owner.query(
        `INSERT INTO search_item_public (item_id, version_id, rendered_sha256, title, text)
         SELECT $1, $2, l.output_sha256, $3, $4 FROM publication_ledger l
          WHERE l.subject_kind = 'content_version' AND l.subject_id = $2 AND l.audience = 'public' AND l.current_to IS NULL`,
        [made.itemId, kept.version_id, kept.title, kept.text],
      );
      expect((await owner.query(`SELECT 1 FROM search_item_public WHERE item_id = $1`, [made.itemId])).rowCount).toBe(1);
      expect((await find('gazebo')).hits).toEqual([]);
    });

    it('gives a person with no member standing the public index, whatever their token says', async () => {
      for (const who of [as('joiner-token'), as('lone-admin-token')]) {
        expect((await find(SECRET, who)).hits).toEqual([]);
        expect(newsItems(await find(PLAIN, who)).map((hit) => hit.slug)).toEqual([picnic.itemId]);
      }
    });

    it('refuses a machine client and a token it cannot verify, and never reads either as the public', async () => {
      for (const who of [as('agent-token'), as('verifier-token'), as('linkcheck-token')]) expect((await refusal(() => find(PLAIN, who))).code).toBe(Code.PermissionDenied);
      expect((await refusal(() => find(PLAIN, { headers: { authorization: 'Bearer nobody' } }))).code).toBe(Code.Unauthenticated);
    });

    it('takes no audience from the request: a header that names one changes nothing', async () => {
      const spoofed = { headers: { 'x-audience': 'members', audience: 'officers', 'x-nwfl-audience': 'members' } };
      expect((await find(SECRET, spoofed)).hits).toEqual([]);
    });

    it('marks only the words found: marker characters already in the text are not carried into a snippet', async () => {
      const made = await publish('search-markers', 'Lantern walk', 'Meet at the bandstand for the lantern walk.');
      for (const table of ['search_item_public', 'search_item_members']) {
        await owner.query(`UPDATE ${table} SET text = $2 WHERE item_id = $1`, [made.itemId, `${START}Meet${STOP} at the bandstand ${START}for the lantern walk.`]);
      }
      for (const who of [ANYONE, MEMBER]) {
        const [hit] = newsItems(await find('bandstand', who));
        expect(marked(hit!.snippet)).toEqual(['bandstand']);
        expect(hit!.snippet.split(START)).toHaveLength(2);
        expect(hit!.snippet.split(STOP)).toHaveLength(2);
      }
    });
  });

  describe('issues: a page of the copy the audience is served', () => {
    let both: { itemId: string; versionId: string; files: Record<string, string> };
    let inner: { itemId: string; versionId: string; files: Record<string, string> };

    beforeAll(async () => {
      both = await issue('Synthetic issue, March', {
        public: [
          ['Picnic at Ferry Park', `Rides: call ${PDF_PHONE} for a seat.`],
          [`Send dues to ${PDF_ADDRESS} by June.`, 'Game night is Tuesday at the library'],
        ],
        members: [
          ['Picnic at Ferry Park', `Rides: call ${PDF_PHONE} for a seat.`, 'Members: the hayride leaves at dusk'],
          [`Send dues to ${PDF_ADDRESS} by June.`, 'Game night is Tuesday at the library'],
        ],
        // The item's own text holds each passage a mark names, as an issue's does: a mark whose passage is in no text of the
        // version shown hides the item (the lens fails closed).
      }, undefined, `Contacts: ${PDF_PHONE}, ${PDF_ADDRESS}. Meet at Ferry Park.`);
      await mark(both.itemId, PDF_PHONE, 'member_phone');
      await mark(both.itemId, PDF_ADDRESS, 'member_address');
      inner = await issue('Synthetic issue, members', { members: [[`The treasurer reports a surplus of ${MARMALADE}`]] });
      expect(await work()).toBe(3);
    }, 180_000);

    it('gives the public a page of the public copy: the file, the issue\'s title, the page and a snippet that marks the word', async () => {
      const response = await find('library');
      expect(issuePages(response)).toHaveLength(1);
      const [hit] = issuePages(response);
      expect(hit).toMatchObject({ fileId: both.files['public'], issueLabel: 'Synthetic issue, March', page: 2 });
      expect(marked(hit!.snippet)).toEqual(['library']);
      expect(hit!.snippet.replaceAll(START, '').replaceAll(STOP, '')).toContain('Game night is Tuesday at the library');
    });

    it('gives members and officers the members copy only: one hit an issue page, never the public file as well', async () => {
      for (const who of [MEMBER, OFFICER]) {
        const pages = issuePages(await find('library', who));
        expect(pages.map((hit) => [hit.fileId, hit.page])).toEqual([[both.files['members'], 2]]);
      }
      // A line only the members' file holds.
      expect((await find('hayride')).hits).toEqual([]);
      expect(issuePages(await find('hayride', MEMBER)).map((hit) => [hit.fileId, hit.page])).toEqual([[both.files['members'], 1]]);
    });

    it('never gives the public a passage redacted from its copy, and gives members what their copy shows', async () => {
      for (const query of [PDF_PHONE, `"${PDF_PHONE}"`, '0142', PDF_ADDRESS, 'Orchard', `"${PDF_ADDRESS}"`]) expect((await find(query)).hits, query).toEqual([]);
      for (const query of ['picnic', 'Rides', 'dues', 'June', 'seat']) {
        const text = said(await find(query));
        for (const canary of [PDF_PHONE, '0142', PDF_ADDRESS, 'Orchard']) expect(text, `${query}: ${canary}`).not.toContain(canary);
      }
      // The control: the public does find the line the phone was on.
      expect(issuePages(await find('Rides')).map((hit) => [hit.fileId, hit.page])).toEqual([[both.files['public'], 1]]);
      // Members are shown the phone and not the address; officers search the members' index, so neither are they.
      const [phone] = issuePages(await find(`"${PDF_PHONE}"`, MEMBER));
      expect([phone?.fileId, phone?.page]).toEqual([both.files['members'], 1]);
      for (const who of [MEMBER, OFFICER]) {
        expect((await find('Orchard', who)).hits).toEqual([]);
        for (const query of ['dues', 'June']) expect(said(await find(query, who)), query).not.toContain('Orchard');
      }
    });

    it('never gives the public a word of a members\' file, in a hit or in the number of hits', async () => {
      const response = await find(MARMALADE);
      expect(response.hits).toEqual([]);
      expect(response.hasMore).toBe(false);
      expect((await find('treasurer surplus')).hits).toEqual([]);
      expect(issuePages(await find(MARMALADE, MEMBER)).map((hit) => [hit.fileId, hit.issueLabel, hit.page])).toEqual([[inner.files['members'], 'Synthetic issue, members', 1]]);
    });

    it('does not give the public a members\' page even when its text sits in the public table (the ledger says the public is served no copy of it)', async () => {
      await owner.query(
        `INSERT INTO search_page_public (file_id, item_id, page, served_sha256, text_version, text, extra)
         SELECT file_id, item_id, page, served_sha256, text_version, text, extra FROM search_page_members WHERE file_id = $1`,
        [inner.files['members']],
      );
      try {
        expect((await owner.query(`SELECT 1 FROM search_page_public WHERE tsv @@ websearch_to_tsquery('english', $1)`, [MARMALADE])).rowCount).toBe(1);
        expect((await find(MARMALADE)).hits).toEqual([]);
      } finally {
        await owner.query(`DELETE FROM search_page_public WHERE file_id = $1`, [inner.files['members']]);
      }
    });

    it('returns a page only while the ledger says that audience is served the very copy the page was read from (read rule b)', async () => {
      const kept = (await owner.query<{ served_sha256: Buffer }>(`SELECT served_sha256 FROM search_page_public WHERE file_id = $1 AND page = 2`, [both.files['public']])).rows[0]!;
      await owner.query(`UPDATE search_page_public SET served_sha256 = sha256('an older copy') WHERE file_id = $1`, [both.files['public']]);
      try {
        expect((await find('library')).hits).toEqual([]);
        expect((await find('picnic')).hits.filter((hit) => hit.hit.case === 'issuePage')).toEqual([]);
        // Members' rows are their own: untouched.
        expect(issuePages(await find('library', MEMBER))).toHaveLength(1);
      } finally {
        await owner.query(`UPDATE search_page_public SET served_sha256 = $2 WHERE file_id = $1`, [both.files['public'], kept.served_sha256]);
      }
      expect(issuePages(await find('library'))).toHaveLength(1);
    });

    it('gives an audience that is served the original no issue text, even from rows that name the original\'s sha', async () => {
      const made = await issue('Synthetic issue, original', { public: [['The quiz bowl is in the rotunda']] });
      expect(await work()).toBe(1);
      const fileId = made.files['public']!;
      expect(issuePages(await find('rotunda', MEMBER)).map((hit) => hit.fileId)).toEqual([fileId]);
      // The ledger now says members are served the original of this file, as under a policy that shows them everything.
      const original = (await owner.query<{ sha256: Buffer }>(`SELECT sha256 FROM stored_file WHERE id = $1`, [fileId])).rows[0]!.sha256;
      await owner.query(`SELECT publication_ledger_record('stored_file', $1, 'members', $2, '{"v":1,"served":"original"}', 0)`, [fileId, original]);
      await owner.query(`UPDATE search_page_members SET served_sha256 = $2 WHERE file_id = $1`, [fileId, original]);
      expect((await owner.query(`SELECT 1 FROM search_page_members WHERE file_id = $1`, [fileId])).rowCount).toBe(1);
      expect((await find('rotunda', MEMBER)).hits).toEqual([]);
      expect((await find('rotunda', OFFICER)).hits).toEqual([]);
      // The public is still served its copy.
      expect(issuePages(await find('rotunda')).map((hit) => hit.fileId)).toEqual([fileId]);
    });

    it('has no hit for a passage from the moment it is marked, before the worker runs, and none for the old text after', async () => {
      expect(issuePages(await find('Ferry'))).toHaveLength(1);
      await mark(both.itemId, 'Ferry Park', 'member_address');
      for (const who of [ANYONE, MEMBER, OFFICER]) {
        expect((await find('Ferry', who)).hits).toEqual([]);
        expect((await find('library', who)).hits.filter((hit) => hit.hit.case === 'issuePage')).toEqual([]);
      }
      expect(await work()).toBe(2);
      for (const who of [ANYONE, MEMBER, OFFICER]) {
        expect((await find('Ferry', who)).hits).toEqual([]);
        expect(issuePages(await find('library', who))).toHaveLength(1);
        expect(said(await find('picnic', who))).not.toContain('Ferry');
      }
    });

    it('drops an issue\'s pages when the issue is taken down, though its rows and its ledger row stand (read rule c)', async () => {
      expect(issuePages(await find(MARMALADE, MEMBER))).toHaveLength(1);
      const columns = 'file_id, item_id, page, served_sha256, text_version, text, extra';
      const kept = (await owner.query<Record<string, unknown>>(`SELECT ${columns} FROM search_page_members WHERE file_id = $1`, [inner.files['members']])).rows;
      await content.withdraw({ itemId: inner.itemId }, WEBMASTER);
      // Merged rule (S1, 0032 search_page_unservable): the withdrawal itself drops the rows. They are put back as a put that
      // raced the withdrawal would leave them, so the read's own rule c is what is tested here.
      expect((await owner.query(`SELECT 1 FROM search_page_members WHERE file_id = $1`, [inner.files['members']])).rowCount).toBe(0);
      for (const row of kept) await owner.query(`INSERT INTO search_page_members (${columns}) VALUES ($1, $2, $3, $4, $5, $6, $7)`, Object.values(row));
      expect((await owner.query(`SELECT 1 FROM search_page_members WHERE file_id = $1`, [inner.files['members']])).rowCount).toBe(1);
      for (const who of [ANYONE, MEMBER, OFFICER]) expect((await find(MARMALADE, who)).hits).toEqual([]);
      // The ledger's row for the file did not move: the item's state alone stands in the way.
      const ledger = await owner.query(
        `SELECT 1 FROM search_page_members p JOIN publication_ledger l ON l.subject_kind = 'stored_file' AND l.subject_id = p.file_id AND l.audience = 'members' AND l.current_to IS NULL
            AND l.output_sha256 = p.served_sha256 AND l.inputs ->> 'served' = 'copy' WHERE p.file_id = $1`,
        [inner.files['members']],
      );
      expect(ledger.rowCount).toBe(1);
    });

    it('gives no one the pages of an officers-only item\'s file, though rows for it sit in the members table with the ledger behind them', async () => {
      const bytes = await pagesPdf([['The audit committee met in the conservatory']]);
      const { versionId } = await publishItem(api.pool, { slug: 'issue-officers', kind: 'document', officeId: office, title: 'Audit papers', visibility: 'officers', body: { blocks: [] }, files: [{ objectKey: 'issue-officers.pdf', audience: 'members', bytes }] });
      const fileId = (await api.pool.query<{ id: string }>(`SELECT id FROM stored_file WHERE version_id = $1`, [versionId])).rows[0]!.id;
      await owner.query(`SELECT publication_ledger_record('stored_file', $1, 'members', sha256('planted'), '{"v":1,"served":"copy"}', 0)`, [fileId]);
      await owner.query(`INSERT INTO search_page_members (file_id, page, served_sha256, text_version, text, extra) VALUES ($1, 1, sha256('planted'), 1, 'The audit committee met in the conservatory', '')`, [fileId]);
      for (const who of [ANYONE, MEMBER, OFFICER]) expect((await find('conservatory', who)).hits).toEqual([]);
    });

    it('gives the public nothing of an issue its policy hides, not a hit and not a next page, though the public has a copy of the file and the ledger behind it', async () => {
      // The news tests tightened the public's cell: a piece written for a named member is hidden from the public.
      expect((await owner.query<{ action: string }>(`SELECT action FROM redaction_policy WHERE audience = 'public' AND category = 'member_name'`)).rows.map((row) => row.action)).toEqual(['hide']);
      const made = await issue('Synthetic issue, guest', { public: Array.from({ length: 12 }, (_unused, n) => [`The zucchini census, part ${n + 1}`]) }, 'Perrin Vale');
      expect(await work()).toBe(1);
      // Merged rule (S1 fix 2, B1: the page writer refuses a file servableFile refuses): no page of it is put. The file's rule
      // (pdf/store.ts) knows nothing of the byline, so the ledger says the public is served a copy; the twelve pages are planted
      // under that copy's sha, as a put that slipped through would leave them, so the read's own refusal is what is tested.
      expect((await owner.query(`SELECT 1 FROM search_page_public WHERE file_id = $1`, [made.files['public']])).rowCount).toBe(0);
      const copy = await owner.query<{ output: Buffer }>(
        `SELECT output_sha256 AS output FROM publication_ledger WHERE subject_kind = 'stored_file' AND subject_id = $1 AND audience = 'public' AND current_to IS NULL AND inputs ->> 'served' = 'copy'`,
        [made.files['public']],
      );
      for (let n = 1; n <= 12; n++) {
        await owner.query(`INSERT INTO search_page_public (file_id, item_id, page, served_sha256, text_version, text, extra) VALUES ($1, $2, $3, $4, 1, $5, '')`, [
          made.files['public'], made.itemId, n, copy.rows[0]!.output, `The zucchini census, part ${n}`,
        ]);
      }
      const held = await owner.query(
        `SELECT 1 FROM search_page_public p JOIN publication_ledger l ON l.subject_kind = 'stored_file' AND l.subject_id = p.file_id AND l.audience = 'public' AND l.current_to IS NULL AND l.output_sha256 = p.served_sha256
          WHERE p.file_id = $1`,
        [made.files['public']],
      );
      expect(held.rowCount).toBe(12);
      // The read of the file is refused for the public (content/files.ts), and so is every page of it here: twelve hidden
      // pages are no hits and no next page, on any page asked for.
      for (const page of [1, 2]) {
        const response = await find('zucchini', ANYONE, page);
        expect(response.hits).toEqual([]);
        expect(response.hasMore).toBe(false);
      }
      const members = await find('zucchini', MEMBER);
      expect(issuePages(members)).toHaveLength(10);
      expect(members.hasMore).toBe(true);
      expect(issuePages(await find('zucchini', MEMBER, 2))).toHaveLength(2);
      // A hit the public is given, ranked below the hidden ones, is on its first page: the hidden pages take no places.
      await publish('search-census', 'Census notes', 'A zucchini was counted.');
      const open = await find('zucchini');
      expect(newsItems(open).map((hit) => hit.slug)).toEqual(['search-census']);
      expect(open.hits).toHaveLength(1);
      expect(open.hasMore).toBe(false);
    });

    it('labels a published edition\'s own PDF by the edition, and gives nothing of an edition not yet published', async () => {
      // Fixture made through the real store and worker since the merge round: the read now also asks whether the copy the
      // public is served now is the one the ledger's row names (P1d), which a planted ledger row with no original cannot say.
      const edition = async (slug: string, title: string, status: string, word: string): Promise<string> => {
        const bytes = await pagesPdf([['Cover of the issue'], ['Contents of the issue'], [`The ${word} trophy goes to the trivia team`]]);
        const id = await insertId(api.pool, `INSERT INTO edition (slug, title, kind, period_start, period_end, status) VALUES ($1, $2, 'regular', $3, $4, $5) RETURNING id`, [slug, title, `${slug}-01`, `${slug}-28`, status]);
        const fileId = (
          await owner.query<{ id: string }>(
            `INSERT INTO stored_file (edition_id, object_key, filename, mime_type, size_bytes, sha256, audience) VALUES ($1, $2, $2, 'application/pdf', $3, $4, 'public') RETURNING id`,
            [id, `${slug}.pdf`, bytes.length, createHash('sha256').update(bytes).digest()],
          )
        ).rows[0]!.id;
        await storeOriginal(api.pool, { fileId, bytes, ...STORER });
        return fileId;
      };
      const out = await edition('2026-02', 'Pensa Mensa, February 2026', 'published', 'gyroscope');
      const proof = await edition('2026-03', 'Pensa Mensa, March 2026', 'proof', 'theodolite');
      expect(await work()).toBe(2);
      // The proof's copy is made and recorded, but none of its pages is put (read rule c on the write side). A row planted for
      // it under the ledger's current output is not returned either.
      const ledger = await owner.query<{ output: Buffer }>(
        `SELECT output_sha256 AS output FROM publication_ledger WHERE subject_kind = 'stored_file' AND subject_id = $1 AND audience = 'public' AND current_to IS NULL AND inputs ->> 'served' = 'copy'`,
        [proof],
      );
      expect(ledger.rows).toHaveLength(1);
      await owner.query(`INSERT INTO search_page_public (file_id, page, served_sha256, text_version, text, extra) VALUES ($1, 3, $2, 1, 'The theodolite trophy goes to the trivia team', '')`, [proof, ledger.rows[0]!.output]);
      expect(issuePages(await find('gyroscope')).map((hit) => [hit.fileId, hit.issueLabel, hit.page])).toEqual([[out, 'Pensa Mensa, February 2026', 3]]);
      expect((await find('theodolite')).hits).toEqual([]);
      expect(issuePages(await find('trophy'))).toHaveLength(1);
    });
  });

  describe('what a query may be', () => {
    it('refuses a query that is too short, too long or too many words, INVALID_ARGUMENT, without repeating it', async () => {
      for (const query of ['', ' ', 'a', 'x'.repeat(101), 'a b c d e f g h i', 'pic\u0000nic']) {
        const error = await refusal(() => find(query));
        expect(error.code, JSON.stringify(query)).toBe(Code.InvalidArgument);
      }
      const canary = 'zzcanaryzz';
      expect((await refusal(() => find(`${canary} `.repeat(9)))).message).not.toContain(canary);
    });

    it('refuses a huge query, and goes on answering', async () => {
      expect((await refusal(() => find('x'.repeat(200_000)))).code).toBe(Code.InvalidArgument);
      // Over the server's own receive limit: refused before the handler.
      expect([Code.ResourceExhausted, Code.InvalidArgument]).toContain((await refusal(() => find('x'.repeat(2_000_000)))).code);
      expect(newsItems(await find(PLAIN))).toHaveLength(1);
    });

    it('treats the query as words, never as SQL: an injection finds nothing, breaks nothing and crosses no audience', async () => {
      const attacks = [
        `'; DROP TABLE search_item_public; --`,
        `' OR '1'='1`,
        `") OR 1=1 --`,
        `x' UNION SELECT text FROM search_item_members --`,
        `$1; SELECT pg_sleep(10)`,
        `\\'; DELETE FROM search_page_public; --`,
        `${PLAIN}' OR tsv @@ '${SECRET}`,
        `E'\\x27' || (SELECT 1)`,
        `%%`,
        `__`,
        `%${SECRET.slice(0, 4)}%`,
        `&|!():*<->`,
        `((((((((`,
        `"""""""`,
        `'''`,
        `<script>alert(1)</script>`,
        `\\\\`,
        `a:* b:*`,
      ];
      for (const query of attacks) {
        const response = await find(query);
        expect(said(response), query).not.toContain(SECRET);
        expect(said(response), query).not.toContain('0177');
      }
      const tables = await owner.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE tablename LIKE 'search\\_%' ORDER BY 1`);
      expect(tables.rows.map((row) => row.tablename)).toEqual(['search_item_members', 'search_item_public', 'search_page_members', 'search_page_public']);
      expect(newsItems(await find(PLAIN))).toHaveLength(1);
      expect(newsItems(await find(SECRET, MEMBER)).length).toBeGreaterThan(0);
    });

    it('has no wildcard: a prefix, a percent sign or a star matches no more than the word typed', async () => {
      for (const who of [ANYONE, MEMBER]) {
        for (const query of [`${SECRET.slice(0, 5)}:*`, `${SECRET.slice(0, 5)}*`, `${SECRET.slice(0, 5)}%`, `%${SECRET.slice(2)}`, `${PLAIN.slice(0, 4)}_____`, '**', '%%', '??', '..']) {
          expect((await find(query, who)).hits, query).toEqual([]);
        }
      }
    });

    it('finds nothing for a query that only leaves words out, or holds only words too common to index, rather than everything', async () => {
      for (const who of [ANYONE, MEMBER]) {
        for (const query of ['-zzzzqq', '-zzzzqq -yyyyqq', 'the of and', 'the', '-the', `-${PLAIN} or -zzzzqq`]) {
          const response = await find(query, who);
          expect(response.hits, query).toEqual([]);
          expect(response.hasMore, query).toBe(false);
        }
      }
      // A word left out does narrow a search that has a word to find.
      expect(newsItems(await find(`picnic -${PLAIN}`))).toEqual([]);
      expect(newsItems(await find('picnic -zzzzqq')).map((hit) => hit.slug)).toEqual([picnic.itemId]);
      // A phrase, and either of two words.
      expect(newsItems(await find(`"${PLAIN} dish"`)).map((hit) => hit.slug)).toEqual([picnic.itemId]);
      expect(newsItems(await find(`"dish ${PLAIN}"`))).toEqual([]);
      expect(newsItems(await find(`zzzzqq or ${PLAIN}`)).map((hit) => hit.slug)).toEqual([picnic.itemId]);
    });

    it('answers a query nothing matches with no hits and no next page', async () => {
      const response = await find('zzzzqq nothingmatchesthis');
      expect(response.hits).toEqual([]);
      expect(response.hasMore).toBe(false);
    });
  });

  describe('pages of ten', () => {
    const titles = (response: SearchResponse): string[] => newsItems(response).map((hit) => hit.title);

    beforeAll(async () => {
      const ids: string[] = [];
      // 25 public items for one word; 105 for another, 5 of them given to members only by a passage.
      for (let n = 1; n <= 25; n++) {
        const made = await publishItem(api.pool, { slug: `quorum-${n}`, officeId: office, title: `Quorum ${String(n).padStart(3, '0')}`, body: { blocks: [paragraph(text('The quorum was met.'))] }, approvedAt: `2026-0${1 + (n % 9)}-${String(1 + (n % 27)).padStart(2, '0')}T12:00:00Z` });
        ids.push(made.itemId);
      }
      for (let n = 1; n <= 105; n++) {
        const made = await publishItem(api.pool, { slug: `plenum-${n}`, officeId: office, title: `Plenum ${String(n).padStart(3, '0')}`, body: { blocks: [paragraph(text('A plenum of the chapter.'))] }, approvedAt: `2025-01-01T00:${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}Z` });
        ids.push(made.itemId);
      }
      await inTx((client) => recordItems(client, ids));
    }, 180_000);

    it('gives ten a page, says whether more follow, never repeats a hit and stops at the last', async () => {
      const pages = [await find('quorum', ANYONE, 1), await find('quorum', ANYONE, 2), await find('quorum', ANYONE, 3), await find('quorum', ANYONE, 4)];
      expect(pages.map((page) => [page.hits.length, page.hasMore])).toEqual([
        [10, true],
        [10, true],
        [5, false],
        [0, false],
      ]);
      const keys = pages.flatMap((page) => page.hits.map(keyOf));
      expect(new Set(keys).size).toBe(25);
      // Page 0 is page 1.
      expect((await find('quorum')).hits.map(keyOf)).toEqual(pages[0]!.hits.map(keyOf));
      // The same search twice gives the same order.
      expect((await find('quorum', ANYONE, 2)).hits.map(keyOf)).toEqual(pages[1]!.hits.map(keyOf));
    });

    it('puts the newest first among hits that match as well as each other', async () => {
      const pages = [await find('plenum', ANYONE, 1), await find('plenum', ANYONE, 2)];
      expect(titles(pages[0]!)).toEqual(Array.from({ length: 10 }, (_unused, n) => `Plenum ${String(105 - n).padStart(3, '0')}`));
      expect(titles(pages[1]!)).toEqual(Array.from({ length: 10 }, (_unused, n) => `Plenum ${String(95 - n).padStart(3, '0')}`));
    });

    it('stops at page ten: it is full, says no more follow, and page eleven is refused', async () => {
      const last = await find('plenum', ANYONE, 10);
      expect(last.hits).toHaveLength(10);
      expect(last.hasMore).toBe(false);
      expect((await find('plenum', ANYONE, 9)).hasMore).toBe(true);
      for (const page of [11, 100, -1, 2_147_483_647]) expect((await refusal(() => find('plenum', ANYONE, page))).code, String(page)).toBe(Code.InvalidArgument);
    });

    it('exactly ten hits are one full page with no next', async () => {
      const ids: string[] = [];
      for (let n = 1; n <= 10; n++) ids.push((await publishItem(api.pool, { slug: `decade-${n}`, officeId: office, title: `Decade ${n}`, body: { blocks: [paragraph(text('A decennial gathering.'))] } })).itemId);
      await inTx((client) => recordItems(client, ids));
      const first = await find('decennial');
      expect([first.hits.length, first.hasMore]).toEqual([10, false]);
      expect((await find('decennial', ANYONE, 2)).hits).toEqual([]);
    });
  });

  describe('the limits and the log', () => {
    it('logs a search by its audience and its sizes, and the query appears in no log line at all', async () => {
      const canary = 'logcanaryword';
      api.logs.length = 0;
      await find(`${canary} ${PLAIN}`, MEMBER);
      await find(`${canary} or ${PLAIN}`);
      await refusal(() => find(`${canary} `.repeat(9)));
      const lines = api.logs.filter((line) => line['msg'] === 'search');
      expect(lines).toHaveLength(2);
      const [member, open] = lines as [Record<string, unknown>, Record<string, unknown>];
      expect(member).toMatchObject({ component: 'search', audience: 'members', query_chars: canary.length + 1 + PLAIN.length, words: 2, hits: 0 });
      expect(open).toMatchObject({ component: 'search', audience: 'public', query_chars: canary.length + 4 + PLAIN.length, words: 3, hits: 1 });
      expect(typeof open['ms']).toBe('number');
      const all = JSON.stringify(api.logs);
      expect(all).not.toContain(canary);
      expect(all).not.toContain(PLAIN);
      // An officer is logged as an officer, though the index read is the members'.
      api.logs.length = 0;
      await find(PLAIN, OFFICER);
      expect(api.logs.find((line) => line['component'] === 'search')).toMatchObject({ audience: 'officers', hits: 1 });
    });

    it('answers four searches at once and refuses a fifth, RESOURCE_EXHAUSTED; a search that runs over two seconds ends, DEADLINE_EXCEEDED, and leaves the API answering', async () => {
      const canary = 'slowcanaryword';
      api.logs.length = 0;
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE search_item_public IN ACCESS EXCLUSIVE MODE');
      const started = performance.now();
      let outcomes: Array<ConnectError | SearchResponse>;
      try {
        const held = [1, 2, 3, 4].map(() => find(canary).catch((error: unknown) => ConnectError.from(error)));
        await until(async () => (await waiting()) === 4);
        const fifth = await refusal(() => find(canary));
        expect(fifth.code).toBe(Code.ResourceExhausted);
        expect(fifth.message).not.toContain(canary);
        outcomes = await Promise.all(held);
      } finally {
        await blocker.query('ROLLBACK');
      }
      const elapsed = performance.now() - started;
      expect(outcomes.map((outcome) => (outcome instanceof ConnectError ? outcome.code : 'ok'))).toEqual([Code.DeadlineExceeded, Code.DeadlineExceeded, Code.DeadlineExceeded, Code.DeadlineExceeded]);
      expect(elapsed).toBeGreaterThan(1_900);
      expect(elapsed).toBeLessThan(8_000);
      for (const outcome of outcomes) expect((outcome as ConnectError).message).not.toContain(canary);
      expect(JSON.stringify(api.logs)).not.toContain(canary);
      expect(api.logs.filter((line) => line['component'] === 'search' && line['level'] === 'warn')).toHaveLength(4);
      // The four places are free again, and the connections went back to the pool whole.
      const after = await Promise.all([1, 2, 3, 4].map(() => find(PLAIN)));
      for (const response of after) expect(newsItems(response)).toHaveLength(1);
    }, 30_000);

    it('holds the production rate: a burst of twenty, then RESOURCE_EXHAUSTED', async () => {
      const strict = await startApi('nwfl_searchrate');
      try {
        const client = strict.client(SearchService);
        const outcomes: string[] = [];
        const started = performance.now();
        // One at a time, so the four-at-once limit is not what refuses.
        for (let n = 0; n < 60; n++) {
          outcomes.push(await client.search({ query: 'anything' }).then(() => 'ok', (error: unknown) => Code[ConnectError.from(error).code]));
        }
        const elapsed = performance.now() - started;
        const ok = outcomes.filter((outcome) => outcome === 'ok').length;
        expect(outcomes.slice(0, 20)).toEqual(Array.from({ length: 20 }, () => 'ok'));
        expect(outcomes.filter((outcome) => outcome !== 'ok' && outcome !== 'ResourceExhausted')).toEqual([]);
        // Twenty, and what ten a second refilled while the sixty ran: on any box that runs them in under
        // three and a half seconds, some were refused.
        expect(ok).toBeLessThanOrEqual(20 + Math.ceil(elapsed / 100) + 1);
      } finally {
        await strict.close();
      }
    }, 120_000);
  });
});
