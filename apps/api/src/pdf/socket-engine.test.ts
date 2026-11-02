// The worker's side of the engine sidecar (UNTRUSTED-PDF-GATE): which socket it may use, and how a
// job fails closed. The sidecar's side is sidecar.test.ts; the lift test runs both as processes.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REPLY_MAGIC, encodeFrame } from './engine-protocol.js';
import { RetryableEngineError } from './regenerate.js';
import { ENGINE_SOCKET_DIRS, SOCKET_TIMEOUT_MS, engineSocketPath, socketRedact } from './socket-engine.js';

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
    ]) {
      expect(() => engineSocketPath({ PDF_ENGINE_SOCKET: value }), value).toThrow('PDF_ENGINE_SOCKET must be an absolute path directly in /run/pdf-engine');
    }
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

  it('fails the job closed when the request cannot be sent, before connecting', async () => {
    const tooMany = socketRedact({ path: '/run/pdf-engine/engine.sock' })(ONE, { quotes: Array.from({ length: 5000 }, () => 'abc'), redactsAny: true });
    await expect(tooMany).rejects.toBeInstanceOf(RetryableEngineError);
    await expect(tooMany).rejects.toThrow('too many quotes');
  });

  it('sends the typed request with the image action, and reads the reply', async () => {
    const socket = path.join(dir(), 'engine.sock');
    const seen: Buffer[] = [];
    const fake = net.createServer((conn) => {
      conn.on('data', (chunk: Buffer) => {
        seen.push(chunk);
        const all = Buffer.concat(seen);
        if (all.length >= 12 && all.length === 12 + all.readUInt32BE(4) + all.readUInt32BE(8)) conn.end(encodeFrame(REPLY_MAGIC, { v: 1, kind: 'original' }));
      });
    });
    await new Promise<void>((resolve) => fake.listen(socket, resolve));
    cleanup.push(() => new Promise<void>((resolve) => fake.close(() => resolve())));
    expect(await socketRedact({ path: socket })(Uint8Array.from([5, 6]), REQUEST)).toEqual({ kind: 'original' });
    const all = Buffer.concat(seen);
    const header = JSON.parse(all.subarray(12, 12 + all.readUInt32BE(4)).toString('utf8')) as unknown;
    expect(header).toEqual({ v: 1, quotes: ['Kestrel Ambry'], redactsAny: true, image: 'blur' });
    expect(all.subarray(12 + all.readUInt32BE(4))).toEqual(Buffer.from([5, 6]));
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
