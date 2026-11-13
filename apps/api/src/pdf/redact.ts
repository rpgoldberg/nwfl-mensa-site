// ============================================================================
// REDACT R3a: one audience's copy of a PDF.
//
// Given the original and what this audience redacts (the marked passages its
// policy redacts, and whether its policy redacts any category at all):
//
//   nothing redacted     the original is the audience's file;
//   otherwise            a redacted copy, or none at all (fail closed).
//
// The copy: annotations and form fields are drawn into their pages (so what
// they show is matched like the page), the marked passages are found in each
// page's text (match.ts), with every copy of a withheld word drawn by another
// text object beside it (a shadow drawn a word at a time), every glyph in their
// regions (exactly the passages' extent, any neighbour removed with them and the
// rest of its word, and any text drawn twice there that PDFium does not read)
// is removed from the content
// (PDFium, form XObjects included) and an opaque box is drawn over exactly
// what was removed. BOXLABEL (labels.ts): each box is labelled by who may
// read it, where its label fits at a readable size: "Private" when a passage
// glyph in it is one members withhold too (the request's membersWithhold;
// every quote when it names none), or it holds none, else "Members Only",
// else "Mbrs Only"; a box too narrow has none. Then the pages are rebuilt alone
// (sanitize.ts): no metadata, outline, attachments, JavaScript, annotations or
// marked-content text. Last, PDFium reads the copy again, then the output
// gate (gate.ts) reads it with pdf.js and decodes every object in it: if
// either finds any passage, there is no copy. The labels are read first as
// the gate reads them (gate-labels.ts): any other text in a box, or a label
// outside one, is no copy, and no label's own text counts as a passage.
//
// No copy (the reason is for an officer):
//   - the file cannot be opened;
//   - a page has drawn content but no text, or pictures cover at least
//     SCAN_SHARE of what it draws: a scan, whose words cannot be found, so
//     cannot be checked, whenever the audience redacts anything;
//   - a page has characters with no Unicode value: its text cannot be checked;
//   - (LIGATURE, unreadable.ts) a glyph read as no text (U+FFFD, private use) is
//     left in the copy where, read as up to its reach of letters, it could finish
//     a quote; one that stands for a ligature of a quote is boxed with it;
//   - a passage has no position, or it or its glyphs' ink lies over a picture
//     (removing the text would leave the picture's pixels under the box);
//   - a withheld glyph is still on the page after removal, even one no whole
//     quote can be read in;
//   - a text object PDFium reads only in part meets a passage: what its reading
//     left out of it is unknown (a text object it reads none of, text drawn
//     twice, is removed and boxed whole with the passage it meets instead);
//   - a glyph is read after removal that was not read before: text drawn twice,
//     whose second copy PDFium's reading left out while the first was there;
//   - text PDFium does not read is left at a passage after removal (the page's
//     text objects are counted against its reading again);
//   - a glyph a text object draws on its own is left within an em of a box, on
//     its line (a copy drawn a glyph at a time that the boxes stopped short of),
//     unless it is punctuation, a bullet or the next run of its line, is no
//     letter or digit of the passage, and has no other such glyph beside it;
//   - withheld text is drawn again where no box reached: a word of 3 letters or
//     more of a passage beside a box on its line, or within an em of a withheld
//     drawing of it (a shadow the boxes stopped short of), or anywhere on the
//     page a passage of two words or more, 4 digits or more of one, or an email
//     or web address. A word of a passage that recurs on its own elsewhere is
//     ordinary text, and is shown;
//   - the page has text drawn as a clip (render mode 4 to 7): PDFium's rewrite
//     of the page would end the clip, and what it clipped would flood the page;
//   - a content stream or a JPEG cannot be read, or a passage is still
//     readable after (PDFium), or the gate finds one or cannot check a stream;
//   - a tiling pattern shows text (GLYPHMAP fix round 2, B1): PDFium reads no
//     text in one, so no passage drawn there could be found or boxed.
//
// LINKS L3: then each approved link the request gives (by id, page, rect and
// label, never its target) gets a fresh annotation pointing to the leaving
// page (link-annots.ts placeLinks), unless its rect meets a box drawn here,
// the ink of a glyph removed here, or (fix round 1, S1 and N1) what the link
// guard reads as withheld: a glyph of the original the copy lacks, and under
// "blur" or "hide" every picture PDFium reads on every page (drawn on the
// page, in a form at any depth, or in an annotation's appearance) and (fix
// round 2, F1; fix round 3, N1 and D1) the whole of every page whose resources
// reach a tiling pattern or a soft mask's group that draws a picture, whose
// place PDFium does not give, or are too many to walk (link-guard.ts, the
// gate's own check too); the reply names the ids kept. PDFium and the gate read the copy
// with the annotations in place, so every string they hold is searched for
// every passage too. With no links, nothing is written and the copy is byte
// for byte what it was before links. When the links cannot be placed, there
// is no copy here; the worker then asks for one with no links (rerun.ts).
// ============================================================================
import { checkCopy } from './gate.js';
import { labelMarks, leakBreak } from './gate-labels.js';
import { patternTextBreak } from './gate-rules.js';
import { namedBreak } from './glyph-names.js';
import { type ImageAction, keepsPicture, pictureWindows } from './images.js';
import type { BoxKind } from './labels.js';
import { type EngineLink, type PageBox, boxOf, meets, placeLinks } from './link-annots.js';
import { linkGuardAreas } from './link-guard.js';
import { type Box, type PageChar, type Region, boxesFor, copiesOf, drawnAgain, hull, loneGlyphs, matchedChars, meeting, notVacated, regionsFor, stillThere, unread, wordsOf } from './match.js';
import { nameBreak } from './pdf-structure.js';
import { UNOPENABLE, pdfiumBreak } from './pdfium-reading.js';
import { Document, type Page, pdfium } from './pdfium.js';
import { sanitize } from './sanitize.js';

