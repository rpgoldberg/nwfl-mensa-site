// BOXLABEL carries two engine fixes the LINKS L3b challenger found on main (NOTE-1, NOTE-4/T1). Synthetic
// fixtures only, every name made up. These PDFs are adversarial in shape: run this file only in the capped container.
import { type PDFContext, PDFDict, PDFDocument, PDFName, PDFNull, type PDFObject, StandardFonts } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { gateVerdict } from '../../src/pdf/gate-rules.js';
import { linkGuardAreas, patternPicturePages } from '../../src/pdf/link-guard.js';
import { redactPdf } from '../../src/pdf/redact.js';
import { sanitize } from '../../src/pdf/sanitize.js';

const ORIGIN = 'https://nwflorida.us';
const samples = (side: number): Uint8Array => Uint8Array.from({ length: side * side * 3 }, (_, i) => (i * 37 + (i >> 3) * 11) % 251);

/** The challenger's sm-none fixture (l3bc/probe/chal-l3b-fx.ts): an ExtGState whose /SMask is the name /None, as InDesign, Illustrator and Acrobat write it. */
async function smNone(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const ctx = doc.context;
  const page = doc.addPage([612, 792]);
  page.node.set(PDFName.of('Resources'), ctx.obj({ ExtGState: { GS1: ctx.obj({ Type: 'ExtGState', SMask: 'None' }) } }));
  page.node.addContentStream(ctx.register(ctx.stream('q /GS1 gs 0 0 0 rg 100 400 200 200 re f Q')));
  page.drawText('Our members at the picnic.', { x: 72, y: 380, size: 12, font });
  return doc.save({ useObjectStreams: false });
}

