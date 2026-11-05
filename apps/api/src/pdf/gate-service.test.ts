// The gate sidecar's own code, in this process (UNTRUSTED-PDF-GATE M2): the output gate as a second
// sidecar, its own container and uid, one capped child per check. The lift test
// (test/pdf/gate-rerun.test.ts) runs the real entry as a process. Children here are stand-ins.
import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { GATE_REPLY_MAGIC, GATE_REQUEST_MAGIC, MAX_GATE_REPLY_HEADER_BYTES, MAX_OUTPUT_BYTES, decodeGateReply, encodeFrame, encodeGateRequest, readFrame, sha256Hex } from './engine-protocol.js';
import { DEFAULT_GATE_SOCKET, GATE_SOCKET_DIR, gateSidecarMain, startGateSidecar } from './gate-service.js';
import type { Sidecar } from './sidecar.js';
import { RetryableEngineError } from './regenerate.js';
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
  const read = readFrame(conn, { magic: GATE_REPLY_MAGIC, maxHeader: MAX_GATE_REPLY_HEADER_BYTES, maxBody: MAX_OUTPUT_BYTES, untilEnd: true });
  conn.write(frame);
  try {
    return decodeGateReply(await read);
  } finally {
    conn.destroy();
  }
}

describe('startGateSidecar', () => {
  it('checks each copy in a child of its own and answers with the copy\'s sha256 and the bytes the child checked, on a 0660 socket', async () => {
    const { socket } = await started();
    expect(lstatSync(socket).mode & 0o777).toBe(0o660);
    const outcome = await socketGate({ path: socket })(JOB);
    expect(outcome).toEqual({ verdict: { pass: true }, sha256: SHA, checked: { pdf: expect.any(Uint8Array) as unknown, sha256: SHA } });
    expect([...(outcome.checked?.pdf ?? [])]).toEqual([...COPY]);
  });

  it('hands its child the links, their origin and the ids the engine kept (LINKS L3), as the worker sent them', async () => {
    const { socket } = await started({ module: child('links') });
    const links = [{ id: 'a'.repeat(26), page: 1, rect: [72, 700, 200, 714] as const, label: 'Link to site.example' }];
    const outcome = await socketGate({ path: socket })({ ...JOB, origin: 'https://nwflorida.us', links, kept: ['a'.repeat(26)] });
    expect(JSON.parse(Buffer.from(outcome.checked!.pdf).toString('utf8'))).toEqual({ origin: 'https://nwflorida.us', links, kept: ['a'.repeat(26)] });
    const none = await socketGate({ path: socket })(JOB);
    expect(JSON.parse(Buffer.from(none.checked!.pdf).toString('utf8'))).toEqual({ origin: null, links: [], kept: [] });
  });

  it('refuses a copy whose bytes do not match the sha256 the worker sent, before any child reads it', async () => {
    // A child sent either would pass (the report stand-in): mismatch means none was.
    const { socket } = await started({ module: child('report') });
    const frame = encodeGateRequest({ ...JOB, sha256: sha256Hex(Buffer.from('another copy')), originalSha256: sha256Hex(ORIGINAL) });
    expect(await ask(socket, frame)).toEqual({ verdict: { pass: false, code: 'mismatch' }, sha256: SHA });
    const original = encodeGateRequest({ ...JOB, originalSha256: sha256Hex(Buffer.from('another original')) });
    expect(await ask(socket, original)).toEqual({ verdict: { pass: false, code: 'mismatch' }, sha256: SHA });
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
    const bad = encodeFrame(GATE_REQUEST_MAGIC, { v: 2, quotes: [], image: 'show', sha256: SHA, originalSha256: sha256Hex(ORIGINAL), copyBytes: 3, links: [], kept: [], env: { PGPASSWORD: 'canary' } }, Buffer.concat([COPY, ORIGINAL]));
    await expect(ask(socket, bad)).rejects.toThrow();
    expect(logged.join('\n')).toContain('refused a request: ');
    expect(logged.join('\n')).not.toContain('canary');
    expect((await socketGate({ path: socket })(JOB)).verdict).toEqual({ pass: true });
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

  it('serves only as PID 1 of its container, exit 2 otherwise (fix round 2)', async () => {
    const { dir } = place();
    const lines: string[] = [];
    const sent: number[] = [];
    const system = { pid: 7, uid: 10004, procRoot: dir, kill: (pid: number) => void sent.push(pid), execArgv: ['--disable-sigusr1'] };
    expect(await gateSidecarMain(['--socket-dir', dir], {}, (line) => void lines.push(line), { system })).toEqual({ code: 2 });
    expect(lines.join('\n')).toMatch(/the gate sidecar must be PID 1 of its container and will not start: it is PID 7/);
    expect(sent).toEqual([]);
  });

  it('starts with a gate child, a deadline and a memory cap from its arguments, says it is listening, and logs why a check was unfinished', async () => {
    const { dir, socket } = place();
    const lines: string[] = [];
    const result = await gateSidecarMain(['--socket-dir', dir, ...SHARED, '--gate', child('hang'), '--timeout-ms', '400', '--max-rss-mb', '200'], { NODE_ENV: 'test' }, (line) => void lines.push(line));
    const { sidecar } = result as { sidecar: Sidecar };
    cleanup.push(() => sidecar.close());
    expect(lines).toContain('gate sidecar listening (not PID 1: shared PID namespace, for tests; nothing is cleared)');
    const t0 = Date.now();
    expect(await socketGate({ path: socket })(JOB)).toEqual({ verdict: { pass: false, code: 'unfinished' }, sha256: SHA });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(lines).toContain('a check was unfinished (deadline)');
  });

  it('as PID 1, clears its namespace (kill(-1)) at start and before every reply, and replies to none when it cannot (fix round 3, S3)', async () => {
    // A made-up /proc: the sidecar is PID 1, alone; kill() records, it kills nothing here.
    const view = (): { pid: number; uid: number; procRoot: string; kill: (pid: number) => void; execArgv: string[]; sent: number[] } => {
      const root = place().dir;
      mkdirSync(path.join(root, '1'));
      writeFileSync(path.join(root, '1', 'status'), 'Name:\tnode\nState:\tS (sleeping)\nUid:\t10004\t10004\t10004\t10004\n');
      const sent: number[] = [];
      return { pid: 1, uid: 10004, procRoot: root, kill: (pid) => void sent.push(pid), execArgv: ['--disable-sigusr1'], sent };
    };
    const { dir, socket } = place();
    const system = view();
    const lines: string[] = [];
    const result = await gateSidecarMain(['--socket-dir', dir, '--gate', child('pass')], {}, (line) => void lines.push(line), { system });
    const { sidecar } = result as { sidecar: Sidecar };
    cleanup.push(() => sidecar.close());
    expect(system.sent).toEqual([-1]);
    expect((await socketGate({ path: socket })(JOB)).verdict).toEqual({ pass: true });
    expect(system.sent).toEqual([-1, -1]);
    expect((await socketGate({ path: socket })(JOB)).verdict).toEqual({ pass: true });
    expect(system.sent).toEqual([-1, -1, -1]);
    // fc's apply step 17e greps this line: exactly once per start.
    expect(lines.filter((line) => line === 'gate sidecar listening (PID 1: clearing its PID namespace before every reply)')).toHaveLength(1);
    // A process the clear cannot remove (a zombie, here) is doubt: no reply, and the sidecar stops for good.
    const stuck = place();
    const doubted = view();
    const fatal: string[] = [];
    const second = await gateSidecarMain(['--socket-dir', stuck.dir, '--gate', child('pass')], {}, () => {}, { system: doubted, onFatal: (reason) => void fatal.push(reason) });
    cleanup.push(() => (second as { sidecar: Sidecar }).sidecar.close());
    mkdirSync(path.join(doubted.procRoot, '9'));
    writeFileSync(path.join(doubted.procRoot, '9', 'status'), 'Name:\tsh\nState:\tZ (zombie)\nUid:\t10004\t10004\t10004\t10004\n');
    await expect(socketGate({ path: stuck.socket })(JOB)).rejects.toBeInstanceOf(RetryableEngineError);
    expect(fatal.join('\n')).toContain('its PID namespace is not clear before a reply: an orphaned process');
  });

  it('runs its children under the permission model, and without it only with --no-child-permission, for tests (fix round 4, S2)', async () => {
    const tried = async (extra: string[]): Promise<Record<string, string>> => {
      const { dir, socket } = place();
      const target = place().dir;
      const result = await gateSidecarMain(['--socket-dir', dir, ...SHARED, '--gate', child('try-write'), ...extra], {}, () => {});
      const { sidecar } = result as { sidecar: Sidecar };
      cleanup.push(() => sidecar.close());
      const outcome = await socketGate({ path: socket })({ ...JOB, quotes: [target] });
      return JSON.parse(new TextDecoder().decode(outcome.checked?.pdf)) as Record<string, string>;
    };
    const modeled = await tried([]);
    expect(modeled['write']).toBe('ERR_ACCESS_DENIED');
    // The guard refuses a listen with the permission model (fix round 5b, S2); behind it, as the socket takeover tests need, it does not.
    expect(modeled['listen']).toBe('ERR_ACCESS_DENIED');
    // And the two ways under a listen, called directly (fix round 6, S2-6): no socket file is left.
    expect([modeled['listen2'], modeled['createServerHandle'], modeled['namedHandle'], modeled['left']]).toEqual(['ERR_ACCESS_DENIED', 'ERR_ACCESS_DENIED', 'ERR_ACCESS_DENIED', '']);
    const bare = await tried(['--no-child-permission']);
    expect(bare['write']).toBe('done');
    expect(bare['listen']).toBe('done');
    expect([bare['listen2'], bare['createServerHandle'], bare['namedHandle']]).toEqual(['done', 'done', 'done']);
    const lines: string[] = [];
    expect(await gateSidecarMain(['--no-child-permission'], { NODE_ENV: 'production' }, (line) => void lines.push(line))).toEqual({ code: 2 });
    expect(lines.join('\n')).toContain('--no-child-permission is for tests and refused in production');
  });

  it('exits 1 when it cannot listen', async () => {
    const lines: string[] = [];
    expect(await gateSidecarMain(['--socket-dir', path.join(place().dir, 'none'), ...SHARED], {}, (line) => void lines.push(line))).toEqual({ code: 1 });
    expect(lines.join('\n')).toContain('the gate sidecar cannot listen');
  });
});
