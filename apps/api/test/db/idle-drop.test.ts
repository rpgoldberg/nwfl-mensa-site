// An idle pooled connection the server ends (a restart, a failover, a timeout, or a dropped test
// database) must not crash the process: the pool hears the error, logs its code, and the next query
// runs on a new connection. Both the server's pool and the worker's.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../../src/db/pool.js';
import { createWorkerPool } from '../../src/pdf/worker.js';
import { APP, APP_PW, WORKER, WORKER_PW, asSuper, dropDatabase, freshDatabase, live, migrate, urlFor } from '../helpers/pg.js';

describe.skipIf(!live)('an idle pooled connection ended by the server', () => {
  let db: string;

  beforeAll(async () => {
    db = await freshDatabase('nwfl_idledrop');
    const run = await migrate(db);
    if (run.code !== 0) throw new Error(run.stderr);
  }, 60_000);

  afterAll(async () => {
    if (db !== undefined) await dropDatabase(db);
  });

  for (const [name, make] of [
    ['the server\'s pool', (warn: (fields: Record<string, unknown>) => void) => createPool({ DATABASE_URL: urlFor(APP, APP_PW, db) }, warn)],
    ['the worker\'s pool', (warn: (fields: Record<string, unknown>) => void) => createWorkerPool({ DATABASE_URL: urlFor(WORKER, WORKER_PW, db) }, warn)],
  ] as const) {
    it(`${name}: logs 57P01, stays up, and the next query gets a new connection`, async () => {
      const warned: Array<Record<string, unknown>> = [];
      const pool = make((fields) => void warned.push(fields));
      try {
        const first = (await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
        await asSuper((client) => client.query('SELECT pg_terminate_backend($1)', [first]));
        const deadline = Date.now() + 5_000;
        while (warned.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
        expect(warned).toEqual([{ error_code: '57P01' }]);
        const next = (await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
        expect(next).not.toBe(first);
      } finally {
        await pool.end();
      }
    });
  }
});
