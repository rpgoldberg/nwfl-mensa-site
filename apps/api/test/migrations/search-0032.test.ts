// ARCHIVE-SEARCH S1: 0032_search.sql. The four index tables (one per audience and kind, no audience
// column), their two guarded writers, and pdf_regen_request's delete. Run against a real Postgres as
// the app role, the worker role, a role with no grants and the superuser (who bypasses grants, not
// functions). The races use two connections and wait until the second is seen blocked on a lock.
// Everything here is synthetic: no PDF is opened, and every name is made up.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pageText } from '../../src/search/text.js';
import { type Api, insertId, startApi } from '../helpers/api.js';
import { paragraph, publishItem, text } from '../helpers/content.js';
import { APP, APP_PW, WORKER, WORKER_PW, live, sqlstate, url, urlFor } from '../helpers/pg.js';

const TABLES = ['search_page_public', 'search_page_members', 'search_item_public', 'search_item_members'] as const;
const sha = (seed: string): Buffer => createHash('sha256').update(seed).digest();
const COPY = { v: 1, served: 'copy' };
const PUT = `SELECT search_page_put($1, $2, $3, $4, $5::text[], $6::text[]) AS pages`;

describe.skipIf(!live)('0032: the search index tables and their guarded writers', () => {
  let api: Api;
  let database: string;
  let owner: pg.Client;
  let app: pg.Client;
  let worker: pg.Client;
  let other: pg.Client;
  let office: string;
  let nobody: string;
  let counter = 0;

  /** A published item with one public PDF file whose original is stored (any bytes: nothing reads them here). */
  const fileItem = async (): Promise<{ itemId: string; versionId: string; fileId: string }> => {
    const n = ++counter;
    const bytes = Buffer.from(`synthetic file ${n}`);
    const made = await publishItem(api.pool, {
      slug: `search-file-${n}`,
      officeId: office,
      title: `Synthetic issue ${n}`,
      body: { blocks: [paragraph(text('A synthetic issue.'))] },
      files: [{ objectKey: `search-${n}.pdf`, audience: 'public', bytes }],
    });
    const fileId = (await api.pool.query<{ id: string }>(`SELECT id FROM stored_file WHERE version_id = $1`, [made.versionId])).rows[0]!.id;
    await api.pool.query(`SELECT pdf_original_put($1, $2, 'sub-author', ARRAY['nwfl-officers'], NULL)`, [fileId, bytes]);
    return { ...made, fileId };
  };
  /** What the ledger says this audience is given for the subject, as the app's own writer records it. */
  const serve = (kind: string, subject: string, audience: string, output: Buffer | null, inputs: object = COPY, client: pg.Client | pg.Pool = api.pool) =>
    client.query(`SELECT publication_ledger_record($1, $2, $3, $4, $5, 0)`, [kind, subject, audience, output, inputs]);
  interface PageRow {
    page: number;
    text: string;
    extra: string;
    served_sha256: Buffer;
    text_version: number;
    item_id: string | null;
  }
  const pages = async (table: string, fileId: string): Promise<PageRow[]> =>
    (await owner.query<PageRow>(`SELECT page, text, extra, served_sha256, text_version, item_id FROM ${table} WHERE file_id = $1 ORDER BY page`, [fileId])).rows;
  const pid = async (client: pg.Client): Promise<number> => (await client.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid;
  /** Resolves once the backend is waiting on a lock; fails the test if it never is. */
  const blocked = async (backend: number): Promise<void> => {
    for (let tries = 0; tries < 200; tries++) {
      const { rows } = await owner.query<{ wait: string | null }>(`SELECT wait_event_type AS wait FROM pg_stat_activity WHERE pid = $1`, [backend]);
      if (rows[0]?.wait === 'Lock') return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect.fail('the second connection was never blocked on a lock');
  };
  /** A query's outcome, never a rejection, so it can be left running while the other connection goes on. */
  const outcome = (client: pg.Client, sql: string, values: unknown[]): Promise<string> =>
    client.query(sql, values).then(
      () => 'ok',
      (error: { code?: string }) => error.code ?? 'no-code',
    );

  beforeAll(async () => {
    api = await startApi('nwfl_search0032');
    office = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ('publications', 'Publications Officer', 'appointed') RETURNING id`);
    database = (await api.pool.query<{ db: string }>(`SELECT current_database() AS db`)).rows[0]!.db;
    const connect = async (connectionString: string): Promise<pg.Client> => {
      const client = new pg.Client({ connectionString });
      await client.connect();
      return client;
    };
    owner = await connect(urlFor('postgres', new URL(url as string).password, database));
    app = await connect(urlFor(APP, APP_PW, database));
    worker = await connect(urlFor(WORKER, WORKER_PW, database));
    other = await connect(urlFor('postgres', new URL(url as string).password, database));
    // A role with nothing but the schema: what PUBLIC holds. Roles are cluster-wide, so its name is random.
    nobody = `nwfl_nobody_${randomBytes(4).toString('hex')}`;
    await owner.query(`CREATE ROLE ${nobody} NOLOGIN`);
    await owner.query(`GRANT USAGE ON SCHEMA public TO ${nobody}`);
  });

  afterAll(async () => {
    await other?.query(`RESET ROLE`).catch(() => undefined);
    await owner?.query(`REVOKE USAGE ON SCHEMA public FROM ${nobody}`).catch(() => undefined);
    await owner?.query(`DROP ROLE IF EXISTS ${nobody}`).catch(() => undefined);
    for (const client of [owner, app, worker, other]) await client?.end();
    await api?.close();
  });

  describe('the tables', () => {
    it('are four, one per audience and kind, and none has an audience column', async () => {
      const { rows } = await owner.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name LIKE 'search\\_%' ORDER BY table_name, ordinal_position`,
      );
      const columns = (table: string): string[] => rows.filter((row) => row.table_name === table).map((row) => row.column_name);
      expect([...new Set(rows.map((row) => row.table_name))].sort()).toEqual([...TABLES].sort());
      for (const table of ['search_page_public', 'search_page_members']) {
        expect(columns(table)).toEqual(['file_id', 'item_id', 'page', 'served_sha256', 'text_version', 'text', 'extra', 'tsv']);
      }
      for (const table of ['search_item_public', 'search_item_members']) {
        expect(columns(table)).toEqual(['item_id', 'version_id', 'rendered_sha256', 'title', 'text', 'tsv']);
      }
      expect(rows.filter((row) => /audience/.test(row.column_name))).toEqual([]);
    });

    it('each have a GIN index over a generated tsv', async () => {
      const { rows } = await owner.query<{ tablename: string; indexdef: string }>(`SELECT tablename, indexdef FROM pg_indexes WHERE tablename LIKE 'search\\_%' AND indexdef LIKE '%gin%'`);
      expect(rows.map((row) => row.tablename).sort()).toEqual([...TABLES].sort());
      for (const row of rows) expect(row.indexdef).toMatch(/USING gin \(tsv\)/);
      const generated = await owner.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.columns WHERE table_name LIKE 'search\\_%' AND column_name = 'tsv' AND is_generated = 'ALWAYS'`,
      );
      expect(generated.rows).toHaveLength(4);
    });

    it('lose their page rows with the file (the foreign key cascades)', async () => {
      const { rows } = await owner.query<{ conrelid: string; confdeltype: string }>(
        `SELECT conrelid::regclass::text AS conrelid, confdeltype FROM pg_constraint WHERE contype = 'f' AND conrelid::regclass::text LIKE 'search\\_%'`,
      );
      expect(rows.length).toBeGreaterThanOrEqual(6);
      for (const row of rows) expect(row.confdeltype, row.conrelid).toBe('c');
    });
  });

  describe('who may write', () => {
    it('refuses every role but the definers INSERT, UPDATE, DELETE and TRUNCATE on all four tables (42501)', async () => {
      const as = async (role: string, sql: string): Promise<string> => {
        await other.query(`SET ROLE ${role}`);
        try {
          return await sqlstate(other, sql);
        } finally {
          await other.query(`RESET ROLE`);
        }
      };
      for (const role of [APP, WORKER, nobody]) {
        for (const table of TABLES) {
          const where = `${role} on ${table}`;
          expect(await as(role, `INSERT INTO ${table} DEFAULT VALUES`), where).toBe('42501');
          expect(await as(role, `UPDATE ${table} SET text = 'x'`), where).toBe('42501');
          expect(await as(role, `DELETE FROM ${table}`), where).toBe('42501');
          expect(await as(role, `TRUNCATE ${table}`), where).toBe('42501');
        }
      }
    });

    it('holds over real connections too: the app reads and writes nothing, the worker neither reads nor writes', async () => {
      for (const table of TABLES) {
        expect(await sqlstate(app, `SELECT count(*) FROM ${table}`), table).toBe('ok');
        expect(await sqlstate(app, `INSERT INTO ${table} DEFAULT VALUES`), table).toBe('42501');
        expect(await sqlstate(app, `UPDATE ${table} SET text = 'x'`), table).toBe('42501');
        expect(await sqlstate(app, `DELETE FROM ${table}`), table).toBe('42501');
        expect(await sqlstate(worker, `SELECT count(*) FROM ${table}`), table).toBe('42501');
        expect(await sqlstate(worker, `INSERT INTO ${table} DEFAULT VALUES`), table).toBe('42501');
        expect(await sqlstate(worker, `UPDATE ${table} SET text = 'x'`), table).toBe('42501');
        expect(await sqlstate(worker, `DELETE FROM ${table}`), table).toBe('42501');
      }
    });

    it('gives the page writer to the worker alone and the item writer to the app alone', async () => {
      const id = '00000000-0000-4000-8000-000000000001';
      expect(await sqlstate(app, PUT, [id, 'public', sha('x'), 1, ['a'], ['']])).toBe('42501');
      expect(await sqlstate(worker, `SELECT search_item_put($1, 'public', $2, 't', 'x')`, [id, sha('x')])).toBe('42501');
      await other.query(`SET ROLE ${nobody}`);
      try {
        expect(await sqlstate(other, PUT, [id, 'public', sha('x'), 1, ['a'], ['']])).toBe('42501');
        expect(await sqlstate(other, `SELECT search_item_put($1, 'public', $2, 't', 'x')`, [id, sha('x')])).toBe('42501');
        expect(await sqlstate(other, `SELECT pdf_regen_request(ARRAY[$1::uuid])`, [id])).toBe('42501');
      } finally {
        await other.query(`RESET ROLE`);
      }
    });

    it('runs both writers and the unservable trigger as their owner with a pinned search_path, and keeps pdf_regen_request an invoker function with one', async () => {
      const { rows } = await owner.query<{ proname: string; prosecdef: boolean; proconfig: string[] | null }>(
        `SELECT proname, prosecdef, proconfig FROM pg_proc WHERE proname IN ('search_page_put', 'search_item_put', 'search_page_unservable', 'pdf_regen_request') ORDER BY proname`,
      );
      expect(rows.map((row) => [row.proname, row.prosecdef])).toEqual([
        ['pdf_regen_request', false],
        ['search_item_put', true],
        ['search_page_put', true],
        ['search_page_unservable', true],
      ]);
      for (const row of rows) expect(row.proconfig, row.proname).toEqual(['search_path=pg_catalog, public, pg_temp']);
    });
  });

  describe('search_page_put', () => {
    it('stores the pages of the copy the ledger says is served, per audience, and replaces them on the next put', async () => {
      const { fileId, itemId } = await fileItem();
      await serve('stored_file', fileId, 'public', sha('copy-1'));
      await serve('stored_file', fileId, 'members', sha('copy-m'));
      const put = await worker.query<{ pages: number }>(PUT, [fileId, 'public', sha('copy-1'), 1, ['first page', 'second page', 'third page'], ['', 'kept-form', '']]);
      expect(put.rows[0]!.pages).toBe(3);
      expect(await pages('search_page_public', fileId)).toEqual([
        { page: 1, text: 'first page', extra: '', served_sha256: sha('copy-1'), text_version: 1, item_id: itemId },
        { page: 2, text: 'second page', extra: 'kept-form', served_sha256: sha('copy-1'), text_version: 1, item_id: itemId },
        { page: 3, text: 'third page', extra: '', served_sha256: sha('copy-1'), text_version: 1, item_id: itemId },
      ]);
      expect(await pages('search_page_members', fileId)).toEqual([]);
      await worker.query(PUT, [fileId, 'members', sha('copy-m'), 2, ['members page'], ['']]);
      expect((await pages('search_page_members', fileId)).map((row) => [row.page, row.text, row.text_version])).toEqual([[1, 'members page', 2]]);
      // A shorter copy replaces every row of the longer one, and only its own audience's.
      await worker.query(PUT, [fileId, 'public', sha('copy-1'), 2, ['only page'], ['']]);
      expect((await pages('search_page_public', fileId)).map((row) => [row.page, row.text, row.text_version])).toEqual([[1, 'only page', 2]]);
      expect(await pages('search_page_members', fileId)).toHaveLength(1);
    });

    it('refuses a sha that is not the ledger\'s current output: stale, never served, or no row at all (55000)', async () => {
      const { fileId } = await fileItem();
      expect(await sqlstate(worker, PUT, [fileId, 'public', sha('a'), 1, ['never served'], ['']])).toBe('55000');
      await serve('stored_file', fileId, 'public', sha('a'));
      expect(await sqlstate(worker, PUT, [fileId, 'public', sha('b'), 1, ['another sha'], ['']])).toBe('55000');
      expect(await sqlstate(worker, PUT, [fileId, 'members', sha('a'), 1, ['another audience'], ['']])).toBe('55000');
      expect(await sqlstate(worker, PUT, [fileId, 'public', sha('a'), 1, ['served now'], ['']])).toBe('ok');
      // The ledger moves on: the sha that was good is stale, and what is served next is good.
      await serve('stored_file', fileId, 'public', sha('c'));
      expect(await sqlstate(worker, PUT, [fileId, 'public', sha('a'), 1, ['stale'], ['']])).toBe('55000');
      expect((await pages('search_page_public', fileId)).map((row) => row.text)).toEqual(['served now']);
      expect(await sqlstate(worker, PUT, [fileId, 'public', sha('c'), 1, ['current'], ['']])).toBe('ok');
      // Nothing served: nothing to index.
      await serve('stored_file', fileId, 'public', null, { v: 1, served: 'not_ready' });
      expect(await sqlstate(worker, PUT, [fileId, 'public', sha('c'), 1, ['withdrawn'], ['']])).toBe('55000');
    });

    it('reads only the file\'s own ledger row: not a version\'s row with the same id, nor another tenant\'s (55000)', async () => {
      const { fileId } = await fileItem();
      await owner.query('BEGIN');
      try {
        // A content_version row carrying the file's id, saying a copy is served.
        await serve('content_version', fileId, 'public', sha('kind'), COPY, owner);
        expect(await sqlstate(owner, PUT, [fileId, 'public', sha('kind'), 1, ['a version row'], ['']])).toBe('55000');
      } finally {
        await owner.query('ROLLBACK');
      }
      await owner.query('BEGIN');
      try {
        // A stored_file row for this file under another tenant, saying a copy is served.
        await owner.query(`INSERT INTO tenant (id, name) VALUES ('other-group', 'Another synthetic group')`);
        await owner.query(
          `INSERT INTO publication_ledger (seq, tenant_id, subject_kind, subject_id, audience, output_sha256, inputs, passages_withheld, current_from, prev_hash, row_hash)
           VALUES (9000000000000000, 'other-group', 'stored_file', $1, 'public', $2, $3, 0, now(), $4, $5)`,
          [fileId, sha('tenant'), COPY, sha('prev'), sha(`row-${fileId}`)],
        );
        expect(await sqlstate(owner, PUT, [fileId, 'public', sha('tenant'), 1, ['another tenant'], ['']])).toBe('55000');
      } finally {
        await owner.query('ROLLBACK');
      }
      // The control: the file's own row, under this tenant, is read.
      await serve('stored_file', fileId, 'public', sha('own'));
      expect(await sqlstate(worker, PUT, [fileId, 'public', sha('own'), 1, ['its own row'], ['']])).toBe('ok');
    });

    it('refuses an audience served the original: only a copy is indexed (55000)', async () => {
      const { fileId } = await fileItem();
      await serve('stored_file', fileId, 'members', sha('original'), { v: 1, served: 'original' });
      expect(await sqlstate(worker, PUT, [fileId, 'members', sha('original'), 1, ['the original text'], ['']])).toBe('55000');
      expect(await pages('search_page_members', fileId)).toEqual([]);
    });

    it('refuses what is not a put: another audience, no file, no sha, no version, and pages over the caps (22023)', async () => {
      const { fileId } = await fileItem();
      await serve('stored_file', fileId, 'public', sha('caps'));
      const good: [string, string, Buffer | null, number | null, string[] | null, string[] | null] = [fileId, 'public', sha('caps'), 1, ['a'], ['']];
      const bad = (change: Partial<Record<0 | 1 | 2 | 3 | 4 | 5, unknown>>): unknown[] => good.map((value, at) => (at in change ? change[at as 0] : value));
      for (const [why, values] of [
        ['officers', bad({ 1: 'officers' })],
        ['no audience', bad({ 1: null })],
        ['no file', bad({ 0: null })],
        ['unknown file', bad({ 0: '00000000-0000-4000-8000-00000000dead' })],
        ['no sha', bad({ 2: null })],
        ['no version', bad({ 3: null })],
        ['version 0', bad({ 3: 0 })],
        ['no pages', bad({ 4: null })],
        ['zero pages', bad({ 4: [], 5: [] })],
        ['a null page', bad({ 4: [null] })],
        ['no extras', bad({ 5: null })],
        ['extras of another length', bad({ 5: ['', ''] })],
        ['a null extra', bad({ 5: [null] })],
        ['301 pages', bad({ 4: Array.from({ length: 301 }, () => 'p'), 5: Array.from({ length: 301 }, () => '') })],
        ['a page over 64 KiB', bad({ 4: ['x'.repeat(65_537)] })],
        ['an extra over 64 KiB', bad({ 5: ['x'.repeat(65_537)] })],
        ['over 4 MiB in all', bad({ 4: Array.from({ length: 65 }, () => 'x '.repeat(32_768)), 5: Array.from({ length: 65 }, () => '') })],
      ] as const) {
        expect(await sqlstate(worker, PUT, values), why).toBe('22023');
      }
      expect(await pages('search_page_public', fileId)).toEqual([]);
      // At the caps it is taken: 300 pages, and a page of exactly 64 KiB.
      expect(await sqlstate(worker, PUT, bad({ 4: ['x '.repeat(32_768), ...Array.from({ length: 299 }, () => 'p')], 5: Array.from({ length: 300 }, () => '') }))).toBe('ok');
      expect(await pages('search_page_public', fileId)).toHaveLength(300);
    });

    it('finds a word split at a line end, a soft-hyphened word, a compound and a word beside a label as typed (the hyphen fixture, through the index)', async () => {
      const { fileId } = await fileItem();
      await serve('stored_file', fileId, 'public', sha('hyphens'));
      const fixture = JSON.parse(readFileSync(new URL('../fixtures/hyphen-cases.json', import.meta.url), 'utf8')) as {
        cases: Array<{ name: string; items: Array<{ str: string; hasEOL?: boolean }> }>;
      };
      const byName = (name: string) => pageText(fixture.cases.find((entry) => entry.name === name)!.items);
      const made = [
        byName('a word split at a line end is one word'),
        byName('a soft hyphen inside a word folds to nothing'),
        byName('a real compound split at a line end keeps its typed form in extra'),
        byName('a soft hyphen at a line end joins, with no kept form'),
        byName('a label drawn beside a word is its own word'),
        byName('a drop capital is found as the word it starts'),
      ];
      await worker.query(PUT, [fileId, 'public', sha('hyphens'), 1, made.map((page) => page.text), made.map((page) => page.extra)]);
      const hits = async (typed: string): Promise<number[]> =>
        (await app.query<{ page: number }>(`SELECT page FROM search_page_public WHERE file_id = $1 AND tsv @@ websearch_to_tsquery('english', $2) ORDER BY page`, [fileId, typed])).rows.map(
          (row) => row.page,
        );
      expect(await hits('members group')).toEqual([1]);
      expect(await hits('"members meet"')).toEqual([2, 4]);
      expect(await hits('well-known')).toEqual([3]);
      expect(await hits('wellknown')).toEqual([3]);
      expect(await hits('zephyrine')).toEqual([]);
      // Items that meet on a line: the word beside a label is found on its own, and the label is a word of its own.
      expect(await hits('today')).toEqual([5]);
      expect(await hits('"today private"')).toEqual([5]);
      expect(await hits('welcome')).toEqual([6]);
    });
  });

  describe('pdf_regen_request', () => {
    it('deletes both audiences\' page rows for its files, and only those, in the caller\'s transaction', async () => {
      const first = await fileItem();
      const second = await fileItem();
      for (const { fileId } of [first, second]) {
        for (const audience of ['public', 'members']) {
          await serve('stored_file', fileId, audience, sha(`${fileId}-${audience}`));
          await worker.query(PUT, [fileId, audience, sha(`${fileId}-${audience}`), 1, ['one', 'two'], ['', '']]);
        }
      }
      await owner.query('BEGIN');
      await owner.query(`SELECT pdf_regen_request(ARRAY[$1::uuid])`, [first.fileId]);
      // Still there for everyone else until the change commits; gone with a rollback's undoing.
      expect((await app.query(`SELECT 1 FROM search_page_public WHERE file_id = $1`, [first.fileId])).rowCount).toBe(2);
      await owner.query('ROLLBACK');
      expect(await pages('search_page_public', first.fileId)).toHaveLength(2);
      await owner.query(`SELECT pdf_regen_request(ARRAY[$1::uuid])`, [first.fileId]);
      expect(await pages('search_page_public', first.fileId)).toEqual([]);
      expect(await pages('search_page_members', first.fileId)).toEqual([]);
      expect(await pages('search_page_public', second.fileId)).toHaveLength(2);
      expect(await pages('search_page_members', second.fileId)).toHaveLength(2);
      // It still queues the file, as before 0032.
      expect((await owner.query(`SELECT 1 FROM pdf_regen WHERE file_id = $1`, [first.fileId])).rowCount).toBe(1);
    });

    it('deletes them when a mark is made on the file\'s item: the trigger\'s own path', async () => {
      const { fileId, itemId } = await fileItem();
      await serve('stored_file', fileId, 'public', sha('before-mark'));
      await worker.query(PUT, [fileId, 'public', sha('before-mark'), 1, ['Call Quillon Brask'], ['']]);
      expect(await pages('search_page_public', fileId)).toHaveLength(1);
      await owner.query(
        `INSERT INTO redaction_mark (content_item_id, field, quote, category, created_by_sub) VALUES ($1, 'body', 'Quillon Brask', 'private_venue', 'sub-officer')`,
        [itemId],
      );
      expect(await pages('search_page_public', fileId)).toEqual([]);
    });
  });

  describe('races (two connections)', () => {
    let workerPid: number;
    let otherPid: number;
    beforeAll(async () => {
      workerPid = await pid(worker);
      otherPid = await pid(other);
    });

    it('a put that arrives while a change holds the file waits, then finds the ledger moved on and leaves no row', async () => {
      const { fileId } = await fileItem();
      await serve('stored_file', fileId, 'public', sha('race-1'));
      await owner.query('BEGIN');
      await owner.query(`SELECT pdf_regen_request(ARRAY[$1::uuid])`, [fileId]);
      const put = outcome(worker, PUT, [fileId, 'public', sha('race-1'), 1, ['the old copy'], ['']]);
      await blocked(workerPid);
      await serve('stored_file', fileId, 'public', null, { v: 1, served: 'not_ready' }, owner);
      await owner.query('COMMIT');
      expect(await put).toBe('55000');
      expect(await pages('search_page_public', fileId)).toEqual([]);
    });

    it('a change that arrives while a put holds the file waits, then deletes the rows the put wrote', async () => {
      const { fileId } = await fileItem();
      await serve('stored_file', fileId, 'public', sha('race-2'));
      await worker.query('BEGIN');
      await worker.query(PUT, [fileId, 'public', sha('race-2'), 1, ['the old copy'], ['']]);
      const change = outcome(other, `SELECT pdf_regen_request(ARRAY[$1::uuid])`, [fileId]);
      await blocked(otherPid);
      await worker.query('COMMIT');
      expect(await change).toBe('ok');
      expect(await pages('search_page_public', fileId)).toEqual([]);
    });

    it('two puts on one file: the second waits for the first, and its pages replace the first\'s whole', async () => {
      const { fileId } = await fileItem();
      await serve('stored_file', fileId, 'public', sha('race-two'));
      const second = new pg.Client({ connectionString: urlFor(WORKER, WORKER_PW, database) });
      await second.connect();
      try {
        const secondPid = await pid(second);
        await worker.query('BEGIN');
        await worker.query(PUT, [fileId, 'public', sha('race-two'), 1, ['a1', 'a2', 'a3'], ['', '', '']]);
        const put = outcome(second, PUT, [fileId, 'public', sha('race-two'), 1, ['b1'], ['']]);
        await blocked(secondPid);
        await worker.query('COMMIT');
        expect(await put).toBe('ok');
        expect((await pages('search_page_public', fileId)).map((row) => row.text)).toEqual(['b1']);
      } finally {
        await second.end();
      }
    });

    it('a put that arrives while the ledger row is being replaced waits, then refuses the old sha', async () => {
      const { fileId } = await fileItem();
      await serve('stored_file', fileId, 'public', sha('race-3'));
      await owner.query('BEGIN');
      // The worker's own append, which takes no file lock: a new copy becomes current.
      await serve('stored_file', fileId, 'public', sha('race-3-next'), COPY, owner);
      const put = outcome(worker, PUT, [fileId, 'public', sha('race-3'), 1, ['the old copy'], ['']]);
      await blocked(workerPid);
      await owner.query('COMMIT');
      expect(await put).toBe('55000');
      expect(await pages('search_page_public', fileId)).toEqual([]);
    });
  });

  describe('search_item_put', () => {
    const ITEM_PUT = `SELECT search_item_put($1, $2, $3, $4, $5)`;
    interface StoredItem {
      version_id: string;
      rendered_sha256: Buffer;
      title: string;
      text: string;
    }
    const items = async (table: string, itemId: string): Promise<StoredItem[]> =>
      (await owner.query<StoredItem>(`SELECT version_id, rendered_sha256, title, text FROM ${table} WHERE item_id = $1`, [itemId])).rows;
    const article = async (): Promise<{ itemId: string; versionId: string }> =>
      publishItem(api.pool, { slug: `search-item-${++counter}`, officeId: office, title: 'Synthetic news', body: { blocks: [paragraph(text('Synthetic.'))] } });

    it('stores one row per item for the output the ledger says is current, and refuses any other sha (55000)', async () => {
      const { itemId, versionId } = await article();
      expect(await sqlstate(app, ITEM_PUT, [versionId, 'public', sha('i1'), 'Title', 'never recorded'])).toBe('55000');
      await serve('content_version', versionId, 'public', sha('i1'));
      expect(await sqlstate(app, ITEM_PUT, [versionId, 'public', sha('i0'), 'Title', 'another sha'])).toBe('55000');
      expect(await sqlstate(app, ITEM_PUT, [versionId, 'members', sha('i1'), 'Title', 'another audience'])).toBe('55000');
      expect(await sqlstate(app, ITEM_PUT, [versionId, 'public', sha('i1'), 'Title', 'the picnic is on'])).toBe('ok');
      expect(await items('search_item_public', itemId)).toEqual([{ version_id: versionId, rendered_sha256: sha('i1'), title: 'Title', text: 'the picnic is on' }]);
      expect(await items('search_item_members', itemId)).toEqual([]);
      expect((await app.query(`SELECT 1 FROM search_item_public WHERE item_id = $1 AND tsv @@ websearch_to_tsquery('english', 'picnic')`, [itemId])).rowCount).toBe(1);
      expect((await app.query(`SELECT 1 FROM search_item_public WHERE item_id = $1 AND tsv @@ websearch_to_tsquery('english', 'title')`, [itemId])).rowCount).toBe(1);
      // The ledger moves on: the old sha is stale; the new one replaces the row.
      await serve('content_version', versionId, 'public', sha('i2'));
      expect(await sqlstate(app, ITEM_PUT, [versionId, 'public', sha('i1'), 'Title', 'stale'])).toBe('55000');
      expect(await sqlstate(app, ITEM_PUT, [versionId, 'public', sha('i2'), 'Title two', 'the picnic moved'])).toBe('ok');
      expect(await items('search_item_public', itemId)).toEqual([{ version_id: versionId, rendered_sha256: sha('i2'), title: 'Title two', text: 'the picnic moved' }]);
    });

    it('deletes the row when the audience is given nothing, or nothing to index, still only on the ledger\'s word', async () => {
      const { itemId, versionId } = await article();
      await serve('content_version', versionId, 'members', sha('m1'));
      await app.query(ITEM_PUT, [versionId, 'members', sha('m1'), 'Title', 'members text']);
      // A null output while the ledger still serves one is refused.
      expect(await sqlstate(app, ITEM_PUT, [versionId, 'members', null, null, null])).toBe('55000');
      expect(await items('search_item_members', itemId)).toHaveLength(1);
      // Given something with nothing to index (a withdrawn item's stub): the row goes.
      expect(await sqlstate(app, ITEM_PUT, [versionId, 'members', sha('m1'), null, null])).toBe('ok');
      expect(await items('search_item_members', itemId)).toEqual([]);
      await app.query(ITEM_PUT, [versionId, 'members', sha('m1'), 'Title', 'members text']);
      // Given nothing at all.
      await serve('content_version', versionId, 'members', null, { v: 1 });
      expect(await sqlstate(app, ITEM_PUT, [versionId, 'members', sha('m1'), 'Title', 'stale'])).toBe('55000');
      expect(await sqlstate(app, ITEM_PUT, [versionId, 'members', null, null, null])).toBe('ok');
      expect(await items('search_item_members', itemId)).toEqual([]);
      // A subject the ledger never held and that is no version: nothing to delete, nothing raised.
      expect(await sqlstate(app, ITEM_PUT, ['00000000-0000-4000-8000-00000000beef', 'public', null, null, null])).toBe('ok');
    });

    it('refuses what is not a put: officers, no version, an unknown version, no text, and text over the caps (22023)', async () => {
      const { itemId, versionId } = await article();
      await serve('content_version', versionId, 'public', sha('c1'));
      const ghost = '00000000-0000-4000-8000-00000000f00d';
      await serve('content_version', ghost, 'public', sha('ghost'));
      expect(await sqlstate(app, ITEM_PUT, [versionId, 'officers', sha('c1'), 'T', 'x'])).toBe('22023');
      expect(await sqlstate(app, ITEM_PUT, [versionId, null, sha('c1'), 'T', 'x'])).toBe('22023');
      expect(await sqlstate(app, ITEM_PUT, [null, 'public', sha('c1'), 'T', 'x'])).toBe('22023');
      expect(await sqlstate(app, ITEM_PUT, [ghost, 'public', sha('ghost'), 'T', 'x'])).toBe('22023');
      expect(await sqlstate(app, ITEM_PUT, [versionId, 'public', sha('c1'), 'T', null])).toBe('22023');
      expect(await sqlstate(app, ITEM_PUT, [versionId, 'public', sha('c1'), 'T'.repeat(1025), 'x'])).toBe('22023');
      expect(await sqlstate(app, ITEM_PUT, [versionId, 'public', sha('c1'), 'T', 'x'.repeat(131_073)])).toBe('22023');
      expect(await items('search_item_public', itemId)).toEqual([]);
      expect(await sqlstate(app, ITEM_PUT, [versionId, 'public', sha('c1'), 'T'.repeat(1024), 'x '.repeat(65_536)])).toBe('ok');
    });

    it('a put that arrives while the ledger row is being replaced waits, then refuses the old sha', async () => {
      const { itemId, versionId } = await article();
      await serve('content_version', versionId, 'public', sha('r1'));
      const appPid = await pid(app);
      await owner.query('BEGIN');
      await serve('content_version', versionId, 'public', sha('r2'), { v: 1 }, owner);
      const put = outcome(app, ITEM_PUT, [versionId, 'public', sha('r1'), 'Title', 'the old text']);
      await blocked(appPid);
      await owner.query('COMMIT');
      expect(await put).toBe('55000');
      expect(await items('search_item_public', itemId)).toEqual([]);
    });
  });

  it('is additive: 0032 changes no table or function that 0031 had, but pdf_regen_request and the worker\'s grants', () => {
    const sql = readFileSync(new URL('../../migrations/0032_search.sql', import.meta.url), 'utf8').replace(/--[^\n]*/g, '');
    expect(sql).not.toMatch(/\b(DROP|ALTER)\s+(TABLE|FUNCTION|INDEX|TRIGGER|COLUMN)\b/i);
    const replaced = [...sql.matchAll(/CREATE OR REPLACE FUNCTION (\w+)/g)].map((match) => match[1]);
    expect(replaced.sort()).toEqual(['nwfl_worker_grants', 'pdf_regen_request']);
    expect(sql).not.toMatch(/search_public|search_members/);
  });
});
