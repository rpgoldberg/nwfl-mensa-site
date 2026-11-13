// REDACT-LOOK: exact-fit boxes (the editor, 11-02). Each box covers exactly the
// marked glyphs' extent, one line tall; the glyphs are still removed from the
// content, and the copy is checked by its rendered pixels: no pixel of marked
// (red) text is left, and every unmarked (blue) pixel that went missing lies
// inside a drawn box. Copy-paste and search (pdf.js, every inflated stream,
// PDFium's own reading) find nothing of a marked passage. Every name is made up.
// These PDFs are adversarial in shape: run this file only in the capped
// container (SPEC section 4).
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Box, PageChar, Region, TextObject } from '../../src/pdf/match.js';
import { matchedChars, regionsFor, stillThere, unread } from '../../src/pdf/match.js';
import { LABEL_EMS, labelSize } from '../../src/pdf/labels.js';
import { Document, Page, pdfium } from '../../src/pdf/pdfium.js';
import { type RedactResult, redactPdf } from '../../src/pdf/redact.js';
import { extractAll, leaked, rawText } from './extract.js';
import { BLUE, FIT_FIXTURES, type FitFixture, NESTED, NEWSLETTER_QUOTES, RED, REPEATS, askLine, fitPdf, lineRepros, newsletterPage, pictureNearFixture, possessiveShadow, scaledTypeFixture, shadowed, tightParagraph } from './fit-fixtures.js';
import { twoMarksFixture } from './fixtures.js';
import { black, blue, contrast, inAny, inside, lost, red, render, where } from './pixels.js';

async function pageChars(pdf: Uint8Array, index = 0): Promise<PageChar[]> {
  return (await pageText(pdf, index)).chars;
}

/** A page's reading and its text objects, as redact.ts takes them. */
async function pageText(pdf: Uint8Array, index = 0): Promise<{ chars: PageChar[]; objects: TextObject[] }> {
  const doc = Document.open(await pdfium(), pdf);
  if (doc === null) throw new Error('unopenable');
  try {
    doc.flatten(index);
    return doc.page(index, (page) => ({ chars: page.chars().chars, objects: page.textObjects() }));
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
    // BOXLABEL: "Quillon" is withheld from members too (the request names no flags), so "Private"; "Bo" is too narrow for any.
    expect((await extractAll(pdf)).match(/Private/g)).toHaveLength(1);
  });

  it('gives two passages on one line two boxes and keeps the unmarked word between them (challenger r2, F3)', async () => {
    const quotes = ['Bo Pellingham', 'Quillon Brask'];
    const apart = `BT /F1 14 Tf 20 60 Td ${BLUE} (Ask ) Tj ${RED} (Bo Pellingham) Tj ${BLUE} ( and ) Tj ${RED} (Quillon Brask) Tj ${BLUE} ( now.) Tj ET`;
    const together = 'BT /F1 14 Tf 20 60 Td (Ask Bo Pellingham and Quillon Brask now.) Tj ET';
    for (const content of [apart, together]) {
      const { pdf, boxes } = copyOf(await redactPdf(await fitPdf(content), { quotes, redactsAny: true }));
      // "Ask " is 27.23 pt, "Bo Pellingham" 90.258, " and " 31.136 and "Quillon Brask" 83.244, at 14 pt from 20.
      expect(boxes, content).toHaveLength(2);
      const [first, second] = boxes as [Region, Region];
      for (const [got, want] of [[first.left, 47.23], [first.right, 137.488], [second.left, 168.624], [second.right, 251.868]] as const) {
        // PDFium sums the advances in single precision: within 0.02 pt of the AFM widths' sum.
        expect(Math.abs(got - want), `${content}: ${got} ${want}`).toBeLessThan(0.02);
      }
      expect((await extractAll(pdf)).split('\n')[0], content).toMatch(/^Ask\s+and\s+now\./);
    }
  });

  it('labels type set at 1 pt and scaled to 12 pt by its matrix as 12 pt type', async () => {
    const { pdf, boxes } = copyOf(await redactPdf(await scaledTypeFixture(), { quotes: ['Quillon Brask'], redactsAny: true }));
    expect(boxes.map((box) => box.fontSize)).toEqual([12]);
    expect((await extractAll(pdf)).match(/Private/g)).toHaveLength(1);
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
      // (iv) Each box is exactly the extent of the glyphs removed under it: not widened, not run on. A text
      // object PDFium does not read (text drawn twice) that a box reached is removed whole, and boxed whole.
      const { chars, objects } = await pageText(original);
      const there = stillThere(chars, await pageChars(pdf));
      // Spaces have no ink and are never boxed (match.ts exactRegions). A glyph of another line removed with a
      // passage is boxed at its advance by its ink's height (fix round 4, F3): its box holds its ink, not its line.
      const removed = chars.filter((c, i) => !there.has(i) && !c.generated && c.text.trim() !== '' && (c.box ?? c.ink) !== null);
      const unreadObjects = unread(chars, objects).objects;
      // Loose boxes of adjacent lines can overlap a little: a box's glyphs are the ones it contains.
      const contains = (box: Box, b: Box): boolean => b.left >= box.left - 0.01 && b.right <= box.right + 0.01 && b.bottom >= box.bottom - 0.01 && b.top <= box.top + 0.01;
      const holds = (box: Box, c: PageChar): boolean => {
        const loose = (c.box ?? c.ink) as Box;
        return contains(box, loose) || (c.ink !== null && contains(box, { ...loose, bottom: c.ink.bottom, top: c.ink.top }));
      };
      for (const box of boxes) {
        const under = [...removed.filter((c) => holds(box, c)).map((c) => (c.box ?? c.ink) as Box), ...unreadObjects.filter((b) => contains(box, b))];
        expect(under.length, JSON.stringify(box)).toBeGreaterThan(0);
        expect(near(box.left, Math.min(...under.map((b) => b.left))), JSON.stringify(box)).toBe(true);
        expect(near(box.right, Math.max(...under.map((b) => b.right))), JSON.stringify(box)).toBe(true);
      }
      for (const c of removed) expect(boxes.some((box) => holds(box, c)), JSON.stringify(c.box)).toBe(true);
      // (v) The same bytes every time.
      const again = copyOf(await redactPdf(original, request));
      expect(Buffer.from(again.pdf).equals(Buffer.from(pdf))).toBe(true);
    });
  }
});