export interface RedactRequest {
  /** The marked passages this audience's policy redacts. */
  quotes: readonly string[];
  /**
   * BOXLABEL: for each quote, whether members withhold it too (store.ts inputsFor): its box is labelled "Private",
   * else "Members Only". Every quote when absent, so every box "Private". One boolean per quote, so no text.
   */
  membersWithhold?: readonly boolean[];
  /** Whether this audience's policy redacts any category: then even an unmarked file is never given as it is. */
  redactsAny: boolean;
  /** This audience's image policy (images.ts); "show" when absent. */
  image?: ImageAction;
  /** What the links point to (https://<origin>/out/<id>); set whenever there are links. */
  origin?: string;
  /** The approved links whose targets pass this audience's check (store.ts inputsFor); none when absent. */
  links?: readonly EngineLink[];
}

export interface RedactDeps {
  sanitize?: (pdf: Uint8Array, image: ImageAction) => Promise<Uint8Array>;
  /** The link guard (link-guard.ts linkGuardAreas), for tests only: each of the engine's two blocks is tested alone (fix 2, N1). */
  guard?: typeof linkGuardAreas;
}

export type RedactResult =
  | { kind: 'original' }
  /** `kept`: the links the copy holds (none when absent). `linksDropped`: why the copy was made with no links, for the logs (rerun.ts). */
  | { kind: 'redacted'; pdf: Uint8Array; boxes: Region[]; kept?: string[]; linksDropped?: string }
  | { kind: 'refused'; reason: string };

/** Why there is no copy when its links cannot be placed: the worker then asks for one with no links (rerun.ts). */
export const LINKS_UNWRITTEN = 'the links could not be written';
/** The share of a page's drawn area that pictures may cover before it counts as a scan. */
export const SCAN_SHARE = 0.8;

