// L-ITEM fix round 2 (R1-N2): what a reviewer's note keeps, without a database. A note nobody can see is no
// note (it lifts no DROP); one of emoji, or of letters in any script, is kept. Written as escapes throughout.
import { describe, expect, it } from 'vitest';
import { keptNote } from './link-gate.js';

const BLANK: [string, string][] = [
  ['no-break spaces', '\u00a0\u202f'],
  ['direction marks, isolates and embeddings', '\u200e\u200f\u061c\u2066\u2069\u202a\u202c'],
  ['a variation selector', '\ufe0f'],
  ['supplementary variation selectors', '\u{e0100}\u{e01ef}'],
  ['a combining mark alone', '\u0301'],
  ['a combining grapheme joiner', '\u034f'],
  ['Hangul fillers', '\u3164\u115f\u1160\uffa0'],
  ['tag characters', '\u{e0020}\u{e0041}\u{e007f}'],
  ['a blank braille cell', '\u2800'],
  ['a soft hyphen', '\u00ad'],
  ['a Mongolian vowel separator', '\u180e'],
  ['invisible operators', '\u2060\u2061\u2062\u2063\u2064'],
  ['an ideographic space', '\u3000'],
  ['Khmer inherent vowels', '\u17b4\u17b5'],
  ['line and paragraph separators', '\u2028\u2029'],
  ['musical format characters', '\u{1d173}\u{1d17a}'],
  ['a half-width Hangul filler between joiners', '\u200d\uffa0\u200d'],
  ['shorthand format characters', '\u{1bca0}\u{1bca3}'],
  ['Egyptian format characters', '\u{13430}\u{13438}'],
  ['a private-use character', '\ue000'],
  ['a noncharacter', '\ufdd0'],
  ['interlinear annotation marks', '\ufff9\ufffa\ufffb'],
  // Fix round 2: two symbols that draw nothing.
  ['an object replacement character', '\ufffc'],
  ['a musical null notehead', '\u{1d159}'],
  ['both, among spaces and hidden characters', ' \u200b\ufffc\u00a0\u{1d159}\ufeff\t'],
  ['nothing', ''],
];

const KEPT: [string, string][] = [
  ['a thumbs-up', '\u{1f44d}'],
  ['a check mark', '\u2705'],
  ['a keycap', '1\ufe0f\u20e3'],
  ['a flag', '\u{1f1fa}\u{1f1f8}'],
  ['a face with a skin tone', '\u{1f44b}\u{1f3fd}'],
  ['Arabic letters', '\u0646\u0639\u0645'],
  ['Hebrew letters', '\u05db\u05df'],
  ['a Chinese character', '\u597d'],
  ['Devanagari letters with marks', '\u0920\u0940\u0915'],
  ['Thai letters', '\u0e43\u0e0a\u0e48'],
  ['Hangul syllables', '\ub124'],
  ['Cyrillic letters', '\u0434\u0430'],
  ['Greek letters', '\u03bd\u03b1\u03b9'],
  ['a musical half note', '\u{1d15e}'],
  ['a replacement character', '\ufffd'],
  ['one full stop', '.'],
];

describe('keptNote', () => {
  it.each(BLANK)('keeps a note made only of %s as no note', (_label, note) => {
    expect(keptNote(note)).toBeNull();
  });

  it.each(KEPT)('keeps a note of %s as it is', (_label, note) => {
    expect(keptNote(note)).toBe(note);
    expect(keptNote(` \u200b${note}\ufffc \u{1d159}\ufeff`)).toBe(`${note}\ufffc \u{1d159}`);
  });

  it('keeps the words of a note with hidden characters in and around them', () => {
    expect(keptNote(' \u202eFine\u200b by hand.\ufeff ')).toBe('Fine by hand.');
  });
});
