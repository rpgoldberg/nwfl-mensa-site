// ARCHIVE-SEARCH S2: the gate's second request, "text" (text-protocol.ts): a stored copy in, the text
// of its pages out, on the gate's own socket and frames. Every name is made up.
import { describe, expect, it } from 'vitest';
import { type Frame, FrameError, GATE_REPLY_MAGIC, GATE_REQUEST_MAGIC, MAX_GATE_REPLY_HEADER_BYTES, MAX_OUTPUT_BYTES, MAX_QUOTES, PROTOCOL_VERSION, decodeGateRequest, encodeFrame, encodeGateRequest, sha256Hex } from './engine-protocol.js';
import { MAX_TEXT_REPLY_BYTES, TEXT_CODES, TEXT_MAX_BYTES, TEXT_MAX_PAGES, TEXT_MAX_PAGE_BYTES, asPages, decodeTextReply, decodeTextRequest, encodeTextReply, encodeTextRequest, isTextFrame } from './text-protocol.js';

const COPY = Uint8Array.from([5, 6, 7]);
const SHA = sha256Hex(COPY);
/** A frame as the other side reads it. */
const framed = (bytes: Buffer): Frame => {
  const head = bytes.readUInt32BE(4);
  return { header: JSON.parse(bytes.subarray(12, 12 + head).toString('utf8')) as unknown, body: bytes.subarray(12 + head) };
};
const page = (text: string, extra = ''): { text: string; extra: string } => ({ text, extra });

describe('the caps', () => {
  it('are the plan\'s: 300 pages, 64 KiB a page, 4 MiB in all, and a reply the worker\'s reader takes', () => {
    expect([TEXT_MAX_PAGES, TEXT_MAX_PAGE_BYTES, TEXT_MAX_BYTES]).toEqual([300, 64 * 1024, 4 * 1024 * 1024]);
    expect(MAX_TEXT_REPLY_BYTES).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(TEXT_CODES).toEqual(['withheld', 'over-cap', 'unfinished', 'mismatch']);
  });
});

describe('asPages', () => {
  it('takes exactly a list of 1 to 300 pages of text and extra', () => {
    expect(asPages([page('Picnic at noon', 'well-known')])).toEqual([page('Picnic at noon', 'well-known')]);
    expect(asPages(Array.from({ length: 300 }, () => page('')))).toHaveLength(300);
    for (const not of [undefined, null, 'text', {}, [], Array.from({ length: 301 }, () => page('')), [null], ['text'], [{ text: 'a' }], [{ text: 'a', extra: 1 }], [{ text: 1, extra: '' }], [{ text: 'a', extra: '', more: 1 }]]) {
      expect(asPages(not), JSON.stringify(not)?.slice(0, 40)).toBeUndefined();
    }
  });

  it('refuses a page or an extra over 64 KiB of UTF-8, a file over 4 MiB in all, and a NUL (Postgres holds none)', () => {
    expect(asPages([page('a'.repeat(TEXT_MAX_PAGE_BYTES))])).toHaveLength(1);
    expect(asPages([page('a'.repeat(TEXT_MAX_PAGE_BYTES + 1))])).toBeUndefined();
    expect(asPages([page('', 'a'.repeat(TEXT_MAX_PAGE_BYTES + 1))])).toBeUndefined();
    // Bytes, not characters: 32768 two-byte letters fit, one more does not.
    expect(asPages([page('é'.repeat(TEXT_MAX_PAGE_BYTES / 2))])).toHaveLength(1);
    expect(asPages([page(`${'é'.repeat(TEXT_MAX_PAGE_BYTES / 2)}a`)])).toBeUndefined();
    const full = page('a'.repeat(TEXT_MAX_PAGE_BYTES));
    expect(asPages(Array.from({ length: 64 }, () => full))).toHaveLength(64);
    expect(asPages([...Array.from({ length: 64 }, () => full), page('a')])).toBeUndefined();
    expect(asPages([page('a\u0000b')])).toBeUndefined();
    expect(asPages([page('a', '\u0000')])).toBeUndefined();
  });
});

