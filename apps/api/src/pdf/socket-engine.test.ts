// The worker's side of the engine sidecar (UNTRUSTED-PDF-GATE): which socket it may use, and how a
// job fails closed. The sidecar's side is sidecar.test.ts; the lift test runs both as processes.
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_REPLY_HEADER_BYTES, REPLY_MAGIC, encodeFrame } from './engine-protocol.js';
import { RetryableEngineError } from './regenerate.js';
import { ENGINE_SOCKET_DIRS, GATE_SOCKET_DIRS, SOCKET_TIMEOUT_MS, engineSocketPath, gateSocketPath, socketRedact, workerSockets } from './socket-engine.js';

const REQUEST = { quotes: ['Kestrel Ambry'], redactsAny: true, image: 'blur' as const };
const ONE = Uint8Array.from([1]);
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function dir(): string {
  const made = mkdtempSync(path.join(tmpdir(), 'nwfl-sce-'));
  cleanup.push(() => rmSync(made, { recursive: true, force: true }));
  return made;
}

describe('engineSocketPath (PDF_ENGINE_SOCKET)', () => {
  it('is unset when the variable is: the worker keeps its in-pod child', () => {
    expect(engineSocketPath({})).toBeUndefined();
  });

  it('takes an absolute path directly in /run/pdf-engine', () => {
    expect(ENGINE_SOCKET_DIRS).toEqual(['/run/pdf-engine']);
    expect(engineSocketPath({ PDF_ENGINE_SOCKET: '/run/pdf-engine/engine.sock' })).toBe('/run/pdf-engine/engine.sock');
    expect(engineSocketPath({ PDF_ENGINE_SOCKET: '/tmp/x/engine.sock' }, ['/tmp/x'])).toBe('/tmp/x/engine.sock');
  });

  it('refuses a relative path, one outside the directory, one that climbs out, and one too long for a socket', () => {
    for (const value of [
      '',
      'engine.sock',
      'run/pdf-engine/engine.sock',
      './engine.sock',
      '/tmp/engine.sock',
      '/run/pdf-engine',
      '/run/pdf-engine/',
      '/run/pdf-engine/sub/engine.sock',
      '/run/pdf-engine/../secrets/engine.sock',
      '/run/pdf-engine//engine.sock',
      '/run/pdf-engine/.',
      '/run/pdf-engine/..',
      `/run/pdf-engine/${'s'.repeat(100)}.sock`,
      '/run/pdf-engine-other/engine.sock',
      // Whitespace and control characters (a YAML block scalar leaves a trailing newline), and anything outside plain path letters.
      '/run/pdf-engine/engine.sock\n',
      ' /run/pdf-engine/engine.sock',
      '/run/pdf-engine/engine sock',
      '/run/pdf-engine/engine.sock\t',
      '/run/pdf-engine/engine\u0000.sock',
      '/run/pdf-engine/engine.sock\r',
      '/run/pdf-engine/\u00e9ngine.sock',
    ]) {
      expect(() => engineSocketPath({ PDF_ENGINE_SOCKET: value }), value).toThrow('PDF_ENGINE_SOCKET must be an absolute path directly in /run/pdf-engine');
    }
  });
});