/** Whether pictures cover at least SCAN_SHARE of the area the page draws on (within the page). */
function isScan(page: Page): boolean {
  const clip = (b: Box): Box => ({ left: Math.max(0, b.left), bottom: Math.max(0, b.bottom), right: Math.min(page.width, b.right), top: Math.min(page.height, b.top) });
  const area = (b: Box): number => Math.max(0, b.right - b.left) * Math.max(0, b.top - b.bottom);
  // One box at a time: a page can draw millions of objects, too many to spread into one call (fix round 3, N5).
  const drawn = hull(page.bounds().map(clip));
  const extent = drawn === null ? 0 : area(drawn);
  const pictures = page.pictures().reduce((sum, picture) => sum + area(clip(picture)), 0);
  return extent > 0 && pictures >= SCAN_SHARE * extent;
}

const isBlank = (c: { text: string }): boolean => /^\s*$/u.test(c.text);
const overlaps = (a: Box, b: Box): boolean => a.left < b.right && b.left < a.right && a.bottom < b.top && b.bottom < a.top;

/** Why one page cannot be given, or null once its passages are removed and boxed (added to `boxes`). */
function redactPage(doc: Document, index: number, quotes: readonly string[], privateQuotes: readonly string[], boxes: Region[], regenerate: boolean, blocked: PageBox[]): string | null {
  doc.flatten(index);
  return doc.page(index, (page) => {
    // Inline pictures become picture XObjects, which sanitize can replace.
    if (regenerate) page.regenerate();
    const { chars, unmapped } = page.chars();
    if (chars.length === 0 && page.objectCount > 0) return `page ${index + 1} has no text layer`;
    if (isScan(page)) return `page ${index + 1} is a scan: pictures cover most of it`;
    if (unmapped > 0) return `page ${index + 1} has text that cannot be read`;
    // A picture the policy does not show is withheld: no link may sit over it, on a page with no passage too (fix 1, S1).
    if (regenerate) blocked.push(...page.allPictures().map((picture) => ({ ...picture, page: index })));
    // Text drawn twice at nearly one place (a shadow, a fake bold, a decoy) is read once: the copy PDFium
    // left out is in no reading, so the page's text objects are counted against it (challenger r2, F2).
    const objects = page.textObjects();
    const hidden = unread(chars, objects);
    // A passage drawn a word at a time and again so beside it is read interleaved, and matched once across
    // the two: the words the match left that repeat a withheld word near it are withheld too (challenger r3, F1).
    const words = wordsOf(chars, objects);
    const matched = matchedChars(chars, quotes);
    const withheld = new Set([...matched, ...copiesOf(chars, matched, words)]);
    const found = regionsFor(chars, withheld, index, hidden.objects, words);
    if (!found.ok) return found.reason;
    if (found.regions.length === 0) return null;
    if (meeting(hidden.parts, found.regions).length > 0) return `page ${index + 1}: text PDFium reads only in part meets a withheld passage`;
    // A box is as narrow as the passage, so the marked glyphs' own ink is checked too.
    const covered: Box[] = [...found.regions, ...[...withheld].flatMap((i) => chars[i]?.ink ?? [])];
    const pictures = page.pictures();
    if (covered.some((area) => pictures.some((picture) => overlaps(area, picture)))) {
      return `page ${index + 1}: a withheld passage lies over a picture`;
    }
    if (page.hasClipText()) return `page ${index + 1} has text drawn as a clip, which removal would lose`;
    page.removeText(found.regions);
    const after = page.chars().chars;
    const there = stillThere(chars, after);
    // No glyph of a passage is exempt, a space included: PDFium reads none of a removed passage again.
    if ([...withheld].some((i) => there.has(i))) return `page ${index + 1}: a withheld glyph survived removal`;
    // Text drawn twice at a small offset (a shadow, a fake bold) is read once: PDFium leaves the second
    // copy out while the first is there, and reads it once the first is removed. A glyph read after the
    // removal and not before is such a copy, perhaps of a withheld glyph, and no box was measured for it.
    const known = stillThere(after, chars);
    if (after.some((c, i) => !c.generated && c.box !== null && !isBlank(c) && !known.has(i))) {
      return `page ${index + 1}: text drawn twice is left after removal`;
    }
    // And the count again: a removal can leave text that no reading after it holds either. Where a glyph of
    // another line was removed from a word's end, PDFium keeps the word's bounds over its place: that is not it.
    const left = unread(after, page.textObjects());
    if (meeting([...left.objects, ...notVacated(chars, withheld, there, left.parts)], found.regions).length > 0) return `page ${index + 1}: text PDFium does not read is left at a withheld passage`;
    // A copy drawn a glyph at a time, letter-spaced unlike the passage, can end beyond the glyphs the boxes reached, and
    // withheld text can be drawn again beside the passage where no box reached, or whole elsewhere: fail closed on both
    // (challenger r4, F1). Ordinary text is not counted: a bullet, a link's full stop, a word of a passage on its own
    // elsewhere on the page (challenger r5, S1).
    if (loneGlyphs(chars, objects, found.regions, there, withheld).length > 0) return `page ${index + 1}: a glyph drawn on its own is left beside a withheld passage`;
    if (drawnAgain(chars, objects, quotes, there, withheld, found.regions).length > 0) return `page ${index + 1}: withheld text is drawn again elsewhere on the page`;
    // The boxes cover exactly what was removed: the passages, any neighbour and any unread text that went with them.
    const removed = new Set([...chars.keys()].filter((i) => !there.has(i)));
    const drawn = boxesFor(chars, withheld, removed, index, meeting(hidden.objects, found.regions));
    // BOXLABEL: the glyphs of a passage members withhold too, and their copies; a box holding one says "Private".
    const privately = matchedChars(chars, privateQuotes);
    page.drawBoxes(drawn, boxKinds(chars, drawn, withheld, new Set([...privately, ...copiesOf(chars, privately, words)])));
    boxes.push(...drawn);
    blocked.push(...withheldAreas(index, found.regions, drawn, chars, removed));
    return null;
  });
}

