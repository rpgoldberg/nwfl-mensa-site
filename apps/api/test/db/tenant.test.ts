// CF-ISO-0, live: the tenant gate reads the real tenant row (0012) as the app role; the worker, which
// may not read the tenant table, checks the tenant its redaction policy rows reference, and runs no job
// until that passes. A mismatch is reported; nothing here exits.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runWorker } from '../../src/pdf/worker.js';
import { policyTenants, startTenantGate, tenantRows } from '../../src/tenant.js';
import { type Api, startApi } from '../helpers/api.js';
import { WORKER, WORKER_PW, live, url } from '../helpers/pg.js';

describe.skipIf(!live)('the TENANT gate, against a migrated database', () => {
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

  it('reads the one tenant row as the app role: verified for nwflorida, a mismatch for any other', async () => {
    expect(await tenantRows(api.pool)()).toEqual(['nwflorida']);
    expect(await startTenantGate(tenantRows(api.pool), 'nwflorida', { onMismatch: vi.fn() }).settled).toBe('verified');
    const onMismatch = vi.fn();
    expect(await startTenantGate(tenantRows(api.pool), 'mensa-other', { onMismatch }).settled).toBe('mismatch');
    expect(onMismatch).toHaveBeenCalledWith('TENANT is mensa-other but the database serves nwflorida: refusing to start');
  });

  it('checks the worker by its redaction policy\'s tenant, since nwfl_worker may not read the tenant table', async () => {
    await expect(api.worker.query('SELECT id FROM tenant')).rejects.toMatchObject({ code: '42501' });
    expect(await policyTenants(api.worker)()).toEqual(['nwflorida']);
  });

  it('starts the job once the worker\'s TENANT is verified', async () => {
    const onVerified = vi.fn();
    const onMismatch = vi.fn();
    const worker = runWorker({ env: workerEnv, intervalMs: 3_600_000, tenant: { id: 'nwflorida', onMismatch, onVerified } });
    await vi.waitFor(() => expect(onVerified).toHaveBeenCalledTimes(1));
    expect(onMismatch).not.toHaveBeenCalled();
    await worker.stop();
  });

  it('runs no job in a worker whose TENANT is another chapter\'s, and reports the mismatch', async () => {
    const onMismatch = vi.fn();
    const errors: unknown[] = [];
    const worker = runWorker({
      env: workerEnv,
      intervalMs: 10,
      engine: fileURLToPath(new URL('../pdf/children/refuse.ts', import.meta.url)),
      onError: (error) => void errors.push(error),
      tenant: { id: 'mensa-other', onMismatch },
    });
    await vi.waitFor(() => expect(onMismatch).toHaveBeenCalledWith('TENANT is mensa-other but the database serves nwflorida: refusing to start'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(errors).toEqual([]);
    await worker.stop();
  });
});
