// REDACT R3a: finding marked passages in a PDF page's text and turning them
// into the regions that are removed and boxed. Pure: a page is a list of
// characters as PDFium reports them (text, generated or not, a line-end
// hyphen or not, a box). Every name here is made up.
import { describe, expect, it } from 'vitest';
import { type PageChar, WIDTH_STEP_EM, matchedChars, regionsFor, textMatches } from './match.js';

const SIZE = 12;
const ADVANCE = 6;

/** A page laid out one line per string, 6 pt per character, 12 pt type; PDFium's generated CR LF between lines. */
function page(lines: readonly string[], options: { x?: number; generatedSpaces?: boolean } = {}): PageChar[] {
  const out: PageChar[] = [];
  lines.forEach((line, row) => {
    if (row > 0) {
      out.push({ text: '\r', generated: true, hyphen: false, box: null, fontSize: 0 });
      out.push({ text: '\n', generated: true, hyphen: false, box: null, fontSize: 0 });
    }
    const bottom = 700 - row * 20;
    [...line].forEach((ch, col) => {
      const left = (options.x ?? 72) + col * ADVANCE;
      const hyphen = ch === '\u0002';
      out.push({
        text: ch,
        generated: false,
        hyphen,
        box: { left, right: left + ADVANCE, bottom, top: bottom + SIZE },
        fontSize: SIZE,
      });
    });
  });
  return out;
}

const textOf = (chars: readonly PageChar[], indices: ReadonlySet<number>): string =>
  [...indices]
    .sort((a, b) => a - b)
    .map((i) => (chars[i] as PageChar).text)
    .join('');

describe('matchedChars', () => {
  it('finds a passage as whole words, folded, on one line', () => {
    const chars = page(['Call QUILLON  brask today.']);
    expect(textOf(chars, matchedChars(chars, ['Quillon Brask']))).toBe('QUILLON  brask');
  });

  it('does not match inside a longer word', () => {
    const chars = page(['Annual meeting, Ann.']);
    expect(textOf(chars, matchedChars(chars, ['Ann']))).toBe('Ann');
  });

  it('finds a passage split across two lines', () => {
    const chars = page(['ask Marvel', 'Ostrander at the door']);
    expect(textOf(chars, matchedChars(chars, ['Marvel Ostrander']))).toBe('MarvelOstrander');
  });

  it('finds a word hyphenated at a line end, with PDFium\'s soft-hyphen marker', () => {
    const chars = page(['Tobias Wren\u0002', 'field hosted it']);
    expect(textOf(chars, matchedChars(chars, ['Wrenfield']))).toBe('Wren\u0002field');
  });

  it('finds a word hyphenated at a line end when PDFium reports no line break after the hyphen', () => {
    const chars = page(['Tobias Wren\u0002', 'hallow hosted it']).filter((c) => !c.generated);
    expect(textOf(chars, matchedChars(chars, ['Wrenhallow']))).toBe('Wren\u0002hallow');
  });

  it('finds a word hyphenated at a line end with a plain hyphen', () => {
    const chars = page(['Tobias Wren-', 'field hosted it']);
    expect(textOf(chars, matchedChars(chars, ['Wrenfield']))).toBe('Wren-field');
  });

  it('keeps a real hyphenated compound that breaks at the hyphen', () => {
    const chars = page(['Ada Smith-', 'Jones came']);
    expect(textOf(chars, matchedChars(chars, ['Smith-Jones']))).toBe('Smith-Jones');
  });

  it('finds a ligature that PDFium reports as two characters', () => {
    const chars = page(['the Snowfield farm']);
    expect(textOf(chars, matchedChars(chars, ['Snowfield']))).toBe('Snowfield');
  });

  it('finds a compatibility ligature character', () => {
    const chars = page(['the Snowﬁeld farm']);
    expect(textOf(chars, matchedChars(chars, ['Snowfield']))).toBe('Snowﬁeld');
  });

  it('finds look-alike letters', () => {
    const chars = page(['Call Quiаlon now']);
    expect(textOf(chars, matchedChars(chars, ['Quialon']))).toBe('Quiаlon');
  });

  it('finds letter-spaced text as a whole word', () => {
    const chars = page(['Phone K e s t r e l, n o w please']);
    expect(textOf(chars, matchedChars(chars, ['Kestrel']))).toBe('K e s t r e l');
  });

  it('does not take a mark out of the middle of a word, plain or letter-spaced, but takes it letter-spaced alone', () => {
    const plain = page(['Come before noon']);
    expect(matchedChars(plain, ['befo']).size).toBe(0);
    const word = page(['Come b e f o r e noon']);
    expect(matchedChars(word, ['befo']).size).toBe(0);
    const alone = page(['Ask B e f o today']);
    expect(textOf(alone, matchedChars(alone, ['befo']))).toBe('B e f o');
  });

  it('finds letter-spaced text across PDFium generated spaces', () => {
    const chars = page(['Phone K e s t r e l.']).map((c) => (c.text === ' ' ? { ...c, generated: true, box: null } : c));
    expect(textOf(chars, matchedChars(chars, ['Kestrel'])).replaceAll(' ', '')).toBe('Kestrel');
  });

  it('leaves ordinary words alone in the letter-spaced pass', () => {
    const chars = page(['Annual plan next']);
    expect(matchedChars(chars, ['Ann', 'plann']).size).toBe(0);
  });

  it('matches nothing without quotes', () => {
    expect(matchedChars(page(['anything']), []).size).toBe(0);
  });

  it('finds a name whose first word alone is letter-spaced', () => {
    const chars = page(['Phone J u n o Blackwood now.']);
    expect(textOf(chars, matchedChars(chars, ['Juno Blackwood']))).toBe('J u n o Blackwood');
  });
});