describe('a glyph of another line PDFium removes with a passage (challenger r4, F3)', () => {
  // A Tj per line, or per word (challenger r5: PDFium keeps a word object's bounds over its removed last glyph).
  it.each(['line', 'word'] as const)('boxes the passage once on its line and each descender of the line above on its own, and takes nothing else of that line (a Tj per %s)', async (per) => {
    const original = await tightParagraph(per);
    const { pdf, boxes } = copyOf(await redactPdf(original, { quotes: ['Quillon Brask'], redactsAny: true }));
    const chars = await pageChars(original);
    const held = [...matchedChars(chars, ['Quillon Brask'])].map((i) => (chars[i] as PageChar).box as Box);
    const band = { bottom: Math.min(...held.map((b) => b.bottom)), top: Math.max(...held.map((b) => b.top)) };
    // On the passage's line: at least half of a box's height is in its band.
    const onLine = (b: Box): boolean => Math.min(b.top, band.top) - Math.max(b.bottom, band.bottom) >= (b.top - b.bottom) / 2;
    const passage = boxes.filter(onLine);
    expect(passage).toHaveLength(1);
    const there = stillThere(chars, await pageChars(pdf));
    const glyph = (c: PageChar): boolean => !c.generated && c.text.trim() !== '' && c.box !== null;
    // Off the passage's line, what went is exactly the glyphs whose ink reaches into its box, which PDFium must take.
    const gone = chars.flatMap((c, i) => (glyph(c) && !onLine(c.box as Box) && !there.has(i) ? [i] : []));
    const reached = chars.flatMap((c, i) => (glyph(c) && !onLine(c.box as Box) && c.ink !== null && overlaps(c.ink, passage[0] as Box) ? [i] : []));
    expect(reached.length).toBeGreaterThan(0);
    expect(gone).toEqual(reached);
    // Each of them is boxed alone, at its own glyph's box.
    const others = boxes.filter((b) => !onLine(b));
    expect(others.map((b) => [b.left, b.right].map((v) => v.toFixed(2)))).toEqual(reached.map((i) => [((chars[i] as PageChar).box as Box).left, ((chars[i] as PageChar).box as Box).right].map((v) => v.toFixed(2))));
    expect(where(await render(pdf), red)).toEqual([]);
  });
});

