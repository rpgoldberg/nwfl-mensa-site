// LINKS L3 fix round 1 (S1, N1): what no kept link may meet, read with PDFium (link-guard.ts).
// Synthetic PDFs only; every person is made up.
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { linkGuardAreas } from '../../src/pdf/link-guard.js';
import { meets } from '../../src/pdf/link-annots.js';
import { redactPdf, withheldAreas } from '../../src/pdf/redact.js';
import { linesPdf } from './fixtures.js';
import { photoPage } from './photo.js';

describe('linkGuardAreas', () => {
  it('reads what is withheld with PDFium: each missing glyph\'s box (and ink), and under a policy that does not show them every picture, by page', async () => {
    const original = await linesPdf(['Tobias Wrenhallow hosted it.']);
    const copy = await redactPdf(original, { quotes: ['Wrenhallow'], redactsAny: true });
    const areas = await linkGuardAreas(original, (copy as { pdf: Uint8Array }).pdf, 'show');
    const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    const start = 72 + font.widthOfTextAtSize('Tobias ', 12);
    const end = 72 + font.widthOfTextAtSize('Tobias Wrenhallow', 12);
    expect(areas.length).toBeGreaterThanOrEqual(10);
    // PDFium's widths for the base font run a little past pdf-lib's (174.0 for 171.9 here): 3 pt of slack.
    expect(areas.every((area) => area.page === 0 && area.left >= start - 3 && area.right <= end + 3 && area.bottom >= 710 && area.top <= 735)).toBe(true);
    expect(areas.some((area) => area.right > end + 1)).toBe(true);
    // Nothing missing from the original itself, and no picture counted under "show".
    expect(await linkGuardAreas(original, original, 'hide')).toEqual([]);
    const photo = await photoPage(true, 2);
    expect(await linkGuardAreas(photo, photo, 'show')).toEqual([]);
    const pictures = await linkGuardAreas(photo, photo, 'blur');
    expect(pictures.map((area) => [area.page, Math.round(area.left), Math.round(area.bottom), Math.round(area.right), Math.round(area.top)])).toEqual([
      [0, 100, 400, 300, 600],
      [1, 100, 400, 300, 600],
    ]);
  });

  it('throws for a file PDFium cannot open, so neither the engine nor the gate keeps a link on it', async () => {
    await expect(linkGuardAreas(Uint8Array.from([1, 2, 3]), Uint8Array.from([1, 2, 3]), 'show')).rejects.toThrow(/cannot be opened/);
    const original = await linesPdf(['Picnic flyer']);
    await expect(linkGuardAreas(original, Uint8Array.from([1, 2, 3]), 'show')).rejects.toThrow(/cannot be opened/);
    await expect(linkGuardAreas(await photoPage(false, 2), original, 'show')).rejects.toThrow(/other pages/);
  });
});

describe('withheldAreas: what the engine itself blocks on a page (N6)', () => {
  const glyph = (box: { left: number; bottom: number; right: number; top: number } | null, ink: typeof box) => ({ text: 'x', generated: false, hyphen: false, box, ink, fontSize: 12 });

  it('blocks the passages, the drawn boxes, and the ink of every removed glyph, even ink that reaches past its box', () => {
    const box = { left: 10, bottom: 10, right: 20, top: 20 };
    const region = { ...box, page: 2, fontSize: 12 };
    // An italic overhang: the glyph's ink reaches 5 pt past the box drawn over it.
    const chars = [glyph(box, { left: 8, bottom: 9, right: 25, top: 22 }), glyph(box, null), glyph(box, { left: 40, bottom: 10, right: 50, top: 20 })];
    const areas = withheldAreas(2, [region], [region], chars, new Set([0, 1, 5]));
    expect(areas).toEqual([region, region, { left: 8, bottom: 9, right: 25, top: 22, page: 2 }]);
    // A link that meets the overhang alone is blocked; the boxes by themselves would not block it.
    const link = { left: 23, bottom: 15, right: 30, top: 18 };
    expect(meets(link, box)).toBe(false);
    expect(areas.some((area) => meets(link, area))).toBe(true);
    // The ink of a glyph that was not removed is not blocked.
    expect(areas.some((area) => area.left === 40)).toBe(false);
  });
});
