// LINKS L3 fix round 2 (F1, N1): a picture painted by a tiling pattern. PDFium reads no picture
// object for it (a pattern's content is not on the page's object list), so its bounds are not
// known: under "blur" or "hide", a page whose resources reach a tiling pattern that holds a
// picture (directly, through forms, nested patterns, soft masks, Type 3 glyphs or annotation
// appearances) is withheld whole: the engine keeps no link on it and the gate refuses a copy that
// does. And one engine-only test per guard path (N1: the challenger's mutants F03, F04 and F24).
// Synthetic PDFs only; every person is made up and every host is a reserved example name.
import { PDFDocument, PDFName } from '@cantoo/pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import { gateVerdict } from '../../src/pdf/gate-rules.js';
import type { ImageAction } from '../../src/pdf/images.js';
import { type EngineLink, type PageBox, writeLinks } from '../../src/pdf/link-annots.js';
import { linkGuardAreas } from '../../src/pdf/link-guard.js';
import { redactPdf } from '../../src/pdf/redact.js';
import { linesPdf } from './fixtures.js';
import { PATTERN_ROUTES, type PatternRoute, patternPage, photoPage } from './photo.js';

const ORIGIN = 'https://nwflorida.us';
const id = (c: string): string => c.repeat(26);
const link = (c: string, rect: EngineLink['rect'], extra: Partial<EngineLink> = {}): EngineLink => ({ id: id(c), page: 1, rect, label: 'Link to site.example', ...extra });
const job = (copy: Uint8Array, original: Uint8Array, links: readonly EngineLink[], kept: readonly string[], image: ImageAction) => ({ copy, original, quotes: [], image, origin: ORIGIN, links, kept });

/** Over the photo, far from it on the same page, and on page 2. */
const OVER = link('p', [150, 450, 250, 550]);
const FAR = link('f', [400, 700, 500, 720]);
const NEXT = link('n', [72, 697, 250, 711], { page: 2 });
/** The routes that hold a picture, so the page is withheld whole. */
const HOLDING = PATTERN_ROUTES.filter((route) => route !== 'vector');

const wholePages = (areas: readonly PageBox[]): number[] => areas.filter((area) => area.left <= -1e300 && area.right >= 1e300 && area.bottom <= -1e300 && area.top >= 1e300).map((area) => area.page);

/** The engine's copy with no links, when the engine gives one and the gate passes it; else null (no copy is stored for the route at all). */
async function plainCopy(original: Uint8Array, image: ImageAction): Promise<Uint8Array | null> {
  const plain = await redactPdf(original, { quotes: [], redactsAny: true, image });
  if (plain.kind !== 'redacted') return null;
  return (await gateVerdict(job(plain.pdf, original, [], [], image))).pass ? plain.pdf : null;
}

/** The engine's copy with no links, then the links written over it anyway: a subverted engine's; null when there is no copy. */
async function subverted(original: Uint8Array, links: readonly EngineLink[], image: ImageAction): Promise<Uint8Array | null> {
  const plain = await plainCopy(original, image);
  if (plain === null) return null;
  const doc = await PDFDocument.load(plain, { updateMetadata: false });
  writeLinks(doc, ORIGIN, links);
  return doc.save({ useObjectStreams: false });
}

describe('F1: the link guard withholds a page whose resources reach a tiling pattern holding a picture', () => {
  for (const image of ['blur', 'hide'] as const) {
    it(`under "${image}", every route reads page 1 as withheld whole, and page 2 not; a pattern with no picture withholds nothing`, async () => {
      for (const route of PATTERN_ROUTES) {
        const original = await patternPage(route, 2);
        const whole = wholePages(await linkGuardAreas(original, original, image));
        expect(whole, route).toEqual(route === 'vector' ? [] : [0]);
      }
    });
  }

  it('under "show" no route withholds anything: pictures are shown', async () => {
    for (const route of HOLDING) expect(await linkGuardAreas(await patternPage(route, 2), await patternPage(route, 2), 'show'), route).toEqual([]);
  });

  it('withholds each page that reaches one shared pattern, and only those', async () => {
    const original = await patternPage('image', 2);
    const doc = await PDFDocument.load(original, { updateMetadata: false });
    const first = doc.getPage(0);
    for (let n = 0; n < 2; n++) {
      const page = doc.addPage([612, 792]);
      page.node.set(PDFName.of('Resources'), first.node.get(PDFName.of('Resources'))!);
      page.node.addContentStream(doc.context.register(doc.context.stream('q /Pattern cs /P1 scn 100 400 200 200 re f Q')));
    }
    const shared = await doc.save({ useObjectStreams: false });
    expect(wholePages(await linkGuardAreas(shared, shared, 'blur'))).toEqual([0, 2, 3]);
  });
});

