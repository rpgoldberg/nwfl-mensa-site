// ARCHIVE-SEARCH S2: the issue-text index job (src/search/pages.ts), against a real Postgres, as the
// worker's own role. The engine is the real one (in this process); the text is read by the real
// reader (gate-text.ts), in this process but for the last test, which runs the worker as a process
// would, with its capped children. Finding F1 is the point of most of it: an audience's index holds
// only text of the copy that audience is served.
//
// The PDFs are synthetic, made here with pdf-lib: never a real issue. Every name is made up.
import { createHash } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordItems } from '../../src/ledger/ledger.js';
import { textReply } from '../../src/pdf/gate-text.js';
import { redactPdf } from '../../src/pdf/redact.js';
import { RetryableEngineError, drain } from '../../src/pdf/regenerate.js';
import { readPdf, storeOriginal } from '../../src/pdf/store.js';
import { runWorker } from '../../src/pdf/worker.js';
import { type Texter, indexFile, indexSweeper } from '../../src/search/pages.js';
import { TEXT_VERSION } from '../../src/search/text.js';
import { type Api, insertId, startApi } from '../helpers/api.js';
import { publishItem } from '../helpers/content.js';
import { WORKER, WORKER_PW, live, url, urlFor } from '../helpers/pg.js';
import { GATE_CHILD_SOURCE, NODE_FLAGS } from '../helpers/sidecar.js';
import { pagesPdf } from './synthetic.js';

const STORER = { sub: 'sub-officer', groups: ['nwfl-members', 'nwfl-officers'] };
/** A member's phone: the public withholds it, members are shown it (0012). */
const PHONE = '850-555-0142';
/** A member's address: both withhold it. */
const ADDRESS = '12 Orchard Lane';
const sha = (bytes: Uint8Array): Buffer => createHash('sha256').update(bytes).digest();
/** The real reading, in this process. */
const reader: Texter = ({ copy, quotes }) => textReply({ kind: 'text', copy, quotes });

interface PageRow {
  page: number;
  text: string;
  extra: string;
  served_sha256: Buffer;
  text_version: number;
  item_id: string | null;
}

