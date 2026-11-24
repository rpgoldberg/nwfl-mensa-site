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
// GATE-LAYOUT: a newsletter draws rectangles of its own in that very style (a
// calendar's black header cells, a bar behind a heading, a hairline rule), so
// the style alone does not make a box. The check is given the original, opens
// it itself (the gate takes nothing the engine says of it), flattens each
// page as the engine does and reads its rectangles in the boxes' style
// (layoutOf). A rectangle of the copy with exactly the bounds of one the
// original draws on the same page is the layout's, one for one in drawing
// order; every other is a box, under every rule above. So a rectangle the
// copy adds, moves, draws once more than the original or on another page is
// a box, and the engine's box drawn exactly on a rectangle of the original,
// in its place, is not: its label is then outside a box, and refused. An
// original that cannot be opened is refused.
// On a rectangle of the layout the labels' rules do not hold (its white
// heading is the newsletter's), and one does: a glyph nobody can see there is
// refused. That is a glyph drawn after the rectangle, its ink wholly inside
// it, that is dark (its fill's luminance under 0.1, under 3:1 against black)
// or not opaque (its fill or a form that draws it transparent, or its glyphs
// not filled), unless a shape drawn between the two covers its ink: a path
// directly on the page, filled opaque in a light colour (luminance 0.4 or
// over), at the identity, whose fill and every clip hold the ink and 0.1 pt
// round it (pdfium.ts Page.shape). Text hidden any other way is not this
// check's to find.
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
// font pdf-lib finds under that name in the page's resources is exactly the
// one PDFium writes for a label (/Type /Font /Subtype /Type1 /BaseFont
// /Helvetica /Encoding /WinAnsiEncoding, and no other key: no /Differences,
// /ToUnicode, /Widths or /FontDescriptor, nothing embedded), so its codes draw the glyphs
// they read as (BOXLABEL fix round 1, F1: a font's /Differences drew a quote
// under codes every text layer read as "Private"), and only from a content
// stream written as PDFium writes one (/Filter /FlateDecode alone, no
// /DecodeParms; F5). That font is the one pdf.js and PDFium find only because
// the callers read the labels after refusing any copy whose names pdf-lib
// reads apart from them, or whose names cannot all be read (pdf-structure.ts
// nameBreak, round 3, R3-1: pdf-lib decodes a name's #XX twice, the readers
// once; round 4, B1: it fails closed): the gate in gateVerdict and gateReply,
// the engine in redactPdf; unlabelled itself does not check.
// The glyph check (drawn.ts) takes a label out besides only where pdf.js's
// glyphs and their text both spell it, once per label
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
import { Document, type LabelReading, type Outline, type Shape, pdfium } from './pdfium.js';

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

/** A glyph's fill under this luminance is under 3:1 against black (WCAG contrast (L + 0.05) / 0.05): unseen on it. */
const DARK = 0.1;
/** A shape's fill at this luminance or over is 3:1 or more against any glyph under DARK: it shows the glyph. */
const LIGHT = 0.4;
/** How far past a glyph's ink a shape must reach, on every side, to cover it: more than the chords of a curve miss by. */
const COVER_MARGIN = 0.1;

const UNREAD_ORIGINAL = 'the original could not be opened to read its layout';

/** Whether the line from (x1, y1) to (x2, y2) meets the box, its edge included (Liang and Barsky's clip). */
function meetsBox(box: Box, x1: number, y1: number, x2: number, y2: number): boolean {
  let from = 0;
  let to = 1;
  const sides: ReadonlyArray<readonly [number, number]> = [
    [x1 - x2, x1 - box.left],
    [x2 - x1, box.right - x1],
    [y1 - y2, y1 - box.bottom],
    [y2 - y1, box.top - y1],
  ];
  for (const [p, q] of sides) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) from = Math.max(from, t);
    else to = Math.min(to, t);
    if (from > to) return false;
  }
  return true;
}

/**
 * Whether an outline's fill holds the whole box: no edge of it meets the box, so the box lies wholly in or wholly
 * out, and its corner lies in. `evenOdd`: by that rule, or by the nonzero winding rule; null: by both (a clip, whose
 * rule PDFium does not give).
 */
function fills(outline: Outline, evenOdd: boolean | null, box: Box): boolean {
  let winding = 0;
  let crossings = 0;
  for (const ring of outline) {
    for (const [i, [x1, y1]] of ring.entries()) {
      const [x2, y2] = ring[(i + 1) % ring.length] as [number, number];
      if (meetsBox(box, x1, y1, x2, y2)) return false;
      // A ray from the box's corner to the right: each edge it crosses, and which way that edge runs.
      if (y1 <= box.bottom === y2 <= box.bottom || x1 + ((box.bottom - y1) * (x2 - x1)) / (y2 - y1) <= box.left) continue;
      winding += y2 > y1 ? 1 : -1;
      crossings += 1;
    }
  }
  const odd = crossings % 2 === 1;
  return evenOdd === null ? odd && winding !== 0 : evenOdd ? odd : winding !== 0;
}

/** Whether a shape covers a glyph's ink whole, and a margin round it: its fill holds it, and so does every clip on it. */
function covers(shape: Shape, ink: Box): boolean {
  const area = { left: ink.left - COVER_MARGIN, right: ink.right + COVER_MARGIN, bottom: ink.bottom - COVER_MARGIN, top: ink.top + COVER_MARGIN };
  return fills(shape.outline, shape.evenOdd, area) && shape.clips.every((clip) => fills(clip, null, area));
}

