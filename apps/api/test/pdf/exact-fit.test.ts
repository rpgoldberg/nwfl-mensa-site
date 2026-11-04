// REDACT-LOOK: exact-fit boxes (Ross, 11-02). Each box covers exactly the
// marked glyphs' extent, one line tall; the glyphs are still removed from the
// content, and the copy is checked by its rendered pixels: no pixel of marked
// (red) text is left, and every unmarked (blue) pixel that went missing lies
// inside a drawn box. Copy-paste and search (pdf.js, every inflated stream,
// PDFium's own reading) find nothing of a marked passage. Every name is made up.
// These PDFs are adversarial in shape: run this file only in the capped
// container (SPEC section 4).
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Box, PageChar, Region } from '../../src/pdf/match.js';
import { stillThere } from '../../src/pdf/match.js';
import { Document, LABEL_EMS, Page, labelSize, pdfium } from '../../src/pdf/pdfium.js';
import { type RedactResult, redactPdf } from '../../src/pdf/redact.js';
import { extractAll, leaked, rawText } from './extract.js';
import { FIT_FIXTURES, askLine, fitPdf, pictureNearFixture, scaledTypeFixture } from './fit-fixtures.js';
import { twoMarksFixture } from './fixtures.js';
import { black, blue, contrast, inAny, inside, lost, red, render, where } from './pixels.js';

async function pageChars(pdf: Uint8Array, index = 0): Promise<PageChar[]> {
  const doc = Document.open(await pdfium(), pdf);
  if (doc === null) throw new Error('unopenable');
  try {
    doc.flatten(index);
    return doc.page(index, (page) => page.chars().chars);
  } finally {
    doc.close();
  }
}

const copyOf = (result: RedactResult): { pdf: Uint8Array; boxes: Region[] } => {
  if (result.kind !== 'redacted') throw new Error(`expected a redacted copy, got ${JSON.stringify(result)}`);
  return result;
};

const near = (a: number, b: number): boolean => Math.abs(a - b) <= 0.01;
const overlaps = (a: Box, b: Box): boolean => a.left < b.right && b.left < a.right && a.bottom < b.top && b.bottom < a.top;

describe('PDFium removes a glyph when a quad overlaps its tight box with positive area (pinned: an upgrade that changes it fails here)', () => {
  // "Bo" in Helvetica 12 pt; the probe quads are placed against o's tight box.
  const remaining = async (quad: (o: Box) => Box): Promise<string> => {
    const doc = Document.open(await pdfium(), await fitPdf('BT /F1 12 Tf 20 50 Td (Bo) Tj ET'));
    if (doc === null) throw new Error('unopenable');
    try {
      return doc.page(0, (page) => {
        const o = page.chars().chars[1]?.ink as Box;
        page.removeText([{ ...quad(o), page: 0, fontSize: 12 }]);
        return page.chars().chars.map((c) => c.text).join('');
      });
    } finally {
      doc.close();
    }
  };

  it('keeps a glyph the quad only touches', async () => {
    expect(await remaining((o) => ({ left: o.right, right: o.right + 2, bottom: o.bottom, top: o.top }))).toBe('Bo');
  });

  it('removes a glyph the quad overlaps by 0.05 pt', async () => {
    expect(await remaining((o) => ({ left: o.right - 0.05, right: o.right + 2, bottom: o.bottom, top: o.top }))).toBe('B');
  });

  it('removes a glyph from a quad inside its counter, where it has no ink', async () => {
    const counter = (o: Box): Box => ({
      left: o.left + 0.3 * (o.right - o.left),
      right: o.left + 0.35 * (o.right - o.left),
      bottom: o.bottom + 0.45 * (o.top - o.bottom),
      top: o.bottom + 0.55 * (o.top - o.bottom),
    });
    expect(await remaining(counter)).toBe('B');
  });
});

