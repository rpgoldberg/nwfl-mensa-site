// ============================================================================
// UNTRUSTED-PDF-GATE: the wire between the worker and its two sidecars, one
// unix-socket connection per copy or check: the engine (sidecar.ts,
// socket-engine.ts) and the output gate (gate-service.ts, socket-gate.ts).
//
//   frame   = magic (4) | header length (u32 BE) | body length (u32 BE) | header | body
//   engine request = "NWQ1", header {v: 3, quotes, redactsAny, image?, origin?, links, membersWithhold},
//                    body the original
//   engine reply   = "NWA1", header {v: 3, kind, kept? | reason? | message?}, body the copy or nothing
//   gate request   = "NGQ1", header {v: 3, quotes, image, sha256, originalSha256, copyBytes, origin?,
//                    links, kept}, body the copy then the original (for its pictures, gate-rules.ts)
//   gate reply     = "NGA1", header {v: 3, verdict: "refused", code, sha256}, no body; or
//                    header {v: 3, verdict: "pass", sha256, checkedSha256}, body the bytes the
//                    gate checked: its own writing of the copy, the only bytes that may be stored
//                    (fix round 3, M1). sha256 names the copy the gate was sent.
//
// Each side reads the 12-byte prefix first and stops there if a declared size is
// over its cap, so a peer's framing is never trusted beyond the caps. A header
// must be exactly the typed request or result, so nothing else (an environment,
// a path, a credential) can ride along; anything else is a malformed frame, and
// a malformed frame gets no answer. The redaction boxes stay in the sidecar:
// nothing downstream reads them, and the copy is what is checked again.
//
// Version 2 (LINKS L3): the links a copy may carry (link-annots.ts), each by
// id, page, rect and label, never its target, with the origin they point to;
// the engine's copy names the ids it kept, and the gate is given all three
// and checks the copy holds exactly those (gate-rules.ts). At most MAX_LINKS
// links, each id once; a kept id is one the request holds.
//
// Version 3 (BOXLABEL): the engine request says, for each quote, whether
// members withhold it too (membersWithhold, one boolean per quote, in the
// quotes' order), so the engine labels its boxes "Private" or "Members Only"
// (labels.ts). Booleans only: the flags add no text to any request, so the
// public's request holds the public's quotes alone and the members' theirs.
// The gate is given nothing new: it takes exactly the three labels inside
// boxes (gate-labels.ts), whichever the engine chose. A frame of version 1 or
// 2 is malformed.
// ============================================================================
import { createHash } from 'node:crypto';
import type { Duplex, Readable } from 'node:stream';
import type { ImageAction } from './images.js';
import type { EngineMessage } from './isolated.js';
import { type EngineLink, MAX_LINKS, linksBreak } from './link-annots.js';
import { LINK_ID } from '../load/links.js';
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
/** An idle connection: a peer that has not begun a frame within this is dropped (fix round 1, NOTE). */
export const FIRST_BYTES_TIMEOUT_MS = 5_000;
export const GATE_REQUEST_MAGIC = Buffer.from('NGQ1', 'latin1');
export const GATE_REPLY_MAGIC = Buffer.from('NGA1', 'latin1');
/** A gate request carries a copy and its original. */
export const MAX_GATE_BODY_BYTES = MAX_OUTPUT_BYTES + MAX_INPUT_BYTES;
export const MAX_GATE_REPLY_HEADER_BYTES = 1024;
export { MAX_LINKS };

/** The wire's version: 2 from LINKS L3 (the links, the origin and the kept ids), 3 from BOXLABEL (what members withhold). */
export const PROTOCOL_VERSION = 3;
const VERSION = PROTOCOL_VERSION;
const IMAGE_ACTIONS: readonly ImageAction[] = ['show', 'blur', 'hide'];
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const SHA256 = /^[0-9a-f]{64}$/;

/** A byte string's sha256, in lower-case hex. */
export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/**
 * Why the gate gave no pass: `withheld`, withheld text found (or a part it cannot read); `rules`, the
 * copy breaks the sanitizer's rules or keeps a picture its policy changes (gate-rules.ts);
 * `unfinished`, the check crashed, ran out of memory or time; `mismatch`, the bytes are not the ones named.
 */
export type GateCode = 'withheld' | 'rules' | 'unfinished' | 'mismatch';
export const GATE_CODES: readonly GateCode[] = ['withheld', 'rules', 'unfinished', 'mismatch'];
export type GateVerdict = { pass: true } | { pass: false; code: GateCode };