describe.skipIf(!live)('the issue-text index job', () => {
  let api: Api;
  let database: string;
  let owner: pg.Client;
  let office: string;
  let counter = 0;
  const warned: Array<{ fields: Record<string, unknown>; message: string }> = [];
  const warn = (fields: Record<string, unknown>, message: string): void => void warned.push({ fields, message });

  const issue = async (
    pages: ReadonlyArray<readonly string[]>,
    audience: 'public' | 'members' = 'public',
    visibility: 'public' | 'members' | 'officers' = 'public',
  ): Promise<{ itemId: string; fileId: string }> => {
    const n = ++counter;
    const bytes = await pagesPdf(pages);
    const { itemId, versionId } = await publishItem(api.pool, {
      slug: `issue-${n}`,
      kind: 'document',
      officeId: office,
      title: `Synthetic issue ${n}`,
      body: { blocks: [] },
      visibility,
      files: [{ objectKey: `issue-${n}.pdf`, audience, bytes }],
    });
    const fileId = (await api.pool.query<{ id: string }>(`SELECT id FROM stored_file WHERE version_id = $1`, [versionId])).rows[0]!.id;
    await storeOriginal(api.pool, { fileId, bytes, ...STORER });
    return { itemId, fileId };
  };
  /** A mark as the API adds one (redaction/marks.ts): the mark and the ledger's rows in one transaction. */
  const mark = async (itemId: string, quote: string, category: string): Promise<void> => {
    const client = await api.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT redaction_mark_add('content_item', $1, 'body', $2, $3, $4, $5, NULL)`, [itemId, quote, category, STORER.sub, STORER.groups]);
      await recordItems(client, [itemId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };
  const rows = async (audience: 'public' | 'members', fileId: string): Promise<PageRow[]> =>
    (await owner.query<PageRow>(`SELECT page, text, extra, served_sha256, text_version, item_id FROM search_page_${audience} WHERE file_id = $1 ORDER BY page`, [fileId])).rows;
  const words = (found: readonly PageRow[]): string => found.map((row) => `${row.text} ${row.extra}`).join('\n');
  const hits = async (audience: 'public' | 'members', query: string): Promise<number> =>
    (await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM search_page_${audience} WHERE tsv @@ websearch_to_tsquery('english', $1)`, [query])).rows[0]!.n;
  /** The job as the worker runs it: every queued file made, then its text indexed. */
  const run = (text: Texter = reader, textVersion?: number) =>
    drain(api.worker, { index: (fileId) => indexFile(api.worker, fileId, { text, warn, ...(textVersion === undefined ? {} : { textVersion }) }) });
  const served = async (fileId: string, audience: string): Promise<Buffer> => {
    const read = await readPdf(api.pool, fileId, audience);
    if (read.kind !== 'pdf') throw new Error(`expected a pdf, got ${read.kind}`);
    return sha(read.pdf);
  };

  beforeAll(async () => {
    api = await startApi('nwfl_searchpages');
    database = (await api.pool.query<{ db: string }>(`SELECT current_database() AS db`)).rows[0]!.db;
    owner = new pg.Client({ connectionString: urlFor('postgres', new URL(url as string).password, database) });
    await owner.connect();
    office = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ('publications', 'Publications Officer', 'appointed') RETURNING id`);
  }, 60_000);

  afterAll(async () => {
    await owner?.end();
    await api?.close();
  });

  describe('finding F1: each audience\'s index holds only what that audience is served', () => {
    let itemId: string;
    let fileId: string;

    it('indexes each audience\'s own copy: a passage redacted for the public is in no public row, and members, who are shown it, find it', async () => {
      ({ itemId, fileId } = await issue([
        ['Picnic at Ferry Park', `Rides: call ${PHONE} for a seat.`],
        [`Send dues to ${ADDRESS} by June.`, 'Game night is Tuesday'],
      ]));
      await mark(itemId, PHONE, 'member_phone');
      await mark(itemId, ADDRESS, 'member_address');
      expect(await run()).toBe(1);
      const [pub, mem] = [await rows('public', fileId), await rows('members', fileId)];
      expect(pub.map((row) => row.page)).toEqual([1, 2]);
      expect(mem.map((row) => row.page)).toEqual([1, 2]);
      // The positive controls: plain lines for both, the phone for members.
      expect(pub[0]!.text).toContain('Picnic at Ferry Park');
      expect(pub[1]!.text).toContain('Game night is Tuesday');
      expect(mem[0]!.text).toContain(`Rides: call ${PHONE} for a seat.`);
      // The withheld passages, whole and in part.
      for (const canary of [PHONE, '0142', '555', ADDRESS, 'Orchard']) expect(words(pub), canary).not.toContain(canary);
      for (const canary of [ADDRESS, 'Orchard']) expect(words(mem), canary).not.toContain(canary);
      expect([await hits('public', 'picnic'), await hits('members', 'picnic')]).toEqual([1, 1]);
      expect([await hits('public', 'orchard'), await hits('members', 'orchard')]).toEqual([0, 0]);
      expect([await hits('public', 'rides'), await hits('members', 'rides')]).toEqual([1, 1]);
      expect(await hits('public', `"${PHONE}"`)).toBe(0);
      expect(await hits('members', `"${PHONE}"`)).toBe(1);
    });

    it('names, on every row, the copy that audience is served, the rule\'s version and the item', async () => {
      const [forPublic, forMembers] = [await served(fileId, 'public'), await served(fileId, 'members')];
      expect(forPublic.equals(forMembers)).toBe(false);
      for (const row of await rows('public', fileId)) expect([row.served_sha256.toString('hex'), row.text_version, row.item_id]).toEqual([forPublic.toString('hex'), TEXT_VERSION, itemId]);
      for (const row of await rows('members', fileId)) expect([row.served_sha256.toString('hex'), row.text_version, row.item_id]).toEqual([forMembers.toString('hex'), TEXT_VERSION, itemId]);
    });

    it('holds nothing of a passage from the moment it is marked, and the new copy\'s text once the worker has made it', async () => {
      expect(words(await rows('public', fileId))).toContain('Ferry Park');
      await mark(itemId, 'Ferry Park', 'member_address');
      // Before the worker runs: no row of either audience (0032's delete, in the mark's own transaction).
      expect([await rows('public', fileId), await rows('members', fileId)]).toEqual([[], []]);
      expect(await hits('public', 'ferry')).toBe(0);
      expect(await run()).toBe(1);
      const [pub, mem] = [await rows('public', fileId), await rows('members', fileId)];
      expect(words(pub)).toContain('Game night is Tuesday');
      for (const found of [pub, mem]) expect(words(found)).not.toContain('Ferry');
      expect([await hits('public', 'ferry'), await hits('members', 'ferry')]).toEqual([0, 0]);
      expect(words(mem)).toContain(PHONE);
      expect(words(pub)).not.toContain(PHONE);
    });

    it('gives the public nothing of a members\' file, and members its text', async () => {
      const members = await issue([['The treasurer reports a surplus of marmalade']], 'members');
      expect(await run()).toBe(1);
      expect(await rows('public', members.fileId)).toEqual([]);
      expect(words(await rows('members', members.fileId))).toContain('The treasurer reports a surplus of marmalade');
      expect([await hits('public', 'marmalade'), await hits('members', 'marmalade')]).toEqual([0, 1]);
      expect(await indexFile(api.worker, members.fileId, { text: reader, audiences: ['public'] })).toEqual([{ audience: 'public', outcome: 'not-a-copy' }]);
      // Even handed the members' text for the public, the database refuses it: the ledger says the public is served no copy.
      const copy = await served(members.fileId, 'members');
      await expect(api.worker.query(`SELECT search_page_put($1, 'public', $2, $3, $4::text[], $5::text[])`, [members.fileId, copy, TEXT_VERSION, ['marmalade'], ['']])).rejects.toMatchObject({ code: '55000' });
    });

    it('refuses to index a copy in which the reader still finds a withheld passage, and says so without the passage', async () => {
      const made = await issue([['Bring a dish to share', 'Ask for Kestrel Ambry at the door']]);
      await run();
      expect(words(await rows('public', made.fileId))).toContain('Kestrel Ambry');
      await owner.query(`DELETE FROM search_page_public WHERE file_id = $1`, [made.fileId]);
      warned.length = 0;
      // A reader told the copy's audience withholds a name the copy holds: what a fault upstream would look like.
      const strict: Texter = ({ copy }) => textReply({ kind: 'text', copy, quotes: ['Kestrel Ambry'] });
      expect(await indexFile(api.worker, made.fileId, { text: strict, warn, audiences: ['public'] })).toEqual([{ audience: 'public', outcome: 'no-text', code: 'withheld' }]);
      expect(await rows('public', made.fileId)).toEqual([]);
      expect(warned).toEqual([{ fields: { file_id: made.fileId, audience: 'public', code: 'withheld' }, message: 'a PDF copy was not indexed' }]);
    });
  });

  describe('indexFile', () => {
    it('says what it did for each audience, and reads a copy two audiences share once', async () => {
      const made = await issue([['Chess club meets Thursday']]);
      await drain(api.worker);
      let calls = 0;
      const counting: Texter = (job) => {
        calls++;
        return reader(job);
      };
      // No mark: the public and members are served the same copy.
      expect((await served(made.fileId, 'public')).equals(await served(made.fileId, 'members'))).toBe(true);
      expect(await indexFile(api.worker, made.fileId, { text: counting })).toEqual([
        { audience: 'public', outcome: 'indexed', pages: 1 },
        { audience: 'members', outcome: 'indexed', pages: 1 },
      ]);
      expect(calls).toBe(1);
      expect(words(await rows('public', made.fileId))).toBe('Chess club meets Thursday ');
    });

    it('indexes nothing for a file it does not know, one with no copy yet, or one whose copy was refused', async () => {
      expect(await indexFile(api.worker, '00000000-0000-4000-8000-00000000abcd', { text: reader })).toEqual([
        { audience: 'public', outcome: 'not-a-copy' },
        { audience: 'members', outcome: 'not-a-copy' },
      ]);
      const made = await issue([['A refused issue']]);
      expect((await indexFile(api.worker, made.fileId, { text: reader })).map((result) => result.outcome)).toEqual(['not-a-copy', 'not-a-copy']);
      await drain(api.worker, { redact: () => Promise.resolve({ kind: 'refused', reason: 'page 1 is a scan' }) });
      expect((await indexFile(api.worker, made.fileId, { text: reader })).map((result) => result.outcome)).toEqual(['not-a-copy', 'not-a-copy']);
      expect([await rows('public', made.fileId), await rows('members', made.fileId)]).toEqual([[], []]);
    });

    it('leaves nothing when what the audience is served changes while the copy is being read (the put is refused)', async () => {
      const made = await issue([['Quiz night', 'Hosted by Ottoline Varga']]);
      await drain(api.worker);
      const racing: Texter = async (job) => {
        const read = await reader(job);
        await mark(made.itemId, 'Ottoline Varga', 'member_address');
        return read;
      };
      const results = await indexFile(api.worker, made.fileId, { text: racing, warn });
      // The public's put meets the moved ledger; by the members' turn their inputs name a copy that is not made yet.
      expect(results.map((result) => result.outcome)).toEqual(['stale', 'not-a-copy']);
      expect(warned.filter((line) => line.fields['file_id'] === made.fileId)).toEqual([]);
      expect([await rows('public', made.fileId), await rows('members', made.fileId)]).toEqual([[], []]);
      await run();
      expect(words(await rows('public', made.fileId))).toContain('Quiz night');
      expect(words(await rows('public', made.fileId))).not.toContain('Ottoline');
    });

    it('leaves the old rows as they were when the reading fails, however it fails, and logs the file and the reason, never the text', async () => {
      const made = await issue([['Book club reads a mystery']]);
      await run();
      const before = [await rows('public', made.fileId), await rows('members', made.fileId)];
      expect(before[0]!.map((row) => row.text_version)).toEqual([TEXT_VERSION]);
      const failures: Array<[string, Texter, Record<string, unknown>]> = [
        ['unfinished', () => Promise.resolve({ sha256: null, code: 'unfinished', cause: 'memory' }), { code: 'unfinished', cause: 'memory' }],
        ['over-cap', (job) => Promise.resolve({ sha256: job.sha256, code: 'over-cap' }), { code: 'over-cap' }],
        ['another copy', async (job) => ({ ...(await reader(job)), sha256: 'ab'.repeat(32) }), { code: 'mismatch' }],
        ['unreachable', () => Promise.reject(new RetryableEngineError('the gate sidecar took longer than 150000 ms')), { code: 'PDF_ENGINE_UNAVAILABLE' }],
        ['a throw', () => Promise.reject(new Error('Book club reads a mystery')), { code: 'failed' }],
      ];
      for (const [name, text, fields] of failures) {
        warned.length = 0;
        const results = await indexFile(api.worker, made.fileId, { text, warn, textVersion: TEXT_VERSION + 1 });
        expect(results.map((result) => result.outcome), name).toEqual(['no-text', 'no-text']);
        expect([await rows('public', made.fileId), await rows('members', made.fileId)], name).toEqual(before);
        expect(warned, name).toEqual(['public', 'members'].map((audience) => ({ fields: { file_id: made.fileId, audience, ...fields }, message: 'a PDF copy was not indexed' })));
        expect(JSON.stringify(warned), name).not.toContain('mystery');
      }
      // A failed put (the database's own refusal of the pages) leaves them too.
      warned.length = 0;
      const tooMany: Texter = (job) => Promise.resolve({ sha256: job.sha256, pages: Array.from({ length: 301 }, () => ({ text: 'mystery', extra: '' })) });
      expect((await indexFile(api.worker, made.fileId, { text: tooMany, warn, textVersion: TEXT_VERSION + 1 })).map((result) => result.outcome)).toEqual(['failed', 'failed']);
      expect([await rows('public', made.fileId), await rows('members', made.fileId)]).toEqual(before);
      expect(warned.map((line) => [line.fields['code'], line.message])).toEqual([['22023', 'a PDF copy was not indexed'], ['22023', 'a PDF copy was not indexed']]);
      expect(JSON.stringify(warned)).not.toContain('mystery');
      // And a good reading then replaces them.
      await indexFile(api.worker, made.fileId, { text: reader, textVersion: TEXT_VERSION + 1 });
      expect((await rows('public', made.fileId)).map((row) => [row.text, row.text_version])).toEqual([['Book club reads a mystery', TEXT_VERSION + 1]]);
      await indexFile(api.worker, made.fileId, { text: reader });
    });

    it('does not let a failed index fail the regeneration run', async () => {
      const made = await issue([['Hike at the bluffs']]);
      warned.length = 0;
      expect(await drain(api.worker, { warn, index: () => Promise.reject(new Error('the index is down')) })).toBe(1);
      expect((await readPdf(api.pool, made.fileId, 'public')).kind).toBe('pdf');
      expect(warned).toEqual([{ fields: { file_id: made.fileId, error_name: 'Error' }, message: 'a PDF copy was made but not indexed' }]);
      await indexFile(api.worker, made.fileId, { text: reader });
    });
  });

  describe('the sweep', () => {
    const steps = async (step: () => Promise<{ deleted: number; indexed: number; left: number }>): Promise<Array<{ deleted: number; indexed: number; left: number }>> => {
      const out = [];
      for (let n = 0; n < 500; n++) {
        const result = await step();
        out.push(result);
        if (result.left === 0) break;
      }
      return out;
    };
    const total = async (audience: 'public' | 'members'): Promise<number> => (await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM search_page_${audience}`)).rows[0]!.n;

    it('indexes every served copy that lacks its text, a batch at a time, and then has nothing left to do', async () => {
      // Whatever the tests above left unindexed is made good first.
      await steps(indexSweeper(api.worker, { text: reader, warn }));
      const made = [await issue([['Stargazing on the pier']]), await issue([['Trivia at the library']]), await issue([['Potluck in the hall']])];
      await drain(api.worker);
      for (const { fileId } of made) expect(await rows('public', fileId)).toEqual([]);
      let calls = 0;
      const step = indexSweeper(api.worker, { text: (job) => (calls++, reader(job)), warn, batch: 4 });
      // Three files, two audiences each: six to index, four in the first step.
      expect(await step()).toEqual({ deleted: 0, indexed: 4, left: 2 });
      expect(await step()).toEqual({ deleted: 0, indexed: 2, left: 0 });
      expect(calls).toBe(6);
      for (const [n, line] of ['Stargazing on the pier', 'Trivia at the library', 'Potluck in the hall'].entries()) {
        expect(words(await rows('public', made[n]!.fileId))).toContain(line);
        expect(words(await rows('members', made[n]!.fileId))).toContain(line);
      }
      // Done: this sweep asks nothing more.
      expect(await step()).toEqual({ deleted: 0, indexed: 0, left: 0 });
      expect(calls).toBe(6);
      // A sweep that cannot list fails its step, and lists again at the next.
      let down = true;
      const flaky = indexSweeper({ query: (sql: string, values?: unknown[]) => (down ? Promise.reject(new Error('db down')) : api.worker.query(sql, values)) }, { text: reader });
      await expect(flaky()).rejects.toThrow('db down');
      down = false;
      expect(await flaky()).toEqual({ deleted: 0, indexed: 0, left: 0 });
      // A new sweep (the next boot) finds nothing lacking.
      expect(await steps(indexSweeper(api.worker, { text: (job) => (calls++, reader(job)), warn }))).toEqual([{ deleted: 0, indexed: 0, left: 0 }]);
      expect(calls).toBe(6);
    });

    it('deletes the rows of copies served no longer (orphans), whoever they were for, and indexes again what is served now', async () => {
      const made = await issue([['Kayaks on the bayou']]);
      const members = await issue([['Minutes of the closed session']], 'members');
      await run();
      // The public's rows fall behind (as after the worker made a new copy and died before its put) ...
      await owner.query(`UPDATE search_page_public SET served_sha256 = sha256('an older copy'::bytea), text = 'an older reading' WHERE file_id = $1`, [made.fileId]);
      // ... and the members' file has a row in the public table, as a fault would leave it.
      const memberCopy = await served(members.fileId, 'members');
      await owner.query(`INSERT INTO search_page_public (file_id, page, served_sha256, text_version, text, extra) VALUES ($1, 1, $2, $3, 'Minutes of the closed session', '')`, [members.fileId, memberCopy, TEXT_VERSION]);
      expect(await hits('public', 'minutes')).toBe(1);
      const membersBefore = await total('members');
      expect(await steps(indexSweeper(api.worker, { text: reader, warn }))).toEqual([{ deleted: 2, indexed: 1, left: 0 }]);
      expect(await hits('public', 'minutes')).toBe(0);
      expect(await rows('public', members.fileId)).toEqual([]);
      expect(words(await rows('members', members.fileId))).toContain('Minutes of the closed session');
      expect((await rows('public', made.fileId)).map((row) => row.text)).toEqual(['Kayaks on the bayou']);
      expect(await total('members')).toBe(membersBefore);
    });

    it('reads every copy again when TEXT_VERSION moves, and a copy whose reading fails keeps its old rows', async () => {
      const [publicRows, memberRows] = [await total('public'), await total('members')];
      expect(publicRows).toBeGreaterThan(5);
      const old = await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM search_page_public WHERE text_version <> $1`, [TEXT_VERSION]);
      expect(old.rows[0]!.n).toBe(0);
      const failing = await issue([['Sailing lessons resume']]);
      await run();
      const next = TEXT_VERSION + 1;
      warned.length = 0;
      // The reader fails on one copy only.
      const failingCopy = (await served(failing.fileId, 'public')).toString('hex');
      const text: Texter = (job) => (job.sha256 === failingCopy ? Promise.resolve({ sha256: null, code: 'unfinished' as const, cause: 'deadline' as const }) : reader(job));
      const done = await steps(indexSweeper(api.worker, { text, warn, textVersion: next, batch: 5 }));
      expect(done.length).toBeGreaterThan(1);
      expect(done.reduce((sum, step) => sum + step.deleted, 0)).toBe(0);
      expect(done.reduce((sum, step) => sum + step.indexed, 0)).toBeGreaterThan(5);
      const versions = await owner.query<{ file_id: string; text_version: number }>(`SELECT DISTINCT file_id, text_version FROM search_page_public`);
      for (const row of versions.rows) expect(row.text_version, row.file_id).toBe(row.file_id === failing.fileId ? TEXT_VERSION : next);
      expect((await rows('public', failing.fileId)).map((row) => [row.text, row.text_version])).toEqual([['Sailing lessons resume', TEXT_VERSION]]);
      expect((await rows('members', failing.fileId)).map((row) => [row.text, row.text_version])).toEqual([['Sailing lessons resume', TEXT_VERSION]]);
      expect(warned.map((line) => line.fields)).toEqual([
        { file_id: failing.fileId, audience: 'members', code: 'unfinished', cause: 'deadline' },
        { file_id: failing.fileId, audience: 'public', code: 'unfinished', cause: 'deadline' },
      ]);
      expect([await total('public'), await total('members')]).toEqual([publicRows + 1, memberRows + 1]);
      // Back at this build's version (a rollback): everything is read again, and nothing is left behind.
      await steps(indexSweeper(api.worker, { text: reader, warn }));
      const back = await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM search_page_public WHERE text_version <> $1`, [TEXT_VERSION]);
      expect(back.rows[0]!.n).toBe(0);
    });

    it('hears a file that fails and goes on to the next', async () => {
      const made = [await issue([['Origami for beginners']]), await issue([['Birdwatching at dawn']])];
      await drain(api.worker);
      warned.length = 0;
      let first = true;
      const flaky: Texter = (job) => {
        if (first) {
          first = false;
          return Promise.reject(new Error('socket hang up'));
        }
        return reader(job);
      };
      expect(await steps(indexSweeper(api.worker, { text: flaky, warn }))).toEqual([{ deleted: 0, indexed: 3, left: 0 }]);
      expect(warned).toHaveLength(1);
      expect(warned[0]!.fields).toMatchObject({ code: 'failed' });
      const indexed = (await Promise.all(made.flatMap(({ fileId }) => [rows('public', fileId), rows('members', fileId)]))).filter((found) => found.length > 0);
      expect(indexed).toHaveLength(3);
      await steps(indexSweeper(api.worker, { text: reader, warn }));
    });
  });

  describe('only what its audience may open (S2 challenge M2)', () => {
    const steps = async (step: () => Promise<{ deleted: number; indexed: number; left: number }>): Promise<Array<{ deleted: number; indexed: number; left: number }>> => {
      const out = [];
      for (let n = 0; n < 500; n++) {
        const result = await step();
        out.push(result);
        if (result.left === 0) break;
      }
      return out;
    };
    /** The ledger's current row for a file and audience, as the put reads it. */
    const ledger = async (fileId: string, audience: 'public' | 'members'): Promise<{ sha: Buffer; served: string } | undefined> =>
      (
        await owner.query<{ sha: Buffer; served: string }>(
          `SELECT output_sha256 AS sha, inputs ->> 'served' AS served FROM publication_ledger
            WHERE tenant_id = 'nwflorida' AND subject_kind = 'stored_file' AND subject_id = $1 AND audience = $2 AND current_to IS NULL`,
          [fileId, audience],
        )
      ).rows[0];
    const lacking = async (): Promise<string[]> =>
      (await api.worker.query<{ file_id: string; audience: string }>(`SELECT file_id, audience FROM search_page_lacking($1)`, [TEXT_VERSION])).rows.map((row) => `${row.file_id} ${row.audience}`);
    const put = (fileId: string, audience: 'public' | 'members', sha256: Buffer) =>
      api.worker.query(`SELECT search_page_put($1, $2, $3, $4, $5::text[], $6::text[])`, [fileId, audience, sha256, TEXT_VERSION, ['a planted page'], ['']]);
    /** A row as a fault (or an older build) would leave it: the ledger's current copy, the text of an item no audience here may open. */
    const plant = async (fileId: string, audience: 'public' | 'members', text: string): Promise<void> => {
      const current = await ledger(fileId, audience);
      await owner.query(`INSERT INTO search_page_${audience} (file_id, page, served_sha256, text_version, text, extra) VALUES ($1, 1, $2, $3, $4, '')`, [fileId, current!.sha, TEXT_VERSION, text]);
    };
    const tx = async (work: (client: pg.PoolClient) => Promise<unknown>): Promise<void> => {
      const client = await api.pool.connect();
      try {
        await client.query('BEGIN');
        await work(client);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    };
    /** A file on a version that was never approved: a draft's. */
    const draft = async (line: string): Promise<string> => {
      const n = ++counter;
      const bytes = await pagesPdf([[line]]);
      const itemId = await insertId(api.pool, `INSERT INTO content_item (slug, kind, office_id) VALUES ($1, 'document', $2) RETURNING id`, [`draft-${n}`, office]);
      const versionId = await insertId(
        api.pool,
        `INSERT INTO content_version (item_id, n, title, visibility, body_ast, created_by_sub, acting_office_id) VALUES ($1, 1, 'A draft', 'public', '{"blocks":[]}', 'sub-author', $2) RETURNING id`,
        [itemId, office],
      );
      const fileId = await insertId(
        api.pool,
        `INSERT INTO stored_file (version_id, object_key, filename, mime_type, size_bytes, sha256, audience) VALUES ($1, $2, $2, 'application/pdf', $3, $4, 'public') RETURNING id`,
        [versionId, `draft-${n}.pdf`, bytes.length, sha(bytes)],
      );
      await storeOriginal(api.pool, { fileId, bytes, ...STORER });
      return fileId;
    };
    /** A file of an edition (the hosted issue), at `status`. */
    const editionFile = async (line: string, status: 'proof' | 'published'): Promise<{ editionId: string; fileId: string }> => {
      const n = ++counter;
      const bytes = await pagesPdf([[line]]);
      const editionId = await insertId(
        api.pool,
        `INSERT INTO edition (slug, title, kind, period_start, period_end, status) VALUES ($1, 'A synthetic issue', 'regular', '2030-01-01', '2030-01-31', $2) RETURNING id`,
        [`2030-01-xtra-${n}`, status],
      );
      const fileId = await insertId(
        api.pool,
        `INSERT INTO stored_file (edition_id, object_key, filename, mime_type, size_bytes, sha256, audience) VALUES ($1, $2, $2, 'application/pdf', $3, $4, 'public') RETURNING id`,
        [editionId, `edition-${n}.pdf`, bytes.length, sha(bytes)],
      );
      await storeOriginal(api.pool, { fileId, bytes, ...STORER });
      return { editionId, fileId };
    };

    it('indexes nothing of an officers-only item or a draft, lists neither, refuses their puts, and sweeps away rows planted for them', async () => {
      await steps(indexSweeper(api.worker, { text: reader, warn }));
      const officers = await issue([['Confidential zanzibar minutes']], 'public', 'officers');
      const drafted = await draft('Confidential narwhal minutes');
      await run();
      await steps(indexSweeper(api.worker, { text: reader, warn }));
      for (const fileId of [officers.fileId, drafted]) {
        // What makes the rule needed: the ledger alone says both audiences are served a copy.
        expect((await ledger(fileId, 'public'))?.served, fileId).toBe('copy');
        for (const audience of ['public', 'members'] as const) {
          expect(await rows(audience, fileId), `${fileId} ${audience}`).toEqual([]);
          await expect(put(fileId, audience, (await ledger(fileId, audience))!.sha), `${fileId} ${audience}`).rejects.toMatchObject({ code: '55000' });
        }
      }
      for (const word of ['zanzibar', 'narwhal']) expect([await hits('public', word), await hits('members', word)], word).toEqual([0, 0]);
      const listed = await lacking();
      for (const fileId of [officers.fileId, drafted]) expect(listed.filter((entry) => entry.startsWith(fileId))).toEqual([]);
      // Rows a fault left behind, with the ledger's own sha: the sweep deletes all four.
      for (const fileId of [officers.fileId, drafted]) for (const audience of ['public', 'members'] as const) await plant(fileId, audience, 'Confidential planted minutes');
      expect(await hits('members', 'planted')).toBe(2);
      expect(await steps(indexSweeper(api.worker, { text: reader, warn }))).toEqual([{ deleted: 4, indexed: 0, left: 0 }]);
      expect([await hits('public', 'planted'), await hits('members', 'planted')]).toEqual([0, 0]);
    });

    it('removes, at the next step of a running sweep, the rows of an item withdrawn or moved to an officers-only revision', async () => {
      const withdrawn = await issue([['Confidential quokka minutes']]);
      const rescoped = await issue([['Confidential wombat minutes']]);
      const kept = await issue([['Kite festival at the beach']]);
      await run();
      const step = indexSweeper(api.worker, { text: reader, warn });
      await steps(step);
      for (const { fileId } of [withdrawn, rescoped, kept]) for (const audience of ['public', 'members'] as const) expect(await rows(audience, fileId)).toHaveLength(1);
      // Withdrawn as the workflow withdraws (content/workflow.ts): the state, then the ledger, in one transaction.
      await tx(async (client) => {
        await client.query(`UPDATE content_item SET state = 'withdrawn', withdrawn_at = now(), updated_at = now() WHERE id = $1`, [withdrawn.itemId]);
        await recordItems(client, [withdrawn.itemId]);
      });
      // A revision for officers alone is approved: the live version moves, and the file of the old one is no one's here.
      const revision = await insertId(
        api.pool,
        `INSERT INTO content_version (item_id, n, title, visibility, body_ast, created_by_sub, acting_office_id, target_newsletter)
           VALUES ($1, 2, 'Revised', 'officers', '{"blocks":[]}', 'sub-author', $2, false) RETURNING id`,
        [rescoped.itemId, office],
      );
      await api.pool.query(`UPDATE content_version SET status = 'ready', content_hash = sha256('revised'::bytea), ready_at = now() WHERE id = $1`, [revision]);
      await api.pool.query(`UPDATE content_version SET status = 'cleared', approved_at = now(), approved_by_sub = 'sub-webmaster', approval_kind = 'normal', public_ast = '{"blocks":[]}' WHERE id = $1`, [revision]);
      // Approved, and made live, in one transaction, as approval does (0010: the live version is the newest approved, at commit).
      await tx(async (client) => {
        await client.query(`UPDATE content_version SET status = 'approved', published_at = now(), published_by_sub = 'sub-webmaster' WHERE id = $1`, [revision]);
        await client.query(`UPDATE content_item SET live_version_id = $2, updated_at = now() WHERE id = $1`, [rescoped.itemId, revision]);
        await recordItems(client, [rescoped.itemId]);
      });
      // The same sweep, a drain later: no restart.
      expect(await step()).toEqual({ deleted: 4, indexed: 0, left: 0 });
      for (const { fileId } of [withdrawn, rescoped]) for (const audience of ['public', 'members'] as const) expect(await rows(audience, fileId), `${fileId} ${audience}`).toEqual([]);
      for (const word of ['quokka', 'wombat']) expect([await hits('public', word), await hits('members', word)], word).toEqual([0, 0]);
      for (const audience of ['public', 'members'] as const) expect(words(await rows(audience, kept.fileId))).toContain('Kite festival at the beach');
      // And nothing brings them back: a fresh sweep lists neither.
      expect(await steps(indexSweeper(api.worker, { text: reader, warn }))).toEqual([{ deleted: 0, indexed: 0, left: 0 }]);
    });

    it('indexes a file of an edition once the edition is published, and not before', async () => {
      const { editionId, fileId } = await editionFile('Hosted issue: sailing club news', 'proof');
      await run();
      await steps(indexSweeper(api.worker, { text: reader, warn }));
      expect(await rows('public', fileId)).toEqual([]);
      await expect(put(fileId, 'public', (await ledger(fileId, 'public'))!.sha)).rejects.toMatchObject({ code: '55000' });
      await api.pool.query(`UPDATE edition SET status = 'published' WHERE id = $1`, [editionId]);
      expect(await lacking()).toContain(`${fileId} public`);
      await steps(indexSweeper(api.worker, { text: reader, warn }));
      expect(words(await rows('public', fileId))).toContain('Hosted issue: sailing club news');
    });
  });

  describe('the worker process', () => {
    it('indexes each copy it makes and, at boot, each served copy with no text, through its capped child and its own role', async () => {
      const swept = await issue([['Lanterns on the lake']]);
      await run();
      await owner.query(`DELETE FROM search_page_public WHERE file_id = $1`, [swept.fileId]);
      const made = await issue([['Orchestra night', `Tickets from ${PHONE} only.`]]);
      await mark(made.itemId, PHONE, 'member_phone');
      const target = new URL(url as string);
      const errors: unknown[] = [];
      warned.length = 0;
      const job = runWorker({
        env: { PGHOST: target.hostname, PGPORT: target.port, PGDATABASE: database, PGUSER: WORKER, PGPASSWORD: WORKER_PW },
        // The real engine, in this process; the gate and the text reading in the real capped child.
        redact: redactPdf,
        gateChild: GATE_CHILD_SOURCE,
        gateNodeFlags: NODE_FLAGS,
        intervalMs: 20,
        onError: (error) => errors.push(error),
        warn,
      });
      const deadline = Date.now() + 90_000;
      const ready = async (): Promise<boolean> => (await rows('members', made.fileId)).length > 0 && (await rows('public', made.fileId)).length > 0 && (await rows('public', swept.fileId)).length > 0;
      while (!(await ready()) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
      // S2 challenge S1 (mutant X17): a copy made after boot, once the sweep has made its list (it indexed `swept` from
      // it), is indexed by the run's own hook, with no restart.
      expect(await ready()).toBe(true);
      const late = await issue([['Late news: kite festival moved']]);
      const lateIndexed = async (): Promise<boolean> => (await rows('public', late.fileId)).length > 0 && (await rows('members', late.fileId)).length > 0;
      const lateDeadline = Date.now() + 60_000;
      while (!(await lateIndexed()) && Date.now() < lateDeadline) await new Promise((resolve) => setTimeout(resolve, 100));
      await job.stop();
      expect(words(await rows('public', late.fileId))).toContain('Late news: kite festival moved');
      expect(words(await rows('members', late.fileId))).toContain('Late news: kite festival moved');
      expect(errors).toEqual([]);
      expect(warned).toEqual([]);
      expect(words(await rows('public', swept.fileId))).toContain('Lanterns on the lake');
      const [pub, mem] = [await rows('public', made.fileId), await rows('members', made.fileId)];
      expect(words(pub)).toContain('Orchestra night');
      expect(words(pub)).not.toContain(PHONE);
      expect(words(pub)).not.toContain('0142');
      expect(words(mem)).toContain(`Tickets from ${PHONE} only.`);
      expect(pub[0]!.served_sha256.equals(await served(made.fileId, 'public'))).toBe(true);
    }, 180_000);
  });
});