describe('gateSocketPath and workerSockets (PDF_GATE_SOCKET, M2)', () => {
  it('takes the gate socket directly in /run/pdf-gate, never in the engine\'s directory', () => {
    expect(GATE_SOCKET_DIRS).toEqual(['/run/pdf-gate']);
    expect(gateSocketPath({})).toBeUndefined();
    expect(gateSocketPath({ PDF_GATE_SOCKET: '/run/pdf-gate/gate.sock' })).toBe('/run/pdf-gate/gate.sock');
    for (const value of ['/run/pdf-engine/gate.sock', '/run/pdf-gate/gate.sock\n', 'gate.sock', '/run/pdf-gate/']) {
      expect(() => gateSocketPath({ PDF_GATE_SOCKET: value }), value).toThrow('PDF_GATE_SOCKET must be an absolute path directly in /run/pdf-gate');
    }
  });

  it('needs PDF_GATE_SOCKET whenever PDF_ENGINE_SOCKET is set, in another directory', () => {
    expect(workerSockets({})).toEqual({});
    expect(workerSockets({ PDF_GATE_SOCKET: '/run/pdf-gate/gate.sock' })).toEqual({ gate: '/run/pdf-gate/gate.sock' });
    expect(workerSockets({ PDF_ENGINE_SOCKET: '/run/pdf-engine/engine.sock', PDF_GATE_SOCKET: '/run/pdf-gate/gate.sock' })).toEqual({
      engine: '/run/pdf-engine/engine.sock',
      gate: '/run/pdf-gate/gate.sock',
    });
    expect(() => workerSockets({ PDF_ENGINE_SOCKET: '/run/pdf-engine/engine.sock' })).toThrow('PDF_GATE_SOCKET must be set whenever PDF_ENGINE_SOCKET is');
    // Tests may move the directories, but never to one shared by both.
    expect(() => workerSockets({ PDF_ENGINE_SOCKET: '/tmp/s/engine.sock', PDF_GATE_SOCKET: '/tmp/s/gate.sock' }, { engineDirs: ['/tmp/s'], gateDirs: ['/tmp/s'] })).toThrow(
      'PDF_ENGINE_SOCKET and PDF_GATE_SOCKET must be in different directories',
    );
  });
});