/**
 * Each box's kind (BOXLABEL, labels.ts): "members" when a withheld glyph is in it (its centre) and none is one members
 * withhold too (`private`: those matched by a quote members withhold, and its copies); else "private", for a box that
 * holds such a glyph, or no withheld glyph at all (only text removed with a passage).
 */
export function boxKinds(chars: readonly PageChar[], drawn: readonly Box[], withheld: ReadonlySet<number>, private_: ReadonlySet<number>): BoxKind[] {
  const centre = (i: number): { x: number; y: number } | null => {
    const place = chars[i]?.box ?? chars[i]?.ink ?? null;
    return place === null ? null : { x: (place.left + place.right) / 2, y: (place.bottom + place.top) / 2 };
  };
  const inBox = (box: Box, i: number): boolean => {
    const at = centre(i);
    return at !== null && at.x >= box.left && at.x <= box.right && at.y >= box.bottom && at.y <= box.top;
  };
  return drawn.map((box) => {
    const held = [...withheld].filter((i) => inBox(box, i));
    return held.length > 0 && !held.some((i) => private_.has(i)) ? 'members' : 'private';
  });
}

/**
 * What no link may sit over on a page (LINKS L3): the passages, the boxes drawn, and every removed glyph's ink, which can
 * reach past its box. A character PDFium generated (a line end's "\r\n", a space it inserts) draws nothing and has no
 * loose box, so stillThere never finds it again and `removed` holds every one; its ink is a point at its line's end, and
 * counting it blocked a link at the end of every line of the page (LINKS-LINEEND). It is not withheld ink.
 */
export function withheldAreas(index: number, regions: readonly Box[], drawn: readonly Box[], chars: readonly PageChar[], removed: Iterable<number>): PageBox[] {
  const inks = [...removed].flatMap((i) => {
    const c = chars[i];
    return c === undefined || c.generated || c.ink === null ? [] : [{ ...c.ink, page: index }];
  });
  return [...regions.map((box) => ({ ...box, page: index })), ...drawn.map((box) => ({ ...box, page: index })), ...inks];
}

/** The document with the passages removed from every page, or why there can be no copy. */
function redactPages(doc: Document, quotes: readonly string[], privateQuotes: readonly string[], regenerate: boolean): { pdf: Uint8Array; boxes: Region[]; blocked: PageBox[] } | string {
  const boxes: Region[] = [];
  const blocked: PageBox[] = [];
  for (let index = 0; index < doc.pageCount; index++) {
    const refused = redactPage(doc, index, quotes, privateQuotes, boxes, regenerate, blocked);
    if (refused !== null) return refused;
  }
  return { pdf: doc.save(), boxes, blocked };
}

