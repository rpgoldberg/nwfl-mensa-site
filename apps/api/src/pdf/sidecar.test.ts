// The engine sidecar's own code, in this process (UNTRUSTED-PDF-GATE). The lift test
// (test/pdf/engine-sidecar.test.ts) runs the same paths through the real entry as a process of its
// own; here they are covered. The engines are stand-ins (test/pdf/children).
import { spawn } from 'node:child_process';
import { lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { REQUEST_MAGIC, encodeRequest } from './engine-protocol.js';
import { RetryableEngineError } from './regenerate.js';
import { DEFAULT_SOCKET, READ_TIMEOUT_MS, SOCKET_MODE, type Sidecar, refusedEnv, sidecarMain, startSidecar } from './sidecar.js';
import { socketRedact } from './socket-engine.js';

const child = (name: string): string => fileURLToPath(new URL(`../../test/pdf/children/${name}.ts`, import.meta.url));
const REQUEST = { quotes: ['Kestrel Ambry'], redactsAny: true };
const ONE = Uint8Array.from([1]);

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function place(): { dir: string; socket: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'nwfl-sci-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, socket: path.join(dir, 'engine.sock') };
}

async function started(options: Partial<Parameters<typeof startSidecar>[0]> = {}): Promise<{ sidecar: Sidecar; socket: string; logged: string[] }> {
  const { socket } = place();
  const logged: string[] = [];
  const sidecar = await startSidecar({ path: socket, module: child('refuse'), log: (line) => void logged.push(line), ...options });
  cleanup.push(() => sidecar.close());
  return { sidecar, socket, logged };
}

/** Sends raw bytes and returns what came back before the sidecar closed. */
function exchange(socket: string, bytes: Uint8Array, end = false): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const conn = net.createConnection({ path: socket });
    conn.on('data', (chunk: Buffer) => chunks.push(chunk));
    conn.on('error', () => {});
    conn.on('close', () => resolve(Buffer.concat(chunks)));
    conn.write(bytes);
    if (end) conn.end();
  });
}

describe('refusedEnv', () => {
  it('names every variable that could hold a database login, a token, a secret, a key or a session', () => {
    const env = {
      DATABASE_URL: 'x',
      PGPASSWORD: 'x',
      PGHOST: 'x',
      pguser: 'x',
      GH_TOKEN: 'x',
      tokenFile: 'x',
      APP_SECRET: 'x',
      API_KEY: 'x',
      SESSION_COOKIE: 'x',
      NODE_ENV: 'production',
      HOME: '/',
      PATH: '/usr/bin',
      SERVICE_VERSION: '1',
      KUBERNETES_SERVICE_HOST: '10.0.0.1',
      DATABASE: 'not a url',
    };
    expect(refusedEnv(env)).toEqual(['API_KEY', 'APP_SECRET', 'DATABASE_URL', 'GH_TOKEN', 'PGHOST', 'PGPASSWORD', 'SESSION_COOKIE', 'pguser', 'tokenFile']);
    expect(refusedEnv({ NODE_ENV: 'production' })).toEqual([]);
  });
});