describe('NOTE-1: an ExtGState /SMask /None is no soft mask', () => {
  it('is sanitized, not thrown on', async () => {
    await expect(sanitize(await smNone())).resolves.toBeInstanceOf(Uint8Array);
  });

  it('reads /None behind a reference, an ExtGState behind one, and a null one, as no soft mask', async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const ctx = doc.context;
    const none = ctx.register(PDFName.of('None'));
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('Resources'), ctx.obj({ ExtGState: { GS1: ctx.register(ctx.obj({ Type: 'ExtGState', SMask: none })), GS2: ctx.register(ctx.obj({ Type: 'ExtGState', SMask: PDFNull })), GS3: PDFNull } }));
    page.node.addContentStream(ctx.register(ctx.stream('q /GS1 gs /GS2 gs 0 0 0 rg 100 400 200 200 re f Q')));
    await expect(sanitize(await doc.save({ useObjectStreams: false }), 'blur')).resolves.toBeInstanceOf(Uint8Array);
  });

  /** A page drawing in graphics state GS1, whose /SMask `mask` makes, beside a GS2 `state` makes (when it makes one). */
  async function masked(mask: (ctx: PDFContext) => PDFObject, state?: (ctx: PDFContext) => PDFObject): Promise<Uint8Array> {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const ctx = doc.context;
    const page = doc.addPage([612, 792]);
    const states = ctx.obj({ GS1: ctx.register(ctx.obj({ Type: 'ExtGState', SMask: mask(ctx) })) });
    if (state !== undefined) states.set(PDFName.of('GS2'), state(ctx));
    page.node.set(PDFName.of('Resources'), ctx.obj({ ExtGState: states }));
    page.node.addContentStream(ctx.register(ctx.stream(`q /GS1 gs ${state === undefined ? '' : '/GS2 gs '}0 0 0 rg 100 400 200 200 re f Q`)));
    page.drawText('Our members at the picnic.', { x: 72, y: 380, size: 12, font });
    return doc.save({ useObjectStreams: false });
  }

  /** The copy with every ExtGState its page lists changed by `edit`, or its list replaced by what `list` makes. */
  async function restated(pdf: Uint8Array, edit: (ctx: PDFContext, state: PDFDict, states: PDFDict) => void, list?: (ctx: PDFContext) => PDFObject): Promise<Uint8Array> {
    const doc = await PDFDocument.load(pdf, { updateMetadata: false });
    const ctx = doc.context;
    const resources = doc.getPage(0).node.Resources() as PDFDict;
    const states = resources.lookup(PDFName.of('ExtGState'), PDFDict);
    for (const [, state] of states.entries()) edit(ctx, ctx.lookup(state, PDFDict), states);
    if (list !== undefined) resources.set(PDFName.of('ExtGState'), list(ctx));
    return doc.save({ useObjectStreams: false });
  }

  const NOT_A_MASK: ReadonlyArray<[string, (ctx: PDFContext) => PDFObject]> = [
    ['a stream', (ctx) => ctx.register(ctx.stream('', { Type: 'Mask', S: 'Luminosity' }))],
    ['an array', (ctx) => ctx.obj(['None'])],
    ['a number', (ctx) => ctx.obj(7)],
    ['another name', () => PDFName.of('Luminosity')],
  ];

  it.each(NOT_A_MASK)('fails closed on a soft mask that is %s, neither /None nor a dictionary (F4): no copy, and the gate refuses one ("rules")', async (_name, mask) => {
    await expect(sanitize(await masked(mask), 'show')).rejects.toThrow('a soft mask is neither /None nor a dictionary');
    expect(await redactPdf(await masked(mask), { quotes: [], redactsAny: true })).toEqual({ kind: 'refused', reason: 'a soft mask is neither /None nor a dictionary' });
    const original = await smNone();
    for (const image of ['show', 'blur', 'hide'] as const) {
      const result = await redactPdf(original, { quotes: [], redactsAny: true, image });
      if (result.kind !== 'redacted') throw new Error(JSON.stringify(result));
      const bad = await restated(result.pdf, (ctx, state) => state.set(PDFName.of('SMask'), mask(ctx)));
      expect(await gateVerdict({ copy: bad, original, quotes: [], image }), image).toEqual({ pass: false, code: 'rules' });
      // /None behind a reference is still no soft mask.
      const none = await restated(result.pdf, (ctx, state) => state.set(PDFName.of('SMask'), ctx.register(PDFName.of('None'))));
      expect(await gateVerdict({ copy: none, original, quotes: [], image }), image).toEqual({ pass: true });
    }
  });

  it('fails closed on an ExtGState that is not a dictionary, and on an ExtGState list that is not one (F4)', async () => {
    const number = await masked(() => PDFName.of('None'), (ctx) => ctx.register(ctx.obj(7)));
    await expect(sanitize(number, 'blur')).rejects.toThrow('an ExtGState is not a dictionary');
    const original = await smNone();
    const result = await redactPdf(original, { quotes: [], redactsAny: true });
    if (result.kind !== 'redacted') throw new Error(JSON.stringify(result));
    const job = { original, quotes: [], image: 'show' } as const;
    const stream = await restated(result.pdf, (ctx, _state, states) => states.set(PDFName.of('GS9'), ctx.register(ctx.stream('', { Type: 'ExtGState', SMask: 'None' }))));
    expect(await gateVerdict({ ...job, copy: stream })).toEqual({ pass: false, code: 'rules' });
    // An /ExtGState list in the resources of a form the page lists and never draws, where nothing else reads it: a
    // dictionary passes, a stream does not.
    const undrawn = async (list: (ctx: PDFContext) => PDFObject): Promise<Uint8Array> => {
      const doc = await PDFDocument.load(result.pdf, { updateMetadata: false });
      const form = doc.context.register(doc.context.flateStream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10], Resources: { ExtGState: list(doc.context) } }));
      doc.getPage(0).node.setXObject(PDFName.of('Fx9'), form);
      return doc.save({ useObjectStreams: false });
    };
    expect(await gateVerdict({ ...job, copy: await undrawn((ctx) => ctx.obj({ GS9: { Type: 'ExtGState' } })) })).toEqual({ pass: true });
    expect(await gateVerdict({ ...job, copy: await undrawn((ctx) => ctx.register(ctx.stream('', { GS9: ctx.obj({ Type: 'ExtGState' }) }))) })).toEqual({ pass: false, code: 'rules' });
  });

  it('still reads a real soft mask behind references: its group is a content stream, so an inline picture in it refuses the copy under "blur"', async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const ctx = doc.context;
    const group = ctx.register(ctx.stream('BI /W 1 /H 1 /CS /G /BPC 8 ID \u0080 EI', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10], Group: { S: 'Transparency' } }));
    const mask = ctx.register(ctx.obj({ Type: 'Mask', S: 'Luminosity', G: group }));
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('Resources'), ctx.obj({ ExtGState: { GS1: ctx.register(ctx.obj({ Type: 'ExtGState', SMask: mask })) } }));
    page.node.addContentStream(ctx.register(ctx.stream('q /GS1 gs 0 0 0 rg 100 400 200 200 re f Q')));
    const pdf = await doc.save({ useObjectStreams: false });
    await expect(sanitize(pdf, 'blur')).rejects.toThrow('an inline picture cannot be replaced');
    await expect(sanitize(pdf, 'show')).resolves.toBeInstanceOf(Uint8Array);
  });

  it.each(['show', 'blur', 'hide'] as const)('gives a copy under "%s", with or without a passage, and the copy passes every gate check', async (image) => {
    const original = await smNone();
    for (const quotes of [[], ['picnic']]) {
      const result = await redactPdf(original, { quotes, redactsAny: true, image });
      expect(result.kind, JSON.stringify(result)).toBe('redacted');
      if (result.kind !== 'redacted') continue;
      expect(await gateVerdict({ copy: result.pdf, original, quotes, image })).toEqual({ pass: true });
    }
  });
});

