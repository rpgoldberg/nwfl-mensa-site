// GLYPHMAP: glyphs PDFium draws by their names while every text layer reads a /ToUnicode (BOXLABEL round 2, R2-2),
// and a page whose /Contents lists anything but streams (BOXLABEL round 5, N5-3). Synthetic PDFs only; every name in
// them is made up.
import { PDFDict, PDFDocument, PDFName, PDFNull, PDFNumber, type PDFObject, type PDFRef, PDFString } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { gateReply, gateVerdict } from '../../src/pdf/gate-rules.js';
import { namedBreak } from '../../src/pdf/glyph-names.js';
import { redactPdf } from '../../src/pdf/redact.js';
import { twoMarksFixture } from './fixtures.js';
import {
  CODES,
  type FontSpec,
  KINDS,
  MEANT,
  READ_CLASSES,
  UNREAD_CLASSES,
  contentText,
  font,
  hex,
  identityCodes,
  identityType0,
  namesOf,
  symbolProgram,
  symbolTrueType,
  toUnicode,
  type3Font,
  withFont,
  withFontRun,
  withPageTwoRun,
  withPatternRun,
  withRun,
} from './glyph-fonts.js';
import { SCALE, render } from './pixels.js';

const WITHHELD = { pass: false, code: 'withheld' };
const LABEL_OP = /q 1 1 1 rg 0 G 1 0 0 1 (\S+) (\S+) cm BT 1 0 0 1 0 0 Tm \/(\S+) (\S+) Tf 0 Tr <([0-9A-F]+)> Tj ET Q/;

async function redacted(original: Uint8Array, quotes: string[], membersWithhold?: boolean[]): Promise<Uint8Array> {
  const result = await redactPdf(original, { quotes, redactsAny: true, ...(membersWithhold ? { membersWithhold } : {}) });
  if (result.kind !== 'redacted') throw new Error(JSON.stringify(result));
  return result.pdf;
}

/** The redacted two-marks copy (Quillon taken out) with a run reading "Private" whose glyph names spell "Quillon" in `cls`. */
async function lyingCopy(kind: FontSpec['kind'], cls: (c: string) => string, reads: string | undefined = CODES): Promise<{ copy: Uint8Array; original: Uint8Array }> {
  const original = await twoMarksFixture();
  const copy = await withRun(await redacted(original, [MEANT]), { kind, codes: CODES, names: namesOf(cls, MEANT), ...(reads === undefined ? {} : { reads }) });
  return { copy, original };
}

const verdict = async (copy: Uint8Array, original: Uint8Array, quotes = [MEANT], image: 'show' | 'blur' = 'show') => gateVerdict({ copy, original, quotes, image });

