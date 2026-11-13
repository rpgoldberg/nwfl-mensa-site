// EDITOR E3: the writer screens' own rules (S1-S5): which offices a person may write as, how long the
// text is in words and newsletter pages, how long the sign-in lasts, and the office's events beside a
// President's report.
import { describe, expect, it } from 'vitest';
import type { EditorItem } from '../api/editor';
import {
  EDIT_LINKS,
  ROSTER_WARNING,
  WORDS_PER_PAGE,
  draftKey,
  clockText,
  keptText,
  lastChangeText,
  lengthText,
  mayHoldAnOffice,
  mayWriteFor,
  newsletterPages,
  officeName,
  ourNews,
  postingOffices,
  signInLine,
  submitTargets,
  wordCount,
} from './writer';

const ROSTER = [
  { id: '11111111-1111-4111-8111-111111111111', slug: 'president', title: 'President' },
  { id: '22222222-2222-4222-8222-222222222222', slug: 'social', title: 'Social Chair' },
  { id: '33333333-3333-4333-8333-333333333333', slug: 'treasurer', title: 'Treasurer' },
];
const [PRESIDENT, SOCIAL, TREASURER] = ROSTER as [(typeof ROSTER)[0], (typeof ROSTER)[0], (typeof ROSTER)[0]];

const item = (officeId: string): EditorItem => ({ id: 'c0000000-0000-4000-8000-000000000001', slug: 's', kind: 'announcement', officeId, state: 'draft' });

describe('postingOffices', () => {
  it('gives an officer the offices they hold, in roster order, as held', () => {
    expect(postingOffices(['nwfl-officers', 'nwfl-office-social', 'nwfl-office-president'], ROSTER)).toEqual([
      { ...PRESIDENT, held: true },
      { ...SOCIAL, held: true },
    ]);
  });

  it('gives the Admin every office; the ones they do not hold are for the office', () => {
    expect(postingOffices(['nwfl-admin', 'nwfl-office-treasurer'], ROSTER)).toEqual([
      { ...PRESIDENT, held: false },
      { ...SOCIAL, held: false },
      { ...TREASURER, held: true },
    ]);
  });

  it('gives none to an officer with no seat, the Webmaster, a member, or a group for an office not on the roster', () => {
    expect(postingOffices(['nwfl-officers'], ROSTER)).toEqual([]);
    expect(postingOffices(['nwfl-webmaster', 'nwfl-officers'], ROSTER)).toEqual([]);
    expect(postingOffices(['nwfl-members'], ROSTER)).toEqual([]);
    expect(postingOffices(['nwfl-officers', 'nwfl-office-publications'], ROSTER)).toEqual([]);
    // A near miss is no office.
    expect(postingOffices(['nwfl-office-president-x', 'xnwfl-office-president'], ROSTER)).toEqual([]);
  });
});

describe('officeName', () => {
  it('names an office, and says when the Admin writes for it', () => {
    expect(officeName({ ...PRESIDENT, held: true })).toBe('President');
    expect(officeName({ ...PRESIDENT, held: false })).toBe('President (for the office)');
  });
});

describe('mayHoldAnOffice', () => {
  it('is true for an office holder or the Admin, false for the Webmaster or a member alone', () => {
    expect(mayHoldAnOffice(['nwfl-members', 'nwfl-officers', 'nwfl-office-president'])).toBe(true);
    expect(mayHoldAnOffice(['nwfl-admin'])).toBe(true);
    expect(mayHoldAnOffice(['nwfl-members', 'nwfl-webmaster'])).toBe(false);
    expect(mayHoldAnOffice(['nwfl-members', 'nwfl-officers'])).toBe(false);
    expect(mayHoldAnOffice([])).toBe(false);
  });
});

describe('mayWriteFor', () => {
  it("lets the office's holders and the Admin write an item, and nobody else", () => {
    const officer = postingOffices(['nwfl-officers', 'nwfl-office-president'], ROSTER);
    expect(mayWriteFor(officer, item(PRESIDENT.id))).toBe(true);
    expect(mayWriteFor(officer, item(SOCIAL.id))).toBe(false);
    expect(mayWriteFor(postingOffices(['nwfl-admin'], ROSTER), item(SOCIAL.id))).toBe(true);
    expect(mayWriteFor([], item(PRESIDENT.id))).toBe(false);
    // An office the roster does not list: nobody but the API knows it; the Admin's list has it not.
    expect(mayWriteFor(postingOffices(['nwfl-admin'], ROSTER), item('44444444-4444-4444-8444-444444444444'))).toBe(false);
  });
});