describe('NOTE-4 (T1): a picture a Type 3 glyph draws is withheld from links, as a pattern\'s is', () => {
  const CMAP = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /T3U def /CMapType 2 def 1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfchar <41> <0041> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end';
  const OVER = { id: 'p'.repeat(26), page: 1, rect: [150, 450, 250, 550] as [number, number, number, number], label: 'Link to site.example' };

  /** The challenger's T1 fixture (chal-l3b-t1.test.ts): one Type 3 glyph draws a 64 x 64 photo at (100, 400), 200 pt a side. */
  async function type3Photo(): Promise<Uint8Array> {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const ctx = doc.context;
    const side = 64;
    const picture = ctx.register(ctx.flateStream(samples(side), { Type: 'XObject', Subtype: 'Image', Width: side, Height: side, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 }));
    const proc = ctx.register(ctx.stream('200 0 0 0 200 200 d1 q 200 0 0 200 0 0 cm /Im1 Do Q'));
    const t3 = ctx.register(
      ctx.obj({ Type: 'Font', Subtype: 'Type3', FontBBox: [0, 0, 200, 200], FontMatrix: [0.005, 0, 0, 0.005, 0, 0], CharProcs: { g: proc }, Encoding: { Type: 'Encoding', Differences: [65, 'g'] }, FirstChar: 65, LastChar: 65, Widths: [200], Resources: { XObject: { Im1: picture } }, ToUnicode: ctx.register(ctx.stream(CMAP)) }),
    );
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('Resources'), ctx.obj({ Font: { T3: t3 } }));
    page.node.addContentStream(ctx.register(ctx.stream('BT /T3 200 Tf 100 400 Td (A) Tj ET')));
    page.drawText('Our members at the picnic.', { x: 72, y: 380, size: 12, font });
    return doc.save({ useObjectStreams: false });
  }

  it('reads the page as reaching a picture PDFium gives no place for', async () => {
    expect([...(await patternPicturePages(await type3Photo()))]).toEqual([0]);
  });

  it.each(['blur', 'hide'] as const)('drops a link over it under "%s", and the gate refuses a copy that keeps one', async (image) => {
    const original = await type3Photo();
    const honest = await redactPdf(original, { quotes: [], redactsAny: true, origin: ORIGIN, links: [OVER], image });
    expect(honest).toMatchObject({ kind: 'redacted', kept: [] });
    // A subverted engine, as the engine with its guard off: the link is kept, and the gate refuses the copy.
    const kept = await redactPdf(original, { quotes: [], redactsAny: true, origin: ORIGIN, links: [OVER], image }, { guard: () => Promise.resolve([]) });
    expect(kept).toMatchObject({ kind: 'redacted', kept: [OVER.id] });
    if (kept.kind !== 'redacted') return;
    expect(await gateVerdict({ copy: kept.pdf, original, quotes: [], image, origin: ORIGIN, links: [OVER], kept: [OVER.id] })).toEqual({ pass: false, code: 'rules' });
  });

  it('keeps the link under "show", where no picture is withheld', async () => {
    const original = await type3Photo();
    expect(await redactPdf(original, { quotes: [], redactsAny: true, origin: ORIGIN, links: [OVER], image: 'show' })).toMatchObject({ kind: 'redacted', kept: [OVER.id] });
    expect(await linkGuardAreas(original, original, 'show')).toEqual([]);
  });

  it('withholds no page for a Type 3 font that draws no picture, on a page with none', async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const ctx = doc.context;
    const proc = ctx.register(ctx.stream('200 0 0 0 200 200 d1 0 0 200 200 re f'));
    const t3 = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type3', FontBBox: [0, 0, 200, 200], FontMatrix: [0.005, 0, 0, 0.005, 0, 0], CharProcs: { g: proc }, Encoding: { Type: 'Encoding', Differences: [65, 'g'] }, FirstChar: 65, LastChar: 65, Widths: [200], Resources: {} }));
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('Resources'), ctx.obj({ Font: { T3: t3 } }));
    page.node.addContentStream(ctx.register(ctx.stream('BT /T3 20 Tf 100 400 Td (A) Tj ET')));
    expect([...(await patternPicturePages(await doc.save({ useObjectStreams: false })))]).toEqual([]);
  });
});