describe('GLYPHMAP: the glyph names PDFium draws by are read for withheld text (R2-2)', () => {
  it("refuses the challenger's copy: Q.alt names under a /ToUnicode that reads \"Private\", outside any box (chal2-alt)", async () => {
    const { copy, original } = await lyingCopy('non-embedded Type1', READ_CLASSES['suffix .alt'] as (c: string) => string);
    expect(await verdict(copy, original)).toEqual(WITHHELD);
    expect((await gateReply({ copy, original, quotes: [MEANT], image: 'show' })).verdict).toEqual(WITHHELD);
    expect(await namedBreak(copy, [MEANT])).toBe('page 1: withheld text is in the glyph names PDFium draws');
  });

  it.each(KINDS)('refuses a %s font in every name class PDFium reads a letter from (red/a-kinds.txt: it draws them all)', async (kind) => {
    const verdicts: Record<string, unknown> = {};
    for (const [name, cls] of Object.entries(READ_CLASSES)) {
      const { copy, original } = await lyingCopy(kind, cls);
      verdicts[name] = await verdict(copy, original);
    }
    expect(verdicts).toEqual(Object.fromEntries(Object.keys(READ_CLASSES).map((name) => [name, WITHHELD])));
  }, 120_000);

  it.each(KINDS)('refuses a %s font whose suffixed names spell the quote with no /ToUnicode at all, and under "blur"', async (kind) => {
    const { copy, original } = await lyingCopy(kind, READ_CLASSES['suffix .alt'] as (c: string) => string, undefined);
    expect(await verdict(copy, original)).toEqual(WITHHELD);
    expect(await verdict(copy, original, [MEANT], 'blur')).toEqual(WITHHELD);
  }, 60_000);

  it('refuses it in a font with no /Subtype or an unknown one, which PDFium draws as a Type1 font', async () => {
    const original = await twoMarksFixture();
    const pdf = await redacted(original, [MEANT]);
    for (const subtype of [null, 'OpenType']) {
      const copy = await withRun(pdf, { kind: 'non-embedded Type1', codes: CODES, names: namesOf(READ_CLASSES['suffix .alt'] as (c: string) => string, MEANT), reads: CODES, subtype });
      expect(await namedBreak(copy, [MEANT]), String(subtype)).toBe('page 1: withheld text is in the glyph names PDFium draws');
      expect(await verdict(copy, original), String(subtype)).toEqual(WITHHELD);
    }
  });

  it('refuses Q.alt glyph names on a box label, whose exemption is then withdrawn (chal2-attack alt-on-label)', async () => {
    const original = await twoMarksFixture();
    const pdf = await redacted(original, [MEANT], [true]);
    const label = LABEL_OP.exec(await contentText(pdf));
    expect(label?.[5]).toBe(Buffer.from('Private').toString('hex').toUpperCase());
    const copy = await withFont(pdf, label?.[3] as string, { kind: 'non-embedded Type1', codes: 'Private', names: namesOf(READ_CLASSES['suffix .alt'] as (c: string) => string, MEANT), reads: 'Private' });
    expect(await verdict(copy, original)).toEqual(WITHHELD);
    // The honest label passes, the same quote and the same copy otherwise.
    expect(await verdict(pdf, original)).toEqual({ pass: true });
  }, 60_000);

  it('the engine gives no copy of an original whose glyph names draw a withheld quote its /ToUnicode hides', async () => {
    for (const [kind, cls] of [['non-embedded Type1', 'suffix .alt'], ['embedded TrueType', 'plain'], ['embedded CFF', 'suffix .sc']] as const) {
      const original = await withRun(await twoMarksFixture(), { kind, codes: CODES, names: namesOf(READ_CLASSES[cls] as (c: string) => string, MEANT), reads: CODES });
      const result = await redactPdf(original, { quotes: [MEANT], redactsAny: true });
      expect(result, `${kind} ${cls}`).toEqual({ kind: 'refused', reason: 'page 1: withheld text is in the glyph names PDFium draws' });
    }
  }, 60_000);

  // A name PDFium reads no letter from draws nothing in a Type1 or CFF font that has no glyph by it, and the engine
  // refuses such a copy already (on main too: "a withheld glyph survived removal"), so those are TrueType's alone, where
  // PDFium draws the code's own glyph.
  it.each(KINDS)('passes an honest %s font in every name class: the engine takes out the quote its glyphs draw, and the rest reads as it is drawn', async (kind) => {
    const text = `Private ${MEANT}`;
    const verdicts: Record<string, unknown> = {};
    const classes = kind.endsWith('TrueType') ? { ...READ_CLASSES, ...UNREAD_CLASSES } : READ_CLASSES;
    for (const [name, cls] of Object.entries(classes)) {
      const names = [...text].map((c) => (c === ' ' ? 'space' : cls(c)));
      const original = await withRun(await twoMarksFixture(), { kind, codes: text, names, reads: text });
      const result = await redactPdf(original, { quotes: [MEANT], redactsAny: true });
      verdicts[name] = result.kind === 'redacted' ? await verdict(result.pdf, original) : result;
    }
    expect(verdicts).toEqual(Object.fromEntries(Object.keys(classes).map((name) => [name, { pass: true }])));
  }, 180_000);

  it('passes a font shaped as LibreOffice embeds one (TrueType, no /Encoding), whose codes PDFium reads as the quote in Mac Roman', async () => {
    // Codes 52 65 6E 8E 65 are "Renée" in Mac Roman, which PDFium reads such a font's codes in once its /ToUnicode is
    // gone; in Windows-1252, as the gate reads strings, they are "RenŽe". The glyphs drawn are the program's, which the
    // /ToUnicode reads as "Tippi".
    const codes = 'Ren\x8Ee';
    const original = await withRun(await twoMarksFixture(), { kind: 'LibreOffice TrueType', codes, names: null, reads: 'Tippi', flags: 4 });
    const result = await redactPdf(original, { quotes: ['Renée'], redactsAny: true });
    if (result.kind !== 'redacted') throw new Error(JSON.stringify(result));
    expect(await namedBreak(result.pdf, ['Renée'])).toBeNull();
    expect(await verdict(result.pdf, original, ['Renée'])).toEqual({ pass: true });
  }, 60_000);

  it('keeps the /ToUnicode of Type0 and Type3 fonts, which draw by glyph id and by drawing: PDFium reads them through it', async () => {
    const doc = await PDFDocument.load(await twoMarksFixture(), { updateMetadata: false });
    const { context } = doc;
    const page = doc.getPage(0);
    const fonts = page.node.Resources()?.lookup(PDFName.of('Font'), PDFDict) as PDFDict;
    const glyph = context.register(context.flateStream('600 0 0 0 500 700 d1 0 0 500 700 re f'));
    fonts.set(PDFName.of('FT3'), context.register(context.obj({
      Type: 'Font', Subtype: 'Type3', FontBBox: [0, 0, 1000, 1000], FontMatrix: [0.001, 0, 0, 0.001, 0, 0], FirstChar: 32, LastChar: 126,
      Widths: Array.from({ length: 95 }, () => 600), Resources: {}, ToUnicode: toUnicode(context, CODES, 'Grommet'),
      CharProcs: Object.fromEntries([...MEANT].map((c) => [c, glyph])),
      Encoding: { Type: 'Encoding', Differences: [...new Map([...CODES].map((c, i) => [c.charCodeAt(0), MEANT[i] as string]))].sort((a, b) => a[0] - b[0]).flat() },
    })));
    const cid = context.obj({ Type: 'Font', Subtype: 'CIDFontType2', BaseFont: 'Helvetica', CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 }, DW: 600 });
    fonts.set(PDFName.of('FT0'), context.register(context.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: 'Helvetica', Encoding: 'Identity-H', DescendantFonts: [context.register(cid)], ToUnicode: toUnicode(context, '\x00\x01', 'Kx') })));
    const ref = page.node.get(PDFName.of('Contents')) as PDFRef;
    context.assign(ref, context.flateStream(`${await contentText(await doc.save())}\nBT /FT3 24 Tf 72 500 Td <${Buffer.from(CODES, 'latin1').toString('hex')}> Tj ET BT /FT0 24 Tf 72 450 Td <00000001> Tj ET`));
    const copy = await doc.save({ useObjectStreams: false });
    expect(await namedBreak(copy, ['Grommet'])).toBe('page 1: withheld text is in the glyph names PDFium draws');
    expect(await namedBreak(copy, ['Kx'])).toBe('page 1: withheld text is in the glyph names PDFium draws');
  });

  it('reads nothing when nothing is withheld, and refuses bytes it cannot read', async () => {
    const { copy } = await lyingCopy('non-embedded Type1', READ_CLASSES['suffix .alt'] as (c: string) => string);
    expect(await namedBreak(copy, [])).toBeNull();
    expect(await namedBreak(copy, ['Brask'])).toBeNull();
    expect(await namedBreak(Buffer.from('%PDF-1.7\nnot a pdf'), [MEANT])).toBe('the copy could not be read');
  });
});

