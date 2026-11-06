// LIGATURE: a withheld quote drawn with a glyph that has no readable text (its /ToUnicode reads U+FFFD, as Cairo
// writes for a glyph its source gave no Unicode: the fi ligature of MuPDF's HTML layout). The engine boxes it where
// the glyph stands for a ligature of the quote, and refuses where unreadable text could spell a quote; the gate
// refuses on its own what the engine left. Every name here is made up.
import { PDFDocument, PDFName } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { checkCopy } from '../../src/pdf/gate.js';
import { gateVerdict } from '../../src/pdf/gate-rules.js';
import { MAX_READINGS, ligatureReadings } from '../../src/pdf/match.js';
import { type RedactResult, redactPdf, verifyRedacted } from '../../src/pdf/redact.js';
import { extractAll } from './extract.js';

const cmap = (pairs: string): string =>
  `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Lig def /CIDSystemInfo <</Registry (Lig) /Ordering (Lig) /Supplement 0>> def 1 begincodespacerange <00> <FF> endcodespacerange ${pairs} endcmap CMapName currentdict /CMap defineresource pop end end`;
/** Times in its StandardEncoding (\256 is fi, \257 fl): every printable code reads as itself but the ligatures, as U+FFFD. */
const LIGATURES_UNREAD = cmap('1 beginbfrange <20> <7E> <0020> endbfrange 2 beginbfchar <AE> <FFFD> <AF> <FFFD> endbfchar');
/**
 * Times whose letters are drawn at codes of their own (a letter's code plus 0x80), each read as U+FFFD: small caps with
 * no Unicode, as Cairo writes MuPDF's. No string in the file spells them.
 */
const LETTERS_UNREAD = cmap(`1 beginbfchar <20> <0020> endbfchar 2 beginbfrange <C1> <DA> [${'<FFFD> '.repeat(26)}] <E1> <FA> [${'<FFFD> '.repeat(26)}] endbfrange`);
const LETTER_NAMES = [0xc1, ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''), 0xe1, ...'abcdefghijklmnopqrstuvwxyz'.split('')];
/** A line in F2: each letter at its own code, as a hex string. */
const smallCaps = (text: string): string => `<${[...text].map((ch) => (/[A-Za-z]/.test(ch) ? ch.charCodeAt(0) + 0x80 : ch.charCodeAt(0)).toString(16).padStart(2, '0')).join('')}>`;

