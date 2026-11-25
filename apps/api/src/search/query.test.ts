// ARCHIVE-SEARCH S3: the limits on what a visitor may ask (plan section 3). Every refusal is
// INVALID_ARGUMENT and none repeats a word of the query.
import { Code, ConnectError } from '@connectrpc/connect';
import { describe, expect, it } from 'vitest';
import { MAX_CHARS, MAX_PAGE, MAX_RAW_UNITS, MAX_WORDS, MIN_CHARS, PAGE_SIZE, pageNumber, parseQuery } from './query.js';

const refusal = (run: () => unknown): ConnectError => {
  try {
    run();
  } catch (error) {
    return error as ConnectError;
  }
  throw new Error('expected a refusal');
};

describe('search: the query limits', () => {
  it('pins the plan\'s numbers', () => {
    expect([MIN_CHARS, MAX_CHARS, MAX_WORDS, PAGE_SIZE, MAX_PAGE]).toEqual([2, 100, 8, 10, 10]);
  });

  it('trims, folds runs of white space to one space, and counts characters and words', () => {
    expect(parseQuery('  spring \t\n picnic  ')).toEqual({ text: 'spring picnic', chars: 13, words: 2 });
    expect(parseQuery('ab')).toEqual({ text: 'ab', chars: 2, words: 1 });
  });

  it('normalises to NFKC before it counts: a full-width word is its plain letters', () => {
    expect(parseQuery('ｐｉｃｎｉｃ').text).toBe('picnic');
    // U+FB01 (the fi ligature) is two letters once normalised, so one ligature alone is long enough.
    expect(parseQuery('ﬁ')).toEqual({ text: 'fi', chars: 2, words: 1 });
    // A no-break space separates words like any other.
    expect(parseQuery('game night').words).toBe(2);
  });

  it('counts characters, not UTF-16 units', () => {
    expect(parseQuery('😀😀').chars).toBe(2);
    expect(parseQuery('😀'.repeat(MAX_CHARS)).chars).toBe(MAX_CHARS);
  });

  it('refuses a query under two characters or over a hundred, and one of more than eight words', () => {
    for (const short of ['', ' ', 'a', ' a \n']) expect(refusal(() => parseQuery(short)).code, JSON.stringify(short)).toBe(Code.InvalidArgument);
    expect(parseQuery('x'.repeat(MAX_CHARS)).chars).toBe(MAX_CHARS);
    expect(refusal(() => parseQuery('x'.repeat(MAX_CHARS + 1))).code).toBe(Code.InvalidArgument);
    expect(parseQuery('a b c d e f g h').words).toBe(MAX_WORDS);
    expect(refusal(() => parseQuery('a b c d e f g h i')).code).toBe(Code.InvalidArgument);
  });

  it('refuses a huge query before normalising it', () => {
    expect(parseQuery(` ${'x'.repeat(MAX_CHARS)}`.padEnd(MAX_RAW_UNITS, ' ')).chars).toBe(MAX_CHARS);
    const huge = refusal(() => parseQuery('ﷺ'.repeat(1_000_000)));
    expect(huge.code).toBe(Code.InvalidArgument);
    // Over the bound as it arrived, though two characters once trimmed: the bound is on what was sent.
    expect(refusal(() => parseQuery(`${' '.repeat(MAX_RAW_UNITS - 1)}ab`)).code).toBe(Code.InvalidArgument);
    expect(parseQuery(`${' '.repeat(MAX_RAW_UNITS - 2)}ab`).text).toBe('ab');
  });

  it('refuses control characters, which the database would refuse less politely', () => {
    for (const bad of ['pic\u0000nic', 'pic\u0007nic', 'pic\u007Fnic', 'pic\u0085nic']) expect(refusal(() => parseQuery(bad)).code, JSON.stringify(bad)).toBe(Code.InvalidArgument);
  });

  it('never repeats the query in a refusal', () => {
    const canary = 'zzcanaryzz';
    const refused = [
      refusal(() => parseQuery(`${canary} `.repeat(9))),
      refusal(() => parseQuery(canary.repeat(11))),
      refusal(() => parseQuery(`${canary}\u0000`)),
      refusal(() => parseQuery(canary.repeat(100))),
    ];
    for (const error of refused) {
      expect(error.code).toBe(Code.InvalidArgument);
      expect(error.message).not.toContain(canary);
    }
  });
});

describe('search: the page number', () => {
  it('reads 0 as the first page and takes 1 to 10', () => {
    expect(pageNumber(0)).toBe(1);
    expect(pageNumber(1)).toBe(1);
    expect(pageNumber(MAX_PAGE)).toBe(MAX_PAGE);
  });

  it('refuses anything else', () => {
    for (const bad of [-1, MAX_PAGE + 1, 2_147_483_647, 1.5, Number.NaN]) expect(refusal(() => pageNumber(bad)).code, String(bad)).toBe(Code.InvalidArgument);
  });
});
