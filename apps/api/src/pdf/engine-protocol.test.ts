// The engine sidecar's wire format (UNTRUSTED-PDF-GATE): one length-prefixed frame each way, with
// hard caps, and nothing in a header but the typed request or result.
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  FIRST_BYTES_TIMEOUT_MS,
  FrameError,
  GATE_REPLY_MAGIC,
  GATE_REQUEST_MAGIC,
  MAX_GATE_BODY_BYTES,
  MAX_GATE_REPLY_HEADER_BYTES,
  MAX_INPUT_BYTES,
  MAX_OUTPUT_BYTES,
  MAX_QUOTES,
  MAX_LINKS,
  MAX_QUOTE_CHARS,
  MAX_REPLY_HEADER_BYTES,
  MAX_REQUEST_HEADER_BYTES,
  MAX_TEXT_CHARS,
  PREFIX_BYTES,
  PROTOCOL_VERSION,
  REPLY_MAGIC,
  REQUEST_MAGIC,
  decodeGateReply,
  decodeGateRequest,
  decodeReply,
  decodeRequest,
  encodeFrame,
  encodeGateReply,
  encodeGateRequest,
  encodeReply,
  encodeRequest,
  readFrame,
  sha256Hex,
} from './engine-protocol.js';

const REQUEST = { quotes: ['Kestrel Ambry'], redactsAny: true };
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const LIMITS = { magic: REQUEST_MAGIC, maxHeader: MAX_REQUEST_HEADER_BYTES, maxBody: MAX_INPUT_BYTES };

/** Reads one frame from a stream fed these chunks, one per tick, then (unless `end` is false) its end. */
function fed(chunks: readonly Buffer[], options: { end?: boolean; untilEnd?: boolean; timeoutMs?: number; firstBytesTimeoutMs?: number; limits?: typeof LIMITS } = {}): ReturnType<typeof readFrame> {
  const stream = new PassThrough();
  const read = readFrame(stream, {
    ...(options.limits ?? LIMITS),
    untilEnd: options.untilEnd ?? true,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.firstBytesTimeoutMs === undefined ? {} : { firstBytesTimeoutMs: options.firstBytesTimeoutMs }),
  });
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
    // A request that says nothing of what members withhold says they withhold every quote (BOXLABEL: "Private").
    expect(decodeRequest(frame)).toEqual({ original, request: { ...REQUEST, links: [], membersWithhold: [true] } });
    const withImage = await fed([encodeRequest(original, { ...REQUEST, image: 'blur', membersWithhold: [false] })]);
    expect(decodeRequest(withImage)).toEqual({ original, request: { ...REQUEST, image: 'blur', links: [], membersWithhold: [false] } });
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
    const good = { v: 3, quotes: [], redactsAny: true, links: [], membersWithhold: [] };
    expect(decodeRequest({ header: good, body }).request).toEqual({ quotes: [], redactsAny: true, links: [], membersWithhold: [] });
    const bad: unknown[] = [
      null,
      [],
      'text',
      { v: 1, quotes: [], redactsAny: true },
      { v: 1, quotes: [], redactsAny: true, links: [] },
      { v: 2, quotes: [], redactsAny: true, links: [] },
      { ...good, v: 2 },
      { v: 3, quotes: [], redactsAny: true, membersWithhold: [] },
      { v: 3, quotes: [], redactsAny: true, links: [] },
      { ...good, path: '/x' },
      { ...good, quotes: 'abc' },
      { ...good, quotes: [1], membersWithhold: [true] },
      { ...good, quotes: Array.from({ length: MAX_QUOTES + 1 }, () => 'a'), membersWithhold: Array.from({ length: MAX_QUOTES + 1 }, () => true) },
      { ...good, quotes: ['x'.repeat(MAX_QUOTE_CHARS + 1)], membersWithhold: [true] },
      { ...good, redactsAny: 1 },
      { ...good, image: 'melt' },
      { v: 3, quotes: [], links: [], membersWithhold: [] },
    ];
    for (const header of bad) expect(() => decodeRequest({ header, body }), JSON.stringify(header)).toThrow(FrameError);
    expect(() => decodeRequest({ header: good, body: Buffer.alloc(0) })).toThrow('the request carries no original');
  });
});

