// GATE-LAYOUT: a newsletter draws black rectangles of its own (a calendar's header cells, a bar behind a
// heading, a hairline rule) in the very style of the engine's boxes. The label check tells them from the boxes by
// the original: a rectangle the original draws on the same page at the same bounds is layout, one for one, and
// every other one is a box under every rule there was. Text nobody can see on such a rectangle (dark, or not
// opaque) is refused, unless a light shape drawn between the two shows it. Every name is made up. These PDFs are
// adversarial in shape: run this file only in the capped container.
import { PDFDict, PDFDocument, PDFName } from '@cantoo/pdf-lib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type PlacedLabel, labelMarks, layoutOf, pageLabels } from '../../src/pdf/gate-labels.js';
import { gateReply, gateVerdict } from '../../src/pdf/gate-rules.js';
import type { ImageAction } from '../../src/pdf/images.js';
import type { Box, PageChar } from '../../src/pdf/match.js';
import { Document, type LabelReading, type Shape, luminance, pdfium } from '../../src/pdf/pdfium.js';
import { type RedactResult, redactPdf } from '../../src/pdf/redact.js';
import { type PageOptions, askLine, fitPdf } from './fit-fixtures.js';

const OTHER = (page = 1): string => `page ${page}: text other than its label is in a box`;
const OUTSIDE = 'page 1: a label is drawn outside a box';
const UNSEEN = (page = 1): string => `page ${page}: text nobody can see lies on a black rectangle of the original`;
const UNREAD = 'the original could not be opened to read its layout';
const MEMBERS = { text: 'Members Only', x: expect.any(Number) as unknown, y: expect.any(Number) as unknown };

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** A header cell: awkward numbers, so a rectangle PDFium writes again must still read as it did. */
const CELL: Rect = { x: 210.3711, y: 84.6137, w: 105.2933, h: 43.4719 };
/** A black rectangle in the boxes' own style, as Publisher draws a header cell. */
const cell = (r: Rect = CELL): string => `0 g ${r.x} ${r.y} ${r.w} ${r.h} re f*`;
/** A word on the header cell, wholly inside it, in this paint. */
const onCell = (paint: string, text = 'Monday', font = 'F2'): string => `q ${paint} BT /${font} 14 Tf ${CELL.x + 20} ${CELL.y + 16} Td (${text}) Tj ET Q`;
const WHITE = '1 g';
/** "Ask Quillon Brask now." below the cell, clear of it. */
const BODY = askLine('(Quillon Brask) Tj', { y: 40 });
const QUOTE = ['Quillon Brask'];
const page = (parts: readonly string[], options?: PageOptions): Promise<Uint8Array> => fitPdf(parts.join('\n'), options);

const redact = (original: Uint8Array, quotes: readonly string[] = [], image: ImageAction = 'show'): Promise<RedactResult> =>
  redactPdf(original, { quotes: [...quotes], membersWithhold: quotes.map(() => false), redactsAny: true, image });
const copyOf = (result: RedactResult): Uint8Array => {
  if (result.kind !== 'redacted') throw new Error(`expected a redacted copy, got ${JSON.stringify(result)}`);
  return result.pdf;
};
const refusal = (result: RedactResult): string => {
  if (result.kind !== 'refused') throw new Error(`expected a refusal, got ${result.kind}`);
  return result.reason;
};
const verdict = (copy: Uint8Array, original: Uint8Array, quotes: readonly string[] = [], image: ImageAction = 'show') => gateVerdict({ copy, original, quotes, image });

/** One PDF of the first page of each. */
async function pagesOf(...pdfs: Uint8Array[]): Promise<Uint8Array> {
  const out = await PDFDocument.create({ updateMetadata: false });
  for (const pdf of pdfs) {
    const [copied] = await out.copyPages(await PDFDocument.load(pdf, { updateMetadata: false }), [0]);
    out.addPage(copied);
  }
  return out.save({ useObjectStreams: false });
}

/** The copy with `content(font)` drawn after everything on its page, `font` being a font the page has. */
async function appended(pdf: Uint8Array, content: (font: string) => string, index = 0, more?: (doc: PDFDocument) => void): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const node = doc.getPage(index).node;
  const fonts = node.Resources()?.lookup(PDFName.of('Font'), PDFDict) as PDFDict;
  // Helvetica, not embedded: the font the labels are drawn in.
  const font = (fonts.keys().find((key) => (fonts.lookup(key, PDFDict).get(PDFName.of('BaseFont')) as PDFName).decodeText() === 'Helvetica') as PDFName).decodeText();
  const old = node.get(PDFName.of('Contents'));
  const before = doc.context.lookup(old);
  const added = doc.context.register(doc.context.flateStream(`\n${content(font)}`));
  node.set(PDFName.of('Contents'), doc.context.obj([...('asArray' in (before as object) ? (before as unknown as { asArray(): unknown[] }).asArray() : [old]), added] as never));
  more?.(doc);
  return doc.save({ useObjectStreams: false });
}

