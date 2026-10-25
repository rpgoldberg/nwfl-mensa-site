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
// page's text (match.ts), every glyph in their widened regions is removed
// from the content (PDFium, form XObjects included) and an opaque box
// labelled "withheld" is drawn over each. Then the pages are rebuilt alone
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
//   - a passage has no position, or lies over a picture (removing the text
//     would leave the picture's pixels under the box);
//   - a content stream or a JPEG cannot be read, or a passage is still
//     readable after (PDFium), or the gate finds one or cannot check a stream.
// ============================================================================
import { checkCopy } from './gate.js';
import { type Box, type Region, matchedChars, regionsFor } from './match.js';
import { Document, type Page, pdfium } from './pdfium.js';
import { sanitize } from './sanitize.js';

export interface RedactRequest {
  /** The marked passages this audience's policy redacts. */
  quotes: readonly string[];
  /** Whether this audience's policy redacts any category: then even an unmarked file is never given as it is. */
  redactsAny: boolean;
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

const overlaps = (a: Region, b: { left: number; right: number; bottom: number; top: number }): boolean =>
  a.left < b.right && b.left < a.right && a.bottom < b.top && b.bottom < a.top;

/** Why one page cannot be given, or null once its passages are removed and boxed (added to `boxes`). */
function redactPage(doc: Document, index: number, quotes: readonly string[], boxes: Region[]): string | null {
  doc.flatten(index);
  return doc.page(index, (page) => {
    const { chars, unmapped } = page.chars();
    if (chars.length === 0 && page.objectCount > 0) return `page ${index + 1} has no text layer`;
    if (isScan(page)) return `page ${index + 1} is a scan: pictures cover most of it`;
    if (unmapped > 0) return `page ${index + 1} has text that cannot be read`;
    const found = regionsFor(chars, matchedChars(chars, quotes), index, page.width);
    if (!found.ok) return found.reason;
    if (found.regions.length === 0) return null;
    const pictures = page.pictures();
    if (found.regions.some((region) => pictures.some((picture) => overlaps(region, picture)))) {
      return `page ${index + 1}: a withheld passage lies over a picture`;
    }
    page.removeText(found.regions);
    page.drawBoxes(found.regions);
    boxes.push(...found.regions);
    return null;
  });
}

/** The document with the passages removed from every page, or why there can be no copy. */
function redactPages(doc: Document, quotes: readonly string[]): { pdf: Uint8Array; boxes: Region[] } | string {
  const boxes: Region[] = [];
  for (let index = 0; index < doc.pageCount; index++) {
    const refused = redactPage(doc, index, quotes, boxes);
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
export async function redactPdf(original: Uint8Array, request: RedactRequest): Promise<RedactResult> {
  const quotes = [...new Set(request.quotes.map((quote) => quote.trim()).filter((quote) => quote !== ''))];
  if (quotes.length === 0 && !request.redactsAny) return { kind: 'original' };
  const doc = Document.open(await pdfium(), original);
  if (doc === null) return { kind: 'refused', reason: UNOPENABLE };
  let redacted: { pdf: Uint8Array; boxes: Region[] } | string;
  try {
    redacted = redactPages(doc, quotes);
  } finally {
    doc.close();
  }
  if (typeof redacted === 'string') return { kind: 'refused', reason: redacted };
  let pdf: Uint8Array;
  try {
    pdf = await sanitize(redacted.pdf);
  } catch (error) {
    return { kind: 'refused', reason: error instanceof Error ? error.message : String(error) };
  }
  const left = (await verifyRedacted(pdf, quotes)) ?? (await checkCopy(pdf, quotes));
  return left === null ? { kind: 'redacted', pdf, boxes: redacted.boxes } : { kind: 'refused', reason: left };
}