describe('textMatches (a plain string, as the output gate reads it)', () => {
  it('finds a passage as whole words, folded, across a line break and a line-end hyphen', () => {
    expect(textMatches('call KESTREL\nWren-\nhallow now', ['Kestrel Wrenhallow'])).toBe(true);
    expect(textMatches('Smith-\r\nJones', ['Smith-Jones'])).toBe(true);
  });

  it('finds letter-spaced and mixed-spaced passages', () => {
    expect(textMatches('see K e s t r e l, then', ['Kestrel'])).toBe(true);
    // The price of word edges (HARDEN-1): single letters run straight on give no edge, so read as one word.
    expect(textMatches('x K e s t r e l y', ['Kestrel'])).toBe(false);
    expect(textMatches('Phone J u n o Blackwood now.', ['Juno Blackwood'])).toBe(true);
  });

  it('does not match inside a longer word, or without quotes', () => {
    expect(textMatches('Ann Leek', ['Ann Lee'])).toBe(false);
    expect(textMatches('come b e f o r e noon', ['befo'])).toBe(false);
    expect(textMatches('ask B e f o today', ['befo'])).toBe(true);
    expect(textMatches('anything', [])).toBe(false);
  });

  it('finds a passage across the seam of a long text read in pieces', () => {
    const long = `${'x'.repeat(70_000)} Kestrel ${'y'.repeat(70_000)}`;
    expect(textMatches(long, ['Kestrel'])).toBe(true);
    const seam = `${'x '.repeat(32_766)}Kestrel Wrenhallow`;
    expect(textMatches(seam, ['Kestrel Wrenhallow'])).toBe(true);
  });
});