describe('wordCount and newsletterPages', () => {
  it('counts the words a reader reads, not the marks around them', () => {
    expect(wordCount('')).toBe(0);
    expect(wordCount('   \n\n  ')).toBe(0);
    expect(wordCount('# Our year\n\n**Thank you** all, for *everything*.')).toBe(7);
    expect(wordCount('- one\n- two\n1. three\n> four')).toBe(4);
    expect(wordCount('See [the picnic page](https://club.example/picnic) now.')).toBe(5);
    expect(wordCount(':members[The gate code] is shut.\n::: members\nInside.\n:::')).toBe(6);
    // Punctuation alone is no word; a number is.
    expect(wordCount('-- * — 2026 !')).toBe(1);
  });

  it(`reckons about ${WORDS_PER_PAGE} words to a page, rounding up, and none for no words`, () => {
    expect(newsletterPages(0)).toBe(0);
    expect(newsletterPages(1)).toBe(1);
    expect(newsletterPages(WORDS_PER_PAGE)).toBe(1);
    expect(newsletterPages(WORDS_PER_PAGE + 1)).toBe(2);
    expect(newsletterPages(7000)).toBe(14);
  });

  it('says the length in words', () => {
    expect(lengthText('')).toBe('No words yet.');
    expect(lengthText('Hello')).toBe('1 word, about 1 newsletter page.');
    expect(lengthText('one two three')).toBe('3 words, about 1 newsletter page.');
    expect(lengthText(Array.from({ length: 1234 }, () => 'word').join(' '))).toBe('1,234 words, about 3 newsletter pages.');
  });
});

describe('signInLine', () => {
  // 20:05 UTC on November 17, 2026 is 2:05 pm Central (CST).
  const EXPIRES = Date.parse('2026-11-17T20:05:00Z') / 1000;

  it('says until when the sign-in lasts, in Central time, while more than five minutes remain', () => {
    expect(signInLine(EXPIRES, EXPIRES - 55 * 60)).toEqual({
      text: 'Your sign-in lasts until 2:05 pm Central time. Save before then.',
      soon: false,
      expiresAt: EXPIRES,
      soonText: 'Your sign-in ends at 2:05 pm Central time. Save now.',
    });
    expect(signInLine(EXPIRES, EXPIRES - 5 * 60 - 1)?.soon).toBe(false);
  });

  it('says "Save now" for the last five minutes', () => {
    expect(signInLine(EXPIRES, EXPIRES - 5 * 60)).toMatchObject({ text: 'Your sign-in ends at 2:05 pm Central time. Save now.', soon: true, expiresAt: EXPIRES });
    expect(signInLine(EXPIRES, EXPIRES - 1)?.soon).toBe(true);
  });

  it('says nothing without a token expiry, or once it has passed', () => {
    expect(signInLine(undefined, EXPIRES)).toBeUndefined();
    expect(signInLine(Number.NaN, EXPIRES)).toBeUndefined();
    expect(signInLine(EXPIRES, EXPIRES)).toBeUndefined();
  });

  it('reads the clock by Central summer time too', () => {
    // 17:30 UTC on July 1 is 12:30 pm Central (CDT).
    const july = Date.parse('2026-07-01T17:30:00Z') / 1000;
    expect(signInLine(july, july - 3600)?.text).toBe('Your sign-in lasts until 12:30 pm Central time. Save before then.');
  });
});

describe('submitTargets', () => {
  it('offers the newsletter for an item everyone or members can read, never for an officers-only one', () => {
    expect(submitTargets('public')).toEqual({ newsletter: true });
    expect(submitTargets('members')).toEqual({ newsletter: true });
    expect(submitTargets('officers')).toEqual({ newsletter: false });
  });
});

describe('the fixed words', () => {
  it('warns against pasting any list from the roster (R13)', () => {
    expect(ROSTER_WARNING).toBe("Never paste birthday, new-member or Mensaversary lists, or anything from Mensa's roster.");
  });

  it("keys the tab's unsent copy by item", () => {
    expect(draftKey('c0000000-0000-4000-8000-000000000001')).toBe('nwfl-draft:c0000000-0000-4000-8000-000000000001');
  });

  it('links each item to its edit and preview pages', () => {
    expect(EDIT_LINKS.edit('abc')).toBe('/officer-area/news/abc');
    expect(EDIT_LINKS.preview('abc')).toBe('/officer-area/news/abc/preview');
    expect(EDIT_LINKS.list).toBe('/officer-area/news');
    expect(EDIT_LINKS.create).toBe('/officer-area/news/new');
  });
});