type Shape = 'self-after' | 'self-before' | 'nested-self' | 'null' | 'number' | 'streams';

/** `pdf` with page 1's /Contents a list of the given shape (BOXLABEL round 5's fixture, chal5-cyclic, and more). */
async function contentsList(pdf: Uint8Array, shape: Shape): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const page = doc.getPage(0);
  const stream = page.node.get(PDFName.of('Contents')) as PDFRef;
  const list = doc.context.obj([]);
  const ref = doc.context.register(list);
  const items: Record<Shape, PDFObject[]> = {
    'self-after': [stream, ref],
    'self-before': [ref, stream],
    'nested-self': [doc.context.register(doc.context.obj([stream, ref]))],
    null: [stream, PDFNull],
    number: [stream, PDFNumber.of(7)],
    streams: [stream, doc.context.register(doc.context.flateStream('q Q'))],
  };
  for (const item of items[shape]) list.push(item);
  page.node.set(PDFName.of('Contents'), ref);
  return doc.save({ useObjectStreams: false });
}

// GLYPHMAP fix round 1: one test per font class the glyph-name reading was not yet pinned for. Each run's /ToUnicode
// reads "Private" while its glyphs are chosen to draw "Quillon"; what PDFium draws is judged by rendering the run and
// comparing it, pixel for pixel, with honest runs of the same font (the renders are in fix1/png). A KNOWN LIMIT test
// pins a copy the gate passes although PDFium draws the quote: namedBreak cannot read it (FOLLOWUP-type0-type3.md).