/** The box-style rectangles PDFium reads directly on a page. */
async function rectangles(pdf: Uint8Array, index = 0): Promise<Box[]> {
  const doc = Document.open(await pdfium(), pdf);
  if (doc === null) throw new Error('unopenable');
  try {
    return doc.page(index, (p) => p.boxes());
  } finally {
    doc.close();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a black rectangle the original draws is layout, not a box', () => {
  const calendar = (): Promise<Uint8Array> => page([cell(), onCell(WHITE), BODY]);

  it.each<[string, readonly string[], ImageAction]>([
    ['nothing marked', [], 'show'],
    ['a quote marked elsewhere on the page', QUOTE, 'show'],
    ['a quote marked elsewhere, the pictures hidden (every stream written again)', QUOTE, 'hide'],
  ])('makes a copy of header cells with white text on them, labelled, and the gate passes it: %s', async (_name, quotes, image) => {
    const original = await calendar();
    const copy = copyOf(await redact(original, quotes, image));
    expect(await labelMarks(copy, original)).toEqual([quotes.length === 0 ? [] : [MEMBERS]]);
    const reply = await gateReply({ copy, original, quotes, image });
    expect(reply.verdict).toEqual({ pass: true });
    // The cell is still there, where the original drew it.
    expect(await rectangles(copy)).toEqual(expect.arrayContaining(await rectangles(original)));
  });

  it('reads the same rectangles after PDFium writes a page of them again (twenty cells at awkward places)', async () => {
    const cells = Array.from({ length: 20 }, (_, i) => ({ x: 12.3457 + (i % 5) * 71.1113, y: 62.7191 + Math.floor(i / 5) * 18.4447, w: 65.0071 + i * 0.1379, h: 14.2223 + i * 0.0613 }));
    const words = cells.map((c, i) => `q 1 g BT /F2 8 Tf ${c.x + 4} ${c.y + 4} Td (Day ${i}) Tj ET Q`);
    const original = await page([...cells.map(cell), ...words, askLine('(Quillon Brask) Tj', { y: 20 })]);
    const copy = copyOf(await redact(original, QUOTE));
    expect(await labelMarks(copy, original)).toEqual([[MEMBERS]]);
    expect(await verdict(copy, original, QUOTE)).toEqual({ pass: true });
    const drawn = await rectangles(copy);
    for (const rect of await rectangles(original)) expect(drawn).toContainEqual(rect);
  });

  it('takes the same rectangle and text drawn twice, as Publisher draws them', async () => {
    const original = await page([cell(), onCell(WHITE), cell(), onCell(WHITE), BODY]);
    const copy = copyOf(await redact(original, QUOTE));
    expect(await labelMarks(copy, original)).toEqual([[MEMBERS]]);
    expect(await verdict(copy, original, QUOTE)).toEqual({ pass: true });
  });

  it('takes a hairline rule through the centre of a black glyph', async () => {
    // "H" at 5 pt spans 249 to 252.6; the rule, 0.6 pt wide, runs through its middle.
    const original = await page(['0 g 250.5 85 0.6 31.4 re f*', 'BT /F1 5 Tf 249 99 Td 0 g (H) Tj ET', BODY]);
    const copy = copyOf(await redact(original, QUOTE));
    expect(await labelMarks(copy, original)).toEqual([[MEMBERS]]);
    expect(await verdict(copy, original, QUOTE)).toEqual({ pass: true });
    expect(await verdict(copyOf(await redact(original)), original)).toEqual({ pass: true });
  });

  it('reads a rectangle an annotation draws as the engine does: the gate flattens each page of the original first', async () => {
    const plain = await page([BODY]);
    const doc = await PDFDocument.load(plain, { updateMetadata: false });
    const look = doc.context.register(doc.context.flateStream('0 g 0 0 60 30 re f*', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 60, 30] }));
    const annot = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Square', Rect: [300, 90, 360, 120], F: 4, AP: { N: look } }));
    doc.getPage(0).node.set(PDFName.of('Annots'), doc.context.obj([annot]));
    const original = await doc.save({ useObjectStreams: false });
    const copy = copyOf(await redact(original, QUOTE));
    const flatten = vi.spyOn(Document.prototype, 'flatten');
    expect(await labelMarks(copy, original)).toEqual([[MEMBERS]]);
    expect(flatten.mock.calls).toEqual([[0]]);
    expect(await layoutOf(original)).toEqual([await rectangles(copy)].map((boxes) => boxes.slice(0, -1)));
    expect(await verdict(copy, original, QUOTE)).toEqual({ pass: true });
  });

  it('flattens every page of the original, and reads each page\'s rectangles apart', async () => {
    const original = await pagesOf(await calendar(), await page([BODY]));
    const flatten = vi.spyOn(Document.prototype, 'flatten');
    const layout = await layoutOf(original);
    expect(flatten.mock.calls).toEqual([[0], [1]]);
    expect(layout).toEqual([await rectangles(original, 0), []]);
    expect((layout as Box[][])[0]).toHaveLength(1);
  });
});

