// ============================================================================
// extract (SPEC D4 step 1): the links of one PDF, read with pdf.js (the version apps/api's gate pins),
// in a container with no network. The only part of the checker that parses a PDF.
//
// For each Link annotation with a URL: its 1-based page, its rect clamped to the page's crop box and
// rounded to 0.01, the URL, and the text drawn under it (whole text items that meet the rect, for
// The editor's sheet only; never written to links.json). Also the plain-text URLs no link carries.
//
// Fail closed, and bounded:
//   - a file over 10 MiB, not a PDF, unreadable, over 500 pages, with more than 500 links or more than
//     1000 refused links, or past its deadline is refused whole;
//   - a link is refused (page and reason only, never its URL; the scheme's name when it is one) when
//     its scheme is not https, http or mailto, when it holds a control, bidi or zero-width character,
//     when it is over 2048 characters, when its rect misses the page, or when pdf.js shows it came from
//     an action other than URI (reason "action"): pdf.js sets newWindow on every URL it recovers from a
//     JavaScript action, and on a Launch or GoToR URL only when the action's /NewWindow is a boolean;
//     for a GoToR with an explicit destination it appends the destination as a JSON fragment
//     ("#[0,{"name":"Fit"}]"), so a URL whose fragment starts with "[" is refused too.
//   - nothing of the annotation's own dictionary (/Contents, /T, /Alt, /AP) is read or written.
// pdf.js gives no action type for a URL it hands over, so a Launch or GoToR URL with neither mark (no
// /NewWindow, no explicit destination) reads like a URI one and is checked like any other; the copy
// never carries the original's action either way (SPEC D1b: the engine draws fresh annotations from
// the approved list).
// ============================================================================
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type { TextItem } from 'pdfjs-dist/types/src/display/api.js';
import { AUDIENCES, type Audience, MAX_LINKS_PER_FILE, type Rect, isRect } from './list.js';
import { CONTROL, CONTROLS, MAX_URL_LENGTH, parseLink, trimTrailing } from './urls.js';

export const EXTRACT_FORMAT = 'nwfl-link-extract/1';
export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const MAX_PAGES = 500;
export const MAX_REFUSED = 1000;
export const MAX_UNLINKED = 500;
export const MAX_TEXT = 300;
export const DEFAULT_DEADLINE_MS = 120_000;

export type RefusalReason = 'scheme' | 'control' | 'too-long' | 'action' | 'rect';
const REASONS: readonly RefusalReason[] = ['scheme', 'control', 'too-long', 'action', 'rect'];

export interface ExtractedLink {
  page: number;
  rect: Rect;
  /** Trimmed at both ends, decoded from UTF-8 where its bytes were; otherwise as the file holds it. */
  url: string;
  text: string;
}

export interface Refused {
  page: number;
  reason: RefusalReason;
  scheme?: string;
}

export interface Unlinked {
  page: number;
  url: string;
}

export interface Extraction {
  format: typeof EXTRACT_FORMAT;
  audience: Audience;
  sha256: string;
  pages: number;
  links: ExtractedLink[];
  refused: Refused[];
  /** Links to a place in the file itself (out of scope for v1, SPEC D1a): counted only. */
  internal: number;
  unlinked: Unlinked[];
  unlinkedMore: number;
}

export class ExtractError extends Error {
  override name = 'ExtractError';
}

const SCHEME_NAME = /^[a-z][a-z0-9+.-]{0,30}$/;

type Screened = { ok: true; url: string } | { ok: false; reason: RefusalReason; scheme?: string };

/** A raw URL as extract keeps it, or why not: the cheap checks; parsing and hygiene are the check's. */
export function screenUrl(input: string): Screened {
  let raw = input;
  // A PDF string's bytes arrive as latin1 characters: read them as UTF-8 when they are.
  // eslint-disable-next-line no-control-regex -- every latin1 character, U+0000 included
  if (/[\u0080-\u00ff]/.test(raw) && !/[^\u0000-\u00ff]/.test(raw)) {
    try {
      raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(raw, 'latin1'));
    } catch {
      // not UTF-8: kept as it is; the URL parser percent-encodes it
    }
  }
  raw = raw.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
  if (raw.length > MAX_URL_LENGTH) return { ok: false, reason: 'too-long' };
  if (CONTROL.test(raw)) return { ok: false, reason: 'control' };
  if (/^www\./i.test(raw)) return { ok: true, url: raw };
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw)?.[1]?.toLowerCase();
  if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') return { ok: true, url: raw };
  return scheme !== undefined && SCHEME_NAME.test(scheme) ? { ok: false, reason: 'scheme', scheme } : { ok: false, reason: 'scheme' };
}

