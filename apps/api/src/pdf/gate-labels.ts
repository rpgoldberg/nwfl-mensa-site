// ============================================================================
// BOXLABEL: the labels in a copy (labels.ts), as the engine and the output
// gate read them. The gate does not trust the engine that drew them.
//
// PDFium reads each page's objects (pdfium.ts labelReading). A box is a path
// in the boxes' style (one rectangle, drawn round its corners and closed as
// "re" draws it, filled even-odd, not stroked, opaque black, at the
// identity); a label is a text object that reads exactly as "Members Only",
// "Mbrs Only" or "Private" in white non-embedded Helvetica.
// The copy's labels are refused (labelMarks gives the reason) when:
//   - a label is drawn in a form XObject, or directly on the page where no
//     box drawn before it holds it: a label outside a box;
//   - text in the labels' font and colour that a box holds is not exactly a
//     label (any other string, the old "withheld", another case or spelling,
//     text PDFium does not read), or a label is not in the labels' style
//     (its glyphs filled, opaque, moved but not scaled or turned, at least
//     MIN_LABEL_PT), or a box holds more than one label;
//   - any other glyph drawn over a box (after it, on the page or in a form)
//     has its centre in it: text other than its label in a box.
// A glyph drawn before a box lies under it, hidden: the engine leaves one
// there only when PDFium could not remove it (an invisible copy, before as
// now), and the leak checks read it like any other.
//
// The leak checks (gate.ts checkCopy, drawn.ts's glyphs, the engine's own
// PDFium reading) do not count the labels' text (leakBreak). A check that
// finds withheld text in a copy whose labels pass is run once more on the
// copy with exactly those labels' text taken out (unlabelled): in the page's
// own content, each label's string in the very bytes PDFium writes for a
// label at that label's place, as many as PDFium read there and no more, is
// turned to spaces. Nothing else of the copy changes. It is taken out only
// when that op names its font in letters and digits, as PDFium does (no #XX
// escape, which pdf-lib and the readers decode apart: round 2, R2-1), and the
// font that name finds in the page's resources is exactly the one
// PDFium writes for a label (/Type /Font /Subtype /Type1 /BaseFont /Helvetica
// /Encoding /WinAnsiEncoding, and no other key: no /Differences, /ToUnicode,
// /Widths or /FontDescriptor, nothing embedded), so its codes draw the glyphs
// they read as (BOXLABEL fix round 1, F1: a font's /Differences drew a quote
// under codes every text layer read as "Private"), and only from a content
// stream written as PDFium writes one (/Filter /FlateDecode alone, no
// /DecodeParms; F5). The glyph check (drawn.ts) takes a label out besides
// only where pdf.js's glyphs and their text both spell it, once per label
// (F1, defence in depth). A copy whose labels fail, or whose label bytes are
// not found so, is judged as it is. So the exemption is exactly those
// strings, drawn as themselves, inside boxes; a label string drawn anywhere
// else, once more than PDFium read labels, or in any other font, is still
// read.
// ============================================================================
import { PDFArray, PDFDict, PDFDocument, PDFName, type PDFObject, PDFRawStream, PDFRef } from '@cantoo/pdf-lib';
import { decodePDFRawStream } from '@cantoo/pdf-lib';
import { type Label, isLabel } from './labels.js';
import type { Box, PageChar } from './match.js';
import { Document, type LabelReading, pdfium } from './pdfium.js';

/** A label as read from a copy: its text, and its place (the origin PDFium draws it from). */
export interface PlacedLabel {
  text: Label;
  x: number;
  y: number;
}

/** How far a glyph's centre must be inside a box to count as in it, and a label inside its box, in points. */
const SLACK = 0.01;

/** Whether `outer` holds `inner`, to SLACK. */
const holds = (outer: Box, inner: Box): boolean =>
  inner.left >= outer.left - SLACK && inner.right <= outer.right + SLACK && inner.bottom >= outer.bottom - SLACK && inner.top <= outer.top + SLACK;
const centreIn = (box: Box, { left, right, bottom, top }: Box): boolean => {
  const x = (left + right) / 2;
  const y = (bottom + top) / 2;
  return x > box.left + SLACK && x < box.right - SLACK && y > box.bottom + SLACK && y < box.top - SLACK;
};