describe('every other rectangle is still a box: the rules hold as they did', () => {
  it('refuses our own box drawn exactly on a rectangle of the original: its label is outside any box', async () => {
    const plain = await page([BODY]);
    const copy = copyOf(await redact(plain, QUOTE));
    const [box] = (await rectangles(copy)) as [Box];
    // An original that draws a black rectangle at the very bounds of the engine's box: a width and a height that,
    // added in single precision as PDFium adds them, give its right and its top exactly.
    const span = (from: number, to: number): number => {
      for (let w = Math.fround(to - from), n = 0; n < 8; n++, w = Math.fround(w * (1 + 2 ** -23))) if (Math.fround(from + w) === to) return w;
      for (let w = Math.fround(to - from), n = 0; n < 8; n++, w = Math.fround(w * (1 - 2 ** -24))) if (Math.fround(from + w) === to) return w;
      throw new Error('no such span');
    };
    const under = `0 g ${box.left} ${box.bottom} ${span(box.left, box.right)} ${span(box.bottom, box.top)} re f*`;
    const original = await page([under, BODY]);
    expect(await rectangles(original)).toEqual([box]);
    expect(await labelMarks(copy, plain)).toEqual([[MEMBERS]]);
    expect(await labelMarks(copy, original)).toBe(OUTSIDE);
    expect(await verdict(copy, original, QUOTE)).toEqual({ pass: false, code: 'rules' });
    // The engine, of that original, fails closed: the redaction takes the original's rectangle away with the text
    // under the box, so the one rectangle left is taken for the original's and its label is outside any box.
    expect(refusal(await redact(original, QUOTE))).toBe(OUTSIDE);
  });

  it('refuses text over a rectangle the copy adds', async () => {
    const copy = copyOf(await redact(await page([cell(), onCell(WHITE), BODY]), QUOTE));
    const original = await page([BODY]);
    expect(await labelMarks(copy, original)).toBe(OTHER());
    expect(await verdict(copy, original, QUOTE)).toEqual({ pass: false, code: 'rules' });
  });

  it('refuses text over a rectangle the copy draws once more than the original does', async () => {
    const twice = await page([cell(), cell(), onCell(WHITE), BODY]);
    const copy = copyOf(await redact(twice, QUOTE));
    expect(await labelMarks(copy, twice)).toEqual([[MEMBERS]]);
    const once = await page([cell(), onCell(WHITE), BODY]);
    expect(await labelMarks(copy, once)).toBe(OTHER());
    expect(await verdict(copy, once, QUOTE)).toEqual({ pass: false, code: 'rules' });
  });

  it('refuses text over a rectangle the original draws only on another page', async () => {
    const calendar = await page([cell(), onCell(WHITE), BODY]);
    const bare = await page([onCell(WHITE), BODY]);
    const both = await pagesOf(calendar, calendar);
    const copy = copyOf(await redact(both, QUOTE));
    expect(await labelMarks(copy, both)).toEqual([[MEMBERS], [MEMBERS]]);
    expect(await labelMarks(copy, await pagesOf(calendar, bare))).toBe(OTHER(2));
    expect(await labelMarks(copy, await pagesOf(bare, calendar))).toBe(OTHER(1));
    expect(await verdict(copy, await pagesOf(calendar, bare), QUOTE)).toEqual({ pass: false, code: 'rules' });
    // A copy with a page the original has not: no rectangle on it is layout.
    expect(await labelMarks(copy, calendar)).toBe(OTHER(2));
  });

  it.each([
    ['left', { x: CELL.x + 0.02 }],
    ['bottom', { y: CELL.y + 0.02 }],
    ['width', { w: CELL.w + 0.02 }],
    ['height', { h: CELL.h + 0.02 }],
  ])('does not match a rectangle whose %s is 0.02 pt off', async (_name, change) => {
    const copy = copyOf(await redact(await page([cell(), onCell(WHITE), BODY]), QUOTE));
    const moved = await page([cell({ ...CELL, ...change }), onCell(WHITE), BODY]);
    expect(await labelMarks(copy, moved)).toBe(OTHER());
    expect(await verdict(copy, moved, QUOTE)).toEqual({ pass: false, code: 'rules' });
  });

  it('refuses a label drawn on a rectangle of the original', async () => {
    const original = await page([cell(), onCell(WHITE), BODY]);
    const copy = copyOf(await redact(original, QUOTE));
    const bad = await appended(copy, (font) => `q 1 1 1 rg 0 G 1 0 0 1 ${CELL.x + 30} ${CELL.y + 3} cm BT 1 0 0 1 0 0 Tm /${font} 9 Tf 0 Tr (Private) Tj ET Q`);
    expect(await labelMarks(bad, original)).toBe(OUTSIDE);
    expect(await verdict(bad, original, QUOTE)).toEqual({ pass: false, code: 'rules' });
  });

  it('refuses, as "rules", a copy whose original cannot be opened to read its layout', async () => {
    const original = await page([cell(), onCell(WHITE), BODY]);
    const copy = copyOf(await redact(original, QUOTE));
    const garbage = new TextEncoder().encode('not a PDF at all');
    expect(await labelMarks(copy, garbage)).toBe(UNREAD);
    expect(await layoutOf(garbage)).toBe(UNREAD);
    expect(await verdict(copy, garbage, QUOTE)).toEqual({ pass: false, code: 'rules' });
    expect((await gateReply({ copy, original: garbage, quotes: QUOTE, image: 'show' })).verdict).toEqual({ pass: false, code: 'rules' });
  });
});