/** The fragment pdf.js writes for a GoToR action's explicit destination: JSON.stringify(dest), an array. */
const REMOTE_DEST = /^[^#]*#\[/;

const round = (n: number): number => Math.round(n * 100) / 100;

/** The rect clamped to the page box, rounded; undefined when nothing of it is on the page. */
function clamp(rect: readonly number[], view: readonly number[]): Rect | undefined {
  if (rect.length !== 4 || view.length !== 4 || ![...rect, ...view].every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined;
  const [ax, ay, bx, by] = rect as Rect;
  const [vx1, vy1, vx2, vy2] = view as Rect;
  const out: Rect = [
    round(Math.max(Math.min(ax, bx), Math.min(vx1, vx2))),
    round(Math.max(Math.min(ay, by), Math.min(vy1, vy2))),
    round(Math.min(Math.max(ax, bx), Math.max(vx1, vx2))),
    round(Math.min(Math.max(ay, by), Math.max(vy1, vy2))),
  ];
  return isRect(out) ? out : undefined;
}

interface Placed {
  str: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function placed(item: TextItem): Placed {
  const [, , c = 0, d = 0, x = 0, y = 0] = item.transform as number[];
  const height = item.height > 0 ? item.height : Math.hypot(c, d);
  return { str: item.str, x1: x, y1: y, x2: x + item.width, y2: y + height };
}

const tidy = (text: string): string => text.replace(CONTROLS, '').replace(/\s+/gu, ' ').trim();

/** The text items that meet the rect, top to bottom and left to right, as one line of at most 300 characters. */
function textUnder(items: readonly Placed[], rect: Rect): string {
  const [x1, y1, x2, y2] = rect;
  const meeting = items.filter((i) => i.x1 < x2 && i.x2 > x1 && i.y1 < y2 && i.y2 > y1).sort((a, b) => b.y1 - a.y1 || a.x1 - b.x1);
  return [...tidy(meeting.map((i) => i.str).join(' '))].slice(0, MAX_TEXT).join('');
}

const URL_IN_TEXT = /(?:https?:\/\/|www\.)[^\s<>"'`]+/giu;

/** What a URL points at, scheme and a trailing slash aside, so a printed form matches its link. */
function sameTarget(raw: string): string | undefined {
  const parsed = parseLink(raw);
  if (!parsed.ok) return undefined;
  if (parsed.link.kind === 'mail') return parsed.link.url;
  const url = new URL(parsed.link.url);
  return `${parsed.link.host}${url.pathname.replace(/\/$/, '')}${url.search}`;
}

export interface ReadOptions {
  deadlineMs?: number;
  now?: () => number;
}

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjs: Promise<PdfJs> | undefined;
const loadPdfJs = (): Promise<PdfJs> => (pdfjs ??= import('pdfjs-dist/legacy/build/pdf.mjs'));

interface LinkData {
  subtype?: string;
  rect?: number[];
  unsafeUrl?: unknown;
  newWindow?: unknown;
  dest?: unknown;
}

/** The links of one PDF, read in this thread (extract runs it in a worker of its own). Throws ExtractError when the file is refused whole. */
export async function readPdf(pdf: Uint8Array, audience: Audience, options: ReadOptions = {}): Promise<Extraction> {
  if (pdf.length > MAX_PDF_BYTES) throw new ExtractError('the file is larger than 10 MiB');
  if (Buffer.from(pdf.subarray(0, 5)).toString('latin1') !== '%PDF-') throw new ExtractError('the file is not a PDF');
  const now = options.now ?? Date.now;
  const deadline = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const start = now();
  const sha256 = createHash('sha256').update(pdf).digest('hex');
  const lib = await loadPdfJs();
  const task = lib.getDocument({ data: new Uint8Array(pdf), verbosity: 0, disableFontFace: true, enableXfa: false, useSystemFonts: false });
  try {
    let doc;
    try {
      doc = await task.promise;
    } catch {
      throw new ExtractError('the file could not be read as a PDF');
    }
    if (doc.numPages > MAX_PAGES) throw new ExtractError(`the file has more than ${MAX_PAGES} pages`);
    const links: ExtractedLink[] = [];
    const refused: Refused[] = [];
    const unlinkedAll: Unlinked[] = [];
    let internal = 0;
    for (let n = 1; n <= doc.numPages; n += 1) {
      if (now() - start > deadline) throw new ExtractError(`reading the file took longer than ${deadline} ms`);
      const page = await doc.getPage(n);
      const items = (await page.getTextContent()).items.filter((item): item is TextItem => 'str' in item).map(placed);
      const annotations = (await page.getAnnotations()) as LinkData[];
      for (const annotation of annotations) {
        if (annotation.subtype !== 'Link') continue;
        if (typeof annotation.unsafeUrl !== 'string') {
          if (annotation.dest !== undefined) internal += 1;
          continue;
        }
        const refuse = (reason: RefusalReason, scheme?: string): void => {
          refused.push(scheme === undefined ? { page: n, reason } : { page: n, reason, scheme });
          if (refused.length > MAX_REFUSED) throw new ExtractError(`the file has more than ${MAX_REFUSED} refused links`);
        };
        if (annotation.newWindow !== undefined || REMOTE_DEST.test(annotation.unsafeUrl)) {
          refuse('action');
          continue;
        }
        const screened = screenUrl(annotation.unsafeUrl);
        if (!screened.ok) {
          refuse(screened.reason, screened.scheme);
          continue;
        }
        const rect = clamp(annotation.rect ?? [], page.view);
        if (rect === undefined) {
          refuse('rect');
          continue;
        }
        links.push({ page: n, rect, url: screened.url, text: textUnder(items, rect) });
        if (links.length > MAX_LINKS_PER_FILE) throw new ExtractError(`the file has more than ${MAX_LINKS_PER_FILE} links`);
      }
      const text = items.map((i) => i.str).join(' ');
      for (const match of text.matchAll(URL_IN_TEXT)) {
        const url = trimTrailing(match[0]);
        if (screenUrl(url).ok) unlinkedAll.push({ page: n, url });
      }
    }
    const linked = new Set(links.map((l) => sameTarget(l.url)));
    const unlinked = unlinkedAll.filter((u) => {
      const target = sameTarget(u.url);
      return target !== undefined && !linked.has(target);
    });
    return {
      format: EXTRACT_FORMAT,
      audience,
      sha256,
      pages: doc.numPages,
      links,
      refused,
      internal,
      unlinked: unlinked.slice(0, MAX_UNLINKED),
      unlinkedMore: Math.max(0, unlinked.length - MAX_UNLINKED),
    };
  } finally {
    await task.destroy();
  }
}

// --- the isolated read ---------------------------------------------------------

/** The heap a reading may use: pdf.js builds every annotation of a page before any cap here can count them. */
export const WORKER_HEAP_MB = 256;

export interface ExtractOptions {
  deadlineMs?: number;
  /** The worker's module; the built extract-worker.js beside this file by default. */
  workerUrl?: URL;
  heapMb?: number;
}

/** What the worker posts back. */
export type WorkerReply = { ok: true; extraction: Extraction } | { ok: false; message: string };

/**
 * The links of one PDF, read by readPdf in a worker thread with a heap limit and a deadline (SPEC D7: bounded memory and
 * time). A worker that runs out of heap or time is ended, and the file is refused whole.
 */
export function extract(pdf: Uint8Array, audience: Audience, options: ExtractOptions = {}): Promise<Extraction> {
  if (pdf.length > MAX_PDF_BYTES) return Promise.reject(new ExtractError('the file is larger than 10 MiB'));
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const heapMb = options.heapMb ?? WORKER_HEAP_MB;
  return new Promise<Extraction>((resolve, reject) => {
    const worker = new Worker(options.workerUrl ?? new URL('./extract-worker.js', import.meta.url), {
      workerData: { pdf, audience, deadlineMs },
      resourceLimits: { maxOldGenerationSizeMb: heapMb, maxYoungGenerationSizeMb: Math.min(32, heapMb), stackSizeMb: 4 },
      stdout: true,
      stderr: true,
    });
    // pdf.js's warnings stay out of the command's output: read and dropped, so they never pile up.
    worker.stdout.resume();
    worker.stderr.resume();
    let settled = false;
    const settle = (error: Error | undefined, extraction?: Extraction): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error);
      else resolve(extraction as Extraction);
    };
    const timer = setTimeout(() => settle(new ExtractError(`reading the file took longer than ${deadlineMs} ms`)), deadlineMs);
    worker.once('message', (reply: WorkerReply) => settle(reply.ok ? undefined : new ExtractError(reply.message), reply.ok ? reply.extraction : undefined));
    worker.once('error', (error: Error & { code?: string }) =>
      settle(new ExtractError(error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? `reading the file needed more than ${heapMb} MiB` : 'the file could not be read as a PDF')),
    );
    worker.once('exit', () => settle(new ExtractError('the file could not be read as a PDF')));
  });
}

// --- the strict reader --------------------------------------------------------

type Json = Record<string, unknown>;

function object(value: unknown, where: string): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ExtractError(`${where} must be a JSON object`);
  return value as Json;
}

function known(json: Json, where: string, keys: readonly string[]): void {
  for (const key of Object.keys(json)) if (!keys.includes(key)) throw new ExtractError(`${where}: unknown field ${key}`);
}

const own = (json: Json, key: string): unknown => (Object.hasOwn(json, key) ? json[key] : undefined);

function count(value: unknown, where: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new ExtractError(`${where} must be a whole number from ${min} to ${max}`);
  return value;
}

function list(value: unknown, where: string, max: number): unknown[] {
  if (!Array.isArray(value)) throw new ExtractError(`${where} must be a list`);
  if (value.length > max) throw new ExtractError(`${where} holds at most ${max} entries`);
  return value;
}

function url(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new ExtractError(`${where} must be an https, http or mailto URL`);
  const screened = screenUrl(value);
  if (!screened.ok || screened.url !== value) throw new ExtractError(`${where} must be an https, http or mailto URL`);
  return value;
}

/** An extraction as the check and list stages read it: known fields only, every cap held again. */
export function parseExtraction(input: unknown): Extraction {
  const json = object(input, 'the extraction');
  known(json, 'the extraction', ['format', 'audience', 'sha256', 'pages', 'links', 'refused', 'internal', 'unlinked', 'unlinkedMore']);
  if (own(json, 'format') !== EXTRACT_FORMAT) throw new ExtractError(`the extraction's format must be ${EXTRACT_FORMAT}`);
  const audience = own(json, 'audience');
  if (!(AUDIENCES as readonly unknown[]).includes(audience)) throw new ExtractError('audience must be public or members');
  const sha256 = own(json, 'sha256');
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) throw new ExtractError('sha256 must be 64 lower-case hex digits');
  const pages = count(own(json, 'pages'), 'pages', 1, MAX_PAGES);
  const links = list(own(json, 'links'), 'links', MAX_LINKS_PER_FILE).map((entry, n): ExtractedLink => {
    const where = `links[${n}]`;
    const link = object(entry, where);
    known(link, where, ['page', 'rect', 'url', 'text']);
    const rect = own(link, 'rect');
    if (!isRect(rect)) throw new ExtractError(`${where}.rect must be four finite numbers rounded to 0.01`);
    const text = own(link, 'text');
    if (typeof text !== 'string' || [...text].length > MAX_TEXT || CONTROL.test(text)) throw new ExtractError(`${where}.text must be at most ${MAX_TEXT} characters with no control character`);
    return { page: count(own(link, 'page'), `${where}.page`, 1, pages), rect, url: url(own(link, 'url'), `${where}.url`), text };
  });
  const refused = list(own(json, 'refused'), 'refused', MAX_REFUSED).map((entry, n): Refused => {
    const where = `refused[${n}]`;
    const one = object(entry, where);
    known(one, where, ['page', 'reason', 'scheme']);
    const reason = own(one, 'reason');
    if (!(REASONS as readonly unknown[]).includes(reason)) throw new ExtractError(`${where}.reason must be one of ${REASONS.join(', ')}`);
    const scheme = own(one, 'scheme');
    if (scheme !== undefined && (typeof scheme !== 'string' || !SCHEME_NAME.test(scheme))) throw new ExtractError(`${where}.scheme must be a scheme's name`);
    const page = count(own(one, 'page'), `${where}.page`, 1, pages);
    return scheme === undefined ? { page, reason: reason as RefusalReason } : { page, reason: reason as RefusalReason, scheme };
  });
  const unlinked = list(own(json, 'unlinked'), 'unlinked', MAX_UNLINKED).map((entry, n): Unlinked => {
    const where = `unlinked[${n}]`;
    const one = object(entry, where);
    known(one, where, ['page', 'url']);
    return { page: count(own(one, 'page'), `${where}.page`, 1, pages), url: url(own(one, 'url'), `${where}.url`) };
  });
  return {
    format: EXTRACT_FORMAT,
    audience: audience as Audience,
    sha256,
    pages,
    links,
    refused,
    internal: count(own(json, 'internal'), 'internal', 0, 1_000_000),
    unlinked,
    unlinkedMore: count(own(json, 'unlinkedMore'), 'unlinkedMore', 0, 1_000_000),
  };
}
