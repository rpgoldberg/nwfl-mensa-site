// BOXLABEL fix round 1: what the challenger did to the labels, as tests. A label's font may draw other glyphs
// than the codes every text layer reads (F1); a box must be one rectangle, drawn round and closed (F3); the
// label check must hold on every rule the mutants showed untested (F2); the copy with its labels taken out is
// made only from content streams PDFium writes (F5). Every name is made up. These PDFs are adversarial in
// shape: run this file only in the capped container.
import { type PDFContext, PDFDict, PDFDocument, PDFName, type PDFObject, PDFRawStream, PDFRef, decodePDFRawStream } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { type PageRef, drawnBreak } from '../../src/pdf/drawn.js';
import { type PlacedLabel, labelMarks, opFontName, pageLabels, unlabelled } from '../../src/pdf/gate-labels.js';
import { gateReply, gateVerdict } from '../../src/pdf/gate-rules.js';
import { BLUR_MAX, type ImageAction } from '../../src/pdf/images.js';
import type { Box, PageChar } from '../../src/pdf/match.js';
import type { LabelReading } from '../../src/pdf/pdfium.js';
import { type RedactRequest, type RedactResult, redactPdf } from '../../src/pdf/redact.js';
import { askLine, fitPdf } from './fit-fixtures.js';
import { twoMarksFixture } from './fixtures.js';

const copyOf = (result: RedactResult): { pdf: Uint8Array; boxes: Box[] } => {
  if (result.kind !== 'redacted') throw new Error(`expected a redacted copy, got ${JSON.stringify(result)}`);
  return result;
};
const load = (pdf: Uint8Array): Promise<PDFDocument> => PDFDocument.load(pdf, { updateMetadata: false });
const hex = (text: string): string => Buffer.from(text, 'latin1').toString('hex').toUpperCase();
const LABEL_OP = /q 1 1 1 rg 0 G 1 0 0 1 (\S+) (\S+) cm BT 1 0 0 1 0 0 Tm \/(\S+) (\S+) Tf 0 Tr <([0-9A-F]+)> Tj ET Q/;
const BOX_OP = /q 0 0 0 rg 0 G (\S+) (\S+) (\S+) (\S+) re f\* Q/;
const WITHHELD_GLYPHS = { code: 'withheld', reason: 'page 1: withheld text is in the glyphs pdf.js draws' };

/** A page's one content stream (PDFium writes one), by reference. */
function contentRef(doc: PDFDocument, index = 0): PDFRef {
  const value = doc.getPage(index).node.get(PDFName.of('Contents'));
  if (!(value instanceof PDFRef)) throw new Error('expected one content stream');
  return value;
}
const contentText = (doc: PDFDocument, index = 0): string => Buffer.from(decodePDFRawStream(doc.context.lookup(contentRef(doc, index)) as PDFRawStream).decode()).toString('latin1');
const contentOf = async (pdf: Uint8Array, index = 0): Promise<string> => contentText(await load(pdf), index);

/** The copy with its page's content changed by `edit` (a subverted engine's), and anything else `more` does. */
async function patched(pdf: Uint8Array, edit: (content: string) => string, more?: (doc: PDFDocument) => void, index = 0): Promise<Uint8Array> {
  const doc = await load(pdf);
  doc.context.assign(contentRef(doc, index), doc.context.flateStream(Buffer.from(edit(contentText(doc, index)), 'latin1')));
  more?.(doc);
  return doc.save({ useObjectStreams: false });
}

/** The copy with the font its first label is drawn in (the name the label's own op uses) made by `make`, or taken away. */
async function withLabelFont(pdf: Uint8Array, make: (context: PDFContext) => PDFObject | undefined): Promise<Uint8Array> {
  const doc = await load(pdf);
  const name = (LABEL_OP.exec(contentText(doc)) as RegExpExecArray)[3] as string;
  const fonts = doc.getPage(0).node.Resources()?.lookup(PDFName.of('Font'), PDFDict) as PDFDict;
  const font = make(doc.context);
  if (font === undefined) fonts.delete(PDFName.of(name));
  else fonts.set(PDFName.of(name), font);
  return doc.save({ useObjectStreams: false });
}