const boundsKey = ({ left, right, bottom, top }: Box): string => `${left},${right},${bottom},${top}`;

/**
 * One page's labels, or why they are not the engine's (see the header). `layout`: the rectangles the original draws
 * on this page in the boxes' style (layoutOf); `shapeAt`: the page's object at a place in its drawing order, as a
 * shape that hides what is under it (pdfium.ts Page.shape).
 */
export function pageLabels(reading: LabelReading, chars: readonly PageChar[], index: number, layout: readonly Box[], shapeAt: (at: number) => Shape | null): PlacedLabel[] | string {
  const where = `page ${index + 1}`;
  const outside = `${where}: a label is drawn outside a box`;
  const other = `${where}: text other than its label is in a box`;
  if (reading.nested > 0) return outside;
  // The original's rectangles not yet found in the copy, by their bounds: each excuses one rectangle of the copy.
  const spare = new Map<string, number>();
  for (const box of layout) spare.set(boundsKey(box), (spare.get(boundsKey(box)) ?? 0) + 1);
  const boxes: Array<{ at: number; bounds: Box; held: number }> = [];
  const ruled: Array<{ at: number; bounds: Box }> = [];
  const labels = new Set<number>();
  const out: PlacedLabel[] = [];
  for (const [at, mark] of reading.top.entries()) {
    if (mark.kind === 'box') {
      const left = spare.get(boundsKey(mark.bounds)) ?? 0;
      if (left > 0) {
        spare.set(boundsKey(mark.bounds), left - 1);
        ruled.push({ at, bounds: mark.bounds });
      } else boxes.push({ at, bounds: mark.bounds, held: 0 });
    }
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
  const shapes = new Map<number, Shape | null>();
  const shape = (at: number): Shape | null => {
    if (!shapes.has(at)) shapes.set(at, shapeAt(at));
    return shapes.get(at) ?? null;
  };
  /** Whether a light shape drawn after the rectangle at `from` and before the glyph's object at `to` covers the ink. */
  const shown = (from: number, to: number, ink: Box): boolean => {
    for (let at = from + 1; at < to; at++) {
      const found = shape(at);
      if (found !== null && found.luminance >= LIGHT && covers(found, ink)) return true;
    }
    return false;
  };
  for (const [i, c] of chars.entries()) {
    const place = c.box ?? c.ink;
    if (c.generated || place === null || /^\s*$/u.test(c.text) || labels.has(reading.owners[i] ?? 0)) continue;
    const drawnAt = reading.places[i] ?? -1;
    // Any other glyph drawn over a box (after it), with its centre in the box. One drawn before it, under the opaque box,
    // is hidden by it: as before the labels, the leak checks read it.
    if (boxes.some((box) => (drawnAt < 0 || box.at < drawnAt) && centreIn(box.bounds, place))) return other;
    // A glyph nobody can see on a rectangle of the original (GATE-LAYOUT): dark or not opaque, its ink wholly inside
    // the rectangle, drawn after it, and no light shape drawn between the two under it.
    const paint = reading.paints[i];
    if (paint !== undefined && paint.opaque && paint.luminance >= DARK) continue;
    const ink = c.ink ?? place;
    const end = drawnAt < 0 ? reading.top.length : drawnAt;
    if (ruled.some((rule) => rule.at < end && holds(rule.bounds, ink) && !shown(rule.at, end, ink))) return `${where}: text nobody can see lies on a black rectangle of the original`;
  }
  return out;
}

/**
 * Each page of the original's rectangles in the boxes' style (0-based), or why they cannot be read. Each page is
 * flattened first, as the engine flattens it (redact.ts redactPage), so what an annotation draws is read as the
 * copy holds it.
 */
export async function layoutOf(original: Uint8Array): Promise<Box[][] | string> {
  const doc = Document.open(await pdfium(), original);
  if (doc === null) return UNREAD_ORIGINAL;
  try {
    const out: Box[][] = [];
    for (let index = 0; index < doc.pageCount; index++) {
      doc.flatten(index);
      out.push(doc.page(index, (page) => page.boxes()));
    }
    return out;
  } finally {
    doc.close();
  }
}

/**
 * Each page's labels (0-based), or why the copy's labels are not the engine's: see the header. `original`: the file
 * the copy was made from, whose own rectangles in the boxes' style are not boxes (layoutOf); a page the original has
 * not has none.
 */
export async function labelMarks(pdf: Uint8Array, original: Uint8Array): Promise<PlacedLabel[][] | string> {
  const layout = await layoutOf(original);
  if (typeof layout === 'string') return layout;
  const doc = Document.open(await pdfium(), pdf);
  if (doc === null) return 'the copy could not be opened to read its labels';
  try {
    const out: PlacedLabel[][] = [];
    for (let index = 0; index < doc.pageCount; index++) {
      const found = doc.page(index, (page) => pageLabels(page.labelReading(), page.chars().chars, index, layout[index] ?? [], (at) => page.shape(at)));
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
 * A content op's name operand as pdf-lib's parser reads the same name in a dictionary: each #XX decoded in either case
 * (R2-1: PDFName.of alone decodes only upper-case #XX), then PDFName.of, which decodes upper-case #XX a second time.
 * pdf.js and PDFium decode once, so for a name that still holds '#' after the first pass this is not what they read
 * (R3-1); no copy holding one reaches the label check (pdf-structure.ts nameBreak). LABEL_OP admits no '#', so for a
 * label this changes nothing.
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
