// The engine sidecar's own code, in this process (UNTRUSTED-PDF-GATE). The lift test
// (test/pdf/engine-sidecar.test.ts) runs the same paths through the real entry as a process of its
// own; here they are covered. The engines are stand-ins (test/pdf/children).
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REQUEST_MAGIC, encodeRequest } from './engine-protocol.js';
import { RetryableEngineError } from './regenerate.js';
import { ALLOWED_ENV, DEFAULT_SOCKET, ENGINE_SOCKET_DIR, MAX_CONNECTIONS, READ_TIMEOUT_MS, SOCKET_MODE, type Sidecar, type System, WATCH_MS, HELD_SIGNALS, holdSignals, refusedEnv, sidecarMain, socketDrift, startSidecar } from './sidecar.js';
import { socketRedact } from './socket-engine.js';
import { NODE_FLAGS } from '../../test/helpers/sidecar.js';

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

describe('refusedEnv: an allow-list (S2)', () => {
  it('names every variable that is not on the allow-list, a credential or not, in any case', () => {
    const env = {
      DATABASE_URL: 'x',
      PGPASSWORD: 'x',
      POSTGRES_PASSWORD: 'x',
      DB_PASSWORD: 'x',
      PASSWORD: 'x',
      MYSQL_PWD: 'x',
      REDIS_URL: 'x',
      MONGODB_URI: 'x',
      SENTRY_DSN: 'x',
      GOOGLE_APPLICATION_CREDENTIALS: 'x',
      AWS_SHARED_CREDENTIALS_FILE: 'x',
      SMTP_PASS: 'x',
      NPM_CONFIG__AUTH: 'x',
      CREDENTIALS_DIRECTORY: 'x',
      NODE_OPTIONS: '--require /tmp/x.js',
      path: '/usr/bin',
      KUBERNETES_SERVICE_HOST_EXTRA: 'x',
      PDF_SECRET: 'x',
      NODE_ENV: 'production',
      HOME: '/',
      PATH: '/usr/bin',
    };
    expect(refusedEnv(env)).toEqual([
      'AWS_SHARED_CREDENTIALS_FILE',
      'CREDENTIALS_DIRECTORY',
      'DATABASE_URL',
      'DB_PASSWORD',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'KUBERNETES_SERVICE_HOST_EXTRA',
      'MONGODB_URI',
      'MYSQL_PWD',
      'NODE_OPTIONS',
      'NPM_CONFIG__AUTH',
      'PASSWORD',
      'PDF_SECRET',
      'PGPASSWORD',
      'POSTGRES_PASSWORD',
      'REDIS_URL',
      'SENTRY_DSN',
      'SMTP_PASS',
      'path',
    ]);
  });

  it('passes what the image, the container runtime and the kubelet set, and nothing else', () => {
    expect([...ALLOWED_ENV].sort()).toEqual(
      [
        'GRPC_PORT',
        'HEALTH_PORT',
        'HOME',
        'HOSTNAME',
        'KUBERNETES_PORT',
        'KUBERNETES_PORT_443_TCP',
        'KUBERNETES_PORT_443_TCP_ADDR',
        'KUBERNETES_PORT_443_TCP_PORT',
        'KUBERNETES_PORT_443_TCP_PROTO',
        'KUBERNETES_SERVICE_HOST',
        'KUBERNETES_SERVICE_PORT',
        'KUBERNETES_SERVICE_PORT_HTTPS',
        'LANG',
        'LC_ALL',
        'NODE_ENV',
        'NODE_VERSION',
        'PATH',
        'PDF_ENGINE_SOCKET',
        'PDF_GATE_SOCKET',
        'SERVICE_VERSION',
        'TERM',
        'TZ',
        'YARN_VERSION',
      ].sort(),
    );
    expect(refusedEnv(Object.fromEntries([...ALLOWED_ENV].map((name) => [name, 'x'])))).toEqual([]);
    expect(refusedEnv({})).toEqual([]);
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
    expect(await socketRedact({ path: echo.socket })(Uint8Array.from([1, 2, 3]), REQUEST)).toEqual({ kind: 'redacted', pdf: Uint8Array.from([3, 2, 1]), boxes: [], kept: [] });
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
    const header = Buffer.from(JSON.stringify({ v: 3, quotes: [], redactsAny: true, links: [], membersWithhold: [], env: { PGPASSWORD: 'canary' } }));
    const sizes = Buffer.alloc(8);
    sizes.writeUInt32BE(header.length, 0);
    sizes.writeUInt32BE(1, 4);
    expect(await exchange(socket, Buffer.concat([REQUEST_MAGIC, sizes, header, ONE]))).toEqual(Buffer.alloc(0));
    expect(logged.filter((line) => line.startsWith('refused a request: '))).toHaveLength(5);
    expect(logged.join('\n')).not.toMatch(/passwd|canary/);
    expect(READ_TIMEOUT_MS).toBe(30_000);
    expect(await socketRedact({ path: socket })(ONE, REQUEST)).toEqual({ kind: 'refused', reason: 'refused by the engine process' });
  });

  it('makes no copy for a worker that hung up while its request waited its turn', async () => {
    const { socket, logged } = await started({ module: child('slow') });
    const redact = socketRedact({ path: socket });
    const first = redact(ONE, REQUEST);
    const waiting = socketRedact({ path: socket, timeoutMs: 300 })(ONE, REQUEST);
    await expect(waiting).rejects.toBeInstanceOf(RetryableEngineError);
    expect(await first).toEqual({ kind: 'refused', reason: 'slow but done' });
    await vi.waitFor(() => expect(logged).toContain('dropped a request: the worker hung up before its turn'), { timeout: 5_000 });
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

  it('takes over a stale socket, and fails to start where its directory cannot be read', async () => {
    const { socket: stale } = place();
    // A socket file no one serves: a process that listens on it and is killed, so it never unlinks it.
    const listener = spawn(process.execPath, ['-e', "require('net').createServer().listen(process.argv[1], () => process.kill(process.pid, 'SIGKILL'))", stale], { env: {}, stdio: 'ignore' });
    await new Promise((resolve) => listener.once('exit', resolve));
    expect(lstatSync(stale).isSocket()).toBe(true);
    const lines: string[] = [];
    const again = await startSidecar({ path: stale, module: child('refuse'), log: (line) => void lines.push(line) });
    cleanup.push(() => again.close());
    expect(await socketRedact({ path: stale })(ONE, REQUEST)).toEqual({ kind: 'refused', reason: 'refused by the engine process' });
    expect(lines).toContain('removed from its socket directory before listening: engine.sock (a socket)');
    const { socket: file } = place();
    writeFileSync(file, 'kept');
    await expect(startSidecar({ path: path.join(file, 'below'), log: () => {} })).rejects.toThrow('ENOTDIR');
    await expect(startSidecar({ path: path.join(place().dir, 'no', 'such', 'engine.sock'), log: () => {} })).rejects.toThrow('ENOENT');
  });

  it('empties its socket directory at start, whatever a child left there: a directory squatting at its path, a renamed socket, files, links (fix round 4, S2 and N5)', async () => {
    const { dir, socket } = place();
    // What a child of the sidecar's uid could leave before the permission model: the socket renamed aside and a directory in its place.
    const old = spawn(process.execPath, ['-e', "require('net').createServer().listen(process.argv[1], () => process.kill(process.pid, 'SIGKILL'))", path.join(dir, 'old.sock')], { env: {}, stdio: 'ignore' });
    await new Promise((resolve) => old.once('exit', resolve));
    mkdirSync(socket);
    mkdirSync(path.join(socket, 'deeper'));
    writeFileSync(path.join(socket, 'deeper', 'inside'), 'x');
    writeFileSync(path.join(dir, '.fill'), Buffer.alloc(4096));
    symlinkSync('/dev/null', path.join(dir, 'link'));
    const lines: string[] = [];
    const sidecar = await startSidecar({ path: socket, module: child('refuse'), log: (line) => void lines.push(line) });
    cleanup.push(() => sidecar.close());
    expect(readdirSync(dir)).toEqual(['engine.sock']);
    expect(lstatSync(socket).isSocket()).toBe(true);
    expect(existsSync('/dev/null')).toBe(true);
    expect(lines).toContain('removed from its socket directory before listening: .fill (a file), engine.sock (a directory), link (a link), old.sock (a socket)');
    expect(await socketRedact({ path: socket })(ONE, REQUEST)).toEqual({ kind: 'refused', reason: 'refused by the engine process' });
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

describe('startSidecar: the socket it bound is the one it serves (M1)', () => {
  it('exits on its watch when the socket is replaced or removed, and serves nothing after', async () => {
    expect(WATCH_MS).toBe(1_000);
    for (const change of ['replace', 'remove'] as const) {
      const fatal: string[] = [];
      const { socket } = await started({ onFatal: (reason) => void fatal.push(reason), watchMs: 50 });
      if (change === 'remove') unlinkSync(socket);
      else {
        unlinkSync(socket);
        writeFileSync(socket, 'not the socket it bound');
      }
      await vi.waitFor(() => expect(fatal, change).toEqual([`the socket at ${socket} was replaced or removed`]));
      // Once: the watch and the server are stopped.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(fatal, change).toHaveLength(1);
    }
  });

  it('exits on its watch when the socket\'s mode changes in place, as a child of its uid can chmod it (S1)', async () => {
    for (const mode of [0o000, 0o666]) {
      const fatal: string[] = [];
      const { socket } = await started({ onFatal: (reason) => void fatal.push(reason), watchMs: 50 });
      chmodSync(socket, mode);
      await vi.waitFor(() => expect(fatal, mode.toString(8)).toEqual([`the socket at ${socket} changed its mode or owner`]));
    }
  });

  it('tells the socket as bound from one gone, replaced, or changed in mode, owner or group (S1)', () => {
    const bound = { dev: 7, ino: 11, mode: SOCKET_MODE, uid: 10004, gid: 10003 };
    const stat = (change: Partial<typeof bound> & { socket?: boolean } = {}) => {
      const { socket = true, ...rest } = change;
      return { ...bound, mode: 0o140000 | bound.mode, ...rest, isSocket: () => socket };
    };
    expect(socketDrift(bound, stat())).toBeNull();
    expect(socketDrift(bound, undefined)).toBe('gone');
    expect(socketDrift(bound, stat({ socket: false }))).toBe('gone');
    expect(socketDrift(bound, stat({ ino: 12 }))).toBe('gone');
    expect(socketDrift(bound, stat({ dev: 8 }))).toBe('gone');
    expect(socketDrift(bound, stat({ mode: 0o140000 }))).toBe('changed');
    expect(socketDrift(bound, stat({ mode: 0o140666 }))).toBe('changed');
    expect(socketDrift(bound, stat({ uid: 10005 }))).toBe('changed');
    expect(socketDrift(bound, stat({ gid: 0 }))).toBe('changed');
  });

  it('checks the socket\'s mode after every job and before any reply: a job whose child chmods it gets none (S1)', async () => {
    const fatal: string[] = [];
    const at: { socket?: string } = {};
    const { socket } = await started({
      module: child('slow'),
      onFatal: (reason) => void fatal.push(reason),
      watchMs: 60_000,
      sweep: () => {
        chmodSync(at.socket as string, 0o000);
        return Promise.resolve(null);
      },
    });
    at.socket = socket;
    await expect(socketRedact({ path: socket, timeoutMs: 10_000 })(ONE, REQUEST)).rejects.toBeInstanceOf(RetryableEngineError);
    expect(fatal).toEqual([`the socket at ${socket} changed its mode or owner`]);
  });

  it('checks the socket after every job and before any reply: a job whose child replaced it gets none', async () => {
    const fatal: string[] = [];
    const at: { socket?: string } = {};
    const { socket } = await started({
      module: child('slow'),
      onFatal: (reason) => void fatal.push(reason),
      watchMs: 60_000,
      // The sweep runs after the job, before its reply: here it plays a process that took the socket.
      sweep: () => {
        unlinkSync(at.socket as string);
        writeFileSync(at.socket as string, 'taken');
        return Promise.resolve(null);
      },
    });
    at.socket = socket;
    const job = socketRedact({ path: socket, timeoutMs: 10_000 })(ONE, REQUEST);
    await expect(job).rejects.toBeInstanceOf(RetryableEngineError);
    expect(fatal).toEqual([`the socket at ${socket} was replaced or removed`]);
  });

  it('checks the socket at each connection, before it reads a request or forks a child (N2)', async () => {
    const fatal: string[] = [];
    const { dir, socket } = place();
    const moved = path.join(dir, 'moved.sock');
    // The mark stand-in signals this process as soon as it is sent a job.
    let ran = 0;
    const heard = (): void => void (ran += 1);
    process.on('SIGURG', heard);
    cleanup.push(() => void process.off('SIGURG', heard));
    const sidecar = await startSidecar({ path: socket, module: child('mark'), log: () => {}, onFatal: (reason) => void fatal.push(reason), watchMs: 60_000 });
    cleanup.push(() => sidecar.close());
    // The bound socket moved aside and a decoy in its place: a connection still reaching the bound one is refused.
    renameSync(socket, moved);
    writeFileSync(socket, 'decoy');
    expect(await exchange(moved, encodeRequest(ONE, { quotes: [String(process.pid)], redactsAny: true }))).toEqual(Buffer.alloc(0));
    expect(fatal).toEqual([`the socket at ${socket} was replaced or removed`]);
    // No child was forked for the refused connection.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(ran).toBe(0);
  });

  it('closes a connection past MAX_CONNECTIONS at once, and serves again once one is free (S2)', async () => {
    expect(MAX_CONNECTIONS).toBe(8);
    const { socket } = await started({ firstBytesTimeoutMs: 10_000, readTimeoutMs: 20_000 });
    const idle = await Promise.all(
      Array.from({ length: MAX_CONNECTIONS }, () => new Promise<net.Socket>((resolve) => {
        const conn = net.createConnection({ path: socket }, () => resolve(conn));
        conn.on('error', () => {});
      })),
    );
    cleanup.push(() => idle.forEach((conn) => conn.destroy()));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const t0 = Date.now();
    expect(await exchange(socket, encodeRequest(ONE, REQUEST))).toEqual(Buffer.alloc(0));
    expect(Date.now() - t0).toBeLessThan(2_000);
    (idle[0] as net.Socket).destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await socketRedact({ path: socket })(ONE, REQUEST)).toEqual({ kind: 'refused', reason: 'refused by the engine process' });
  });
});

describe('startSidecar: the namespace cleared after each job, before its reply (M1)', () => {
  it('clears its namespace after every job, before its reply, and one job at a time', async () => {
    const order: string[] = [];
    const { socket } = await started({
      sweep: () => {
        order.push('sweep');
        return Promise.resolve(null);
      },
    });
    const redact = socketRedact({ path: socket });
    await redact(ONE, REQUEST);
    order.push('reply');
    await redact(ONE, REQUEST);
    order.push('reply');
    expect(order).toEqual(['sweep', 'reply', 'sweep', 'reply']);
  });

  it('stops without a reply when its namespace is not clear, or the check fails: a process may still be running', async () => {
    for (const [sweep, why] of [
      [() => Promise.resolve('processes are still in its PID namespace after 50 passes'), 'its PID namespace is not clear before a reply: processes are still in its PID namespace after 50 passes'],
      [
        () => Promise.reject(Object.assign(new Error('kill EPERM'), { code: 'EPERM' })),
        'its PID namespace is not clear before a reply: its check failed (EPERM)',
      ],
    ] as Array<[() => Promise<string | null>, string]>) {
      const fatal: string[] = [];
      const { socket } = await started({ onFatal: (reason) => void fatal.push(reason), sweep });
      await expect(socketRedact({ path: socket })(ONE, REQUEST)).rejects.toBeInstanceOf(RetryableEngineError);
      expect(fatal).toEqual([why]);
    }
  });

  it('drops an idle connection within the first-bytes deadline (NOTE: idle connections are bounded)', async () => {
    const { socket, logged } = await started({ firstBytesTimeoutMs: 100, readTimeoutMs: 10_000 });
    const t0 = Date.now();
    expect(await exchange(socket, new Uint8Array(0))).toEqual(Buffer.alloc(0));
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(logged).toContain('refused a request: no frame began within 100 ms');
  });
});

describe('sidecarMain (the entry\'s logic)', () => {
  /** A made-up process view: the sidecar as PID 1, alone, with a kill that only records (never the real one). */
  function system(self: Partial<System> = {}): System & { sent: number[] } {
    const root = mkdtempSync(path.join(tmpdir(), 'nwfl-proc-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(path.join(root, '1'));
    writeFileSync(path.join(root, '1', 'status'), 'Name:\tnode\nState:\tS (sleeping)\nUid:\t10002\t10002\t10002\t10002\n');
    const sent: number[] = [];
    return { pid: 1, uid: 10002, procRoot: root, kill: (pid) => void sent.push(pid), execArgv: ['--disable-sigusr1'], sent, ...self };
  }
  const SHARED = ['--shared-pid-namespace'];

  it('refuses to start, exit 2, naming the variables that are not allowed and not their values', async () => {
    const lines: string[] = [];
    expect(await sidecarMain([], { NODE_ENV: 'production', DB_PASSWORD: 'canary-value', REDIS_URL: 'canary-url' }, (line) => void lines.push(line))).toEqual({ code: 2 });
    expect(lines.join('\n')).toContain('DB_PASSWORD, REDIS_URL');
    expect(lines.join('\n')).not.toContain('canary');
  });

  it('refuses arguments it does not know, a relative socket and a bad timeout, exit 2', async () => {
    const { dir } = place();
    for (const argv of [['--port', '80'], ['--socket', 'engine.sock'], ['--timeout-ms', '0'], ['--timeout-ms', 'soon'], ['--timeout-ms', '3600001'], ['extra'], ['--socket-dir', 'relative']]) {
      const lines: string[] = [];
      expect(await sidecarMain([...argv, ...(argv[0] === '--socket-dir' ? [] : ['--socket-dir', dir]), ...SHARED], {}, (line) => void lines.push(line)), argv.join(' ')).toEqual({ code: 2 });
      expect(lines.length, argv.join(' ')).toBeGreaterThan(0);
    }
  });

  it('binds only directly in its own directory, /run/pdf-engine, and never in another', async () => {
    expect(ENGINE_SOCKET_DIR).toBe('/run/pdf-engine');
    expect(DEFAULT_SOCKET).toBe('/run/pdf-engine/engine.sock');
    const { dir } = place();
    for (const socket of ['/run/pdf-gate/engine.sock', '/tmp/engine.sock', '/run/pdf-engine/sub/engine.sock', '/run/pdf-engine/../pdf-gate/gate.sock', '/run/pdf-engine/engine.sock\n', `${dir}/engine.sock`]) {
      const lines: string[] = [];
      expect(await sidecarMain(['--socket', socket, ...SHARED], {}, (line) => void lines.push(line)), socket).toEqual({ code: 2 });
      expect(lines.join('\n'), socket).toContain('--socket must be an absolute path directly in /run/pdf-engine');
    }
  });

  it('takes --socket-dir, --shared-pid-namespace and --no-child-permission, for tests, only outside production', async () => {
    const { dir } = place();
    for (const argv of [['--socket-dir', dir], SHARED, ['--no-child-permission']]) {
      const lines: string[] = [];
      expect(await sidecarMain(argv, { NODE_ENV: 'production' }, (line) => void lines.push(line), { system: system() }), argv.join(' ')).toEqual({ code: 2 });
      expect(lines.join('\n'), argv.join(' ')).toContain('is for tests and refused in production');
    }
  });

  it('runs its children under the permission model, and without it only with --no-child-permission, so a test can reach the layers behind it (fix round 4, S2)', async () => {
    const tried = async (extra: string[]): Promise<Record<string, string>> => {
      const { dir, socket } = place();
      const target = place().dir;
      const result = await sidecarMain(['--socket-dir', dir, ...SHARED, '--engine', child('try-write'), ...extra], {}, () => {});
      const { sidecar } = result as { sidecar: Sidecar };
      cleanup.push(() => sidecar.close());
      const reply = await socketRedact({ path: socket })(ONE, { quotes: [target], redactsAny: true });
      return JSON.parse((reply as { reason: string }).reason) as Record<string, string>;
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
  });

  it('serves only as PID 1 of its container, never as root, and in production only with --disable-sigusr1, exit 2 (fix round 2)', async () => {
    const { dir } = place();
    const cases: Array<[string, string[], NodeJS.ProcessEnv, System & { sent: number[] }, RegExp]> = [
      ['not PID 1 (dumb-init or another init in front of it)', ['--socket-dir', dir], {}, system({ pid: 7 }), /must be PID 1 of its container and will not start: it is PID 7, not PID 1 of its container: set command, not args/],
      ['root', ['--socket-dir', dir], {}, system({ uid: 0 }), /will not start: it runs as root/],
      ['root, even for tests', ['--socket-dir', dir, ...SHARED], {}, system({ pid: 7, uid: 0 }), /will not start: it runs as root/],
      ['production without the flag', [], { NODE_ENV: 'production' }, system({ execArgv: [] }), /will not start without --disable-sigusr1/],
    ];
    for (const [name, argv, env, given, why] of cases) {
      const lines: string[] = [];
      expect(await sidecarMain(argv, env, (line) => void lines.push(line), { system: given }), name).toEqual({ code: 2 });
      expect(lines.join('\n'), name).toMatch(why);
      expect(given.sent, name).toEqual([]);
    }
  });

  it('as PID 1, clears its namespace (kill(-1)) at start and before every reply', async () => {
    const { dir, socket } = place();
    const view = system();
    const lines: string[] = [];
    const result = await sidecarMain(['--socket-dir', dir, '--engine', child('refuse')], {}, (line) => void lines.push(line), { system: view });
    const { sidecar } = result as { sidecar: Sidecar };
    cleanup.push(() => sidecar.close());
    expect(view.sent).toEqual([-1]);
    expect(await socketRedact({ path: socket })(ONE, REQUEST)).toEqual({ kind: 'refused', reason: 'refused by the engine process' });
    expect(view.sent).toEqual([-1, -1]);
    // fc's apply step 17e greps this line: exactly once per start.
    expect(lines.filter((line) => line === 'engine sidecar listening (PID 1: clearing its PID namespace before every reply)')).toHaveLength(1);
  });

  it('exits 1 at start when its namespace is not clear', async () => {
    const { dir } = place();
    const view = system();
    writeFileSync(path.join(view.procRoot, 'stray'), '');
    mkdirSync(path.join(view.procRoot, '9'));
    writeFileSync(path.join(view.procRoot, '9', 'status'), 'Name:\tsh\nState:\tZ (zombie)\nUid:\t10002\t10002\t10002\t10002\n');
    const lines: string[] = [];
    expect(await sidecarMain(['--socket-dir', dir], {}, (line) => void lines.push(line), { system: view })).toEqual({ code: 1 });
    expect(lines.join('\n')).toContain('its PID namespace is not clear: an orphaned process');
  });

  it('takes SIGUSR1 with a listener, so Node does not open its inspector to a child, and every other signal that would end it by default (N2)', () => {
    const target = new EventEmitter();
    holdSignals(target as unknown as NodeJS.Process);
    expect(target.listenerCount('SIGUSR1')).toBe(1);
    expect(() => target.emit('SIGUSR1')).not.toThrow();
    expect(HELD_SIGNALS).toEqual(['SIGHUP', 'SIGQUIT', 'SIGTRAP', 'SIGABRT', 'SIGUSR2', 'SIGALRM', 'SIGVTALRM', 'SIGPROF', 'SIGIO', 'SIGPWR', 'SIGSTKFLT', 'SIGSYS', 'SIGXCPU', 'SIGXFSZ']);
    for (const signal of HELD_SIGNALS) {
      expect(target.listenerCount(signal), signal).toBe(1);
      expect(() => target.emit(signal)).not.toThrow();
    }
    // SIGTERM and SIGINT are the entries' own (a clean stop); SIGKILL and SIGSTOP cannot be held; a fault is not to be.
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGKILL', 'SIGSTOP', 'SIGSEGV', 'SIGBUS', 'SIGFPE', 'SIGILL']) expect(target.listenerCount(signal), signal).toBe(0);
  });

  it('keeps a real process running through each held signal (N2)', async () => {
    const sidecarModule = fileURLToPath(new URL('./sidecar.ts', import.meta.url));
    const script = `const { holdSignals } = await import(${JSON.stringify(sidecarModule)}); holdSignals(); process.send('held'); setTimeout(() => process.exit(0), 1500);`;
    const held = spawn(process.execPath, [...NODE_FLAGS, '--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], env: {} });
    const exited = new Promise<number | null>((resolve) => held.once('exit', (code) => resolve(code)));
    const ready = new Promise<boolean>((resolve) => {
      held.once('message', () => resolve(true));
      held.once('exit', () => resolve(false));
    });
    expect(await ready).toBe(true);
    for (const signal of HELD_SIGNALS) held.kill(signal);
    expect(await exited).toBe(0);
  });

  it('exits 1 when it cannot listen, and reports a replaced socket to its caller', async () => {
    const { dir, socket } = place();
    const lines: string[] = [];
    expect(await sidecarMain(['--socket-dir', path.join(dir, 'none'), ...SHARED], {}, (line) => void lines.push(line))).toEqual({ code: 1 });
    expect(lines.join('\n')).toContain('the engine sidecar cannot listen');
    const fatal: string[] = [];
    const result = await sidecarMain(['--socket-dir', dir, ...SHARED], {}, () => {}, { onFatal: (reason) => void fatal.push(reason) });
    const { sidecar } = result as { sidecar: Sidecar };
    cleanup.push(() => sidecar.close());
    unlinkSync(socket);
    await vi.waitFor(() => expect(fatal).toEqual([`the socket at ${socket} was replaced or removed`]), { timeout: 3_000 });
  });

  it('starts with an engine and a timeout from its arguments, and says it is listening', async () => {
    const { dir, socket } = place();
    const lines: string[] = [];
    const result = await sidecarMain(['--socket-dir', dir, ...SHARED, '--engine', child('selective'), '--timeout-ms', '200'], { NODE_ENV: 'test' }, (line) => void lines.push(line));
    expect('sidecar' in result).toBe(true);
    const { sidecar } = result as { sidecar: Sidecar };
    cleanup.push(() => sidecar.close());
    expect(lines).toContain('engine sidecar listening (not PID 1: shared PID namespace, for tests; nothing is cleared)');
    await expect(socketRedact({ path: socket })(ONE, { quotes: ['hang'], redactsAny: true })).rejects.toThrow('took longer than 200 ms');
  });
});