/** One page's labels, or why they are not the engine's (see the header). */
export function pageLabels(reading: LabelReading, chars: readonly PageChar[], index: number): PlacedLabel[] | string {
  const where = `page ${index + 1}`;
  const outside = `${where}: a label is drawn outside a box`;
  const other = `${where}: text other than its label is in a box`;
  if (reading.nested > 0) return outside;
  const boxes: Array<{ at: number; bounds: Box; held: number }> = [];
  const labels = new Set<number>();
  const out: PlacedLabel[] = [];
  for (const [at, mark] of reading.top.entries()) {
    if (mark.kind === 'box') boxes.push({ at, bounds: mark.bounds, held: 0 });
    if (mark.kind !== 'lettering') continue;
    // Held by a box drawn before it: a label, and nothing else, in the labels' style, one to a box.
    const box = boxes.find((b) => holds(b.bounds, mark.bounds));
    if (box === undefined) {
      if (isLabel(mark.text)) return outside;
      continue;
    }
    if (!isLabel(mark.text)) return other;
    if (!mark.styled) return `${where}: a label is not in the labels' style`;
    if (++box.held > 1) return `${where}: a box holds more than one label`;
    labels.add(mark.object);
    out.push({ text: mark.text, x: mark.x, y: mark.y });
  }
  // Any other glyph drawn over a box (after it), with its centre in the box. One drawn before it, under the opaque box, is
  // hidden by it: as before the labels, the leak checks read it.
  for (const [i, c] of chars.entries()) {
    const place = c.box ?? c.ink;
    if (c.generated || place === null || /^\s*$/u.test(c.text) || labels.has(reading.owners[i] ?? 0)) continue;
    const drawnAt = reading.places[i] ?? -1;
    if (boxes.some((box) => (drawnAt < 0 || box.at < drawnAt) && centreIn(box.bounds, place))) return other;
  }
  return out;
}

/** Each page's labels (0-based), or why the copy's labels are not the engine's: see the header. */
export async function labelMarks(pdf: Uint8Array): Promise<PlacedLabel[][] | string> {
  const doc = Document.open(await pdfium(), pdf);
  if (doc === null) return 'the copy could not be opened to read its labels';
  try {
    const out: PlacedLabel[][] = [];
    for (let index = 0; index < doc.pageCount; index++) {
      const found = doc.page(index, (page) => pageLabels(page.labelReading(), page.chars().chars, index));
      if (typeof found === 'string') return found;
      out.push(found);
    }
    return out;
  } finally {
    doc.close();
  }
}

/**
 * A label as PDFium writes it (pdfium.ts drawBoxes, then GenerateContent): its place, its font's name and its size,
 * and its text in hex. PDFium names the font FXF<n>, so the name is letters and digits only: an op whose name has a
 * #XX escape, which the readers and pdf-lib decode apart (round 2, R2-1), is not a label's.
 */
const LABEL_OP = /q 1 1 1 rg 0 G 1 0 0 1 (-?\d*\.?\d+) (-?\d*\.?\d+) cm BT 1 0 0 1 0 0 Tm \/([A-Za-z0-9]+) \d*\.?\d+ Tf 0 Tr <([0-9A-F]+)> Tj ET Q/g;
const hexOf = (text: string): string => Buffer.from(text, 'latin1').toString('hex').toUpperCase();

/** A page's content streams, each by its reference. */
function contentRefs(doc: PDFDocument, value: PDFObject | undefined): PDFRef[] {
  const found = value instanceof PDFRef ? doc.context.lookup(value) : value;
  if (found instanceof PDFArray) return found.asArray().flatMap((item) => contentRefs(doc, item));
  return value instanceof PDFRef && found instanceof PDFRawStream ? [value] : [];
}

/** The font PDFium writes for a label, every key and value of it (F1). */
const LABEL_FONT: ReadonlyArray<[string, string]> = [
  ['Type', 'Font'],
  ['Subtype', 'Type1'],
  ['BaseFont', 'Helvetica'],
  ['Encoding', 'WinAnsiEncoding'],
];

/**
 * A content op's name operand as pdf-lib's parser reads the same name in a dictionary: each #XX decoded in either
 * case, as pdf.js and PDFium decode it, then PDFName.of. PDFName.of alone decodes only upper-case #XX (R2-1). LABEL_OP
 * admits no '#', so for a label this changes nothing; it keeps the lookup right if that ever changes.
 */
