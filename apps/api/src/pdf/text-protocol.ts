// ============================================================================
// ARCHIVE-SEARCH S2: the gate's second request, "text".
//
// The search index holds the text of the copy an audience is served
// (search/pages.ts). Reading a PDF's text means parsing it, and the worker
// parses nothing: the copy goes to the gate (the sidecar, or the worker's
// capped child in the pre-sidecar mode), whose child reads its pages with
// pdf.js, as it does for a check, and answers their text (gate-text.ts).
//
// On the gate's socket and in its frames (engine-protocol.ts), told from a
// check by its header alone:
//
//   text request = "NGQ1", header {v: 3, kind: "text", sha256, quotes}, body the copy
//   text reply   = "NGA1", header {v: 3, verdict: "text", sha256, pages: n},
//                  body a JSON list of n [text, extra] pairs; or
//                  header {v: 3, verdict: "no-text", code, sha256}, no body
//
// A check's frames are as they were, byte for byte, so PROTOCOL_VERSION stays
// 3: a gate that does not know "text" takes the request for a malformed check
// and gives no answer, which the worker hears as a reading that failed.
//
// `quotes` is what the copy's audience withholds. The gate passed the copy
// for them when it was made; the reading looks again and gives no text at all
// ("withheld") for a copy in which it finds one, so a fault upstream cannot
// put a withheld passage into an index. The caps are the index's (0032): 300
// pages, 64 KiB a page and an extra, 4 MiB in all; over one, "over-cap" and no
// text. The codes say why there is none, never what the copy holds.
// ============================================================================
import type { PageText } from '../search/text.js';
import { type Frame, FrameError, GATE_REPLY_MAGIC, GATE_REQUEST_MAGIC, MAX_OUTPUT_BYTES, MAX_QUOTES, MAX_QUOTE_CHARS, MAX_REQUEST_HEADER_BYTES, PROTOCOL_VERSION, encodeFrame } from './engine-protocol.js';

export const TEXT_MAX_PAGES = 300;
/** Of UTF-8, for a page's text and again for its extra: what a row holds (0032). */
export const TEXT_MAX_PAGE_BYTES = 64 * 1024;
/** Of UTF-8, every page's text and extra together: what search_page_put takes (0032). */
export const TEXT_MAX_BYTES = 4 * 1024 * 1024;
/** The reply's body, as JSON: the text cap twice over, for what JSON escapes. Past it, "over-cap". */
export const MAX_TEXT_REPLY_BYTES = 2 * TEXT_MAX_BYTES + 64 * 1024;

/**
 * Why a reading gave no text: the copy still holds a passage its audience withholds; it is over a cap; the child
 * crashed, ran out of time or memory, or could not read it; or the bytes are not the ones named.
 */
export type TextCode = 'withheld' | 'over-cap' | 'unfinished' | 'mismatch';
export const TEXT_CODES: readonly TextCode[] = ['withheld', 'over-cap', 'unfinished', 'mismatch'];

/** What the worker asks: the copy with its sha256, and what its audience withholds. */
export interface TextRequest {
  copy: Uint8Array;
  sha256: string;
  quotes: readonly string[];
}

/** What a reading answers: the sha256 of the copy it was sent and the text of its pages, or why there is none. */
export type TextReply = { sha256: string; pages: PageText[] } | { sha256: string; code: TextCode };

const UTF8 = new TextDecoder('utf-8', { fatal: true });
const SHA256 = /^[0-9a-f]{64}$/;
const isHash = (value: unknown): value is string => typeof value === 'string' && SHA256.test(value);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasExactly = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const validQuotes = (quotes: unknown): quotes is string[] =>
  Array.isArray(quotes) && quotes.length <= MAX_QUOTES && quotes.every((quote) => typeof quote === 'string' && quote.length <= MAX_QUOTE_CHARS);
const bytesOf = (value: string): number => Buffer.byteLength(value, 'utf8');

/**
 * `value`, if it is exactly 1 to 300 pages of text and extra within the caps, with no NUL (Postgres holds none in
 * text); else undefined. Every side that takes pages from another process takes them through this.
 */
export function asPages(value: unknown): PageText[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > TEXT_MAX_PAGES) return undefined;
  let total = 0;
  const pages: PageText[] = [];
  for (const page of value as unknown[]) {
    if (!isRecord(page) || !hasExactly(page, ['text', 'extra'])) return undefined;
    const { text, extra } = page;
    if (typeof text !== 'string' || typeof extra !== 'string' || text.includes('\u0000') || extra.includes('\u0000')) return undefined;
    const [textBytes, extraBytes] = [bytesOf(text), bytesOf(extra)];
    total += textBytes + extraBytes;
    if (textBytes > TEXT_MAX_PAGE_BYTES || extraBytes > TEXT_MAX_PAGE_BYTES || total > TEXT_MAX_BYTES) return undefined;
    pages.push({ text, extra });
  }
  return pages;
}

