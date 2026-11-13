// EDITOR A3b: a piece's link list, its order, its hash and which links need a sign-in, without a
// database. The RPCs and the gate are exercised in test/workflow/link-gate.test.ts.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Entry, VenueRow } from '../events/service.js';
import { IN_TEXT, canonicalLinks, eventLinks, linksSha256, loginWalled, refusedMessage, textLinks, uncheckedMessage } from './item-links.js';
import { parseMarkup } from './markup.js';
import type { Tree } from './tree.js';

const venue = (name: string, url: string | null): VenueRow => ({
  id: 'v',
  kind: 'business',
  name,
  business_address: null,
  city: null,
  area: 'okaloosa',
  host_office_id: null,
  url,
  accessibility_note: null,
  active: true,
});
const entry = (title: string, fields: Partial<Entry> = {}): Entry => ({
  id: 'e',
  ownerOfficeId: '',
  localDate: '2026-11-05',
  series: undefined,
  title,
  startsAt: null,
  endsAt: null,
  venue: undefined,
  status: 'scheduled',
  statusNote: '',
  detail: '',
  url: '',
  visibility: 'public',
  ...fields,
});

describe('textLinks', () => {
  it('finds links and printed URLs in every kind of block, inside members passages and link words too', () => {
    const { tree, problems } = parseMarkup(
      [
        '# Plans at https://example.org/heading',
        '',
        '- a list item with [a link](https://example.org/list)',
        '- **bold https://example.org/bold**',
        '',
        '> quoted https://example.org/quote',
        '',
        '::: members',
        'Members only: https://example.org/members',
        ':::',
        '',
        'Words [see https://example.org/inner](https://example.org/outer) and :members[[hidden](https://example.org/span)].',
      ].join('\n'),
    );
    expect(problems).toEqual([]);
    expect(textLinks(tree).map((link) => [link.url, link.label])).toEqual([
      ['https://example.org/heading', ''],
      ['https://example.org/list', 'a link'],
      ['https://example.org/bold', ''],
      ['https://example.org/quote', ''],
      ['https://example.org/members', ''],
      ['https://example.org/outer', 'see https://example.org/inner'],
      ['https://example.org/inner', ''],
      ['https://example.org/span', 'hidden'],
    ]);
    expect(new Set(textLinks(tree).map((link) => link.where))).toEqual(new Set([IN_TEXT]));
  });

  it("takes a link's words from its text and members passages, a placeholder adding none", () => {
    const tree: Tree = {
      blocks: [
        {
          type: 'paragraph',
          children: [
            {
              type: 'link',
              href: 'https://example.org/words',
              children: [{ type: 'text', text: 'the  ', bold: false, italic: false }, { type: 'redacted' }, { type: 'members', children: [{ type: 'text', text: 'members page', bold: true, italic: false }] }],
            },
          ],
        },
      ],
    };
    expect(textLinks(tree)).toEqual([{ url: 'https://example.org/words', label: 'the members page', where: IN_TEXT }]);
  });

  it('reads nothing from an image or a placeholder', () => {
    const tree: Tree = {
      blocks: [{ type: 'image', fileId: '7a0d3d4e-1f1b-4c55-9a51-0b8f1c6a2e01', alt: 'https://example.org/alt' }, { type: 'redacted' }, { type: 'paragraph', children: [{ type: 'redacted' }] }],
    };
    expect(textLinks(tree)).toEqual([]);
  });
});

describe('eventLinks', () => {
  it("gives an event's own address, those in its detail and its venue's, and nothing for an event or venue without one", () => {
    expect(
      eventLinks([
        entry('Board games night', { url: 'https://www.facebook.com/events/1', detail: 'Map: https://maps.example.org/a, or https://maps.example.org/b.', venue: venue('Corner Cafe', 'https://cafe.example.org/') }),
        entry('Picnic', { venue: venue('Town Park', null) }),
        entry('Lunch'),
      ]),
    ).toEqual([
      { url: 'https://www.facebook.com/events/1', label: '', where: 'event: Board games night' },
      { url: 'https://maps.example.org/a', label: '', where: 'event: Board games night' },
      { url: 'https://maps.example.org/b', label: '', where: 'event: Board games night' },
      { url: 'https://cafe.example.org/', label: '', where: 'venue: Corner Cafe' },
    ]);
  });
});

