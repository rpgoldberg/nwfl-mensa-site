// The output gate's child process (UNTRUSTED-PDF-GATE M2): every check of a copy runs in a child of
// its own, with no environment, a capped heap, a memory watchdog, a deadline and no way to start a
// process. Its children here are stand-ins (test/pdf/gate-children), all benign: the ones that use
// memory or start processes run only in a capped container (test/pdf/gate-rerun.test.ts).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256Hex } from './engine-protocol.js';
import { GATE_CHILD, GATE_HEAP_MB, GATE_MAX_RSS_BYTES, GATE_TIMEOUT_MS, gateExecArgv, isolatedGate, rssOf } from './gate-isolated.js';
import { guardFlag } from './no-fork.js';

const child = (name: string): string => fileURLToPath(new URL(`../../test/pdf/gate-children/${name}.ts`, import.meta.url));
const COPY = Uint8Array.from([1, 2, 3]);
const JOB = { copy: COPY, original: Uint8Array.from([9]), quotes: ['Kestrel Ambry'], image: 'blur' as const };
const guard = (name: string): string => fileURLToPath(new URL(`../../test/pdf/guards/${name}.ts`, import.meta.url));
const unfinished = (cause: string) => ({ verdict: { pass: false, code: 'unfinished' }, sha256: null, cause });

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const step of cleanup.splice(0)) step();
});