/** What the worker asks the gate: the copy and its original, each with its sha256, and what this audience withholds. */
export interface GateRequest {
  copy: Uint8Array;
  original: Uint8Array;
  quotes: string[];
  image: ImageAction;
  sha256: string;
  originalSha256: string;
  /** What the links point to; set whenever there are links. */
  origin?: string;
  /** The links the engine was given (none when absent). */
  links?: readonly EngineLink[];
  /** The ids the engine says its copy holds (none when absent). */
  kept?: readonly string[];
}

/** The bytes a gate passed: its own writing of the copy (gate-rules.ts gateReply), the only bytes that may be stored, and their sha256. */
export interface CheckedCopy {
  pdf: Uint8Array;
  sha256: string;
}

/** What the gate answers: its verdict, the sha256 of the copy it was sent, and on a pass the bytes it checked (fix round 3, M1). */
export interface GateReply {
  verdict: GateVerdict;
  sha256: string;
  checked?: CheckedCopy;
}

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
  limits: { magic: Buffer; maxHeader: number; maxBody: number; timeoutMs?: number; firstBytesTimeoutMs?: number; untilEnd?: boolean },
): Promise<Frame> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let expected: number | undefined;
    let headerLength = 0;
    const timer = limits.timeoutMs === undefined ? undefined : setTimeout(() => fail(`the frame took longer than ${limits.timeoutMs} ms`), limits.timeoutMs);
    // Until the 12-byte prefix is in; an idle connection holds a slot for no longer than this.
    let begun = limits.firstBytesTimeoutMs === undefined ? undefined : setTimeout(() => fail(`no frame began within ${limits.firstBytesTimeoutMs} ms`), limits.firstBytesTimeoutMs);

    // Every path out detaches every listener and the timers first, so the promise settles once.
    function detach(): void {
      clearTimeout(timer);
      clearTimeout(begun);
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
        clearTimeout(begun);
        begun = undefined;
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
const isHash = (value: unknown): value is string => typeof value === 'string' && SHA256.test(value);

/** Why a list of kept ids is not one (at most MAX_LINKS ids, each once, each one of `given` when that is known), or null. */
function keptBreak(kept: unknown, given?: ReadonlySet<string>): string | null {
  if (!Array.isArray(kept) || kept.length > MAX_LINKS) return 'the kept links are not a list within the cap';
  if (!kept.every((id) => typeof id === 'string' && LINK_ID.test(id)) || new Set(kept).size !== kept.length) return 'the kept links are not distinct link ids';
  if (given !== undefined && kept.some((id) => !given.has(id as string))) return 'a kept link is not one of the links given';
  return null;
}

/** Throws a FrameError for links (with their origin) that break the caps (link-annots.ts linksBreak). */
function checkLinks(links: unknown, origin: unknown): void {
  const broken = linksBreak(links, origin);
  if (broken !== null) throw new FrameError(broken);
}

const FLAGS = 'what members withhold is not one boolean per quote';
/** Whether `flags` is one boolean per quote. */
const validFlags = (flags: unknown, quotes: readonly unknown[]): flags is boolean[] => Array.isArray(flags) && flags.length === quotes.length && flags.every((flag) => typeof flag === 'boolean');

/** Throws a FrameError for quotes over a cap. */
function checkQuotes(quotes: readonly string[]): void {
  if (quotes.length > MAX_QUOTES) throw new FrameError('too many quotes');
  if (!validQuotes([...quotes])) throw new FrameError('a quote is over its cap');
}

/** A frame whose header is within the request header cap, or a FrameError. */
function requestFrame(magic: Buffer, header: unknown, body: Uint8Array): Buffer {
  const frame = encodeFrame(magic, header, body);
  if (frame.readUInt32BE(4) > MAX_REQUEST_HEADER_BYTES) throw new FrameError('the request header is over its cap');
  return frame;
}

/** The worker's request, as a frame; throws a FrameError over any cap, before anything is sent. */
export function encodeRequest(original: Uint8Array, request: RedactRequest): Buffer {
  if (original.byteLength === 0 || original.byteLength > MAX_INPUT_BYTES) throw new FrameError('the original is outside the engine input cap');
  checkQuotes(request.quotes);
  // Every quote when the request names none: every box "Private" (redact.ts).
  const membersWithhold = request.membersWithhold === undefined ? request.quotes.map(() => true) : [...request.membersWithhold];
  if (!validFlags(membersWithhold, request.quotes)) throw new FrameError(FLAGS);
  const links = [...(request.links ?? [])];
  checkLinks(links, request.origin);
  const header = {
    v: VERSION,
    quotes: [...request.quotes],
    redactsAny: request.redactsAny,
    ...(request.image === undefined ? {} : { image: request.image }),
    ...(request.origin === undefined ? {} : { origin: request.origin }),
    links,
    membersWithhold,
  };
  return requestFrame(REQUEST_MAGIC, header, original);
}

/** The sidecar's reading of a request frame: exactly the typed request and an original, or a FrameError. */
export function decodeRequest(frame: Frame): EngineMessage {
  const { header, body } = frame;
  if (!isRecord(header)) throw new FrameError('the request header is not a request');
  if (header['v'] !== VERSION) throw new FrameError('the request is of another version');
  if (!hasKeys(header, ['v', 'quotes', 'redactsAny', 'links', 'membersWithhold'], ['image', 'origin'])) throw new FrameError('the request header is not a request');
  if (!validQuotes(header['quotes'])) throw new FrameError('the quotes are not a list of text within the caps');
  if (!validFlags(header['membersWithhold'], header['quotes'])) throw new FrameError(FLAGS);
  if (typeof header['redactsAny'] !== 'boolean') throw new FrameError('redactsAny is not a boolean');
  const image = header['image'];
  if (image !== undefined && !IMAGE_ACTIONS.includes(image as ImageAction)) throw new FrameError('the image action is not one the engine knows');
  checkLinks(header['links'], header['origin']);
  if (body.length === 0) throw new FrameError('the request carries no original');
  const origin = header['origin'] as string | undefined;
  const request: RedactRequest = {
    quotes: header['quotes'],
    redactsAny: header['redactsAny'],
    ...(image === undefined ? {} : { image: image as ImageAction }),
    ...(origin === undefined ? {} : { origin }),
    links: header['links'] as EngineLink[],
    membersWithhold: header['membersWithhold'],
  };
  return { original: new Uint8Array(body.buffer, body.byteOffset, body.byteLength), request };
}

/** The sidecar's answer, as a frame: no copy outside the output cap, and text cut to its cap. */
export function encodeReply(reply: SidecarReply): Buffer {
  const text = (value: string): string => value.slice(0, MAX_TEXT_CHARS);
  switch (reply.kind) {
    case 'redacted':
      if (reply.pdf.byteLength === 0 || reply.pdf.byteLength > MAX_OUTPUT_BYTES) return encodeReply({ kind: 'failed', message: 'the copy is outside the engine output cap' });
      if (keptBreak(reply.kept ?? []) !== null) return encodeReply({ kind: 'failed', message: 'the engine kept links that are not distinct link ids' });
      return encodeFrame(REPLY_MAGIC, { v: VERSION, kind: 'redacted', kept: [...(reply.kept ?? [])] }, reply.pdf);
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
      if (hasKeys(header, ['v', 'kind', 'kept']) && !empty && keptBreak(header['kept']) === null) {
        return { kind: 'redacted', pdf: new Uint8Array(body.buffer, body.byteOffset, body.byteLength), boxes: [], kept: header['kept'] as string[] };
      }
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

/** The worker's request to the gate, as a frame; throws a FrameError over any cap, before anything is sent. */
export function encodeGateRequest(request: GateRequest): Buffer {
  const { copy, original } = request;
  if (copy.byteLength === 0 || copy.byteLength > MAX_OUTPUT_BYTES) throw new FrameError('the copy is outside the gate input cap');
  if (original.byteLength === 0 || original.byteLength > MAX_INPUT_BYTES) throw new FrameError('the original is outside the gate input cap');
  checkQuotes(request.quotes);
  if (!isHash(request.sha256) || !isHash(request.originalSha256)) throw new FrameError('a hash is not a sha256');
  const links = [...(request.links ?? [])];
  const kept = [...(request.kept ?? [])];
  checkLinks(links, request.origin);
  const keptBroken = keptBreak(kept, new Set(links.map((link) => link.id)));
  if (keptBroken !== null) throw new FrameError(keptBroken);
  const header = {
    v: VERSION,
    quotes: [...request.quotes],
    image: request.image,
    sha256: request.sha256,
    originalSha256: request.originalSha256,
    copyBytes: copy.byteLength,
    ...(request.origin === undefined ? {} : { origin: request.origin }),
    links,
    kept,
  };
  return requestFrame(GATE_REQUEST_MAGIC, header, Buffer.concat([copy, original]));
}

/** The gate's reading of a request frame: exactly the typed gate request, or a FrameError. */
export function decodeGateRequest(frame: Frame): GateRequest {
  const { header, body } = frame;
  if (!isRecord(header) || !hasKeys(header, ['v', 'quotes', 'image', 'sha256', 'originalSha256', 'copyBytes', 'links', 'kept'], ['origin'])) throw new FrameError('the gate request header is not a gate request');
  if (header['v'] !== VERSION) throw new FrameError('the gate request is of another version');
  if (!validQuotes(header['quotes'])) throw new FrameError('the quotes are not a list of text within the caps');
  const image = header['image'];
  if (!IMAGE_ACTIONS.includes(image as ImageAction)) throw new FrameError('the image action is not one the gate knows');
  if (!isHash(header['sha256']) || !isHash(header['originalSha256'])) throw new FrameError('a hash is not a sha256');
  const copyBytes = header['copyBytes'];
  if (typeof copyBytes !== 'number' || !Number.isInteger(copyBytes) || copyBytes < 1 || copyBytes > MAX_OUTPUT_BYTES || copyBytes >= body.length) throw new FrameError('the copy is not within the body');
  if (body.length - copyBytes > MAX_INPUT_BYTES) throw new FrameError('the original is outside the gate input cap');
  checkLinks(header['links'], header['origin']);
  const links = header['links'] as EngineLink[];
  const keptBroken = keptBreak(header['kept'], new Set(links.map((link) => link.id)));
  if (keptBroken !== null) throw new FrameError(keptBroken);
  const origin = header['origin'] as string | undefined;
  const part = (from: number, to: number): Uint8Array => new Uint8Array(body.buffer, body.byteOffset + from, to - from);
  return {
    copy: part(0, copyBytes),
    original: part(copyBytes, body.length),
    quotes: header['quotes'],
    image: image as ImageAction,
    sha256: header['sha256'],
    originalSha256: header['originalSha256'],
    ...(origin === undefined ? {} : { origin }),
    links,
    kept: header['kept'] as string[],
  };
}

/**
 * The gate's answer, as a frame: the verdict by code only and the copy's hash; a pass also carries the bytes the gate
 * checked, as the body, with their hash. Throws a FrameError for a pass without them, or with them outside the output cap.
 */
export function encodeGateReply(reply: GateReply): Buffer {
  if (!reply.verdict.pass) return encodeFrame(GATE_REPLY_MAGIC, { v: VERSION, verdict: 'refused', code: reply.verdict.code, sha256: reply.sha256 });
  const { checked } = reply;
  if (checked === undefined || checked.pdf.byteLength === 0 || checked.pdf.byteLength > MAX_OUTPUT_BYTES) throw new FrameError('a pass carries the checked copy, within the output cap');
  return encodeFrame(GATE_REPLY_MAGIC, { v: VERSION, verdict: 'pass', sha256: reply.sha256, checkedSha256: checked.sha256 }, checked.pdf);
}

/** The worker's reading of a gate reply frame: exactly one typed verdict (a pass with its checked bytes), or a FrameError. */
export function decodeGateReply(frame: Frame): GateReply {
  const { header, body } = frame;
  if (isRecord(header) && header['v'] === VERSION && isHash(header['sha256'])) {
    if (header['verdict'] === 'pass' && hasKeys(header, ['v', 'verdict', 'sha256', 'checkedSha256']) && isHash(header['checkedSha256']) && body.length > 0 && body.length <= MAX_OUTPUT_BYTES) {
      return { verdict: { pass: true }, sha256: header['sha256'], checked: { pdf: new Uint8Array(body), sha256: header['checkedSha256'] } };
    }
    if (header['verdict'] === 'refused' && body.length === 0 && hasKeys(header, ['v', 'verdict', 'code', 'sha256']) && GATE_CODES.includes(header['code'] as GateCode)) {
      return { verdict: { pass: false, code: header['code'] as GateCode }, sha256: header['sha256'] };
    }
  }
  throw new FrameError('the reply is not a verdict the worker knows');
}
