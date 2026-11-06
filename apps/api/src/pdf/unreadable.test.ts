// LIGATURE: a glyph with no readable text (U+FFFD, a private-use code point) where a withheld quote may be.
// Every name here is made up.
import { describe, expect, it } from 'vitest';
import { type PageChar, matchedChars } from './match.js';
import { charUnits, isUnreadable, readThrough, reachOf, textUnits, unreadableAt } from './unreadable.js';

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
    for (const ch of ['a', 'ﬁ', 'ﬄ', ' ', '-', '\u0002', '\r', '\n', '\t', '😀']) expect(isUnreadable(ch)).toBe(false);
  });

  it('is U+0000 and every other C0 control but tab, line feed, carriage return and PDFium\'s U+0002 (LIGATURE fix 1, F5)', () => {
    for (let cp = 0; cp < 0x20; cp++) expect(isUnreadable(String.fromCharCode(cp)), cp.toString(16)).toBe(![0x02, 0x09, 0x0a, 0x0d].includes(cp));
  });
});

/** The indices unreadableAt gives for a string's characters. */
const misfits = (text: string): number[] => [...unreadableAt([...text])].sort((a, b) => a - b);

describe('unreadableAt: a letter whose Unicode does not fit its word (LIGATURE fix 1, F1: Ghostscript\'s re-distilled ligatures)', () => {
  it('flags a letter of another script inside a Latin word: fi U+0856, fl U+0857, ff U+0853, ffl U+0855, ti U+08A2, tt U+08B0', () => {
    expect(misfits('so Fi\u0856 Amberwick')).toEqual([5]);
    expect(misfits('Orla Pen\u0857eet')).toEqual([8]);
    expect(misfits('Ferncli\u0853 Gazette')).toEqual([7]);
    expect(misfits('Wa\u0855estafford')).toEqual([2]);
    expect(misfits('\u08A2med rounds')).toEqual([0]);
    expect(misfits('Pe\u08B0bone')).toEqual([2]);
  });

  it('flags an accented capital drawn after a small letter (ffi read as f and U+00CF), not an ASCII one', () => {
    expect(misfits('Tif\u00CFn Ashgrove')).toEqual([3]);
    expect(misfits('Ef\u00CFngtonshirecastle')).toEqual([2]);
    for (const text of ['McDonald', 'iPhone', 'DeVries', '\u00CFsland', 'NA\u00CFVE', 'na\u00EFve']) expect(misfits(text), text).toEqual([]);
  });

  it('flags every letter of a word two scripts share equally, and none of a word in one script', () => {
    expect(misfits('a\u0856 b')).toEqual([0, 1]);
    for (const text of ['caf\u00E9 Zo\u00EB \u00C5ngstr\u00F6m', '\u0391\u03B8\u03AE\u03BD\u03B1', '\u041C\u043E\u0441\u043A\u0432\u0430', '\u6771\u4EAC\u30BF\u30EF\u30FC', 'e\u0301t\u00E9', 'H2O \u00B5m']) expect(misfits(text), text).toEqual([]);
  });

  it('flags U+FFFD, private use and the C0 controls wherever they are, and nothing in plain ASCII', () => {
    expect(misfits('o\uFFFDce Ferncli\u0000 \uE001')).toEqual([1, 12, 14]);
    expect(misfits('The office staff, Ferncliff\r\n\tand\u0002more')).toEqual([]);
  });

  it('looks scripts up afresh once it has looked up more letters than it keeps, and reads them alike', () => {
    expect(unreadableAt(Array.from({ length: 5000 }, (_, i) => String.fromCodePoint(0x4e00 + i))).size).toBe(0);
    expect(misfits('so Fi\u0856 Amberwick')).toEqual([5]);
  });

  it('keeps a combining mark in its word: a misfit after a decomposed accent is flagged (fix 2, N1: V4)', () => {
    expect(misfits('Re\u0301\u0856')).toEqual([3]);
    expect(misfits('so Re\u0301\u0856 Amberwick')).toEqual([6]);
  });

  it('counts a letter of a script it does not list as a script of its own', () => {
    expect(misfits('ab\u{10940}c')).toEqual([2]);
  });
});

describe('Ghostscript\'s readable but wrong ligature code points: matched and read through (LIGATURE fix 1, F1)', () => {
  const cases: Array<[string, string, string]> = [
    ['Fi\u0856 Amberwick', 'Fifi Amberwick', 'Fi\u0856 Amberwick'],
    ['Orla Pen\u0857eet', 'Orla Penfleet', 'Orla Pen\u0857eet'],
    ['Tif\u00CFn Ashgrove', 'Tiffin Ashgrove', 'Tif\u00CFn Ashgrove'],
    ['Ferncli\u0853', 'Ferncliff', 'Ferncli\u0853'],
    ['Bartolomeo Ef\u00CFngtonshirecastle', 'Bartolomeo Effingtonshirecastle', 'Bartolomeo Ef\u00CFngtonshirecastle'],
    ['Hieronymus Wa\u0855estaffordshire', 'Hieronymus Wafflestaffordshire', 'Hieronymus Wa\u0855estaffordshire'],
    ['Fjorda Pe\u08B0bone', 'Fjorda Pettibone', 'Fjorda Pe\u08B0bone'],
    ['Ernes\u08A2ne Rook', 'Ernestine Rook', 'Ernes\u08A2ne Rook'],
    ['Ferncli\u0000', 'Ferncliff', 'Ferncli\u0000'],
  ];

  it('the engine\'s matcher boxes each, the glyph with it', () => {
    for (const [text, quote, found] of cases) {
      const chars = line(`and ${text} said`);
      expect(textOf(chars, matchedChars(chars, [quote])), quote).toBe(found);
    }
  });

  it('the gate reads each through the glyph, on its own', () => {
    for (const [text, quote] of cases) expect(readThrough(textUnits(`and ${text} said`), [quote]), quote).toBe(true);
  });

  it('reads PDFium\'s glyphs with no Unicode (a map error) as unreadable too', () => {
    const chars = line('Moira ShuZeby').map((c, i) => (i === 9 ? { ...c, unmapped: true } : c));
    expect(charUnits(chars)).toContain(3);
    expect(readThrough(charUnits(chars), ['Moira Shuffleby'])).toBe(true);
    expect(textOf(chars, matchedChars(chars, ['Moira Shuffleby']))).toBe('Moira ShuZeby');
  });
});

