// ARCHIVE-SEARCH S1: the one line-end hyphen rule, against the fixture both apps will share.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TEXT_VERSION, capUtf8, pageText, plain } from './text.js';

interface Case {
  name: string;
  items: Array<{ str: string; hasEOL?: boolean }>;
  text: string;
  extra: string;
  finds: string[];
  misses: string[];
}

const fixture = JSON.parse(readFileSync(new URL('../../test/fixtures/hyphen-cases.json', import.meta.url), 'utf8')) as { cases: Case[] };

describe('search/text: the page text the index stores', () => {
  it('has cases to run', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(20);
    expect(TEXT_VERSION).toBe(1);
  });

  it.each(fixture.cases)('$name', ({ items, text, extra, finds, misses }) => {
    const page = pageText(items);
    expect(page).toEqual({ text, extra });
    const haystack = `${page.text} ${page.extra}`.toLowerCase();
    for (const typed of finds) expect(haystack, typed).toContain(typed.toLowerCase());
    for (const typed of misses) expect(haystack, typed).not.toContain(typed.toLowerCase());
  });

  it('never leaves a soft hyphen, a line break or a double space in what it stores', () => {
    for (const { items } of fixture.cases) {
      const { text, extra } = pageText(items);
      expect(`${text}|${extra}`).not.toMatch(/­|\n| {2}/);
    }
  });

  it('puts a space between items that meet on a line, so a word beside a label is not fused with it', () => {
    const { text, extra } = pageText([{ str: 'Call today' }, { str: 'Private' }, { str: ' or later' }]);
    expect(text.split(' ')).toEqual(['Call', 'today', 'Private', 'or', 'later']);
    expect(extra).toBe('todayPrivate');
    // A line end between them is still a line end: the hyphen join is unchanged.
    expect(pageText([{ str: 'Call Quil-' }, { str: '', hasEOL: true }, { str: 'lon today' }])).toEqual({ text: 'Call Quillon today', extra: 'Quil-lon' });
  });

  it('plain() gives item text one form: NFKC, no soft hyphen, single spaces, lines kept', () => {
    expect(plain(' mem­bers  of\tthe oﬃce \n\n next ')).toBe('members of the office\nnext');
    expect(plain('')).toBe('');
  });

  it('capUtf8() cuts on a character, never inside one', () => {
    expect(capUtf8('abc', 10)).toBe('abc');
    expect(capUtf8('abcdef', 3)).toBe('abc');
    // "é" is two bytes: a cut inside it drops it whole.
    expect(capUtf8('aé', 2)).toBe('a');
    expect(capUtf8('a😀', 4)).toBe('a');
    expect(Buffer.byteLength(capUtf8('é'.repeat(100), 51))).toBe(50);
  });
});
