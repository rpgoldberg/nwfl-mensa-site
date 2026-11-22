// ARCHIVE-SEARCH S2: 0033_search_worker.sql. What the worker's index job needs beside the page
// writer, and no more: which files lack their text (search_page_lacking) and the removal of rows no
// audience is served any longer (search_page_sweep). Both are definer functions, so the worker reads
// neither the index nor the ledger. Run against a real Postgres as the app role, the worker role and
// a role with no grants. Everything here is synthetic: no PDF is opened, and every name is made up.
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Api, insertId, startApi } from '../helpers/api.js';
import { paragraph, publishItem, text } from '../helpers/content.js';
import { APP, APP_PW, WORKER, WORKER_PW, live, sqlstate, url, urlFor } from '../helpers/pg.js';

const sha = (seed: string): Buffer => createHash('sha256').update(seed).digest();
const PUT = `SELECT search_page_put($1, $2, $3, $4, $5::text[], $6::text[]) AS pages`;
const PAGE_TABLES = ['search_page_public', 'search_page_members'] as const;

describe.skipIf(!live)('0033: what the worker\'s index job may do', () => {
  let api: Api;
  let owner: pg.Client;
  let app: pg.Client;
  let worker: pg.Client;
  let other: pg.Client;
  let office: string;
  let nobody: string;
  let counter = 0;

  const fileItem = async (audience: 'public' | 'members' = 'public'): Promise<{ itemId: string; fileId: string }> => {
    const n = ++counter;
    const bytes = Buffer.from(`synthetic file ${n}`);
    const made = await publishItem(api.pool, {
      slug: `sweep-file-${n}`,
      officeId: office,
      title: `Synthetic issue ${n}`,
      body: { blocks: [paragraph(text('A synthetic issue.'))] },
      files: [{ objectKey: `sweep-${n}.pdf`, audience, bytes }],
    });
    const fileId = (await api.pool.query<{ id: string }>(`SELECT id FROM stored_file WHERE version_id = $1`, [made.versionId])).rows[0]!.id;
    await api.pool.query(`SELECT pdf_original_put($1, $2, 'sub-author', ARRAY['nwfl-officers'], NULL)`, [fileId, bytes]);
    return { itemId: made.itemId, fileId };
  };
  /** What the ledger says this audience is given for the subject, as the app's own writer records it. */
  const serve = (kind: string, subject: string, audience: string, output: Buffer | null, served = 'copy') =>
    api.pool.query(`SELECT publication_ledger_record($1, $2, $3, $4, $5, 0)`, [kind, subject, audience, output, { v: 1, served }]);
  const put = (fileId: string, audience: string, seed: string, version = 1, pages = ['a page']) => worker.query(PUT, [fileId, audience, sha(seed), version, pages, pages.map(() => '')]);
  const count = async (table: string, fileId: string): Promise<number> => (await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE file_id = $1`, [fileId])).rows[0]!.n;
  const lacking = async (version = 1): Promise<string[]> =>
    (await worker.query<{ file_id: string; audience: string }>(`SELECT file_id, audience FROM search_page_lacking($1)`, [version])).rows.map((row) => `${row.file_id} ${row.audience}`);
  const sweep = async (): Promise<number> => (await worker.query<{ n: number }>(`SELECT search_page_sweep() AS n`)).rows[0]!.n;
  /** A row the writers would never leave: put there by the owner, as a fault would. */
  const plant = (table: string, fileId: string, seed: string, words = 'planted words') =>
    owner.query(`INSERT INTO ${table} (file_id, page, served_sha256, text_version, text, extra) VALUES ($1, 1, $2, 1, $3, '')`, [fileId, sha(seed), words]);

  beforeAll(async () => {
    api = await startApi('nwfl_search0033');
    office = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ('publications', 'Publications Officer', 'appointed') RETURNING id`);
    const database = (await api.pool.query<{ db: string }>(`SELECT current_database() AS db`)).rows[0]!.db;
    const connect = async (connectionString: string): Promise<pg.Client> => {
      const client = new pg.Client({ connectionString });
      await client.connect();
      return client;
    };
    const superuser = new URL(url as string).password;
    owner = await connect(urlFor('postgres', superuser, database));
    other = await connect(urlFor('postgres', superuser, database));
    app = await connect(urlFor(APP, APP_PW, database));
    worker = await connect(urlFor(WORKER, WORKER_PW, database));
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

  describe('least privilege', () => {
    it('gives the two functions to the worker alone: not the app, not PUBLIC', async () => {
      for (const sql of [`SELECT search_page_sweep()`, `SELECT * FROM search_page_lacking(1)`]) {
        expect(await sqlstate(worker, sql), sql).toBe('ok');
        expect(await sqlstate(app, sql), sql).toBe('42501');
        await other.query(`SET ROLE ${nobody}`);
        try {
          expect(await sqlstate(other, sql), sql).toBe('42501');
        } finally {
          await other.query(`RESET ROLE`);
        }
      }
    });

    it('runs both as their owner with a pinned search_path', async () => {
      const { rows } = await owner.query<{ proname: string; prosecdef: boolean; proconfig: string[] | null; owner: string }>(
        `SELECT proname, prosecdef, proconfig, pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE proname IN ('search_page_sweep', 'search_page_lacking') ORDER BY proname`,
      );
      expect(rows).toEqual([
        { proname: 'search_page_lacking', prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'], owner: 'nwfl_migrator' },
        { proname: 'search_page_sweep', prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'], owner: 'nwfl_migrator' },
      ]);
    });

    it('still lets the worker read no index table and no ledger row, and write neither', async () => {
      for (const table of [...PAGE_TABLES, 'search_item_public', 'search_item_members', 'publication_ledger']) {
        expect(await sqlstate(worker, `SELECT count(*) FROM ${table}`), table).toBe('42501');
        expect(await sqlstate(worker, `DELETE FROM ${table}`), table).toBe('42501');
        expect(await sqlstate(worker, `INSERT INTO ${table} DEFAULT VALUES`), table).toBe('42501');
      }
      const { rows } = await owner.query<{ table_name: string }>(
        `SELECT DISTINCT c.table_name FROM information_schema.columns c
          WHERE c.table_schema = 'public' AND (c.table_name LIKE 'search\\_%' OR c.table_name LIKE 'publication\\_ledger%')
            AND has_column_privilege($1, format('public.%I', c.table_name), c.column_name, 'SELECT')`,
        [WORKER],
      );
      expect(rows).toEqual([]);
    });

    it('leaves the page writer the worker\'s and the item writer the app\'s (0032), and the app\'s read of the tables', async () => {
      const id = '00000000-0000-4000-8000-000000000001';
      expect(await sqlstate(app, PUT, [id, 'public', sha('x'), 1, ['a'], ['']])).toBe('42501');
      expect(await sqlstate(worker, PUT, [id, 'public', sha('x'), 1, ['a'], ['']])).toBe('22023');
      expect(await sqlstate(worker, `SELECT search_item_put($1, 'public', $2, 't', 'x')`, [id, sha('x')])).toBe('42501');
      for (const table of PAGE_TABLES) expect(await sqlstate(app, `SELECT count(*) FROM ${table}`), table).toBe('ok');
    });
  });

  describe('search_page_lacking', () => {
    it('lists a file for each audience the ledger says is served a copy whose text is not there at this version', async () => {
      const { fileId } = await fileItem();
      expect(await lacking()).not.toContain(`${fileId} public`);
      await serve('stored_file', fileId, 'public', sha('copy-1'));
      expect((await lacking()).filter((line) => line.startsWith(fileId))).toEqual([`${fileId} public`]);
      await serve('stored_file', fileId, 'members', sha('copy-m'));
      expect((await lacking()).filter((line) => line.startsWith(fileId))).toEqual([`${fileId} members`, `${fileId} public`]);
      await put(fileId, 'public', 'copy-1');
      expect((await lacking()).filter((line) => line.startsWith(fileId))).toEqual([`${fileId} members`]);
      await put(fileId, 'members', 'copy-m');
      expect((await lacking()).filter((line) => line.startsWith(fileId))).toEqual([]);
      // Another version of the rule: both again.
      expect((await lacking(2)).filter((line) => line.startsWith(fileId))).toEqual([`${fileId} members`, `${fileId} public`]);
      await put(fileId, 'public', 'copy-1', 2);
      expect((await lacking(2)).filter((line) => line.startsWith(fileId))).toEqual([`${fileId} members`]);
      expect((await lacking(1)).filter((line) => line.startsWith(fileId))).toEqual([`${fileId} public`]);
    });

    it('lists a file whose rows are of another copy than the one served now', async () => {
      const { fileId } = await fileItem();
      await serve('stored_file', fileId, 'public', sha('copy-1'));
      await put(fileId, 'public', 'copy-1');
      // The ledger moves on with no request (the worker's own append of a new copy).
      await serve('stored_file', fileId, 'public', sha('copy-2'));
      expect((await lacking()).filter((line) => line.startsWith(fileId))).toEqual([`${fileId} public`]);
    });

    it('never lists an audience served the original, nothing, or officers, nor a subject that is no file', async () => {
      const { fileId, itemId } = await fileItem();
      await serve('stored_file', fileId, 'public', sha('the original'), 'original');
      await serve('stored_file', fileId, 'members', null, 'hidden');
      await serve('stored_file', fileId, 'officers', sha('copy-o'));
      const version = (await owner.query<{ id: string }>(`SELECT live_version_id AS id FROM content_item WHERE id = $1`, [itemId])).rows[0]!.id;
      await serve('content_version', version, 'public', sha('an item'));
      const listed = await lacking();
      expect(listed.filter((line) => line.startsWith(fileId) || line.startsWith(version))).toEqual([]);
    });

    it('refuses a version that is none', async () => {
      expect(await sqlstate(worker, `SELECT * FROM search_page_lacking(NULL)`)).toBe('22023');
      expect(await sqlstate(worker, `SELECT * FROM search_page_lacking(0)`)).toBe('22023');
    });
  });

  describe('search_page_sweep', () => {
    it('deletes the rows of a copy that is served no longer, and keeps the rows of the one that is', async () => {
      // Whatever the tests above left.
      await sweep();
      const [stale, fresh] = [await fileItem(), await fileItem()];
      for (const { fileId } of [stale, fresh]) {
        await serve('stored_file', fileId, 'public', sha(`${fileId} 1`));
        await serve('stored_file', fileId, 'members', sha(`${fileId} 1`));
        await put(fileId, 'public', `${fileId} 1`, 1, ['one', 'two']);
        await put(fileId, 'members', `${fileId} 1`, 1, ['one', 'two', 'three']);
      }
      expect(await sweep()).toBe(0);
      // The public's copy of one file is replaced (the ledger appended, no request made).
      await serve('stored_file', stale.fileId, 'public', sha(`${stale.fileId} 2`));
      expect(await sweep()).toBe(2);
      expect(await count('search_page_public', stale.fileId)).toBe(0);
      expect(await count('search_page_members', stale.fileId)).toBe(3);
      expect([await count('search_page_public', fresh.fileId), await count('search_page_members', fresh.fileId)]).toEqual([2, 3]);
      expect(await sweep()).toBe(0);
    });

    it('deletes rows for an audience now served the original, nothing, or no row at all: whatever put them there', async () => {
      const [original, hidden, unknown] = [await fileItem(), await fileItem(), await fileItem('members')];
      await sweep();
      // An audience served the original, with a row of that very sha: the ledger's output matches, but it is no copy.
      // (The page writer refuses such a put, 0032; the ledger appends no row for a change of `served` alone.)
      await serve('stored_file', original.fileId, 'public', sha('the original'), 'original');
      await plant('search_page_public', original.fileId, 'the original');
      await serve('stored_file', hidden.fileId, 'members', sha('copy-h'));
      await put(hidden.fileId, 'members', 'copy-h');
      await serve('stored_file', hidden.fileId, 'members', null, 'hidden');
      // A members' file with text in the PUBLIC table: no writer leaves it, a fault might.
      await serve('stored_file', unknown.fileId, 'members', sha('copy-u'));
      await put(unknown.fileId, 'members', 'copy-u');
      await plant('search_page_public', unknown.fileId, 'copy-u', 'the treasurer reports');
      expect(await count('search_page_public', unknown.fileId)).toBe(1);
      expect(await sweep()).toBe(3);
      expect(await count('search_page_public', original.fileId)).toBe(0);
      expect(await count('search_page_members', hidden.fileId)).toBe(0);
      expect(await count('search_page_public', unknown.fileId)).toBe(0);
      // The members' own rows of that file are the copy members are served: kept.
      expect(await count('search_page_members', unknown.fileId)).toBe(1);
    });

    it('waits for a change that holds the file, as the page writer does', async () => {
      const { fileId } = await fileItem();
      await serve('stored_file', fileId, 'public', sha('copy-1'));
      await put(fileId, 'public', 'copy-1');
      await serve('stored_file', fileId, 'public', sha('copy-2'));
      await other.query('BEGIN');
      await other.query(`SELECT 1 FROM stored_file WHERE id = $1 FOR NO KEY UPDATE`, [fileId]);
      const backend = (await worker.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid;
      const swept = worker.query<{ n: number }>(`SELECT search_page_sweep() AS n`);
      let waiting = false;
      for (let tries = 0; tries < 200 && !waiting; tries++) {
        waiting = (await owner.query<{ wait: string | null }>(`SELECT wait_event_type AS wait FROM pg_stat_activity WHERE pid = $1`, [backend])).rows[0]?.wait === 'Lock';
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(waiting).toBe(true);
      expect(await count('search_page_public', fileId)).toBe(1);
      // The holder makes the old copy current again before it lets go: the sweep then finds nothing to delete.
      await other.query(`SELECT publication_ledger_record('stored_file', $1, 'public', $2, $3, 0)`, [fileId, sha('copy-1'), { v: 1, served: 'copy' }]);
      await other.query('COMMIT');
      expect((await swept).rows[0]!.n).toBe(0);
      expect(await count('search_page_public', fileId)).toBe(1);
    });
  });
});
