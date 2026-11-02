// ============================================================================
// UNTRUSTED-PDF-GATE: the wire between the worker and the engine sidecar
// (sidecar.ts, socket-engine.ts), one unix-socket connection per copy.
//
//   frame   = magic (4) | header length (u32 BE) | body length (u32 BE) | header | body
//   request = "NWQ1", header {v: 1, quotes, redactsAny, image?}, body the original
//   reply   = "NWA1", header {v: 1, kind, reason? | message?}, body the copy or nothing
//
// Each side reads the 12-byte prefix first and stops there if a declared size is
// over its cap, so a peer's framing is never trusted beyond the caps. A header
// must be exactly the typed request or result, so nothing else (an environment,
// a path, a credential) can ride along; anything else is a malformed frame, and
// a malformed frame gets no answer. The redaction boxes stay in the sidecar:
// nothing downstream reads them, and the copy is what is checked again.
// ============================================================================
import type { Duplex, Readable } from 'node:stream';
import type { ImageAction } from './images.js';
import type { EngineMessage } from './isolated.js';
import type { RedactRequest, RedactResult } from './redact.js';

/** The largest original: what pdf_original holds (0015). */
export const MAX_INPUT_BYTES = 10 * 1024 * 1024;
/** The largest copy: what pdf_copy holds (0015). */
export const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
export const MAX_REQUEST_HEADER_BYTES = 1024 * 1024;
export const MAX_REPLY_HEADER_BYTES = 16 * 1024;
export const MAX_QUOTES = 4096;
/** A mark's quote is at most 500 characters (0014); room to spare. */
export const MAX_QUOTE_CHARS = 2000;
/** A refusal's reason or a failure's message, in characters. */
export const MAX_TEXT_CHARS = 1000;
export const REQUEST_MAGIC = Buffer.from('NWQ1', 'latin1');
export const REPLY_MAGIC = Buffer.from('NWA1', 'latin1');
export const PREFIX_BYTES = 12;

const VERSION = 1;
const IMAGE_ACTIONS: readonly ImageAction[] = ['show', 'blur', 'hide'];
const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** A frame that is malformed, over a cap, cut short or late. Its message says which, never what it held. */
export class FrameError extends Error {
  override readonly name = 'FrameError';
}

export interface Frame {
  header: unknown;
  body: Buffer;
}

/** What the sidecar answers: the engine's result, or why the engine gave none. */
export type SidecarReply = RedactResult | { kind: 'failed'; message: string };

export function encodeFrame(magic: Buffer, header: unknown, body: Uint8Array = new Uint8Array(0)): Buffer {
  const head = Buffer.from(JSON.stringify(header), 'utf8');
  const prefix = Buffer.alloc(PREFIX_BYTES);
  magic.copy(prefix, 0);
  prefix.writeUInt32BE(head.length, 4);
  prefix.writeUInt32BE(body.byteLength, 8);
  return Buffer.concat([prefix, head, body]);
}

/**
 * Reads one frame. Stops at the prefix when a declared size is over its cap, and on any byte past the
 * frame. With `untilEnd`, answers only once the stream ends (a reply is the sidecar's last word);
 * without, as soon as the frame is whole (the sidecar keeps watching the connection itself).
 */
export function readFrame(
  stream: Readable | Duplex,
  limits: { magic: Buffer; maxHeader: number; maxBody: number; timeoutMs?: number; untilEnd?: boolean },
): Promise<Frame> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let expected: number | undefined;
    let headerLength = 0;
    const timer = limits.timeoutMs === undefined ? undefined : setTimeout(() => fail(`the frame took longer than ${limits.timeoutMs} ms`), limits.timeoutMs);

    // Every path out detaches every listener and the timer first, so the promise settles once.
    function detach(): void {
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
      stream.off('close', onClose);
    }
    function fail(reason: string): void {
      detach();
      reject(new FrameError(reason));
    }
    function finish(): void {
      const all = Buffer.concat(chunks);
      let header: unknown;
      try {
        header = JSON.parse(UTF8.decode(all.subarray(PREFIX_BYTES, PREFIX_BYTES + headerLength)));
      } catch {
        fail('the header is not JSON');
        return;
      }
      detach();
      resolve({ header, body: all.subarray(PREFIX_BYTES + headerLength) });
    }
    function onData(chunk: Buffer): void {
      received += chunk.length;
      chunks.push(chunk);
      if (expected === undefined && received >= PREFIX_BYTES) {
        const head = Buffer.concat(chunks);
        if (!head.subarray(0, 4).equals(limits.magic)) return fail('not a frame');
        headerLength = head.readUInt32BE(4);
        const bodyLength = head.readUInt32BE(8);
        if (headerLength > limits.maxHeader) return fail('the header is over its cap');
        if (bodyLength > limits.maxBody) return fail('the body is over its cap');
        expected = PREFIX_BYTES + headerLength + bodyLength;
      }
      if (expected === undefined) return;
      if (received > expected) return fail('bytes after the frame');
      if (received === expected && limits.untilEnd !== true) finish();
    }
    function onEnd(): void {
      if (received !== expected) fail('the frame was cut short');
      else finish();
    }
    function onError(error: NodeJS.ErrnoException): void {
      fail(`the connection failed (${error.code ?? error.message})`);
    }
    function onClose(): void {
      fail('the frame was cut short');
    }
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
    stream.on('close', onClose);
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasKeys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean =>
  required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const validQuotes = (quotes: unknown): quotes is string[] =>
  Array.isArray(quotes) && quotes.length <= MAX_QUOTES && quotes.every((quote) => typeof quote === 'string' && quote.length <= MAX_QUOTE_CHARS);

