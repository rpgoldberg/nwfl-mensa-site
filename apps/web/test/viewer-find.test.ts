// public/scripts/viewer-find.js (READER2): search within the issue. It reads only the text pdf.js gives
// for the file the reader is served, so the public copy's search can never find what its redaction
// took out (e2e/redaction/leak.spec.ts holds that against the real API). Matches are found in each
// page's text, folded to lower case with runs of space as one, and painted in pdf.js's text layer.
import { describe, expect, it } from 'vitest';
import { NO_TEXT, findIn, hasText, indexText, matchLabel, paintHits, queryOf, rangesOf } from '../public/scripts/viewer-find.js';
import { FakeDoc, FakeEl } from './viewer-fakes';

const items = (...strs: (string | [string, boolean])[]) => strs.map((s) => (typeof s === 'string' ? { str: s } : { str: s[0], hasEOL: s[1] }));

describe('queryOf', () => {
  it('folds what was typed to lower case, trims it, and runs of space become one', () => {
    expect(queryOf('  Picnic   ON Saturday ')).toBe('picnic on saturday');
    expect(queryOf('   ')).toBe('');
    expect(queryOf('\tA\n\nb')).toBe('a b');
  });
});

describe('indexText', () => {
  it("joins a page's text items, lower case, with one space for each run of space and at each line's end", () => {
    const index = indexText(items(['Pensa', true], 'Public  copy,', ' ', 'page 1'));
    expect(index.text).toBe('pensa public copy, page 1');
    // Each character knows its item and its place in it; the space a line's end adds belongs to none.
    expect([index.item[0], index.at[0]]).toEqual([0, 0]);
    expect([index.item[5], index.at[5]]).toEqual([-1, -1]);
    expect([index.item[6], index.at[6]]).toEqual([1, 0]);
    expect([index.item[13], index.at[13]]).toEqual([1, 8]);
  });

  it('starts with no space, never doubles one across items, and keeps a letter whose lower case is longer', () => {
    const index = indexText(items(' ', ['  ', true], 'İx', [' ', true], 'y'));
    expect(index.text).toBe('İx y');
    expect(index.item).toEqual([2, 2, 3, 4]);
  });

  it('is empty for a page with no text (a scanned page), and hasText says so', () => {
    expect(indexText([]).text).toBe('');
    expect(hasText([])).toBe(false);
    expect(hasText(items(' ', ['', true]))).toBe(false);
    expect(hasText(items(' ', 'a'))).toBe(true);
  });
});

describe('characters outside the basic plane (S5)', () => {
  it('an emoji before a match shifts nothing: "picnic" paints exactly "Picnic", and "saturday" its own word', () => {
    const its = items(['\u{1F4C5}\u{1F4C5}\u{1F4C5} Dates', true], 'Picnic Saturday');
    const index = indexText(its);
    expect(index.item).toHaveLength(index.text.length);
    const range = (q: string) => rangesOf(index, findIn(index, q)[0]!, q.length);
    const str = (r: { item: number; from: number; to: number }) => its[r.item]!.str.slice(r.from, r.to);
    expect(range('picnic').map(str)).toEqual(['Picnic']);
    expect(range('saturday').map(str)).toEqual(['Saturday']);
    expect(range('\u{1F4C5} dates').map(str)).toEqual(['\u{1F4C5} Dates']);
  });
});

describe('findIn', () => {
  it('finds every place, one after another and never overlapping; nothing for an empty query', () => {
    const index = indexText(items('aaa ', 'banana'));
    expect(findIn(index, 'a')).toEqual([0, 1, 2, 5, 7, 9]);
    expect(findIn(index, 'ana')).toEqual([5]);
    expect(findIn(index, 'aa')).toEqual([0]);
    expect(findIn(index, '')).toEqual([]);
    expect(findIn(index, 'cherry')).toEqual([]);
  });
});

describe('rangesOf', () => {
  it("gives each item's part of a match, across items, leaving out the space a line's end adds", () => {
    const index = indexText(items(['The picnic', true], 'is on ', 'Saturday'));
    const at = findIn(index, 'picnic is on sat')[0]!;
    expect(rangesOf(index, at, 'picnic is on sat'.length)).toEqual([
      { item: 0, from: 4, to: 10 },
      { item: 1, from: 0, to: 6 },
      { item: 2, from: 0, to: 3 },
    ]);
  });
});

describe('matchLabel', () => {
  it('says which match of how many, or that there is none', () => {
    expect(matchLabel(2, 7)).toBe('2 of 7');
    expect(matchLabel(0, 0)).toBe('No matches');
    expect(NO_TEXT).toBe('No searchable text on this page');
  });
});

describe('paintHits', () => {
  const layer = (...strs: string[]) => {
    const divs = strs.map((s) => Object.assign(new FakeEl('span'), { textContent: s }));
    return { divs, strs, painted: new Set<number>() };
  };
  const shown = (div: FakeEl) => div.children.map((k) => (k.tag === '#text' ? k.textContent : `[${k.textContent}${k.classes.has('viewer-hit--current') ? '*' : ''}]`)).join('');

  it("marks each match's part of each span, the current one apart, and gives back the current mark", () => {
    const doc = new FakeDoc(new FakeEl('body'));
    const l = layer('The picnic is', 'on Saturday', 'untouched');
    const current = paintHits(doc, l, [
      { ranges: [{ item: 0, from: 4, to: 10 }], current: false },
      { ranges: [{ item: 0, from: 11, to: 13 }, { item: 1, from: 0, to: 2 }], current: true },
    ]);
    expect(shown(l.divs[0]!)).toBe('The [picnic] [is*]');
    expect(shown(l.divs[1]!)).toBe('[on*] Saturday');
    expect(l.divs[2]!.children).toEqual([]);
    expect(current?.textContent).toBe('is');
    expect([...l.painted]).toEqual([0, 1]);
    // Painting again first gives every painted span back its own text.
    expect(paintHits(doc, l, [])).toBeUndefined();
    expect(l.divs.map((d) => d.textContent)).toEqual(['The picnic is', 'on Saturday', 'untouched']);
    expect(l.divs[0]!.children).toEqual([]);
    expect(l.painted.size).toBe(0);
  });

  it('skips a range for a span pdf.js did not make (past its limit)', () => {
    const doc = new FakeDoc(new FakeEl('body'));
    const l = layer('one');
    expect(paintHits(doc, l, [{ ranges: [{ item: 3, from: 0, to: 1 }], current: true }])).toBeUndefined();
    expect(l.painted.size).toBe(0);
  });
});