describe('a possessive copy of a withheld word (challenger r4, F2)', () => {
  for (const order of ['after', 'before'] as const) {
    it(`leaves no glyph of the far copy's "Marsh's" (52, 0), ${order} the line: refused, or only the line's own unmarked 's is red`, async () => {
      const original = await fitPdf(possessiveShadow('Ada Marsh', 52, 0, order), { width: 420 });
      const result = await redactPdf(original, { quotes: ['Ada Marsh'], redactsAny: true });
      // With the copy withheld, the box runs on over " car.", whose space PDFium did not read: fail closed.
      if (result.kind === 'refused') {
        expect(result.reason).toBe('page 1: text PDFium reads only in part meets a withheld passage');
        return;
      }
      const { pdf } = copyOf(result);
      // The line's "'s" is drawn red with the name and is not in the quote: its pixels are the only red left.
      const chars = await pageChars(original);
      // The line's "Marsh" ends at 114.0; the copy's "Marsh's" begins at 128.8.
      const own = chars.filter((c) => (c.text === "'" || c.text === 's') && c.box !== null && c.box.left > 113 && c.box.right < 128).map((c) => c.box as Box);
      expect(own).toHaveLength(2);
      expect(where(await render(pdf), red).filter((p) => !inAny(p, own))).toEqual([]);
      const seen = { extracted: await extractAll(pdf), raw: rawText(pdf) };
      expect(['Ada Marsh', 'Marsh'].filter((needle) => leaked(needle, seen.extracted, seen.raw))).toEqual([]);
    });
  }

  for (const [dx, order] of [[36, 'after'], [-36, 'before']] as const) {
    it(`gives a copy with no red left when "Quillon Brask's" is drawn again at (${dx}, 0) ${order} the line: its "Brask's" is withheld`, async () => {
      const original = await fitPdf(possessiveShadow('Quillon Brask', dx, 0, order), { width: 420 });
      const { pdf } = copyOf(await redactPdf(original, { quotes: ['Quillon Brask'], redactsAny: true }));
      expect(where(await render(pdf), red)).toEqual([]);
      const seen = { extracted: await extractAll(pdf), raw: rawText(pdf) };
      expect(['Quillon Brask', 'Quillon', 'Brask'].filter((needle) => leaked(needle, seen.extracted, seen.raw))).toEqual([]);
    });
  }
});

describe('withheld text drawn again elsewhere on the page (challenger r4, F1)', () => {
  // A masthead with the editor's name, the name in an article, and another article below.
  const issue = (article: string): Promise<Uint8Array> =>
    fitPdf([`BT /F1 16 Tf 20 115 Td ${BLUE} (The Picnic Post, edited by ) Tj ${RED} (Quillon Brask) Tj ET`, askLine('(Quillon Brask) Tj', { y: 80 }), `BT /F1 12 Tf 20 40 Td ${BLUE} (${article}) Tj ET`].join('\n'), { width: 420 });

  it('gives a copy when every drawing of a withheld name is marked: the masthead and an article', async () => {
    const { pdf, boxes } = copyOf(await redactPdf(await issue('The raffle is at noon.'), { quotes: ['Quillon Brask'], redactsAny: true }));
    expect(boxes).toHaveLength(2);
    expect(where(await render(pdf), red)).toEqual([]);
  });

  it('gives a copy that shows a word of the name recurring on its own in another article, as a possessive too (challenger r5, S1)', async () => {
    // Below the name, beyond an em of it: the name is withheld, not its words.
    for (const article of ['Brask won the raffle.', "The raffle prize is Brask's.", 'Ask QUILLON about the raffle.']) {
      const { pdf } = copyOf(await redactPdf(await issue(article), { quotes: ['Quillon Brask'], redactsAny: true }));
      expect(where(await render(pdf), red), article).toEqual([]);
      expect((await pageChars(pdf)).map((c) => c.text).join(''), article).toContain(article);
    }
  });

  it('refuses the page when a word of the name is drawn again a glyph at a time just below it, where no box reaches', async () => {
    // "Brask" a glyph per text object, 14 pt under the name's "Brask" (a copy the boxes do not tie to it).
    let x = 20 + 27.23 + 47.46;
    const glyphs = [...'Brask'].map((ch) => {
      const g = `BT /F1 14 Tf ${x.toFixed(3)} 66 Td ${RED} (${ch}) Tj ET`;
      x += { B: 9.338, r: 4.662, a: 7.784, s: 7, k: 7 }[ch] as number;
      return g;
    });
    const page = fitPdf([askLine('(Quillon Brask) Tj', { y: 80 }), ...glyphs].join('\n'), { width: 420 });
    expect(await redactPdf(await page, { quotes: ['Quillon Brask'], redactsAny: true })).toEqual({ kind: 'refused', reason: 'page 1: withheld text is drawn again elsewhere on the page' });
  });

  it('gives a copy when only a short word or a number under 4 digits of a passage recurs', async () => {
    const page = fitPdf([askLine('(Bo Pell) Tj (, 850-555-0142) Tj', { y: 80 }), `BT /F1 12 Tf 20 40 Td ${BLUE} (Bo said 555 came.) Tj ET`].join('\n'), { width: 420 });
    copyOf(await redactPdf(await page, { quotes: ['Bo Pell', '850-555-0142'], redactsAny: true }));
    const again = fitPdf([askLine('(850-555-0142) Tj', { y: 80 }), `BT /F1 12 Tf 20 40 Td ${BLUE} (Room 0142.) Tj ET`].join('\n'), { width: 420 });
    expect(await redactPdf(await again, { quotes: ['850-555-0142'], redactsAny: true })).toEqual({ kind: 'refused', reason: 'page 1: withheld text is drawn again elsewhere on the page' });
  });
});

