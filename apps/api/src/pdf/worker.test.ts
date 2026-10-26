import { describe, expect, it } from 'vitest';
import { WORKER_ROLE, createWorkerPool, runWorker, workerPoolConfig } from './worker.js';

describe('workerPoolConfig: the PDF worker connects as its own role only', () => {
  it('defaults the user to nwfl_worker and the pool to 2 connections', () => {
    const config = workerPoolConfig({ PGHOST: 'db', PGPASSWORD: 'pw' });
    expect(config).toMatchObject({ host: 'db', user: WORKER_ROLE, password: 'pw', database: 'nwfl', max: 2 });
  });

  it('sets the same lock and idle-in-transaction timeouts as the server', () => {
    expect(workerPoolConfig({})).toMatchObject({ lock_timeout: 5_000, idle_in_transaction_session_timeout: 30_000 });
  });

  it('takes PG_POOL_MAX and an explicit PGUSER of nwfl_worker', () => {
    expect(workerPoolConfig({ PGUSER: 'nwfl_worker', PG_POOL_MAX: '3' })).toMatchObject({ user: 'nwfl_worker', max: 3 });
  });

  it('refuses the app role, or any other, from PGUSER', () => {
    expect(() => workerPoolConfig({ PGUSER: 'nwfl' })).toThrow('the PDF worker connects as nwfl_worker, not nwfl');
    expect(() => workerPoolConfig({ PGUSER: '' })).toThrow('not an unnamed role');
  });

  it('reads the user from DATABASE_URL, and refuses one that is not nwfl_worker', () => {
    expect(workerPoolConfig({ DATABASE_URL: 'postgres://nwfl_worker:pw@db:5432/nwfl' })).toMatchObject({ connectionString: 'postgres://nwfl_worker:pw@db:5432/nwfl' });
    expect(() => workerPoolConfig({ DATABASE_URL: 'postgres://nwfl:pw@db:5432/nwfl' })).toThrow('not nwfl');
    expect(() => workerPoolConfig({ DATABASE_URL: 'postgres://db:5432/nwfl', PGUSER: 'nwfl_worker' })).toThrow('not an unnamed role');
    expect(() => workerPoolConfig({ DATABASE_URL: 'not a url' })).toThrow('DATABASE_URL');
  });
});

describe('createWorkerPool', () => {
  it('survives an idle client dropping, and refuses the app role before connecting', async () => {
    const pool = createWorkerPool({ PGHOST: '127.0.0.1', PGPORT: '1' });
    expect(() => pool.emit('error', new Error('idle client dropped'))).not.toThrow();
    await pool.end();
    expect(() => createWorkerPool({ PGUSER: 'nwfl' })).toThrow('not nwfl');
  });
});

describe('runWorker', () => {
  it('keeps the process alive until stopped: the job\'s own timer is unref\'d and the worker has no listener', async () => {
    const timeouts = () => process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length;
    const before = timeouts();
    const worker = runWorker({ env: { PGHOST: '127.0.0.1', PGPORT: '1' }, intervalMs: 3_600_000 });
    expect(timeouts()).toBe(before + 1);
    await worker.stop();
    expect(timeouts()).toBe(before);
  });
});
