// The gate sidecar's own code, in this process (UNTRUSTED-PDF-GATE M2): the output gate as a second
// sidecar, its own container and uid, one capped child per check. The lift test
// (test/pdf/gate-rerun.test.ts) runs the real entry as a process. Children here are stand-ins.
import { existsSync, lstatSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { GATE_REPLY_MAGIC, GATE_REQUEST_MAGIC, MAX_GATE_REPLY_HEADER_BYTES, decodeGateReply, encodeFrame, encodeGateRequest, readFrame, sha256Hex } from './engine-protocol.js';
import { DEFAULT_GATE_SOCKET, GATE_SOCKET_DIR, gateSidecarMain, startGateSidecar } from './gate-service.js';
import type { Sidecar } from './sidecar.js';
import { socketGate } from './socket-gate.js';

const child = (name: string): string => fileURLToPath(new URL(`../../test/pdf/gate-children/${name}.ts`, import.meta.url));
const COPY = Uint8Array.from([7, 7, 7]);
const SHA = sha256Hex(COPY);
const ORIGINAL = Uint8Array.from([9, 9]);
const JOB = { copy: COPY, original: ORIGINAL, quotes: ['Kestrel Ambry'], image: 'blur' as const, sha256: SHA };

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function place(): { dir: string; socket: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'nwfl-gs-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, socket: path.join(dir, 'gate.sock') };
}

async function started(options: Partial<Parameters<typeof startGateSidecar>[0]> = {}): Promise<{ sidecar: Sidecar; socket: string; logged: string[] }> {
  const { socket } = place();
  const logged: string[] = [];
  const sidecar = await startGateSidecar({ path: socket, module: child('pass'), log: (line) => void logged.push(line), ...options });
  cleanup.push(() => sidecar.close());
  return { sidecar, socket, logged };
}

/** Sends one raw frame and reads the gate's reply frame (or rejects when it hangs up without one). */
async function ask(socket: string, frame: Buffer): Promise<ReturnType<typeof decodeGateReply>> {
  const conn = net.createConnection({ path: socket });
  conn.on('error', () => {});
  const read = readFrame(conn, { magic: GATE_REPLY_MAGIC, maxHeader: MAX_GATE_REPLY_HEADER_BYTES, maxBody: 0, untilEnd: true });
  conn.write(frame);
  try {
    return decodeGateReply(await read);
  } finally {
    conn.destroy();
  }
}

describe('startGateSidecar', () => {
  it('checks each copy in a child of its own and answers with the sha256 of the bytes it checked, on a 0660 socket', async () => {
    const { socket } = await started();
    expect(lstatSync(socket).mode & 0o777).toBe(0o660);
    expect(await socketGate({ path: socket })(JOB)).toEqual({ verdict: { pass: true }, sha256: SHA });
  });

  it('refuses a copy whose bytes do not match the sha256 the worker sent, before any child reads it', async () => {
    const dir = place().dir;
    const report = path.join(dir, 'report.json');
    const { socket } = await started({ module: child('report') });
    const frame = encodeGateRequest({ ...JOB, quotes: [report], sha256: sha256Hex(Buffer.from('another copy')), originalSha256: sha256Hex(ORIGINAL) });
    expect(await ask(socket, frame)).toEqual({ verdict: { pass: false, code: 'mismatch' }, sha256: SHA });
    const original = encodeGateRequest({ ...JOB, quotes: [report], originalSha256: sha256Hex(Buffer.from('another original')) });
    expect(await ask(socket, original)).toEqual({ verdict: { pass: false, code: 'mismatch' }, sha256: SHA });
    expect(existsSync(report)).toBe(false);
  });

  it('refuses a check whose child names other bytes than it was sent', async () => {
    const { socket } = await started({ module: child('wrongsha') });
    expect(await socketGate({ path: socket })(JOB)).toEqual({ verdict: { pass: false, code: 'mismatch' }, sha256: SHA });
  });

  it('answers "unfinished", never a pass, when its child crashes, answers garbage, outgrows its memory or runs past its deadline', async () => {
    for (const [name, options] of [
      ['crash', {}],
      ['garbage', {}],
      ['hog', { maxRssBytes: 256 * 1024 * 1024 }],
      ['hang', { timeoutMs: 300 }],
    ] as const) {
      const { socket } = await started({ module: child(name), ...options });
      expect(await socketGate({ path: socket })(JOB), name).toEqual({ verdict: { pass: false, code: 'unfinished' }, sha256: SHA });
    }
  });

  it('drops a malformed request without a reply and keeps serving', async () => {
    const { socket, logged } = await started();
    const bad = encodeFrame(GATE_REQUEST_MAGIC, { v: 1, quotes: [], image: 'show', sha256: SHA, originalSha256: sha256Hex(ORIGINAL), copyBytes: 3, env: { PGPASSWORD: 'canary' } }, Buffer.concat([COPY, ORIGINAL]));
    await expect(ask(socket, bad)).rejects.toThrow();
    expect(logged.join('\n')).toContain('refused a request: ');
    expect(logged.join('\n')).not.toContain('canary');
    expect(await socketGate({ path: socket })(JOB)).toEqual({ verdict: { pass: true }, sha256: SHA });
  });
});

describe('gateSidecarMain (the gate entry\'s logic)', () => {
  const SHARED = ['--shared-pid-namespace'];

  it('binds by default at /run/pdf-gate/gate.sock, and only directly in /run/pdf-gate', async () => {
    expect(GATE_SOCKET_DIR).toBe('/run/pdf-gate');
    expect(DEFAULT_GATE_SOCKET).toBe('/run/pdf-gate/gate.sock');
    for (const socket of ['/run/pdf-engine/gate.sock', '/run/pdf-gate/x/gate.sock', 'gate.sock']) {
      const lines: string[] = [];
      expect(await gateSidecarMain(['--socket', socket, ...SHARED], {}, (line) => void lines.push(line)), socket).toEqual({ code: 2 });
      expect(lines.join('\n'), socket).toContain('--socket must be an absolute path directly in /run/pdf-gate');
    }
  });

  it('refuses an environment off the allow-list, unknown arguments and bad limits, exit 2', async () => {
    const { dir } = place();
    const lines: string[] = [];
    expect(await gateSidecarMain([], { PGPASSWORD: 'canary' }, (line) => void lines.push(line))).toEqual({ code: 2 });
    expect(lines.join('\n')).toContain('the gate sidecar refuses to start: its environment holds PGPASSWORD');
    expect(lines.join('\n')).not.toContain('canary');
    for (const argv of [['--engine', 'x'], ['--max-rss-mb', '0'], ['--max-rss-mb', '4097'], ['--max-rss-mb', 'lots'], ['--timeout-ms', '-1']]) {
      expect(await gateSidecarMain([...argv, '--socket-dir', dir, ...SHARED], {}, () => {}), argv.join(' ')).toEqual({ code: 2 });
    }
  });

  it('refuses to run as PID 1, exit 2', async () => {
    const { dir } = place();
    const lines: string[] = [];
    const system = { pid: 1, ppid: 0, uid: 10004, procRoot: dir, kill: () => {} };
    expect(await gateSidecarMain(['--socket-dir', dir], {}, (line) => void lines.push(line), { system })).toEqual({ code: 2 });
    expect(lines.join('\n')).toMatch(/is PID 1/);
  });

  it('starts with a gate child, a deadline and a memory cap from its arguments, and says it is listening', async () => {
    const { dir, socket } = place();
    const lines: string[] = [];
    const result = await gateSidecarMain(['--socket-dir', dir, ...SHARED, '--gate', child('hog'), '--timeout-ms', '30000', '--max-rss-mb', '200'], { NODE_ENV: 'test' }, (line) => void lines.push(line));
    const { sidecar } = result as { sidecar: Sidecar };
    cleanup.push(() => sidecar.close());
    expect(lines).toContain('gate sidecar listening (not sweeping: shared PID namespace, for tests)');
    const t0 = Date.now();
    expect(await socketGate({ path: socket })(JOB)).toEqual({ verdict: { pass: false, code: 'unfinished' }, sha256: SHA });
    expect(Date.now() - t0).toBeLessThan(15_000);
  });

  it('exits 1 when it cannot listen', async () => {
    const lines: string[] = [];
    expect(await gateSidecarMain(['--socket-dir', path.join(place().dir, 'none'), ...SHARED], {}, (line) => void lines.push(line))).toEqual({ code: 1 });
    expect(lines.join('\n')).toContain('the gate sidecar cannot listen');
  });
});
