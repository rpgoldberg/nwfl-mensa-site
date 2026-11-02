// The engine sidecar's wire format (UNTRUSTED-PDF-GATE): one length-prefixed frame each way, with
// hard caps, and nothing in a header but the typed request or result.
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  FrameError,
  MAX_INPUT_BYTES,
  MAX_OUTPUT_BYTES,
  MAX_QUOTES,
  MAX_QUOTE_CHARS,
  MAX_REQUEST_HEADER_BYTES,
  MAX_TEXT_CHARS,
  PREFIX_BYTES,
  REPLY_MAGIC,
  REQUEST_MAGIC,
  decodeReply,
  decodeRequest,
  encodeFrame,
  encodeReply,
  encodeRequest,
  readFrame,
} from './engine-protocol.js';

const REQUEST = { quotes: ['Kestrel Ambry'], redactsAny: true };
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const LIMITS = { magic: REQUEST_MAGIC, maxHeader: MAX_REQUEST_HEADER_BYTES, maxBody: MAX_INPUT_BYTES };

/** Reads one frame from a stream fed these chunks, one per tick, then (unless `end` is false) its end. */
function fed(chunks: readonly Buffer[], options: { end?: boolean; untilEnd?: boolean; timeoutMs?: number; limits?: typeof LIMITS } = {}): ReturnType<typeof readFrame> {
  const stream = new PassThrough();
  const read = readFrame(stream, { ...(options.limits ?? LIMITS), untilEnd: options.untilEnd ?? true, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) });
  void (async () => {
    for (const chunk of chunks) {
      await new Promise((resolve) => setImmediate(resolve));
      stream.write(chunk);
    }
    await new Promise((resolve) => setImmediate(resolve));
    if (options.end !== false) stream.end();
  })();
  return read;
}

describe('requests', () => {
  it('round-trip: the original and the typed request, nothing else', async () => {
    const original = Uint8Array.from([37, 80, 68, 70]);
    const frame = await fed([encodeRequest(original, REQUEST)]);
    expect(decodeRequest(frame)).toEqual({ original, request: REQUEST });
    const withImage = await fed([encodeRequest(original, { ...REQUEST, image: 'blur' })]);
    expect(decodeRequest(withImage)).toEqual({ original, request: { ...REQUEST, image: 'blur' } });
  });

  it('arrives in any pieces, a byte at a time included', async () => {
    const bytes = encodeRequest(Uint8Array.from([1, 2, 3]), REQUEST);
    const frame = await fed([...bytes].map((b) => Buffer.from([b])));
    expect(decodeRequest(frame).original).toEqual(Uint8Array.from([1, 2, 3]));
  });

  it('is never built over the caps', () => {
    const one = Uint8Array.from([1]);
    expect(() => encodeRequest(new Uint8Array(0), REQUEST)).toThrow('the original is outside the engine input cap');
    expect(() => encodeRequest(new Uint8Array(MAX_INPUT_BYTES + 1), REQUEST)).toThrow(FrameError);
    expect(() => encodeRequest(one, { quotes: Array.from({ length: MAX_QUOTES + 1 }, () => 'abc'), redactsAny: true })).toThrow('too many quotes');
    expect(() => encodeRequest(one, { quotes: ['x'.repeat(MAX_QUOTE_CHARS + 1)], redactsAny: true })).toThrow('a quote is over its cap');
    const heavy = Array.from({ length: Math.ceil(MAX_REQUEST_HEADER_BYTES / MAX_QUOTE_CHARS) + 1 }, () => 'a'.repeat(MAX_QUOTE_CHARS));
    expect(() => encodeRequest(one, { quotes: heavy, redactsAny: true })).toThrow('the request header is over its cap');
  });

  it('refuses a header that is not exactly the typed request', () => {
    const body = Buffer.from([1]);
    const bad: unknown[] = [
      null,
      [],
      'text',
      { v: 2, quotes: [], redactsAny: true },
      { v: 1, quotes: [], redactsAny: true, path: '/x' },
      { v: 1, quotes: 'abc', redactsAny: true },
      { v: 1, quotes: [1], redactsAny: true },
      { v: 1, quotes: Array.from({ length: MAX_QUOTES + 1 }, () => 'a'), redactsAny: true },
      { v: 1, quotes: ['x'.repeat(MAX_QUOTE_CHARS + 1)], redactsAny: true },
      { v: 1, quotes: [], redactsAny: 1 },
      { v: 1, quotes: [], redactsAny: true, image: 'melt' },
      { v: 1, quotes: [] },
    ];
    for (const header of bad) expect(() => decodeRequest({ header, body }), JSON.stringify(header)).toThrow(FrameError);
    expect(() => decodeRequest({ header: { v: 1, quotes: [], redactsAny: true }, body: Buffer.alloc(0) })).toThrow('the request carries no original');
  });
});