async function newsletter(lines: readonly string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([612, 792]);
  const { context } = doc;
  const times = (toUnicode: string, extra: Record<string, unknown> = {}) =>
    context.register(context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Times-Roman', ...extra, ToUnicode: context.register(context.flateStream(toUnicode)) }));
  page.node.setFontDictionary(PDFName.of('F1'), times(LIGATURES_UNREAD));
  const differences = LETTER_NAMES.map((d) => (typeof d === 'number' ? d : PDFName.of(d)));
  page.node.setFontDictionary(PDFName.of('F2'), times(LETTERS_UNREAD, { Encoding: { Type: 'Encoding', BaseEncoding: 'WinAnsiEncoding', Differences: differences } }));
  const shown = (line: string): string => (line.startsWith('SC ') ? `/F2 13 Tf ${smallCaps(line.slice(3))}` : `/F1 13 Tf (${line})`);
  page.node.set(PDFName.of('Contents'), context.register(context.flateStream(lines.map((line, i) => `BT 72 ${720 - 20 * i} Td ${shown(line)} Tj ET`).join('\n'))));
  return doc.save({ useObjectStreams: false });
}

/**
 * A page of a newsletter: the ligatures read as U+FFFD in "office", "staff", "Ferncliff" and the quote "Fifi Amberwick"
 * (Times has no ff glyph in its StandardEncoding, so \257, fl, stands in for one: the text layer is what is tested).
 */
const BODY = ['The o\\256ce sta\\257 of the Ferncli\\257 Circle met.', 'Fi\\256 Amberwick kept score at the quiz.', 'Corwin Vellacott led it.'];
const QUOTE = 'Fifi Amberwick';

function copyOf(result: RedactResult): Uint8Array & { boxes: number } {
  if (result.kind !== 'redacted') throw new Error(`expected a redacted copy, got ${JSON.stringify(result)}`);
  return Object.assign(result.pdf, { boxes: result.boxes.length });
}

describe('LIGATURE: a quote drawn with a ligature glyph that reads U+FFFD', () => {
  it('is boxed, the glyph with it, and the gate passes the copy', async () => {
    const original = await newsletter(BODY);
    const copy = copyOf(await redactPdf(original, { quotes: [QUOTE], redactsAny: true }));
    expect(copy.boxes).toBeGreaterThan(0);
    const text = await extractAll(copy);
    expect(text).not.toContain('Amberwick');
    expect(text).toContain('Corwin Vellacott led it.');
    expect(await gateVerdict({ copy, original, quotes: [QUOTE], image: 'show' })).toEqual({ pass: true });
  });

  it('is found by the engine\'s own reading of a copy when no box was drawn (PDFium, after removal)', async () => {
    expect(await verifyRedacted(await newsletter(BODY), [QUOTE])).toBe('page 1: withheld text is still readable after removal');
    expect(await verifyRedacted(await newsletter(['SC Fifi Amberwick']), [QUOTE])).toBe('page 1 has text that cannot be read where a withheld passage may be');
    expect(await verifyRedacted(await newsletter(BODY), ['Mirabel Quince'])).toBeNull();
  });

  it('is refused by the gate on its own when the engine left it (pdf.js reads U+FFFD there)', async () => {
    const left = await newsletter(BODY);
    expect(await checkCopy(left, [QUOTE])).toBe('page 1: text another reader cannot read may hold withheld text');
    expect(await gateVerdict({ copy: left, original: left, quotes: [QUOTE], image: 'show' })).toEqual({ pass: false, code: 'withheld' });
  });

  it('a place name with an ff ligature is boxed too', async () => {
    const copy = copyOf(await redactPdf(await newsletter(BODY), { quotes: ['Ferncliff'], redactsAny: true }));
    expect(copy.boxes).toBe(1);
    expect(await extractAll(copy)).not.toMatch(/Ferncli/);
  });
});

describe('LIGATURE: unreadable letters that could spell a quote', () => {
  it('gives no copy where a run of them is as long as the quote (small caps with no Unicode)', async () => {
    const original = await newsletter([...BODY, 'SC Fifi Amberwick']);
    expect(await redactPdf(original, { quotes: [QUOTE], redactsAny: true })).toEqual({ kind: 'refused', reason: 'page 1 has text that cannot be read where a withheld passage may be' });
    expect(await redactPdf(original, { quotes: ['Corwin Vellacott'], redactsAny: true })).toEqual({ kind: 'refused', reason: 'page 1 has text that cannot be read where a withheld passage may be' });
    expect(await checkCopy(original, ['Mirabel Quince'])).toBe('page 1: text another reader cannot read may hold withheld text');
  });
});

describe('LIGATURE: honest copies with no quote there still pass', () => {
  it('gives a copy with no quote at all, and the gate passes it', async () => {
    const original = await newsletter([...BODY, 'SC Fifi Amberwick']);
    const copy = copyOf(await redactPdf(original, { quotes: [], redactsAny: true }));
    expect(copy.boxes).toBe(0);
    expect(await gateVerdict({ copy, original, quotes: [], image: 'show' })).toEqual({ pass: true });
  });

  it('gives a copy, unboxed, when the quote is not on the page, beside ligatures that read U+FFFD', async () => {
    const original = await newsletter(BODY);
    const copy = copyOf(await redactPdf(original, { quotes: ['Bartholomew Quince'], redactsAny: true }));
    expect(copy.boxes).toBe(0);
    expect(await gateVerdict({ copy, original, quotes: ['Bartholomew Quince'], image: 'show' })).toEqual({ pass: true });
  });
});

/**
 * A page in Times whose ToUnicode reads \256 and \257 as Ghostscript re-distils a ligature (LIGATURE fix 1, F1): a
 * code point that is readable but wrong, U+0856 for fi, f and U+00CF for ffi, U+0000 for a crafted map. Each line is
 * drawn where it says, in the order given.
 */
async function distilled(fi: string, ffi: string, lines: ReadonlyArray<readonly [string, number, number]>): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([612, 792]);
  const { context } = doc;
  const toUnicode = cmap(`1 beginbfrange <20> <7E> <0020> endbfrange 2 beginbfchar <AE> <${fi}> <AF> <${ffi}> endbfchar`);
  page.node.setFontDictionary(PDFName.of('F1'), context.register(context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Times-Roman', ToUnicode: context.register(context.flateStream(toUnicode)) })));
  page.node.set(PDFName.of('Contents'), context.register(context.flateStream(lines.map(([line, x, y]) => `BT /F1 13 Tf ${x} ${y} Td (${line}) Tj ET`).join('\n'))));
  return doc.save({ useObjectStreams: false });
}

/** One line a row, from the top: Ghostscript's fi and ffi (U+0856; f and U+00CF). */
const gs = (...lines: string[]): Promise<Uint8Array> => distilled('0856', '006600CF', lines.map((line, i) => [line, 72, 720 - 20 * i] as const));
const GS_BODY = ['Fi\\256 Amberwick kept score; Ti\\257n Ashgrove set grids.', 'Bartolomeo E\\257ngtonshirecastle thanked Hieronymus Wa\\256estaffordshire.', 'Corwin Vellacott led it.'];

describe('LIGATURE fix 1 (F1): a ligature Ghostscript reads as a wrong but readable code point', () => {
  for (const [quote, left] of [
    ['Fifi Amberwick', /Amberwick/],
    ['Tiffin Ashgrove', /Ashgrove/],
    ['Bartolomeo Effingtonshirecastle', /ngtonshire/],
    ['Hieronymus Wafflestaffordshire', /estafford/],
  ] as const) {
    it(`boxes ${quote}, and the gate passes the copy`, async () => {
      const original = await gs(...GS_BODY);
      const copy = copyOf(await redactPdf(original, { quotes: [quote], redactsAny: true }));
      expect(copy.boxes).toBeGreaterThan(0);
      const text = await extractAll(copy);
      expect(text).not.toMatch(left);
      expect(text).toContain('Corwin Vellacott led it.');
      expect(await gateVerdict({ copy, original, quotes: [quote], image: 'show' })).toEqual({ pass: true });
    });

    it(`the gate alone refuses a copy that shows ${quote}`, async () => {
      const left = await gs(...GS_BODY);
      expect(await checkCopy(left, [quote])).toBe('page 1: text another reader cannot read may hold withheld text');
      expect(await gateVerdict({ copy: left, original: left, quotes: [quote], image: 'show' })).toEqual({ pass: false, code: 'withheld' });
    });
  }

  it('still gives a copy, unboxed, for a quote not on the page and for no quote', async () => {
    const original = await gs(...GS_BODY);
    for (const quotes of [['Bartholomew Quince'], []]) {
      const copy = copyOf(await redactPdf(original, { quotes, redactsAny: true }));
      expect(copy.boxes).toBe(0);
      expect(await gateVerdict({ copy, original, quotes, image: 'show' })).toEqual({ pass: true });
    }
  });
});

describe('LIGATURE fix 1 (F3): the gate reads both of pdf.js\'s orders on its own', () => {
  it('finds a quote through U+FFFD only by position, when it is drawn out of order (X1)', async () => {
    const left = await distilled('FFFD', 'FFFD', [
      ['Amberwick kept score.', 100, 700],
      ['Fi\\256', 72, 700],
    ]);
    expect(await checkCopy(left, ['Fifi Amberwick'])).toBe('page 1: text another reader cannot read may hold withheld text');
  });

  it('finds a quote through U+FFFD only in the order it is drawn, when another line sits between its words by position (X2)', async () => {
    const left = await distilled('FFFD', 'FFFD', [
      ['Fi\\256', 72, 700],
      ['Amberwick', 72, 680],
      ['Corwin Vellacott', 300, 700],
    ]);
    expect(await checkCopy(left, ['Fifi Amberwick'])).toBe('page 1: text another reader cannot read may hold withheld text');
  });
});

describe('LIGATURE fix 1 (F5): a ligature crafted to read U+0000, a space or its first letter', () => {
  const crafted = (to: string): Promise<Uint8Array> => distilled(to, to, [['The o\\256ce sta\\257 met at Ferncli\\257 Hall.', 72, 720], ['Corwin Vellacott led the quiz.', 72, 700]]);

  it('U+0000: boxes the one-word quote, and the gate alone refuses it', async () => {
    const original = await crafted('0000');
    const copy = copyOf(await redactPdf(original, { quotes: ['Ferncliff'], redactsAny: true }));
    expect(copy.boxes).toBe(1);
    expect(await extractAll(copy)).not.toMatch(/Ferncli/);
    expect(await gateVerdict({ copy, original, quotes: ['Ferncliff'], image: 'show' })).toEqual({ pass: true });
    expect(await gateVerdict({ copy: original, original, quotes: ['Ferncliff'], image: 'show' })).toEqual({ pass: false, code: 'withheld' });
  });

  it('LIMIT (documented): a one-word quote whose ligature reads as a space or as its first letter is served', async () => {
    for (const to of ['0020', '0066']) {
      const original = await crafted(to);
      const copy = copyOf(await redactPdf(original, { quotes: ['Ferncliff'], redactsAny: true }));
      expect(copy.boxes, to).toBe(0);
      expect(await gateVerdict({ copy, original, quotes: ['Ferncliff'], image: 'show' }), to).toEqual({ pass: true });
    }
  });
});

describe('LIGATURE fix 1 (F6): the ligature readings tried on a page are capped', () => {
  it('refuses a page with an unreadable glyph whose quotes have more readings than MAX_READINGS between them', async () => {
    const quote = 'Tiffin Shuffleby';
    const each = (ligatureReadings([quote]) as string[]).length;
    const quotes = Array.from({ length: Math.ceil(MAX_READINGS / each) + 1 }, (_, i) => `${quote} ${String.fromCharCode(97 + (i % 26))}${i}`);
    const original = await newsletter(BODY);
    expect(await redactPdf(original, { quotes, redactsAny: true })).toEqual({ kind: 'refused', reason: 'page 1 has text that cannot be read, and the withheld passages have more ligature readings than are tried' });
    // The same quotes on a page with no unreadable glyph: no reading is needed, and the copy is given.
    const plain = await gs('Corwin Vellacott led it.');
    expect(copyOf(await redactPdf(plain, { quotes, redactsAny: true })).boxes).toBe(0);
  });
});

describe('LIGATURE fix 1: glyphs PDFium has no Unicode for, as the gate reads them on its own', () => {
  /** A line in Times whose letters are drawn at codes of their own (a letter's code plus 0x80) named /zz1, /zz2...: no reader knows those names, and the font has no ToUnicode. */
  async function unnamed(text: string): Promise<Uint8Array> {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const page = doc.addPage([612, 792]);
    const { context } = doc;
    const differences = [0xc1, ...Array.from({ length: 26 }, (_, i) => PDFName.of(`zz${i + 1}`)), 0xe1, ...Array.from({ length: 26 }, (_, i) => PDFName.of(`zz${i + 27}`))];
    page.node.setFontDictionary(PDFName.of('F1'), context.register(context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Times-Roman', Encoding: { Type: 'Encoding', BaseEncoding: 'WinAnsiEncoding', Differences: differences } })));
    page.node.set(PDFName.of('Contents'), context.register(context.flateStream(`BT /F1 13 Tf 72 720 Td ${smallCaps(text)} Tj ET\nBT /F1 13 Tf 72 700 Td (Corwin Vellacott led it.) Tj ET`)));
    return doc.save({ useObjectStreams: false });
  }

  it('refuses a copy whose quote is drawn in them, where pdf.js reads no quote: PDFium\'s map errors are unreadable', async () => {
    const left = await unnamed('Fifi Amberwick');
    expect(await checkCopy(left, [QUOTE])).toBeNull();
    expect(await gateVerdict({ copy: left, original: left, quotes: [QUOTE], image: 'show' })).toEqual({ pass: false, code: 'withheld' });
    // With no quote, nothing is withheld: the copy passes.
    expect(await gateVerdict({ copy: left, original: left, quotes: [], image: 'show' })).toEqual({ pass: true });
  });
});
