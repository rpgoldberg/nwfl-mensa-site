// ARCHIVE-SEARCH S3: the read side keeps an item that is not served out of every audience's results BY ITSELF,
// whatever the index holds. The write side (S1, S2) keeps such items out of the index; these tests put them in,
// with the ledger standing behind each row, so that only the read's own conditions are left to refuse them:
// officers-only, draft, ready (approved or not, never published) and withdrawn, as a news row and as a page of a
// PDF, for the public, a member and an officer. The control is a published item planted the same way, which is found.
//
// Real gRPC, real Postgres. Every person is made up.
import { ConnectError, type Client } from '@connectrpc/connect';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContentKind, ContentService } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { type SearchResponse, SearchService } from '../../src/gen/nwfl/mensa/v1/search_pb.js';
import { recordItems } from '../../src/ledger/ledger.js';
import { textReply } from '../../src/pdf/gate-text.js';
import { drain } from '../../src/pdf/regenerate.js';
import { storeOriginal } from '../../src/pdf/store.js';
import { indexFile } from '../../src/search/pages.js';
import { searchSql } from '../../src/search/sql.js';
import { type Api, MEMBER, OFFICER, as, insertId, startApi } from '../helpers/api.js';
import { paragraph, publishItem, text } from '../helpers/content.js';
import { live, url, urlFor } from '../helpers/pg.js';
import { pagesPdf } from './synthetic.js';

const PUB = as('pub-token');
const WEBMASTER = as('webmaster-token');
const TREASURER = as('treasurer-token');
const AUDIENCES: Array<[string, { headers?: Record<string, string> }]> = [
  ['the public', {}],
  ['a member', MEMBER],
  ['an officer', OFFICER],
];
/** One word an item, in its news row and on its PDF page. */
const WORDS = { published: 'quokkaword', officers: 'narwhalword', draft: 'ocelotword', ready: 'tapirword', approved: 'axolotlword', withdrawn: 'pangolinword', redraft: 'wombatword' };

