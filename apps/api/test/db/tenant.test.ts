// CF-ISO-0, live: the startup check reads the real tenant row (0012) as the app role, and the worker,
// which may not read the tenant table, checks the tenant its redaction policy rows reference instead.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkWorkerTenant } from '../../src/pdf/worker.js';
import { checkTenant, tenantRows } from '../../src/tenant.js';
import { type Api, startApi } from '../helpers/api.js';
import { WORKER, WORKER_PW, live, url } from '../helpers/pg.js';

const instant = { sleep: () => Promise.resolve(), attempts: 1 };

describe.skipIf(!live)('the TENANT startup check, against a migrated database', () => {
  let api: Api;
  let workerEnv: Record<string, string>;

  beforeAll(async () => {
    api = await startApi('nwfl_tenant');
    const target = new URL(url as string);
    const database = (await api.pool.query<{ db: string }>('SELECT current_database() AS db')).rows[0]!.db;
    workerEnv = { PGHOST: target.hostname, PGPORT: target.port, PGDATABASE: database, PGUSER: WORKER, PGPASSWORD: WORKER_PW };
  }, 60_000);

  afterAll(async () => {
    await api?.close();
  });

  it('reads the one tenant row as the app role, and passes for nwflorida only', async () => {
    expect(await tenantRows(api.pool)()).toEqual(['nwflorida']);
    await expect(checkTenant(tenantRows(api.pool), 'nwflorida', instant)).resolves.toBeUndefined();
    await expect(checkTenant(tenantRows(api.pool), 'mensa-other', instant)).rejects.toThrow('TENANT is mensa-other but the database serves nwflorida: refusing to start');
  });

  it('checks the worker by its redaction policy\'s tenant, since nwfl_worker may not read the tenant table', async () => {
    await expect(api.worker.query('SELECT id FROM tenant')).rejects.toMatchObject({ code: '42501' });
    await expect(checkWorkerTenant(workerEnv, 'nwflorida', instant)).resolves.toBeUndefined();
    await expect(checkWorkerTenant(workerEnv, 'mensa-other', instant)).rejects.toThrow('TENANT is mensa-other but the database serves nwflorida');
  });
});
