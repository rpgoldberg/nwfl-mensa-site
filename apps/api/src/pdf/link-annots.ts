// ============================================================================
// LINKS L3: the one link annotation a copy may carry (SPEC D1b, D2).
//
// The server never reads a link from a PDF. The approved list (0024, read by
// store.ts inputsFor) gives each link an opaque id, its page (1-based), its
// rect in PDF user space and a label naming its host; the engine is never
// given the link's target. After the copy is redacted and rebuilt
// (redact.ts, sanitize.ts), placeLinks writes a fresh annotation for each link
// in exactly one shape:
//
//   << /Type /Annot /Subtype /Link /Rect [x1 y1 x2 y2] /Border [0 0 0] /F 4
//      /A << /S /URI /URI (https://<origin>/out/<id>) >> /Contents (Link to <host>) >>
//
// by reference from its page's /Annots. Nothing is copied from the original's
// annotations, so its /Contents, /T, /Alt, /NM, /RC, /AP, /QuadPoints and /A
// never reach a copy. A link is dropped when its page is not in the copy, when
// its rect, clamped to the page's crop box (within the media box), is empty,
// or when that clamped rect meets (touching counts) a box the engine drew or
// the ink of a glyph it removed, or its whole rect meets what the link guard
// reads as withheld (link-guard.ts: a picture the policy does not show, a
// glyph of the original the copy lacks), as the gate reads it.
//
// The gate (gate-rules.ts) reads a copy with acceptedLinks: on each page,
// /Annots must be a list in the page of references, each to a dictionary of
// exactly that shape, every value direct, the URI byte for byte
// https://<origin>/out/<id> for an id the engine said it kept, on that link's
// page, at its rect (within RECT_TOLERANCE) and with its label; each id once,
// every kept id there, and no annotation referenced from anywhere else. What it
// accepts it exempts from the "no annotation, no action, no /URI" rule; all
// else stays refused (rule 1). The text under each link is the gate's own
// check (gate-links.ts).
// ============================================================================
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, type PDFObject, PDFRef, PDFStream, PDFString } from '@cantoo/pdf-lib';
import { HOST, LINK_ID, MAX_COORDINATE, MAX_LINKS_PER_FILE, MAX_PAGE, roundRect } from '../load/links.js';
import type { Box } from './match.js';

export type Rect = readonly [number, number, number, number];

/** One link as the engine and the gate are given it: never its target. */
export interface EngineLink {
  id: string;
  /** 1-based. */
  page: number;
  rect: Rect;
  /** "Link to <host>": what a screen reader says (the annotation's /Contents). */
  label: string;
}

/** What the engine and the gate are told of the links: the origin they point to, the links, and (the gate) the ids the engine kept. */
export interface LinkRequest {
  origin?: string;
  links?: readonly EngineLink[];
  kept?: readonly string[];
}

/** A box on a page (0-based): one the engine drew, or a removed glyph's ink. */
export interface PageBox extends Box {
  page: number;
}

/** What a request tells of its links, as the gate's job takes it: the origin when there is one, the links and the kept ids (none when absent). */
export function linkRequestOf(request: LinkRequest): { origin?: string; links: readonly EngineLink[]; kept: readonly string[] } {
  return { ...(request.origin === undefined ? {} : { origin: request.origin }), links: request.links ?? [], kept: request.kept ?? [] };
}

/** A file holds at most this many links (0024), so a request does too. */
export const MAX_LINKS = MAX_LINKS_PER_FILE;
export const LABEL_PREFIX = 'Link to ';
/** "Link to " and the longest host. */
export const MAX_LABEL_CHARS = LABEL_PREFIX.length + 253;
/** How far, in points, a written rect may be from the request's. */
export const RECT_TOLERANCE = 0.01;

const NO_ORIGIN = "links need an origin: https:// and the site's host";
/** https and a DNS name (0024's host), or localhost with a port for local runs; no path, credentials or upper case. */
export const isOrigin = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('https://') && (HOST.test(value.slice(8)) || /^localhost(?::(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))?$/.test(value.slice(8)));
/** The site's canonical public origin (apps/web server/public-hosts.mjs SITE): what a copy's links point to unless LINK_ORIGIN says otherwise. */
export const DEFAULT_LINK_ORIGIN = 'https://nwflorida.us';

