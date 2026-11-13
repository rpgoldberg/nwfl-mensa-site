// BOXLABEL: which label a box gets (the editor, 11-05): "Members Only", else "Mbrs Only", else none, for text
// members can see; "Private", else none, for text members cannot see either. Each fits by its own width.
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { LABELS, LABEL_EMS, MIN_LABEL_PT, isLabel, labelFor, labelSize } from './labels.js';
import type { Box, PageChar, Region } from './match.js';
import { boxKinds } from './redact.js';

const region = (width: number, height = 14, fontSize = 12): Region => ({ page: 0, left: 100, right: 100 + width, bottom: 600, top: 600 + height, fontSize });

describe('the labels', () => {
  it('are exactly the three strings, in title case, with no period after Mbrs', () => {
    expect(LABELS).toEqual(['Members Only', 'Mbrs Only', 'Private']);
    expect(isLabel('Members Only')).toBe(true);
    expect(isLabel('Mbrs Only')).toBe(true);
    expect(isLabel('Private')).toBe(true);
    for (const other of ['withheld', 'Mbrs. Only', 'members only', 'MEMBERS ONLY', 'Private ', 'Members  Only', '']) expect(isLabel(other), other).toBe(false);
  });

  it("measures each from Helvetica's real widths (pdf-lib's AFM metrics, glyph by glyph: a Tj draws no kerning)", async () => {
    const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    for (const label of LABELS) expect(LABEL_EMS[label]).toBeCloseTo([...label].reduce((sum, glyph) => sum + font.widthOfTextAtSize(glyph, 1), 0), 6);
    expect(LABEL_EMS['Members Only']).toBeCloseTo(6.501, 6);
    expect(LABEL_EMS['Mbrs Only']).toBeCloseTo(4.556, 6);
    expect(LABEL_EMS.Private).toBeCloseTo(3.112, 6);
  });
});

describe('labelSize: the readable-size rule, per string', () => {
  it('is 0.8 of the type size, smaller for the height or width, never below MIN_LABEL_PT or 0.6 of the type size', () => {
    expect(MIN_LABEL_PT).toBe(7);
    // Wide and tall enough: 0.8 x 12 = 9.6 pt.
    expect(labelSize(region(200), 'Members Only')).toBeCloseTo(9.6, 9);
    // Bound by its width: (width - 2) / ems, a point clear each side.
    const width = 2 + 8 * LABEL_EMS['Members Only'];
    expect(labelSize(region(width), 'Members Only')).toBeCloseTo(8, 9);
    // Below 0.6 x 12 = 7.2 pt there is none.
    expect(labelSize(region(2 + 7.1 * LABEL_EMS['Members Only']), 'Members Only')).toBeNull();
    // Bound by its height: 0.8 x 10 = 8 pt.
    expect(labelSize(region(200, 10), 'Private')).toBeCloseTo(8, 9);
    // 8 pt type: 0.8 x 8 = 6.4, under the 7 pt floor, however wide the box.
    expect(labelSize(region(400, 14, 8), 'Private')).toBeNull();
    // 9 pt type: 0.6 x 9 = 5.4, so the 7 pt floor rules a box bound by its width.
    expect(labelSize(region(2 + 6.99 * LABEL_EMS.Private, 14, 9), 'Private')).toBeNull();
    expect(labelSize(region(2 + 7.001 * LABEL_EMS.Private, 14, 9), 'Private')).toBeCloseTo(7.001, 9);
  });
});

describe('labelFor: per box', () => {
  const full = 2 + 9.6 * LABEL_EMS['Members Only'];
  const short = 2 + 9.6 * LABEL_EMS['Mbrs Only'];
  const priv = 2 + 9.6 * LABEL_EMS.Private;

  it('gives text members can see "Members Only" where it fits, else "Mbrs Only", else none', () => {
    expect(labelFor(region(full), 'members')).toEqual({ text: 'Members Only', size: expect.closeTo(9.6, 9) as unknown });
    // Too narrow for the long one at a readable size: the short one, at its own size.
    const narrower = 2 + 7 * LABEL_EMS['Members Only'];
    expect(labelSize(region(narrower), 'Members Only')).toBeNull();
    expect(labelFor(region(narrower), 'members')).toEqual({ text: 'Mbrs Only', size: expect.closeTo(9.6, 9) as unknown });
    expect(labelFor(region(short - 0.01), 'members')).toEqual({ text: 'Mbrs Only', size: expect.closeTo((short - 0.01 - 2) / LABEL_EMS['Mbrs Only'], 9) as unknown });
    // Too narrow for either.
    expect(labelFor(region(2 + 7.1 * LABEL_EMS['Mbrs Only']), 'members')).toBeNull();
    // Never "Private" for text members can see, however narrow.
    expect(labelFor(region(priv), 'members')).toBeNull();
  });

  it('gives text members cannot see either "Private" where it fits, else none: never a members label', () => {
    expect(labelFor(region(full), 'private')).toEqual({ text: 'Private', size: expect.closeTo(9.6, 9) as unknown });
    expect(labelFor(region(priv), 'private')).toEqual({ text: 'Private', size: expect.closeTo(9.6, 9) as unknown });
    expect(labelFor(region(2 + 7.1 * LABEL_EMS.Private), 'private')).toBeNull();
  });

  it('keeps every label it gives inside its box, a point clear each side', () => {
    for (let width = 10; width < 120; width += 0.5) {
      for (const kind of ['members', 'private'] as const) {
        const box = region(width);
        const label = labelFor(box, kind);
        if (label === null) continue;
        expect(label.size).toBeGreaterThanOrEqual(MIN_LABEL_PT);
        expect(LABEL_EMS[label.text] * label.size).toBeLessThanOrEqual(width - 2 + 1e-9);
      }
    }
  });
});

describe('boxKinds: which kind each box is (redact.ts), from the withheld glyphs whose centres it holds', () => {
  const glyph = (left: number, place: 'box' | 'ink' | 'none' = 'box'): PageChar => {
    const at: Box = { left, right: left + 6, bottom: 700, top: 712 };
    return { text: 'x', generated: false, hyphen: false, box: place === 'box' ? at : null, ink: place === 'ink' ? at : null, fontSize: 12 };
  };
  const box = (left: number, right: number): Box => ({ left, right, bottom: 698, top: 714 });

  it('is "members" when every withheld glyph in it is one members can see, else "private"', () => {
    const chars = [glyph(100), glyph(110), glyph(200), glyph(300), glyph(310)];
    const withheld = new Set([0, 1, 2, 3, 4]);
    // Box 1 holds glyphs 0 and 1 (members see both); box 2 glyph 2 (members withhold it); box 3 glyphs 3 and 4 (one each).
    expect(boxKinds(chars, [box(98, 118), box(198, 208), box(298, 318)], withheld, new Set([2, 4]))).toEqual(['members', 'private', 'private']);
  });

  it('is "private" for a box that holds no withheld glyph (only text removed with a passage), or only glyphs with no place', () => {
    const chars = [glyph(100), glyph(200, 'none'), glyph(300)];
    // Glyph 0 is not withheld; glyph 1 has neither a box nor ink; glyph 2 lies outside both boxes.
    expect(boxKinds(chars, [box(98, 108), box(198, 208)], new Set([1, 2]), new Set())).toEqual(['private', 'private']);
  });

  it('places a glyph PDFium gives no box by its ink', () => {
    expect(boxKinds([glyph(100, 'ink')], [box(98, 108)], new Set([0]), new Set())).toEqual(['members']);
  });
});