/** A child's message, if it is exactly a text reply within the caps (gate-isolated.ts isolatedText); else undefined. */
export function asTextReply(message: unknown): TextReply | undefined {
  if (!isRecord(message) || !isHash(message['sha256'])) return undefined;
  const { sha256 } = message;
  if (hasExactly(message, ['sha256', 'pages'])) {
    const pages = asPages(message['pages']);
    return pages === undefined ? undefined : { sha256, pages };
  }
  if (hasExactly(message, ['sha256', 'code']) && TEXT_CODES.includes(message['code'] as TextCode)) return { sha256, code: message['code'] as TextCode };
  return undefined;
}

/** Whether a gate request frame asks for text: its header says so. Anything else is a check's to read. */
export function isTextFrame(frame: Frame): boolean {
  return isRecord(frame.header) && frame.header['kind'] === 'text';
}

/** The worker's text request, as a frame; throws a FrameError over any cap, before anything is sent. */
export function encodeTextRequest(request: TextRequest): Buffer {
  const { copy } = request;
  if (copy.byteLength === 0 || copy.byteLength > MAX_OUTPUT_BYTES) throw new FrameError('the copy is outside the gate input cap');
  if (!isHash(request.sha256)) throw new FrameError('the hash is not a sha256');
  if (!validQuotes([...request.quotes])) throw new FrameError('the quotes are over a cap');
  const frame = encodeFrame(GATE_REQUEST_MAGIC, { v: PROTOCOL_VERSION, kind: 'text', sha256: request.sha256, quotes: [...request.quotes] }, copy);
  if (frame.readUInt32BE(4) > MAX_REQUEST_HEADER_BYTES) throw new FrameError('the request header is over its cap');
  return frame;
}

/** The gate's reading of a text request frame: exactly the typed request, or a FrameError. */
export function decodeTextRequest(frame: Frame): TextRequest {
  const { header, body } = frame;
  if (!isRecord(header) || !hasExactly(header, ['v', 'kind', 'sha256', 'quotes']) || header['kind'] !== 'text') throw new FrameError('the text request header is not a text request');
  if (header['v'] !== PROTOCOL_VERSION) throw new FrameError('the text request is of another version');
  if (!isHash(header['sha256'])) throw new FrameError('the hash is not a sha256');
  if (!validQuotes(header['quotes'])) throw new FrameError('the quotes are not a list of text within the caps');
  if (body.length === 0 || body.length > MAX_OUTPUT_BYTES) throw new FrameError('the copy is outside the gate input cap');
  return { copy: new Uint8Array(body.buffer, body.byteOffset, body.length), sha256: header['sha256'], quotes: header['quotes'] };
}

/**
 * The gate's answer to a text request, as a frame. Pages over a cap, or whose JSON is over the reply's, go as
 * "over-cap": never a frame the worker would have to refuse, and never a part of the text.
 */
export function encodeTextReply(reply: TextReply): Buffer {
  const refused = (code: TextCode): Buffer => encodeFrame(GATE_REPLY_MAGIC, { v: PROTOCOL_VERSION, verdict: 'no-text', code, sha256: reply.sha256 });
  if ('code' in reply) return refused(reply.code);
  const pages = asPages(reply.pages);
  if (pages === undefined) return refused('over-cap');
  const body = Buffer.from(JSON.stringify(pages.map((page) => [page.text, page.extra])), 'utf8');
  if (body.length > MAX_TEXT_REPLY_BYTES) return refused('over-cap');
  return encodeFrame(GATE_REPLY_MAGIC, { v: PROTOCOL_VERSION, verdict: 'text', sha256: reply.sha256, pages: pages.length }, body);
}

/** The body of a text reply as pages, or undefined: valid UTF-8, a JSON list of [text, extra] pairs, within the caps. */
function bodyPages(body: Buffer): PageText[] | undefined {
  let listed: unknown;
  try {
    listed = JSON.parse(UTF8.decode(body));
  } catch {
    return undefined;
  }
  if (!Array.isArray(listed)) return undefined;
  return asPages((listed as unknown[]).map((pair) => (Array.isArray(pair) && pair.length === 2 ? { text: pair[0] as unknown, extra: pair[1] as unknown } : null)));
}

/** The worker's reading of a text reply frame: exactly one typed reply, or a FrameError. A check's verdict is none. */
export function decodeTextReply(frame: Frame): TextReply {
  const { header, body } = frame;
  if (isRecord(header) && header['v'] === PROTOCOL_VERSION && isHash(header['sha256'])) {
    if (header['verdict'] === 'text' && hasExactly(header, ['v', 'verdict', 'sha256', 'pages']) && body.length > 0 && body.length <= MAX_TEXT_REPLY_BYTES) {
      const pages = bodyPages(body);
      if (pages !== undefined && pages.length === header['pages']) return { sha256: header['sha256'], pages };
    }
    if (header['verdict'] === 'no-text' && body.length === 0 && hasExactly(header, ['v', 'verdict', 'code', 'sha256']) && TEXT_CODES.includes(header['code'] as TextCode)) {
      return { sha256: header['sha256'], code: header['code'] as TextCode };
    }
  }
  throw new FrameError('the reply is not a text reply the worker knows');
}