describe('readFrame', () => {
  it('refuses another magic, and the reply magic where a request belongs', async () => {
    await expect(fed([Buffer.from('GET / HTTP/1.1\r\n\r\n')])).rejects.toThrow('not a frame');
    await expect(fed([encodeFrame(REPLY_MAGIC, { v: 1, kind: 'original' })])).rejects.toThrow('not a frame');
  });

  it('stops at the declared sizes, before reading on', async () => {
    await expect(fed([Buffer.concat([REQUEST_MAGIC, u32(MAX_REQUEST_HEADER_BYTES + 1), u32(1)])], { end: false })).rejects.toThrow('the header is over its cap');
    await expect(fed([Buffer.concat([REQUEST_MAGIC, u32(2), u32(MAX_INPUT_BYTES + 1)])], { end: false })).rejects.toThrow('the body is over its cap');
  });

  it('refuses bytes after the frame, in the same piece or a later one', async () => {
    const frame = encodeRequest(Uint8Array.from([1]), REQUEST);
    await expect(fed([Buffer.concat([frame, Buffer.from('x')])])).rejects.toThrow('bytes after the frame');
    await expect(fed([frame, Buffer.from('x')])).rejects.toThrow('bytes after the frame');
  });

  it('refuses a frame cut short, before or after its prefix', async () => {
    const frame = encodeRequest(Uint8Array.from([1]), REQUEST);
    await expect(fed([frame.subarray(0, 5)])).rejects.toThrow('the frame was cut short');
    await expect(fed([frame.subarray(0, frame.length - 1)])).rejects.toThrow('the frame was cut short');
    await expect(fed([])).rejects.toThrow('the frame was cut short');
  });

  it('refuses a header that is not UTF-8 JSON', async () => {
    const raw = (header: Buffer): Buffer => Buffer.concat([REQUEST_MAGIC, u32(header.length), u32(1), header, Buffer.from([1])]);
    await expect(fed([raw(Buffer.from('{"v":'))])).rejects.toThrow('the header is not JSON');
    await expect(fed([raw(Buffer.from([0x22, 0xff, 0x22]))])).rejects.toThrow('the header is not JSON');
  });

  it('without untilEnd, answers as soon as the frame is whole; with it, only once the stream ends', async () => {
    const frame = encodeRequest(Uint8Array.from([1]), REQUEST);
    expect(decodeRequest(await fed([frame], { end: false, untilEnd: false })).original).toEqual(Uint8Array.from([1]));
    await expect(fed([frame], { end: false, timeoutMs: 100 })).rejects.toThrow('the frame took longer than 100 ms');
  });

  it('gives up after its timeout, and on a stream error or close', async () => {
    await expect(fed([REQUEST_MAGIC], { end: false, timeoutMs: 50 })).rejects.toThrow('the frame took longer than 50 ms');
    const failing = new PassThrough();
    const read = readFrame(failing, LIMITS);
    failing.destroy(Object.assign(new Error('reset'), { code: 'ECONNRESET' }));
    await expect(read).rejects.toThrow('the connection failed (ECONNRESET)');
    const closing = new PassThrough();
    const closed = readFrame(closing, LIMITS);
    closing.destroy();
    await expect(closed).rejects.toThrow('the frame was cut short');
    const plain = new PassThrough();
    const odd = readFrame(plain, LIMITS);
    plain.destroy(new Error('no code'));
    await expect(odd).rejects.toThrow('the connection failed (no code)');
  });
});