describe.skipIf(!live)('SearchService.Search: items that are not served', () => {
  let api: Api;
  let search: Client<typeof SearchService>;
  let content: Client<typeof ContentService>;
  let owner: pg.Client;
  let office: string;
  const planted: Record<string, { itemId: string; versionId: string; fileId: string }> = {};

  const find = (query: string, who: { headers?: Record<string, string> }): Promise<SearchResponse> => search.search({ query }, who);
  /** A row in both news tables and a page in both page tables for the version, each with the ledger's current row behind it. */
  /** A PDF's row on a version, attached before the version is marked ready: an approved version's files are frozen (0011). */
  const attach = async (name: keyof typeof WORDS, versionId: string): Promise<void> => {
    await owner.query(
      `INSERT INTO stored_file (version_id, object_key, filename, mime_type, size_bytes, sha256, audience) VALUES ($1, $2, $2, 'application/pdf', 10, sha256(convert_to($2, 'UTF8')), 'public')`,
      [versionId, `planted-${name}.pdf`],
    );
  };
  const plant = async (name: keyof typeof WORDS, itemId: string, versionId: string): Promise<void> => {
    const word = WORDS[name];
    const fileId = (await owner.query<{ id: string }>(`SELECT id FROM stored_file WHERE version_id = $1`, [versionId])).rows[0]!.id;
    for (const audience of ['public', 'members'] as const) {
      await owner.query(`SELECT publication_ledger_record('content_version', $1, $2, sha256('planted item'), '{"v":1}', 0)`, [versionId, audience]);
      await owner.query(`DELETE FROM search_item_${audience} WHERE item_id = $1`, [itemId]);
      await owner.query(`INSERT INTO search_item_${audience} (item_id, version_id, rendered_sha256, title, text) VALUES ($1, $2, sha256('planted item'), $3, $4)`, [itemId, versionId, `Notes ${word}`, `The ${word} was discussed.`]);
      await owner.query(`SELECT publication_ledger_record('stored_file', $1, $2, sha256('planted copy'), '{"v":1,"served":"copy"}', 0)`, [fileId, audience]);
      await owner.query(`INSERT INTO search_page_${audience} (file_id, item_id, page, served_sha256, text_version, text, extra) VALUES ($1, $2, 1, sha256('planted copy'), 1, $3, '')`, [fileId, itemId, `Page one: the ${word} again.`]);
    }
    planted[name] = { itemId, versionId, fileId };
  };
  const working = async (itemId: string): Promise<string> => (await owner.query<{ id: string }>(`SELECT working_version_id AS id FROM content_item WHERE id = $1`, [itemId])).rows[0]!.id;
  const drafted = async (name: keyof typeof WORDS, title: string): Promise<string> => {
    const item = (await content.createItem({ kind: ContentKind.ARTICLE, officeId: office, slug: `state-${name}`, title }, PUB)).item!;
    await content.saveDraft({ itemId: item.id, title, bodyMarkup: 'A plain body.' }, PUB);
    await attach(name, await working(item.id));
    return item.id;
  };
  const readied = async (itemId: string): Promise<Uint8Array> =>
    (await content.markReady({ itemId, targets: { website: true, newsletter: false, email: false } }, PUB)).item?.working?.contentHash as Uint8Array;

  beforeAll(async () => {
    api = await startApi('nwfl_searchstates', { search: { perSecond: 100_000, burst: 100_000 } });
    search = api.client(SearchService);
    content = api.client(ContentService);
    office = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ('publications', 'Publications Officer', 'appointed') RETURNING id`);
    const database = (await api.pool.query<{ db: string }>(`SELECT current_database() AS db`)).rows[0]!.db;
    owner = new pg.Client({ connectionString: urlFor('postgres', new URL(url as string).password, database) });
    await owner.connect();

    // The control is made as production makes it, not planted (since the merge round): the read now also asks the live code
    // whether a hit's row is what the audience is served now (P1d), which a planted row and ledger row cannot pass.
    const bytes = await pagesPdf([[`Page one: the ${WORDS.published} again.`]]);
    const published = await publishItem(api.pool, { slug: 'state-published', officeId: office, title: `Notes ${WORDS.published}`, body: { blocks: [paragraph(text(`The ${WORDS.published} was discussed.`))] }, files: [{ objectKey: 'planted-published.pdf', audience: 'public', bytes }] });
    const publishedFile = (await owner.query<{ id: string }>(`SELECT id FROM stored_file WHERE version_id = $1`, [published.versionId])).rows[0]!.id;
    await storeOriginal(api.pool, { fileId: publishedFile, bytes, sub: 'sub-officer', groups: ['nwfl-members', 'nwfl-officers'] });
    await recordItems(api.pool, [published.itemId]);
    expect(await drain(api.worker, { index: (fileId) => indexFile(api.worker, fileId, { text: ({ copy, quotes }) => textReply({ kind: 'text', copy, quotes }) }) })).toBe(1);
    planted['published'] = { itemId: published.itemId, versionId: published.versionId, fileId: publishedFile };
    const officers = await publishItem(api.pool, { slug: 'state-officers', officeId: office, title: 'Officers', visibility: 'officers', body: { blocks: [paragraph(text('x'))] }, files: [{ objectKey: 'planted-officers.pdf', audience: 'public' }] });
    await plant('officers', officers.itemId, officers.versionId);
    // Never published: a draft, a version marked ready, and one approved and waiting to be published.
    const draft = await drafted('draft', 'Draft');
    await plant('draft', draft, await working(draft));
    const ready = await drafted('ready', 'Ready');
    await readied(ready);
    await plant('ready', ready, await working(ready));
    const approved = await drafted('approved', 'Approved');
    await content.approve({ itemId: approved, contentHash: await readied(approved) }, TREASURER);
    await plant('approved', approved, await working(approved));
    // Published, then withdrawn.
    const withdrawn = await publishItem(api.pool, { slug: 'state-withdrawn', officeId: office, title: 'Withdrawn', body: { blocks: [paragraph(text('x'))] }, files: [{ objectKey: 'planted-withdrawn.pdf', audience: 'public' }] });
    await content.withdraw({ itemId: withdrawn.itemId }, WEBMASTER);
    await plant('withdrawn', withdrawn.itemId, withdrawn.versionId);
    // Published, with a newer draft: the DRAFT version's rows are planted beside the item, in place of the live one's.
    const redraft = await publishItem(api.pool, { slug: 'state-redraft', officeId: office, title: 'Live', body: { blocks: [paragraph(text('x'))] } });
    await content.saveDraft({ itemId: redraft.itemId, title: 'Live, revised', bodyMarkup: 'A revised body.' }, PUB);
    await attach('redraft', await working(redraft.itemId));
    await plant('redraft', redraft.itemId, await working(redraft.itemId));
    for (const [slug, status, word] of [['2026-02', 'published', 'editionoutword'], ['2026-03', 'proof', 'editionproofword']] as const) {
      const edition = await insertId(api.pool, `INSERT INTO edition (slug, title, kind, period_start, period_end, status) VALUES ($1, $1, 'regular', $2, $3, $4) RETURNING id`, [slug, `${slug}-01`, `${slug}-28`, status]);
      const fileId = (
        await owner.query<{ id: string }>(
          `INSERT INTO stored_file (edition_id, object_key, filename, mime_type, size_bytes, sha256, audience) VALUES ($1, $2, $2, 'application/pdf', 10, sha256(convert_to($2, 'UTF8')), 'public') RETURNING id`,
          [edition, `edition-${slug}.pdf`],
        )
      ).rows[0]!.id;
      for (const audience of ['public', 'members'] as const) {
        await owner.query(`SELECT publication_ledger_record('stored_file', $1, $2, sha256('planted copy'), '{"v":1,"served":"copy"}', 0)`, [fileId, audience]);
        await owner.query(`INSERT INTO search_page_${audience} (file_id, page, served_sha256, text_version, text, extra) VALUES ($1, 1, sha256('planted copy'), 1, $2, '')`, [fileId, `The ${word} issue.`]);
      }
    }
  }, 120_000);

  afterAll(async () => {
    await owner?.end();
    await api?.close();
  });

  it('planted each item\'s row and page where a search would match them, in both audiences\' tables', async () => {
    for (const [name, word] of Object.entries(WORDS)) {
      for (const table of ['search_item_public', 'search_item_members', 'search_page_public', 'search_page_members']) {
        expect((await owner.query(`SELECT 1 FROM ${table} WHERE tsv @@ websearch_to_tsquery('english', $1)`, [word])).rowCount, `${name} in ${table}`).toBe(1);
      }
    }
    const states = await owner.query<{ slug: string; state: string }>(`SELECT slug, state FROM content_item WHERE slug LIKE 'state-%' ORDER BY slug`);
    expect(Object.fromEntries(states.rows.map((row) => [row.slug, row.state]))).toEqual({
      'state-approved': 'ready',
      'state-draft': 'draft',
      'state-officers': 'published',
      'state-published': 'published',
      'state-ready': 'ready',
      'state-redraft': 'published',
      'state-withdrawn': 'withdrawn',
    });
  });

  describe.each(AUDIENCES)('for %s', (_who, who) => {
    it('finds the published item, as a news hit and as a page of its file: the control', async () => {
      const response = await find(WORDS.published, who);
      expect(response.hits.map((hit) => hit.hit.case).sort()).toEqual(['issuePage', 'newsItem']);
      const page = response.hits.find((hit) => hit.hit.case === 'issuePage')!.hit.value as { fileId: string; page: number };
      expect([page.fileId, page.page]).toEqual([planted['published']!.fileId, 1]);
    });

    it.each(['officers', 'draft', 'ready', 'approved', 'withdrawn', 'redraft'] as const)('gives nothing of the %s item: no hit, no next page, and no word of it beside the control', async (name) => {
      const alone = await find(WORDS[name], who);
      expect(alone.hits).toEqual([]);
      expect(alone.hasMore).toBe(false);
      // Beside a word that is found: the same two hits as the control alone, and nothing of the item in them.
      const beside = await find(`${WORDS.published} or ${WORDS[name]}`, who);
      expect(beside.hits).toHaveLength(2);
      const said = JSON.stringify(beside.hits.map((hit) => hit.hit.value)).replaceAll('', '').replaceAll('', '');
      expect(said).not.toContain(WORDS[name]);
      expect(said).not.toContain(planted[name]!.fileId);
      expect(said).not.toContain(planted[name]!.itemId);
    });
  });

  // The statement and the lens each refuse these on their own. Here the statement alone, before the lens is asked.
  it.each(['public', 'members'] as const)('gives no row for any of them from the %s statement itself, and the control\'s two', async (audience) => {
    const rows = async (word: string): Promise<string[]> => (await api.pool.query<{ kind: string }>(searchSql(audience), [word, 300])).rows.map((row) => row.kind).sort();
    expect(await rows(WORDS.published)).toEqual(['item', 'page']);
    for (const name of ['officers', 'draft', 'ready', 'approved', 'withdrawn', 'redraft'] as const) expect(await rows(WORDS[name]), name).toEqual([]);
    // An edition's own PDF: a row once the edition is published, none while it is in proof.
    expect(await rows('editionproofword')).toEqual([]);
    expect(await rows('editionoutword')).toEqual(['page']);
  });

  it('answers a search for every such word at once with the control alone, for each audience', async () => {
    for (const [, who] of AUDIENCES) {
      const response = await find(Object.values(WORDS).slice(0, 4).join(' or '), who).catch((error: unknown) => ConnectError.from(error));
      expect(response).not.toBeInstanceOf(ConnectError);
      expect((response as SearchResponse).hits).toHaveLength(2);
      expect((await find(Object.values(WORDS).slice(4).join(' or '), who)).hits).toEqual([]);
    }
  });
});