/**
 * LINK_ORIGIN, or the site's; throws for one that is not https and a host, so a worker or a server never starts with
 * it (readConfig reads it at boot, fix 1 N5). In production (NODE_ENV=production, as the image sets it) localhost is
 * refused too: it is for tests and the local e2e only.
 */
export function linkOrigin(env: Record<string, string | undefined> = process.env): string {
  const origin = env['LINK_ORIGIN'] ?? DEFAULT_LINK_ORIGIN;
  if (!isOrigin(origin)) throw new Error("LINK_ORIGIN must be https:// and the site's host, with no path");
  if (env['NODE_ENV'] === 'production' && !HOST.test(origin.slice(8))) throw new Error("LINK_ORIGIN must be the site's public https host in production, not localhost");
  return origin;
}
export const isLabel = (value: unknown): value is string => typeof value === 'string' && value.startsWith(LABEL_PREFIX) && HOST.test(value.slice(LABEL_PREFIX.length));
/** The only target a copy's link may have: our leaving page, by the link's id (no URL in a query: no open redirect). */
export const linkUri = (origin: string, id: string): string => `${origin}/out/${id}`;
export const linkLabel = (host: string): string => `${LABEL_PREFIX}${host}`;
export { roundRect };

const isRect = (value: unknown): value is Rect =>
  Array.isArray(value) &&
  value.length === 4 &&
  value.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= MAX_COORDINATE) &&
  (value[0] as number) < (value[2] as number) &&
  (value[1] as number) < (value[3] as number);

const LINK_KEYS = ['id', 'label', 'page', 'rect'];

/** Why a list of links (with its origin) is not one the engine or the gate takes, or null. Names what is wrong, never what it holds. */
export function linksBreak(links: unknown, origin: unknown): string | null {
  if (!Array.isArray(links)) return 'the links are not a list';
  if (origin !== undefined && !isOrigin(origin)) return NO_ORIGIN;
  if (links.length === 0) return null;
  if (origin === undefined) return NO_ORIGIN;
  if (links.length > MAX_LINKS) return `at most ${MAX_LINKS} links`;
  const seen = new Set<string>();
  for (const link of links as unknown[]) {
    if (typeof link !== 'object' || link === null || Array.isArray(link) || Object.keys(link).sort().join() !== LINK_KEYS.join()) return 'a link is exactly id, page, rect and label';
    const { id, page, rect, label } = link as Record<string, unknown>;
    if (typeof id !== 'string' || !LINK_ID.test(id)) return 'a link id is 26 lower-case base32 characters';
    if (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > MAX_PAGE) return `a link page is 1 to ${MAX_PAGE}`;
    if (!isRect(rect)) return `a link rect is four finite numbers within ${MAX_COORDINATE} of 0, with x1 < x2 and y1 < y2`;
    if (!isLabel(label)) return 'a link label is "Link to " and a host';
    if (seen.has(id)) return 'a link id is given twice';
    seen.add(id);
  }
  return null;
}

/** Whether two boxes meet: overlap or touch. */
export const meets = (a: Box, b: Box): boolean => a.left <= b.right && b.left <= a.right && a.bottom <= b.top && b.bottom <= a.top;

type Page = ReturnType<PDFDocument['getPages']>[number];

/** The part of a rect on the page (its crop box within its media box), or null when none of it is. */
function onPage(rect: Rect, page: Page): Box | null {
  const crop = page.getCropBox();
  const media = page.getMediaBox();
  const left = Math.max(rect[0], crop.x, media.x);
  const bottom = Math.max(rect[1], crop.y, media.y);
  const right = Math.min(rect[2], crop.x + crop.width, media.x + media.width);
  const top = Math.min(rect[3], crop.y + crop.height, media.y + media.height);
  return left < right && bottom < top ? { left, bottom, right, top } : null;
}

/** The one annotation dictionary, in the shape the header gives, for a link. */
function annotation(doc: PDFDocument, origin: string, link: EngineLink): PDFDict {
  return doc.context.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [...link.rect],
    Border: [0, 0, 0],
    F: 4,
    A: { S: 'URI', URI: PDFString.of(linkUri(origin, link.id)) },
    Contents: PDFString.of(link.label),
  });
}