/** Page 1's pixels where the runs are drawn (x 60 to 460, y 470 to 545), as PDFium renders them. */
async function runArea(pdf: Uint8Array): Promise<Buffer> {
  const r = await render(pdf);
  const [x0, x1, y0, y1] = [60 * SCALE, 460 * SCALE, Math.round((r.pageHeight - 545) * SCALE), Math.round((r.pageHeight - 470) * SCALE)];
  return Buffer.concat(Array.from({ length: y1 - y0 }, (_, y) => Buffer.from(r.rgb.subarray(((y0 + y) * r.width + x0) * 3, ((y0 + y) * r.width + x1) * 3))));
}

/**
 * What PDFium draws for the run of `copy`: the name of the reference run it matches pixel for pixel, "nothing", or
 * "something else". Every reference must draw something, and something no other reference draws (fix round 2, S2), so
 * a match says what is drawn: a run moved off the page matches no reference, where it matched one drawing nothing too.
 */
async function shows(copy: Uint8Array, refs: Record<string, Uint8Array>, blank: Uint8Array): Promise<string> {
  const empty = await runArea(blank);
  const areas: Array<[string, Buffer]> = [];
  for (const [name, ref] of Object.entries(refs)) areas.push([name, await runArea(ref)]);
  for (const [i, [name, ref]] of areas.entries()) {
    expect(ref.equals(empty), `the reference "${name}" draws nothing`).toBe(false);
    for (const [other, drawn] of areas.slice(i + 1)) expect(ref.equals(drawn), `the references "${name}" and "${other}" draw the same`).toBe(false);
  }
  const area = await runArea(copy);
  for (const [name, ref] of areas) if (area.equals(ref)) return name;
  return area.equals(empty) ? 'nothing' : 'something else';
}

const run = (codes: string): string => `BT /FXA1 24 Tf 72 500 Td <${hex(codes)}> Tj ET`;
const judged = async (copy: Uint8Array, original: Uint8Array): Promise<string> => {
  const v = await verdict(copy, original);
  return v.pass ? 'pass' : v.code;
};