describe('a newsletter page as Word draws one (challenger r5, S1)', () => {
  /** The copy, checked: nothing of the quotes readable, no red pixel left, and no blue one lost outside a box. */
  const checked = async (original: Uint8Array, quotes: string[]): Promise<{ pdf: Uint8Array; boxes: Region[] }> => {
    const copy = copyOf(await redactPdf(original, { quotes, redactsAny: true }));
    const after = await render(copy.pdf);
    expect(where(after, red)).toEqual([]);
    expect(lost(await render(original), after, blue).filter((p) => !inAny(p, copy.boxes))).toEqual([]);
    const seen = { extracted: await extractAll(copy.pdf), raw: rawText(copy.pdf), pdfium: (await pageChars(copy.pdf)).map((c) => c.text).join('') };
    expect(quotes.filter((quote) => leaked(quote, seen.extracted, seen.raw) || leaked(quote, seen.pdfium, ''))).toEqual([]);
    return copy;
  };

  for (const font of ['F1', 'F4'] as const) {
    for (const red of [false, true]) {
      for (const { name, content, quotes } of lineRepros(font, red)) {
        it(`gives a copy of ${name} (${font}, ${red ? 'the passage a red run' : 'all blue, as Word draws it'})`, async () => {
          expect((await checked(await fitPdf(content), quotes)).boxes).toHaveLength(1);
        });
      }
    }
  }

  for (const { name, content, quotes, shown } of REPEATS) {
    it(`gives a copy that shows ${name}, a word of the passage recurring on its own`, async () => {
      const { pdf } = await checked(await fitPdf(content), quotes);
      expect((await pageChars(pdf)).map((c) => c.text).join('')).toContain(shown);
    });
  }

  it.each(Object.entries(NEWSLETTER_QUOTES))('gives a copy of a plain newsletter page with %s withheld', async (_, quotes) => {
    await checked(await newsletterPage(), quotes);
  });
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

  describe('the ink guard, with a glyph whose ink reaches past its loose box (defensive: no real file tried does this)', () => {
    afterEach(() => vi.restoreAllMocks());
    const read = Object.getOwnPropertyDescriptor(Page.prototype, 'chars')?.value as (this: Page) => ReturnType<Page['chars']>;

    it('refuses when the marked a\'s ink, not its box, reaches the picture beside "Åsa"', async () => {
      // The picture starts at 89; the a's loose box ends at 86.02. Only the first reading is changed.
      let first = true;
      vi.spyOn(Page.prototype, 'chars').mockImplementation(function (this: Page) {
        const got = read.call(this);
        if (!first) return got;
        first = false;
        const a = got.chars.findLastIndex((c) => c.text === 'a');
        const ink = got.chars[a]?.ink as Box;
        return { ...got, chars: got.chars.map((c, i) => (i === a ? { ...c, ink: { ...ink, right: 90 } } : c)) };
      });
      expect(await redactPdf(await pictureNearFixture('beside'), { quotes: ['Åsa'], redactsAny: true })).toEqual({
        kind: 'refused',
        reason: 'page 1: a withheld passage lies over a picture',
      });
    });
  });
});

