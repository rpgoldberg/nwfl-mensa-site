// GLYPHMAP: glyphs PDFium draws by their names while every text layer reads a /ToUnicode (BOXLABEL round 2, R2-2),
// and a page whose /Contents lists anything but streams (BOXLABEL round 5, N5-3). Synthetic PDFs only; every name in
// them is made up.
import { PDFDict, PDFDocument, PDFName, PDFNull, PDFNumber, type PDFObject, type PDFRef, PDFString } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { gateReply, gateVerdict } from '../../src/pdf/gate-rules.js';
import { namedBreak } from '../../src/pdf/glyph-names.js';
import { redactPdf } from '../../src/pdf/redact.js';
import { twoMarksFixture } from './fixtures.js';
import { CODES, type FontSpec, KINDS, MEANT, READ_CLASSES, UNREAD_CLASSES, contentText, namesOf, toUnicode, withFont, withRun } from './glyph-fonts.js';

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

describe('GLYPHMAP: a page whose /Contents lists anything but streams (N5-3)', () => {
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
