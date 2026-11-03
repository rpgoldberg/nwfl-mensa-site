// The output gate's child process (UNTRUSTED-PDF-GATE M2): every check of a copy runs in a child of
// its own, with no environment, a capped heap, a memory watchdog and a deadline, and whatever it
// started is killed after it. Its children here are stand-ins (test/pdf/gate-children).
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { aliveWith } from '../../test/helpers/sidecar.js';
import { sha256Hex } from './engine-protocol.js';
import { GATE_CHILD, GATE_HEAP_MB, GATE_MAX_RSS_BYTES, GATE_TIMEOUT_MS, isolatedGate, rssOf } from './gate-isolated.js';

const child = (name: string): string => fileURLToPath(new URL(`../../test/pdf/gate-children/${name}.ts`, import.meta.url));
const COPY = Uint8Array.from([1, 2, 3]);
const JOB = { copy: COPY, original: Uint8Array.from([9]), quotes: ['Kestrel Ambry'], image: 'blur' as const };
const UNFINISHED = { verdict: { pass: false, code: 'unfinished' }, sha256: null };

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

  it('hands back the child\'s verdict and the sha256 of the bytes it checked', async () => {
    expect(await isolatedGate({ module: child('pass') })(JOB)).toEqual({ verdict: { pass: true }, sha256: sha256Hex(COPY) });
    // A wrong hash is passed on as it came: the caller compares it.
    expect(await isolatedGate({ module: child('wrongsha') })(JOB)).toEqual({ verdict: { pass: true }, sha256: sha256Hex(Buffer.from('other bytes')) });
  });

  it('gives no pass for a child that crashed, answered something else, or could not be started', async () => {
    expect(await isolatedGate({ module: child('crash') })(JOB)).toEqual(UNFINISHED);
    expect(await isolatedGate({ module: child('garbage') })(JOB)).toEqual(UNFINISHED);
    expect(await isolatedGate({ module: child('no-such-child') })(JOB)).toEqual(UNFINISHED);
  });

  it('kills a child past its deadline', async () => {
    const t0 = Date.now();
    expect(await isolatedGate({ module: child('hang'), timeoutMs: 300 })(JOB)).toEqual(UNFINISHED);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('kills a child whose memory outgrows its cap, outside the heap too, long before the deadline', async () => {
    const t0 = Date.now();
    expect(await isolatedGate({ module: child('hog'), maxRssBytes: 256 * 1024 * 1024, timeoutMs: 60_000 })(JOB)).toEqual(UNFINISHED);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it('gives the child no environment, no --env-file, and a heap capped at 512 MiB', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nwfl-gi-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const out = path.join(dir, 'report.json');
    expect((await isolatedGate({ module: child('report') })({ ...JOB, quotes: [out] })).verdict).toEqual({ pass: true });
    const report = JSON.parse(readFileSync(out, 'utf8')) as { env: string[]; execArgv: string[]; heapLimitMb: number; pid: number };
    expect(report.env).toEqual([]);
    expect(report.execArgv).toContain('--max-old-space-size=512');
    expect(report.execArgv.join(' ')).not.toContain('--env-file');
    expect(report.heapLimitMb).toBeGreaterThanOrEqual(512);
    // V8 adds its young generation to the old space's 512 MiB (704 MiB on Node 24); uncapped it is several GiB.
    expect(report.heapLimitMb).toBeLessThan(1024);
    expect(report.pid).not.toBe(process.pid);
  });

  it('kills the child when its signal aborts, and forks none for one already aborted', async () => {
    const stop = new AbortController();
    const job = isolatedGate({ module: child('hang'), signal: stop.signal })(JOB);
    setTimeout(() => stop.abort(), 200);
    expect(await job).toEqual(UNFINISHED);
    expect(await isolatedGate({ module: child('pass'), signal: stop.signal })(JOB)).toEqual(UNFINISHED);
  });

  it('kills what the child left in its process group once it is done', async () => {
    const marker = `nwfl-gate-left-${randomUUID()}`;
    expect((await isolatedGate({ module: child('leave') })({ ...JOB, quotes: ['group', marker] })).verdict).toEqual({ pass: true });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(aliveWith(marker)).toEqual([]);
  });

  it('reads a process\'s resident memory from /proc, and nothing for one that is gone', () => {
    expect(rssOf(process.pid)).toBeGreaterThan(10 * 1024 * 1024);
    expect(rssOf(2 ** 22 + 7)).toBe(0);
  });
});