describe('startSidecar', () => {
  it('serves a copy per connection, from a child per copy, on a socket of mode 0660', async () => {
    const { socket, sidecar } = await started();
    expect(sidecar.path).toBe(socket);
    expect(SOCKET_MODE).toBe(0o660);
    expect(lstatSync(socket).mode & 0o777).toBe(0o660);
    const redact = socketRedact({ path: socket });
    expect(await redact(ONE, REQUEST)).toEqual({ kind: 'refused', reason: 'refused by the engine process' });
    expect(await redact(ONE, REQUEST)).toEqual({ kind: 'refused', reason: 'refused by the engine process' });
  });

  it('passes on the engine\'s copy, its failure, and a copy over the output cap as a failure', async () => {
    const echo = await started({ module: child('echo') });
    expect(await socketRedact({ path: echo.socket })(Uint8Array.from([1, 2, 3]), REQUEST)).toEqual({ kind: 'redacted', pdf: Uint8Array.from([3, 2, 1]), boxes: [] });
    const fail = await started({ module: child('fail') });
    const failed = socketRedact({ path: fail.socket })(ONE, REQUEST);
    await expect(failed).rejects.toThrow('the engine threw');
    await expect(failed).rejects.not.toBeInstanceOf(RetryableEngineError);
    const big = await started({ module: child('big') });
    await expect(socketRedact({ path: big.socket })(ONE, REQUEST)).rejects.toThrow('the copy is outside the engine output cap');
    const crash = await started({ module: child('crash') });
    await expect(socketRedact({ path: crash.socket })(ONE, REQUEST)).rejects.toThrow('the engine process ended without a copy (exit 3)');
  });

  it('kills a copy past its timeout', async () => {
    const { socket } = await started({ module: child('selective'), timeoutMs: 200 });
    await expect(socketRedact({ path: socket })(ONE, { quotes: ['hang'], redactsAny: true })).rejects.toThrow('the engine process took longer than 200 ms');
  });

  it('kills the copy of a worker that hung up, and frees the slot for the next', async () => {
    const { socket } = await started({ module: child('selective') });
    await expect(socketRedact({ path: socket, timeoutMs: 300 })(ONE, { quotes: ['hang'], redactsAny: true })).rejects.toBeInstanceOf(RetryableEngineError);
    expect(await socketRedact({ path: socket, timeoutMs: 5_000 })(ONE, { quotes: ['quick'], redactsAny: true })).toEqual({ kind: 'refused', reason: 'answered' });
  });

  it('takes one copy at a time: a second waits for the first', async () => {
    const { socket } = await started({ module: child('slow') });
    const redact = socketRedact({ path: socket });
    const t0 = Date.now();
    const both = await Promise.all([redact(ONE, REQUEST), redact(ONE, REQUEST)]);
    expect(both).toEqual([
      { kind: 'refused', reason: 'slow but done' },
      { kind: 'refused', reason: 'slow but done' },
    ]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(3_000);
  });

  it('answers a malformed or slow request with nothing, logs why without its content, and keeps serving', async () => {
    const { socket, logged } = await started({ readTimeoutMs: 200 });
    const frame = encodeRequest(ONE, REQUEST);
    expect(await exchange(socket, Buffer.from('GET /etc/passwd HTTP/1.1\r\n\r\n'))).toEqual(Buffer.alloc(0));
    expect(await exchange(socket, frame.subarray(0, 20), true)).toEqual(Buffer.alloc(0));
    expect(await exchange(socket, REQUEST_MAGIC)).toEqual(Buffer.alloc(0));
    expect(await exchange(socket, Buffer.concat([frame, Buffer.from('x')]))).toEqual(Buffer.alloc(0));
    const header = Buffer.from(JSON.stringify({ v: 1, quotes: [], redactsAny: true, env: { PGPASSWORD: 'canary' } }));
    const sizes = Buffer.alloc(8);
    sizes.writeUInt32BE(header.length, 0);
    sizes.writeUInt32BE(1, 4);
    expect(await exchange(socket, Buffer.concat([REQUEST_MAGIC, sizes, header, ONE]))).toEqual(Buffer.alloc(0));
    expect(logged.filter((line) => line.startsWith('refused a request: '))).toHaveLength(5);
    expect(logged.join('\n')).not.toMatch(/passwd|canary/);
    expect(READ_TIMEOUT_MS).toBe(30_000);
    expect(await socketRedact({ path: socket })(ONE, REQUEST)).toEqual({ kind: 'refused', reason: 'refused by the engine process' });
  });

  it('drops a request that sends more after its frame while the copy is made', async () => {
    const { socket } = await started({ module: child('slow') });
    const reply = new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = [];
      const conn = net.createConnection({ path: socket });
      conn.on('data', (chunk: Buffer) => chunks.push(chunk));
      conn.on('error', () => {});
      conn.on('close', () => resolve(Buffer.concat(chunks)));
      conn.write(encodeRequest(ONE, REQUEST));
      setTimeout(() => conn.write('x'), 300);
    });
    expect(await reply).toEqual(Buffer.alloc(0));
  });

  it('takes over a stale socket, and refuses a path that holds anything else', async () => {
    const { socket: stale } = place();
    // A socket file no one serves: a process that listens on it and is killed, so it never unlinks it.
    const listener = spawn(process.execPath, ['-e', "require('net').createServer().listen(process.argv[1], () => process.kill(process.pid, 'SIGKILL'))", stale], { env: {}, stdio: 'ignore' });
    await new Promise((resolve) => listener.once('exit', resolve));
    expect(lstatSync(stale).isSocket()).toBe(true);
    const again = await startSidecar({ path: stale, module: child('refuse'), log: () => {} });
    cleanup.push(() => again.close());
    expect(await socketRedact({ path: stale })(ONE, REQUEST)).toEqual({ kind: 'refused', reason: 'refused by the engine process' });
    const { socket: file } = place();
    writeFileSync(file, 'kept');
    await expect(startSidecar({ path: file, log: () => {} })).rejects.toThrow('is not a socket');
    await expect(startSidecar({ path: path.join(file, 'below'), log: () => {} })).rejects.toThrow('ENOTDIR');
    const { socket: link } = place();
    symlinkSync('/dev/null', link);
    await expect(startSidecar({ path: link, log: () => {} })).rejects.toThrow('is not a socket');
    await expect(startSidecar({ path: path.join(place().dir, 'no', 'such', 'engine.sock'), log: () => {} })).rejects.toThrow(/^listen E/);
  });

  it('on close, kills the copies in flight, fails their jobs closed, and removes its socket; twice is harmless', async () => {
    const { socket } = place();
    const sidecar = await startSidecar({ path: socket, module: child('selective'), log: () => {} });
    const job = socketRedact({ path: socket, timeoutMs: 10_000 })(ONE, { quotes: ['hang'], redactsAny: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await sidecar.close();
    await expect(job).rejects.toBeInstanceOf(RetryableEngineError);
    expect(() => lstatSync(socket)).toThrow();
    await sidecar.close();
  });
});

describe('sidecarMain (the entry\'s logic)', () => {
  it('refuses to start, exit 2, naming the variables and not their values', async () => {
    const lines: string[] = [];
    expect(await sidecarMain([], { NODE_ENV: 'production', PGPASSWORD: 'canary-value', GH_TOKEN: 'canary-token' }, (line) => void lines.push(line))).toEqual({ code: 2 });
    expect(lines.join('\n')).toContain('GH_TOKEN, PGPASSWORD');
    expect(lines.join('\n')).not.toContain('canary');
  });

  it('refuses arguments it does not know, a relative socket and a bad timeout, exit 2', async () => {
    for (const argv of [['--port', '80'], ['--socket', 'engine.sock'], ['--timeout-ms', '0'], ['--timeout-ms', 'soon'], ['--timeout-ms', '3600001'], ['extra']]) {
      const lines: string[] = [];
      expect(await sidecarMain(argv, {}, (line) => void lines.push(line)), argv.join(' ')).toEqual({ code: 2 });
      expect(lines.length, argv.join(' ')).toBeGreaterThan(0);
    }
  });

  it('exits 1 when it cannot listen, and starts on /run/pdf-engine/engine.sock by default', async () => {
    const { socket } = place();
    writeFileSync(socket, 'kept');
    const lines: string[] = [];
    expect(await sidecarMain(['--socket', socket], {}, (line) => void lines.push(line))).toEqual({ code: 1 });
    expect(lines.join('\n')).toContain('is not a socket');
    expect(DEFAULT_SOCKET).toBe('/run/pdf-engine/engine.sock');
  });

  it('starts with an engine and a timeout from its arguments, and says it is listening', async () => {
    const { socket } = place();
    const lines: string[] = [];
    const result = await sidecarMain(['--socket', socket, '--engine', child('selective'), '--timeout-ms', '200'], { NODE_ENV: 'production' }, (line) => void lines.push(line));
    expect('sidecar' in result).toBe(true);
    const { sidecar } = result as { sidecar: Sidecar };
    cleanup.push(() => sidecar.close());
    expect(lines).toContain('engine sidecar listening');
    await expect(socketRedact({ path: socket })(ONE, { quotes: ['hang'], redactsAny: true })).rejects.toThrow('took longer than 200 ms');
  });
});
