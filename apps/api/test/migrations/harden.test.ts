// HARDEN-1 (0019): the worker records only its own file under its lease, a ledger row's inputs are
// capped, no function is executable by PUBLIC or runs without a pinned search_path, and a writer
// waiting on the ledger lock gives up after lock_timeout. Every name is made up.
import { createHash } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../../src/db/pool.js';
import { storeOriginal } from '../../src/pdf/store.js';
import { createWorkerPool } from '../../src/pdf/worker.js';
import { type Api, insertId, startApi } from '../helpers/api.js';
import { publishItem } from '../helpers/content.js';
import { APP, APP_PW, MIGRATOR, MIGRATOR_PW, WORKER, WORKER_PW, live, sqlstate, urlFor } from '../helpers/pg.js';
import { linesPdf } from '../pdf/fixtures.js';

const STORER = { sub: 'sub-officer', groups: ['nwfl-members', 'nwfl-officers'] };
const FAKE = '00000000-0000-0000-0000-0000000000aa';
const sha = (bytes: Uint8Array | string): Buffer => createHash('sha256').update(bytes).digest();
const RECORD_FILE = `SELECT publication_ledger_record_file($1, $2, $3, $4, $5, $6) AS seq`;
const RECORD = `SELECT publication_ledger_record($1, $2, $3, $4, $5, $6) AS seq`;
const BIG = { v: 1, pad: 'x'.repeat(9 * 1024) };

