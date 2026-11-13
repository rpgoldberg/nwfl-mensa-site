// LINKS-LINEEND: on a page with a redaction, the engine blocked every line's end. PDFium generates a "\r\n" at
// each line end (FPDFText_IsGenerated); it has no loose box, so stillThere never reads it as still there, and its
// ink is a point at the line's end on the baseline. Counted as removed, each such point was withheld ink, and a
// link that touched any line's end was dropped. Only a glyph the removal took counts as withheld ink now; a link
// over a removed glyph, a box, or text the copy lacks is still dropped, and the gate still proves the text under
// every kept link. Synthetic PDFs only; every person is made up.
import { describe, expect, it } from 'vitest';
import { gateVerdict } from '../../src/pdf/gate-rules.js';
import { type EngineLink, meets } from '../../src/pdf/link-annots.js';
import { type Box, type PageChar, matchedChars, stillThere } from '../../src/pdf/match.js';
import { Document, pdfium } from '../../src/pdf/pdfium.js';
import { redactPdf, withheldAreas } from '../../src/pdf/redact.js';
import { linesPdf } from './fixtures.js';

const ORIGIN = 'https://nwflorida.us';
const QUOTES = ['Wrenhallow'];
// Line 1 holds the passage, with text after it; lines 2 to 4 are ordinary. Helvetica 12 at x 72, baselines 720 to 660.
const LINES = ['Write to Tobias Wrenhallow at the lodge.', 'Read about the puzzle hunt at site.example', 'Bring a pencil and a friend.', 'Doors open at seven.'];
// 26 lower-case base32 characters, a distinct one for each number.
const id = (n: number): string => {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let out = '';
  for (let rest = n; out.length < 26; rest = Math.floor(rest / 32)) out = (alphabet[rest % 32] as string) + out;
  return out;
};
const link = (n: number, rect: EngineLink['rect']): EngineLink => ({ id: id(n), page: 1, rect, label: 'Link to site.example' });
const box = (rect: EngineLink['rect']): Box => ({ left: rect[0], bottom: rect[1], right: rect[2], top: rect[3] });

const charsOf = async (pdf: Uint8Array): Promise<PageChar[]> => {
  const doc = Document.open(await pdfium(), pdf);
  if (doc === null) throw new Error('unopenable');
  try {
    return doc.page(0, (page) => page.chars().chars);
  } finally {
    doc.close();
  }
};

/** Each line's end as PDFium reads it: the generated "\r"'s ink, a point at the last glyph's right on the baseline. */
const lineEnds = (chars: readonly PageChar[]): { x: number; y: number }[] =>
  chars.flatMap((c) => (c.generated && c.text === '\r' && c.ink !== null ? [{ x: c.ink.right, y: c.ink.bottom }] : []));

const copyOf = async (original: Uint8Array, links: readonly EngineLink[]) => {
  const result = await redactPdf(original, { quotes: QUOTES, redactsAny: true, origin: ORIGIN, links });
  if (result.kind !== 'redacted') throw new Error(`expected a copy, got ${JSON.stringify(result)}`);
  return result;
};

describe('withheldAreas: only glyphs the removal took are withheld ink (LINKS-LINEEND)', () => {
  const at = (text: string, generated: boolean, ink: Box): PageChar => ({ text, generated, hyphen: false, box: generated ? null : ink, ink, fontSize: 12 });

  it('skips a generated line end or space, and still blocks a removed glyph and a removed space beside the passage', () => {
    const glyph = at('W', false, { left: 128, bottom: 654, right: 140, top: 662 });
    const space = at(' ', false, { left: 221.4, bottom: 654, right: 224.7, top: 654 });
    const lineEnd = [at('\r', true, { left: 306.8, bottom: 632, right: 306.8, top: 632 }), at('\n', true, { left: 306.8, bottom: 632, right: 306.8, top: 632 })];
    const inserted = at(' ', true, { left: 250, bottom: 610, right: 250, top: 610 });
    const areas = withheldAreas(0, [], [], [glyph, space, ...lineEnd, inserted], new Set([0, 1, 2, 3, 4]));
    expect(areas).toEqual([
      { ...glyph.ink, page: 0 },
      { ...space.ink, page: 0 },
    ]);
  });
});