describe('the text request', () => {
  it('is a gate frame of kind "text": the copy, its sha256 and what the audience withholds, and nothing else', () => {
    const frame = framed(encodeTextRequest({ copy: COPY, sha256: SHA, quotes: ['Kestrel Ambry'] }));
    expect(frame.header).toEqual({ v: PROTOCOL_VERSION, kind: 'text', sha256: SHA, quotes: ['Kestrel Ambry'] });
    expect(isTextFrame(frame)).toBe(true);
    const request = decodeTextRequest(frame);
    expect({ ...request, copy: [...request.copy] }).toEqual({ copy: [...COPY], sha256: SHA, quotes: ['Kestrel Ambry'] });
    expect(encodeTextRequest({ copy: COPY, sha256: SHA, quotes: [] }).subarray(0, 4)).toEqual(GATE_REQUEST_MAGIC);
  });

  it('is not taken for a check, nor a check for it', () => {
    const text = framed(encodeTextRequest({ copy: COPY, sha256: SHA, quotes: [] }));
    expect(() => decodeGateRequest(text)).toThrow(FrameError);
    const check = framed(encodeGateRequest({ copy: COPY, original: Uint8Array.from([9]), quotes: [], image: 'show', sha256: SHA, originalSha256: sha256Hex(Uint8Array.from([9])) }));
    expect(isTextFrame(check)).toBe(false);
    expect(() => decodeTextRequest(check)).toThrow(FrameError);
    for (const header of [null, [], 'text', { kind: 'check' }]) expect(isTextFrame({ header, body: Buffer.alloc(1) })).toBe(false);
  });

  it('is refused before it is sent when the copy is empty or over the cap, the hash is none, or the quotes are over theirs', () => {
    expect(() => encodeTextRequest({ copy: new Uint8Array(0), sha256: SHA, quotes: [] })).toThrow('outside the gate input cap');
    expect(() => encodeTextRequest({ copy: new Uint8Array(MAX_OUTPUT_BYTES + 1), sha256: SHA, quotes: [] })).toThrow('outside the gate input cap');
    expect(() => encodeTextRequest({ copy: COPY, sha256: 'abc', quotes: [] })).toThrow('not a sha256');
    expect(() => encodeTextRequest({ copy: COPY, sha256: SHA, quotes: Array.from({ length: MAX_QUOTES + 1 }, () => 'q') })).toThrow(FrameError);
  });

  it('is malformed with another version, a key more or less, a bad hash, bad quotes, or no copy', () => {
    const good = { v: PROTOCOL_VERSION, kind: 'text', sha256: SHA, quotes: [] as unknown };
    const body = Buffer.from(COPY);
    expect(decodeTextRequest({ header: good, body }).sha256).toBe(SHA);
    for (const header of [{ ...good, v: PROTOCOL_VERSION - 1 }, { ...good, env: 'x' }, { v: PROTOCOL_VERSION, kind: 'text', sha256: SHA }, { ...good, sha256: 'no' }, { ...good, quotes: [1] }, { ...good, quotes: 'q' }, null]) {
      expect(() => decodeTextRequest({ header, body }), JSON.stringify(header)).toThrow(FrameError);
    }
    expect(() => decodeTextRequest({ header: good, body: Buffer.alloc(0) })).toThrow('the copy');
  });
});