/** Writes each link's annotation on its page (by reference from its /Annots, any other annotation dropped), in the request's order. */
export function writeLinks(doc: PDFDocument, origin: string, links: readonly EngineLink[]): void {
  const byPage = new Map<number, PDFRef[]>();
  for (const link of links) byPage.set(link.page - 1, [...(byPage.get(link.page - 1) ?? []), doc.context.register(annotation(doc, origin, link))]);
  for (const [index, refs] of byPage) (doc.getPage(index).node as PDFDict).set(PDFName.of('Annots'), doc.context.obj(refs));
}

/** A link's rect as a box. */
export const boxOf = (rect: Rect): Box => ({ left: rect[0], bottom: rect[1], right: rect[2], top: rect[3] });

/**
 * The copy with a fresh annotation for each link that survives (see the header), and the ids kept, in the
 * request's order. No links, or none kept: the copy as it came, byte for byte. `vetoed`, when given, is asked last,
 * with the links that survive the rest, for the ids that may not be kept either (the engine's link guard, redact.ts,
 * which tests a link's whole rect, as the gate does).
 */
export async function placeLinks(
  pdf: Uint8Array,
  links: readonly EngineLink[],
  origin: string | undefined,
  blocked: readonly PageBox[],
  vetoed: (links: readonly EngineLink[]) => Promise<ReadonlySet<string>> = () => Promise.resolve(new Set()),
): Promise<{ pdf: Uint8Array; kept: string[] }> {
  if (links.length === 0) return { pdf, kept: [] };
  if (!isOrigin(origin)) throw new Error(NO_ORIGIN);
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const pages = doc.getPages();
  const placed = links.filter((link) => {
    const page = pages[link.page - 1];
    const area = page === undefined ? null : onPage(link.rect, page);
    return area !== null && !blocked.some((box) => box.page === link.page - 1 && meets(area, box));
  });
  const vetoes = placed.length === 0 ? new Set<string>() : await vetoed(placed);
  const kept = placed.filter((link) => !vetoes.has(link.id));
  if (kept.length === 0) return { pdf, kept: [] };
  writeLinks(doc, origin, kept);
  return { pdf: await doc.save({ useObjectStreams: false }), kept: kept.map((link) => link.id) };
}

/** What acceptedLinks lets through: the pages whose /Annots hold the links, and the annotation objects. */
export interface Accepted {
  pages: Set<PDFDict>;
  annots: Set<PDFObject>;
}

const ANNOT_KEYS = ['A', 'Border', 'Contents', 'F', 'Rect', 'Subtype', 'Type'];
const bytesOf = (value: PDFObject | undefined): string | undefined => (value instanceof PDFString ? Buffer.from(value.asBytes()).toString('latin1') : undefined);
const numbers = (value: PDFObject | undefined, count: number): number[] | undefined => {
  if (!(value instanceof PDFArray) || value.size() !== count) return undefined;
  const items = value.asArray();
  const read = items.flatMap((item) => (item instanceof PDFNumber ? [item.asNumber()] : []));
  return read.length === count ? read : undefined;
};
const keysOf = (dict: PDFDict): string => dict.keys().map((key) => key.decodeText()).sort().join();

/** The link an annotation dictionary is, if it has exactly the one shape (every value direct) and points to our origin by an id; else undefined. */
function linkOf(dict: PDFDict, origin: string): { id: string; rect: number[]; label: string } | undefined {
  if (keysOf(dict) !== ANNOT_KEYS.join()) return undefined;
  const get = (key: string): PDFObject | undefined => dict.get(PDFName.of(key));
  if (get('Type') !== PDFName.of('Annot') || get('Subtype') !== PDFName.of('Link')) return undefined;
  const rect = numbers(get('Rect'), 4);
  const border = numbers(get('Border'), 3);
  const flags = get('F');
  const action = get('A');
  const label = bytesOf(get('Contents'));
  if (rect === undefined || border?.every((n) => n === 0) !== true || !(flags instanceof PDFNumber) || flags.asNumber() !== 4 || label === undefined) return undefined;
  if (!(action instanceof PDFDict) || keysOf(action) !== 'S,URI' || action.get(PDFName.of('S')) !== PDFName.of('URI')) return undefined;
  const uri = bytesOf(action.get(PDFName.of('URI')));
  const prefix = `${origin}/out/`;
  if (uri === undefined || !uri.startsWith(prefix)) return undefined;
  const id = uri.slice(prefix.length);
  return LINK_ID.test(id) && uri === linkUri(origin, id) ? { id, rect, label } : undefined;
}