describe('canonicalLinks and linksSha256', () => {
  it('keeps one row per url and where, the first words found, sorted by url then where (code units)', () => {
    const list = canonicalLinks([
      { url: 'https://example.org/b', label: '', where: IN_TEXT },
      { url: 'https://example.org/b', label: 'the b page', where: IN_TEXT },
      { url: 'https://example.org/b', label: 'another name', where: IN_TEXT },
      { url: 'https://example.org/b', label: '', where: 'event: Z' },
      { url: 'https://Example.org/a', label: '', where: IN_TEXT },
      { url: 'https://example.org/a', label: '', where: IN_TEXT },
    ]);
    expect(list).toEqual([
      { url: 'https://Example.org/a', label: '', where: IN_TEXT },
      { url: 'https://example.org/a', label: '', where: IN_TEXT },
      { url: 'https://example.org/b', label: '', where: 'event: Z' },
      { url: 'https://example.org/b', label: 'the b page', where: IN_TEXT },
    ]);
  });

  it('hashes the JSON array of [url, where] pairs: the words are not in it', () => {
    const list = [
      { url: 'https://example.org/a', label: 'A', where: IN_TEXT },
      { url: 'https://example.org/b', label: '', where: 'event: Z' },
    ];
    const expected = createHash('sha256').update('[["https://example.org/a","in the text"],["https://example.org/b","event: Z"]]').digest();
    expect(linksSha256(list)).toEqual(expected);
    expect(linksSha256(list.map((link) => ({ ...link, label: 'other' })))).toEqual(expected);
    expect(linksSha256([])).toEqual(createHash('sha256').update('[]').digest());
  });
});

describe('loginWalled', () => {
  it('is true for a site that needs a sign-in, whatever its case, sub-site or scheme', () => {
    for (const url of ['https://www.facebook.com/groups/x', 'https://FB.me/x', 'http://m.facebook.com/x', 'www.instagram.com/x', 'https://x.com/x', 'https://www.linkedin.com/in/x']) {
      expect(loginWalled(url), url).toBe(true);
    }
  });

  it('is false for any other site, an email address and an unreadable address', () => {
    for (const url of ['https://example.org/', 'https://notfacebook.com/', 'mailto:someone@example.org', 'https://facebook.com.example.org/', 'not a url', 'ftp://facebook.com/']) {
      expect(loginWalled(url), url).toBe(false);
    }
  });
});

describe('uncheckedMessage', () => {
  it('says how many links wait, in plain words', () => {
    expect(uncheckedMessage(1)).toBe('1 link needs a sign-in to check (such as Facebook): someone other than the writer must open it and answer yes before this is approved');
    expect(uncheckedMessage(3)).toBe('3 links need a sign-in to check (such as Facebook): someone other than the writer must open them and answer yes before this is approved');
  });
});

describe('refusedMessage', () => {
  it('names the link a reviewer answered no, shortened and with hidden characters shown, and counts the rest', () => {
    expect(refusedMessage(['https://example.org/a'])).toBe(
      'a reviewer answered no for the link "https://example.org/a" (it does not show the right page): the writer fixes it, or a reviewer changes the answer to yes, before this is approved',
    );
    expect(refusedMessage(['https://example.org/\u200bb', 'https://example.org/c'])).toMatch(/^a reviewer answered no for the link "https:\/\/example.org\/\?b" and 1 more \(/);
    expect(refusedMessage([`https://example.org/${'x'.repeat(100)}`])).toContain('xxx..."');
  });
});