describe('text drawn as a clip (Tr 4 to 7, challenger F5)', () => {
  // PDFium's rewrite of the page wraps each text object in q ... Q, so a text clip ends with its text
  // object, and the fill it clipped floods the page (a probe: an untouched clip's 3,773 blue pixels
  // became 320,000 once the page was rewritten). So a page with one is refused whenever it is rewritten.
  const refused = { kind: 'refused', reason: 'page 1 has text drawn as a clip, which removal would lose' };
  const clipped = (tr: number): string =>
    `BT /F1 24 Tf 20 60 Td ${BLUE} (Ask ) Tj ET q BT /F1 24 Tf ${20 + 1.945 * 24} 60 Td ${tr} Tr ${RED} (Quillon Brask) Tj ET ${RED} 0 0 400 140 re f Q BT /F1 24 Tf 250 20 Td ${BLUE} (now.) Tj ET`;
  const apart = `q BT /F1 24 Tf 20 100 Td 7 Tr (Ask) Tj ET ${BLUE} 0 0 400 140 re f Q`;

  for (const tr of [4, 5, 6, 7]) {
    it(`refuses the marked words drawn as a clip for a fill (Tr ${tr})`, async () => {
      expect(await redactPdf(await fitPdf(clipped(tr)), { quotes: ['Quillon Brask'], redactsAny: true })).toEqual(refused);
    });
  }

  it('refuses a clip the passage never reaches, on the page or in a form XObject, since the rewrite loses it too', async () => {
    const marked = askLine('(Quillon Brask) Tj', { y: 40 });
    expect(await redactPdf(await fitPdf(`${apart} ${marked}`), { quotes: ['Quillon Brask'], redactsAny: true })).toEqual(refused);
    expect(await redactPdf(await fitPdf(`q /Fm1 Do Q ${marked}`, { form: apart }), { quotes: ['Quillon Brask'], redactsAny: true })).toEqual(refused);
  });

  it('keeps a clip on a page with nothing withheld, which is not rewritten, and redacts invisible text (Tr 3)', async () => {
    const { pdf } = copyOf(await redactPdf(await fitPdf(apart), { quotes: ['Quillon Brask'], redactsAny: true }));
    const above = (raster: Awaited<ReturnType<typeof render>>): number => where(raster, blue).filter((p) => p.y > 90).length;
    expect(above(await render(pdf))).toBe(above(await render(await fitPdf(apart))));
    expect((await redactPdf(await fitPdf(askLine('3 Tr (Quillon Brask) Tj 0 Tr')), { quotes: ['Quillon Brask'], redactsAny: true })).kind).toBe('redacted');
  });
});

