// scripts/migrate.sh against a real Postgres: it applies, records, re-runs as a
// no-op, and refuses the six unsafe cases before it touches anything.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { container, dockerExec, dropDatabase, freshDatabase, live, migrate, MIGRATOR, MIGRATOR_PW, url, urlFor, withClient } from '../helpers/pg.js';

describe('live migration runner', () => {
  it.runIf(process.env['CI'] === 'true')('has a database and its container in CI', () => {
    expect(url, 'NWFL_TEST_DATABASE_URL must be set in CI').toBeTruthy();
    expect(container, 'NWFL_TEST_PG_CONTAINER must be set in CI').toBeTruthy();
  });

  describe.skipIf(!live)('scripts/migrate.sh', () => {
    let db: string;
    // A scratch copy of the migrations inside the container, for the cases
    // that need an edited or extra file. /repo is mounted read-only.
    const scratch = (name: string): string => `/tmp/${db}-${name}`;
    const copyMigrations = async (name: string): Promise<string> => {
      const dir = scratch(name);
      await dockerExec(['sh', '-c', `rm -rf ${dir} && mkdir -p ${dir} && cp /repo/migrations/*.sql ${dir}/`]);
      return dir;
    };

    beforeAll(async () => {
      db = await freshDatabase('nwfl_runner');
    });

    afterAll(async () => {
      await dockerExec(['sh', '-c', `rm -rf /tmp/${db}-*`]);
      await dropDatabase(db);
    });

    it('applies every migration in one run and records each in the ledger', async () => {
      const run = await migrate(db);
      expect(run.code, run.stderr).toBe(0);
      expect(run.stdout).toMatch(/done — applied=\d+ skipped=0/);
      const ledger = await withClient(urlFor(MIGRATOR, MIGRATOR_PW, db), async (client) =>
        (await client.query<{ filename: string }>('SELECT filename FROM schema_migrations ORDER BY filename')).rows.map((r) => r.filename),
      );
      expect(ledger[0]).toBe('0000_grants.sql');
      expect(run.stdout).toContain(`applied=${ledger.length} skipped=0`);
    });

    it('is a no-op on re-run', async () => {
      const run = await migrate(db);
      expect(run.code, run.stderr).toBe(0);
      expect(run.stdout).toMatch(/applied=0 skipped=\d+/);
    });

    it('refuses to run as a superuser (exit 2)', async () => {
      const run = await migrate(db, '/repo/migrations', { PGUSER: 'postgres', PGPASSWORD: '' });
      expect(run.code).toBe(2);
      expect(run.stderr).toMatch(/SUPERUSER/);
    });

    it('refuses a maintenance database (exit 2)', async () => {
      const run = await migrate('postgres');
      expect(run.code).toBe(2);
      expect(run.stderr).toMatch(/maintenance database/);
    });

    it('refuses a .sql file the NNNN_ glob would silently ignore (exit 2)', async () => {
      const dir = await copyMigrations('misnamed');
      await dockerExec(['sh', '-c', `echo 'SELECT 1;' > ${dir}/9a_typo.sql`]);
      const run = await migrate(db, dir);
      expect(run.code).toBe(2);
      expect(run.stderr).toMatch(/SILENTLY IGNORED: 9a_typo\.sql/);
    });

    it('refuses the whole run when an applied migration was edited (exit 4)', async () => {
      const dir = await copyMigrations('edited');
      await dockerExec(['sh', '-c', `echo '-- edited' >> ${dir}/0000_grants.sql`]);
      const run = await migrate(db, dir);
      expect(run.code).toBe(4);
      expect(run.stderr).toMatch(/provenance: '0000_grants\.sql'/);
    });

    it('refuses a pending file that holds transaction control (exit 5)', async () => {
      const dir = await copyMigrations('txn');
      await dockerExec(['sh', '-c', `printf 'CREATE TABLE t_txn (id int);\\nCOMMIT;\\n' > ${dir}/9000_txn.sql`]);
      const run = await migrate(db, dir);
      expect(run.code).toBe(5);
      expect(run.stderr).toMatch(/transaction control inside '9000_txn\.sql'/);
      const created = await withClient(urlFor(MIGRATOR, MIGRATOR_PW, db), async (client) =>
        (await client.query<{ t: string | null }>("SELECT to_regclass('t_txn') AS t")).rows[0]);
      expect(created?.t).toBeNull();
    });

    it('rolls a failing file back whole: no DDL kept, no ledger row', async () => {
      const dir = await copyMigrations('atomic');
      await dockerExec(['sh', '-c', `printf 'CREATE TABLE t_atomic (id int);\\nSELECT 1/0;\\n' > ${dir}/9001_atomic.sql`]);
      const run = await migrate(db, dir);
      expect(run.code).not.toBe(0);
      expect(run.stderr).toMatch(/FAILED 9001_atomic\.sql/);
      const state = await withClient(urlFor(MIGRATOR, MIGRATOR_PW, db), async (client) =>
        (
          await client.query<{ t: string | null; recorded: boolean }>(
            `SELECT to_regclass('t_atomic') AS t, EXISTS (SELECT 1 FROM schema_migrations WHERE filename = '9001_atomic.sql') AS recorded`,
          )
        ).rows[0],
      );
      expect(state).toEqual({ t: null, recorded: false });
    });

    it('refuses a back-dated pending file (exit 6)', async () => {
      // Synthetic files in a database of their own: 0000 and 0002 applied,
      // then a 0001 appears. A fresh database would replay it in a different
      // order from this one's history.
      const other = await freshDatabase('nwfl_backdated');
      try {
        const dir = scratch('backdated');
        await dockerExec(['sh', '-c', `rm -rf ${dir} && mkdir -p ${dir} && echo 'SELECT 1;' > ${dir}/0000_a.sql && echo 'SELECT 1;' > ${dir}/0002_c.sql`]);
        expect((await migrate(other, dir)).code).toBe(0);
        await dockerExec(['sh', '-c', `echo 'SELECT 1;' > ${dir}/0001_b.sql`]);
        const run = await migrate(other, dir);
        expect(run.code).toBe(6);
        expect(run.stderr).toMatch(/out-of-order migration '0001_b\.sql'/);
      } finally {
        await dropDatabase(other);
      }
    });
  });
});