describe('GLYPHMAP fix round 1: each font class, what PDFium draws and what the gate does', () => {
  it('(a) Type 3 fonts whose CharProcs are named for the quote\'s letters: refused with no /ToUnicode, drawn boxes pass; KNOWN LIMIT: glyphs that draw their letter in a font of their own under a lying /ToUnicode pass', async () => {
    const original = await twoMarksFixture();
    const pdf = await redacted(original, [MEANT]);
    const letter = (name: string): string => name;
    const t3 = (codes: string, names: readonly string[], shown: (name: string) => string | null, reads?: string): Promise<Uint8Array> =>
      withFontRun(pdf, (ctx) => type3Font(ctx, codes, names, shown, reads), run(codes));
    const refs = { 'the quote': await t3(MEANT, [...MEANT], letter, MEANT), 'seven boxes': await t3(CODES, [...CODES], () => null, CODES) };
    const rows: Record<string, unknown> = {};
    for (const [name, copy] of [
      ['letters, no /ToUnicode', await t3(CODES, [...MEANT], letter)],
      ['boxes, /ToUnicode Private', await t3(CODES, [...MEANT], () => null, CODES)],
      ['letters, /ToUnicode Private', await t3(CODES, [...MEANT], letter, CODES)],
    ] as const) {
      rows[name] = { shows: await shows(copy, refs, pdf), gate: await judged(copy, original), named: await namedBreak(copy, [MEANT]) };
    }
    expect(rows).toEqual({
      // pdf.js reads a Type 3 glyph's name when there is no /ToUnicode, and its text layer then spells the quote.
      'letters, no /ToUnicode': { shows: 'the quote', gate: 'withheld', named: null },
      // The names spell the quote but the glyphs draw boxes: nothing withheld is shown.
      'boxes, /ToUnicode Private': { shows: 'seven boxes', gate: 'pass', named: null },
      // KNOWN LIMIT: PDFium draws "Quillon" and every reading gives "Private". PDFium reads no Type 3 glyph name (with the
      // /ToUnicode taken out it reads no letter at all), so namedBreak keeps Type 3 out; drawn.ts reads each glyph's
      // own text once, in CharProcs order ("Quilon"). FOLLOWUP-type0-type3.md.
      'letters, /ToUnicode Private': { shows: 'the quote', gate: 'pass', named: null },
    });
  }, 120_000);

  it('(b) symbolic embedded TrueType with a (3,0) cmap: names that spell the quote are refused; KNOWN LIMIT: a program cmap that draws it passes', async () => {
    const original = await twoMarksFixture();
    const pdf = await redacted(original, [MEANT]);
    const sym = (draws: string, names: readonly string[] | null, codes = CODES, reads = CODES): Promise<Uint8Array> =>
      withFontRun(pdf, (ctx) => symbolTrueType(ctx, symbolProgram(codes, draws), codes, names, reads), run(codes));
    const refs = { 'the quote': await sym(MEANT, null, MEANT, MEANT), 'the harmless word': await sym(CODES, null) };
    const rows: Record<string, unknown> = {};
    for (const [name, copy] of [
      ['honest cmap, names Quillon', await sym(CODES, [...MEANT])],
      ['honest cmap, names Q.alt ...', await sym(CODES, namesOf(READ_CLASSES['suffix .alt'] as (c: string) => string, MEANT))],
      ['cmap draws Quillon, no /Encoding', await sym(MEANT, null)],
      ['cmap draws Quillon, names Private', await sym(MEANT, [...CODES])],
    ] as const) {
      rows[name] = { shows: await shows(copy, refs, pdf), gate: await judged(copy, original) };
    }
    expect(rows).toEqual({
      // PDFium draws a (3,0) font by code, so these show "Private"; the names read "Quillon", and the gate refuses
      // them (it over-reads, which fails closed, and only for a lying copy).
      'honest cmap, names Quillon': { shows: 'the harmless word', gate: 'withheld' },
      'honest cmap, names Q.alt ...': { shows: 'the harmless word', gate: 'withheld' },
      // KNOWN LIMIT (README: a font program whose own cmap gives a code another letter): what the program draws for
      // a code is in no text layer and no glyph name.
      'cmap draws Quillon, no /Encoding': { shows: 'the quote', gate: 'pass' },
      'cmap draws Quillon, names Private': { shows: 'the quote', gate: 'pass' },
    });
  }, 120_000);

  it.each(KINDS)('(c) uniXXXX and uXXXXX names a %s font draws by, against the base encoding: a quote drawn is refused, and what passes does not draw it', async (kind) => {
    const original = await twoMarksFixture();
    const pdf = await redacted(original, [MEANT]);
    const simple = (codes: string, names: readonly string[], reads = codes): Promise<Uint8Array> => withRun(pdf, { kind, codes, names, reads });
    const refs = { 'the quote': await simple(MEANT, [...MEANT]), 'the harmless word': await simple(CODES, [...CODES]), Qui: await simple('Qui', [...'Qui']), Quivate: await simple('Quivate', [...'Quivate']) };
    const hex4 = (c: string): string => c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0');
    const classes: Record<string, readonly string[]> = {
      'uXXXXX (five digits)': [...MEANT].map((c) => `u0${hex4(c)}`),
      'uniXXXX, lowercase hex': [...MEANT].map((c) => `uni${hex4(c).toLowerCase()}`),
      'uXXXX, lowercase hex': [...MEANT].map((c) => `u${hex4(c).toLowerCase()}`),
      'uniXXXX_alt (underscore)': [...MEANT].map((c) => `uni${hex4(c)}_alt`),
      'uniXXXXYYYY (two letters a name)': ['uni00510075', 'uni0069006C', 'uni006C006F', 'uni006E'],
    };
    const rows: Record<string, unknown> = {};
    for (const [name, names] of Object.entries(classes)) {
      const copy = await simple(CODES.slice(0, names.length), names, CODES.slice(0, names.length));
      rows[name] = { shows: await shows(copy, refs, pdf), gate: await judged(copy, original) };
    }
    // A name PDFium reads no letter from draws nothing, or in TrueType the code's own glyph.
    const trueType = kind.endsWith('TrueType');
    const harmless = trueType ? 'the harmless word' : 'nothing';
    const lowercase = trueType ? 'Quivate' : 'Qui';
    expect(rows).toEqual({
      'uXXXXX (five digits)': { shows: 'the quote', gate: 'withheld' },
      // PDFium reads upper-case hex only: 0051, 0075 and 0069 draw "Qui"; 006c, 006f and 006e are names it reads no
      // letter from, as is uni0051_alt.
      'uniXXXX, lowercase hex': { shows: lowercase, gate: 'pass' },
      'uXXXX, lowercase hex': { shows: lowercase, gate: 'pass' },
      'uniXXXX_alt (underscore)': { shows: harmless, gate: 'pass' },
      // Only the last, one-letter name draws (an "n"); the rest draw nothing.
      'uniXXXXYYYY (two letters a name)': { shows: 'something else', gate: 'pass' },
    });
  }, 120_000);

  it.each(KINDS)('(d) .notdef and empty names in a %s font: codes that spell the quote are refused; .notdef over a harmless word passes', async (kind) => {
    const original = await twoMarksFixture();
    const pdf = await redacted(original, [MEANT]);
    const simple = (codes: string, names: readonly string[], reads: string): Promise<Uint8Array> => withRun(pdf, { kind, codes, names, reads });
    const refs = { 'the quote': await simple(MEANT, [...MEANT], MEANT), 'the harmless word': await simple(CODES, [...CODES], CODES) };
    const rows: Record<string, unknown> = {};
    for (const [name, codes, glyph] of [
      ['codes Quillon, names empty', MEANT, ''],
      ['codes Quillon, names .notdef', MEANT, '.notdef'],
      ['codes Private, names .notdef', CODES, '.notdef'],
    ] as const) {
      const copy = await simple(codes, [...codes].map(() => glyph), CODES);
      rows[name] = { shows: await shows(copy, refs, pdf), gate: await judged(copy, original) };
    }
    // A TrueType font draws nothing for .notdef; a Type1 or CFF one draws glyphs of no word (fix1/png).
    const notdef = kind.endsWith('TrueType') ? 'nothing' : 'something else';
    expect(rows).toEqual({
      // An empty name draws the code's glyph in its base encoding, and PDFium reads it so.
      'codes Quillon, names empty': { shows: 'the quote', gate: 'withheld' },
      'codes Quillon, names .notdef': { shows: notdef, gate: 'withheld' },
      'codes Private, names .notdef': { shows: notdef, gate: 'pass' },
    });
  }, 120_000);

  it('(e) a font held as a direct dict in /Resources /Font, or reached through an array (a page held directly in /Kids), has its /ToUnicode taken out too (C1)', async () => {
    const original = await twoMarksFixture();
    const pdf = await redacted(original, [MEANT]);
    const spec: FontSpec = { kind: 'non-embedded Type1', codes: CODES, names: namesOf(READ_CLASSES['suffix .alt'] as (c: string) => string, MEANT), reads: CODES };
    const refs = { 'the quote': await withRun(pdf, { kind: 'non-embedded Type1', codes: MEANT, names: [...MEANT], reads: MEANT }) };
    const direct = await withFontRun(pdf, (ctx) => font(ctx, spec), run(CODES), 'direct');
    expect(await shows(direct, refs, pdf)).toBe('the quote');
    expect(await namedBreak(direct, [MEANT])).toBe('page 1: withheld text is in the glyph names PDFium draws');
    expect(await verdict(direct, original)).toEqual(WITHHELD);
    // PDFium draws a page held directly in /Kids. pdf-lib cannot write such a tree, so once the walk has found the
    // font's /ToUnicode the reading cannot be made, and the copy is refused as unreadable; the rules refuse it too.
    const inArray = await withFontRun(pdf, (ctx) => font(ctx, spec), run(CODES), 'in an array');
    expect(await shows(inArray, refs, pdf)).toBe('the quote');
    expect(await namedBreak(inArray, [MEANT])).toBe('the copy could not be read');
    expect(await verdict(inArray, original)).toEqual({ pass: false, code: 'rules' });
  }, 60_000);

  it('(f) KNOWN LIMIT: a Type0 Identity-H font whose /ToUnicode lies about the glyph ids it draws passes, while the honest one is refused', async () => {
    const original = await twoMarksFixture();
    const pdf = await redacted(original, [MEANT]);
    const t0 = (reads: string, draws = MEANT): Promise<Uint8Array> => withFontRun(pdf, (ctx) => identityType0(ctx, draws, reads), `BT /FXA1 24 Tf 72 500 Td <${identityCodes(draws)}> Tj ET`);
    const honest = await t0(MEANT);
    const lying = await t0(CODES);
    // The same glyphs are drawn: PDFium shows "Quillon" for both (fix1/png), and not the harmless word's.
    expect(await shows(lying, { 'the honest run': honest, 'the harmless word': await t0(CODES, CODES) }, pdf)).toBe('the honest run');
    expect(await verdict(honest, original)).toEqual(WITHHELD);
    // KNOWN LIMIT: a code is a glyph id, and with the /ToUnicode taken out PDFium reads no letter for it and pdf.js
    // reads the id itself as a character, so neither can be asked what the glyphs are. FOLLOWUP-type0-type3.md.
    expect(await namedBreak(lying, [MEANT])).toBeNull();
    expect(await verdict(lying, original)).toEqual({ pass: true });
  }, 60_000);

  it('refuses glyph names that draw a one-character quote (C3)', async () => {
    const original = await twoMarksFixture();
    const pdf = await redacted(original, [MEANT]);
    const copy = await withRun(pdf, { kind: 'non-embedded Type1', codes: 'P', names: ['Q.alt'], reads: 'P' });
    expect(await namedBreak(copy, ['Q'])).toBe('page 1: withheld text is in the glyph names PDFium draws');
    expect(await namedBreak(pdf, ['Q'])).toBeNull();
  });
});

