// LIGATURE: a glyph with no readable text (U+FFFD, a private-use code point) where a withheld quote may be.
// Every name here is made up.
import { describe, expect, it } from 'vitest';
import { type PageChar, matchedChars } from './match.js';
import { charUnits, isUnreadable, readThrough, reachOf, textUnits } from './unreadable.js';

const SIZE = 12;
const ADVANCE = 6;

/** One line, 6 pt per character, 12 pt type; `wide` gives a character's advance in ems where it differs. */
function line(text: string, wide: Readonly<Record<number, number>> = {}): PageChar[] {
  let left = 72;
  return [...text].map((ch, i) => {
    const width = (wide[i] ?? ADVANCE / SIZE) * SIZE;
    const c: PageChar = { text: ch, generated: false, hyphen: false, box: { left, right: left + width, bottom: 700, top: 712 }, ink: { left: left + 0.5, right: left + width - 0.5, bottom: 701, top: 710 }, fontSize: SIZE };
    left += width;
    return c;
  });
}

const textOf = (chars: readonly PageChar[], indices: ReadonlySet<number>): string =>
  [...indices]
    .sort((a, b) => a - b)
    .map((i) => (chars[i] as PageChar).text)
    .join('');

describe('isUnreadable: what no reader can turn into text', () => {
  it('is U+FFFD, a private-use code point, a noncharacter or a lone surrogate', () => {
    for (const ch of ['\uFFFD', '\uE000', '\uF001', '\uF8FF', '\u{F0000}', '\u{10FFFD}', '\uFFFE', '\uFFFF', '\uD800', '\uDFFF']) expect(isUnreadable(ch)).toBe(true);
  });

  it('is not a letter, a ligature with its own code point, a space or punctuation', () => {
    for (const ch of ['a', 'ﬁ', 'ﬄ', ' ', '-', '\u0002', '\r', '😀']) expect(isUnreadable(ch)).toBe(false);
  });
});

describe('matchedChars: a ligature glyph with no readable text inside a quote (LIGATURE)', () => {
  it('finds a quote whose fi ligature reads U+FFFD (Cairo re-emitting MuPDF), the glyph included', () => {
    const chars = line('so Fi\uFFFD Amberwick kept score');
    expect(textOf(chars, matchedChars(chars, ['Fifi Amberwick']))).toBe('Fi\uFFFD Amberwick');
  });

  it('finds each of ff, fl, ffi, ffl, st and ct, and a legacy private-use ligature code', () => {
    const cases: Array<[string, string, string]> = [
      ['Griff Ha\uFFFDerty', 'Griff Hafferty', 'Griff Ha\uFFFDerty'],
      ['Orla \uFFFDintwood', 'Orla Flintwood', 'Orla \uFFFDintwood'],
      ['Ti\uFFFDn Ashgrove', 'Tiffin Ashgrove', 'Ti\uFFFDn Ashgrove'],
      ['Moira Shu\uFFFDeby', 'Moira Shuffleby', 'Moira Shu\uFFFDeby'],
      ['Erne\uFFFDine Pell', 'Ernestine Pell', 'Erne\uFFFDine Pell'],
      ['Prosper A\uFFFDonby', 'Prosper Actonby', 'Prosper A\uFFFDonby'],
      ['Fi\uF001 Amberwick', 'Fifi Amberwick', 'Fi\uF001 Amberwick'],
    ];
    for (const [text, quote, found] of cases) {
      const chars = line(`and ${text} said`);
      expect(textOf(chars, matchedChars(chars, [quote]))).toBe(found);
    }
  });

  it('finds a quote with two ligatures, each read as U+FFFD', () => {
    const chars = line('Ti\uFFFDn Ru\uFFFDe came');
    expect(textOf(chars, matchedChars(chars, ['Tiffin Ruffle']))).toBe('Ti\uFFFDn Ru\uFFFDe');
  });

  it('matches only where the glyph stands in place of a ligature and the rest reads as the quote', () => {
    for (const text of ['Fi\uFFFD Amberwock', 'Fif\uFFFD Amberwick', 'Fi\uFFFD\uFFFD Amberwick', 'Fi Amberwick', 'Fix Amberwick', 'Fiq Amberwick']) {
      // A ligature that reads U+FFFD elsewhere on the line: the stand-in is no letter the page has.
      const chars = line(`${text} met at the o\uFFFDce`);
      expect(matchedChars(chars, ['Fifi Amberwick']).size).toBe(0);
    }
  });

  it('reads a quote with more ligature readings than it tries as written, and readThrough still finds it', () => {
    const quote = 'Affiffiffiffiffiffi Moss';
    const chars = line(`by ${quote} and the o\uFFFDce`);
    expect(textOf(chars, matchedChars(chars, [quote]))).toBe(quote);
    expect(readThrough(textUnits('by A\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD Moss'), [quote])).toBe(true);
  });

  it('keeps the strict reading: U+FFFD beside a quote is no letter of its word', () => {
    const chars = line('Amberwick\uFFFD came');
    expect(textOf(chars, matchedChars(chars, ['Amberwick']))).toBe('Amberwick');
  });
});