describe('isolatedGate', () => {
  it('has the limits fc\'s manifest sizes the gate sidecar for, and runs the built gate-child.js by default', () => {
    expect(GATE_TIMEOUT_MS).toBe(120_000);
    expect(GATE_HEAP_MB).toBe(512);
    expect(GATE_MAX_RSS_BYTES).toBe(768 * 1024 * 1024);
    expect(GATE_CHILD.endsWith(`${path.sep}gate-child.js`)).toBe(true);
  });

  it('hands back the child\'s verdict, the sha256 of the copy, and on a pass the bytes it checked with their sha256 (M1)', async () => {
    expect(await isolatedGate({ module: child('pass') })(JOB)).toEqual({ verdict: { pass: true }, sha256: sha256Hex(COPY), checked: { pdf: COPY, sha256: sha256Hex(COPY) } });
    // A wrong hash is passed on as it came: the caller compares it.
    const other = new TextEncoder().encode('other bytes');
    expect(await isolatedGate({ module: child('wrongsha') })(JOB)).toEqual({ verdict: { pass: true }, sha256: sha256Hex(other), checked: { pdf: other, sha256: sha256Hex(other) } });
  });

  it('gives no pass for a pass without checked bytes, with checked bytes over the output cap, or with checked bytes that are not bytes (M1)', async () => {
    expect(await isolatedGate({ module: child('bare') })(JOB)).toEqual(unfinished('crash'));
    expect(await isolatedGate({ module: child('oversize') })(JOB)).toEqual(unfinished('crash'));
    expect(await isolatedGate({ module: child('oversize') })({ ...JOB, quotes: ['text'] })).toEqual(unfinished('crash'));
  });

  it('gives no pass for a child that passes and then exits 3, or passes and then is killed (S4)', async () => {
    expect(await isolatedGate({ module: child('passexit') })(JOB)).toEqual(unfinished('crash'));
    expect(await isolatedGate({ module: child('passkill') })(JOB)).toEqual(unfinished('crash'));
  });

  it('gives no pass for a child that crashed, answered something else, or could not be started, and says it crashed', async () => {
    expect(await isolatedGate({ module: child('crash') })(JOB)).toEqual(unfinished('crash'));
    expect(await isolatedGate({ module: child('garbage') })(JOB)).toEqual(unfinished('crash'));
    expect(await isolatedGate({ module: child('no-such-child') })(JOB)).toEqual(unfinished('crash'));
  });

  it('kills a child past its deadline, and says so', async () => {
    const t0 = Date.now();
    expect(await isolatedGate({ module: child('hang'), timeoutMs: 300 })(JOB)).toEqual(unfinished('deadline'));
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('kills a child whose memory passes its cap at the watchdog, long before the deadline, and says it was memory (M2)', async () => {
    // A spy stands in for /proc: the child (hang) uses no memory, so nothing here stresses the host.
    // Without the watchdog this is a deadline kill at 10 s, not a memory kill: the test goes red.
    const read: number[] = [];
    const rss = (pid: number): number => {
      read.push(pid);
      return read.length >= 3 ? 300 * 1024 * 1024 : 50 * 1024 * 1024;
    };
    const t0 = Date.now();
    expect(await isolatedGate({ module: child('hang'), maxRssBytes: 256 * 1024 * 1024, timeoutMs: 10_000, rss })(JOB)).toEqual(unfinished('memory'));
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(read.length).toBeGreaterThanOrEqual(3);
  });

  it('refuses the check when the child\'s process limit cannot be set or its spawn still works (no-fork), before it is sent the copy', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nwfl-gi-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const out = path.join(dir, 'report.json');
    const failing = (): Promise<void> => Promise.reject(Object.assign(new Error('prlimit: not found'), { code: 'ENOENT' }));
    expect(await isolatedGate({ module: child('report'), limit: failing })({ ...JOB, quotes: [out] })).toEqual(unfinished('no-fork'));
    // A guard stand-in that says a process started (it starts none): the parent refuses it too.
    expect(await isolatedGate({ module: child('report'), guard: guard('lies') })({ ...JOB, quotes: [out] })).toEqual(unfinished('no-fork'));
    expect(() => readFileSync(out)).toThrow();
  });

  it('gives the child no environment, no --env-file, and a heap capped at 512 MiB', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nwfl-gi-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const out = path.join(dir, 'report.json');
    expect((await isolatedGate({ module: child('report') })({ ...JOB, quotes: [out] })).verdict).toEqual({ pass: true });
    const report = JSON.parse(readFileSync(out, 'utf8')) as { env: string[]; execArgv: string[]; heapLimitMb: number; pid: number; limits: string };
    expect(report.env).toEqual([]);
    expect(report.execArgv).toContain('--max-old-space-size=512');
    expect(report.execArgv.at(-1)).toBe(guardFlag());
    expect(report.execArgv.join(' ')).not.toContain('--env-file');
    expect(report.limits).toMatch(/^Max processes\s+1\s+1\s+processes/);
    expect(report.heapLimitMb).toBeGreaterThanOrEqual(512);
    // V8 adds its young generation to the old space's 512 MiB (704 MiB on Node 24); uncapped it is several GiB.
    expect(report.heapLimitMb).toBeLessThan(1024);
    expect(report.pid).not.toBe(process.pid);
  });

  it('drops every --env-file flag of its parent, both spellings, keeps the rest, caps the heap, and preloads the guard last (S4)', () => {
    const parent = ['--env-file=/srv/worker.env', '--conditions', 'node', '--env-file', '/srv/other.env', '--env-file-if-exists=/srv/maybe.env', '--env-file-if-exists', '/srv/maybe2.env', '--max-semi-space-size=16'];
    expect(gateExecArgv(parent, ['--import', '/hook.mjs'], '/guard.js')).toEqual(['--conditions', 'node', '--max-semi-space-size=16', '--import', '/hook.mjs', '--max-old-space-size=512', '--import=file:///guard.js']);
    expect(gateExecArgv([])).toEqual(['--max-old-space-size=512', guardFlag()]);
  });

  it('kills the child when its signal aborts, and forks none for one already aborted', async () => {
    const stop = new AbortController();
    const job = isolatedGate({ module: child('hang'), signal: stop.signal })(JOB);
    setTimeout(() => stop.abort(), 200);
    expect(await job).toEqual(unfinished('signal'));
    expect(await isolatedGate({ module: child('pass'), signal: stop.signal })(JOB)).toEqual(unfinished('signal'));
  });

  it('reads a process\'s resident memory from /proc, and nothing for one that is gone', () => {
    expect(rssOf(process.pid)).toBeGreaterThan(10 * 1024 * 1024);
    expect(rssOf(2 ** 22 + 7)).toBe(0);
  });
});