/** The worker's request, as a frame; throws a FrameError over any cap, before anything is sent. */
export function encodeRequest(original: Uint8Array, request: RedactRequest): Buffer {
  if (original.byteLength === 0 || original.byteLength > MAX_INPUT_BYTES) throw new FrameError('the original is outside the engine input cap');
  if (request.quotes.length > MAX_QUOTES) throw new FrameError('too many quotes');
  if (!validQuotes([...request.quotes])) throw new FrameError('a quote is over its cap');
  const header = { v: VERSION, quotes: [...request.quotes], redactsAny: request.redactsAny, ...(request.image === undefined ? {} : { image: request.image }) };
  const frame = encodeFrame(REQUEST_MAGIC, header, original);
  if (frame.readUInt32BE(4) > MAX_REQUEST_HEADER_BYTES) throw new FrameError('the request header is over its cap');
  return frame;
}

/** The sidecar's reading of a request frame: exactly the typed request and an original, or a FrameError. */
export function decodeRequest(frame: Frame): EngineMessage {
  const { header, body } = frame;
  if (!isRecord(header) || !hasKeys(header, ['v', 'quotes', 'redactsAny'], ['image'])) throw new FrameError('the request header is not a request');
  if (header['v'] !== VERSION) throw new FrameError('the request is of another version');
  if (!validQuotes(header['quotes'])) throw new FrameError('the quotes are not a list of text within the caps');
  if (typeof header['redactsAny'] !== 'boolean') throw new FrameError('redactsAny is not a boolean');
  const image = header['image'];
  if (image !== undefined && !IMAGE_ACTIONS.includes(image as ImageAction)) throw new FrameError('the image action is not one the engine knows');
  if (body.length === 0) throw new FrameError('the request carries no original');
  const request: RedactRequest = { quotes: header['quotes'], redactsAny: header['redactsAny'], ...(image === undefined ? {} : { image: image as ImageAction }) };
  return { original: new Uint8Array(body.buffer, body.byteOffset, body.byteLength), request };
}

/** The sidecar's answer, as a frame: no copy outside the output cap, and text cut to its cap. */
export function encodeReply(reply: SidecarReply): Buffer {
  const text = (value: string): string => value.slice(0, MAX_TEXT_CHARS);
  switch (reply.kind) {
    case 'redacted':
      if (reply.pdf.byteLength === 0 || reply.pdf.byteLength > MAX_OUTPUT_BYTES) return encodeReply({ kind: 'failed', message: 'the copy is outside the engine output cap' });
      return encodeFrame(REPLY_MAGIC, { v: VERSION, kind: 'redacted' }, reply.pdf);
    case 'original':
      return encodeFrame(REPLY_MAGIC, { v: VERSION, kind: 'original' });
    case 'refused':
      return encodeFrame(REPLY_MAGIC, { v: VERSION, kind: 'refused', reason: reply.reason === '' ? 'the engine refused without a reason' : text(reply.reason) });
    case 'failed':
      return encodeFrame(REPLY_MAGIC, { v: VERSION, kind: 'failed', message: text(reply.message) });
  }
}

/** The worker's reading of a reply frame: exactly one typed result, or a FrameError. */
export function decodeReply(frame: Frame): SidecarReply {
  const { header, body } = frame;
  if (!isRecord(header) || header['v'] !== VERSION) throw new FrameError('the reply header is not a reply');
  const empty = body.length === 0;
  const text = (value: unknown, min: number): value is string => typeof value === 'string' && value.length >= min && value.length <= MAX_TEXT_CHARS;
  switch (header['kind']) {
    case 'redacted':
      if (hasKeys(header, ['v', 'kind']) && !empty) return { kind: 'redacted', pdf: new Uint8Array(body.buffer, body.byteOffset, body.byteLength), boxes: [] };
      break;
    case 'original':
      if (hasKeys(header, ['v', 'kind']) && empty) return { kind: 'original' };
      break;
    case 'refused':
      if (hasKeys(header, ['v', 'kind', 'reason']) && empty && text(header['reason'], 1)) return { kind: 'refused', reason: header['reason'] };
      break;
    case 'failed':
      if (hasKeys(header, ['v', 'kind', 'message']) && empty && text(header['message'], 0)) return { kind: 'failed', message: header['message'] };
      break;
  }
  throw new FrameError('the reply is not a result the worker knows');
}