/** Null when no passage can be read in the PDF's text, else why the copy fails. */
export const verifyRedacted = pdfiumBreak;

/** This audience's file: the original, a redacted copy, or none, with the reason. */
export async function redactPdf(original: Uint8Array, request: RedactRequest, deps: RedactDeps = {}): Promise<RedactResult> {
  const image = request.image ?? 'show';
  const quotes = [...new Set(request.quotes.map((quote) => quote.trim()).filter((quote) => quote !== ''))];
  // A quote any copy of which members withhold is theirs to withhold too (BOXLABEL): its boxes say "Private".
  const privateQuotes = [...new Set(request.quotes.flatMap((quote, i) => (request.membersWithhold?.[i] === false ? [] : [quote.trim()])).filter((quote) => quote !== ''))];
  if (quotes.length === 0 && !request.redactsAny && image === 'show') return { kind: 'original' };
  const doc = Document.open(await pdfium(), original);
  if (doc === null) return { kind: 'refused', reason: UNOPENABLE };
  let redacted: { pdf: Uint8Array; boxes: Region[]; blocked: PageBox[] } | string;
  try {
    redacted = redactPages(doc, quotes, privateQuotes, image !== 'show');
  } finally {
    doc.close();
  }
  if (typeof redacted === 'string') return { kind: 'refused', reason: redacted };
  let pdf: Uint8Array;
  try {
    pdf = await (deps.sanitize ?? sanitize)(redacted.pdf, image);
  } catch (error) {
    return { kind: 'refused', reason: error instanceof Error ? error.message : String(error) };
  }
  if (image !== 'show' && (await keepsPicture(pdf, await pictureWindows(original)))) return { kind: 'refused', reason: 'an original picture is still in the copy' };
  let kept: string[];
  const plain = pdf;
  // The link guard reads the original and this copy as the gate will (fix 1, S1 and N1): a link that meets anything it reads is dropped.
  const guarded = async (links: readonly EngineLink[]): Promise<ReadonlySet<string>> => {
    const areas = await (deps.guard ?? linkGuardAreas)(original, plain, image);
    return new Set(links.filter((link) => areas.some((area) => area.page === link.page - 1 && meets(boxOf(link.rect), area))).map((link) => link.id));
  };
  try {
    ({ pdf, kept } = await placeLinks(pdf, request.links ?? [], request.origin, redacted.blocked, guarded));
  } catch {
    return { kind: 'refused', reason: LINKS_UNWRITTEN };
  }
  // The labels are read as the gate reads them (gate-labels.ts): any other text in a box, or a label outside one, is no
  // copy, and no label's own text counts as withheld text. First, as the gate does (R3-1), no copy holds a name pdf-lib
  // reads apart from pdf.js and PDFium, so the font a label's op names is the one each of them finds.
  const names = await nameBreak(pdf);
  if (names !== null) return { kind: 'refused', reason: names };
  const labels = await labelMarks(pdf);
  if (typeof labels === 'string') return { kind: 'refused', reason: labels };
  // And the text the glyph names draw, as the gate reads it (GLYPHMAP, glyph-names.ts).
  const left = await leakBreak(pdf, labels, async (bytes) => (await verifyRedacted(bytes, quotes)) ?? (await namedBreak(bytes, quotes)) ?? (await checkCopy(bytes, quotes)));
  if (left !== null) return { kind: 'refused', reason: left };
  // Then no tiling pattern shows text: PDFium, which the engine matches with, reads none there (GLYPHMAP fix round 2,
  // B1), so withheld text there that no reading above found is refused here.
  const tiled = await patternTextBreak(pdf);
  return tiled === null ? { kind: 'redacted', pdf, boxes: redacted.boxes, kept } : { kind: 'refused', reason: tiled };
}