describe('exact fit: the boxes are the passages\' own widths', () => {
  it('boxes "Bo" and "Quillon" at 12 pt at 14.676 and 37.344 pt, draws them so, and labels only the one that fits', async () => {
    const { pdf, boxes } = copyOf(await redactPdf(await twoMarksFixture(), { quotes: ['Bo', 'Quillon'], redactsAny: true }));
    expect(boxes.map((box) => Number((box.right - box.left).toFixed(3)))).toEqual([14.676, 37.344]);
    const drawn = [...rawText(pdf).matchAll(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) re\b/g)].map((m) => Number(Number(m[3]).toFixed(3)));
    expect(drawn.filter((w) => w === 14.676 || w === 37.344).sort()).toEqual([14.676, 37.344]);
    expect((await extractAll(pdf)).match(/withheld/g)).toHaveLength(1);
  });

  it('labels type set at 1 pt and scaled to 12 pt by its matrix as 12 pt type', async () => {
    const { pdf, boxes } = copyOf(await redactPdf(await scaledTypeFixture(), { quotes: ['Quillon Brask'], redactsAny: true }));
    expect(boxes.map((box) => box.fontSize)).toEqual([12]);
    expect((await extractAll(pdf)).match(/withheld/g)).toHaveLength(1);
  });
});

describe('exact fit: no marked pixel is left, no unmarked pixel goes missing outside a box, nothing can be read', () => {
  for (const fixture of FIT_FIXTURES) {
    it(`${fixture.surface}: ${fixture.name}`, async () => {
      const original = await fixture.pdf();
      const before = await render(original);
      // The fixture is what it says: red ink drawn, every needle readable.
      expect(where(before, red).length).toBeGreaterThan(0);
      const seenBefore = { extracted: await extractAll(original), raw: rawText(original) };
      expect(fixture.needles.filter((needle) => leaked(needle, seenBefore.extracted, seenBefore.raw))).toEqual(fixture.needles);

      const request = { quotes: fixture.quotes, redactsAny: true };
      const result = await redactPdf(original, request);
      if (result.kind === 'refused') {
        // Fail closed is allowed only where the SPEC allows it, and only for a reason like this.
        expect(fixture.mayRefuse, result.reason).toBeDefined();
        expect(result.reason).toMatch(fixture.mayRefuse as RegExp);
        return;
      }
      const { pdf, boxes } = copyOf(result);
      const after = await render(pdf);

      // (i) No pixel of marked text is left.
      expect(where(after, red)).toEqual([]);
      // (ii) Every unmarked pixel that went missing lies inside a drawn box.
      expect(lost(before, after, blue).filter((point) => !inAny(point, boxes))).toEqual([]);
      // (iii) Nothing of a marked passage can be read: pdf.js, the raw streams, PDFium.
      const seen = { extracted: await extractAll(pdf), raw: rawText(pdf) };
      expect(fixture.needles.filter((needle) => leaked(needle, seen.extracted, seen.raw))).toEqual([]);
      const pdfiumText = (await pageChars(pdf)).map((c) => c.text).join('');
      expect(fixture.needles.filter((needle) => leaked(needle, pdfiumText, ''))).toEqual([]);
      // (iv) Each box is exactly the extent of the glyphs removed under it: not widened, not run on.
      const chars = await pageChars(original);
      const there = stillThere(chars, await pageChars(pdf));
      // Spaces have no ink and are never boxed (match.ts exactRegions).
      const removed = chars.filter((c, i) => !there.has(i) && !c.generated && c.text.trim() !== '' && (c.box ?? c.ink) !== null).map((c) => (c.box ?? c.ink) as Box);
      // Loose boxes of adjacent lines can overlap a little: a box's glyphs are the ones it contains.
      const contains = (box: Box, b: Box): boolean => b.left >= box.left - 0.01 && b.right <= box.right + 0.01 && b.bottom >= box.bottom - 0.01 && b.top <= box.top + 0.01;
      for (const box of boxes) {
        const under = removed.filter((b) => contains(box, b));
        expect(under.length, JSON.stringify(box)).toBeGreaterThan(0);
        expect(near(box.left, Math.min(...under.map((b) => b.left))), JSON.stringify(box)).toBe(true);
        expect(near(box.right, Math.max(...under.map((b) => b.right))), JSON.stringify(box)).toBe(true);
      }
      for (const b of removed) expect(boxes.some((box) => contains(box, b)), JSON.stringify(b)).toBe(true);
      // (v) The same bytes every time.
      const again = copyOf(await redactPdf(original, request));
      expect(Buffer.from(again.pdf).equals(Buffer.from(pdf))).toBe(true);
    });
  }
});