describe('GLYPHMAP: a page whose /Contents lists anything but streams (N5-3)', () => {
  it('passes a blank page with no /Contents at all (C2)', async () => {
    const doc = await PDFDocument.load(await twoMarksFixture(), { updateMetadata: false });
    doc.addPage([612, 792]);
    const original = await doc.save({ useObjectStreams: false });
    const made = await PDFDocument.load(await redacted(original, [MEANT]), { updateMetadata: false });
    made.getPage(1).node.delete(PDFName.of('Contents'));
    const copy = await made.save({ useObjectStreams: false });
    expect((await PDFDocument.load(copy)).getPage(1).node.has(PDFName.of('Contents'))).toBe(false);
    for (const image of ['show', 'blur'] as const) expect(await verdict(copy, original, [MEANT], image), image).toEqual({ pass: true });
  }, 60_000);

  it('refuses a list that holds itself, another list, null or a number, under every policy and with or without quotes; passes a list of streams', async () => {
    const original = await twoMarksFixture();
    const pdf = await redacted(original, [MEANT]);
    const verdicts: Record<string, unknown> = {};
    for (const shape of ['self-after', 'self-before', 'nested-self', 'null', 'number', 'streams'] as const) {
      const copy = await contentsList(pdf, shape);
      for (const quotes of [[MEANT], []]) {
        for (const image of ['show', 'blur'] as const) {
          const v = await gateVerdict({ copy, original, quotes, image });
          verdicts[`${shape} ${image} ${quotes.length}`] = v.pass ? 'pass' : v.code;
        }
      }
    }
    const want = (shape: Shape): string => (shape === 'streams' ? 'pass' : 'rules');
    expect(verdicts).toEqual(Object.fromEntries(Object.keys(verdicts).map((key) => [key, want(key.split(' ')[0] as Shape)])));
  }, 120_000);
});