describe.skipIf(!live)('0019: HARDEN-1', () => {
  let api: Api;
  let database: string;
  let file: string;
  let version: string;
  let fileSha: Buffer;
  let worker: pg.Client;
  let owner: pg.Client;
  let claim: string;

  beforeAll(async () => {
    api = await startApi('nwfl_harden');
    database = new URL((api.pool as unknown as { options: { connectionString: string } }).options.connectionString).pathname.slice(1);
    const office = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ('publications', 'Publications Officer', 'appointed') RETURNING id`);
    const bytes = await linesPdf(['Picnic flyer', 'Rides: call 850-555-0199.']);
    fileSha = sha(bytes);
    ({ versionId: version } = await publishItem(api.pool, { slug: 'flyer', officeId: office, title: 'Flyer', body: { blocks: [] }, files: [{ objectKey: 'k-flyer', audience: 'public', bytes }] }));
    file = (await api.pool.query<{ id: string }>(`SELECT id FROM stored_file WHERE version_id = $1`, [version])).rows[0]!.id;
    await storeOriginal(api.pool, { fileId: file, bytes, ...STORER });
    worker = new pg.Client({ connectionString: urlFor(WORKER, WORKER_PW, database) });
    owner = new pg.Client({ connectionString: urlFor(MIGRATOR, MIGRATOR_PW, database) });
    await Promise.all([worker.connect(), owner.connect()]);
    claim = (await worker.query<{ claim: string }>(`SELECT claim FROM pdf_regen_claim(600)`)).rows[0]!.claim;
  }, 60_000);

  afterAll(async () => {
    await Promise.all([worker?.end(), owner?.end()]);
    await api?.close();
  });

  describe('the worker\'s own record function', () => {
    it('takes publication_ledger_record from the worker, for every kind of subject', async () => {
      expect(await sqlstate(worker, RECORD, ['content_version', version, 'public', sha('x'), { v: 1 }, 0])).toBe('42501');
      expect(await sqlstate(worker, RECORD, ['stored_file', file, 'public', fileSha, { v: 1, served: 'original' }, 0])).toBe('42501');
    });

    it('refuses a content_version subject: it holds no lease and has no PDF', async () => {
      expect(await sqlstate(worker, RECORD_FILE, [version, claim, 'public', sha('x'), { v: 1, served: 'original' }, 0])).toBe('42501');
    });

    it('refuses a file without the live lease', async () => {
      expect(await sqlstate(worker, RECORD_FILE, [file, FAKE, 'public', fileSha, { v: 1, served: 'original' }, 0])).toBe('42501');
    });

    it('refuses an output that is not the stored copy\'s sha256, or nothing claimed as served', async () => {
      expect(await sqlstate(worker, RECORD_FILE, [file, claim, 'public', sha('forged'), { v: 1, served: 'original' }, 0])).toBe('22023');
      expect(await sqlstate(worker, RECORD_FILE, [file, claim, 'public', fileSha, { v: 1, served: 'copy', input_hash: '00'.repeat(32) }, 0])).toBe('22023');
      expect(await sqlstate(worker, RECORD_FILE, [file, claim, 'public', fileSha, { v: 1, served: 'copy' }, 0])).toBe('22023');
      expect(await sqlstate(worker, RECORD_FILE, [file, claim, 'public', null, { v: 1, served: 'copy' }, 0])).toBe('22023');
      expect(await sqlstate(worker, RECORD_FILE, [file, claim, 'public', null, { v: 1, served: 'original' }, 0])).toBe('22023');
    });

    it('records the stored copy\'s sha256 under the lease: the original\'s, and a ready copy\'s', async () => {
      const original = await worker.query<{ seq: string }>(RECORD_FILE, [file, claim, 'members', fileSha, { v: 1, served: 'original' }, 0]);
      expect(original.rows[0]!.seq).not.toBeNull();
      const hash = sha('inputs');
      await worker.query(`SELECT pdf_copy_put($1, $2, $3, 'e', $4, NULL)`, [file, claim, hash, Buffer.from('%PDF-copy')]);
      const copy = await worker.query<{ seq: string }>(RECORD_FILE, [file, claim, 'public', sha('%PDF-copy'), { v: 1, served: 'copy', input_hash: hash.toString('hex') }, 1]);
      expect(copy.rows[0]!.seq).not.toBeNull();
      const hidden = await worker.query<{ seq: string | null }>(RECORD_FILE, [file, claim, 'public', null, { v: 1, served: 'hidden' }, 0]);
      expect(hidden.rows[0]!.seq).not.toBeNull();
    });

    it('refuses 9 KiB of inputs, in both record functions', async () => {
      expect(await sqlstate(worker, RECORD_FILE, [file, claim, 'officers', fileSha, { ...BIG, served: 'original' }, 0])).toBe('22023');
      const app = await api.pool.connect();
      try {
        expect(await sqlstate(app as unknown as pg.Client, RECORD, ['content_version', version, 'public', sha('x'), BIG, 0])).toBe('22023');
        expect(await sqlstate(app as unknown as pg.Client, RECORD, ['content_version', version, 'public', sha('x'), { v: 1, pad: 'x'.repeat(7 * 1024) }, 0])).toBe('ok');
      } finally {
        app.release();
      }
    });

    it('is the worker\'s alone once the role exists: the app role keeps publication_ledger_record', async () => {
      const { rows } = await owner.query<{ app: boolean; wk: boolean; rec_app: boolean; rec_wk: boolean }>(
        `SELECT has_function_privilege('nwfl', 'publication_ledger_record_file(uuid, uuid, text, bytea, jsonb, integer)', 'EXECUTE') AS app,
                has_function_privilege('nwfl_worker', 'publication_ledger_record_file(uuid, uuid, text, bytea, jsonb, integer)', 'EXECUTE') AS wk,
                has_function_privilege('nwfl', 'publication_ledger_record(text, uuid, text, bytea, jsonb, integer)', 'EXECUTE') AS rec_app,
                has_function_privilege('nwfl_worker', 'publication_ledger_record(text, uuid, text, bytea, jsonb, integer)', 'EXECUTE') AS rec_wk`,
      );
      expect(rows[0]).toEqual({ app: false, wk: true, rec_app: true, rec_wk: false });
    });
  });

  describe('function privileges', () => {
    it('leaves no function in public executable by PUBLIC, and none without a pinned search_path', async () => {
      const { rows } = await owner.query<{ fn: string; public_exec: boolean; pinned: boolean }>(
        `SELECT p.oid::regprocedure::text AS fn,
                has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
                coalesce(EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%'), false) AS pinned
         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace ORDER BY 1`,
      );
      expect(rows.length).toBeGreaterThan(50);
      expect(rows.filter((row) => row.public_exec).map((row) => row.fn)).toEqual([]);
      expect(rows.filter((row) => !row.pinned).map((row) => row.fn)).toEqual([]);
    });

    it('gives a function created later no PUBLIC EXECUTE either (default privileges)', async () => {
      await owner.query('BEGIN');
      try {
        await owner.query(`CREATE FUNCTION harden_probe() RETURNS int LANGUAGE sql SET search_path = pg_catalog AS 'SELECT 1'`);
        const { rows } = await owner.query<{ x: boolean }>(`SELECT has_function_privilege('public', 'harden_probe()', 'EXECUTE') AS x`);
        expect(rows[0]!.x).toBe(false);
      } finally {
        await owner.query('ROLLBACK');
      }
    });

    it('still lets the app role publish (its invoker triggers call content_item_check_live_is_newest)', async () => {
      const office = (await api.pool.query<{ id: string }>(`SELECT id FROM office WHERE slug = 'publications'`)).rows[0]!.id;
      await expect(publishItem(api.pool, { slug: 'second', officeId: office, title: 'Second', body: { blocks: [] } })).resolves.toBeDefined();
    });

    it('says what the guard triggers hold: every role\'s writes, but not an owner who drops or disables them', async () => {
      const { rows } = await owner.query<{ tgname: string; comment: string | null }>(
        `SELECT tgname, obj_description(oid, 'pg_trigger') AS comment FROM pg_trigger WHERE tgname = 'publication_ledger_guard'`,
      );
      expect(rows[0]!.comment).toMatch(/owner can disable or drop/);
    });
  });

  describe('timeouts on every pooled connection', () => {
    it('makes a second writer fail within lock_timeout while the ledger lock is held, for the server and the worker', async () => {
      const holder = new pg.Client({ connectionString: urlFor(APP, APP_PW, database) });
      await holder.connect();
      const server = createPool({ DATABASE_URL: urlFor(APP, APP_PW, database) });
      const job = createWorkerPool({ DATABASE_URL: urlFor(WORKER, WORKER_PW, database) });
      try {
        expect((await server.query<{ t: string }>(`SELECT current_setting('idle_in_transaction_session_timeout') AS t`)).rows[0]!.t).toBe('30s');
        expect((await job.query<{ t: string }>(`SELECT current_setting('lock_timeout') AS t`)).rows[0]!.t).toBe('5s');
        await holder.query('BEGIN');
        await holder.query('SELECT publication_ledger_lock()');
        // One writer at a time: a second waiter would queue behind the first on the row's lock.
        for (const pool of [server, job]) {
          const started = Date.now();
          const outcome = await pool.query('SELECT publication_ledger_lock()').then(
            () => 'ok',
            (error: { code?: string }) => error.code,
          );
          const waited = Date.now() - started;
          expect(outcome).toBe('55P03');
          expect(waited).toBeGreaterThanOrEqual(4_500);
          expect(waited).toBeLessThan(8_000);
        }
      } finally {
        await holder.query('ROLLBACK');
        await Promise.all([holder.end(), server.end(), job.end()]);
      }
    }, 30_000);
  });
});