describe('text PDFium does not read, by a passage (challenger r2, F2)', () => {
  afterEach(() => vi.restoreAllMocks());
  const remove = Object.getOwnPropertyDescriptor(Page.prototype, 'removeText')?.value as (this: Page, regions: readonly Region[]) => boolean;
  const fa = (): Promise<Uint8Array> => (FIT_FIXTURES.find((f) => f.name.startsWith('"Quillon Brask" drawn twice (6.3, 4)')) as FitFixture).pdf();

  it('removes and boxes the whole of a shadow PDFium never reads, so no decoy can hide what a removal leaves of it (F-A)', async () => {
    const original = await fa();
    const { chars, objects } = await pageText(original);
    const shadow = unread(chars, objects).objects;
    // The shadow, 6.3 pt right and 4 pt up of the name: in no reading.
    expect(shadow.map((b) => Number(b.right.toFixed(2)))).toEqual([136.79]);
    const { pdf, boxes } = copyOf(await redactPdf(original, { quotes: ['Quillon Brask'], redactsAny: true }));
    expect(boxes).toHaveLength(1);
    const box = boxes[0] as Region;
    // The shadow's k lies over the n of " now.", which goes with it, and the rest of its word with the n (fix round
    // 3, F1): the box ends with the full stop (160.04 + 3.892).
    expect([box.left, box.right].map((v) => Number(v.toFixed(2)))).toEqual([47.23, 163.93]);
    expect(box.top).toBeGreaterThanOrEqual((shadow[0] as Box).top);
    expect((await extractAll(pdf)).split('\n')[0]).toMatch(/^Ask\s+Private$/);
    expect(where(await render(pdf), red)).toEqual([]);
  });

  it('refuses a page where a text object PDFium reads only in part meets a passage: what it left out is unknown', async () => {
    // An invisible "Ask Bo Smith" laid over a visible "Ask Bo": PDFium reads its "Ask Bo" once, as the visible
    // one's, and reads " Smith" of it.
    const content = 'BT /F1 14 Tf 20 60 Td (Ask Bo) Tj ET BT /F1 14 Tf 3 Tr 20 60 Td (Ask Bo Smith) Tj 0 Tr ET';
    const { chars, objects } = await pageText(await fitPdf(content));
    expect(unread(chars, objects).parts.length).toBeGreaterThan(0);
    expect(await redactPdf(await fitPdf(content), { quotes: ['Bo'], redactsAny: true })).toEqual({
      kind: 'refused',
      reason: 'page 1: text PDFium reads only in part meets a withheld passage',
    });
    // Apart from the passage, on another line, the same object is no reason to refuse.
    const apart = `${content}\n${askLine('(Quillon Brask) Tj', { y: 20 })}`;
    expect((await redactPdf(await fitPdf(apart), { quotes: ['Quillon Brask'], redactsAny: true })).kind).toBe('redacted');
  });

  it('refuses when a removal leaves text PDFium does not read at a passage (the second guard: the count is taken again after it)', async () => {
    // A removal that stops at the name's own right edge (20 + 27.23 + 83.258), as an exact one did before the
    // count: it misses the shadow's last glyph, and the decoy hides that from the reading after it.
    vi.spyOn(Page.prototype, 'removeText').mockImplementation(function (this: Page, regions: readonly Region[]) {
      return remove.call(this, regions.map((region) => ({ ...region, right: Math.min(region.right, 130.49) })));
    });
    expect(await redactPdf(await fa(), { quotes: ['Quillon Brask'], redactsAny: true })).toEqual({
      kind: 'refused',
      reason: 'page 1: text PDFium does not read is left at a withheld passage',
    });
  });

  it('refuses when the count misses a copy and removal uncovers it (the reading after removal, kept as a guard)', async () => {
    // F-A's shadow with no decoy, and the count blinded: the shadow is in none, so only the name's own extent
    // is removed, and what is left of the shadow is read once the name is gone.
    vi.spyOn(Page.prototype, 'textObjects').mockReturnValue([]);
    const original = await fitPdf(`${askLine('(Quillon Brask) Tj')}\nBT /F1 14 Tf 53.53 64 Td ${RED} (Quillon Brask) Tj ET`);
    expect(await redactPdf(original, { quotes: ['Quillon Brask'], redactsAny: true })).toEqual({
      kind: 'refused',
      reason: 'page 1: text drawn twice is left after removal',
    });
  });

  it('boxes a shadow PDFium never reads up to its own top with no decoy, on the page and in a form drawn moved (challenger r3, N2)', async () => {
    const content = shadowed('Quillon Brask', 6.3, 4);
    for (const original of [await fitPdf(content), await fitPdf('q 1 0 0 1 0 -20 cm /Fm1 Do Q', { form: content })]) {
      const { chars, objects } = await pageText(original);
      const shadow = unread(chars, objects).objects;
      expect(shadow).toHaveLength(1);
      // 4 pt up, the shadow's ink reaches above every loose box the reading has: only its own bounds box it.
      const top = (shadow[0] as Box).top;
      expect(top).toBeGreaterThan(Math.max(...chars.flatMap((c) => (c.box === null ? [] : [c.box.top]))));
      const { pdf, boxes } = copyOf(await redactPdf(original, { quotes: ['Quillon Brask'], redactsAny: true }));
      expect(boxes).toHaveLength(1);
      expect((boxes[0] as Region).top).toBeGreaterThanOrEqual(top);
      expect(where(await render(pdf), red)).toEqual([]);
    }
  });

  it('places text two forms deep on the page by the inner form\'s matrix, then the outer\'s, which do not commute (challenger r3, N1)', async () => {
    type M = [number, number, number, number, number, number];
    const times = ([a, b, c, d, e, f]: M, [A, B, C, D, E, F]: M): M => [a * A + b * C, a * B + b * D, c * A + d * C, c * B + d * D, e * A + f * C + E, e * B + f * D + F];
    const carried = (box: Box, [a, b, c, d, e, f]: M): Box => {
      const xs = [box.left, box.right].flatMap((x) => [box.bottom, box.top].map((y) => a * x + c * y + e));
      const ys = [box.left, box.right].flatMap((x) => [box.bottom, box.top].map((y) => b * x + d * y + f));
      return { left: Math.min(...xs), right: Math.max(...xs), bottom: Math.min(...ys), top: Math.max(...ys) };
    };
    const matrix = (ops: string): M => (ops.match(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) cm/) as RegExpMatchArray).slice(1, 7).map(Number) as M;
    const flat = await pageText(await fitPdf(shadowed('Quillon Brask', 6.3, 4)));
    const alone = unread(flat.chars, flat.objects).objects;
    expect(alone).toHaveLength(1);
    for (const [order, page, form] of NESTED) {
      const { chars, objects } = await pageText(await (FIT_FIXTURES.find((f) => f.name === `F-A with no decoy two forms deep, ${order}`) as FitFixture).pdf());
      const got = unread(chars, objects).objects;
      const want = carried(alone[0] as Box, times(matrix(form), matrix(page)));
      expect(got, order).toHaveLength(1);
      for (const side of ['left', 'right', 'bottom', 'top'] as const) expect(Math.abs((got[0] as Box)[side] - want[side]), `${order} ${side}`).toBeLessThan(0.01);
      // The other way round is somewhere else: the order is pinned.
      const swapped = carried(alone[0] as Box, times(matrix(page), matrix(form)));
      expect(Math.abs((got[0] as Box).left - swapped.left) + Math.abs((got[0] as Box).top - swapped.top), order).toBeGreaterThan(1);
    }
  });

  it('counts text objects in a form XObject, in page space', async () => {
    const original = await (FIT_FIXTURES.find((f) => f.name === 'F-A in a form XObject drawn moved') as FitFixture).pdf();
    const { chars, objects } = await pageText(original);
    // The form is drawn 20 pt down: the shadow's bounds are too.
    expect(unread(chars, objects).objects.map((b) => [Number(b.right.toFixed(2)), Number(b.top.toFixed(2))])).toEqual([[136.79, 54.32]]);
    expect(objects.length).toBeGreaterThanOrEqual(5);
  });
});