describe('the text reply', () => {
  it('carries the pages as its body and the copy\'s sha256, and reads back the same', () => {
    const pages = [page('Picnic at noon. Bring a chair.', ''), page('The well known speaker', 'well-known'), page('naïve café — “quoted” \\ "x"')];
    const bytes = encodeTextReply({ sha256: SHA, pages });
    expect(bytes.subarray(0, 4)).toEqual(GATE_REPLY_MAGIC);
    const frame = framed(bytes);
    expect(frame.header).toEqual({ v: PROTOCOL_VERSION, verdict: 'text', sha256: SHA, pages: 3 });
    expect(bytes.readUInt32BE(4)).toBeLessThanOrEqual(MAX_GATE_REPLY_HEADER_BYTES);
    expect(decodeTextReply(frame)).toEqual({ sha256: SHA, pages });
  });

  it('carries a refusal by its code alone, with no body', () => {
    for (const code of TEXT_CODES) {
      const frame = framed(encodeTextReply({ sha256: SHA, code }));
      expect(frame.header).toEqual({ v: PROTOCOL_VERSION, verdict: 'no-text', code, sha256: SHA });
      expect(frame.body).toHaveLength(0);
      expect(decodeTextReply(frame)).toEqual({ sha256: SHA, code });
    }
  });

  it('says "over-cap", never the text, for pages over a cap or a body over the reply\'s', () => {
    expect(framed(encodeTextReply({ sha256: SHA, pages: [page('a'.repeat(TEXT_MAX_PAGE_BYTES + 1))] })).header).toMatchObject({ verdict: 'no-text', code: 'over-cap' });
    expect(framed(encodeTextReply({ sha256: SHA, pages: [] })).header).toMatchObject({ verdict: 'no-text', code: 'over-cap' });
    // Within the text caps, but every character is six bytes of JSON: the body would pass the reply's cap.
    const escaped = Array.from({ length: 64 }, () => page('\u0001'.repeat(TEXT_MAX_PAGE_BYTES)));
    expect(asPages(escaped)).toHaveLength(64);
    const reply = encodeTextReply({ sha256: SHA, pages: escaped });
    expect(framed(reply).header).toMatchObject({ verdict: 'no-text', code: 'over-cap' });
    expect(reply.length).toBeLessThan(1024);
  });

  it('is malformed as anything else: a check\'s verdict, pages over a cap, a wrong count, a body that is no JSON, a code it does not know', () => {
    const body = Buffer.from(JSON.stringify([['one', '']]), 'utf8');
    const good = { v: PROTOCOL_VERSION, verdict: 'text', sha256: SHA, pages: 1 };
    expect(decodeTextReply({ header: good, body })).toEqual({ sha256: SHA, pages: [page('one')] });
    const bad: Array<[unknown, Buffer]> = [
      [{ ...good, v: 2 }, body],
      [{ ...good, pages: 2 }, body],
      [{ ...good, more: 1 }, body],
      [{ ...good, sha256: 'x' }, body],
      [good, Buffer.from('not json')],
      [good, Buffer.from(JSON.stringify([['one']]))],
      [good, Buffer.from(JSON.stringify([['one', '', 'x']]))],
      [good, Buffer.from(JSON.stringify({ 0: ['one', ''] }))],
      [good, Buffer.from(JSON.stringify([['a'.repeat(TEXT_MAX_PAGE_BYTES + 1), '']]))],
      [good, Buffer.from([0x5b, 0x5b, 0x22, 0xff, 0x22, 0x2c, 0x22, 0x22, 0x5d, 0x5d])],
      [good, Buffer.alloc(0)],
      [{ v: PROTOCOL_VERSION, verdict: 'no-text', code: 'rules', sha256: SHA }, Buffer.alloc(0)],
      [{ v: PROTOCOL_VERSION, verdict: 'no-text', code: 'unfinished', sha256: SHA }, Buffer.from('x')],
      [{ v: PROTOCOL_VERSION, verdict: 'pass', sha256: SHA, checkedSha256: SHA }, Buffer.from('x')],
      [{ v: PROTOCOL_VERSION, verdict: 'refused', code: 'unfinished', sha256: SHA }, Buffer.alloc(0)],
      [null, body],
    ];
    for (const [header, bytes] of bad) expect(() => decodeTextReply({ header, body: bytes }), JSON.stringify(header)).toThrow(FrameError);
    expect(() => decodeTextReply(framed(encodeFrame(GATE_REPLY_MAGIC, good, body)))).not.toThrow();
  });
});
