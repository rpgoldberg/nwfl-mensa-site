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
import { Document, type LabelReading, type Paint, type Shape, type Twin, type Unread, luminance, pdfium } from '../../src/pdf/pdfium.js';
import { type RedactResult, redactPdf } from '../../src/pdf/redact.js';
import { type PageOptions, askLine, fitPdf } from './fit-fixtures.js';
import { manyShows } from './hostile.js';

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
/** A white shape under the word on the cell. */
const COVER: Rect = { x: CELL.x + 10, y: CELL.y + 6, w: 80, h: 30 };
const rect = (r: Rect): string => `${r.x} ${r.y} ${r.w} ${r.h} re`;
/** An ellipse round `r`, drawn as four curves (as Publisher draws a callout). */
const ellipse = (r: Rect): string => {
  const [cx, cy, rx, ry, k] = [r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0.5523];
  return `${cx + rx} ${cy} m ${cx + rx} ${cy + k * ry} ${cx + k * rx} ${cy + ry} ${cx} ${cy + ry} c ${cx - k * rx} ${cy + ry} ${cx - rx} ${cy + k * ry} ${cx - rx} ${cy} c ${cx - rx} ${cy - k * ry} ${cx - k * rx} ${cy - ry} ${cx} ${cy - ry} c ${cx + k * rx} ${cy - ry} ${cx + rx} ${cy - k * ry} ${cx + rx} ${cy} c h`;
};
const GS = { extGState: { Type: 'ExtGState', ca: 0.5, CA: 0.5 } };

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

  it('looks for the text drawn again as it is at the 8 nearest places after it, and reads a page of many in time', async () => {
    // Hidden under a white cover, then drawn again as it is 7 or 8 times after it: the last, on top, is seen.
    const again = (n: number): Promise<Uint8Array> => page([cell(), onCell(WHITE), `1 g ${rect(COVER)} f`, ...Array.from({ length: n }, () => `${cell()}\n${onCell(WHITE)}`), BODY]);
    const passes = async (n: number): Promise<boolean> => Array.isArray(await labelMarks(await again(n), await again(n)));
    expect(await passes(8)).toBe(true);
    expect(await passes(9)).toBe(false);
    const original = await again(9);
    expect(await redact(original, QUOTE)).toEqual({ kind: 'refused', reason: UNSEEN() });
    // 20,000 text objects drawn as one is: each one's list stays short, and reading them takes no time to speak of.
    const many = await fitPdf(Array.from({ length: 20_000 }, () => 'BT /F1 4 Tf 12 115 Td 1 g (n) Tj ET').join('\n'));
    const doc = Document.open(await pdfium(), many);
    if (doc === null) throw new Error('fixture did not open');
    try {
      const started = performance.now();
      const twins = doc.page(0, (p) => p.labelReading().twins ?? []);
      expect(performance.now() - started).toBeLessThan(4000);
      expect(twins.reduce((most, list) => Math.max(most, list.length), 0)).toBe(8);
    } finally {
      doc.close();
    }
    // 20,000 text objects, each read: telling which PDFium reads no glyph of takes no time to speak of (one object at a
    // time, PDFium reads the page's every glyph for each: 5.6 s).
    const shows = Document.open(await pdfium(), manyShows(20_000));
    if (shows === null) throw new Error('fixture did not open');
    try {
      const started = performance.now();
      shows.page(0, (p) => p.labelReading());
      expect(performance.now() - started).toBeLessThan(2000);
    } finally {
      shows.close();
    }
  }, 120_000);

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

  // Fix round 1 (S2): half-transparent white on a white shape is white on white, so it is refused (below), not passed.
  it.each(UNSEEN_PAINTS.slice(0, 3))('passes %s text there once a white shape drawn between the two shows it', async (_name, paint, options) => {
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

  it('leaves dark text alone that is mostly outside the rectangle, and dark text under it', async () => {
    // The word starts inside the cell and runs out of it to the right: it shows on the page. Fix round 1 (D): each
    // glyph is judged by how much of its ink lies on the cell, so the word starts 4 pt in, not 12.
    const out = `q 0 g BT /F2 14 Tf ${CELL.x + CELL.w - 4} ${CELL.y + 16} Td (Mo) Tj ET Q`;
    const original = await page([`q 0 g BT /F2 14 Tf ${CELL.x + 20} ${CELL.y + 16} Td (Under) Tj ET Q`, cell(), out, BODY]);
    const copy = copyOf(await redact(original, QUOTE));
    expect(await labelMarks(copy, original)).toEqual([[MEMBERS]]);
    expect(await verdict(copy, original, QUOTE)).toEqual({ pass: true });
  });
});