/** The copy with its page's content stream written by `make` from the same content. */
async function withContentStream(pdf: Uint8Array, make: (context: PDFContext, content: string) => PDFRawStream): Promise<Uint8Array> {
  const doc = await load(pdf);
  doc.context.assign(contentRef(doc), make(doc.context, contentText(doc)));
  return doc.save({ useObjectStreams: false });
}

const PDFIUM_HELVETICA = { Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' } as const;
const byte = (code: number): string => code.toString(16).toUpperCase().padStart(2, '0');

/** A ToUnicode map reading each of the label's codes as `reads`'s character in its place. */
function toUnicode(context: PDFContext, label: string, reads: string): PDFRef {
  const pairs = [...new Map([...label].map((ch, i) => [ch.charCodeAt(0), (reads[i] ?? ' ').charCodeAt(0)]))].map(([code, to]) => `<${byte(code)}> <${to.toString(16).toUpperCase().padStart(4, '0')}>`);
  const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Lie def /CIDSystemInfo << /Registry (L) /Ordering (L) /Supplement 0 >> def 1 begincodespacerange <00> <FF> endcodespacerange ${pairs.length} beginbfchar ${pairs.join(' ')} endbfchar endcmap CMapName currentdict /CMap defineresource pop end end`;
  return context.register(context.flateStream(cmap));
}

/**
 * The challenger's F1 font: non-embedded Helvetica whose /Differences draw `glyphs` for the label's codes, with a
 * ToUnicode map reading each code as itself, so every text layer reads the label and pdf.js draws `glyphs`.
 */
function drawsOther(context: PDFContext, label: string, glyphs: string): PDFRef {
  const byCode = new Map([...label].map((ch, i) => [ch.charCodeAt(0), glyphs[i] ?? ' ']));
  const differences = [...byCode].sort((a, b) => a[0] - b[0]).flatMap(([code, glyph]) => [code, glyph === ' ' ? 'space' : glyph]);
  return context.register(context.obj({ ...PDFIUM_HELVETICA, Encoding: { Type: 'Encoding', BaseEncoding: 'WinAnsiEncoding', Differences: differences }, ToUnicode: toUnicode(context, label, label) }));
}

/** The reverse: PDFium's glyphs for the label's codes, read through a ToUnicode map as `reads`. */
const readsOther = (context: PDFContext, label: string, reads: string): PDFRef => context.register(context.obj({ ...PDFIUM_HELVETICA, ToUnicode: toUnicode(context, label, reads) }));

const pagesOf = async (pdf: Uint8Array): Promise<PageRef[]> => (await load(pdf)).getPages().map((page) => ({ num: page.ref.objectNumber, gen: page.ref.generationNumber }));
const marksOf = async (pdf: Uint8Array): Promise<PlacedLabel[][]> => {
  const marks = await labelMarks(pdf);
  if (typeof marks === 'string') throw new Error(marks);
  return marks;
};

/** "Ask Quillon Brask now.", the name withheld from the public only: one box, labelled "Members Only". */
const quillon = async (request: Partial<RedactRequest> = {}): Promise<{ original: Uint8Array; pdf: Uint8Array; box: Box }> => {
  const original = await fitPdf(askLine('(Quillon Brask) Tj'));
  const { pdf, boxes } = copyOf(await redactPdf(original, { quotes: ['Quillon Brask'], membersWithhold: [false], redactsAny: true, ...request }));
  return { original, pdf, box: boxes[0] as Box };
};
const verdictOf = (copy: Uint8Array, original: Uint8Array, quotes: readonly string[] = ['Quillon Brask'], image: ImageAction = 'show') => gateVerdict({ copy, original, quotes, image });

describe('F1: a label counts as one only in PDFium\'s own font, and its glyphs must spell it too', () => {
  const CASES = [
    { label: 'Private', original: twoMarksFixture, quotes: ['Quillon'], membersWithhold: [true], glyphs: 'Quillon' },
    { label: 'Members Only', original: () => fitPdf(askLine('(Varvara Lund) Tj')), quotes: ['Varvara Lund'], membersWithhold: [false], glyphs: 'Varvara Lund' },
    { label: 'Mbrs Only', original: twoMarksFixture, quotes: ['Quillon'], membersWithhold: [false], glyphs: 'Quillon  ' },
  ];

  it.each(CASES.map((c) => [c.label, c] as const))('refuses a "%s" label whose font\'s /Differences draw the quote it covers: "withheld"', async (label, c) => {
    const original = await c.original();
    const { pdf } = copyOf(await redactPdf(original, { quotes: c.quotes, membersWithhold: c.membersWithhold, redactsAny: true }));
    const marks = await marksOf(pdf);
    expect(marks).toEqual([[{ text: label, x: expect.any(Number) as unknown, y: expect.any(Number) as unknown }]]);
    expect((await gateReply({ copy: pdf, original, quotes: c.quotes, image: 'show' })).verdict).toEqual({ pass: true });
    // The same copy with only the label's font changed: every text layer still reads the label, pdf.js draws the quote.
    const lying = await withLabelFont(pdf, (context) => drawsOther(context, label, c.glyphs));
    expect.soft(await gateVerdict({ copy: lying, original, quotes: c.quotes, image: 'show' })).toEqual({ pass: false, code: 'withheld' });
    expect.soft((await gateReply({ copy: lying, original, quotes: c.quotes, image: 'show' })).verdict).toEqual({ pass: false, code: 'withheld' });
    expect.soft(await labelMarks(lying)).toEqual(marks);
    const pages = await pagesOf(lying);
    expect.soft(await drawnBreak(lying, 'show', c.quotes, pages)).toEqual(WITHHELD_GLYPHS);
    // Each layer alone holds: (a) the font is not PDFium's, so no label is taken out; (b) the glyphs do not spell the label.
    expect.soft(await unlabelled(lying, marks)).toBeNull();
    expect.soft(await drawnBreak(lying, 'show', c.quotes, pages, [[label]])).toEqual(WITHHELD_GLYPHS);
  });

  it('(b) takes out of the glyph check only a run whose glyphs and text both spell a label of that page, once each', async () => {
    const original = await fitPdf(askLine('(Private) Tj'));
    const { pdf } = copyOf(await redactPdf(original, { quotes: ['Private'], membersWithhold: [true], redactsAny: true }));
    const pages = await pagesOf(pdf);
    expect(await drawnBreak(pdf, 'show', ['Private'], pages)).toEqual(WITHHELD_GLYPHS);
    expect(await drawnBreak(pdf, 'show', ['Private'], pages, [['Private']])).toBeNull();
    // Another label's exemption takes nothing out, nor one for another page.
    expect(await drawnBreak(pdf, 'show', ['Private'], pages, [['Members Only']])).toEqual(WITHHELD_GLYPHS);
    expect(await drawnBreak(pdf, 'show', ['Private'], pages, [[], ['Private']])).toEqual(WITHHELD_GLYPHS);
    // The word drawn a second time, outside the box, is counted.
    const font = (LABEL_OP.exec(await contentOf(pdf)) as RegExpExecArray)[3] as string;
    const again = await patched(pdf, (content) => `${content}\nq 0 0 0 rg BT /${font} 12 Tf 20 20 Td (Private) Tj ET Q`);
    expect(await drawnBreak(again, 'show', ['Private'], pages, [['Private']])).toEqual(WITHHELD_GLYPHS);
    // Text that spells the label over glyphs that do not, and glyphs that spell it over text that does not.
    const glyphsLie = await withLabelFont(pdf, (context) => drawsOther(context, 'Private', 'Quillon'));
    expect(await drawnBreak(glyphsLie, 'show', ['Quillon'], pages, [['Private']])).toEqual(WITHHELD_GLYPHS);
    const textLie = await withLabelFont(pdf, (context) => readsOther(context, 'Private', 'Quillon'));
    expect(await drawnBreak(textLie, 'show', ['Quillon'], pages, [['Private']])).toEqual(WITHHELD_GLYPHS);
    expect(await unlabelled(textLie, await marksOf(pdf))).toBeNull();
  });

  const FONTS: ReadonlyArray<[string, (context: PDFContext) => PDFObject | undefined]> = [
    ['a /ToUnicode map, even one reading each code as itself', (context) => context.register(context.obj({ ...PDFIUM_HELVETICA, ToUnicode: toUnicode(context, 'Members Only', 'Members Only') }))],
    ['/Widths, /FirstChar and /LastChar', (context) => context.register(context.obj({ ...PDFIUM_HELVETICA, FirstChar: 32, LastChar: 126, Widths: Array.from({ length: 95 }, () => 500) }))],
    ['/FirstChar alone', (context) => context.register(context.obj({ ...PDFIUM_HELVETICA, FirstChar: 32 }))],
    ['/LastChar alone', (context) => context.register(context.obj({ ...PDFIUM_HELVETICA, LastChar: 126 }))],
    ['a /FontDescriptor, embedding nothing', (context) => context.register(context.obj({ ...PDFIUM_HELVETICA, FontDescriptor: { Type: 'FontDescriptor', FontName: 'Helvetica', Flags: 32, FontBBox: [-166, -225, 1000, 931], ItalicAngle: 0, Ascent: 718, Descent: -207, CapHeight: 718, StemV: 88 } }))],
    ['an /Encoding dictionary with no /Differences', (context) => context.register(context.obj({ ...PDFIUM_HELVETICA, Encoding: { Type: 'Encoding', BaseEncoding: 'WinAnsiEncoding' } }))],
    ['/Differences that change nothing', (context) => context.register(context.obj({ ...PDFIUM_HELVETICA, Encoding: { Type: 'Encoding', BaseEncoding: 'WinAnsiEncoding', Differences: [77, 'M'] } }))],
    ['/MacRomanEncoding', (context) => context.register(context.obj({ ...PDFIUM_HELVETICA, Encoding: 'MacRomanEncoding' }))],
    ['no /Encoding', (context) => context.register(context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' }))],
    ['/WinAnsiEncoding behind a reference', (context) => context.register(context.obj({ ...PDFIUM_HELVETICA, Encoding: context.register(PDFName.of('WinAnsiEncoding')) }))],
    ['another base font', (context) => context.register(context.obj({ ...PDFIUM_HELVETICA, BaseFont: 'Helvetica-Bold' }))],
    ['another subtype', (context) => context.register(context.obj({ ...PDFIUM_HELVETICA, Subtype: 'TrueType' }))],
    ['no /Type', (context) => context.register(context.obj({ Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }))],
    ['a key PDFium does not write', (context) => context.register(context.obj({ ...PDFIUM_HELVETICA, Name: 'FXF9' }))],
    ['a stream in the font\'s place', (context) => context.register(context.flateStream('', { ...PDFIUM_HELVETICA }))],
    ['no font under the label\'s name', () => undefined],
  ];

  it.each(FONTS)('(a) takes no label out when the label\'s font has %s', async (_name, make) => {
    const { pdf } = await quillon();
    const marks = await marksOf(pdf);
    expect(await unlabelled(await withLabelFont(pdf, (context) => context.register(context.obj({ ...PDFIUM_HELVETICA }))), marks)).toBeInstanceOf(Uint8Array);
    expect(await unlabelled(await withLabelFont(pdf, make), marks)).toBeNull();
  });

  it('(a) reads the font through the name the label\'s own op uses, and no other', async () => {
    const { pdf } = await quillon();
    const marks = await marksOf(pdf);
    // The label drawn in a lying font under a new name, PDFium's own font left beside it under the old one.
    const renamed = await patched(
      pdf,
      (content) => content.replace(LABEL_OP, (op, _x, _y, name: string) => op.replace(`/${name} `, '/FXL9 ')),
      (doc) => (doc.getPage(0).node.Resources()?.lookup(PDFName.of('Font'), PDFDict) as PDFDict).set(PDFName.of('FXL9'), drawsOther(doc.context, 'Members Only', 'Varvara Lund')),
    );
    expect(await unlabelled(renamed, marks)).toBeNull();
    // A lie in another of the page's fonts, which no label uses, changes nothing.
    const other = await patched(
      pdf,
      (content) => content,
      (doc) => (doc.getPage(0).node.Resources()?.lookup(PDFName.of('Font'), PDFDict) as PDFDict).set(PDFName.of('FXL9'), drawsOther(doc.context, 'Members Only', 'Varvara Lund')),
    );
    expect(await unlabelled(other, marks)).toBeInstanceOf(Uint8Array);
  });

  // Round 2, R2-1: pdf.js and PDFium decode a name's #XX in either case, pdf-lib's PDFName.of only in upper case. So
  // "/FX#4a9" in the op names FXJ9 (here a lying font) to the readers, but to pdf-lib a key that holds PDFium's font.
  const ESCAPES: ReadonlyArray<[string, string]> = [
    ['a lower-case #XX escape, which pdf-lib reads apart from the readers', 'FX#4a9'],
    ['an upper-case #XX escape', 'FX#4A9'],
  ];

  it.each(ESCAPES)('(a) finds no label whose op names its font with %s: PDFium writes FXF<n> (R2-1)', async (_name, escaped) => {
    const original = await twoMarksFixture();
    const { pdf } = copyOf(await redactPdf(original, { quotes: ['Quillon'], membersWithhold: [true], redactsAny: true }));
    const marks = await marksOf(pdf);
    const bad = await patched(
      pdf,
      (content) => content.replace(LABEL_OP, (op, _x, _y, name: string) => op.replace(`/${name} `, `/${escaped} `)),
      (doc) => {
        const fonts = doc.getPage(0).node.Resources()?.lookup(PDFName.of('Font'), PDFDict) as PDFDict;
        fonts.set(PDFName.of('FX#4a9'), doc.context.register(doc.context.obj({ ...PDFIUM_HELVETICA })));
        fonts.set(PDFName.of('FXJ9'), drawsOther(doc.context, 'Private', 'Quillon'));
      },
    );
    expect(Buffer.from(bad).toString('latin1')).toContain('/FX#234a9');
    // PDFium still reads the label, in its box; pdf.js draws the quote under it.
    expect(await labelMarks(bad)).toEqual(marks);
    expect.soft(await unlabelled(bad, marks)).toBeNull();
    expect.soft(await verdictOf(bad, original, ['Quillon'])).toEqual({ pass: false, code: 'withheld' });
    expect.soft((await gateReply({ copy: bad, original, quotes: ['Quillon'], image: 'show' })).verdict).toEqual({ pass: false, code: 'withheld' });
  });

  it('(a) finds no label whose op has any #XX escape, even one that names PDFium\'s own font (R2-1)', async () => {
    const { pdf } = await quillon();
    const marks = await marksOf(pdf);
    // "/FX#46" is FXF to every reader, and FXF holds PDFium's own font: honest, but not as PDFium writes it.
    const escaped = await patched(
      pdf,
      (content) => content.replace(LABEL_OP, (op, _x, _y, name: string) => op.replace(`/${name} `, '/FX#46 ')),
      (doc) => (doc.getPage(0).node.Resources()?.lookup(PDFName.of('Font'), PDFDict) as PDFDict).set(PDFName.of('FXF'), doc.context.register(doc.context.obj({ ...PDFIUM_HELVETICA }))),
    );
    expect(await labelMarks(escaped)).toEqual(marks);
    expect(await unlabelled(escaped, marks)).toBeNull();
    // The same font under a plain name is a label's.
    const plain = await patched(
      pdf,
      (content) => content.replace(LABEL_OP, (op, _x, _y, name: string) => op.replace(`/${name} `, '/FXF ')),
      (doc) => (doc.getPage(0).node.Resources()?.lookup(PDFName.of('Font'), PDFDict) as PDFDict).set(PDFName.of('FXF'), doc.context.register(doc.context.obj({ ...PDFIUM_HELVETICA }))),
    );
    expect(await unlabelled(plain, marks)).toBeInstanceOf(Uint8Array);
  });

  it.each([
    ['no /Font list', (resources: PDFDict) => resources.delete(PDFName.of('Font'))],
    ['a /Font list that is not a dictionary', (resources: PDFDict) => resources.set(PDFName.of('Font'), PDFName.of('Helvetica'))],
  ] as const)('(a) takes no label out of a page whose resources have %s', async (_name, change) => {
    const { pdf } = await quillon();
    const marks = await marksOf(pdf);
    const bad = await patched(pdf, (content) => content, (doc) => change(doc.getPage(0).node.Resources() as PDFDict));
    expect(await unlabelled(bad, marks)).toBeNull();
  });

  it('(a) looks a label\'s font up by its name decoded as the parser decodes one, #XX in either case (R2-1)', () => {
    expect(opFontName('FXF1')).toBe(PDFName.of('FXF1'));
    expect(opFontName('FX#4a9')).toBe(PDFName.of('FXJ9'));
    expect(opFontName('FX#4A9')).toBe(PDFName.of('FXJ9'));
    expect(opFontName('F#2f#2F')).toBe(PDFName.of('F//'));
    expect(opFontName('F#4')).toBe(PDFName.of('F#4'));
  });
});

describe('F5: the labels are taken out only of content streams written as PDFium writes them', () => {
  const STREAMS: ReadonlyArray<[string, (context: PDFContext, content: string) => PDFRawStream]> = [
    ['no filter', (context, content) => context.stream(content)],
    ['/DecodeParms beside /FlateDecode', (context, content) => context.flateStream(content, { DecodeParms: { Predictor: 1 } })],
    ['/FlateDecode in an array', (context, content) => {
      const stream = context.flateStream(content);
      stream.dict.set(PDFName.of('Filter'), context.obj(['FlateDecode']));
      return stream;
    }],
  ];

  it.each(STREAMS)('takes no label out of a content stream with %s', async (_name, make) => {
    const { pdf } = await quillon();
    const marks = await marksOf(pdf);
    expect(await unlabelled(await withContentStream(pdf, (context, content) => context.flateStream(content)), marks)).toBeInstanceOf(Uint8Array);
    expect(await unlabelled(await withContentStream(pdf, make), marks)).toBeNull();
  });
});

describe('F3 and F2: a box is one rectangle, drawn round and closed, opaque black, at the identity', () => {
  const SHAPES: ReadonlyArray<[string, (x: number, y: number, w: number, h: number) => string]> = [
    ['two triangles (a bowtie), its corners in another order', (x, y, w, h) => `q 0 0 0 rg 0 G ${x} ${y} m ${x + w} ${y} l ${x} ${y + h} l ${x + w} ${y + h} l h f* Q`],
    ['four sides, never closed', (x, y, w, h) => `q 0 0 0 rg 0 G ${x} ${y} m ${x + w} ${y} l ${x + w} ${y + h} l ${x} ${y + h} l ${x} ${y} l f* Q`],
    ['five segments, one corner moved in (M20)', (x, y, w, h) => `q 0 0 0 rg 0 G ${x} ${y} m ${x + w} ${y} l ${x + w} ${y + h} l ${x + 1} ${y + h} l h f* Q`],
    ['turned about its middle by its matrix (M12)', (x, y, w, h) => {
      const [left, bottom, right, top] = [Math.floor(x), Math.floor(y), Math.ceil(x + w), Math.ceil(y + h)];
      return `q 0 0 0 rg 0 G -1 0 0 -1 ${left + right} ${bottom + top} cm ${left} ${bottom} ${right - left} ${top - bottom} re f* Q`;
    }],
    ['half transparent', (x, y, w, h) => `q /GSx gs 0 0 0 rg 0 G ${x} ${y} ${w} ${h} re f* Q`],
    ['see-through, its fill opaque but under a soft mask (M13)', (x, y, w, h) => `q /GSm gs 0 0 0 rg 0 G ${x} ${y} ${w} ${h} re f* Q`],
    ['a curve through three corners, closed by a line (5 segments)', (x, y, w, h) => `q 0 0 0 rg 0 G ${x} ${y} m ${x + w} ${y} ${x + w} ${y + h} ${x} ${y + h} c h f* Q`],
  ];

  it.each(SHAPES)('refuses a box drawn as %s: its label is outside any box', async (_name, draw) => {
    const { original, pdf } = await quillon();
    const bad = await patched(
      pdf,
      (content) => content.replace(BOX_OP, (_op, x: string, y: string, w: string, h: string) => draw(Number(x), Number(y), Number(w), Number(h))),
      (doc) => {
        // A luminosity mask whose group draws nothing: black, so whatever it masks is not drawn at all.
        const group = doc.context.register(doc.context.flateStream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 400, 140], Group: { S: 'Transparency', CS: 'DeviceRGB' } }));
        const states = doc.getPage(0).node.Resources()?.lookup(PDFName.of('ExtGState'), PDFDict) as PDFDict;
        states.set(PDFName.of('GSx'), doc.context.obj({ Type: 'ExtGState', ca: 0.5, CA: 0.5 }));
        states.set(PDFName.of('GSm'), doc.context.obj({ Type: 'ExtGState', SMask: { Type: 'Mask', S: 'Luminosity', G: group } }));
      },
    );
    expect(await labelMarks(bad)).toBe('page 1: a label is drawn outside a box');
    expect((await verdictOf(bad, original)).pass).toBe(false);
  });

  it('takes a box drawn round by hand and closed, as "re" draws it', async () => {
    const { original, pdf } = await quillon();
    const drawn = await patched(pdf, (content) =>
      content.replace(BOX_OP, (_op, x: string, y: string, w: string, h: string) => {
        const [X, Y, W, H] = [x, y, w, h].map(Number) as [number, number, number, number];
        return `q 0 0 0 rg 0 G ${X} ${Y} m ${X + W} ${Y} l ${X + W} ${Y + H} l ${X} ${Y + H} l h f* Q`;
      }),
    );
    expect(await labelMarks(drawn)).toEqual(await labelMarks(pdf));
    expect(await verdictOf(drawn, original)).toEqual({ pass: true });
  });
});

describe('F2: the label rules the mutants showed untested', () => {
  it.each([
    ['3 pt (M14)', (op: string) => op.replace(/ \S+ Tf /, ' 3 Tf ')],
    ['invisible, 3 Tr (M15)', (op: string) => op.replace(' 0 Tr ', ' 3 Tr ')],
    ['a clip, 7 Tr (M15)', (op: string) => op.replace(' 0 Tr ', ' 7 Tr ')],
  ])('refuses a label set %s', async (_name, edit) => {
    const { original, pdf } = await quillon();
    const bad = await patched(pdf, (content) => content.replace(LABEL_OP, edit));
    expect(await labelMarks(bad)).toBe("page 1: a label is not in the labels' style");
    expect(await verdictOf(bad, original)).toEqual({ pass: false, code: 'rules' });
  });

  it('refuses a second label in one box, apart from the first, for holding two (M3)', async () => {
    const { original, pdf, box } = await quillon();
    const second = await patched(pdf, (content) => {
      const font = (LABEL_OP.exec(content) as RegExpExecArray)[3] as string;
      return `${content}\nq 1 1 1 rg 0 G 1 0 0 1 ${box.left + 1.5} ${box.bottom + 0.5} cm BT 1 0 0 1 0 0 Tm /${font} 7 Tf 0 Tr <${hex('Private')}> Tj ET Q`;
    });
    // Not the duplicate's path: PDFium reads both labels whole, and the box holds two.
    expect(await labelMarks(second)).toBe('page 1: a box holds more than one label');
    expect(await verdictOf(second, original)).toEqual({ pass: false, code: 'rules' });
  });

  it('refuses a label whose reading needs a space PDFium makes up (M26)', async () => {
    const { original, pdf } = await quillon();
    const spaced = await patched(pdf, (content) => content.replace(`<${hex('Members Only')}> Tj`, `[<${hex('Members')}> -278 <${hex('Only')}>] TJ`));
    expect(await labelMarks(spaced)).toBe('page 1: text other than its label is in a box');
    expect(await verdictOf(spaced, original)).toEqual({ pass: false, code: 'rules' });
  });

  it('refuses a glyph over a box that PDFium names no drawing object for, and passes one drawn under the box (M5)', () => {
    const box: Box = { left: 0, right: 100, bottom: 0, top: 20 };
    const chars: PageChar[] = [{ text: 'x', generated: false, hyphen: false, box: { left: 10, right: 16, bottom: 5, top: 12 }, ink: null, fontSize: 10 }];
    const reading = (places: number[]): LabelReading => ({ top: [{ kind: 'other', object: 7 }, { kind: 'box', object: 1, bounds: box }], nested: 0, owners: [7], places });
    expect(pageLabels(reading([0]), chars, 0)).toEqual([]);
    expect(pageLabels(reading([-1]), chars, 0)).toBe('page 1: text other than its label is in a box');
    expect(pageLabels(reading([]), chars, 0)).toBe('page 1: text other than its label is in a box');
  });

  it('judges a copy whose labels fail by what it shows: a quote in it is "withheld", not only "rules" (M19)', async () => {
    const { original, pdf } = await quillon();
    const font = (LABEL_OP.exec(await contentOf(pdf)) as RegExpExecArray)[3] as string;
    const bad = await patched(pdf, (content) => `${content.replace(hex('Members Only'), hex('withheld'))}\nq 0 0 0 rg BT /${font} 12 Tf 20 120 Td (Quillon Brask) Tj ET Q`);
    expect(typeof (await labelMarks(bad))).toBe('string');
    expect(await verdictOf(bad, original)).toEqual({ pass: false, code: 'withheld' });
  });

  it('takes each label out once, at its own place, and nowhere else (M6, M7)', async () => {
    const { pdf } = await quillon();
    const marks = await marksOf(pdf);
    const [mark] = marks[0] as [PlacedLabel];
    const out = await unlabelled(pdf, marks);
    expect(await contentOf(out as Uint8Array)).not.toContain(hex('Members Only'));
    expect(await contentOf(out as Uint8Array)).toContain(`<${'20'.repeat(12)}>`);
    // A label a point from where PDFium read it is not the label.
    expect(await unlabelled(pdf, [[{ ...mark, x: mark.x + 1 }]])).toBeNull();
    expect(await unlabelled(pdf, [[{ ...mark, y: mark.y - 1 }]])).toBeNull();
    // The same op twice at its place: one label read, one taken out.
    const twice = await patched(pdf, (content) => `${content}\n${(LABEL_OP.exec(content) as RegExpExecArray)[0]}`);
    const once = await contentOf((await unlabelled(twice, marks)) as Uint8Array);
    expect(once.split(`<${hex('Members Only')}>`)).toHaveLength(2);
  });

  // M18 (the walk under the policy skipped once the glyphs pass) survives this: every picture the walk refuses, the pdf-lib
  // rules (readRules) refuse first, here for a /Subtype that is not direct. The test pins that the copy is still refused.
  it.each(['blur', 'hide'] as const)('a quote only in a label leaves the rest of the gate under "%s": a picture past the policy on another page is refused', async (image) => {
    // "Ask Private now." on page 1, the word withheld from members too; page 2 blank.
    const one = await load(await fitPdf(askLine('(Private) Tj')));
    one.addPage([400, 140]);
    const original = await one.save({ useObjectStreams: false });
    const { pdf } = copyOf(await redactPdf(original, { quotes: ['Private'], membersWithhold: [true], redactsAny: true, image }));
    expect(await verdictOf(pdf, original, ['Private'], image)).toEqual({ pass: true });
    // A subverted engine draws a picture larger than either policy on page 2, its /Subtype behind a reference, which
    // pdf.js draws (the walk under the policy refuses it) and the pdf-lib rules refuse as not direct.
    const doc = await load(pdf);
    const page = doc.getPage(1);
    const side = BLUR_MAX + 1;
    const picture = doc.context.stream(Uint8Array.from({ length: side * side }, (_, i) => (i * 37) % 251), { Type: 'XObject', Width: side, Height: side, ColorSpace: 'DeviceGray', BitsPerComponent: 8 });
    picture.dict.set(PDFName.of('Subtype'), doc.context.register(PDFName.of('Image')));
    page.node.setXObject(PDFName.of('Im9'), doc.context.register(picture));
    page.node.addContentStream(doc.context.register(doc.context.flateStream('q 100 0 0 100 72 20 cm /Im9 Do Q')));
    const drawsPicture = await doc.save({ useObjectStreams: false });
    const pages = await pagesOf(drawsPicture);
    expect(await drawnBreak(drawsPicture, image, ['Private'], pages)).toEqual(WITHHELD_GLYPHS);
    expect(await drawnBreak(drawsPicture, image, [], pages)).toEqual({ code: 'rules', reason: `page 2: pdf.js draws a picture of ${side} x ${side}` });
    expect(await verdictOf(drawsPicture, original, ['Private'], image)).toEqual({ pass: false, code: 'rules' });
  });
});
