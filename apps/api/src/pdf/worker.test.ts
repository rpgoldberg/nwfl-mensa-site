import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { RetryableEngineError } from './regenerate.js';
import { RERUN_REFUSAL } from './rerun.js';
import { WORKER_ROLE, createWorkerPool, runWorker, workerPoolConfig, workerRedact } from './worker.js';

const child = (name: string): string => fileURLToPath(new URL(`../../test/pdf/children/${name}.ts`, import.meta.url));

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

  it('logs a dropped idle client at warn with the code only', async () => {
    const warned: unknown[] = [];
    const pool = createWorkerPool({ PGHOST: '127.0.0.1', PGPORT: '1' }, (fields) => void warned.push(fields));
    pool.emit('error', Object.assign(new Error('gone'), { code: '57P01' }));
    await pool.end();
    expect(warned).toEqual([{ error_code: '57P01' }]);
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

  it('claims nothing until the tenant is verified: a database that is down is retried, never a job run (CF-ISO-0)', async () => {
    const errors: unknown[] = [];
    const retries: unknown[] = [];
    const onMismatch = vi.fn();
    const worker = runWorker({
      env: { PGHOST: '127.0.0.1', PGPORT: '1' },
      intervalMs: 10,
      onError: (error) => void errors.push(error),
      tenant: { id: 'nwflorida', onMismatch, onRetry: (fields) => void retries.push(fields), firstDelayMs: 10, maxDelayMs: 10 },
    });
    await vi.waitFor(() => expect(retries.length).toBeGreaterThanOrEqual(3));
    // Without the gate the job would have run (and failed) every 10 ms.
    expect(errors).toEqual([]);
    expect(onMismatch).not.toHaveBeenCalled();
    await worker.stop();
  });
});

describe('workerRedact: the engine the worker uses, chosen by PDF_ENGINE_SOCKET (UNTRUSTED-PDF-GATE)', () => {
  const ONE = Uint8Array.from([1, 2, 3]);

  it('without it, forks the in-pod child, as before', async () => {
    expect(await workerRedact({}, { engine: child('refuse') })(ONE, { quotes: ['Kestrel'], redactsAny: true })).toEqual({ kind: 'refused', reason: 'refused by the engine process' });
    expect(await workerRedact({}, { engine: child('echo') })(ONE, { quotes: [], redactsAny: true })).toEqual({ kind: 'redacted', pdf: Uint8Array.from([3, 2, 1]) });
  });

  it('re-runs the output gate on every copy, whatever the engine: one it cannot read is refused', async () => {
    expect(await workerRedact({}, { engine: child('echo') })(ONE, { quotes: ['Kestrel'], redactsAny: true })).toEqual({ kind: 'refused', reason: RERUN_REFUSAL });
    const given = () => Promise.resolve({ kind: 'redacted' as const, pdf: Uint8Array.from([9]), boxes: [] });
    expect(await workerRedact({}, { redact: given })(ONE, { quotes: ['Kestrel'], redactsAny: true })).toEqual({ kind: 'refused', reason: RERUN_REFUSAL });
  });

  it('with it, talks only to the sidecar: a missing socket fails the job closed, never the in-pod child', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nwfl-wr-'));
    try {
      const redact = workerRedact({ PDF_ENGINE_SOCKET: path.join(dir, 'engine.sock') }, { socketDirs: [dir], engine: child('refuse'), engineTimeoutMs: 1_000 });
      const job = redact(ONE, { quotes: ['Kestrel'], redactsAny: true });
      await expect(job).rejects.toBeInstanceOf(RetryableEngineError);
      await expect(job).rejects.toThrow('the engine socket is missing');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a socket outside /run/pdf-engine, and so does runWorker, before it opens a pool', () => {
    expect(() => workerRedact({ PDF_ENGINE_SOCKET: 'engine.sock' }, {})).toThrow('PDF_ENGINE_SOCKET must be an absolute path directly in /run/pdf-engine');
    expect(() => runWorker({ env: { PGHOST: '127.0.0.1', PGPORT: '1', PDF_ENGINE_SOCKET: '/tmp/engine.sock' }, intervalMs: 3_600_000 })).toThrow('PDF_ENGINE_SOCKET');
  });
});
