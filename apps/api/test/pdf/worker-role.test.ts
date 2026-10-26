// W-WORKER (0017): only the PDF worker's own role, nwfl_worker, reaches original PDF bytes, and only
// through the regeneration functions. The app role keeps pdf_original_read, which serves an
// original only to an audience whose policy shows everything (what that audience is given anyway).
// Every name is made up.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drain } from '../../src/pdf/regenerate.js';
import { storeOriginal } from '../../src/pdf/store.js';
import { runWorker } from '../../src/pdf/worker.js';
import { type Api, insertId, startApi } from '../helpers/api.js';
import { publishItem } from '../helpers/content.js';
import { APP, APP_PW, MIGRATOR, MIGRATOR_PW, WORKER, WORKER_ATTRIBUTES, WORKER_PW, live, sqlstate, url, urlFor } from '../helpers/pg.js';
import { linesPdf } from './fixtures.js';

const STORER = { sub: 'sub-officer', groups: ['nwfl-members', 'nwfl-officers'] };
const FAKE = '00000000-0000-0000-0000-0000000000aa';

/** What the worker may read, column by column: nothing else in the schema. */
const WORKER_COLUMNS: Record<string, string[]> = {
  content_version: ['id', 'item_id'],
  edition_item: ['edition_id', 'item_id'],
  pdf_copy: ['bytes', 'file_id', 'input_hash', 'status'],
  pdf_original: ['file_id'],
  redaction_mark: ['category', 'content_item_id', 'id', 'quote', 'status', 'tenant_id'],
  redaction_policy: ['action', 'audience', 'category', 'tenant_id'],
  stored_file: ['audience', 'edition_id', 'id', 'sha256', 'version_id'],
};

const WORKER_FUNCTIONS = [
  'pdf_copy_put',
  'pdf_file_items',
  'pdf_regen_claim',
  'pdf_regen_finish',
  'pdf_regen_original',
  'publication_ledger_lock',
  'publication_ledger_record_file',
];