describe('the engine keeps a link at a line end on a page with a redaction (LINKS-LINEEND)', () => {
  it('keeps the reproducer\'s rects at line ends, drops the ones over the passage, and the gate passes the copy', async () => {
    const original = await linesPdf(LINES);
    const chars = await charsOf(original);
    const ends = lineEnds(chars);
    // The fixture has the shape the rehearsal found: a generated, box-less line end with point ink on each line.
    expect(ends.map((end) => Math.round(end.y))).toEqual([720, 700, 680]);
    expect(chars.filter((c) => c.generated && c.text === '\r').every((c) => c.box === null && c.ink !== null && c.ink.left === c.ink.right && c.ink.bottom === c.ink.top)).toBe(true);
    const [end1, end2, end3] = ends as [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
    const passage = [...matchedChars(chars, QUOTES)].map((i) => (chars[i] as PageChar).ink as Box);
    const passageLeft = Math.min(...passage.map((ink) => ink.left));
    const passageRight = Math.max(...passage.map((ink) => ink.right));
    const links = [
      link(1, [72, 697, end2.x, 711]), // the whole of line 2, ending at its end
      link(2, [end2.x - 0.3, 699, end2.x + 0.2, 704]), // touching line 2's end
      link(3, [end3.x - 7, 679, end3.x, 684]), // line 3's last glyph to its end
      link(4, [end1.x - 20, 719, end1.x, 724]), // the passage's line, its end far from the passage
      link(5, [end2.x - 4, 699, end2.x - 0.4, 704]), // line 2's last glyph, short of its end
      link(6, [72, 677, 400, 691]), // line 3 and the blank past its end
      link(7, [passageLeft + 2, 719, passageRight - 2, 724]), // over the passage
      link(8, [passageRight, 719, passageRight + 6, 724]), // touching the passage's right edge
      link(9, [passageLeft - 30, 717, passageLeft + 1, 731]), // into the passage from the left
    ];
    const result = await copyOf(original, links);
    expect(result.kept).toEqual([1, 2, 3, 4, 5, 6].map(id));
    expect(await gateVerdict({ copy: result.pdf, original, quotes: QUOTES, image: 'show', origin: ORIGIN, links, kept: result.kept ?? [] })).toEqual({ pass: true });
    // With no quote the page is not redacted and every line-end link was kept before the fix too.
    const plain = await redactPdf(original, { quotes: [], redactsAny: true, origin: ORIGIN, links: links.slice(0, 6) });
    expect(plain.kind === 'redacted' ? plain.kept : null).toEqual([1, 2, 3, 4, 5, 6].map(id));
  });

  it('still drops, by its own block with the link guard off, a link over only the ink of a space removed with the passage', async () => {
    const original = await linesPdf(LINES);
    const chars = await charsOf(original);
    const last = Math.max(...matchedChars(chars, QUOTES));
    // The space after "Wrenhallow": removed with the passage, outside its box, its ink a line on the baseline.
    const space = chars[last + 1] as PageChar;
    expect(space.text === ' ' && !space.generated && space.ink !== null).toBe(true);
    const ink = space.ink as Box;
    const over = link(1, [ink.left + 0.5, ink.bottom - 1, ink.right - 0.5, ink.bottom + 1]);
    const off = { guard: () => Promise.resolve([]) };
    const result = await redactPdf(original, { quotes: QUOTES, redactsAny: true, origin: ORIGIN, links: [over] }, off);
    if (result.kind !== 'redacted') throw new Error(result.kind);
    expect(stillThere([space], await charsOf(result.pdf)).size).toBe(0);
    expect(result.boxes.some((b) => meets(box(over.rect), b))).toBe(false);
    expect(result.kept).toEqual([]);
  });

  it('blocks a cell of a grid over the page exactly when it meets a box or the ink of a glyph the copy lacks', async () => {
    const original = await linesPdf(LINES);
    // 8 x 4 pt cells, 10 pt apart across and 5 pt down, over the four lines and past their ends.
    const cells: EngineLink['rect'][] = [];
    for (let y = 735; y >= 650; y -= 5) for (let x = 72; x < 452; x += 10) cells.push([x + 1, y + 1, x + 9, y + 5]);
    const kept = new Set<string>();
    let boxes: Box[] = [];
    let copy: Uint8Array = new Uint8Array();
    for (let start = 0; start < cells.length; start += 350) {
      const part = cells.slice(start, start + 350).map((rect, i) => link(start + i, rect));
      const result = await copyOf(original, part);
      for (const k of result.kept ?? []) kept.add(k);
      boxes = result.boxes;
      copy = result.pdf;
    }
    // What the copy truly withholds, read apart from the engine: its boxes, and every glyph of the original (no
    // generated character) that PDFium no longer reads in the copy, by its ink and its loose box.
    const before = await charsOf(original);
    const there = stillThere(before, await charsOf(copy));
    const gone = before.flatMap((c, i) => (c.generated || there.has(i) ? [] : [c.ink, c.box].filter((b): b is Box => b !== null)));
    expect(gone.length).toBeGreaterThan(0);
    const zone = [...boxes, ...gone];
    const wrong = cells.flatMap((rect, i) => {
      const blocked = !kept.has(id(i));
      const withheld = zone.some((area) => meets(box(rect), area));
      return blocked === withheld ? [] : [`${blocked ? 'blocked' : 'kept'} ${JSON.stringify(rect)}`];
    });
    expect(wrong).toEqual([]);
    // Some cells are blocked (over the passage) and most are not.
    expect(cells.length - kept.size).toBeGreaterThan(0);
    expect(kept.size).toBeGreaterThan(cells.length * 0.9);
  });
});