describe('text develop refused that nobody can see stays refused (fix round 1)', () => {
  /** A Type 3 font /F9 whose one glyph is d0: its proc sets its own colour (`proc`) and paints a block in it. */
  async function withType3(pdf: Uint8Array, proc = '600 0 d0 0 g 50 0 500 700 re f'): Promise<Uint8Array> {
    const doc = await PDFDocument.load(pdf, { updateMetadata: false });
    const { context } = doc;
    const glyph = context.register(context.flateStream(proc));
    const codes = [0x48, 0x69, 0x64, 0x65, 0x6e];
    const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Fix1 def /CIDSystemInfo <</Registry (F) /Ordering (F) /Supplement 0>> def 1 begincodespacerange <00> <FF> endcodespacerange ${codes.length} beginbfchar ${codes.map((c) => `<${c.toString(16)}> <00${c.toString(16)}>`).join(' ')} endbfchar endcmap CMapName currentdict /CMap defineresource pop end end`;
    const font = context.obj({
      Type: 'Font',
      Subtype: 'Type3',
      FontBBox: [0, 0, 600, 700],
      FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
      CharProcs: { g: glyph },
      Encoding: { Type: 'Encoding', Differences: [0x41, ...Array.from({ length: 0x7a - 0x41 + 1 }, () => PDFName.of('g'))] },
      FirstChar: 0x41,
      LastChar: 0x7a,
      Widths: Array.from({ length: 0x7a - 0x41 + 1 }, () => 600),
      Resources: {},
      ToUnicode: context.register(context.flateStream(cmap)),
    } as never);
    doc.getPage(0).node.setFontDictionary(PDFName.of('F9'), context.register(font));
    return doc.save({ useObjectStreams: false });
  }
  /** A luminosity soft mask /GS0 whose group is all black: whatever it is set for is not drawn at all. */
  async function withBlackSoftMask(pdf: Uint8Array): Promise<Uint8Array> {
    const doc = await PDFDocument.load(pdf, { updateMetadata: false });
    const { context } = doc;
    const group = context.register(context.flateStream('0 g 0 0 400 140 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 400, 140], Group: { S: 'Transparency', CS: 'DeviceGray' } }));
    doc.getPage(0).node.setExtGState(PDFName.of('GS0'), context.register(context.obj({ Type: 'ExtGState', SMask: { Type: 'Mask', S: 'Luminosity', G: group } } as never)));
    return doc.save({ useObjectStreams: false });
  }
  const MULTIPLY = { extGState: { Type: 'ExtGState', BM: 'Multiply' } };
  const hidden = (paint: string, font = 'F2'): string => `q ${paint} BT /${font} 14 Tf ${CELL.x + 20} ${CELL.y + 16} Td (Hidden) Tj ET Q`;
  const LOWER: Rect = { x: CELL.x, y: CELL.y, w: CELL.w, h: 20 };
  const UPPER: Rect = { x: CELL.x, y: CELL.y + 20, w: CELL.w, h: 23.4719 };
  /** A cell whose top is 0.05 pt under the top of the ink of every glyph of "nnmmnu" drawn at 14 pt from (CELL.x + 10, CELL.y + 16). */
  const tight = async (): Promise<Rect> => {
    const doc = Document.open(await pdfium(), await page([`q 0 g BT /F1 14 Tf ${CELL.x + 10} ${CELL.y + 16} Td (nnmmnu) Tj ET Q`]));
    if (doc === null) throw new Error('unopenable');
    try {
      const inks = doc.page(0, (p) => p.chars().chars).flatMap((c) => (c.ink === null ? [] : [c.ink]));
      const [left, right, bottom, top] = [Math.min(...inks.map((b) => b.left)), Math.max(...inks.map((b) => b.right)), Math.min(...inks.map((b) => b.bottom)), Math.min(...inks.map((b) => b.top))];
      return { x: left - 3, y: bottom - 3, w: right - left + 6, h: top - 0.05 - (bottom - 3) };
    } finally {
      doc.close();
    }
  };

  const CASES: ReadonlyArray<[string, () => Promise<Uint8Array>]> = [
    // S1: dark ink on a rectangle of the original, made to look shown.
    ['A1: black text, a white shape, then a black rectangle filled nonzero over it', () => page([cell(), `1 g ${rect(COVER)} f`, `0 g ${rect(COVER)} f`, hidden('0 g'), BODY])],
    ['A2: black text, a white shape, then a near-black rectangle filled even-odd over it', () => page([cell(), `1 g ${rect(COVER)} f`, `0.02 g ${rect(COVER)} f*`, hidden('0 g'), BODY])],
    ['A3: black text, a white shape, then a black ellipse over it', () => page([cell(), `1 g ${rect(COVER)} f`, `0 g ${ellipse({ x: CELL.x + 2, y: CELL.y - 8, w: 100, h: 60 })} f`, hidden('0 g'), BODY])],
    ['A4: black text, a white shape, then a black rectangle in a form over it', () => page([cell(), `1 g ${rect(COVER)} f`, '/Fm1 Do', hidden('0 g'), BODY], { form: `0 g ${rect(COVER)} f` })],
    ['A5: black text, a white shape, then a black rectangle over half of it', () => page([cell(), `1 g ${rect(COVER)} f`, `0 g ${rect({ ...COVER, w: 40 })} f`, hidden('0 g'), BODY])],
    ['D1: black text across the seam of two cells', () => page([cell(LOWER), cell(UPPER), `q 0 g BT /F1 14 Tf ${CELL.x + 10} ${CELL.y + 17} Td (Hidden phone) Tj ET Q`, BODY])],
    ['D2: black text whose ink pokes 0.05 pt out of its cell', async () => page([cell(await tight()), `q 0 g BT /F1 14 Tf ${CELL.x + 10} ${CELL.y + 16} Td (nnmmnu) Tj ET Q`, BODY])],
    ['F1: Type 3 glyphs (d0) whose procs paint black, filled white', async () => withType3(await page([cell(), hidden('1 g', 'F9'), BODY]))],
    // S2: light ink on a rectangle of the original, hidden another way.
    ['B1: white text on a white shape on the cell', () => page([cell(), `1 g ${rect(COVER)} f`, hidden('1 g'), BODY])],
    ['B2: yellow text on a yellow shape on the cell', () => page([cell(), `1 1 0 rg ${rect(COVER)} f`, hidden('1 1 0 rg'), BODY])],
    ['C1: white text, then a black rectangle over it', () => page([cell(), hidden('1 g'), `0 g ${rect(COVER)} f`, BODY])],
    ['C2: white text, then a picture over it', () => page([cell(), hidden('1 g'), BODY], { picture: { left: COVER.x, bottom: COVER.y, width: COVER.w, height: COVER.h } })],
    ['C3: white text, then a white stroke 30 pt wide over it', () => page([cell(), hidden('1 g'), `1 G 30 w ${CELL.x + 10} ${CELL.y + 20} m ${CELL.x + 95} ${CELL.y + 20} l S`, BODY])],
    ['E1: white text clipped to a 1 pt square', () => page([cell(), `q ${CELL.x} ${CELL.y} 1 1 re W n 1 g BT /F2 14 Tf ${CELL.x + 20} ${CELL.y + 16} Td (Hidden) Tj ET Q`, BODY])],
    ['E2: white text in a form, clipped there to a 1 pt square', () => page([cell(), '/Fm1 Do', BODY], { form: `${CELL.x} ${CELL.y} 1 1 re W n 1 g BT /F1 14 Tf ${CELL.x + 20} ${CELL.y + 16} Td (Hidden) Tj ET` })],
    ['E3: white text in a form, and a white shape under it in the form', () => page([cell(), '/Fm1 Do', BODY], { form: `1 g ${rect(COVER)} f BT /F1 14 Tf ${CELL.x + 20} ${CELL.y + 16} Td (Hidden) Tj ET` })],
    // S3: blend modes and soft masks, on the text, on the shape, in a form.
    ['K1: white text, blend mode Multiply', () => page([cell(), hidden('/GS0 gs 1 g'), BODY], MULTIPLY)],
    ['K2: white text, blend mode Darken', () => page([cell(), hidden('/GS0 gs 1 g'), BODY], { extGState: { Type: 'ExtGState', BM: 'Darken' } })],
    ['K3: black text on a white shape drawn with blend mode Multiply', () => page([cell(), `q /GS0 gs 1 g ${rect(COVER)} f Q`, hidden('0 g'), BODY], MULTIPLY)],
    ['K4: white text under a black soft mask', async () => withBlackSoftMask(await page([cell(), hidden('/GS0 gs 1 g'), BODY]))],
    ['K5: black text on a white shape under a black soft mask', async () => withBlackSoftMask(await page([cell(), `q /GS0 gs 1 g ${rect(COVER)} f Q`, hidden('0 g'), BODY]))],
    ['half-transparent white text on a white shape on the cell', () => page([cell(), `1 g ${rect(COVER)} f`, hidden('/GS0 gs 1 g'), BODY], GS)],
    ['white text on a white shape drawn in a form between (PDFium\'s drawing shows nothing of it)', () => page([cell(), '/Fm1 Do', hidden('1 g'), BODY], { form: `1 g ${rect(COVER)} f` })],
    ['white text on a black cell its clip leaves out, over the white page', () => page([`q ${CELL.x} ${CELL.y + 200} 1 1 re W n ${cell()} Q`, onCell(WHITE), BODY])],
    ['white text on a black cell clipped by a triangle that leaves it out', () => page([`q ${CELL.x} ${CELL.y} m ${CELL.x + 5} ${CELL.y} l ${CELL.x} ${CELL.y + 5} l h W n ${cell()} Q`, onCell(WHITE), BODY])],
    ['K6: white text in a form drawn with blend mode Multiply', () => page([cell(), 'q /GS0 gs /Fm1 Do Q', BODY], { form: `1 g BT /F1 14 Tf ${CELL.x + 20} ${CELL.y + 16} Td (Hidden) Tj ET`, ...MULTIPLY })],
  ];

  it.each(CASES)('refuses %s, in the engine and in the gate', async (_name, build) => {
    const original = await build();
    expect(refusal(await redact(original, QUOTE))).toBe(UNSEEN());
    expect(refusal(await redact(original))).toBe(UNSEEN());
    // The gate reads the original as a copy of itself the same way: it takes nothing from the engine.
    expect(await labelMarks(original, original)).toBe(UNSEEN());
    expect(await verdict(original, original)).toEqual({ pass: false, code: 'rules' });
  });

  // The gate refuses these Type 3 fonts by rules of its own (gate-rules.ts, the Type 3 glyph procs); the labels pass.
  it.each<[string, () => Promise<Uint8Array>]>([
    ['Type 3 glyphs (d1) filled white', () => page([cell(), `q 1 g BT /F3 14 Tf ${CELL.x + 20} ${CELL.y + 16} Td (BHI) Tj ET Q`, BODY])],
    ['Type 3 glyphs (d0) whose procs paint white, filled black', async () => withType3(await page([cell(), hidden('0 g', 'F9'), BODY]), '600 0 d0 1 g 50 0 500 700 re f')],
  ])('takes %s for seen: their labels pass', async (_name, build) => {
    const original = await build();
    const copy = copyOf(await redact(original, QUOTE));
    expect(await labelMarks(copy, original)).toEqual([[MEMBERS]]);
  });

  it.each<[string, () => Promise<Uint8Array>]>([
    ['K7: white text filled and stroked (2 Tr)', () => page([cell(), hidden('1 g 1 G 2 Tr'), BODY])],
    ['black text on a white shape, under a black frame stroked round the shape', () => page([cell(), `1 g ${rect(COVER)} f`, `0 G 0.75 w ${rect({ x: COVER.x - 2, y: COVER.y - 2, w: COVER.w + 4, h: COVER.h + 4 })} S`, hidden('0 g'), BODY])],
    ['white text in a form drawn 20 pt lower, clipped in the form round itself', () => page([cell(), 'q 1 0 0 1 0 -20 cm /Fm1 Do Q', BODY], { form: `${rect({ ...COVER, y: COVER.y + 20 })} W n 1 g BT /F1 14 Tf ${CELL.x + 20} ${CELL.y + 36} Td (Monday) Tj ET` })],
    ['white text on a grey shape drawn in a form between (PDFium\'s drawing shows it, 4:1)', () => page([cell(), '/Fm1 Do', hidden('1 g'), BODY], { form: `0.5 g ${rect(COVER)} f` })],
    ['white text on a cell, both drawn again where a clip leaves them out (as Publisher does)', () => page([cell(), onCell(WHITE), `q ${CELL.x} ${CELL.y + 200} 1 1 re W n ${cell()} ${onCell(WHITE)} Q`, BODY])],
    ['white text on a cell, both drawn again in a clip shaped as a triangle round them', () => page([cell(), onCell(WHITE), `q ${CELL.x - 300} ${CELL.y - 300} m ${CELL.x + 600} ${CELL.y - 300} l ${CELL.x - 300} ${CELL.y + 600} l h W n ${cell()} ${onCell(WHITE)} Q`, BODY])],
    ['white text across the seam of two cells', () => page([cell(LOWER), cell(UPPER), `q 1 g BT /F1 14 Tf ${CELL.x + 10} ${CELL.y + 17} Td (Hidden phone) Tj ET Q`, BODY])],
    ['black text mostly off the cell, its first glyph a third on it', () => page([cell(), `q 0 g BT /F1 14 Tf ${CELL.x + CELL.w - 4} ${CELL.y + 16} Td (Mo) Tj ET Q`, BODY])],
  ])('passes %s', async (_name, build) => {
    const original = await build();
    const copy = copyOf(await redact(original, QUOTE));
    expect(await labelMarks(copy, original)).toEqual([[MEMBERS]]);
    expect(await verdict(copy, original, QUOTE)).toEqual({ pass: true });
  });

  it('reads a page of 1,600 cells under 800 glyphs in well under the gate\'s time (develop: 52 ms; quadratic: 16 s)', async () => {
    const cells = Array.from({ length: 1600 }, () => '0 g 10 10 380 120 re f*').join('\n');
    const text = `q 0 g BT /F1 4 Tf 12 115 Td ${Array.from({ length: 10 }, () => `(${'n'.repeat(80)}) Tj 0 -5 Td`).join(' ')} ET Q`;
    const pdf = await fitPdf(`${cells}\n1 g 11 11 378 118 re f\n${text}`);
    const started = performance.now();
    expect(await labelMarks(pdf, pdf)).toEqual([[]]);
    expect(performance.now() - started).toBeLessThan(4000);
  }, 60_000);
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

  it('judges by the glyph\'s ink where PDFium gives it, else by its box, half of it or more on the rectangle, and leaves blank and made-up glyphs', () => {
    const layout = [cellBox];
    // The box reaches past the rectangle's right; the ink does not.
    const edge = { ...glyph(95), box: { left: 95, right: 101, bottom: 5, top: 12 }, ink: { left: 95.5, right: 99.5, bottom: 5, top: 11 } };
    expect(pageLabels(reading(3), [edge], 0, layout, none)).toBe(UNSEEN());
    // Fix round 1 (D): a glyph mostly on the rectangle is judged on it, though some of it lies off it.
    expect(pageLabels(reading(3), [{ ...edge, ink: null }], 0, layout, none)).toBe(UNSEEN());
    expect(pageLabels(reading(3), [{ ...edge, ink: { ...edge.ink, right: 100.5 } }], 0, layout, none)).toBe(UNSEEN());
    expect(pageLabels(reading(3), [{ ...edge, ink: { ...edge.ink, left: 97.4, right: 102.4 } }], 0, layout, none)).toBe(UNSEEN());
    expect(pageLabels(reading(3), [{ ...edge, ink: { ...edge.ink, left: 97.51, right: 102.51 } }], 0, layout, none)).toEqual([]);
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
    // Fix round 1: the glyphs stand apart (a glyph drawn over most of another is now a cover).
    const chars = [glyph(10), glyph(20), glyph(30)];
    const three = reading(3, [DARK, DARK, DARK]);
    three.owners = [9, 9, 9];
    three.places = [3, 3, 3];
    const shapeAt = vi.fn((at: number): Shape | null => (at === 2 ? white([square(8, 3, 40, 14)]) : null));
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

describe('pageLabels, on readings made by hand: what lies under a glyph and over it (fix round 1)', () => {
  const cellBox: Box = { left: 0, right: 100, bottom: 0, top: 20 };
  const ink = (left: number, more: Partial<Box> = {}): Box => ({ left: left + 0.5, right: left + 5.5, bottom: 5, top: 11, ...more });
  const glyph = (left: number, text = 'x', more: Partial<Box> = {}): PageChar => ({ text, generated: false, hyphen: false, box: { left, right: left + 6, bottom: 5, top: 12 }, ink: ink(left, more), fontSize: 10 });
  const WHITE_TEXT = { luminance: 1, opaque: true };
  const BLACK_TEXT = { luminance: 0, opaque: true };
  const square = (left: number, bottom: number, right: number, top: number): Array<[number, number]> => [[left, bottom], [right, bottom], [right, top], [left, top]];
  const fill = (luminance: number, outline: Shape['outline'], more: Partial<Shape> = {}): Shape => ({ luminance, evenOdd: false, outline, clips: [], ...more });
  /** The cell at 1, then the objects `between` (2, 3, ...), the glyphs' object, then the objects `after`. */
  const page_ = (between: Array<Shape | Unread | null>, after: Array<Shape | Unread | null> = [], paints: Paint[] = [WHITE_TEXT], places?: number[]) => {
    const drawn = [null, null, ...between, null, ...after];
    const text = 2 + between.length;
    const reading: LabelReading = {
      top: drawn.map((_, at) => (at === 1 ? { kind: 'box' as const, object: 1, bounds: cellBox } : { kind: 'other' as const, object: 100 + at })),
      nested: 0,
      owners: paints.map(() => 100 + text),
      places: places ?? paints.map(() => text),
      paints,
    };
    return { reading, shapeAt: (at: number) => drawn[at] ?? null, text };
  };
  const judge = (between: Array<Shape | Unread | null>, after: Array<Shape | Unread | null> = [], paints: Paint[] = [WHITE_TEXT], chars: PageChar[] = [glyph(10)], places?: number[]): PlacedLabel[] | string => {
    const { reading, shapeAt } = page_(between, after, paints, places);
    return pageLabels(reading, chars, 0, [cellBox], shapeAt);
  };

  it('refuses light text on a light shape, and passes text 3:1 or more against what it lies on', () => {
    const cover = square(8, 3, 18, 14);
    expect(judge([fill(1, [cover])])).toBe(UNSEEN());
    expect(judge([fill(1, [cover])], [], [{ luminance: 0.2, opaque: true }])).toEqual([]);
    expect(judge([fill(0.9, [cover])], [], [{ luminance: 0.3, opaque: true }])).toBe(UNSEEN());
    // 3:1 is (L + 0.05) against 3 (l + 0.05): 0.2 needs 0.7 under it, and 0.0001 needs 0.1003 over it.
    expect(judge([fill(0.7001, [cover])], [], [{ luminance: 0.2, opaque: true }])).toEqual([]);
    expect(judge([fill(0.6999, [cover])], [], [{ luminance: 0.2, opaque: true }])).toBe(UNSEEN());
    expect(judge([fill(0.4001, [cover])], [], [{ luminance: 0.1001, opaque: true }])).toBe(UNSEEN());
    expect(judge([fill(0.0001, [cover])], [], [{ luminance: 0.1004, opaque: true }])).toEqual([]);
    expect(judge([fill(0.0001, [cover])], [], [{ luminance: 0.1002, opaque: true }])).toBe(UNSEEN());
  });

  it('judges light text across two rectangles by both, and by the page where neither reaches (seen when half its ink shows)', () => {
    const lower: Box = { left: 0, right: 100, bottom: 0, top: 8 };
    const upper: Box = { left: 0, right: 100, bottom: 8, top: 20 };
    const two = (top: Box): LabelReading => ({
      top: [{ kind: 'box', object: 1, bounds: lower }, { kind: 'box', object: 2, bounds: top }, { kind: 'other', object: 3 }],
      nested: 0,
      owners: [3],
      places: [2],
      paints: [WHITE_TEXT],
    });
    expect(pageLabels(two(upper), [glyph(10)], 0, [lower, upper], () => null)).toEqual([]);
    // A gap between the two: the white page shows there, under white ink; the rest shows.
    const gapped = { ...upper, bottom: 8.5 };
    expect(pageLabels(two(gapped), [glyph(10)], 0, [lower, gapped], () => null)).toEqual([]);
    // Light grey on two black rectangles, and on a light grey one between them over most of the ink.
    const grey: Paint = { luminance: 0.5, opaque: true };
    const three: LabelReading = { ...two(upper), top: [...two(upper).top.slice(0, 2), { kind: 'other', object: 5 }, { kind: 'other', object: 3 }], places: [3], paints: [grey] };
    const band = (top: number): Shape => ({ luminance: 0.45, evenOdd: false, outline: [[[0, 0], [100, 0], [100, top], [0, top]]], clips: [] });
    expect(pageLabels(three, [glyph(10)], 0, [lower, upper], (at) => (at === 2 ? band(7.9) : null))).toEqual([]);
    expect(pageLabels(three, [glyph(10)], 0, [lower, upper], (at) => (at === 2 ? band(8.1) : null))).toBe(UNSEEN());
    // Mid grey is 3:1 or more against both black and white.
    expect(pageLabels({ ...two(gapped), paints: [{ luminance: 0.2, opaque: true }] }, [glyph(10)], 0, [lower, gapped], () => null)).toEqual([]);
  });

  it('takes a stroke for a piece of what lies under the ink, where it comes within reach of it', () => {
    const cover = fill(1, [square(8, 3, 18, 14)]);
    const frame = (width: number, mitred: boolean, outline = [square(5, -0.5, 21, 16.5)]): Shape => ({ luminance: null, evenOdd: false, outline, clips: [], stroke: { luminance: 0, width, mitred } });
    // Each side of the frame is 5.5 pt from the ink, and each corner 5.5 pt across and up from the ink's.
    expect(judge([cover, frame(7.7, false)], [], [BLACK_TEXT])).toEqual([]);
    expect(judge([cover, frame(7.8, false)], [], [BLACK_TEXT])).toBe(UNSEEN());
    expect(judge([cover, frame(1.09, true)], [], [BLACK_TEXT])).toEqual([]);
    expect(judge([cover, frame(1.11, true)], [], [BLACK_TEXT])).toBe(UNSEEN());
    expect(judge([cover, frame(1.11, false)], [], [BLACK_TEXT])).toEqual([]);
    // A stroked light shape under black text: its black edge shows the glyph only where it does not reach.
    expect(judge([{ ...cover, stroke: { luminance: 0, width: 1, mitred: false } }], [], [BLACK_TEXT])).toEqual([]);
    expect(judge([{ ...cover, stroke: { luminance: 0, width: 6, mitred: false } }], [], [BLACK_TEXT])).toBe(UNSEEN());
    // A clip on a stroke keeps it away from the ink.
    expect(judge([cover, { ...frame(30, true), clips: [[square(40, 0, 60, 20)]] }], [], [BLACK_TEXT])).toEqual([]);
    // A white stroke under white text, and a white one 30 pt wide drawn over it.
    expect(judge([{ ...frame(30, false), stroke: { luminance: 1, width: 30, mitred: false } }])).toBe(UNSEEN());
    expect(judge([], [{ ...frame(30, false), stroke: { luminance: 1, width: 30, mitred: false } }])).toBe(UNSEEN());
  });

  it('refuses a glyph over what it cannot read, and anything drawn over it after; passes one drawn again where it was', () => {
    // Over 2.6 pt of the 5 pt ink (more than half), and over 2.4 pt.
    const near: Unread = { unread: { left: 12.9, right: 30, bottom: 0, top: 20 } };
    const far: Unread = { unread: { left: 13.1, right: 30, bottom: 0, top: 20 } };
    expect(judge([near])).toBe(UNSEEN());
    expect(judge([far])).toEqual([]);
    expect(judge([], [near])).toBe(UNSEEN());
    expect(judge([], [far])).toEqual([]);
    expect(judge([], [fill(1, [square(12.9, 0, 30, 20)])])).toBe(UNSEEN());
    expect(judge([], [fill(1, [square(13.1, 0, 30, 20)])])).toEqual([]);
    expect(judge([], [fill(1, [square(15.4, 0, 30, 20)]), fill(1, [square(0, 0, 13, 20)])])).toBe(UNSEEN());
    // Drawn again where it was (the same text over half its ink or more), and seen there: the glyph drawn again shows it.
    const again = (dx: number, text = 'x'): PageChar => ({ ...glyph(10 + dx, text), ink: ink(10, { left: 10.5 + dx, right: 15.5 + dx }) });
    const twice = (second: PageChar, places = [2, 4]): PlacedLabel[] | string => {
      const reading: LabelReading = {
        top: [{ kind: 'other', object: 9 }, { kind: 'box', object: 1, bounds: cellBox }, { kind: 'other', object: 2 }, { kind: 'box', object: 3, bounds: cellBox }, { kind: 'other', object: 4 }],
        nested: 0,
        owners: [2, 4],
        places,
        paints: [WHITE_TEXT, WHITE_TEXT],
      };
      return pageLabels(reading, [glyph(10), second], 0, [cellBox, cellBox], () => null);
    };
    expect(twice(again(2.5))).toEqual([]);
    expect(twice(again(-2.5))).toEqual([]);
    expect(twice(again(2.51))).toBe(UNSEEN());
    expect(twice(again(0, 'y'))).toBe(UNSEEN());
    expect(twice({ ...again(0), ink: null })).toBe(UNSEEN());
    // Drawn again by a later object, though earlier in the reading; or by an earlier one, where that one is not seen.
    expect(twice(again(0), [4, 2])).toEqual([]);
    expect(twice(again(0), [2, 0])).toBe(UNSEEN());
    // By the same object: the cover reaches over half of the first only; or over half of both.
    const sameObject = (first: PageChar, second: PageChar): PlacedLabel[] | string => {
      const reading: LabelReading = {
        top: [{ kind: 'other', object: 9 }, { kind: 'box', object: 1, bounds: cellBox }, { kind: 'other', object: 2 }, { kind: 'other', object: 3 }],
        nested: 0,
        owners: [2, 2],
        places: [2, 2],
        paints: [WHITE_TEXT, WHITE_TEXT],
      };
      return pageLabels(reading, [first, second], 0, [cellBox], (at) => (at === 3 ? { unread: { left: 10.2, right: 13.2, bottom: 0, top: 20 } } : null));
    };
    expect(sameObject(glyph(10), again(0.2))).toEqual([]);
    expect(sameObject(again(0.2), glyph(10))).toEqual([]);
    expect(sameObject(glyph(10), again(-0.5))).toBe(UNSEEN());
  });

  it('takes another glyph drawn over half a glyph\'s ink or more for a cover, but not the same glyph again, an earlier one or a blank', () => {
    const over = (second: PageChar, places = [2, 3]): PlacedLabel[] | string => {
      const reading: LabelReading = {
        top: [{ kind: 'other', object: 9 }, { kind: 'box', object: 1, bounds: cellBox }, { kind: 'other', object: 2 }, { kind: 'other', object: 3 }],
        nested: 0,
        owners: [2, 3],
        places,
        paints: [WHITE_TEXT, WHITE_TEXT],
      };
      return pageLabels(reading, [glyph(10), second], 0, [cellBox], () => null);
    };
    const shifted = (dx: number, text = 'y'): PageChar => ({ ...glyph(10 + dx, text), ink: ink(10 + dx) });
    expect(over(shifted(2.5))).toBe(UNSEEN());
    expect(over(shifted(2.51))).toEqual([]);
    // The same text over half of it or more is the glyph drawn again, not a cover.
    expect(over(shifted(0.5, 'x'))).toEqual([]);
    expect(over(shifted(2.5, 'x'))).toEqual([]);
    // A big glyph over the whole of the small one: it covers it when drawn after it, and is not covered by it.
    const big: PageChar = { ...glyph(9, 'Y'), ink: { left: 9, right: 17, bottom: 3, top: 13 } };
    expect(over(big)).toBe(UNSEEN());
    expect(over(big, [3, 2])).toEqual([]);
    expect(over({ ...big, text: ' ' })).toEqual([]);
    expect(over({ ...big, generated: true })).toEqual([]);
    expect(over({ ...big, ink: null, box: null })).toEqual([]);
  });

  it('judges a glyph whose text object is drawn again as it is (which PDFium does not read again) where that is drawn', () => {
    // The cell at 1, the text at 2, the cell again at 3, the text object again at 4, then whatever is at 5.
    const at = (place: number, paint: Paint = WHITE_TEXT): Twin => ({ at: place, object: 100 + place, paint });
    const twice = (twins: Twin[], last: Unread | null = null, paint: Paint = WHITE_TEXT): PlacedLabel[] | string => {
      const reading: LabelReading = {
        top: [{ kind: 'other', object: 9 }, { kind: 'box', object: 1, bounds: cellBox }, { kind: 'other', object: 2 }, { kind: 'box', object: 3, bounds: cellBox }, { kind: 'other', object: 4 }, { kind: 'other', object: 5 }],
        nested: 0,
        owners: [2],
        places: [2],
        paints: [paint],
        twins: [twins],
      };
      return pageLabels(reading, [glyph(10)], 0, [cellBox, cellBox], (at) => (at === 5 ? last : null));
    };
    expect(twice([at(4)])).toEqual([]);
    expect(twice([])).toBe(UNSEEN());
    expect(twice([at(4)], { unread: { left: 0, right: 100, bottom: 0, top: 20 } })).toBe(UNSEEN());
    expect(twice([at(4, BLACK_TEXT)], null, BLACK_TEXT)).toBe(UNSEEN());
    // The twin is judged by its own paint: clipped away, or not, whatever the first's is.
    expect(twice([at(4, { ...WHITE_TEXT, clips: [[square(0, 0, 1, 1)]] })])).toBe(UNSEEN());
    expect(twice([at(4)], null, { ...WHITE_TEXT, clips: [[square(0, 0, 1, 1)]] })).toEqual([]);
    // A twin at the glyph's own place, or before it, is not drawn after it.
    const early: LabelReading = {
      top: [{ kind: 'box', object: 1, bounds: cellBox }, { kind: 'other', object: 2 }, { kind: 'other', object: 3 }, { kind: 'box', object: 4, bounds: cellBox }],
      nested: 0,
      owners: [3],
      places: [2],
      paints: [WHITE_TEXT],
      twins: [[at(1)]],
    };
    expect(pageLabels(early, [glyph(10)], 0, [cellBox, cellBox], () => null)).toBe(UNSEEN());
    expect(pageLabels({ ...early, twins: [[at(2)]] }, [glyph(10)], 0, [cellBox, cellBox], () => null)).toBe(UNSEEN());
  });

  it('refuses a glyph a clip on it holds only in part, or drawn in a form beside anything else', () => {
    expect(judge([], [], [{ ...WHITE_TEXT, clips: [[square(0, 0, 100, 20)]] }])).toEqual([]);
    // An upright rectangle by the share of the ink it lets show; any other shape only when it holds the ink.
    expect(judge([], [], [{ ...WHITE_TEXT, clips: [[square(0, 0, 100, 20)], [square(0, 0, 12.9, 20)]] }])).toBe(UNSEEN());
    expect(judge([], [], [{ ...WHITE_TEXT, clips: [[square(0, 0, 100, 20)], [square(0, 0, 13.1, 20)]] }])).toEqual([]);
    expect(judge([], [], [{ ...WHITE_TEXT, clips: [[[...square(0, 0, 13.1, 20), [0, 0]]]] }])).toEqual([]);
    expect(judge([], [], [{ ...WHITE_TEXT, clips: [[[[0, 0], [30, 0], [0, 30]]]] }])).toEqual([]);
    expect(judge([], [], [{ ...WHITE_TEXT, clips: [[[[0, 0], [14, 0], [0, 14]]]] }])).toBe(UNSEEN());
    expect(judge([], [], [{ ...WHITE_TEXT, clips: [[[[0, 0], [14, 0], [14, 20], [0, 20], [0, 10]]]] }])).toBe(UNSEEN());
    expect(judge([], [], [{ ...WHITE_TEXT, clips: [[square(0, 0, 13.1, 20), square(0, 0, 13.1, 20)]] }])).toBe(UNSEEN());
    expect(judge([], [], [{ ...WHITE_TEXT, beside: [{ left: 13.1, right: 40, bottom: 0, top: 20 }] }])).toEqual([]);
    expect(judge([], [], [{ ...WHITE_TEXT, beside: [{ left: 12.9, right: 40, bottom: 0, top: 20 }] }])).toBe(UNSEEN());
  });

  it('judges a glyph on at most 32 pieces of what lies under it', () => {
    const strips = (n: number): Shape[] => Array.from({ length: n }, (_, k) => fill(0, [square(10 + k * 0.1, 0, 10.6 + k * 0.1, 20)]));
    expect(judge(strips(31))).toEqual([]);
    expect(judge(strips(32))).toBe(UNSEEN());
  });

  it('asks PDFium\'s drawing of the page about a glyph only where a picture, form or shading lies on its ink or under it', () => {
    const picture: Unread = { unread: { left: 0, right: 100, bottom: 0, top: 20 } };
    const asked: Array<[number, Box]> = [];
    const drawn = (share: number | null) => (object: number, at: Box): number | null => {
      asked.push([object, at]);
      return share;
    };
    const run = (between: Array<Shape | Unread | null>, after: Array<Shape | Unread | null>, share: number | null, paints: Paint[] = [WHITE_TEXT]): PlacedLabel[] | string => {
      const { reading, shapeAt } = page_(between, after, paints);
      return pageLabels(reading, [glyph(10)], 0, [cellBox], shapeAt, { shows: drawn(share) });
    };
    expect(run([], [picture], 0.05)).toEqual([]);
    expect(asked).toEqual([[102, ink(10)]]);
    expect(run([], [picture], 0.0499)).toBe(UNSEEN());
    expect(run([], [picture], null)).toBe(UNSEEN());
    expect(run([picture], [], 0.05)).toEqual([]);
    expect(run([picture], [], 0)).toBe(UNSEEN());
    expect(run([], [], 0, [{ ...WHITE_TEXT, beside: [picture.unread] }])).toBe(UNSEEN());
    expect(run([], [], 1, [{ ...WHITE_TEXT, beside: [picture.unread] }])).toEqual([]);
    // Not asked where nothing it cannot read lies there, nor where the rest already leaves it unseen.
    asked.length = 0;
    expect(run([], [], 0)).toEqual([]);
    expect(run([picture], [], 1, [BLACK_TEXT])).toBe(UNSEEN());
    expect(asked).toEqual([]);
  });

  it('draws the page without at most 24 text objects', () => {
    const picture: Unread = { unread: { left: 0, right: 400, bottom: 0, top: 20 } };
    const wide: Box = { left: 0, right: 400, bottom: 0, top: 20 };
    const many = (n: number): PlacedLabel[] | string => {
      const reading: LabelReading = {
        top: [{ kind: 'box', object: 1, bounds: wide }, ...Array.from({ length: n }, (_, k) => ({ kind: 'other' as const, object: 10 + k })), { kind: 'other', object: 99 }],
        nested: 0,
        owners: Array.from({ length: n }, (_, k) => 10 + k),
        places: Array.from({ length: n }, (_, k) => 1 + k),
        paints: Array.from({ length: n }, () => WHITE_TEXT),
      };
      return pageLabels(reading, Array.from({ length: n }, (_, k) => glyph(10 * k + 1)), 0, [wide], (at) => (at === n + 1 ? picture : null), { shows: () => 1 });
    };
    expect(many(24)).toEqual([]);
    expect(many(25)).toBe(UNSEEN());
  });

  it('refuses a page whose glyphs take more work to judge than it allows', () => {
    const { reading, shapeAt } = page_([fill(0, [square(0, 0, 1, 1)])]);
    const chars = [glyph(10), glyph(20), glyph(30)];
    reading.owners = [104, 104, 104];
    reading.places = [3, 3, 3];
    reading.paints = [WHITE_TEXT, WHITE_TEXT, WHITE_TEXT];
    expect(pageLabels(reading, chars, 1, [cellBox], shapeAt)).toEqual([]);
    expect(pageLabels(reading, chars, 1, [cellBox], shapeAt, { budget: 20 })).toBe('page 2: too much is drawn on the black rectangles of the original to check');
  });

  it('finds the rectangles under a glyph wherever they lie, many or wide, and a glyph with no area by whether one holds it', () => {
    const many = Array.from({ length: 40 }, (_, k): Box => ({ left: k * 2.5, right: k * 2.5 + 2.5, bottom: 0, top: 20 }));
    const reading = (boxes: Box[], paints: Paint[] = [BLACK_TEXT]): LabelReading => ({
      top: [...boxes.map((bounds, k) => ({ kind: 'box' as const, object: k + 1, bounds })), { kind: 'other', object: 99 }],
      nested: 0,
      owners: [99],
      places: [boxes.length],
      paints,
    });
    // Forty strips side by side under it (more than 32 distinct): all of it is taken as on them.
    expect(pageLabels(reading(many), [{ ...glyph(10), ink: { left: 0.5, right: 99.5, bottom: 5, top: 11 } }], 0, many, () => null)).toBe(UNSEEN());
    // A rectangle far wider than the grid's cells, and a glyph far from any rectangle.
    const wide: Box = { left: -5000, right: 5000, bottom: 0, top: 20 };
    expect(pageLabels(reading([wide]), [glyph(10)], 0, [wide], () => null)).toBe(UNSEEN());
    expect(pageLabels(reading([cellBox]), [{ ...glyph(10), ink: { left: 300, right: 305, bottom: 300, top: 306 } }], 0, [cellBox], () => null)).toEqual([]);
    // A glyph whose ink spans the whole grid.
    expect(pageLabels(reading([cellBox]), [{ ...glyph(10), ink: { left: -1000, right: 1000, bottom: -1000, top: 1000 } }], 0, [cellBox], () => null)).toEqual([]);
    // Ink with no area: judged when a rectangle holds it.
    expect(pageLabels(reading([cellBox]), [{ ...glyph(10), ink: { left: 10, right: 10, bottom: 5, top: 11 } }], 0, [cellBox], () => null)).toBe(UNSEEN());
    expect(pageLabels(reading([cellBox]), [{ ...glyph(10), ink: { left: 10, right: 10, bottom: 15, top: 21 } }], 0, [cellBox], () => null)).toEqual([]);
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