describe('socketRedact', () => {
  it('gives up after SOCKET_TIMEOUT_MS by default: past the sidecar\'s own 5-minute limit on a copy', () => {
    expect(SOCKET_TIMEOUT_MS).toBe(330_000);
  });

  it('fails the job closed when the path is not a socket or cannot be checked', async () => {
    const at = dir();
    const file = path.join(at, 'engine.sock');
    writeFileSync(file, 'x');
    const notSocket = socketRedact({ path: file })(ONE, REQUEST);
    await expect(notSocket).rejects.toBeInstanceOf(RetryableEngineError);
    await expect(notSocket).rejects.toThrow('the engine socket path holds something other than a socket');
    const unchecked = socketRedact({ path: path.join(file, 'below') })(ONE, REQUEST);
    await expect(unchecked).rejects.toThrow('the engine socket cannot be checked (ENOTDIR)');
  });

  it('refuses, never retries, a request it cannot send: the same request would fail the same way (S1)', async () => {
    expect(await socketRedact({ path: '/run/pdf-engine/engine.sock' })(ONE, { quotes: Array.from({ length: 5000 }, () => 'abc'), redactsAny: true })).toEqual({
      kind: 'refused',
      reason: 'the engine request could not be sent: too many quotes',
    });
    // 2200 marks of 500 characters each are valid marks (0014), and over the request header's cap.
    expect(await socketRedact({ path: '/run/pdf-engine/engine.sock' })(ONE, { quotes: Array.from({ length: 2200 }, (_, n) => `${n}`.padEnd(500, 'q')), redactsAny: true })).toEqual({
      kind: 'refused',
      reason: 'the engine request could not be sent: the request header is over its cap',
    });
  });

  it('fails the job closed for a symlink at the socket path, even one to a live socket (S4: lstat, not stat)', async () => {
    const at = dir();
    const real = path.join(at, 'real.sock');
    let connections = 0;
    const live = net.createServer((conn) => {
      connections += 1;
      conn.destroy();
    });
    await new Promise<void>((resolve) => live.listen(real, resolve));
    cleanup.push(() => new Promise<void>((resolve) => live.close(() => resolve())));
    const link = path.join(at, 'engine.sock');
    symlinkSync(real, link);
    const job = socketRedact({ path: link })(ONE, REQUEST);
    await expect(job).rejects.toBeInstanceOf(RetryableEngineError);
    await expect(job).rejects.toThrow('the engine socket path holds something other than a socket');
    expect(connections).toBe(0);
  });

  it('sends the typed request with the image action, and reads the reply', async () => {
    const socket = path.join(dir(), 'engine.sock');
    const seen: Buffer[] = [];
    const fake = net.createServer((conn) => {
      conn.on('data', (chunk: Buffer) => {
        seen.push(chunk);
        const all = Buffer.concat(seen);
        if (all.length >= 12 && all.length === 12 + all.readUInt32BE(4) + all.readUInt32BE(8)) conn.end(encodeFrame(REPLY_MAGIC, { v: 3, kind: 'original' }));
      });
    });
    await new Promise<void>((resolve) => fake.listen(socket, resolve));
    cleanup.push(() => new Promise<void>((resolve) => fake.close(() => resolve())));
    expect(await socketRedact({ path: socket })(Uint8Array.from([5, 6]), REQUEST)).toEqual({ kind: 'original' });
    const all = Buffer.concat(seen);
    const header = JSON.parse(all.subarray(12, 12 + all.readUInt32BE(4)).toString('utf8')) as unknown;
    expect(header).toEqual({ v: 3, quotes: ['Kestrel Ambry'], redactsAny: true, image: 'blur', links: [], membersWithhold: [true] });
    expect(all.subarray(12 + all.readUInt32BE(4))).toEqual(Buffer.from([5, 6]));
  });

  it('reads a reply header of exactly MAX_REPLY_HEADER_BYTES, and refuses one byte more (S2: a subverted engine cannot flood the worker)', async () => {
    expect(MAX_REPLY_HEADER_BYTES).toBe(16 * 1024);
    for (const [size, outcome] of [
      [MAX_REPLY_HEADER_BYTES, 'read'],
      [MAX_REPLY_HEADER_BYTES + 1, 'over'],
    ] as const) {
      const json = '{"v":3,"kind":"refused","reason":"refused by the engine process"}';
      // JSON allows trailing whitespace: a valid reply, padded to the size under test.
      const head = Buffer.from(json + ' '.repeat(size - json.length), 'utf8');
      const prefix = Buffer.alloc(12);
      REPLY_MAGIC.copy(prefix, 0);
      prefix.writeUInt32BE(head.length, 4);
      const socket = path.join(dir(), 'engine.sock');
      const fake = net.createServer((conn) => {
        conn.on('error', () => {});
        conn.once('data', () => conn.end(Buffer.concat([prefix, head])));
      });
      await new Promise<void>((resolve) => fake.listen(socket, resolve));
      cleanup.push(() => new Promise<void>((resolve) => fake.close(() => resolve())));
      const job = socketRedact({ path: socket })(ONE, REQUEST);
      if (outcome === 'read') expect(await job).toEqual({ kind: 'refused', reason: 'refused by the engine process' });
      else await expect(job).rejects.toThrow('the engine sidecar gave no usable reply: the header is over its cap');
    }
  });

  it('fails the job closed when the sidecar hangs up without a reply', async () => {
    const socket = path.join(dir(), 'engine.sock');
    const fake = net.createServer((conn) => conn.destroy());
    await new Promise<void>((resolve) => fake.listen(socket, resolve));
    cleanup.push(() => new Promise<void>((resolve) => fake.close(() => resolve())));
    const job = socketRedact({ path: socket })(ONE, REQUEST);
    await expect(job).rejects.toBeInstanceOf(RetryableEngineError);
    await expect(job).rejects.toThrow('the engine sidecar gave no usable reply');
  });
});

describe('RetryableEngineError', () => {
  it('carries a code for the worker\'s log, and is an Error', () => {
    const error = new RetryableEngineError('the engine socket is missing');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('RetryableEngineError');
    expect(error.code).toBe('PDF_ENGINE_UNAVAILABLE');
  });
});