describe('requests: what members withhold (v3, BOXLABEL)', () => {
  const header = (frame: Buffer): Record<string, unknown> => JSON.parse(frame.subarray(PREFIX_BYTES, PREFIX_BYTES + frame.readUInt32BE(4)).toString('utf8')) as Record<string, unknown>;
  /** Every string a header holds, at any depth. */
  const strings = (value: unknown): string[] =>
    typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : typeof value === 'object' && value !== null ? Object.values(value).flatMap(strings) : [];

  it('is one boolean per quote, so the header holds no text beyond the quotes it already held', async () => {
    const quotes = ['Kestrel Ambry', '850-555-0142'];
    const flagged = encodeRequest(Uint8Array.from([1]), { quotes, redactsAny: true, membersWithhold: [false, true] });
    const plain = encodeRequest(Uint8Array.from([1]), { quotes, redactsAny: true, membersWithhold: [false, false] });
    expect(header(flagged)).toEqual({ v: PROTOCOL_VERSION, quotes, redactsAny: true, links: [], membersWithhold: [false, true] });
    expect(PROTOCOL_VERSION).toBe(3);
    // The flags change no string of the header: the same text whichever quotes members withhold.
    expect(strings(header(flagged)).sort()).toEqual([...quotes].sort());
    expect(strings(header(flagged))).toEqual(strings(header(plain)));
    expect(decodeRequest(await fed([flagged])).request.membersWithhold).toEqual([false, true]);
  });

  it('refuses flags that are not one boolean per quote, or that carry text', () => {
    const body = Buffer.from([1]);
    const base = { v: 3, quotes: ['Kestrel Ambry'], redactsAny: true, links: [] };
    for (const membersWithhold of [[], [true, false], ['Kestrel Ambry'], [1], [null], 'true', true, { 0: true }]) {
      expect(() => decodeRequest({ header: { ...base, membersWithhold }, body }), JSON.stringify(membersWithhold)).toThrow('what members withhold is not one boolean per quote');
    }
  });

  it('is never built unless it is one boolean per quote', () => {
    const one = Uint8Array.from([1]);
    expect(() => encodeRequest(one, { quotes: ['a', 'b'], redactsAny: true, membersWithhold: [true] })).toThrow('what members withhold is not one boolean per quote');
    expect(() => encodeRequest(one, { quotes: ['a'], redactsAny: true, membersWithhold: ['a' as unknown as boolean] })).toThrow(FrameError);
  });
});