describe('keptText', () => {
  const post = (body: BodyInit, type?: string) => new Request('https://site.example/officer-area/news/x', { method: 'POST', body, ...(type ? { headers: { 'content-type': type } } : {}) });

  it('gives back what was posted, as typed, line breaks as the page shows them', async () => {
    const form = new FormData();
    form.set('title', '  My report ');
    form.set('summary', 'One line');
    form.set('visibility', 'members');
    form.set('markup', 'Line one\r\nLine <b>two</b>');
    expect(await keptText(post(form))).toEqual({ ok: true, values: { title: '  My report ', summary: 'One line', visibility: 'members', markup: 'Line one\nLine <b>two</b>' }, base: '' });
  });

  it('gives empty fields for what was not posted', async () => {
    expect(await keptText(post(new URLSearchParams({ markup: 'Only text' }), 'application/x-www-form-urlencoded'))).toEqual({ ok: true, values: { title: '', summary: '', visibility: '', markup: 'Only text' }, base: '' });
  });

  it("refuses what is not a form, or is over the edit form's cap", async () => {
    expect(await keptText(post('{}', 'application/json'))).toEqual({ ok: false, status: 415 });
    expect(await keptText(post(new URLSearchParams({ markup: 'a'.repeat(57 * 1024) }).toString(), 'application/x-www-form-urlencoded'))).toEqual({ ok: false, status: 413 });
  });
});

describe('lastChangeText (fix 1)', () => {
  it('says when, in Central time: the weekday, the day, the month and the clock', () => {
    // 20:05 UTC on Thursday November 12, 2026 is 2:05 pm Central (CST).
    expect(lastChangeText(new Date('2026-11-12T20:05:00Z'))).toBe('Thu 12 Nov, 2:05 pm');
    // 03:30 UTC on Friday is still Thursday evening in Central.
    expect(lastChangeText(new Date('2026-11-13T03:30:00Z'))).toBe('Thu 12 Nov, 9:30 pm');
    // Summer time: 17:00 UTC on July 1 is noon Central (CDT).
    expect(lastChangeText(new Date('2026-07-01T17:00:00Z'))).toBe('Wed 1 Jul, 12:00 noon');
    expect(lastChangeText(new Date('2026-01-05T06:07:00Z'))).toBe('Mon 5 Jan, 12:07 am');
  });

  it('says nothing is known without a time', () => {
    expect(lastChangeText(undefined)).toBe('Not known');
  });
});

describe('ourNews (fix 1)', () => {
  const at = (iso: string) => new Date(iso);
  const one = (id: string, lastChangedAt?: Date): EditorItem => ({ ...item(PRESIDENT.id), id, ...(lastChangedAt ? { lastChangedAt } : {}) });

  it('puts the items being written and the published ones in one list, each once, newest change first', () => {
    const writing = [one('a', at('2026-11-12T10:00:00Z')), one('b', at('2026-11-12T12:00:00Z'))];
    const published = [one('b', at('2026-11-12T12:00:00Z')), one('c', at('2026-11-12T11:00:00Z')), one('d')];
    expect(ourNews(writing, published).map((i) => i.id)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('keeps the order given for items with the same time or none', () => {
    expect(ourNews([one('x'), one('y')], [one('z')]).map((i) => i.id)).toEqual(['x', 'y', 'z']);
  });
});

describe('clockText (round 2)', () => {
  it('says the time of day in Central, as the site says it', () => {
    expect(clockText(new Date('2026-11-12T20:05:00Z'))).toBe('2:05 pm');
    expect(clockText(new Date('2026-07-01T17:00:00Z'))).toBe('12:00 noon');
  });
});

describe('keptText keeps the base the form was opened from (round 2)', () => {
  it('reads it from the post, or none', async () => {
    const post = (body: string) => new Request('https://example.org/x', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    expect(await keptText(post('title=T&summary=&visibility=public&markup=x&base=12.000000500'))).toMatchObject({ ok: true, base: '12.000000500' });
    expect(await keptText(post('title=T&markup=x'))).toMatchObject({ ok: true, base: '' });
  });
});
