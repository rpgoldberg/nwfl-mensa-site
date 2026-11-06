// LINKS L3 fix round 3 (D1): what patternPicturePages costs on a small file built to make its walk
// explode, and what it answers. In the challenger's lattice(n), 3n forms each name one resource
// kind of their own (an empty dictionary) and read the rest from whoever draws them, so a walk
// keyed on the identity of every kind's dictionary walks each form again under every parent's
// combination (36 s, and a V8 heap abort at n = 400, for a 20 KB file at n = 40). The walk now keys
// kinds by what they hold and follows what a set of resources reaches once; and it reads at most
// WALK_BUDGET resource entries a page, and FILE_WALK_BUDGET in all (1,000 pages that share one
// dictionary of WALK_BUDGET entries took 51 s): past them a page counts as reaching a picture
// (withheld whole), which fails safe. Synthetic PDFs only; made-up content.
import { PDFDocument, PDFName, type PDFRef, StandardFonts } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { FILE_WALK_BUDGET, WALK_BUDGET, patternPicturePages } from '../../src/pdf/link-guard.js';

/** Far more than the walk needs once bounded (milliseconds), far less than the unbounded walk took. */
const BOUNDED_MS = 3000;

/** The challenger's lattice: 3n forms, each with only one kind of its own (empty), on one page; `picture` gives the last a tiling pattern that holds a photo. */
async function lattice(n: number, picture = false): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const ctx = doc.context;
  const page = doc.addPage([612, 792]);
  const xobjects: Record<string, unknown> = {};
  for (const kind of ['Font', 'Pattern', 'ExtGState']) {
    for (let i = 0; i < n; i++) xobjects[`${kind[0]}${i}`] = ctx.register(ctx.stream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1], Resources: { [kind]: {} } }));
  }
  if (picture) {
    const photo = ctx.register(ctx.flateStream(new Uint8Array(8 * 8 * 3).map((_, i) => (i * 37) % 251), { Type: 'XObject', Subtype: 'Image', Width: 8, Height: 8, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 }));
    const tile = ctx.register(ctx.stream('q 200 0 0 200 0 0 cm /Im1 Do Q', { Type: 'Pattern', PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 200, 200], XStep: 200, YStep: 200, Resources: { XObject: { Im1: photo } } }));
    xobjects[`P${n - 1}`] = ctx.register(ctx.stream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1], Resources: { Pattern: { T1: tile } } }));
  }
  page.node.set(PDFName.of('Resources'), ctx.obj({ XObject: xobjects as never, Font: { F1: font.ref } }));
  page.node.addContentStream(ctx.register(ctx.stream('BT /F1 12 Tf 72 700 Td (Picnic flyer) Tj ET')));
  return doc.save({ useObjectStreams: false });
}

/**
 * A page whose XObject dictionary names one empty form `count` times: the walk reads each entry once, and nothing more.
 * With `pages`, that many pages share the one dictionary, and `bare` pages with no resource after them.
 */
async function fan(count: number, pages = 1, bare = 0): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const form = ctx.register(ctx.stream('0 0 1 1 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1], Resources: {} }));
  const shared = ctx.register(ctx.obj({ XObject: Object.fromEntries(Array.from({ length: count }, (_, i) => [`X${i}`, form])) }));
  for (let n = 0; n < pages; n++) doc.addPage([612, 792]).node.set(PDFName.of('Resources'), shared);
  for (let n = 0; n < bare; n++) doc.addPage([612, 792]).node.set(PDFName.of('Resources'), ctx.obj({}));
  return doc.save({ useObjectStreams: false });
}

/**
 * A page whose resources name one object `count` times in one kind's dictionary (a form, a shading pattern, a Type 1
 * font, a graphics state with no soft mask), or that has `count` annotations with no appearance, or one annotation
 * with `count` appearance states: the walk reads each entry once, and nothing more (the annotation itself is one).
 */
async function crowd(kind: 'Pattern' | 'Font' | 'ExtGState' | 'Annots' | 'States', count: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const page = doc.addPage([612, 792]);
  const many = (object: PDFRef) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`E${i}`, object]));
  if (kind === 'Annots') page.node.set(PDFName.of('Annots'), ctx.obj(Array.from({ length: count }, () => ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Square', Rect: [0, 0, 1, 1] })))));
  else if (kind === 'States') page.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: [0, 0, 1, 1], AP: { N: many(ctx.register(ctx.stream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1] }))) } }))]));
  else {
    const object = { Pattern: () => ctx.obj({ PatternType: 2, Shading: { ShadingType: 2, ColorSpace: 'DeviceGray', Coords: [0, 0, 1, 0], Function: { FunctionType: 2, Domain: [0, 1], C0: [0], C1: [1], N: 1 } } }), Font: () => ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' }), ExtGState: () => ctx.obj({ Type: 'ExtGState', CA: 1 }) }[kind]();
    page.node.set(PDFName.of('Resources'), ctx.obj({ [kind]: many(ctx.register(object)) }));
  }
  return doc.save({ useObjectStreams: false });
}

/**
 * A page that paints with a tiling pattern whose resources hold a Type 3 font of `count` glyphs (one vector procedure):
 * each glyph is a content stream read inside the pattern, after four reads (the page's pattern, the pattern's content,
 * the page's pattern again as the pattern's own, its font).
 */