describe('matchedChars: the ligatures a glyph may stand for, matched in one pass (LIGATURE fix 1, F4; fix 2, S1)', () => {
  it('finds a quote with each ligature a producer draws, ck, ft, tt, ti, fj, Th, ffj, fb, fh, fk, tf, ffb, ffh, ffk, fft, tti among them', () => {
    const cases: Array<[string, string]> = [
      ['Amberwi\uE002', 'Amberwick'],
      ['Lo\uE001on', 'Lofton'],
      ['Pe\uE003bone', 'Pettibone'],
      ['Ernes\uE004ne', 'Ernestine'],
      ['\uE000orda', 'Fjorda'],
      ['\uE000addeus', 'Thaddeus'],
      ['Ha\uE000ord', 'Haffjord'],
      ['O\uE000ury', 'Ofbury'],
      ['Ra\uE000am', 'Rafham'],
      ['Ka\uE000a', 'Kafka'],
      ['Ou\uE000ield', 'Outfield'],
      ['Mo\uE000ury', 'Moffbury'],
      ['Ho\uE000am', 'Hoffham'],
      ['Ka\uE000a', 'Kaffka'],
      ['Gri\uE000on', 'Griffton'],
      ['Ma\uE000ng', 'Matting'],
    ];
    for (const [text, quote] of cases) {
      const chars = line(`by ${text} today`);
      expect(textOf(chars, matchedChars(chars, [quote])), quote).toBe(text);
    }
  });

  it('reads a ligature in each way it can be taken: ffl whole, or ff or fl with the other letter as written', () => {
    for (const text of ['Ru\uFFFDe', 'Ru\uFFFDle', 'Ruf\uFFFDe']) {
      const chars = line(`by ${text} today`);
      expect(textOf(chars, matchedChars(chars, ['Ruffle'])), text).toBe(text);
    }
    // Each of fft, ff, ft, tt, ti and tti; and two glyphs, fft then ti or ff then tti, two ways to the same letters.
    for (const text of ['Ha\uFFFDting', 'Ha\uFFFDtting', 'Haf\uFFFDting', 'Haff\uFFFDing', 'Hafft\uFFFDng', 'Haff\uFFFDng', 'Ha\uFFFD\uFFFDng']) {
      const chars = line(`by ${text} today`);
      expect(textOf(chars, matchedChars(chars, ['Hafftting'])), text).toBe(text);
    }
  });

  it('finds a passage of a sentence or more through one of its ligatures, beside a far-away one (fix 2, S1)', () => {
    // 2,047 readings of the quote by its ligatures: matched in one pass, with no cap.
    const passage = 'The attendees list for the October potluck is withheld from the public edition of this newsletter.';
    const drawn = passage.replace('list', 'li\uFFFD');
    const chars = line(`In the o\uFFFDce: ${drawn} Orla Penfleet kept score.`);
    expect(textOf(chars, matchedChars(chars, ['Orla Penfleet', passage]))).toBe(`${drawn.slice(0, -1)}Orla Penfleet`);
  });

  it('finds each of many quotes with many ligatures on one page, with no cap on the quotes of a page (fix 2, S1)', () => {
    const quotes = Array.from({ length: 40 }, (_, i) => `Tiffin Shuffleby ${i}`);
    const chars = line('the o\uFFFDce: Ti\uFFFDn Shu\uFFFDeby 7 and Tiffin Shu\uFFFDleby 31 and Ti\uFFFDn Shuffleby 39 came');
    expect(textOf(chars, matchedChars(chars, quotes))).toBe('Ti\uFFFDn Shu\uFFFDeby 7Tiffin Shu\uFFFDleby 31Ti\uFFFDn Shuffleby 39');
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

  it('reads a quote with many ligatures, written out, as written, and readThrough finds it through the glyphs', () => {
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
    // A word wholly in Cyrillic look-alikes has no misfit: only the look-alikes read it as the quote (fix 2, S2: X12).
    expect([...unreadableAt([...'\u0420\u0430\uFFFD\u0435'])]).toEqual([2]);
    expect(readThrough(textUnits('\u0420\u0430\uFFFD\u0435'), ['Paste'])).toBe(true);
    expect(readThrough(textUnits('\u0420\u0430\uFFFD\u0435 \u0410\u0441\u0435'), ['Paste Ace'])).toBe(true);
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

  it('rounds a glyph\'s reach up off a letter\'s boundary, and reads its ink where it is wider than its advance (F3: X6, X7)', () => {
    const [c] = line('\uFFFD');
    const at = (ink: number, box: number): PageChar => ({ ...(c as PageChar), ink: { left: 72, right: 72 + ink, bottom: 701, top: 703 }, box: { left: 72, right: 72 + box, bottom: 700, top: 702 } });
    // 3.4 letters' width at REACH_EM (0.25 em of 12 pt: 3 pt a letter): four.
    expect(reachOf(at(10.2, 6))).toBe(4);
    // Ink 18 pt wide over an advance of 6: six letters, not the advance's three.
    expect(reachOf(at(18, 6))).toBe(6);
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