describe('readFrame', () => {
  it('refuses another magic, and the reply magic where a request belongs', async () => {
    await expect(fed([Buffer.from('GET / HTTP/1.1\r\n\r\n')])).rejects.toThrow('not a frame');
    await expect(fed([encodeFrame(REPLY_MAGIC, { v: 3, kind: 'original' })])).rejects.toThrow('not a frame');
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

  it('bounds an idle connection: the prefix must arrive within its own few seconds, then the frame has the rest', async () => {
    expect(FIRST_BYTES_TIMEOUT_MS).toBe(5_000);
    await expect(fed([], { end: false, firstBytesTimeoutMs: 50, timeoutMs: 10_000 })).rejects.toThrow('no frame began within 50 ms');
    // Eleven bytes are not a prefix yet.
    await expect(fed([encodeRequest(Uint8Array.from([1]), REQUEST).subarray(0, 11)], { end: false, firstBytesTimeoutMs: 50, timeoutMs: 10_000 })).rejects.toThrow('no frame began within 50 ms');
    // Once the prefix is in, the first-bytes deadline is off and only the frame's own applies.
    const frame = encodeRequest(Uint8Array.from([1]), REQUEST);
    const slow = new PassThrough();
    const read = readFrame(slow, { ...LIMITS, firstBytesTimeoutMs: 50, timeoutMs: 2_000 });
    slow.write(frame.subarray(0, PREFIX_BYTES));
    await new Promise((resolve) => setTimeout(resolve, 150));
    slow.end(frame.subarray(PREFIX_BYTES));
    expect(decodeRequest(await read).original).toEqual(Uint8Array.from([1]));
  });
});

describe('gate requests and replies (the worker and the gate sidecar)', () => {
  const COPY = Uint8Array.from([4, 5, 6]);
  const SHA = sha256Hex(COPY);
  const ORIGINAL = Uint8Array.from([9, 9]);
  const ORIGINAL_SHA = sha256Hex(ORIGINAL);
  const GATE = { copy: COPY, original: ORIGINAL, quotes: ['Kestrel Ambry'], image: 'blur' as const, sha256: SHA, originalSha256: ORIGINAL_SHA };
  const GATE_LIMITS = { magic: GATE_REQUEST_MAGIC, maxHeader: MAX_REQUEST_HEADER_BYTES, maxBody: MAX_GATE_BODY_BYTES };
  const REPLY_LIMITS = { magic: GATE_REPLY_MAGIC, maxHeader: MAX_GATE_REPLY_HEADER_BYTES, maxBody: MAX_OUTPUT_BYTES };

  it('hashes with sha256, in lower-case hex', () => {
    expect(SHA).toBe('787c798e39a5bc1910355bae6d0cd87a36b2e10fd0202a83e3bb6b005da83472');
    expect(MAX_GATE_BODY_BYTES).toBe(MAX_OUTPUT_BYTES + MAX_INPUT_BYTES);
  });

  it('round-trip: the copy and the original with their sha256s, the quotes and the image action, nothing else', async () => {
    const frame = encodeGateRequest(GATE);
    expect(frame.subarray(0, 4).equals(GATE_REQUEST_MAGIC)).toBe(true);
    expect(JSON.parse(frame.subarray(12, 12 + frame.readUInt32BE(4)).toString('utf8'))).toEqual({ v: 3, quotes: ['Kestrel Ambry'], image: 'blur', sha256: SHA, originalSha256: ORIGINAL_SHA, copyBytes: 3, links: [], kept: [] });
    expect(frame.subarray(12 + frame.readUInt32BE(4))).toEqual(Buffer.from([4, 5, 6, 9, 9]));
    expect(decodeGateRequest(await fed([frame], { limits: GATE_LIMITS }))).toEqual({ ...GATE, links: [], kept: [] });
  });

  it('is never built over the caps, or with a hash that is not one', () => {
    expect(() => encodeGateRequest({ ...GATE, copy: new Uint8Array(0) })).toThrow('the copy is outside the gate input cap');
    expect(() => encodeGateRequest({ ...GATE, copy: new Uint8Array(MAX_OUTPUT_BYTES + 1) })).toThrow('the copy is outside the gate input cap');
    expect(() => encodeGateRequest({ ...GATE, original: new Uint8Array(0) })).toThrow('the original is outside the gate input cap');
    expect(() => encodeGateRequest({ ...GATE, original: new Uint8Array(MAX_INPUT_BYTES + 1) })).toThrow('the original is outside the gate input cap');
    expect(() => encodeGateRequest({ ...GATE, quotes: Array.from({ length: MAX_QUOTES + 1 }, () => 'a') })).toThrow('too many quotes');
    expect(() => encodeGateRequest({ ...GATE, quotes: ['x'.repeat(MAX_QUOTE_CHARS + 1)] })).toThrow('a quote is over its cap');
    expect(() => encodeGateRequest({ ...GATE, quotes: Array.from({ length: 2200 }, () => 'q'.repeat(500)) })).toThrow('the request header is over its cap');
    expect(() => encodeGateRequest({ ...GATE, sha256: 'abc' })).toThrow('a hash is not a sha256');
    expect(() => encodeGateRequest({ ...GATE, originalSha256: 'abc' })).toThrow('a hash is not a sha256');
  });

  it('refuses a request header that is not exactly the typed gate request', () => {
    const body = Buffer.from([4, 5, 6, 9, 9]);
    const good = { v: 3, quotes: [], image: 'show', sha256: SHA, originalSha256: ORIGINAL_SHA, copyBytes: 3, links: [], kept: [] };
    expect(decodeGateRequest({ header: good, body })).toEqual({ ...GATE, quotes: [], image: 'show', links: [], kept: [] });
    const bad: Array<[unknown, Buffer]> = [
      [null, body],
      [[], body],
      [{ ...good, v: 1 }, body],
      [{ ...good, links: undefined }, body],
      [{ ...good, kept: undefined }, body],
      [{ ...good, sha256: undefined }, body],
      [{ ...good, env: {} }, body],
      [{ ...good, quotes: [7] }, body],
      [{ ...good, image: 'melt' }, body],
      [{ ...good, image: undefined }, body],
      [{ ...good, sha256: SHA.toUpperCase() }, body],
      [{ ...good, originalSha256: 7 }, body],
      [{ ...good, copyBytes: 0 }, body],
      [{ ...good, copyBytes: 5 }, body],
      [{ ...good, copyBytes: 2.5 }, body],
      [{ ...good, copyBytes: '3' }, body],
      [{ ...good, copyBytes: MAX_OUTPUT_BYTES + 1 }, Buffer.alloc(MAX_OUTPUT_BYTES + 2)],
      [good, Buffer.concat([Buffer.from([4, 5, 6]), Buffer.alloc(MAX_INPUT_BYTES + 1)])],
    ];
    for (const [header, raw] of bad) expect(() => decodeGateRequest({ header, body: raw }), JSON.stringify(header)?.slice(0, 120)).toThrow(FrameError);
  });

  it('round-trip: a pass with the bytes the gate checked (its writing of the copy) and their sha256, or a refusal by code with no body; each names the copy\'s sha256 (M1)', async () => {
    const reply = async (value: Parameters<typeof encodeGateReply>[0]): Promise<ReturnType<typeof decodeGateReply>> => decodeGateReply(await fed([encodeGateReply(value)], { limits: REPLY_LIMITS }));
    const written = Uint8Array.from([7, 8, 9, 10]);
    const checked = { pdf: written, sha256: sha256Hex(written) };
    const passed = await reply({ verdict: { pass: true }, sha256: SHA, checked });
    expect(passed).toEqual({ verdict: { pass: true }, sha256: SHA, checked: { pdf: expect.any(Uint8Array) as unknown, sha256: checked.sha256 } });
    expect([...(passed.checked?.pdf ?? [])]).toEqual([7, 8, 9, 10]);
    for (const code of ['withheld', 'rules', 'unfinished', 'mismatch'] as const) {
      expect(await reply({ verdict: { pass: false, code }, sha256: SHA, checked }), code).toEqual({ verdict: { pass: false, code }, sha256: SHA });
    }
  });

  it('will not write a pass without the checked bytes, or with bytes outside the output cap', () => {
    expect(() => encodeGateReply({ verdict: { pass: true }, sha256: SHA })).toThrow(FrameError);
    expect(() => encodeGateReply({ verdict: { pass: true }, sha256: SHA, checked: { pdf: new Uint8Array(0), sha256: SHA } })).toThrow(FrameError);
    expect(() => encodeGateReply({ verdict: { pass: true }, sha256: SHA, checked: { pdf: new Uint8Array(MAX_OUTPUT_BYTES + 1), sha256: SHA } })).toThrow(FrameError);
  });

  it('refuses a reply that is not exactly a typed verdict', () => {
    const none = Buffer.alloc(0);
    const bad: Array<[unknown, Buffer]> = [
      [null, none],
      [{ v: 1, verdict: 'pass', sha256: SHA, checkedSha256: SHA }, Buffer.from([1])],
      [{ v: 3, verdict: 'pass' }, Buffer.from([1])],
      [{ v: 3, verdict: 'pass', sha256: 'x', checkedSha256: SHA }, Buffer.from([1])],
      [{ v: 3, verdict: 'pass', sha256: SHA, checkedSha256: 'x' }, Buffer.from([1])],
      [{ v: 3, verdict: 'pass', sha256: SHA, checkedSha256: SHA, code: 'withheld' }, Buffer.from([1])],
      [{ v: 3, verdict: 'pass', sha256: SHA }, Buffer.from([1])],
      [{ v: 3, verdict: 'pass', sha256: SHA, checkedSha256: SHA }, none],
      [{ v: 3, verdict: 'pass', sha256: SHA, checkedSha256: SHA }, Buffer.alloc(MAX_OUTPUT_BYTES + 1)],
      [{ v: 3, verdict: 'refused', code: 'rules', sha256: SHA }, Buffer.from([1])],
      [{ v: 3, verdict: 'refused', sha256: SHA }, none],
      [{ v: 3, verdict: 'refused', code: 'leaked', sha256: SHA }, none],
      [{ v: 3, verdict: 'refused', code: 'withheld', sha256: SHA, reason: 'Kestrel' }, none],
      [{ v: 3, verdict: 'maybe', sha256: SHA }, none],
    ];
    for (const [header, body] of bad) expect(() => decodeGateReply({ header, body }), JSON.stringify(header)).toThrow(FrameError);
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
      kept: [],
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
      [{ v: 1, kind: 'original' }, none],
      [{ v: 1, kind: 'redacted' }, one],
      [{ v: 3, kind: 'redacted' }, one],
      [{ v: 3, kind: 'leaked' }, none],
      [{ v: 3, kind: 'original', extra: 1 }, none],
      [{ v: 3, kind: 'original' }, one],
      [{ v: 3, kind: 'redacted', kept: [] }, none],
      [{ v: 3, kind: 'redacted', kept: [], boxes: [] }, one],
      [{ v: 3, kind: 'refused' }, none],
      [{ v: 3, kind: 'refused', reason: '' }, none],
      [{ v: 3, kind: 'refused', reason: 'x'.repeat(MAX_TEXT_CHARS + 1) }, none],
      [{ v: 3, kind: 'refused', reason: 'no' }, one],
      [{ v: 3, kind: 'failed', message: 7 }, none],
      [{ v: 3, kind: 'failed' }, none],
    ];
    for (const [header, body] of bad) expect(() => decodeReply({ header, body }), JSON.stringify(header)).toThrow(FrameError);
  });

  it('has a 12-byte prefix: the magic and two lengths', () => {
    const frame = encodeFrame(REPLY_MAGIC, { v: 3 }, Uint8Array.from([7]));
    expect(PREFIX_BYTES).toBe(12);
    expect(frame.subarray(0, 4).equals(REPLY_MAGIC)).toBe(true);
    expect(frame.readUInt32BE(4)).toBe(Buffer.byteLength('{"v":2}'));
    expect(frame.readUInt32BE(8)).toBe(1);
  });
});

describe('protocol v2 (LINKS L3): the links and the origin out, the kept ids back', () => {
  const ORIGIN = 'https://nwflorida.us';
  const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
  /** A distinct id for each n below 1024. */
  const id = (n: number): string => `${'c'.repeat(24)}${B32[(n >> 5) & 31]}${B32[n & 31]}`;
  const LINK = (n: number) => ({ id: id(n), page: 2, rect: [72, 700, 200.5, 714] as const, label: 'Link to site.example' });
  const original = Uint8Array.from([37, 80, 68, 70]);

  it('is version 3 since BOXLABEL (version 2 from LINKS L3)', () => {
    expect(PROTOCOL_VERSION).toBe(3);
    expect(JSON.parse(encodeRequest(original, REQUEST).subarray(12).toString('latin1', 0, encodeRequest(original, REQUEST).readUInt32BE(4)))).toEqual({ v: 3, quotes: ['Kestrel Ambry'], redactsAny: true, links: [], membersWithhold: [true] });
  });

  it('round-trips the links and the origin, and never a target URL', async () => {
    const request = { ...REQUEST, origin: ORIGIN, links: [LINK(1), LINK(2)], membersWithhold: [false] };
    const frame = encodeRequest(original, request);
    expect(frame.toString('latin1')).not.toContain('site.example/');
    expect(decodeRequest(await fed([frame]))).toEqual({ original, request });
  });

  it('is never built with links outside their caps, and a sidecar refuses such a header', () => {
    /** `origin` null: none given. */
    const refuse = (links: unknown, origin: unknown = ORIGIN): void => {
      expect(() => encodeRequest(original, { ...REQUEST, links: links as never, ...(origin === null ? {} : { origin: origin as string }) }), JSON.stringify(links)?.slice(0, 80)).toThrow(FrameError);
      expect(() => decodeRequest({ header: { v: 3, quotes: [], redactsAny: true, links, ...(origin === null ? {} : { origin }) }, body: Buffer.from([1]) }), JSON.stringify(links)?.slice(0, 80)).toThrow(FrameError);
    };
    refuse(Array.from({ length: MAX_LINKS + 1 }, (_, n) => LINK(n)));
    refuse([LINK(1), LINK(1)]);
    refuse([{ ...LINK(1), url: 'https://site.example/' }]);
    refuse([{ ...LINK(1), label: 'Link to Quillon Brask' }]);
    refuse([{ ...LINK(1), rect: [1, 2, 3, Number.POSITIVE_INFINITY] }]);
    refuse([LINK(1)], null);
    refuse([LINK(1)], 'https://evil.example/out/');
    refuse([], 'javascript:alert(1)');
    refuse('links');
  });

  it('carries the ids the engine kept in a copy\'s reply, and refuses any that are not ids, or given twice', async () => {
    const reply = decodeReply(await fed([encodeReply({ kind: 'redacted', pdf: Uint8Array.from([9]), boxes: [], kept: [id(2), id(1)] })], { limits: { magic: REPLY_MAGIC, maxHeader: MAX_REPLY_HEADER_BYTES, maxBody: MAX_OUTPUT_BYTES } }));
    expect(reply).toEqual({ kind: 'redacted', pdf: Uint8Array.from([9]), boxes: [], kept: [id(2), id(1)] });
    const one = Buffer.from([1]);
    for (const kept of [[id(1), id(1)], ['Quillon Brask'], 'none', [7], Array.from({ length: MAX_LINKS + 1 }, () => id(1))]) {
      expect(() => decodeReply({ header: { v: 3, kind: 'redacted', kept }, body: one }), JSON.stringify(kept).slice(0, 60)).toThrow(FrameError);
    }
    expect(encodeReply({ kind: 'redacted', pdf: Uint8Array.from([9]), boxes: [], kept: ['Quillon Brask'] }).toString('latin1')).not.toContain('Quillon');
  });

  it('fits 500 kept ids in a reply header', () => {
    const kept = Array.from({ length: MAX_LINKS }, (_, n) => id(n));
    const frame = encodeReply({ kind: 'redacted', pdf: Uint8Array.from([9]), boxes: [], kept });
    expect(frame.readUInt32BE(4)).toBeLessThanOrEqual(MAX_REPLY_HEADER_BYTES);
    expect((decodeReply({ header: JSON.parse(frame.subarray(12, 12 + frame.readUInt32BE(4)).toString('utf8')), body: Buffer.from([9]) }) as { kept: string[] }).kept).toEqual(kept);
  });

  it('gives the gate the links, the origin and the kept ids, and refuses kept ids the request does not hold', async () => {
    const COPY = Uint8Array.from([4, 5, 6]);
    const ORIGINAL = Uint8Array.from([9, 9]);
    const gate = { copy: COPY, original: ORIGINAL, quotes: [], image: 'show' as const, sha256: sha256Hex(COPY), originalSha256: sha256Hex(ORIGINAL), origin: ORIGIN, links: [LINK(1), LINK(2)], kept: [id(2)] };
    const frame = encodeGateRequest(gate);
    expect(decodeGateRequest(await fed([frame], { limits: { magic: GATE_REQUEST_MAGIC, maxHeader: MAX_REQUEST_HEADER_BYTES, maxBody: MAX_GATE_BODY_BYTES } }))).toEqual(gate);
    const body = Buffer.from([4, 5, 6, 9, 9]);
    const header = { v: 3, quotes: [], image: 'show', sha256: gate.sha256, originalSha256: gate.originalSha256, copyBytes: 3, origin: ORIGIN, links: [LINK(1), LINK(2)], kept: [id(2)] };
    for (const bad of [{ kept: [id(3)] }, { kept: [id(2), id(2)] }, { kept: 'all' }, { links: [LINK(1), LINK(1)] }, { origin: 'https://evil.example/' }, { origin: undefined }]) {
      expect(() => decodeGateRequest({ header: { ...header, ...bad }, body }), JSON.stringify(bad)).toThrow(FrameError);
      expect(() => encodeGateRequest({ ...gate, ...bad } as never), JSON.stringify(bad)).toThrow(FrameError);
    }
  });
});