async function glyphs(count: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const proc = ctx.register(ctx.stream('1000 0 0 0 750 750 d1 0 0 750 750 re f'));
  const procs = Object.fromEntries(Array.from({ length: count }, (_, i) => [`g${i}`, proc]));
  const font = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type3', FontBBox: [0, 0, 750, 750], FontMatrix: [0.001, 0, 0, 0.001, 0, 0], CharProcs: procs, Encoding: { Type: 'Encoding', Differences: [65, 'g0'] }, FirstChar: 65, LastChar: 65, Widths: [1000] }));
  const tile = ctx.register(ctx.stream('BT /T3 12 Tf 0 0 Td (A) Tj ET', { Type: 'Pattern', PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 20, 20], XStep: 20, YStep: 20, Resources: { Font: { T3: font } } }));
  doc.addPage([612, 792]).node.set(PDFName.of('Resources'), ctx.obj({ Pattern: { P1: tile } }));
  return doc.save({ useObjectStreams: false });
}

/** A page whose XObject dictionary holds `forms` forms, each with a font of its own (so each reads other resources than the rest, and reads the page's XObjects again), then pictures, `entries` in all. */
async function wide(forms: number, entries: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const photo = ctx.register(ctx.flateStream(new Uint8Array(3), { Type: 'XObject', Subtype: 'Image', Width: 1, Height: 1, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 }));
  const font = () => ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' }));
  const xobjects = Array.from({ length: entries }, (_, i): [string, PDFRef] => [`X${i}`, i < forms ? ctx.register(ctx.stream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1], Resources: { Font: { F1: font() } } })) : photo]);
  doc.addPage([612, 792]).node.set(PDFName.of('Resources'), ctx.obj({ XObject: Object.fromEntries(xobjects) }));
  return doc.save({ useObjectStreams: false });
}

/** The pages patternPicturePages names, and how long it took. */
async function timed(pdf: Uint8Array): Promise<{ pages: number[]; ms: number }> {
  const started = performance.now();
  const pages = [...(await patternPicturePages(pdf))];
  return { pages, ms: performance.now() - started };
}

describe('D1: the pattern walk is bounded, and fails safe past its budget', () => {
  it('walks the lattice at n = 40 (20 KB) once per form: no picture, no page withheld, in bounded time', async () => {
    const { pages, ms } = await timed(await lattice(40));
    expect(pages).toEqual([]);
    expect(ms).toBeLessThan(BOUNDED_MS);
  }, 120_000);

  it('walks the lattice at n = 400 too, and finds the photo a lattice form\'s tiling pattern holds, in bounded time', async () => {
    for (const picture of [false, true]) {
      const { pages, ms } = await timed(await lattice(400, picture));
      expect(pages, String(picture)).toEqual(picture ? [0] : []);
      expect(ms, String(picture)).toBeLessThan(BOUNDED_MS);
    }
  }, 120_000);

  it('reads exactly WALK_BUDGET entries on a page, and withholds a page that needs one more, whatever it reads', async () => {
    expect((await timed(await fan(WALK_BUDGET))).pages).toEqual([]);
    expect((await timed(await fan(WALK_BUDGET + 1))).pages).toEqual([0]);
    for (const kind of ['Pattern', 'Font', 'ExtGState', 'Annots'] as const) {
      expect((await timed(await crowd(kind, WALK_BUDGET))).pages, kind).toEqual([]);
      expect((await timed(await crowd(kind, WALK_BUDGET + 1))).pages, kind).toEqual([0]);
    }
    // The annotation is one read, its states the rest.
    expect((await timed(await crowd('States', WALK_BUDGET - 1))).pages).toEqual([]);
    expect((await timed(await crowd('States', WALK_BUDGET))).pages).toEqual([0]);
  }, 300_000);

  it('counts each content stream it reads where PDFium lists no object: a Type 3 font\'s glyphs inside a pattern', async () => {
    expect((await timed(await glyphs(WALK_BUDGET - 4))).pages).toEqual([]);
    expect((await timed(await glyphs(WALK_BUDGET - 3))).pages).toEqual([0]);
  }, 120_000);

  it('reads a page of 200 forms with fonts of their own in full; past the budget (400 of them) withholds it whole, in bounded time', async () => {
    expect((await timed(await wide(200, 200))).pages).toEqual([]);
    const { pages, ms } = await timed(await wide(400, 400));
    expect(pages).toEqual([0]);
    expect(ms).toBeLessThan(BOUNDED_MS);
  }, 120_000);

  it('reads FILE_WALK_BUDGET entries in all, then withholds each page that needs one more; a page that needs none is read', async () => {
    const full = FILE_WALK_BUDGET / WALK_BUDGET;
    expect(full).toBe(16);
    // Sixteen pages read their WALK_BUDGET each, the file's budget exactly; the next four need one more; the last none.
    const { pages } = await timed(await fan(WALK_BUDGET, full + 4, 1));
    expect(pages).toEqual([16, 17, 18, 19]);
  }, 120_000);

  it('walks 1,000 pages that share one dictionary of WALK_BUDGET entries in bounded time, withholding those past the file budget', async () => {
    const { pages, ms } = await timed(await fan(WALK_BUDGET, 1000));
    expect(pages).toEqual(Array.from({ length: 1000 - 16 }, (_, i) => 16 + i));
    expect(ms).toBeLessThan(BOUNDED_MS);
  }, 300_000);
});