describe('replies', () => {
  const reply = async (value: Parameters<typeof encodeReply>[0]): Promise<ReturnType<typeof decodeReply>> =>
    decodeReply(await fed([encodeReply(value)], { limits: { magic: REPLY_MAGIC, maxHeader: 16_384, maxBody: MAX_OUTPUT_BYTES } }));

  it('round-trip: each kind, the copy\'s bytes intact and its boxes left behind', async () => {
    expect(await reply({ kind: 'redacted', pdf: Uint8Array.from([9, 8]), boxes: [{ page: 0, left: 1, bottom: 2, right: 3, top: 4 } as never] })).toEqual({
      kind: 'redacted',
      pdf: Uint8Array.from([9, 8]),
      boxes: [],
    });
    expect(await reply({ kind: 'original' })).toEqual({ kind: 'original' });
    expect(await reply({ kind: 'refused', reason: 'page 1 is a scan' })).toEqual({ kind: 'refused', reason: 'page 1 is a scan' });
    expect(await reply({ kind: 'failed', message: 'the engine threw' })).toEqual({ kind: 'failed', message: 'the engine threw' });
    expect(await reply({ kind: 'failed', message: '' })).toEqual({ kind: 'failed', message: '' });
  });

  it('sends no copy outside the output cap, and cuts long text to its cap', async () => {
    expect(await reply({ kind: 'redacted', pdf: new Uint8Array(MAX_OUTPUT_BYTES + 1), boxes: [] })).toEqual({ kind: 'failed', message: 'the copy is outside the engine output cap' });
    expect(await reply({ kind: 'redacted', pdf: new Uint8Array(0), boxes: [] })).toEqual({ kind: 'failed', message: 'the copy is outside the engine output cap' });
    expect(await reply({ kind: 'refused', reason: 'r'.repeat(MAX_TEXT_CHARS + 5) })).toEqual({ kind: 'refused', reason: 'r'.repeat(MAX_TEXT_CHARS) });
    expect(await reply({ kind: 'failed', message: 'm'.repeat(MAX_TEXT_CHARS + 5) })).toEqual({ kind: 'failed', message: 'm'.repeat(MAX_TEXT_CHARS) });
    expect(await reply({ kind: 'refused', reason: '' })).toEqual({ kind: 'refused', reason: 'the engine refused without a reason' });
  });

  it('refuses a reply that is not exactly a typed result', () => {
    const none = Buffer.alloc(0);
    const one = Buffer.from([1]);
    const bad: Array<[unknown, Buffer]> = [
      [null, none],
      [{ v: 2, kind: 'original' }, none],
      [{ v: 1, kind: 'leaked' }, none],
      [{ v: 1, kind: 'original', extra: 1 }, none],
      [{ v: 1, kind: 'original' }, one],
      [{ v: 1, kind: 'redacted' }, none],
      [{ v: 1, kind: 'redacted', boxes: [] }, one],
      [{ v: 1, kind: 'refused' }, none],
      [{ v: 1, kind: 'refused', reason: '' }, none],
      [{ v: 1, kind: 'refused', reason: 'x'.repeat(MAX_TEXT_CHARS + 1) }, none],
      [{ v: 1, kind: 'refused', reason: 'no' }, one],
      [{ v: 1, kind: 'failed', message: 7 }, none],
      [{ v: 1, kind: 'failed' }, none],
    ];
    for (const [header, body] of bad) expect(() => decodeReply({ header, body }), JSON.stringify(header)).toThrow(FrameError);
  });

  it('has a 12-byte prefix: the magic and two lengths', () => {
    const frame = encodeFrame(REPLY_MAGIC, { v: 1 }, Uint8Array.from([7]));
    expect(PREFIX_BYTES).toBe(12);
    expect(frame.subarray(0, 4).equals(REPLY_MAGIC)).toBe(true);
    expect(frame.readUInt32BE(4)).toBe(Buffer.byteLength('{"v":1}'));
    expect(frame.readUInt32BE(8)).toBe(1);
  });
});