describe('text nobody can see on a rectangle of the original is refused', () => {
  /** A white shape under the word on the cell. */
  const COVER: Rect = { x: CELL.x + 10, y: CELL.y + 6, w: 80, h: 30 };
  const rect = (r: Rect): string => `${r.x} ${r.y} ${r.w} ${r.h} re`;
  /** An ellipse round `r`, drawn as four curves (as Publisher draws a callout). */
  const ellipse = (r: Rect): string => {
    const [cx, cy, rx, ry, k] = [r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0.5523];
    return `${cx + rx} ${cy} m ${cx + rx} ${cy + k * ry} ${cx + k * rx} ${cy + ry} ${cx} ${cy + ry} c ${cx - k * rx} ${cy + ry} ${cx - rx} ${cy + k * ry} ${cx - rx} ${cy} c ${cx - rx} ${cy - k * ry} ${cx - k * rx} ${cy - ry} ${cx} ${cy - ry} c ${cx + k * rx} ${cy - ry} ${cx + rx} ${cy - k * ry} ${cx + rx} ${cy} c h`;
  };
  const GS = { extGState: { Type: 'ExtGState', ca: 0.5, CA: 0.5 } };

  const UNSEEN_PAINTS: ReadonlyArray<[string, string, PageOptions?]> = [
    ['black', '0 g'],
    ['0.05 grey', '0.05 g'],
    ['dark blue, under 3:1 on black', '0 0 0.6 rg'],
    ['half-transparent white', '/GS0 gs 1 g', GS],
    ['white, not drawn at all (3 Tr)', '1 g 3 Tr'],
    ['white, stroked only in black (1 Tr)', '1 g 0 G 1 Tr'],
  ];

  it.each(UNSEEN_PAINTS)('refuses %s text wholly inside one, in the engine and in the gate', async (_name, paint, options) => {
    const original = await page([cell(), onCell(paint), BODY], options);
    expect(refusal(await redact(original, QUOTE))).toBe(UNSEEN());
    expect(refusal(await redact(original))).toBe(UNSEEN());
    // And the gate, of a copy that came by it some other way: the honest copy with that text drawn on its cell.
    const seen = await page([cell(), onCell(WHITE), BODY], options);
    const honest = copyOf(await redact(seen, QUOTE));
    const copy = await appended(honest, (font) => `q ${paint.replace('/GS0 gs', '/GSx gs')} BT /${font} 14 Tf ${CELL.x + 20} ${CELL.y + 4} Td (Tuesday) Tj ET Q`, 0, (doc) => {
      const node = doc.getPage(0).node;
      const states = node.Resources()?.lookup(PDFName.of('ExtGState'));
      if (states instanceof PDFDict) states.set(PDFName.of('GSx'), doc.context.obj({ Type: 'ExtGState', ca: 0.5, CA: 0.5 }));
      else node.setExtGState(PDFName.of('GSx'), doc.context.register(doc.context.obj({ Type: 'ExtGState', ca: 0.5, CA: 0.5 })));
    });
    expect(await labelMarks(copy, seen)).toBe(UNSEEN());
    expect(await verdict(copy, seen, QUOTE)).toEqual({ pass: false, code: 'rules' });
  });

  it.each(UNSEEN_PAINTS.slice(0, 4))('passes %s text there once a white shape drawn between the two shows it', async (_name, paint, options) => {
    const original = await page([cell(), `1 g ${rect(COVER)} f`, onCell(paint), BODY], options);
    const copy = copyOf(await redact(original, QUOTE));
    expect(await labelMarks(copy, original)).toEqual([[MEMBERS]]);
    expect(await verdict(copy, original, QUOTE)).toEqual({ pass: true });
  });

  it.each([
    ['an ellipse of four curves', `1 g ${ellipse({ x: CELL.x + 2, y: CELL.y - 8, w: 100, h: 60 })} f`],
    ['a rectangle filled even-odd', `1 g ${rect(COVER)} f*`],
    ['a light grey rectangle, filled and stroked', `0.8 g 0 G ${rect(COVER)} B`],
    ['two rectangles, one inside the other, filled nonzero (no hole)', `1 g ${rect(COVER)} ${rect({ x: COVER.x + 4, y: COVER.y + 2, w: 72, h: 26 })} f`],
    ['a shape whose clip holds the text too', `q ${rect({ ...COVER, x: COVER.x + 2 })} W n 1 g ${rect(COVER)} f Q`],
  ])('takes for that shape %s', async (_name, cover) => {
    const original = await page([cell(), cover, onCell('0 g'), BODY]);
    const copy = copyOf(await redact(original, QUOTE));
    expect(await labelMarks(copy, original)).toEqual([[MEMBERS]]);
    expect(await verdict(copy, original, QUOTE)).toEqual({ pass: true });
  });

  it.each([
    ['covers only half the word', `1 g ${rect({ ...COVER, w: 30 })} f`, undefined],
    ['is an ellipse the word pokes out of', `1 g ${ellipse({ x: CELL.x + 14, y: CELL.y + 10, w: 56, h: 22 })} f`, undefined],
    ['is half transparent', `q /GS0 gs 1 g ${rect(COVER)} f Q`, GS],
    ['is dark grey', `0.3 g ${rect(COVER)} f`, undefined],
    ['is only stroked', `1 G 1 g ${rect(COVER)} S`, undefined],
    ['has a hole round the word (two rectangles, even-odd)', `1 g ${rect({ x: CELL.x + 1, y: CELL.y + 1, w: 103, h: 41 })} ${rect(COVER)} f*`, undefined],
    ['is clipped away from the word', `q ${rect({ ...COVER, w: 30 })} W n 1 g ${rect(COVER)} f Q`, undefined],
    ['is drawn small by a matrix', `q 0.1 0 0 0.1 0 0 cm 1 g ${rect(COVER)} f Q`, undefined],
    ['is drawn in a form', '/Fm1 Do', { form: `1 g ${rect(COVER)} f` }],
    ['is a picture', '', { picture: { left: COVER.x, bottom: COVER.y, width: COVER.w, height: COVER.h } }],
  ] as ReadonlyArray<[string, string, PageOptions | undefined]>)('refuses black text there when the shape %s', async (_name, cover, options) => {
    const original = await page([cell(), cover, onCell('0 g'), BODY], options);
    expect(refusal(await redact(original, QUOTE))).toBe(UNSEEN());
  });

  it('refuses black text there when the white shape is drawn before the rectangle, or after the text', async () => {
    const cover = `1 g ${rect(COVER)} f`;
    expect(refusal(await redact(await page([cover, cell(), onCell('0 g'), BODY]), QUOTE))).toBe(UNSEEN());
    // Drawn after it, the shape hides the text: nothing shows it on the rectangle.
    expect(refusal(await redact(await page([cell(), onCell('0 g'), cover, BODY]), QUOTE))).toBe(UNSEEN());
  });

  it('refuses black text in a form drawn on the rectangle, and under a second rectangle drawn over the white shape', async () => {
    const inForm = await page([cell(), '/Fm1 Do', BODY], { form: `0 g BT /F1 14 Tf ${CELL.x + 20} ${CELL.y + 16} Td (Monday) Tj ET` });
    expect(refusal(await redact(inForm, QUOTE))).toBe(UNSEEN());
    const again = await page([cell(), `1 g ${rect(COVER)} f`, cell(), onCell('0 g'), BODY]);
    expect(refusal(await redact(again, QUOTE))).toBe(UNSEEN());
  });

  it('refuses white text in a half-transparent form drawn on the rectangle, at any depth', async () => {
    const word = `1 g BT /F1 14 Tf ${CELL.x + 20} ${CELL.y + 16} Td (Monday) Tj ET`;
    const seen = await page([cell(), '/Fm1 Do', BODY], { form: word });
    expect(await labelMarks(copyOf(await redact(seen, QUOTE)), seen)).toEqual([[MEMBERS]]);
    const veiled = await page([cell(), 'q /GS0 gs /Fm1 Do Q', BODY], { form: word, ...GS });
    expect(refusal(await redact(veiled, QUOTE))).toBe(UNSEEN());
    const deep = await page([cell(), 'q /GS0 gs /Fm1 Do Q', BODY], { form: '/Fm2 Do', innerForm: word, ...GS });
    expect(refusal(await redact(deep, QUOTE))).toBe(UNSEEN());
  });

  it('leaves dark text alone that is not wholly inside the rectangle, and dark text under it', async () => {
    // The word starts inside the cell and runs out of it to the right: it shows on the page.
    const out = `q 0 g BT /F2 14 Tf ${CELL.x + CELL.w - 12} ${CELL.y + 16} Td (Mo) Tj ET Q`;
    const original = await page([`q 0 g BT /F2 14 Tf ${CELL.x + 20} ${CELL.y + 16} Td (Under) Tj ET Q`, cell(), out, BODY]);
    const copy = copyOf(await redact(original, QUOTE));
    expect(await labelMarks(copy, original)).toEqual([[MEMBERS]]);
    expect(await verdict(copy, original, QUOTE)).toEqual({ pass: true });
  });
});

