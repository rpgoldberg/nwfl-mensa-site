// ARCHIVE-SEARCH S2: the "text" job over the gate sidecar's socket: the worker's side
// (socket-gate.ts socketText) and the sidecar's (gate-service.ts), in this process. The children
// are stand-ins (test/pdf/gate-children). Every name is made up.
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gateStandIn } from '../../test/helpers/sidecar.js';
import { GATE_REPLY_MAGIC, encodeFrame, encodeGateReply, sha256Hex } from './engine-protocol.js';
import { startGateSidecar } from './gate-service.js';
import { RetryableEngineError } from './regenerate.js';
import type { Sidecar } from './sidecar.js';
import { socketGate, socketText } from './socket-gate.js';
import { encodeTextReply, encodeTextRequest } from './text-protocol.js';

const COPY = Uint8Array.from([7, 7, 7, 7, 7]);
const SHA = sha256Hex(COPY);
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});
const place = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nwfl-ts-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'gate.sock');
};
async function sidecar(child: string, options: Partial<Parameters<typeof startGateSidecar>[0]> = {}): Promise<{ socket: string; logged: string[]; sidecar: Sidecar }> {
  const socket = place();
  const logged: string[] = [];
  const started = await startGateSidecar({ path: socket, module: gateStandIn(child), log: (line) => void logged.push(line), ...options });
  cleanup.push(() => started.close());
  return { socket, logged, sidecar: started };
}
/** A stand-in for the sidecar: it answers every request with `reply`, or hangs up. */
async function fake(reply: Buffer | null): Promise<{ socket: string; seen: Buffer[] }> {
  const socket = place();
  const seen: Buffer[] = [];
  const server = net.createServer((conn) => {
    const chunks: Buffer[] = [];
    conn.on('error', () => {});
    conn.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      const all = Buffer.concat(chunks);
      if (all.length >= 12 && all.length === 12 + all.readUInt32BE(4) + all.readUInt32BE(8)) {
        seen.push(all);
        if (reply === null) conn.destroy();
        else conn.end(reply);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { socket, seen };
}

describe('the gate sidecar, asked for text', () => {
  it('reads the copy in a child of its own and answers its pages with the copy\'s sha256', async () => {
    const { socket } = await sidecar('text');
    expect(await socketText({ path: socket })({ copy: COPY, sha256: SHA, quotes: ['Kestrel Ambry'] })).toEqual({ sha256: SHA, pages: [{ text: 'text:5', extra: 'Kestrel Ambry' }] });
  });

  it('still checks a copy on the same socket', async () => {
    const { socket } = await sidecar('pass');
    expect(await socketGate({ path: socket })({ copy: COPY, original: Uint8Array.from([9]), quotes: [], image: 'show', sha256: SHA })).toMatchObject({ verdict: { pass: true }, sha256: SHA });
  });

  it('refuses a copy whose bytes are not the sha256 the worker named, before any child reads it', async () => {
    const { socket } = await sidecar('crash');
    expect(await socketText({ path: socket })({ copy: COPY, sha256: sha256Hex(Uint8Array.from([1])), quotes: [] })).toEqual({ sha256: SHA, code: 'mismatch' });
  });

  it('refuses text whose child names other bytes than it was sent', async () => {
    const { socket } = await sidecar('text');
    expect(await socketText({ path: socket })({ copy: COPY, sha256: SHA, quotes: ['other'] })).toEqual({ sha256: SHA, code: 'mismatch' });
  });

  it('passes on the child\'s refusal, and answers "unfinished" with a log line when the child crashes, answers a verdict or runs past its deadline', async () => {
    const { socket, logged } = await sidecar('text', { timeoutMs: 400 });
    expect(await socketText({ path: socket })({ copy: COPY, sha256: SHA, quotes: ['refuse'] })).toEqual({ sha256: SHA, code: 'withheld' });
    expect(logged).toEqual([]);
    for (const [child, cause] of [['crash', 'crash'], ['pass', 'crash'], ['hang', 'deadline']] as const) {
      const made = await sidecar(child, { timeoutMs: 400 });
      expect(await socketText({ path: made.socket })({ copy: COPY, sha256: SHA, quotes: [] }), child).toEqual({ sha256: SHA, code: 'unfinished' });
      expect(made.logged).toEqual([`a text reading was unfinished (${cause})`]);
    }
  });

  it('drops a malformed text request without a reply and keeps serving', async () => {
    const { socket } = await sidecar('text');
    const conn = net.createConnection({ path: socket });
    const bad = encodeTextRequest({ copy: COPY, sha256: SHA, quotes: [] });
    // One more key in the header: not a text request, and not a check.
    const header = Buffer.from(JSON.stringify({ v: 3, kind: 'text', sha256: SHA, quotes: [], env: 'x' }), 'utf8');
    const prefix = Buffer.from(bad.subarray(0, 12));
    prefix.writeUInt32BE(header.length, 4);
    const replied = await new Promise<number>((resolve) => {
      let bytes = 0;
      conn.on('data', (chunk: Buffer) => (bytes += chunk.length));
      conn.on('close', () => resolve(bytes));
      conn.on('error', () => {});
      conn.end(Buffer.concat([prefix, header, COPY]));
    });
    expect(replied).toBe(0);
    expect(await socketText({ path: socket })({ copy: COPY, sha256: SHA, quotes: [] })).toMatchObject({ pages: [{ text: 'text:5' }] });
  });
});

describe('socketText', () => {
  it('sends one text request: the copy, its sha256 and the quotes', async () => {
    const { socket, seen } = await fake(encodeTextReply({ sha256: SHA, pages: [{ text: 'one', extra: '' }] }));
    expect(await socketText({ path: socket })({ copy: COPY, sha256: SHA, quotes: ['Kestrel Ambry'] })).toEqual({ sha256: SHA, pages: [{ text: 'one', extra: '' }] });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(encodeTextRequest({ copy: COPY, sha256: SHA, quotes: ['Kestrel Ambry'] }));
  });

  it('gives no text for a request it cannot send, and does not connect for it', async () => {
    const { socket, seen } = await fake(null);
    expect(await socketText({ path: socket })({ copy: new Uint8Array(0), sha256: SHA, quotes: [] })).toEqual({ sha256: null, code: 'unfinished' });
    expect(seen).toEqual([]);
  });

  it('fails, retryably, on a missing socket, a hang-up, no reply in time, or a reply that is no text reply (a check\'s verdict, garbage)', async () => {
    const ask = (socket: string, timeoutMs = 2_000) => socketText({ path: socket, timeoutMs })({ copy: COPY, sha256: SHA, quotes: [] });
    await expect(ask(place())).rejects.toBeInstanceOf(RetryableEngineError);
    await expect(ask((await fake(null)).socket)).rejects.toBeInstanceOf(RetryableEngineError);
    await expect(ask((await fake(encodeGateReply({ verdict: { pass: false, code: 'unfinished' }, sha256: SHA }))).socket)).rejects.toThrow('the gate sidecar gave no usable text reply');
    await expect(ask((await fake(encodeFrame(GATE_REPLY_MAGIC, { hello: 1 }))).socket)).rejects.toBeInstanceOf(RetryableEngineError);
    const { socket: silent } = await sidecar('hang');
    await expect(ask(silent, 300)).rejects.toThrow(/took longer than 300 ms/);
  });
});
