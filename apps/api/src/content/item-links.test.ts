// EDITOR A3b: a piece's link list, its order, its hash and which links need a sign-in, without a
// database. The RPCs and the gate are exercised in test/workflow/link-gate.test.ts.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Entry, VenueRow } from '../events/service.js';
import { type Answer, IN_TEXT, type Verdict, canonicalLinks, eventLinks, linkHold, linksSha256, loginWalled, neverFetched, refusedMessage, rfc3339Micros, textLinks, uncheckedMessage } from './item-links.js';
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

  it('hashes the JSON array [ready time, [url, where] pairs]: the words are not in it, the round is', () => {
    const list = [
      { url: 'https://example.org/a', label: 'A', where: IN_TEXT },
      { url: 'https://example.org/b', label: '', where: 'event: Z' },
    ];
    const at = '2026-10-22T15:00:00.123456Z';
    const expected = createHash('sha256').update('["2026-10-22T15:00:00.123456Z",[["https://example.org/a","in the text"],["https://example.org/b","event: Z"]]]').digest();
    expect(linksSha256(at, list)).toEqual(expected);
    expect(linksSha256(at, list.map((link) => ({ ...link, label: 'other' })))).toEqual(expected);
    expect(linksSha256('2026-10-22T15:00:00.123457Z', list)).not.toEqual(expected);
    expect(linksSha256(null, [])).toEqual(createHash('sha256').update('[null,[]]').digest());
  });
});

describe('rfc3339Micros', () => {
  it('writes microseconds since the epoch as RFC 3339 in UTC, to the microsecond', () => {
    expect(rfc3339Micros('1792681200123456')).toBe('2026-10-22T15:00:00.123456Z');
    expect(rfc3339Micros('1792681200000007')).toBe('2026-10-22T15:00:00.000007Z');
    expect(rfc3339Micros('0')).toBe('1970-01-01T00:00:00.000000Z');
    expect(rfc3339Micros('-1')).toBe('1969-12-31T23:59:59.999999Z');
    expect(rfc3339Micros(null)).toBeNull();
  });
});

describe('loginWalled', () => {
  it('is true for a site that needs a sign-in, whatever its case, sub-site or scheme', () => {
    for (const url of ['https://www.facebook.com/groups/x', 'https://FB.me/x', 'http://m.facebook.com/x', 'www.instagram.com/x', 'https://x.com/x', 'https://www.linkedin.com/in/x']) {
      expect(loginWalled(url), url).toBe(true);
    }
  });

  it('is false for any other site and an email address', () => {
    for (const url of ['https://example.org/', 'https://notfacebook.com/', 'mailto:someone@example.org', 'https://facebook.com.example.org/', 'https://example.org:443/', 'http://example.org:80/']) {
      expect(loginWalled(url), url).toBe(false);
    }
  });
});

// The no-fetch host, named once: an address with userinfo on it is put together from this, so no text here reads as a person's email address (scripts/made-up-people.mjs).
const NO_FETCH_HOST = 'us.mensa.org';

// Fix round 2 (R1-N4): an address whose host cannot be read is never taken for one the checker's OK counts on.
const UNREADABLE = [
  ['userinfo', `https://user@${NO_FETCH_HOST}/x`],
  ['userinfo and a password', `https://user:secret@${NO_FETCH_HOST}/x`],
  ['userinfo on any other host', 'https://user@example.org/x'],
  ['a port', 'https://us.mensa.org:8443/x'],
  ['a port on any other host', 'https://club.example.org:8443/x'],
  ['no host', 'https://'],
  ['a host that is no host', 'https://exa mple.org/x'],
  ['words', 'not a url'],
  ['another scheme', 'ftp://us.mensa.org/x'],
  ['nothing', ''],
  ['a control character', 'https://us.mensa.org/\u0007x'],
  ['a zero-width space in the host', 'https://us.mensa\u200b.org/x'],
  ['more than 2048 characters', `https://club.example.org/${'x'.repeat(2048)}`],
  ['a mail address with no domain', 'mailto:someone'],
] as const;

describe('loginWalled and neverFetched fail closed', () => {
  it.each(UNREADABLE)('are both true for an address with %s', (_label, url) => {
    expect(neverFetched(url)).toBe(true);
    expect(loginWalled(url)).toBe(true);
  });

  it.each(UNREADABLE)('linkHold holds an address with %s on a fresh OK; a yes still accepts it', (_label, url) => {
    const ok: Verdict = { verdict: 'ok', reasons: [], at: new Date(), fresh: true, id: 1n };
    expect(linkHold(url, undefined, ok)).toBe('walled');
    expect(linkHold(url, { answer: 'yes', label: 'Treasurer', note: null, id: 2n } satisfies Answer, ok)).toBeUndefined();
  });
});

describe('neverFetched', () => {
  it('is true for a host on the no-fetch list, however it is written, with a default port, or as a mail domain', () => {
    for (const url of ['https://us.mensa.org/x', 'https://US.MENSA.ORG/x', 'https://us.mensa.org./x', 'https://www.us.mensa.org/x', 'https://us.mensa.org:443/x', 'http://us.mensa.org:80/x', `mailto:someone@${NO_FETCH_HOST}`, 'https://vndb.org/v1']) {
      expect(neverFetched(url), url).toBe(true);
      expect(linkHold(url, undefined, { verdict: 'ok', reasons: [], at: new Date(), fresh: true, id: 1n }), url).toBe('unchecked');
    }
  });

  // The re-challenge's host list (round 1): every way of writing a no-fetch host. Written as escapes.
  it.each([
    'https://US.MENSA.ORG/x',
    'https://us.mensa.org./x',
    'https://us.mensa.org../x',
    'https://www.us.mensa.org/x',
    'https://us.mensa.org:443/x',
    'https://us.mensa.org:80/x',
    `https://user@${NO_FETCH_HOST}/x`,
    'https://\uff55\uff53.\uff4d\uff45\uff4e\uff53\uff41.\uff4f\uff52\uff47/x',
    'https://us\u3002mensa\u3002org/x',
    'https://us.mensa.org%2E/x',
    'https://us%2Emensa.org/x',
    `mailto:x@${NO_FETCH_HOST}`,
    `mailto:x@${NO_FETCH_HOST.toUpperCase()}.`,
    'https://myfigurecollection.net/x',
    'https://MYFIGURECOLLECTION.co.uk./x',
    'https://www.vndb.org/v1',
    'http://us.mensa.org/x',
    'HTTPS://us.mensa.org/x',
    'https://us.mensa.org\\x',
    'https://us.mensa.org?x',
    'https://us.mensa.org#x',
    'https://us.mensa.org\u00ad/x',
  ])('a fresh OK on %s is never accepted', (url) => {
    expect(neverFetched(url)).toBe(true);
    expect(linkHold(url, undefined, { verdict: 'ok', reasons: [], at: new Date(), fresh: true, id: 1n })).toBeDefined();
  });

  it('takes a look-alike host for what it is, another host: the checker fetches that one', () => {
    // A Cyrillic a in "mensa".
    expect(neverFetched('https://us.mens\u0430.org/x')).toBe(false);
  });

  it('is false for a host the checker fetches, with a default port too: a fresh OK there counts', () => {
    for (const url of ['https://club.example.org/', 'https://club.example.org:443/', 'http://club.example.org:80/', 'mailto:someone@example.org', 'https://us.mensa.org.example.org/']) {
      expect(neverFetched(url), url).toBe(false);
      expect(linkHold(url, undefined, { verdict: 'ok', reasons: [], at: new Date(), fresh: true, id: 1n }), url).toBeUndefined();
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