describe.skipIf(!live)('0017: the PDF worker role', () => {
  let api: Api;
  let database: string;
  let file: string;
  let app: pg.Client;
  let worker: pg.Client;
  let owner: pg.Client;

  beforeAll(async () => {
    api = await startApi('nwfl_workerrole');
    database = new URL((api.pool as unknown as { options: { connectionString: string } }).options.connectionString).pathname.slice(1);
    const office = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ('publications', 'Publications Officer', 'appointed') RETURNING id`);
    const bytes = await linesPdf(['Picnic flyer', 'Rides: call 850-555-0199.']);
    const { versionId } = await publishItem(api.pool, { slug: 'flyer', officeId: office, title: 'Flyer', body: { blocks: [] }, files: [{ objectKey: 'k-flyer', audience: 'public', bytes }] });
    file = (await api.pool.query<{ id: string }>(`SELECT id FROM stored_file WHERE version_id = $1`, [versionId])).rows[0]!.id;
    await storeOriginal(api.pool, { fileId: file, bytes, ...STORER });
    app = new pg.Client({ connectionString: urlFor(APP, APP_PW, database) });
    worker = new pg.Client({ connectionString: urlFor(WORKER, WORKER_PW, database) });
    owner = new pg.Client({ connectionString: urlFor(MIGRATOR, MIGRATOR_PW, database) });
    await Promise.all([app.connect(), worker.connect(), owner.connect()]);
  }, 60_000);

  afterAll(async () => {
    await Promise.all([app?.end(), worker?.end(), owner?.end()]);
    await api?.close();
  });

  it('denies the app role every path to an original\'s bytes but the policy-checked read', async () => {
    for (const sql of [
      `SELECT * FROM pdf_regen_claim(60)`,
      `SELECT pdf_regen_original('${file}', '${FAKE}')`,
      `SELECT pdf_copy_put('${file}', '${FAKE}', '\\x00'::bytea, 'e', NULL, 'r')`,
      `SELECT pdf_regen_finish('${file}', '${FAKE}', ARRAY[]::bytea[])`,
      `SELECT publication_ledger_original(1, 'sub-officer', '{nwfl-officers}', NULL)`,
      `SELECT bytes FROM pdf_original`,
      `SELECT nwfl_worker_grants()`,
    ]) {
      expect(await sqlstate(app, sql), sql).toBe('42501');
    }
    // The file is still queued: the app role could not take it.
    expect((await api.pool.query(`SELECT 1 FROM pdf_regen WHERE file_id = $1`, [file])).rowCount).toBe(1);
    // Not a member of the worker role either.
    expect((await app.query<{ m: boolean }>(`SELECT pg_has_role('nwfl', 'nwfl_worker', 'USAGE') AS m`)).rows[0]!.m).toBe(false);
  });

  it('lets the worker regenerate end to end: claim, original, copies, finish and the ledger rows', async () => {
    expect(await drain(api.worker)).toBe(1);
    expect((await api.pool.query(`SELECT 1 FROM pdf_regen WHERE file_id = $1`, [file])).rowCount).toBe(0);
    expect((await api.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM pdf_copy WHERE file_id = $1 AND status = 'ready'`, [file])).rows[0]!.n).toBeGreaterThan(0);
    expect((await api.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM publication_ledger WHERE subject_id = $1`, [file])).rows[0]!.n).toBeGreaterThan(0);
  });

  it('runs as the worker process: runWorker drains the queue with the worker\'s own credentials', async () => {
    await api.pool.query(`SELECT redaction_mark_add('content_item', item_id, 'body', '850-555-0199', 'member_phone', $1, $2, NULL) FROM content_version v JOIN stored_file f ON f.version_id = v.id WHERE f.id = $3`, [STORER.sub, STORER.groups, file]);
    expect((await api.pool.query(`SELECT 1 FROM pdf_regen WHERE file_id = $1`, [file])).rowCount).toBe(1);
    const target = new URL(url as string);
    const errors: unknown[] = [];
    const job = runWorker({
      env: { PGHOST: target.hostname, PGPORT: target.port, PGDATABASE: database, PGUSER: WORKER, PGPASSWORD: WORKER_PW },
      intervalMs: 20,
      onError: (error) => errors.push(error),
    });
    const deadline = Date.now() + 20_000;
    while ((await api.pool.query(`SELECT 1 FROM pdf_regen WHERE file_id = $1`, [file])).rowCount !== 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await job.stop();
    expect(errors).toEqual([]);
    expect((await api.pool.query(`SELECT 1 FROM pdf_regen WHERE file_id = $1`, [file])).rowCount).toBe(0);
  });

  it('gives the worker nothing outside its grants: no other table, column or write, no other function', async () => {
    const { rows: columns } = await owner.query<{ table_name: string; column_name: string; privilege_type: string }>(
      `SELECT c.table_name, c.column_name, p.privilege_type
       FROM information_schema.columns c
       CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) AS p (privilege_type)
       WHERE c.table_schema = 'public' AND has_column_privilege($1, format('public.%I', c.table_name), c.column_name, p.privilege_type)
       ORDER BY 1, 2, 3`,
      [WORKER],
    );
    expect(columns.every((row) => row.privilege_type === 'SELECT')).toBe(true);
    const granted: Record<string, string[]> = {};
    for (const row of columns) (granted[row.table_name] ??= []).push(row.column_name);
    expect(granted).toEqual(WORKER_COLUMNS);
    const { rows: tableWrites } = await owner.query<{ relname: string }>(
      `SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'S', 'v', 'm')
         AND (has_table_privilege($1, oid, 'DELETE') OR has_table_privilege($1, oid, 'TRUNCATE') OR has_table_privilege($1, oid, 'TRIGGER')
              OR (relkind = 'S' AND has_sequence_privilege($1, oid, 'USAGE')))`,
      [WORKER],
    );
    expect(tableWrites).toEqual([]);
    // Every function it may call that runs as its owner or writes: exactly the job's.
    const { rows: functions } = await owner.query<{ proname: string }>(
      `SELECT DISTINCT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND has_function_privilege($1, oid, 'EXECUTE')
         AND (prosecdef OR proname = 'pdf_file_items') ORDER BY 1`,
      [WORKER],
    );
    expect(functions.map((row) => row.proname)).toEqual(WORKER_FUNCTIONS);
    for (const sql of [
      `SELECT body_src FROM content_version`,
      `SELECT bytes FROM pdf_original`,
      `SELECT * FROM member_account`,
      `SELECT * FROM audit_event`,
      `SELECT * FROM publication_ledger`,
      `UPDATE redaction_policy SET action = 'show'`,
      `INSERT INTO content_item (slug) VALUES ('x')`,
      `DELETE FROM pdf_copy`,
      `SELECT pdf_original_read('${file}', 'officers')`,
      `SELECT publication_ledger_original(1, 'sub-officer', '{nwfl-officers}', NULL)`,
      `SELECT redaction_mark_add('content_item', '${FAKE}', 'body', 'x', 'member_phone', 'sub-officer', '{nwfl-officers}', NULL)`,
      `SELECT redaction_propose('nwflorida', 'public', 'image', 'show', 'sub-officer', '{nwfl-officers}', NULL)`,
      `SELECT nwfl_worker_grants()`,
      `CREATE TABLE w (x int)`,
    ]) {
      expect(await sqlstate(worker, sql), sql).toBe('42501');
    }
  });

  it('lets the migrator run nwfl_worker_grants() again, with the same result', async () => {
    expect((await owner.query<{ done: boolean }>(`SELECT nwfl_worker_grants() AS done`)).rows[0]!.done).toBe(true);
    expect(await sqlstate(app, `SELECT pdf_regen_original('${file}', '${FAKE}')`)).toBe('42501');
    expect(await sqlstate(worker, `SELECT pdf_regen_original('${file}', '${FAKE}')`)).toBe('42501'); // a live claim is still required
  });
});

// The role is cluster-wide and every suite creates it, so "no role yet" needs a Postgres of its own.
const SCRIPTS = fileURLToPath(new URL('../../scripts/', import.meta.url));

function run(file: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, stdout, stderr });
    });
  });
}

describe.skipIf(!live)('0017 before fc creates the worker role', () => {
  let id: string | undefined;
  let superUrl: string;

  beforeAll(async () => {
    const started = await run('sh', [`${SCRIPTS}test-db.sh`, 'start']);
    if (started.code !== 0) throw new Error(started.stderr);
    id = /NWFL_TEST_PG_CONTAINER=(\S+)/.exec(started.stdout)?.[1];
    superUrl = /NWFL_TEST_DATABASE_URL=(\S+)/.exec(started.stdout)?.[1] as string;
  }, 60_000);

  afterAll(async () => {
    if (id !== undefined) await run('sh', [`${SCRIPTS}test-db.sh`, 'stop', id]);
  });

  const at = (user: string, password: string, db: string): string => {
    const target = new URL(superUrl);
    target.username = user;
    target.password = password;
    target.pathname = `/${db}`;
    return target.toString();
  };

  it('applies cleanly, keeps the old behaviour, and grants once the role exists', async () => {
    const su = new pg.Client({ connectionString: superUrl });
    await su.connect();
    try {
      await su.query(`CREATE ROLE ${MIGRATOR} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${MIGRATOR_PW}'`);
      await su.query(`CREATE ROLE ${APP} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${APP_PW}'`);
      await su.query(`CREATE DATABASE nwfl OWNER ${MIGRATOR}`);
    } finally {
      await su.end();
    }
    const migrated = await run('docker', ['exec', '-e', 'PGHOST=127.0.0.1', '-e', `PGUSER=${MIGRATOR}`, '-e', `PGPASSWORD=${MIGRATOR_PW}`, '-e', 'PGDATABASE=nwfl', id as string, 'sh', '/repo/scripts/migrate.sh', '/repo/migrations']);
    expect(migrated.code, migrated.stderr).toBe(0);
    expect(migrated.stdout + migrated.stderr).toMatch(/role nwfl_worker does not exist/);
    expect(migrated.stdout).toContain('migrate: worker grants f');
    const app = new pg.Client({ connectionString: at(APP, APP_PW, 'nwfl') });
    const owner = new pg.Client({ connectionString: at(MIGRATOR, MIGRATOR_PW, 'nwfl') });
    await Promise.all([app.connect(), owner.connect()]);
    try {
      // The old behaviour: the app role still runs the job (nothing is queued, so the claim is empty).
      expect((await app.query(`SELECT * FROM pdf_regen_claim(60)`)).rowCount).toBe(0);
      expect(await sqlstate(app, `SELECT pdf_regen_original('${FAKE}', '${FAKE}')`)).toBe('42501'); // by the claim check, not a grant
      expect((await owner.query<{ done: boolean }>(`SELECT nwfl_worker_grants() AS done`)).rows[0]!.done).toBe(false);
      // fc creates the role, then runs the function: the app role loses the path.
      const su2 = new pg.Client({ connectionString: superUrl });
      await su2.connect();
      await su2.query(`CREATE ROLE ${WORKER} ${WORKER_ATTRIBUTES.replace('CONNECTION LIMIT 40', 'CONNECTION LIMIT 3')} PASSWORD '${WORKER_PW}'`);
      await su2.end();
      // Re-running the migration Job applies them: nothing is pending, the grants follow the role.
      const again = await run('docker', ['exec', '-e', 'PGHOST=127.0.0.1', '-e', `PGUSER=${MIGRATOR}`, '-e', `PGPASSWORD=${MIGRATOR_PW}`, '-e', 'PGDATABASE=nwfl', id as string, 'sh', '/repo/scripts/migrate.sh', '/repo/migrations']);
      expect(again.code, again.stderr).toBe(0);
      expect(again.stdout).toMatch(/applied=0 skipped=20/);
      expect(again.stdout).toContain('migrate: worker grants t');
      expect(await sqlstate(app, `SELECT * FROM pdf_regen_claim(60)`)).toBe('42501');
      const worker = new pg.Client({ connectionString: at(WORKER, WORKER_PW, 'nwfl') });
      await worker.connect();
      expect((await worker.query(`SELECT * FROM pdf_regen_claim(60)`)).rowCount).toBe(0);
      await worker.end();
    } finally {
      await Promise.all([app.end(), owner.end()]);
    }
  }, 60_000);
});
