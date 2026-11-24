// ARCHIVE-SEARCH S2: how the worker reads a copy's text (worker.ts workerText) and when the
// regenerator runs the index job (regenerate.ts: `index` after a finished run, `after` once each
// drain is over). Stand-in children and a made-up database; every name is made up.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/pool.js';
import { gateStandIn } from '../../test/helpers/sidecar.js';
import { sha256Hex } from './engine-protocol.js';
import { startGateSidecar } from './gate-service.js';
import { regenerateOne, startRegenerator } from './regenerate.js';
import { workerText } from './worker.js';

const COPY = Uint8Array.from([4, 4, 4]);
const SHA = sha256Hex(COPY);
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('workerText', () => {
  it('reads in a capped child of the worker when no gate socket is set (the pre-sidecar mode), at the in-pod limits', async () => {
    const text = workerText({}, { gateChild: gateStandIn('text') });
    expect(await text({ copy: COPY, sha256: SHA, quotes: ['Kestrel Ambry'] })).toEqual({ sha256: SHA, pages: [{ text: 'text:3', extra: 'Kestrel Ambry' }] });
    expect(await workerText({}, { gateChild: gateStandIn('hang'), gateChildTimeoutMs: 300 })({ copy: COPY, sha256: SHA, quotes: [] })).toEqual({ sha256: null, code: 'unfinished', cause: 'deadline' });
    const over = (): number => 641 * 1024 * 1024;
    expect(await workerText({}, { gateChild: gateStandIn('hang'), gateChildTimeoutMs: 5_000, gateRss: over })({ copy: COPY, sha256: SHA, quotes: [] })).toEqual({ sha256: null, code: 'unfinished', cause: 'memory' });
  });

  it('asks the gate sidecar when PDF_GATE_SOCKET is set, and never falls back to a child', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nwfl-wt-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const engineDir = mkdtempSync(path.join(tmpdir(), 'nwfl-we-'));
    cleanup.push(() => rmSync(engineDir, { recursive: true, force: true }));
    const env = { PDF_ENGINE_SOCKET: path.join(engineDir, 'engine.sock'), PDF_GATE_SOCKET: path.join(dir, 'gate.sock') };
    const options = { socketDirs: [engineDir], gateSocketDirs: [dir], gateChild: gateStandIn('crash'), gateTimeoutMs: 5_000 };
    // No sidecar yet: the reading fails; the worker's own child (a stand-in that would crash) is not asked.
    await expect(workerText(env, options)({ copy: COPY, sha256: SHA, quotes: [] })).rejects.toMatchObject({ code: 'PDF_ENGINE_UNAVAILABLE' });
    const sidecar = await startGateSidecar({ path: env.PDF_GATE_SOCKET, module: gateStandIn('text'), log: () => {} });
    cleanup.push(() => sidecar.close());
    expect(await workerText(env, options)({ copy: COPY, sha256: SHA, quotes: ['q'] })).toEqual({ sha256: SHA, pages: [{ text: 'text:3', extra: 'q' }] });
  });

  it('refuses a gate socket outside its directory, as the engine\'s choice does', () => {
    expect(() => workerText({ PDF_ENGINE_SOCKET: '/run/pdf-engine/engine.sock', PDF_GATE_SOCKET: '/tmp/gate.sock' }, {})).toThrow('PDF_GATE_SOCKET');
  });
});

describe('the regenerator and the index job', () => {
  /** A database with one queued file that makes no copy: the claim, no targets, the ledger, the finish. */
  const oneFile = (done: boolean) => {
    let claimed = false;
    const query = (sql: string): Promise<{ rows: unknown[] }> => {
      if (sql.includes('pdf_regen_claim')) {
        const rows = claimed ? [] : [{ file_id: 'file-1', claim: 'claim-1', attempts: 1 }];
        claimed = true;
        return Promise.resolve({ rows });
      }
      if (sql.includes('pdf_regen_finish')) return Promise.resolve({ rows: [{ done }] });
      return Promise.resolve({ rows: [] });
    };
    const client = { query, release: () => {} };
    return { query, connect: () => Promise.resolve(client) } as unknown as Db;
  };

  it('indexes a file once its run has finished, and not one that was queued again meanwhile', async () => {
    const indexed: string[] = [];
    const index = (fileId: string): Promise<void> => Promise.resolve(void indexed.push(fileId));
    expect(await regenerateOne(oneFile(true), { index })).toEqual({ fileId: 'file-1', done: true });
    expect(indexed).toEqual(['file-1']);
    expect(await regenerateOne(oneFile(false), { index })).toEqual({ fileId: 'file-1', done: false });
    expect(indexed).toEqual(['file-1']);
  });

  it('finishes the run whatever the index job does, and says so without the error\'s message', async () => {
    const warned: unknown[] = [];
    const index = (): Promise<void> => Promise.reject(Object.assign(new TypeError('text of a page'), { code: 'E_TEXT' }));
    expect(await regenerateOne(oneFile(true), { index, warn: (fields, message) => void warned.push([fields, message]) })).toEqual({ fileId: 'file-1', done: true });
    expect(warned).toEqual([[{ file_id: 'file-1', error_name: 'TypeError', error_code: 'E_TEXT' }, 'a PDF copy was made but not indexed']]);
    expect(await regenerateOne(oneFile(true), { index })).toEqual({ fileId: 'file-1', done: true });
    warned.length = 0;
    // Whatever is thrown, an Error or not.
    const notAnError: Error = Object.create(null) as Error;
    expect(await regenerateOne(oneFile(true), { index: () => Promise.reject(notAnError), warn: (fields, message) => void warned.push([fields, message]) })).toEqual({ fileId: 'file-1', done: true });
    expect(warned).toEqual([[{ file_id: 'file-1', error_name: 'unknown' }, 'a PDF copy was made but not indexed']]);
  });

  it('runs `after` once each drain is over, hears its failure, and still runs the next drain', async () => {
    const order: string[] = [];
    const errors: unknown[] = [];
    let afters = 0;
    const db = { query: (sql: string): Promise<{ rows: unknown[] }> => (sql.includes('pdf_regen_claim') && order.push('drain'), Promise.resolve({ rows: [] })) } as unknown as Db;
    const job = startRegenerator({
      db,
      intervalMs: 10,
      before: () => Promise.resolve(void order.push('before')),
      after: () => {
        order.push('after');
        return ++afters === 1 ? Promise.reject(new Error('the sweep failed')) : Promise.resolve();
      },
      onError: (error) => errors.push(error),
    });
    for (let n = 0; n < 200 && afters < 3; n++) await sleep(10);
    await job.stop();
    expect(order.slice(0, 7)).toEqual(['before', 'drain', 'after', 'drain', 'after', 'drain', 'after']);
    expect(errors.map(String)).toEqual(['Error: the sweep failed']);
  });

  it('does not run `after` when the drain failed', async () => {
    const errors: unknown[] = [];
    let afters = 0;
    const job = startRegenerator({ db: { query: () => Promise.reject(new Error('db down')) }, intervalMs: 10, after: () => Promise.resolve(void afters++), onError: (error) => errors.push(error) });
    for (let n = 0; n < 200 && errors.length < 2; n++) await sleep(10);
    await job.stop();
    expect(afters).toBe(0);
    expect(String(errors[0])).toBe('Error: db down');
  });
});
