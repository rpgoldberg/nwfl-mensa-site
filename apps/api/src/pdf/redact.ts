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
// what was removed, labelled "withheld" where the label fits at a readable
// size (pdfium.ts labelSize). Then the pages are rebuilt alone
// (sanitize.ts): no metadata, outline, attachments, JavaScript, annotations or
// marked-content text. Last, PDFium reads the copy again, then the output
// gate (gate.ts) reads it with pdf.js and decodes every object in it: if
// either finds any passage, there is no copy.
//
// No copy (the reason is for an officer):
//   - the file cannot be opened;
//   - a page has drawn content but no text, or pictures cover at least
//     SCAN_SHARE of what it draws: a scan, whose words cannot be found, so
//     cannot be checked, whenever the audience redacts anything;
//   - a page has characters with no Unicode value: its text cannot be checked;
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
//     its line (a copy drawn a glyph at a time that the boxes stopped short of);
//   - a withheld word of 3 letters or 4 digits or more is drawn again, on the
//     page, where no box reached: withheld text drawn twice, which honest pages
//     rarely do, goes to a person;
//   - the page has text drawn as a clip (render mode 4 to 7): PDFium's rewrite
//     of the page would end the clip, and what it clipped would flood the page;
//   - a content stream or a JPEG cannot be read, or a passage is still
//     readable after (PDFium), or the gate finds one or cannot check a stream.
// ============================================================================
import { checkCopy } from './gate.js';
import { type ImageAction, keepsPicture, pictureWindows } from './images.js';
import { type Box, type Region, boxesFor, copiesOf, drawnAgain, loneGlyphs, matchedChars, meeting, notVacated, regionsFor, stillThere, unread, wordsOf } from './match.js';
import { Document, type Page, pdfium } from './pdfium.js';
import { sanitize } from './sanitize.js';

export interface RedactRequest {
  /** The marked passages this audience's policy redacts. */
  quotes: readonly string[];
  /** Whether this audience's policy redacts any category: then even an unmarked file is never given as it is. */
  redactsAny: boolean;
  /** This audience's image policy (images.ts); "show" when absent. */
  image?: ImageAction;
}

export interface RedactDeps {
  sanitize?: (pdf: Uint8Array, image: ImageAction) => Promise<Uint8Array>;
}

export type RedactResult =
  | { kind: 'original' }
  | { kind: 'redacted'; pdf: Uint8Array; boxes: Region[] }
  | { kind: 'refused'; reason: string };

const UNOPENABLE = 'the PDF could not be opened';
/** The share of a page's drawn area that pictures may cover before it counts as a scan. */
export const SCAN_SHARE = 0.8;

/** Whether pictures cover at least SCAN_SHARE of the area the page draws on (within the page). */
function isScan(page: Page): boolean {
  const clip = (b: Box): Box => ({ left: Math.max(0, b.left), bottom: Math.max(0, b.bottom), right: Math.min(page.width, b.right), top: Math.min(page.height, b.top) });
  const area = (b: Box): number => Math.max(0, b.right - b.left) * Math.max(0, b.top - b.bottom);
  const drawn = page.bounds().map(clip);
  const extent = area({
    left: Math.min(...drawn.map((b) => b.left)),
    bottom: Math.min(...drawn.map((b) => b.bottom)),
    right: Math.max(...drawn.map((b) => b.right)),
    top: Math.max(...drawn.map((b) => b.top)),
  });
  const pictures = page.pictures().reduce((sum, picture) => sum + area(clip(picture)), 0);
  return extent > 0 && pictures >= SCAN_SHARE * extent;
}

const isBlank = (c: { text: string }): boolean => /^\s*$/u.test(c.text);
const overlaps = (a: Box, b: Box): boolean => a.left < b.right && b.left < a.right && a.bottom < b.top && b.bottom < a.top;

/** Why one page cannot be given, or null once its passages are removed and boxed (added to `boxes`). */
function redactPage(doc: Document, index: number, quotes: readonly string[], boxes: Region[], regenerate: boolean): string | null {
  doc.flatten(index);
  return doc.page(index, (page) => {
    // Inline pictures become picture XObjects, which sanitize can replace.
    if (regenerate) page.regenerate();
    const { chars, unmapped } = page.chars();
    if (chars.length === 0 && page.objectCount > 0) return `page ${index + 1} has no text layer`;
    if (isScan(page)) return `page ${index + 1} is a scan: pictures cover most of it`;
    if (unmapped > 0) return `page ${index + 1} has text that cannot be read`;
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
    // withheld text can be drawn again where no box reaches at all: fail closed on both (challenger r4, F1).
    if (loneGlyphs(chars, objects, found.regions, there).length > 0) return `page ${index + 1}: a glyph drawn on its own is left beside a withheld passage`;
    if (drawnAgain(chars, objects, quotes, there).length > 0) return `page ${index + 1}: withheld text is drawn again elsewhere on the page`;
    // The boxes cover exactly what was removed: the passages, any neighbour and any unread text that went with them.
    const removed = new Set([...chars.keys()].filter((i) => !there.has(i)));
    const drawn = boxesFor(chars, withheld, removed, index, meeting(hidden.objects, found.regions));
    page.drawBoxes(drawn);
    boxes.push(...drawn);
    return null;
  });
}

/** The document with the passages removed from every page, or why there can be no copy. */
function redactPages(doc: Document, quotes: readonly string[], regenerate: boolean): { pdf: Uint8Array; boxes: Region[] } | string {
  const boxes: Region[] = [];
  for (let index = 0; index < doc.pageCount; index++) {
    const refused = redactPage(doc, index, quotes, boxes, regenerate);
    if (refused !== null) return refused;
  }
  return { pdf: doc.save(), boxes };
}

/** Null when no passage can be read in the PDF's text, else why the copy fails. */
export async function verifyRedacted(pdf: Uint8Array, quotes: readonly string[]): Promise<string | null> {
  const doc = Document.open(await pdfium(), pdf);
  if (doc === null) return UNOPENABLE;
  try {
    for (let index = 0; index < doc.pageCount; index++) {
      const left = doc.page(index, (page) => matchedChars(page.chars().chars, quotes).size);
      if (left > 0) return `page ${index + 1}: withheld text is still readable after removal`;
    }
    return null;
  } finally {
    doc.close();
  }
}

/** This audience's file: the original, a redacted copy, or none, with the reason. */
export async function redactPdf(original: Uint8Array, request: RedactRequest, deps: RedactDeps = {}): Promise<RedactResult> {
  const image = request.image ?? 'show';
  const quotes = [...new Set(request.quotes.map((quote) => quote.trim()).filter((quote) => quote !== ''))];
  if (quotes.length === 0 && !request.redactsAny && image === 'show') return { kind: 'original' };
  const doc = Document.open(await pdfium(), original);
  if (doc === null) return { kind: 'refused', reason: UNOPENABLE };
  let redacted: { pdf: Uint8Array; boxes: Region[] } | string;
  try {
    redacted = redactPages(doc, quotes, image !== 'show');
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
  const left = (await verifyRedacted(pdf, quotes)) ?? (await checkCopy(pdf, quotes));
  return left === null ? { kind: 'redacted', pdf, boxes: redacted.boxes } : { kind: 'refused', reason: left };
}
