import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GATE_CHILD_SOURCE, NODE_FLAGS } from '../../test/helpers/sidecar.js';
import { RetryableEngineError } from './regenerate.js';
import { RERUN_REASONS, RERUN_REFUSAL } from './rerun.js';
import { startSidecar } from './sidecar.js';
import { UNTRUSTED_PDF_READY } from './untrusted.js';
import { IN_POD_GATE_MAX_RSS_BYTES, WORKER_ROLE, createWorkerPool, runWorker, workerPoolConfig, workerRedact } from './worker.js';

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

  it('refuses a LINK_ORIGIN that is not https and a host, before it opens a pool (LINKS L3)', () => {
    for (const bad of ['http://nwflorida.us', 'https://nwflorida.us/out', 'https://evil.example@nwflorida.us']) {
      expect(() => runWorker({ env: { PGHOST: '127.0.0.1', PGPORT: '1', LINK_ORIGIN: bad }, intervalMs: 3_600_000 }), bad).toThrow("LINK_ORIGIN must be https:// and the site's host, with no path");
    }
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

describe('workerRedact: the engine and the gate the worker uses, chosen by PDF_ENGINE_SOCKET and PDF_GATE_SOCKET (UNTRUSTED-PDF-GATE)', () => {
  const ONE = Uint8Array.from([1, 2, 3]);
  const gateChild = (name: string): string => fileURLToPath(new URL(`../../test/pdf/gate-children/${name}.ts`, import.meta.url));
  const dirs: string[] = [];
  const fresh = (): string => {
    const made = mkdtempSync(path.join(tmpdir(), 'nwfl-wr-'));
    dirs.push(made);
    return made;
  };
  afterEach(() => {
    for (const made of dirs.splice(0)) rmSync(made, { recursive: true, force: true });
  });

  it('without the sockets, forks the in-pod engine child, and checks every copy in the in-pod gate child, never in the worker', async () => {
    expect(await workerRedact({}, { engine: child('refuse') })(ONE, { quotes: ['Kestrel'], redactsAny: true })).toEqual({ kind: 'refused', reason: 'refused by the engine process' });
    expect(await workerRedact({}, { engine: child('echo'), gateChild: gateChild('pass') })(ONE, { quotes: [], redactsAny: true })).toEqual({ kind: 'redacted', pdf: Uint8Array.from([3, 2, 1]) });
    expect(await workerRedact({}, { engine: child('echo'), gateChild: gateChild('crash') })(ONE, { quotes: [], redactsAny: true })).toEqual({ kind: 'refused', reason: RERUN_REASONS.unfinished });
    expect(await workerRedact({}, { engine: child('echo'), gateChild: gateChild('hang'), gateChildTimeoutMs: 300 })(ONE, { quotes: [], redactsAny: true })).toEqual({
      kind: 'refused',
      reason: RERUN_REASONS.unfinished,
    });
  });

  it('re-runs the real gate on every copy, whatever the engine: one it cannot read is refused', async () => {
    const real = { gateChild: GATE_CHILD_SOURCE, gateNodeFlags: NODE_FLAGS };
    expect(await workerRedact({}, { engine: child('echo'), ...real })(ONE, { quotes: ['Kestrel'], redactsAny: true })).toEqual({ kind: 'refused', reason: RERUN_REFUSAL });
    const given = () => Promise.resolve({ kind: 'redacted' as const, pdf: Uint8Array.from([9]), boxes: [] });
    expect(await workerRedact({}, { redact: given, ...real })(ONE, { quotes: [], redactsAny: true })).toEqual({ kind: 'refused', reason: RERUN_REASONS.rules });
  });

  it('with both sockets, talks only to the sidecars: a missing engine or gate socket fails the job closed, never an in-pod child', async () => {
    const engineDir = fresh();
    const gateDir = fresh();
    const env = { PDF_ENGINE_SOCKET: path.join(engineDir, 'engine.sock'), PDF_GATE_SOCKET: path.join(gateDir, 'gate.sock') };
    // The in-pod children named here would answer if the worker ever fell back to them.
    const fallbacks = { engine: child('echo'), gateChild: gateChild('pass'), socketDirs: [engineDir], gateSocketDirs: [gateDir], engineTimeoutMs: 1_000, gateTimeoutMs: 1_000 };
    const noEngine = workerRedact(env, fallbacks)(ONE, { quotes: ['Kestrel'], redactsAny: true });
    await expect(noEngine).rejects.toBeInstanceOf(RetryableEngineError);
    await expect(noEngine).rejects.toThrow('the engine socket is missing');
    const engine = await startSidecar({ path: env.PDF_ENGINE_SOCKET, module: child('echo'), log: () => {} });
    try {
      const noGate = workerRedact(env, fallbacks)(ONE, { quotes: ['Kestrel'], redactsAny: true });
      await expect(noGate).rejects.toBeInstanceOf(RetryableEngineError);
      await expect(noGate).rejects.toThrow('the gate socket is missing');
    } finally {
      await engine.close();
    }
  });

  it('caps the in-pod gate child at IN_POD_GATE_MAX_RSS_BYTES (640 MiB: 384 refused ordinary 4 MiB copies, fix round 4, S3)', async () => {
    expect(IN_POD_GATE_MAX_RSS_BYTES).toBe(640 * 1024 * 1024);
    // A spy stands in for /proc: the child (hang) uses no memory. Over the cap, the watchdog kills it at
    // once; under a larger cap it would run to its 5 s deadline.
    const over = () => IN_POD_GATE_MAX_RSS_BYTES + 1;
    const t0 = Date.now();
    expect(await workerRedact({}, { engine: child('echo'), gateChild: gateChild('hang'), gateChildTimeoutMs: 5_000, gateRss: over })(ONE, { quotes: [], redactsAny: true })).toEqual({
      kind: 'refused',
      reason: RERUN_REASONS.unfinished,
    });
    expect(Date.now() - t0).toBeLessThan(3_000);
    const under = () => IN_POD_GATE_MAX_RSS_BYTES;
    expect((await workerRedact({}, { engine: child('echo'), gateChild: gateChild('pass'), gateRss: under })(ONE, { quotes: [], redactsAny: true })).kind).toBe('redacted');
  });

  it('once UNTRUSTED_PDF_READY is true, refuses to start without both sockets: untrusted PDFs are parsed only in the sidecars (S6)', () => {
    const sockets = { PDF_ENGINE_SOCKET: '/run/pdf-engine/engine.sock', PDF_GATE_SOCKET: '/run/pdf-gate/gate.sock' };
    expect(() => workerRedact({}, { ready: true })).toThrow('UNTRUSTED_PDF_READY is true: the worker parses PDFs only in the sidecars; set PDF_ENGINE_SOCKET and PDF_GATE_SOCKET');
    expect(() => workerRedact({ PDF_GATE_SOCKET: sockets.PDF_GATE_SOCKET }, { ready: true })).toThrow('UNTRUSTED_PDF_READY is true');
    expect(() => workerRedact(sockets, { ready: true })).not.toThrow();
    // The default is the flag itself (fix round 4, integrity N2): with no sockets the in-pod mode starts exactly while it is false.
    if (UNTRUSTED_PDF_READY) expect(() => workerRedact({}, {})).toThrow('UNTRUSTED_PDF_READY is true');
    else expect(() => workerRedact({}, {})).not.toThrow();
    expect(() => runWorker({ env: { PGHOST: '127.0.0.1', PGPORT: '1' }, ready: true, intervalMs: 3_600_000 })).toThrow('UNTRUSTED_PDF_READY is true');
  });

  it('refuses PDF_ENGINE_SOCKET without PDF_GATE_SOCKET, or either outside its directory, and so does runWorker, before it opens a pool', () => {
    expect(() => workerRedact({ PDF_ENGINE_SOCKET: 'engine.sock' }, {})).toThrow('PDF_ENGINE_SOCKET must be an absolute path directly in /run/pdf-engine');
    expect(() => workerRedact({ PDF_ENGINE_SOCKET: '/run/pdf-engine/engine.sock' }, {})).toThrow('PDF_GATE_SOCKET must be set whenever PDF_ENGINE_SOCKET is');
    expect(() => workerRedact({ PDF_ENGINE_SOCKET: '/run/pdf-engine/engine.sock', PDF_GATE_SOCKET: '/run/pdf-engine/gate.sock' }, {})).toThrow(
      'PDF_GATE_SOCKET must be an absolute path directly in /run/pdf-gate',
    );
    expect(() => runWorker({ env: { PGHOST: '127.0.0.1', PGPORT: '1', PDF_ENGINE_SOCKET: '/tmp/engine.sock' }, intervalMs: 3_600_000 })).toThrow('PDF_ENGINE_SOCKET');
    expect(() => runWorker({ env: { PGHOST: '127.0.0.1', PGPORT: '1', PDF_ENGINE_SOCKET: '/run/pdf-engine/engine.sock' }, intervalMs: 3_600_000 })).toThrow('PDF_GATE_SOCKET');
  });
});