export function opFontName(name: string): PDFName {
  return PDFName.of(name.replace(/#([0-9A-Fa-f]{2})/g, (_escape, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))));
}

/** Whether `name` in these fonts is exactly the font PDFium writes for a label (LABEL_FONT, each value a direct name, and no other key). */
function labelFont(doc: PDFDocument, fonts: PDFObject | undefined, name: string): boolean {
  const list = doc.context.lookup(fonts);
  const font = list instanceof PDFDict ? doc.context.lookup(list.get(opFontName(name))) : undefined;
  if (!(font instanceof PDFDict) || font.keys().length !== LABEL_FONT.length) return false;
  return LABEL_FONT.every(([key, value]) => {
    const found = font.get(PDFName.of(key));
    return found instanceof PDFName && found.decodeText() === value;
  });
}

/** Whether a content stream is written as PDFium writes one: /Filter /FlateDecode alone, and no /DecodeParms (F5). */
function plainFlate(stream: PDFRawStream): boolean {
  const filter = stream.dict.get(PDFName.of('Filter'));
  return filter instanceof PDFName && filter.decodeText() === 'FlateDecode' && !stream.dict.has(PDFName.of('DecodeParms'));
}

/**
 * The copy with exactly these labels' text turned to spaces (see the header), or null when there are none, or one of
 * them is not found in its page's own content, written as PDFium writes a label, at its place, in PDFium's own label
 * font (F1), in a content stream PDFium would write (F5).
 */
export async function unlabelled(pdf: Uint8Array, labels: readonly PlacedLabel[][]): Promise<Uint8Array | null> {
  if (labels.every((page) => page.length === 0)) return null;
  const doc = await PDFDocument.load(pdf, { updateMetadata: false, throwOnInvalidObject: true });
  const pages = doc.getPages();
  if (pages.length !== labels.length) return null;
  for (const [index, placed] of labels.entries()) {
    if (placed.length === 0) continue;
    const page = pages[index] as (typeof pages)[number];
    // The page's resources as PDFium and pdf.js read them: its own, or the nearest ancestor's.
    const resources = doc.context.lookup(page.node.getInheritableAttribute(PDFName.of('Resources')));
    const fonts = resources instanceof PDFDict ? resources.get(PDFName.of('Font')) : undefined;
    const streams = contentRefs(doc, page.node.get(PDFName.of('Contents'))).map((ref) => {
      const raw = doc.context.lookup(ref) as PDFRawStream;
      // Only a stream PDFium would write is read for labels: in any other, none is found.
      return { ref, text: plainFlate(raw) ? Buffer.from(decodePDFRawStream(raw).decode()).toString('latin1') : '', changed: false };
    });
    for (const label of placed) {
      const hex = hexOf(label.text);
      let done = false;
      for (const stream of streams) {
        for (const op of stream.text.matchAll(LABEL_OP)) {
          if (op[4] !== hex || Math.abs(Number(op[1]) - label.x) > SLACK || Math.abs(Number(op[2]) - label.y) > SLACK) continue;
          if (!labelFont(doc, fonts, op[3] as string)) return null;
          const at = op.index + op[0].lastIndexOf(`<${hex}>`) + 1;
          stream.text = stream.text.slice(0, at) + '20'.repeat(hex.length / 2) + stream.text.slice(at + hex.length);
          stream.changed = true;
          done = true;
          break;
        }
        if (done) break;
      }
      if (!done) return null;
    }
    for (const stream of streams) if (stream.changed) doc.context.assign(stream.ref, doc.context.flateStream(Buffer.from(stream.text, 'latin1')));
  }
  return doc.save({ useObjectStreams: false });
}

/**
 * What `check` finds in the copy, not counting its labels' text (see the header): null when it finds nothing, or
 * finds something only in labels that pass (`labels`, from labelMarks). Else what it found in the copy as it is. The
 * second run is handed the labels as well, so a check that reads glyphs (drawn.ts) can take out only those whose
 * glyphs spell them (F1).
 */
export async function leakBreak<T>(
  pdf: Uint8Array,
  labels: PlacedLabel[][] | string,
  check: (bytes: Uint8Array, labels?: readonly PlacedLabel[][]) => Promise<T | null>,
): Promise<T | null> {
  const found = await check(pdf);
  if (found === null || typeof labels === 'string') return found;
  const masked = await unlabelled(pdf, labels);
  return masked === null ? found : check(masked, labels);
}