describe('regionsFor', () => {
  const step = WIDTH_STEP_EM * SIZE;

  it('widens a short passage to one step from its left edge', () => {
    const chars = page(['Call Bo today, and the rest of a long line of text']);
    const result = regionsFor(chars, matchedChars(chars, ['Bo']));
    expect(result).toEqual({
      ok: true,
      regions: [{ page: 0, left: 72 + 5 * ADVANCE, right: 72 + 5 * ADVANCE + step, bottom: 700, top: 712, fontSize: SIZE }],
    });
  });

  it('gives two passages of different lengths in the same step boxes of the same width', () => {
    const chars = page(['x Bo y and some filler words here', 'x Quillon y and some filler words here']);
    const result = regionsFor(chars, matchedChars(chars, ['Bo', 'Quillon']));
    if (!result.ok) throw new Error(result.reason);
    const widths = result.regions.map((r) => r.right - r.left);
    expect(widths).toEqual([step, step]);
  });

  it('widens a long passage to the next multiple of the step', () => {
    const chars = page(['x Bartholomew y then a much longer tail of filler text']);
    const result = regionsFor(chars, matchedChars(chars, ['Bartholomew']));
    if (!result.ok) throw new Error(result.reason);
    expect(result.regions.map((r) => r.right - r.left)).toEqual([2 * step]);
  });

  it('caps a region at the line, shifting it left first', () => {
    const chars = page(['a long line that ends with Bo']);
    const result = regionsFor(chars, matchedChars(chars, ['Bo']));
    if (!result.ok) throw new Error(result.reason);
    const lineRight = 72 + 29 * ADVANCE;
    expect(result.regions).toEqual([{ page: 0, left: lineRight - step, right: lineRight, bottom: 700, top: 712, fontSize: SIZE }]);
  });

  it('caps a region at a line shorter than one step', () => {
    const chars = page(['Bo ok']);
    const result = regionsFor(chars, matchedChars(chars, ['Bo']));
    if (!result.ok) throw new Error(result.reason);
    expect(result.regions).toEqual([{ page: 0, left: 72, right: 72 + 5 * ADVANCE, bottom: 700, top: 712, fontSize: SIZE }]);
  });

  it('gives each line of a split passage its own region', () => {
    const chars = page(['then you can ask Marvel', 'Ostrander at the door and more filler text']);
    const result = regionsFor(chars, matchedChars(chars, ['Marvel Ostrander']));
    if (!result.ok) throw new Error(result.reason);
    expect(result.regions.map((r) => r.bottom)).toEqual([700, 680]);
  });

  it('starts a new line after PDFium\'s line-end hyphen, even with no line break reported', () => {
    const chars = page(['then Tobias Wren\u0002', 'hallow hosted it and more filler text']).filter((c) => !c.generated);
    const result = regionsFor(chars, matchedChars(chars, ['Wrenhallow']));
    if (!result.ok) throw new Error(result.reason);
    // The hyphen is the first line's last glyph: its region reaches it.
    expect(result.regions.map((r) => [r.left, r.right, r.bottom, r.top])).toEqual([[126, 174, 700, 712], [72, 120, 680, 692]]);
  });

  it('merges regions that overlap once widened, then widens the merge to a whole step', () => {
    const chars = page(['x Bo Al y and some filler words here to widen']);
    const result = regionsFor(chars, matchedChars(chars, ['Bo', 'Al']));
    if (!result.ok) throw new Error(result.reason);
    expect(result.regions.map((r) => r.right - r.left)).toEqual([2 * step]);
  });

  it('refuses a matched character that has no box', () => {
    const chars = page(['Call Bo now']).map((c, i) => (i === 5 ? { ...c, box: null } : c));
    expect(regionsFor(chars, new Set([5, 6]))).toEqual({ ok: false, reason: 'a withheld passage on page 1 has no position' });
  });

  it('gives no regions for no matches', () => {
    expect(regionsFor(page(['nothing']), new Set())).toEqual({ ok: true, regions: [] });
  });

  it('runs a box that reaches the line end on to the page\'s right margin, so its edge does not show where the passage ends', () => {
    // 612 pt page, text from 72: the right margin mirrors the left, at 540.
    const lee = page(['Please phone our club treasurer, Ann Lee']);
    const leek = page(['Please phone our club treasurer, Ann Leek']);
    const boxOf = (chars: PageChar[], quote: string): number[] => {
      const result = regionsFor(chars, matchedChars(chars, [quote]), 0, 612);
      if (!result.ok) throw new Error(result.reason);
      return result.regions.map((r) => [r.left, r.right]).flat();
    };
    const annAt = 72 + 33 * ADVANCE;
    expect(boxOf(lee, 'Ann Lee')).toEqual([annAt, 540]);
    expect(boxOf(leek, 'Ann Leek')).toEqual([annAt, 540]);
  });

  it('stops a line-end box short of text further right in the same band (a second column)', () => {
    const left = page(['some words then Ann Lee']);
    const right = page(['other column']).map((c) => ({ ...c, box: c.box && { ...c.box, left: c.box.left + 300, right: c.box.right + 300 } }));
    const chars = [...left, { text: '\n', generated: true, hyphen: false, box: null, fontSize: 0 }, ...right];
    const result = regionsFor(chars, matchedChars(chars, ['Ann Lee']), 0, 612);
    if (!result.ok) throw new Error(result.reason);
    expect(result.regions.map((r) => [r.left, r.right])).toEqual([[72 + 16 * ADVANCE, 372]]);
  });

  it('keeps a line-end box at the line when the line already passes the right margin', () => {
    const chars = page(['a long line that ends with Bo']);
    const result = regionsFor(chars, matchedChars(chars, ['Bo']), 0, 72 + 29 * ADVANCE + 10);
    if (!result.ok) throw new Error(result.reason);
    const lineRight = 72 + 29 * ADVANCE;
    expect(result.regions.map((r) => [r.left, r.right])).toEqual([[lineRight - step, lineRight]]);
  });

  it('numbers the page it is given', () => {
    const chars = page(['Bo and more filler words to widen into']);
    const result = regionsFor(chars, matchedChars(chars, ['Bo']), 3);
    if (!result.ok) throw new Error(result.reason);
    expect(result.regions[0]?.page).toBe(3);
  });
});