describe('a withheld glyph that survives removal (L3)', () => {
  afterEach(() => vi.restoreAllMocks());
  // The real removal, taken before any spy replaces it.
  const remove = Object.getOwnPropertyDescriptor(Page.prototype, 'removeText')?.value as (this: Page, regions: readonly Region[]) => boolean;

  // A glyph PDFium reads survives only if a quad misses its tight box, and PDFium's loose box held the
  // tight box in every shape tried (Type 3 glyphs with d1 boxes that lie, sit off their advance or are
  // empty). Text drawn twice can leave a glyph PDFium never read: a different check, tested with real
  // files under L2 above (challenger F1, F2). These stand in for a removal that misses: the quads are
  // trimmed so the passage's last glyph is left.
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

  it('is refused when a space of the passage is still read after removal (fail closed: no glyph of a passage is exempt)', async () => {
    // The real removal, then the space read back at its place, as if PDFium had kept it in its reading.
    const read = Object.getOwnPropertyDescriptor(Page.prototype, 'chars')?.value as (this: Page) => ReturnType<Page['chars']>;
    let space: PageChar | undefined;
    let calls = 0;
    vi.spyOn(Page.prototype, 'chars').mockImplementation(function (this: Page) {
      const got = read.call(this);
      calls += 1;
      if (calls === 1) space = got.chars.find((c, i) => c.text === ' ' && got.chars[i - 1]?.text === 'n' && got.chars[i + 1]?.text === 'B');
      return calls === 2 && space !== undefined ? { ...got, chars: [...got.chars, space] } : got;
    });
    expect(await redactPdf(await fitPdf(askLine('(Quillon Brask) Tj')), { quotes: ['Quillon Brask'], redactsAny: true })).toEqual({
      kind: 'refused',
      reason: 'page 1: a withheld glyph survived removal',
    });
    expect(space).toBeDefined();
  });

  it('is never refused for a space in the layouts producers write: PDFium reads no space of a removed passage again', async () => {
    const layouts = [
      'BT /F1 14 Tf 20 60 Td (Ask Quillon Brask now.) Tj ET',
      'BT /F1 14 Tf 20 60 Td (Ask) Tj ( ) Tj (Quillon) Tj ( ) Tj (Brask) Tj ( ) Tj (now.) Tj ET',
      'BT /F1 14 Tf 20 60 Td [(Ask) -278 (Quillon) -278 (Brask) -278 (now.)] TJ ET',
      'BT /F1 14 Tf 20 60 Td 6 Tw (Ask Quillon Brask now.) Tj ET',
      'BT /F1 14 Tf 20 60 Td 2 Tc (Ask Quillon Brask now.) Tj ET',
    ];
    for (const layout of layouts) {
      const doc = Document.open(await pdfium(), await fitPdf(layout));
      if (doc === null) throw new Error('unopenable');
      try {
        const left = doc.page(0, (page) => {
          const before = page.chars().chars;
          const withheld = matchedChars(before, ['Quillon Brask']);
          const found = regionsFor(before, withheld);
          if (!found.ok) throw new Error(found.reason);
          page.removeText(found.regions);
          const there = stillThere(before, page.chars().chars);
          // The passage's own space is withheld with its words, and is not read again.
          expect(withheld.has(before.findIndex((c, i) => c.text === ' ' && before[i - 1]?.text === 'n' && before[i + 1]?.text === 'B')), layout).toBe(true);
          return [...withheld].filter((i) => there.has(i));
        });
        expect(left, layout).toEqual([]);
      } finally {
        doc.close();
      }
      expect((await redactPdf(await fitPdf(layout), { quotes: ['Quillon Brask'], redactsAny: true })).kind, layout).toBe('redacted');
    }
  });
});