describe('pageLabels, on readings made by hand', () => {
  const cellBox: Box = { left: 0, right: 100, bottom: 0, top: 20 };
  const glyph = (left: number, text = 'x'): PageChar => ({ text, generated: false, hyphen: false, box: { left, right: left + 6, bottom: 5, top: 12 }, ink: { left: left + 0.5, right: left + 5.5, bottom: 5, top: 11 }, fontSize: 10 });
  const SEEN = { luminance: 1, opaque: true };
  const DARK = { luminance: 0, opaque: true };
  const none = (): Shape | null => null;
  /** The cell at place 1, anything at 2 and 3, and one glyph drawn by the object at `place`. */
  const reading = (place: number, paints: LabelReading['paints'] = [DARK]): LabelReading => ({
    top: [{ kind: 'other', object: 7 }, { kind: 'box', object: 1, bounds: cellBox }, { kind: 'other', object: 8 }, { kind: 'other', object: 9 }],
    nested: 0,
    owners: [9],
    places: place === -2 ? [] : [place],
    paints,
  });
  const square = (left: number, bottom: number, right: number, top: number): Array<[number, number]> => [[left, bottom], [right, bottom], [right, top], [left, top]];
  const white = (outline: Shape['outline'], more: Partial<Shape> = {}): Shape => ({ luminance: 1, evenOdd: false, outline, clips: [], ...more });

  it('takes a rectangle for layout only at exactly the original\'s bounds, each of them once', () => {
    const chars = [glyph(10)];
    expect(pageLabels(reading(3, [SEEN]), chars, 0, [], none)).toBe(OTHER());
    expect(pageLabels(reading(3, [SEEN]), chars, 0, [cellBox], none)).toEqual([]);
    for (const side of ['left', 'right', 'bottom', 'top'] as const) expect(pageLabels(reading(3, [SEEN]), chars, 0, [{ ...cellBox, [side]: cellBox[side] + 0.001 }], none), side).toBe(OTHER());
    const two = reading(3, [SEEN]);
    two.top.splice(2, 0, { kind: 'box', object: 2, bounds: cellBox });
    two.places = [4];
    expect(pageLabels(two, chars, 0, [cellBox], none)).toBe(OTHER());
    expect(pageLabels(two, chars, 0, [cellBox, cellBox], none)).toEqual([]);
    expect(pageLabels(two, chars, 2, [], none)).toBe(OTHER(3));
  });

  it('refuses a glyph nobody can see wholly inside a rectangle of the original, drawn after it', () => {
    const chars = [glyph(10)];
    const layout = [cellBox];
    expect(pageLabels(reading(3), chars, 0, layout, none)).toBe(UNSEEN());
    expect(pageLabels(reading(3, [{ luminance: 1, opaque: false }]), chars, 4, layout, none)).toBe(UNSEEN(5));
    expect(pageLabels(reading(3, [{ luminance: 0.0999, opaque: true }]), chars, 0, layout, none)).toBe(UNSEEN());
    expect(pageLabels(reading(3, [{ luminance: 0.1, opaque: true }]), chars, 0, layout, none)).toEqual([]);
    // No paint read for it, or no drawing object named for it: unseen, and after every rectangle.
    expect(pageLabels(reading(3, []), chars, 0, layout, none)).toBe(UNSEEN());
    expect(pageLabels(reading(-1), chars, 0, layout, none)).toBe(UNSEEN());
    expect(pageLabels(reading(-2), chars, 0, layout, none)).toBe(UNSEEN());
    // Drawn before the rectangle it lies under it; by the same object, it is not after it.
    expect(pageLabels(reading(0), chars, 0, layout, none)).toEqual([]);
    expect(pageLabels(reading(1), chars, 0, layout, none)).toEqual([]);
  });

  it('judges by the glyph\'s ink where PDFium gives it, else by its box, and leaves blank and made-up glyphs', () => {
    const layout = [cellBox];
    // The box reaches past the rectangle's right; the ink does not.
    const edge = { ...glyph(95), box: { left: 95, right: 101, bottom: 5, top: 12 }, ink: { left: 95.5, right: 99.5, bottom: 5, top: 11 } };
    expect(pageLabels(reading(3), [edge], 0, layout, none)).toBe(UNSEEN());
    expect(pageLabels(reading(3), [{ ...edge, ink: null }], 0, layout, none)).toEqual([]);
    expect(pageLabels(reading(3), [{ ...edge, ink: { ...edge.ink, right: 100.5 } }], 0, layout, none)).toEqual([]);
    expect(pageLabels(reading(3), [{ ...glyph(10), box: null }], 0, layout, none)).toBe(UNSEEN());
    expect(pageLabels(reading(3), [{ ...glyph(10), box: null, ink: null }], 0, layout, none)).toEqual([]);
    expect(pageLabels(reading(3), [glyph(10, ' ')], 0, layout, none)).toEqual([]);
    expect(pageLabels(reading(3), [{ ...glyph(10), generated: true }], 0, layout, none)).toEqual([]);
  });

  it('passes it when a light, opaque shape drawn between the two covers it whole', () => {
    const chars = [glyph(10)];
    const layout = [cellBox];
    const asked: number[] = [];
    const at2 = (shape: Shape | null) => (at: number): Shape | null => {
      asked.push(at);
      return at === 2 ? shape : null;
    };
    const cover = square(8, 3, 18, 14);
    expect(pageLabels(reading(3), chars, 0, layout, at2(white([cover])))).toEqual([]);
    // Only the objects between the rectangle (1) and the glyph's (3) are asked for.
    expect(asked).toEqual([2]);
    expect(pageLabels(reading(3), chars, 0, layout, at2(white([cover], { luminance: 0.4 })))).toEqual([]);
    expect(pageLabels(reading(3), chars, 0, layout, at2(white([cover], { luminance: 0.3999 })))).toBe(UNSEEN());
    expect(pageLabels(reading(3), chars, 0, layout, at2(null))).toBe(UNSEEN());
    // At the glyph's own place, or before the rectangle, a shape is not between them.
    expect(pageLabels(reading(2), chars, 0, layout, at2(white([cover])))).toBe(UNSEEN());
    expect(pageLabels(reading(3), chars, 0, layout, (at) => (at === 0 || at === 1 || at === 3 ? white([cover]) : null))).toBe(UNSEEN());
    // Nothing is named for the glyph: it is after everything, so every later shape is between.
    expect(pageLabels(reading(-1), chars, 0, layout, at2(white([cover])))).toEqual([]);
  });

  it('asks for each shape once, however many glyphs lie on the rectangle', () => {
    const chars = [glyph(10), glyph(11), glyph(12)];
    const three = reading(3, [DARK, DARK, DARK]);
    three.owners = [9, 9, 9];
    three.places = [3, 3, 3];
    const shapeAt = vi.fn((at: number): Shape | null => (at === 2 ? white([square(8, 3, 20, 14)]) : null));
    expect(pageLabels(three, chars, 0, [cellBox], shapeAt)).toEqual([]);
    expect(shapeAt.mock.calls).toEqual([[2]]);
  });

  it('counts a glyph covered only when no edge of the shape comes within 0.1 pt of its ink and the fill holds it', () => {
    const chars = [glyph(10)];
    const layout = [cellBox];
    // The glyph's ink is 10.5 to 15.5 across and 5 to 11 up.
    const judge = (shape: Shape): PlacedLabel[] | string => pageLabels(reading(3), chars, 0, layout, (at) => (at === 2 ? shape : null));
    expect(judge(white([square(10.3, 4.8, 15.7, 11.2)]))).toEqual([]);
    expect(judge(white([square(10.45, 4.8, 15.7, 11.2)]))).toBe(UNSEEN());
    expect(judge(white([square(10.3, 4.8, 15.55, 11.2)]))).toBe(UNSEEN());
    expect(judge(white([square(10.3, 4.95, 15.7, 11.2)]))).toBe(UNSEEN());
    expect(judge(white([square(10.3, 4.8, 15.7, 11.05)]))).toBe(UNSEEN());
    // A shape beside the glyph, one above it, and one that crosses it corner to corner.
    expect(judge(white([square(30, 3, 40, 14)]))).toBe(UNSEEN());
    expect(judge(white([square(8, 13, 18, 19)]))).toBe(UNSEEN());
    expect(judge(white([[[9, 4], [17, 12], [17, 4]]]))).toBe(UNSEEN());
    // A triangle wide enough to hold it, drawn either way round.
    expect(judge(white([[[0, 2], [40, 2], [12, 19]]]))).toEqual([]);
    expect(judge(white([[[12, 19], [40, 2], [0, 2]]]))).toEqual([]);
    // A hole round the glyph: filled nonzero when both run the same way, a hole when even-odd or wound the other way.
    const outer = square(2, 1, 60, 19);
    const inner = square(8, 3, 18, 14);
    expect(judge(white([outer, inner]))).toEqual([]);
    expect(judge(white([outer, inner], { evenOdd: true }))).toBe(UNSEEN());
    expect(judge(white([outer, [...inner].reverse()]))).toBe(UNSEEN());
    expect(judge(white([outer, [...inner].reverse()], { evenOdd: true }))).toBe(UNSEEN());
    // A clip: it must hold the glyph too, under either fill rule.
    expect(judge(white([outer], { clips: [[inner]] }))).toEqual([]);
    expect(judge(white([outer], { clips: [[inner], [square(30, 3, 40, 14)]] }))).toBe(UNSEEN());
    expect(judge(white([outer], { clips: [[outer, inner]] }))).toBe(UNSEEN());
    expect(judge(white([outer], { clips: [[outer, [...inner].reverse()]] }))).toBe(UNSEEN());
    // An outline with nothing in it covers nothing.
    expect(judge(white([]))).toBe(UNSEEN());
  });

  it('keeps every rule for the engine\'s own boxes beside a rectangle of the original', () => {
    const ours: Box = { left: 200, right: 300, bottom: 0, top: 20 };
    const label = (text: string, styled = true): LabelReading['top'][number] => ({ kind: 'lettering', object: 5, text, styled, x: 210, y: 4, bounds: { left: 210, right: 260, bottom: 4, top: 12 } });
    const both = (mark: LabelReading['top'][number]): LabelReading => ({ top: [{ kind: 'box', object: 1, bounds: cellBox }, { kind: 'box', object: 2, bounds: ours }, mark], nested: 0, owners: [], places: [], paints: [] });
    expect(pageLabels(both(label('Private')), [], 0, [cellBox], none)).toEqual([{ text: 'Private', x: 210, y: 4 }]);
    expect(pageLabels(both(label('Private', false)), [], 0, [cellBox], none)).toBe("page 1: a label is not in the labels' style");
    expect(pageLabels(both(label('Call 555-0142')), [], 0, [cellBox], none)).toBe(OTHER());
    // The same label over the engine's box, when that box is taken for layout: outside any box.
    expect(pageLabels(both(label('Private')), [], 0, [cellBox, ours], none)).toBe(OUTSIDE);
    // White lettering that is no label, on a rectangle of the original: a heading, left alone.
    const heading: LabelReading['top'][number] = { kind: 'lettering', object: 5, text: 'Monday', styled: true, x: 10, y: 4, bounds: { left: 10, right: 60, bottom: 4, top: 12 } };
    expect(pageLabels(both(heading), [], 0, [cellBox], none)).toEqual([]);
  });
});

describe('luminance', () => {
  it('is the WCAG relative luminance of an sRGB colour', () => {
    expect(luminance(0, 0, 0)).toBe(0);
    expect(luminance(255, 255, 255)).toBeCloseTo(1, 10);
    expect(luminance(255, 0, 0)).toBeCloseTo(0.2126, 4);
    expect(luminance(0, 255, 0)).toBeCloseTo(0.7152, 4);
    expect(luminance(0, 0, 255)).toBeCloseTo(0.0722, 4);
    // Mid grey 128 is about 0.2159; 10 is on the linear part (10 / 255 / 12.92).
    expect(luminance(128, 128, 128)).toBeCloseTo(0.2159, 3);
    expect(luminance(10, 10, 10)).toBeCloseTo(10 / 255 / 12.92, 10);
  });
});