/** Every reference to an accepted annotation outside its page's /Annots, anywhere in the copy. */
function referencedElsewhere(doc: PDFDocument, annots: ReadonlySet<string>, lists: ReadonlySet<PDFObject>): boolean {
  const walk = (value: PDFObject | undefined): boolean => {
    if (value instanceof PDFRef) return annots.has(value.toString());
    if (value instanceof PDFArray) return !lists.has(value) && value.asArray().some(walk);
    const dict = value instanceof PDFStream ? value.dict : value instanceof PDFDict ? value : undefined;
    return dict !== undefined && dict.entries().some(([, child]) => walk(child));
  };
  const trailer = Object.values(doc.context.trailerInfo) as Array<PDFObject | undefined>;
  return trailer.some(walk) || [...doc.context.enumerateIndirectObjects()].some(([, object]) => walk(object));
}

/**
 * The link annotations the gate lets through (see the header), or why the copy's are not exactly the engine's: one
 * reason, naming what is wrong, never what the copy holds. With nothing kept, nothing is accepted, and rule 1 refuses
 * any annotation the copy holds.
 */
export function acceptedLinks(doc: PDFDocument, request: LinkRequest): Accepted | string {
  const kept = request.kept ?? [];
  const none: Accepted = { pages: new Set(), annots: new Set() };
  if (kept.length === 0) return none;
  const links = new Map((request.links ?? []).map((link) => [link.id, link]));
  if (!isOrigin(request.origin)) return NO_ORIGIN;
  if (new Set(kept).size !== kept.length) return 'the engine kept a link twice';
  if (kept.some((id) => !links.has(id))) return 'the engine kept a link it was not given';
  const wanted = new Set(kept);
  const found = new Set<string>();
  const accepted: Accepted = { pages: new Set(), annots: new Set() };
  const refs = new Set<string>();
  const lists = new Set<PDFObject>();
  for (const [index, page] of doc.getPages().entries()) {
    const raw = page.node.get(PDFName.of('Annots'));
    if (raw === undefined) continue;
    if (!(raw instanceof PDFArray)) {
      const target = raw instanceof PDFRef ? doc.context.lookup(raw) : raw;
      if (target instanceof PDFArray && target.size() === 0) continue;
      return "a page's /Annots is not a list written in the page";
    }
    if (raw.size() === 0) continue;
    for (const item of raw.asArray()) {
      const target = item instanceof PDFRef ? doc.context.lookup(item) : undefined;
      if (!(target instanceof PDFDict)) return 'a link annotation is not a dictionary by reference';
      if (refs.has(item.toString())) return 'a link annotation is listed twice';
      refs.add(item.toString());
      const read = linkOf(target, request.origin);
      const link = read === undefined ? undefined : links.get(read.id);
      if (read === undefined || link === undefined || !wanted.has(read.id)) return 'an annotation is not one of the links the engine kept, in its one shape';
      if (found.has(read.id)) return 'a link id is in the copy twice';
      if (link.page !== index + 1 || read.label !== link.label || read.rect.some((n, k) => Math.abs(n - (link.rect[k] as number)) > RECT_TOLERANCE + 1e-9)) return 'a link is not on its page, at its rect, with its label';
      found.add(read.id);
      accepted.annots.add(target);
    }
    accepted.pages.add(page.node);
    lists.add(raw);
  }
  if (found.size !== wanted.size) return 'the copy does not hold exactly the links the engine kept';
  if (referencedElsewhere(doc, refs, lists)) return 'a link annotation is referenced outside its page';
  return accepted;
}