describe('GLYPHMAP fix round 2: a run in a tiling pattern (B1), a run on page 2 alone (S1), and an MMType1 font (N1)', () => {
  const TILED = 'a tiling pattern shows text, or draws content that cannot be read';
  const RULES = { pass: false, code: 'rules' };
  const alt = (kind: FontSpec['kind'], extra: Partial<FontSpec> = {}): FontSpec => ({ kind, codes: CODES, names: namesOf(READ_CLASSES['suffix .alt'] as (c: string) => string, MEANT), reads: CODES, ...extra });

  it.each(KINDS)('refuses as "rules" a %s run in a tiling pattern that PDFium draws as the quote while it reads no text there, under "show" and "blur"', async (kind) => {
    const original = await twoMarksFixture();
    const pdf = await redacted(original, [MEANT]);
    const honest = await withPatternRun(pdf, { kind, codes: MEANT, names: [...MEANT], reads: MEANT });
    const lying = await withPatternRun(pdf, alt(kind));
    expect(await shows(lying, { 'the quote': honest, 'the harmless word': await withPatternRun(pdf, { kind, codes: CODES, names: [...CODES], reads: CODES }) }, pdf)).toBe('the quote');
    // PDFium reads no text inside a tiling pattern, with the /ToUnicode taken out or not: the glyph-name reading is blind there.
    expect(await namedBreak(lying, [MEANT])).toBeNull();
    for (const image of ['show', 'blur'] as const) {
      expect(await verdict(lying, original, [MEANT], image), image).toEqual(RULES);
      expect(await verdict(honest, original, [MEANT], image), `honest, ${image}`).toEqual(RULES);
      expect(await verdict(lying, original, [], image), `no quotes, ${image}`).toEqual(RULES);
    }
  }, 120_000);

  it('the engine gives no copy, under any policy, of an original that draws the run in a tiling pattern (adv2 E2E: it made one, and the gate passed it)', async () => {
    const original = await withPatternRun(await twoMarksFixture(), alt('embedded TrueType'));
    for (const image of ['show', 'blur', 'hide'] as const) expect(await redactPdf(original, { quotes: [MEANT], redactsAny: true, image }), image).toEqual({ kind: 'refused', reason: TILED });
  }, 60_000);

  it('reads every page: a run on page 2 alone is found there, and refused (M14)', async () => {
    const original = await twoMarksFixture();
    const pdf = await redacted(original, [MEANT]);
    const copy = await withPageTwoRun(pdf, alt('non-embedded Type1'));
    expect((await PDFDocument.load(copy)).getPageCount()).toBe(2);
    expect(await namedBreak(pdf, [MEANT])).toBeNull();
    expect(await namedBreak(copy, [MEANT])).toBe('page 2: withheld text is in the glyph names PDFium draws');
    expect(await verdict(copy, original)).toEqual(WITHHELD);
  }, 60_000);

  it('takes the /ToUnicode out of an MMType1 font, which PDFium draws by name as a Type1 one (M15)', async () => {
    const original = await twoMarksFixture();
    const pdf = await redacted(original, [MEANT]);
    const copy = await withRun(pdf, alt('non-embedded Type1', { subtype: 'MMType1' }));
    const refs = { 'the quote': await withRun(pdf, { kind: 'non-embedded Type1', codes: MEANT, names: [...MEANT], reads: MEANT, subtype: 'MMType1' }) };
    expect(await shows(copy, refs, pdf)).toBe('the quote');
    expect(await namedBreak(copy, [MEANT])).toBe('page 1: withheld text is in the glyph names PDFium draws');
    expect(await verdict(copy, original)).toEqual(WITHHELD);
  }, 60_000);
});
