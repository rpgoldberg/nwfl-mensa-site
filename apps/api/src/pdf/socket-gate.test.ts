// The worker's side of the gate sidecar (UNTRUSTED-PDF-GATE M2): one connection per check, and a job
// that fails closed, retryably, when the gate cannot be asked. The gate's side is gate-service.test.ts.
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GATE_REPLY_MAGIC, MAX_GATE_REPLY_HEADER_BYTES, MAX_OUTPUT_BYTES, encodeFrame, sha256Hex } from './engine-protocol.js';
import { RetryableEngineError } from './regenerate.js';
import { GATE_SOCKET_TIMEOUT_MS, socketGate } from './socket-gate.js';

const COPY = Uint8Array.from([3, 1, 4]);
const SHA = sha256Hex(COPY);
const ORIGINAL = Uint8Array.from([2, 7]);
const JOB = { copy: COPY, original: ORIGINAL, quotes: ['Kestrel Ambry'], image: 'hide' as const, sha256: SHA };
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function dir(): string {
  const made = mkdtempSync(path.join(tmpdir(), 'nwfl-sg-'));
  cleanup.push(() => rmSync(made, { recursive: true, force: true }));
  return made;
}

/** A gate stand-in on a fresh socket: it reads one request, records it, and answers `reply`. */
async function fakeGate(reply: (request: Buffer) => Buffer | null): Promise<{ socket: string; seen: Buffer[] }> {
  const socket = path.join(dir(), 'gate.sock');
  const seen: Buffer[] = [];
  const server = net.createServer((conn) => {
    const chunks: Buffer[] = [];
    conn.on('error', () => {});
    conn.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      const all = Buffer.concat(chunks);
      if (all.length >= 12 && all.length === 12 + all.readUInt32BE(4) + all.readUInt32BE(8)) {
        seen.push(all);
        const answer = reply(all);
        if (answer === null) conn.destroy();
        else conn.end(answer);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { socket, seen };
}

describe('socketGate', () => {
  it('gives up after GATE_SOCKET_TIMEOUT_MS by default: past the gate\'s own 120 s deadline', () => {
    expect(GATE_SOCKET_TIMEOUT_MS).toBe(150_000);
  });

  it('sends the copy and the original with their sha256s, the quotes and the image action, and hands back the verdict and the hash the gate names', async () => {
    const { socket, seen } = await fakeGate(() => encodeFrame(GATE_REPLY_MAGIC, { v: 1, verdict: 'refused', code: 'rules', sha256: SHA }));
    expect(await socketGate({ path: socket })(JOB)).toEqual({ verdict: { pass: false, code: 'rules' }, sha256: SHA });
    const request = seen[0] as Buffer;
    expect(JSON.parse(request.subarray(12, 12 + request.readUInt32BE(4)).toString('utf8'))).toEqual({
      v: 1,
      quotes: ['Kestrel Ambry'],
      image: 'hide',
      sha256: SHA,
      originalSha256: sha256Hex(ORIGINAL),
      copyBytes: COPY.length,
    });
    expect(request.subarray(12 + request.readUInt32BE(4))).toEqual(Buffer.concat([COPY, ORIGINAL]));
  });

  it('fails the job closed, retryably, when the socket is missing, not a socket, or a symlink to a live one (S4)', async () => {
    const at = dir();
    const missing = socketGate({ path: path.join(at, 'gate.sock') })(JOB);
    await expect(missing).rejects.toBeInstanceOf(RetryableEngineError);
    await expect(missing).rejects.toThrow('the gate socket is missing');
    const file = path.join(at, 'file.sock');
    writeFileSync(file, 'x');
    await expect(socketGate({ path: file })(JOB)).rejects.toThrow('the gate socket path holds something other than a socket');
    const { socket, seen } = await fakeGate(() => encodeFrame(GATE_REPLY_MAGIC, { v: 1, verdict: 'pass', sha256: SHA }));
    const link = path.join(at, 'link.sock');
    symlinkSync(socket, link);
    const linked = socketGate({ path: link })(JOB);
    await expect(linked).rejects.toBeInstanceOf(RetryableEngineError);
    await expect(linked).rejects.toThrow('the gate socket path holds something other than a socket');
    expect(seen).toEqual([]);
  });

  it('fails the job closed, retryably, on a hang-up, a malformed reply, or no reply in time', async () => {
    const hangUp = await fakeGate(() => null);
    const gone = socketGate({ path: hangUp.socket })(JOB);
    await expect(gone).rejects.toBeInstanceOf(RetryableEngineError);
    await expect(gone).rejects.toThrow('the gate sidecar gave no usable reply');
    for (const bad of [
      encodeFrame(GATE_REPLY_MAGIC, { v: 1, verdict: 'pass' }),
      encodeFrame(GATE_REPLY_MAGIC, { v: 1, verdict: 'pass', sha256: SHA, note: 'Kestrel' }),
      Buffer.from('HTTP/1.1 200 OK\r\n\r\n'),
    ]) {
      const { socket } = await fakeGate(() => bad);
      await expect(socketGate({ path: socket })(JOB)).rejects.toBeInstanceOf(RetryableEngineError);
    }
    const silent = await fakeGate(() => Buffer.alloc(0));
    const late = socketGate({ path: silent.socket, timeoutMs: 300 })(JOB);
    await expect(late).rejects.toBeInstanceOf(RetryableEngineError);
    const nobody = path.join(dir(), 'gate.sock');
    const listener = net.createServer();
    await new Promise<void>((resolve) => listener.listen(nobody, resolve));
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    // close() removes the socket file; a socket file with no listener is what a killed sidecar leaves.
    expect(await socketGate({ path: nobody })(JOB).catch((error: Error) => error.message)).toMatch(/the gate socket is missing|could not be reached/);
  });

  it('reads a verdict header of exactly MAX_GATE_REPLY_HEADER_BYTES, and refuses one byte more (S2)', async () => {
    expect(MAX_GATE_REPLY_HEADER_BYTES).toBe(1024);
    for (const [size, outcome] of [
      [MAX_GATE_REPLY_HEADER_BYTES, 'read'],
      [MAX_GATE_REPLY_HEADER_BYTES + 1, 'over'],
    ] as const) {
      const json = `{"v":1,"verdict":"pass","sha256":"${SHA}"}`;
      const head = Buffer.from(json + ' '.repeat(size - json.length), 'utf8');
      const prefix = Buffer.alloc(12);
      GATE_REPLY_MAGIC.copy(prefix, 0);
      prefix.writeUInt32BE(head.length, 4);
      const { socket } = await fakeGate(() => Buffer.concat([prefix, head]));
      const check = socketGate({ path: socket })(JOB);
      if (outcome === 'read') expect(await check).toEqual({ verdict: { pass: true }, sha256: SHA });
      else await expect(check).rejects.toThrow('the gate sidecar gave no usable reply: the header is over its cap');
    }
  });

  it('gives no pass for a check it cannot send, and does not connect for it', async () => {
    const { socket, seen } = await fakeGate(() => encodeFrame(GATE_REPLY_MAGIC, { v: 1, verdict: 'pass', sha256: SHA }));
    const tooBig = new Uint8Array(MAX_OUTPUT_BYTES + 1);
    expect(await socketGate({ path: socket })({ ...JOB, copy: tooBig, sha256: sha256Hex(tooBig) })).toEqual({ verdict: { pass: false, code: 'unfinished' }, sha256: null });
    expect(await socketGate({ path: socket })({ ...JOB, quotes: Array.from({ length: 2200 }, (_, n) => `${n}`.padEnd(500, 'q')) })).toEqual({ verdict: { pass: false, code: 'unfinished' }, sha256: null });
    expect(seen).toEqual([]);
  });
});