describe('pictures near a narrower box (L8)', () => {
  it('refuses a marked word whose glyphs lie under a picture, which a box would only cover', async () => {
    expect(await redactPdf(await pictureNearFixture('over'), { quotes: ['Åsa'], redactsAny: true })).toEqual({
      kind: 'refused',
      reason: 'page 1: a withheld passage lies over a picture',
    });
  });

  it('gives a copy, with the picture untouched, when the picture is beside the word, clear of its glyphs', async () => {
    const original = await pictureNearFixture('beside');
    const { pdf, boxes } = copyOf(await redactPdf(original, { quotes: ['Åsa'], redactsAny: true }));
    // "Ask " is 1.945 em at 18 pt, "Åsa" 1.723 em: the box ends at 20 + 35.01 + 31.014.
    expect(boxes.map((box) => Number(box.right.toFixed(2)))).toEqual([86.02]);
    const grey = (r: number, g: number, b: number): boolean => r === 128 && g === 128 && b === 128;
    expect(where(await render(pdf), grey)).toEqual(where(await render(original), grey));
  });

  it('checks the marked glyphs\' own ink against the pictures, not only their boxes (PDFium\'s loose box holds the ink in every fixture here: a second guard)', async () => {
    const chars = await pageChars(await pictureNearFixture('over'));
    const ring = chars.find((c) => c.text === 'Å') as PageChar;
    expect(ring.ink !== null && ring.box !== null && ring.ink.top <= ring.box.top).toBe(true);
  });
});

describe('a withheld glyph that survives removal (L3)', () => {
  afterEach(() => vi.restoreAllMocks());
  // The real removal, taken before any spy replaces it.
  const remove = Object.getOwnPropertyDescriptor(Page.prototype, 'removeText')?.value as (this: Page, regions: readonly Region[]) => boolean;

  // PDFium's loose box held every glyph's tight box in every shape tried (Type 3 glyphs with d1 boxes
  // that lie, sit off their advance or are empty), so no file makes a glyph survive. These stand in
  // for a removal that misses: the quads are trimmed so the passage's last glyph is left.
  const trimmed = (by: number): void => {
    vi.spyOn(Page.prototype, 'removeText').mockImplementation(function (this: Page, regions: readonly Region[]) {
      return remove.call(this, regions.map((region) => ({ ...region, right: region.right - by })));
    });
  };

  it('is refused when one glyph is left, which no whole-quote check can read ("Quillon Bras" + "k")', async () => {
    trimmed(6);
    expect(await redactPdf(await twoMarksFixture(), { quotes: ['Quillon'], redactsAny: true })).toEqual({
      kind: 'refused',
      reason: 'page 1: a withheld glyph survived removal',
    });
  });

  it('is refused when nothing at all is removed', async () => {
    vi.spyOn(Page.prototype, 'removeText').mockReturnValue(true);
    expect(await redactPdf(await twoMarksFixture(), { quotes: ['Bo', 'Quillon'], redactsAny: true })).toEqual({
      kind: 'refused',
      reason: 'page 1: a withheld glyph survived removal',
    });
  });

  it('is not refused for a space of the passage that PDFium keeps: a space shows nothing', async () => {
    // The quads skip the space between the two words, so PDFium keeps it.
    vi.spyOn(Page.prototype, 'removeText').mockImplementation(function (this: Page, regions: readonly Region[]) {
      const space = this.chars().chars.find((c) => c.text === ' ' && c.box !== null && regions.some((r) => (c.box as Box).left > r.left && (c.box as Box).right < r.right));
      if (space === undefined) throw new Error('no space inside the passage');
      const gap = space.box as Box;
      return remove.call(this, regions.flatMap((r) => [{ ...r, right: gap.left }, { ...r, left: gap.right }]));
    });
    const result = await redactPdf(await fitPdf(askLine('(Quillon Brask) Tj')), { quotes: ['Quillon Brask'], redactsAny: true });
    expect(result.kind).toBe('redacted');
  });
});