describe('labels (L12)', () => {
  it('draws its label ("Private" when members withhold it too, BOXLABEL) in white on the black box, wholly inside it, at a readable contrast, where it fits', async () => {
    const { pdf, boxes } = copyOf(await redactPdf(await twoMarksFixture(), { quotes: ['Quillon'], redactsAny: true }));
    const box = boxes[0] as Region;
    const size = labelSize(box, 'Private') as number;
    expect(size).toBeCloseTo(9.6, 6);
    // The label's own glyphs, read back by PDFium, lie inside the box.
    const label = (await pageChars(pdf)).filter((c) => c.ink !== null && overlaps(c.ink, box));
    expect(label.map((c) => c.text).join('')).toBe('Private');
    for (const c of label) {
      const ink = c.ink as Box;
      expect(ink.left >= box.left && ink.right <= box.right && ink.bottom >= box.bottom && ink.top <= box.top, JSON.stringify(ink)).toBe(true);
    }
    expect(LABEL_EMS.Private * size).toBeLessThanOrEqual(box.right - box.left - 2);
    const pixels = inside(await render(pdf), box);
    expect(contrast(pixels)).toBeGreaterThanOrEqual(15);
    expect(pixels.some(([r, g, b]) => r === 255 && g === 255 && b === 255)).toBe(true);
  });

  it('keeps a label bound by the box\'s height wholly inside it (a box under 1 em tall)', async () => {
    // 18 pt tall for 20 pt type: the label is 0.8 x 18 = 14.4 pt, under the 16 pt of the type size.
    const region: Region = { page: 0, left: 50, right: 250, bottom: 50, top: 68, fontSize: 20 };
    expect(labelSize(region, 'Members Only')).toBeCloseTo(14.4, 6);
    const doc = Document.open(await pdfium(), await fitPdf(''));
    if (doc === null) throw new Error('unopenable');
    let pdf: Uint8Array;
    try {
      doc.page(0, (page) => page.drawBoxes([region], ['members']));
      pdf = doc.save();
    } finally {
      doc.close();
    }
    const label = (await pageChars(pdf)).filter((c) => c.ink !== null);
    expect(label.map((c) => c.text).join('')).toBe('Members Only');
    for (const c of label) {
      const ink = c.ink as Box;
      expect(ink.left >= region.left && ink.right <= region.right && ink.bottom >= region.bottom && ink.top <= region.top, JSON.stringify(ink)).toBe(true);
    }
  });

  it('leaves a box too narrow for a readable label without one, all black', async () => {
    const { pdf, boxes } = copyOf(await redactPdf(await twoMarksFixture(), { quotes: ['Bo'], redactsAny: true }));
    expect(labelSize(boxes[0] as Region, 'Private')).toBeNull();
    expect(await extractAll(pdf)).not.toContain('Private');
    const pixels = inside(await render(pdf), boxes[0] as Region);
    expect(pixels.length).toBeGreaterThan(0);
    expect(pixels.every(([r, g, b]) => black(r, g, b))).toBe(true);
  });

  it('gives a copy of a passage that is the old label, "withheld" (challenger F8 refused it while it was the label; BOXLABEL)', async () => {
    const { pdf, boxes } = copyOf(await redactPdf(await fitPdf(askLine('(withheld) Tj')), { quotes: ['withheld'], redactsAny: true }));
    expect(boxes).toHaveLength(1);
    expect(await extractAll(pdf)).not.toContain('withheld');
    expect((await redactPdf(await fitPdf(askLine('(Anna Held) Tj')), { quotes: ['Anna Held'], redactsAny: true })).kind).toBe('redacted');
  });

  it('adds no text but the label: the copy reads as the original with each passage replaced', async () => {
    const { pdf } = copyOf(await redactPdf(await twoMarksFixture(), { quotes: ['Bo', 'Quillon'], redactsAny: true }));
    const words = ((await extractAll(pdf)).split('\n')[0] as string).split(/\s+/).filter((w) => /^[A-Za-z]+$/.test(w));
    expect(words.filter((w) => !['Phone', 'now', 'about', 'the', 'picnic', 'and', 'rest'].includes(w))).toEqual(['Private']);
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