describe('F1: the engine keeps no link on such a page, and the gate refuses a copy that does', () => {
  for (const image of ['blur', 'hide'] as const) {
    it(`under "${image}", the engine drops every link on the pattern's page, over the photo or far from it, and keeps the one on page 2`, async () => {
      const made: PatternRoute[] = [];
      for (const route of HOLDING) {
        const original = await patternPage(route, 2);
        // Some routes give no copy at all, links or none: the engine refuses an inline picture, a filter it cannot read or a
        // glyph it cannot read, and the gate the copy of a pattern that draws a picture its resources do not name.
        if ((await plainCopy(original, image)) === null) continue;
        const result = await redactPdf(original, { quotes: [], redactsAny: true, origin: ORIGIN, links: [OVER, FAR, NEXT], image });
        if (result.kind !== 'redacted') throw new Error(`${route}: ${result.kind}`);
        made.push(route);
        expect(result.kept, route).toEqual([NEXT.id]);
        expect(await gateVerdict(job(result.pdf, original, [OVER, FAR, NEXT], result.kept ?? [], image)), route).toEqual({ pass: true });
      }
      // Not vacuous: the routes the challenger and this round found open give a copy.
      expect(made).toEqual(['image', 'flat', 'form', 'nested', 'pageform', 'annot', 'smask', 'predictor']);
    });

    it(`under "${image}", the gate refuses a subverted engine's copy that keeps a link anywhere on the pattern's page, and passes one on page 2`, async () => {
      let checked = 0;
      for (const route of HOLDING) {
        const original = await patternPage(route, 2);
        for (const over of [OVER, FAR]) {
          const copy = await subverted(original, [over, NEXT], image);
          if (copy === null) continue;
          checked++;
          expect(await gateVerdict(job(copy, original, [over, NEXT], [over.id, NEXT.id], image)), `${route} ${over.id[0]}`).toEqual({ pass: false, code: 'rules' });
        }
        const next = await subverted(original, [NEXT], image);
        if (next !== null) expect(await gateVerdict(job(next, original, [NEXT], [NEXT.id], image)), route).toEqual({ pass: true });
      }
      expect(checked).toBe(16);
    });
  }

  it('under "show", the links on a pattern\'s page are kept: nothing is withheld', async () => {
    const original = await patternPage('image', 2);
    const result = await redactPdf(original, { quotes: [], redactsAny: true, origin: ORIGIN, links: [OVER, FAR, NEXT], image: 'show' });
    expect(result).toMatchObject({ kind: 'redacted', kept: [OVER.id, FAR.id, NEXT.id] });
  });

  it('a pattern with no picture costs no link: the page is not withheld', async () => {
    const original = await patternPage('vector', 2);
    const result = await redactPdf(original, { quotes: [], redactsAny: true, origin: ORIGIN, links: [OVER, FAR, NEXT], image: 'blur' });
    expect(result).toMatchObject({ kind: 'redacted', kept: [OVER.id, FAR.id, NEXT.id] });
  });
});

describe('N1: one engine-only test per guard path', () => {
  it('the engine\'s own picture block alone (the guard answering nothing) drops a link over a photo, under "blur" and "hide" (F04)', async () => {
    for (const image of ['blur', 'hide'] as const) {
      const guard = vi.fn<typeof linkGuardAreas>(() => Promise.resolve([]));
      const result = await redactPdf(await photoPage(), { quotes: [], redactsAny: true, origin: ORIGIN, links: [link('p', [100, 400, 300, 600]), link('b', [320, 450, 400, 470])], image }, { guard });
      expect(result, image).toMatchObject({ kind: 'redacted', kept: [id('b')] });
      expect(guard, image).toHaveBeenCalledTimes(1);
    }
  });

  it('the guard alone drops the links that meet what it reads, asked once with the links that survive the rest (F03, F24)', async () => {
    const original = await linesPdf(['Picnic flyer: see www.site.example for the map.']);
    const guard = vi.fn<typeof linkGuardAreas>(() => Promise.resolve([{ page: 0, left: 300, bottom: 600, right: 310, top: 610 }]));
    const met = link('m', [305, 605, 320, 620]);
    const clear = link('c', [72, 697, 250, 711]);
    const result = await redactPdf(original, { quotes: [], redactsAny: true, origin: ORIGIN, links: [met, clear] }, { guard });
    expect(result).toMatchObject({ kind: 'redacted', kept: [clear.id] });
    expect(guard).toHaveBeenCalledTimes(1);
    expect(guard.mock.calls[0]?.[0]).toBe(original);
    expect(guard.mock.calls[0]?.[2]).toBe('show');
  });
});