describe('labels (L12)', () => {
  it('draws "withheld" in white on the black box, wholly inside it, at a readable contrast, where it fits', async () => {
    const { pdf, boxes } = copyOf(await redactPdf(await twoMarksFixture(), { quotes: ['Quillon'], redactsAny: true }));
    const box = boxes[0] as Region;
    const size = labelSize(box) as number;
    expect(size).toBeCloseTo(9.6, 6);
    // The label's own glyphs, read back by PDFium, lie inside the box.
    const label = (await pageChars(pdf)).filter((c) => c.ink !== null && overlaps(c.ink, box));
    expect(label.map((c) => c.text).join('')).toBe('withheld');
    for (const c of label) {
      const ink = c.ink as Box;
      expect(ink.left >= box.left && ink.right <= box.right && ink.bottom >= box.bottom && ink.top <= box.top, JSON.stringify(ink)).toBe(true);
    }
    expect(LABEL_EMS * size).toBeLessThanOrEqual(box.right - box.left - 2);
    const pixels = inside(await render(pdf), box);
    expect(contrast(pixels)).toBeGreaterThanOrEqual(15);
    expect(pixels.some(([r, g, b]) => r === 255 && g === 255 && b === 255)).toBe(true);
  });

  it('leaves a box too narrow for a readable label without one, all black', async () => {
    const { pdf, boxes } = copyOf(await redactPdf(await twoMarksFixture(), { quotes: ['Bo'], redactsAny: true }));
    expect(labelSize(boxes[0] as Region)).toBeNull();
    expect(await extractAll(pdf)).not.toContain('withheld');
    const pixels = inside(await render(pdf), boxes[0] as Region);
    expect(pixels.length).toBeGreaterThan(0);
    expect(pixels.every(([r, g, b]) => black(r, g, b))).toBe(true);
  });

  it('adds no text but the label: the copy reads as the original with each passage replaced', async () => {
    const { pdf } = copyOf(await redactPdf(await twoMarksFixture(), { quotes: ['Bo', 'Quillon'], redactsAny: true }));
    const words = ((await extractAll(pdf)).split('\n')[0] as string).split(/\s+/).filter((w) => /^[A-Za-z]+$/.test(w));
    expect(words.filter((w) => !['Phone', 'now', 'about', 'the', 'picnic', 'and', 'rest'].includes(w))).toEqual(['withheld']);
  });
});

describe('box opacity (L9)', () => {
  it('paints every box pure black even when the page leaves a translucent, multiplying state open', async () => {
    const fixture = FIT_FIXTURES.find((f) => f.surface === 'L9');
    if (fixture === undefined) throw new Error('no L9 fixture');
    const { pdf, boxes } = copyOf(await redactPdf(await fixture.pdf(), { quotes: fixture.quotes, redactsAny: true }));
    const raster = await render(pdf);
    expect(boxes).toHaveLength(2);
    for (const box of boxes) {
      const pixels = inside(raster, box);
      expect(pixels.length).toBeGreaterThan(0);
      // Black, or the white label: never a translucent grey or a blend of the page.
      expect(pixels.filter(([r, g, b]) => !black(r, g, b) && !(r === g && g === b)), JSON.stringify(box)).toEqual([]);
      expect(pixels.filter(([r, g, b]) => black(r, g, b)).length / pixels.length).toBeGreaterThan(0.5);
    }
  });
});