describe('readThrough: whether a quote could be read through a glyph with no readable text', () => {
  it('finds a quote whose ligature reads U+FFFD, as the gate reads it (pdf.js puts spaces around the glyph)', () => {
    expect(readThrough(textUnits('so Fi\uFFFD Amberwick kept'), ['Fifi Amberwick'])).toBe(true);
    expect(readThrough(textUnits('so Fi \uFFFD   Amberwick kept'), ['Fifi Amberwick'])).toBe(true);
    expect(readThrough(textUnits('Ferncli\uFFFD Puzzle'), ['Ferncliff'])).toBe(true);
  });

  it('finds a quote in a run of unreadable glyphs as long as it (small caps with no Unicode)', () => {
    expect(readThrough(textUnits('by \uFFFD\uFFFD\uFFFD\uFFFD \uFFFD\uFFFD\uFFFD\uFFFD\uFFFD today'), ['Fifi Amberwick'])).toBe(true);
  });

  it('finds nothing where no glyph is unreadable: the strict matcher reads that text', () => {
    expect(textUnits('so Fifi Amberwick kept')).toEqual([]);
    expect(charUnits(line('so Fifi Amberwick kept'))).toEqual([]);
    expect(readThrough(['f', 'i', 'f', 'i'], ['Fifi'])).toBe(false);
  });

  it('finds nothing with no quote, or a quote with no letter', () => {
    expect(readThrough(textUnits('Fi\uFFFD'), [])).toBe(false);
    expect(readThrough(textUnits('Fi\uFFFD'), ['--'])).toBe(false);
  });

  it('keeps word edges: a ligature inside a longer word is no quote', () => {
    const units = textUnits('The o\uFFFDce sta\uFFFD shu\uFFFDed \uFFFDfty e\uFFFDcient wa\uFFFDes.');
    for (const quote of ['Ed', 'Fifi Amberwick', 'Corwin Vellacott', 'Office Hours', 'Stack Hollow']) expect(readThrough(units, [quote])).toBe(false);
  });

  it('a glyph reaches at most three letters: a run of them shorter than the quote is no quote', () => {
    expect(readThrough(textUnits('\uFFFD\uFFFD'), ['Amberwick'])).toBe(false);
    expect(readThrough(textUnits('\uFFFD\uFFFD\uFFFD'), ['Amberwick'])).toBe(true);
  });

  it('counts a letter beside the glyph that the quote does not hold as an edge it cannot cross', () => {
    expect(readThrough(textUnits('xFi\uFFFD Amberwick'), ['Fifi Amberwick'])).toBe(false);
    expect(readThrough(textUnits('Fi\uFFFD Amberwickx'), ['Fifi Amberwick'])).toBe(false);
  });

  it('reads look-alikes as the quote does', () => {
    expect(readThrough(textUnits('F\u0456\uFFFD \u0410mberwick'), ['Fifi Amberwick'])).toBe(true);
  });
});

describe('reachOf and charUnits: how many letters a glyph of the page may stand for', () => {
  it('is three for a glyph no longer than a ligature, more for a longer one, by its ink and advance', () => {
    const chars = line('a\uFFFDb\uFFFD', { 1: 0.55, 3: 6 });
    expect(reachOf(chars[1] as PageChar)).toBe(3);
    expect(reachOf(chars[3] as PageChar)).toBe(24);
  });

  it('is unbounded for a glyph with no place on the page or no size, and by its box\'s longer side with no ink', () => {
    const [c] = line('\uFFFD');
    expect(reachOf({ ...(c as PageChar), box: null, ink: null })).toBe(Number.POSITIVE_INFINITY);
    expect(reachOf({ ...(c as PageChar), fontSize: 0 })).toBe(Number.POSITIVE_INFINITY);
    expect(reachOf({ ...(c as PageChar), ink: null })).toBe(4);
    expect(reachOf({ ...(c as PageChar), box: null })).toBe(3);
  });

  it('a wide unreadable glyph can hide a whole name, a ligature-wide one cannot', () => {
    expect(readThrough(charUnits(line('by \uFFFD today', { 3: 6 })), ['Amberwick'])).toBe(true);
    expect(readThrough(charUnits(line('by \uFFFD today', { 3: 0.55 })), ['Amberwick'])).toBe(false);
  });

  it('reads PDFium\'s line breaks and blanks as edges, and letters folded', () => {
    const chars = [...line('FI\uFFFD'), { text: '\r', generated: true, hyphen: false, box: null, ink: null, fontSize: 0 }, ...line('AMBERWICK')];
    expect(charUnits(chars)).toEqual(['f', 'i', 3, '', 'a', 'm', 'b', 'e', 'r', 'w', 'i', 'c', 'k']);
    expect(readThrough(charUnits(chars), ['Fifi Amberwick'])).toBe(true);
  });
});
