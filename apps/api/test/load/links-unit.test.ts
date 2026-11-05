// LINKS L2, the approved links' input rules, with no database: the links list both loaders read
// (src/load/links.ts), its hash, the issue bundle nwfl-issue/2 and the links bundle nwfl-links/1.
// Every URL here is under a reserved example name; every person is made up.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LINKS_FORMAT, MAX_LINKS_BUNDLE_BYTES, parseLinksBundle, runAttach } from '../../src/load/attach.js';
import { canonicalJson } from '../../src/content/hash.js';
import { LoadError, parseBundle } from '../../src/load/load.js';
import { type IssueLinks, type Link, MAX_FORMS, MAX_LINKS_PER_FILE, decodedForms, hostOf, linksSha256, parseLinks, refuseWithheldTargets, targetHolds } from '../../src/load/links.js';
import { ADDRESS, EMAIL, LINKS, NAME, PHONE, bundleJson, linkId, linksBundleJson, linksJson, mailLink, sha256, stdinOf, webLink } from './bundle.js';

const NO_DB = { DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none' };
const PRODUCTION = { ...NO_DB, NODE_ENV: 'production' };
const HASH = 'a'.repeat(64);
/** The two files' sha256, as a links bundle names them. */
const FILES = { public: 'b'.repeat(64), members: 'c'.repeat(64) };

/** A copy of a JSON value with one path set (or deleted with undefined). */
function withPath(json: Record<string, unknown>, path: Array<string | number>, value: unknown): Record<string, unknown> {
  const copy = structuredClone(json);
  let at: Record<string | number, unknown> = copy;
  for (const key of path.slice(0, -1)) at = at[key] as Record<string | number, unknown>;
  const last = path[path.length - 1] as string | number;
  if (value === undefined) delete at[last];
  else at[last] = value;
  return copy;
}

/** One public link, as JSON, with a field set. */
const oneLink = (field: string, value: unknown): Record<string, unknown> => withPath(linksJson({ public: [webLink(1)], members: [] }), ['public', 0, field], value);

describe('parseLinks', () => {
  it('reads the links of both files, each with its id, page, rect, url, kind and confirm flag', () => {
    expect(parseLinks(linksJson(LINKS))).toEqual(LINKS);
  });

  it('accepts a file with no links, and reads an empty list for it', () => {
    expect(parseLinks({ public: [], members: [mailLink(1)] })).toEqual({ public: [], members: [mailLink(1)] });
  });

  it.each([
    ['not an object', [], /links must be a JSON object/],
    ['an unknown field', { ...linksJson(LINKS), officers: [] }, /links: unknown field officers/],
    ['a __proto__ field', { ...linksJson(LINKS), ...(JSON.parse('{"__proto__": []}') as object) }, /links: unknown field __proto__/],
    ['no public list', { members: [] }, /links\.public must be a list/],
    ['a members object', { public: [], members: {} }, /links\.members must be a list/],
    ['a link that is not an object', { public: ['https://example.org/'], members: [] }, /links\.public\[0\] must be a JSON object/],
    ['an unknown link field', oneLink('title', 'Game night'), /links\.public\[0\]: unknown field title/],
    ['a link with its host given', oneLink('host', 'example.org'), /links\.public\[0\]: unknown field host/],
  ])('refuses %s', (_label, value, message) => {
    expect(() => parseLinks(value)).toThrow(LoadError);
    expect(() => parseLinks(value)).toThrow(message);
  });

  it(`refuses more than ${MAX_LINKS_PER_FILE} links on a file`, () => {
    const many = Array.from({ length: MAX_LINKS_PER_FILE + 1 }, (_v, n) => webLink(n + 1));
    expect(() => parseLinks(linksJson({ public: many, members: [] }))).toThrow(/at most 500 links/);
    expect(parseLinks(linksJson({ public: many.slice(1), members: [] })).public).toHaveLength(MAX_LINKS_PER_FILE);
  });

  describe('the id', () => {
    it.each([
      ['too short', 'a'.repeat(25)],
      ['too long', 'a'.repeat(27)],
      ['upper case', 'A'.repeat(26)],
      ['a digit outside base32 (0, 1, 8, 9)', `${'a'.repeat(25)}1`],
      ['not a string', 7],
      ['a path', `../${'a'.repeat(23)}`],
    ])('refuses an id %s', (_label, id) => {
      expect(() => parseLinks(oneLink('id', id))).toThrow(/links\.public\[0\]\.id must be 26 lower-case base32 characters/);
    });

    it('refuses the same id twice, on one file or across both', () => {
      expect(() => parseLinks(linksJson({ public: [webLink(1), { ...webLink(2), id: linkId(1) }], members: [] }))).toThrow(/links\.public\[1\]: the id is used twice/);
      expect(() => parseLinks(linksJson({ public: [webLink(1)], members: [{ ...mailLink(2), id: linkId(1) }] }))).toThrow(/links\.members\[0\]: the id is used twice/);
    });
  });

  describe('the page and the rect', () => {
    it.each([0, 10_001, 1.5, '1', null])('refuses page %s', (page) => {
      expect(() => parseLinks(oneLink('page', page))).toThrow(/links\.public\[0\]\.page must be a whole number from 1 to 10000/);
    });

    it('accepts the first and the last page', () => {
      expect(parseLinks(oneLink('page', 1)).public[0]?.page).toBe(1);
      expect(parseLinks(oneLink('page', 10_000)).public[0]?.page).toBe(10_000);
    });

    it.each([
      ['not a list', { x: 1 }],
      ['three numbers', [1, 2, 3]],
      ['five numbers', [1, 2, 3, 4, 5]],
      ['a string', ['72', 700, 300, 714]],
      ['infinity', [72, 700, Infinity, 714]],
      ['NaN', [72, Number.NaN, 300, 714]],
      ['a number past the largest page (14400)', [72, 700, 14_401, 714]],
      ['a number below minus 14400', [-14_401, 700, 300, 714]],
      ['a left edge right of its right edge', [300, 700, 72, 714]],
      ['a zero width', [72, 700, 72, 714]],
      ['a bottom above its top', [72, 714, 300, 700]],
      ['narrower than a hundredth of a point once rounded (LINKS L3 fix 1, N4)', [100.001, 700, 100.004, 710]],
      ['shorter than a hundredth of a point once rounded', [72, 700.001, 300, 700.004]],
      ['a hundredth wide that rounds to nothing', [100.005, 700, 100.0149, 710]],
    ])('refuses a rect that is %s', (_label, rect) => {
      expect(() => parseLinks(oneLink('rect', rect))).toThrow(/links\.public\[0\]\.rect must be \[x1, y1, x2, y2\]/);
    });

    it('accepts a rect a hundredth of a point wide and high once rounded', () => {
      expect(parseLinks(oneLink('rect', [100.004, 700, 100.014, 700.01])).public[0]?.rect).toEqual([100.004, 700, 100.014, 700.01]);
    });

    it('accepts fractional and negative coordinates inside the bounds', () => {
      expect(parseLinks(oneLink('rect', [-14_400, -0.25, 14_400, 0.5])).public[0]?.rect).toEqual([-14_400, -0.25, 14_400, 0.5]);
    });
  });

  describe('the url and kind', () => {
    it.each([
      ['plain http (the checker upgrades it, or it is dropped)', 'http://example.org/'],
      ['no URL at all', 'https://[nope/'],
      ['javascript:', 'javascript:alert(1)'],
      ['data:', 'data:text/html,hi'],
      ['ftp', 'ftp://example.org/'],
      ['a space', 'https://example.org/a b'],
      ['a tab', 'https://example.org/a\tb'],
      ['a control character', 'https://example.org/\u0007'],
      ['a right-to-left override', 'https://example.org/‮gro'],
      ['a non-ASCII host (it must arrive in punycode)', 'https://bücher.example/'],
      ['an upper-case host (not the canonical form)', 'https://EXAMPLE.org/'],
      ['no path (not the canonical form)', 'https://example.org'],
      ['a backslash', 'https://example.org\\@evil.example/'],
      ['credentials', 'https://user:pw@example.org/'],
      ['a user only', 'https://user@example.org/'],
      ['a port', 'https://example.org:8443/'],
      ['an IPv6 literal', 'https://[2001:db8::1]/'],
      ['an IPv4 literal', 'https://127.0.0.1/'],
      ['a private IPv4 literal', 'https://10.0.0.1/admin'],
      ['an IPv4 literal in decimal', 'https://2130706433/'],
      ['an IPv4 literal in hex', 'https://0x7f.0.0.1/'],
      ['a dotless host', 'https://localhost/'],
      ['a one-label host', 'https://intranet/'],
      ['a trailing dot', 'https://example.org./'],
      ['two trailing dots', 'https://example.org../'],
      ['an empty label', 'https://example..org/'],
      ['a leading dot', 'https://.example.org/'],
      ['a numeric last label', 'https://example.123/'],
      ['an explicit :443', 'https://example.org:443/'],
      ['an explicit :80', 'https://example.org:80/'],
      ['a mailto', 'mailto:games@example.org'],
      ['too long', `https://example.org/${'a'.repeat(2048 - 20 + 1)}`],
      ['not a string', 42],
    ])('refuses a web link with %s', (_label, url) => {
      expect(() => parseLinks(oneLink('url', url))).toThrow(/links\.public\[0\]\.url/);
    });

    it('accepts a canonical https URL of up to 2048 characters, with its query and fragment', () => {
      const long = `https://example.org/${'a'.repeat(2048 - 20)}`;
      expect(long).toHaveLength(2048);
      expect(parseLinks(oneLink('url', long)).public[0]?.url).toBe(long);
      expect(parseLinks(oneLink('url', 'https://example.org/p?q=1&r=2#top')).public[0]?.url).toBe('https://example.org/p?q=1&r=2#top');
      expect(parseLinks(oneLink('url', 'https://xn--bcher-kva.example/')).public[0]?.url).toBe('https://xn--bcher-kva.example/');
      expect(parseLinks(oneLink('url', 'https://a-1.b2.example.org/')).public[0]?.url).toBe('https://a-1.b2.example.org/');
    });

    it('accepts a mailto of one address, its local part as written and its domain in lower-case punycode', () => {
      // An IDN domain in punycode is the shared fixture's (mailto:club~@xn--bcher-kva.example): made-up-people allows only example.com, .org and .net addresses.
      for (const url of ['mailto:games@example.org', 'mailto:Games.Night@example.org', 'mailto:club~@xn--bcher-kva.example', 'mailto:first.last+news@example.com']) {
        const json = withPath(linksJson({ public: [mailLink(1)], members: [] }), ['public', 0, 'url'], url);
        expect(parseLinks(json).public[0]?.url).toBe(url);
      }
    });

    it.each([
      ['an https URL', 'https://example.org/'],
      ['a query', 'mailto:games@example.org?subject=hi'],
      ['a subject', 'mailto:games@example.org?subject=Game%20night'],
      ['a cc', 'mailto:games@example.org?cc=host@example.org'],
      ['a fragment', 'mailto:games@example.org#x'],
      ['an upper-case domain (not the canonical form)', 'mailto:games@Example.ORG'],
      ['an upper-case scheme', 'MAILTO:games@example.org'],
      ['a percent-encoded IDN domain (it must arrive in punycode)', 'mailto:games@b%C3%BCcher.example'],
      ['an IPv4 domain', 'mailto:games@127.0.0.1'],
      ['an IP domain literal', 'mailto:games@[127.0.0.1]'],
      ['a trailing dot', 'mailto:games@example.org.'],
      ['an empty label', 'mailto:games@example..org'],
      ['a numeric last label', 'mailto:games@example.123'],
      ['no address', 'mailto:'],
      ['no domain', 'mailto:games@'],
      ['two at signs', 'mailto:games@club@example.org'],
      ['a one-label domain', 'mailto:games@localhost'],
      ['a space', 'mailto:games @example.org'],
      ['a non-ASCII address', 'mailto:spiele@bücher.example'],
      // A local part never starts with '/', which a URL parser reads as a path or an authority (round 3, CONTRACT item 10).
      ['a local part starting with /', 'mailto:/x@example.org'],
      ['an authority', 'mailto://x@example.org'],
      ['a dot segment', 'mailto:/./x@example.org'],
      ['a dot-dot segment', 'mailto:/a/../b@example.org'],
    ])('refuses a mail link with %s', (_label, url) => {
      const json = withPath(linksJson({ public: [mailLink(1)], members: [] }), ['public', 0, 'url'], url);
      expect(() => parseLinks(json)).toThrow(/links\.public\[0\]\.url/);
    });

    it.each(['link', 'tel', 'Web', null])('refuses kind %s', (kind) => {
      expect(() => parseLinks(oneLink('kind', kind))).toThrow(/links\.public\[0\]\.kind must be web or mail/);
    });

    it.each([1, 'true', null])('refuses a confirm flag of %s', (confirm) => {
      expect(() => parseLinks(oneLink('confirm', confirm))).toThrow(/links\.public\[0\]\.confirm must be true or false/);
    });
  });
});

describe('hostOf', () => {
  it("is a web link's host, in ASCII, and a mail link's domain, in lower case", () => {
    expect(hostOf(webLink(1, 'https://xn--bcher-kva.example/p'))).toBe('xn--bcher-kva.example');
    expect(hostOf(webLink(1, 'https://www.example.org/p?q=1'))).toBe('www.example.org');
    expect(hostOf(mailLink(1, 'mailto:Games@example.org'))).toBe('example.org');
  });
});

describe('linksSha256', () => {
  /** The canonical form, pinned (CONTRACT item 4): L1's checker computes the same hash over the same JSON. */
  const pinned = (files: { public: string; members: string }, links: IssueLinks): string => {
    const sorted = (list: readonly Link[]) =>
      [...list].sort((a, b) => (a.id < b.id ? -1 : 1)).map((link) => ({ confirm: link.confirm, id: link.id, kind: link.kind, page: link.page, rect: [...link.rect], url: link.url }));
    return createHash('sha256')
      .update(canonicalJson({ v: 2, sha256: { public: files.public, members: files.members }, links: { members: sorted(links.members), public: sorted(links.public) } }))
      .digest('hex');
  };

  it("is SHA-256 of the canonical JSON of v 2, both files' sha256 and both lists, each sorted by id", () => {
    expect(linksSha256(FILES, LINKS)).toBe(pinned(FILES, LINKS));
    expect(linksSha256(FILES, LINKS)).toMatch(/^[0-9a-f]{64}$/);
    expect(linksSha256(FILES, { public: [webLink(1)], members: [] })).toBe(
      createHash('sha256')
        .update(
          `{"links":{"members":[],"public":[{"confirm":false,"id":"${linkId(1)}","kind":"web","page":1,"rect":[72,680,300,694],"url":"https://example.org/games/1"}]},"sha256":{"members":"${FILES.members}","public":"${FILES.public}"},"v":2}`,
        )
        .digest('hex'),
    );
  });

  it("reproduces L1's pinned test vector (apps/linkcheck test/list.test.ts), byte for byte", () => {
    const link = (over: Partial<Link>): Link => ({ id: 'aaaaaaaaaaaaaaaaaaaaaaaaaa', page: 1, rect: [72, 700.5, 200.25, 714], url: 'https://example.org/a', kind: 'web', confirm: false, ...over });
    const a = link({ id: 'bbbbbbbbbbbbbbbbbbbbbbbbbb' });
    const b = link({ page: 2, kind: 'mail', url: 'mailto:editor@example.org' });
    const c = link({ id: 'cccccccccccccccccccccccccc', url: 'https://www.facebook.com/groups/example', confirm: true });
    expect(linksSha256({ public: '1'.repeat(64), members: '2'.repeat(64) }, { public: [a, b], members: [c] })).toBe('59ac3705ac3b1d00c13c0865375092a973f4c636929b08fb7371439b1fe70375');
  });

  it('does not depend on the order of the links in a list', () => {
    expect(linksSha256(FILES, { public: [...LINKS.public].reverse(), members: [...LINKS.members].reverse() })).toBe(linksSha256(FILES, LINKS));
  });

  it('changes with every field of a link, with the file a link is on, and with either file\'s sha256', () => {
    const base = linksSha256(FILES, LINKS);
    const first = LINKS.public[0] as Link;
    const variants: Link[] = [
      { ...first, id: linkId(99) },
      { ...first, page: 2 },
      { ...first, rect: [72, 680, 300, 694.01] },
      { ...first, url: 'https://example.org/games/2' },
      { ...first, kind: 'mail' },
      { ...first, confirm: true },
    ];
    for (const variant of variants) expect(linksSha256(FILES, { ...LINKS, public: [variant, ...LINKS.public.slice(1)] })).not.toBe(base);
    expect(linksSha256(FILES, { public: LINKS.public.slice(1), members: [first, ...LINKS.members] })).not.toBe(base);
    // Links approved for one issue's files are not approved for another's (CONTRACT item 4).
    expect(linksSha256({ ...FILES, public: 'd'.repeat(64) }, LINKS)).not.toBe(base);
    expect(linksSha256({ ...FILES, members: 'd'.repeat(64) }, LINKS)).not.toBe(base);
    expect(linksSha256({ public: FILES.members, members: FILES.public }, LINKS)).not.toBe(base);
  });
});

describe('the shared links contract (CONTRACT.md, the same fixture in apps/linkcheck)', () => {
  const FIXTURE = new URL('./fixtures/links-contract.json', import.meta.url);
  /** The fixture both parts commit, byte for byte: L1's suite pins the same sha256. */
  const CONTRACT_SHA256 = '744f1e310b4a1dd2133d121bede97fd62f1c60111d8966db8b1fe4e8741fb045';
  const bytes = (): Buffer => readFileSync(FIXTURE);
  const cases = (): Array<{ in: string; out: string | null }> => JSON.parse(bytes().toString('utf8')) as Array<{ in: string; out: string | null }>;

  it('is the agreed fixture, byte for byte', () => {
    expect(createHash('sha256').update(bytes()).digest('hex')).toBe(CONTRACT_SHA256);
    const list = cases();
    expect(`${JSON.stringify([...list].sort((a, b) => (a.in < b.in ? -1 : a.in > b.in ? 1 : 0)), null, 2)}\n`).toBe(bytes().toString('utf8'));
    expect(list.length).toBeGreaterThan(20);
  });

  /** Whether the loader keeps this url as a link of this kind. */
  const keeps = (url: string, kind: 'web' | 'mail'): boolean => {
    const link = kind === 'web' ? webLink(1, url) : mailLink(1, url);
    try {
      return parseLinks(linksJson({ public: [link], members: [] })).public[0]?.url === url;
    } catch (error) {
      expect(error).toBeInstanceOf(LoadError);
      return false;
    }
  };
  const kindOf = (url: string): 'web' | 'mail' => (url.startsWith('mailto:') ? 'mail' : 'web');

  it('runs every case through the loader: a kept form is kept as it is, and nothing else is', () => {
    for (const { in: input, out } of cases()) {
      // The loader takes only what the checker writes: the kept form itself, never a form it rewrites.
      expect({ input, web: keeps(input, 'web'), mail: keeps(input, 'mail') }).toEqual({ input, web: out === input && kindOf(input) === 'web', mail: out === input && kindOf(input) === 'mail' });
      if (out !== null) expect({ out, kept: keeps(out, kindOf(out)) }).toEqual({ out, kept: true });
    }
  });
});

describe('targetHolds: a URL that holds a withheld quote (CONTRACT item 5)', () => {
  const QUOTES = [NAME, PHONE, ADDRESS, EMAIL, 'Müllerhaus Ballroom'];

  it.each([
    ['a mailto to a withheld address', 'mailto:q.brask@example.org'],
    ['a withheld phone in the path', 'https://example.org/call/850-555-0142'],
    ['a withheld address percent-encoded', 'https://example.org/q.brask%40example.org'],
    ['a withheld address percent-encoded twice', 'https://example.org/q.brask%2540example.org'],
    ['a withheld address in upper case', 'https://example.org/Q.BRASK@EXAMPLE.ORG'],
    ['a withheld address in a query', 'https://example.org/join?to=q.brask%40example.org'],
    ['a withheld name split by dots in the host', 'https://quillon.brask.example.org/'],
    ['a withheld name split by hyphens', 'https://example.org/quillon-brask'],
    ['a withheld name split by underscores and plus signs', 'https://example.org/?who=quillon_brask+x'],
    ['a withheld name run together', 'https://example.org/quillonbrask'],
    ['a withheld name split inside its words', 'https://quil.lon.br-ask.example.org/'],
    ['a withheld street split by slashes', 'https://example.org/12/example/lane'],
    ['a withheld phone split by dots', 'https://example.org/850.555.0142'],
    ['a withheld phone run together', 'https://example.org/tel/8505550142'],
    ['a withheld venue in a punycode host', 'https://xn--mllerhaus-ballroom-m6b.example/'],
    ['a withheld venue percent-encoded in Unicode', 'https://example.org/m%C3%BCllerhaus%20ballroom'],
    ['a withheld venue in a mailto domain in punycode', 'mailto:events~@xn--mllerhaus-ballroom-m6b.example'],
    ['a withheld address with no scheme at all', 'q.brask@example.org'],
    ['a withheld phone under a host that is no domain name', 'https://a%zz.example/850-555-0142'],
  ])('finds %s', (_label, url) => {
    expect(targetHolds(url, QUOTES)).toBe(true);
  });

  /** Every byte as a %XX escape, as a tracker or a wrapper writes it. */
  const escaped = (text: string): string => [...Buffer.from(text, 'utf8')].map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join('');
  const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
  const b64url = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');
  const VENUE_ACE = 'xn--mllerhaus-ballroom-m6b.example';

  it.each([
    // The four forms the challenger loaded through both loaders (round 2, B1).
    ['a withheld venue in punycode, in a redirect inside the URL', `https://example.org/redirect?to=https://${VENUE_ACE}/`],
    ['a withheld venue in punycode, in a percent-encoded wrapper', `https://example.org/l?u=${encodeURIComponent(`https://${VENUE_ACE}/`)}`],
    ['a withheld address in base64url, as a tracking link carries it', `https://example.org/t?e=${b64url(EMAIL)}`],
    ['a withheld address percent-encoded four times', 'https://example.org/q.brask%25252540example.org'],
    // The rest of CONTRACT item 9.
    ['a withheld address percent-encoded eight times', `https://example.org/q.brask%${'25'.repeat(7)}40example.org`],
    ['a withheld venue in punycode, in the path', `https://example.org/${VENUE_ACE}/`],
    ['a withheld venue in an upper-case punycode label', 'https://example.org/go/XN--MLLERHAUS-BALLROOM-M6B'],
    ['a withheld address with %u0040 for its @', 'https://example.org/q.brask%u0040example.org'],
    ['a withheld address with %u escapes, percent-encoded', 'https://example.org/q.brask%25u0040example.org'],
    ['a withheld address with &#64; for its @', 'https://example.org/?to=q.brask&#64;example.org'],
    ['a withheld address with &#x40; for its @', 'https://example.org/?to=q.brask&#x40;example.org'],
    ['a withheld address with &#64 for its @, no semicolon', 'https://example.org/?to=q.brask&#64example.org'],
    ['a withheld address with an encoded HTML reference', `https://example.org/?to=q.brask${encodeURIComponent('&#64;')}example.org`],
    ['a withheld address in padded base64', `https://example.org/?to=${b64(EMAIL)}`],
    ['a withheld address in base64, percent-encoded padding', `https://example.org/?to=${encodeURIComponent(b64(EMAIL))}`],
    ['a withheld address in base64 one byte into a payload', `https://example.org/?d=${b64url(`x${EMAIL}`)}`],
    ['a withheld address in base64 two bytes into a payload', `https://example.org/?d=${b64url(`u=${EMAIL}&n=1`)}`],
    ['a withheld address in base64 three bytes into a payload', `https://example.org/?d=${b64(`to=${EMAIL}`)}`],
    ['a withheld venue in base64, its UTF-8 at every alignment', `https://example.org/?d=${b64url(`xy${'Müllerhaus Ballroom'}`)}`],
    ['a withheld name in base64 in lower case', `https://example.org/?d=${b64url('quillon brask')}`],
    ['a withheld phone split by $', 'https://example.org/850$555$0142'],
    ['a withheld phone split by |', 'https://example.org/850|555|0142'],
    ['a withheld address split by "', 'https://example.org/12%22example%22lane'],
    ['a withheld address split by ^', 'https://example.org/12^example^lane'],
    ['a withheld phone split by en dashes', `https://example.org/850${escaped('–')}555${escaped('–')}0142`],
    ['a withheld phone split by zero-width spaces', `https://example.org/850${escaped('​')}555${escaped('​')}0142`],
    ['a withheld phone split by soft hyphens', `https://example.org/850${escaped('­')}555${escaped('­')}0142`],
    // The NFKC fold (round 2, S2): compatibility and decomposed forms fold to the quote's.
    ['a withheld phone in fullwidth digits', `https://example.org/${escaped('８５０-５５５-０１４２')}`],
    ['a withheld venue in NFD (u and a combining diaeresis)', `https://example.org/${escaped('Müllerhaus Ballroom')}`],
    // Every decoder's output is a form on its own (round 3, B3; CONTRACT item 11): none hides another's.
    ['a withheld address after %26%23, which an HTML reference would eat once percent-decoded', 'https://example.org/s?q=%26%2312%20Example%20Lane'],
    ['a withheld phone after &#, its dashes percent-encoded', 'https://example.org/?x=1&#850%2D555%2D0142'],
    ['a withheld phone after %26%23, its dashes percent-encoded', 'https://example.org/s?q=%26%23850%2D555%2D0142'],
    ['a withheld address after xn--, its @ percent-encoded', 'https://example.org/xn--qbrask%40example.org'],
    ['a withheld name after xn--, its space percent-encoded', 'https://example.org/xn--quillon%20brask'],
    ['a withheld address whose percent-decoding would lengthen the HTML reference before it', 'https://example.org/?a=&#49%32%20Example%20Lane'],
    // Every xn-- label, not only the first (round 3, S3).
    ['a withheld venue in punycode after a label that does not decode', 'https://example.org/xn--zz/?to=xn--mllerhaus-ballroom-m6b.example'],
    ['a withheld venue in a mailto domain after a label that does not decode', 'mailto:events~@xn--zz.xn--mllerhaus-ballroom-m6b.example'],
    // HTML numeric references with any number of leading zeros (round 3, S4).
    ['a withheld address with &#00000064; for its @', 'https://example.org/q.brask&#00000064;example.org'],
    ['a withheld address with &#x0000040; for its @', 'https://example.org/q.brask&#x0000040;example.org'],
    ['a withheld address with forty leading zeros in its reference', `https://example.org/q.brask&#x${'0'.repeat(40)}40;example.org`],
  ])('finds %s', (_label, url) => {
    expect(targetHolds(url, QUOTES)).toBe(true);
  });

  it('finds a quote whose base64 holds + or /, in base64 and in base64url', () => {
    const quote = 'Lake Hall ~ West';
    const payload = Buffer.from(`x${quote}`, 'utf8');
    expect(payload.toString('base64')).toContain('+');
    expect(targetHolds(`https://example.org/?d=${encodeURIComponent(payload.toString('base64'))}`, [quote])).toBe(true);
    expect(targetHolds(`https://example.org/?d=${payload.toString('base64url')}`, [quote])).toBe(true);
    expect(targetHolds('https://example.org/?d=eExha2UgSGFsbCB-IFdlc3', [quote])).toBe(true);
  });

  it('finds a quote base64-encoded after it was percent-encoded or form-encoded, at every alignment, in base64 and base64url (LINKS L3 fix 1, N2)', () => {
    const quote = 'Kestrel Ambry';
    const percent = encodeURIComponent(quote);
    const forms = [percent, quote.replace(/ /g, '+'), percent.replace(/%20/g, '+'), encodeURIComponent('kestrel ambry'), 'kestrel+ambry'];
    for (const form of forms) {
      for (const lead of ['', 'x', 'xx']) {
        const payload = Buffer.from(`${lead}${form}`, 'utf8');
        for (const encoded of [payload.toString('base64'), payload.toString('base64url'), encodeURIComponent(payload.toString('base64'))]) {
          expect(targetHolds(`https://example.org/p?q=${encoded}`, [quote]), `${lead}${form} as ${encoded}`).toBe(true);
        }
      }
    }
    // The challenger's case, as it was found (a percent-encoded quote inside base64), and a near miss that holds nothing.
    expect(targetHolds(`https://example.org/p?q=${Buffer.from('Kestrel%20Ambry').toString('base64')}`, [quote])).toBe(true);
    expect(targetHolds(`https://example.org/p?q=${Buffer.from('Kestrel%20Amber').toString('base64')}`, [quote])).toBe(false);
    // A quote with a lone surrogate has no percent-encoded form: it is still looked for as written.
    expect(() => targetHolds('https://example.org/p?q=x', ['Kestrel Ambry\uD800'])).not.toThrow();
    expect(targetHolds('https://example.org/kestrel-ambry', ['Kestrel Ambry\uD800', quote])).toBe(true);
  });

  /** A %XX escape nested n deep, an HTML reference nested n deep and a %u escape nested n deep, beside an IDN label. */
  const percentNested = (n: number): string => `%${'25'.repeat(n - 1)}41`;
  const entityNested = (n: number): string => `&#38;${'#38;'.repeat(n - 2)}#66;`;
  const percentUNested = (n: number): string => `%u0025${'u0025'.repeat(n - 2)}u0043`;
  const everyWay = (n: number): string => `https://example.org/${percentNested(n)}/${entityNested(n)}/${percentUNested(n)}/xn--bcher-kva`;

  it("decodes with each decoder on its own and with all of them in turn, on every form (CONTRACT item 11)", () => {
    expect(decodedForms('https://example.org/?a=&#49%32')).toEqual(
      expect.arrayContaining([
        'https://example.org/?a=&#49%32',
        // %XX alone, which makes the HTML reference &#492.
        'https://example.org/?a=&#492',
        // The HTML reference alone, then %XX on that form.
        'https://example.org/?a=1%32',
        'https://example.org/?a=12',
        // All of them in turn.
        'https://example.org/?a=\u01ec',
      ]),
    );
    expect(decodedForms('https://example.org/games/1')).toEqual(['https://example.org/games/1']);
  });

  it('passes a link escaped five deep two ways, which all the decoders in turn finish within the eight passes', () => {
    const url = `https://example.org/${percentNested(5)}/${entityNested(5)}`;
    expect(decodedForms(url)).toContain('https://example.org/A/B');
    expect(targetHolds(url, QUOTES)).toBe(false);
  });

  it(`holds a URL that decodes to more than ${MAX_FORMS} forms, whatever it holds`, () => {
    expect(decodedForms(everyWay(2))).toHaveLength(54);
    expect(decodedForms(everyWay(2), 54)).toHaveLength(54);
    expect(decodedForms(everyWay(2), 53)).toBeUndefined();
    expect(decodedForms(everyWay(5))).toBeUndefined();
    expect(targetHolds(everyWay(5), QUOTES)).toBe(true);
    expect(targetHolds(everyWay(2), QUOTES)).toBe(false);
  });

  it('holds a URL that is still decoding after eight passes, whatever it holds, so nothing nested deeper passes', () => {
    expect(targetHolds(`https://example.org/games%${'25'.repeat(8)}41`, QUOTES)).toBe(true);
    // Eight passes are enough for a link holding no quote.
    expect(targetHolds(`https://example.org/games%${'25'.repeat(7)}41`, QUOTES)).toBe(false);
    expect(targetHolds(`https://example.org/games%${'25'.repeat(8)}41`, [])).toBe(false);
  });

  it.each([
    ['a plain web link', 'https://example.org/games/1'],
    ['base64 of something else', `https://example.org/?d=${b64url('the games night is on')}`],
    ['an HTML reference to something else', 'https://example.org/?q=a&#65;b&#x42;'],
    ['an HTML reference past Unicode', 'https://example.org/?q=&#x110000;&#99999999;'],
    ['a %u escape of something else, and a lone surrogate', 'https://example.org/?q=%u0041%uD800'],
    ['a punycode label that does not decode', 'https://example.org/xn--zz/xn--'],
    ['a plain mailto', 'mailto:games@example.org'],
    ['a malformed percent-escape', 'https://example.org/100%zz'],
    ['an IDN host holding no quote', 'https://xn--bcher-kva.example/'],
    ['a host that is no domain name, holding no quote', 'https://a%zz.example/games'],
  ])('passes %s', (_label, url) => {
    expect(targetHolds(url, QUOTES)).toBe(false);
  });

  it("never looks for a quote's base64 shorter than six characters, which noise would match", () => {
    expect(b64('Bo')).toBe('Qm8=');
    expect(targetHolds(`https://example.org/?d=${b64('Bo')}`, ['Bo'])).toBe(false);
  });

  it('holds nothing when nothing is withheld', () => {
    expect(targetHolds('mailto:q.brask@example.org', [])).toBe(false);
  });

  it('refuses the first link that holds one, by its place only, never its URL or the quote', () => {
    const links: IssueLinks = { public: [webLink(1)], members: [mailLink(2), mailLink(3, 'mailto:q.brask@example.org')] };
    expect(() => refuseWithheldTargets(links, QUOTES)).toThrow(LoadError);
    expect(() => refuseWithheldTargets(links, QUOTES)).toThrow(/^links\.members\[1\]: its target holds a passage the public policy withholds$/);
    expect(() => refuseWithheldTargets(LINKS, QUOTES)).not.toThrow();
  });
});

describe('parseBundle, nwfl-issue/2', () => {
  it('reads the links and their approved hash', async () => {
    const bundle = parseBundle(await bundleJson({ format: 'nwfl-issue/2' }));
    expect(bundle.format).toBe('nwfl-issue/2');
    expect(bundle.links).toEqual(LINKS);
    expect(bundle.approval.linksSha256).toBe(linksSha256({ public: sha256(bundle.pdfs.public).toString('hex'), members: sha256(bundle.pdfs.members).toString('hex') }, LINKS));
  });

  it('still reads nwfl-issue/1, with no links', async () => {
    const bundle = parseBundle(await bundleJson());
    expect(bundle.format).toBe('nwfl-issue/1');
    expect(bundle.links).toBeUndefined();
    expect(bundle.approval).not.toHaveProperty('linksSha256');
  });

  it.each([
    ['links in an nwfl-issue/1 bundle', { format: 'nwfl-issue/1' }, (j: Record<string, unknown>) => ({ ...j, links: linksJson(LINKS) }), /the bundle: unknown field links/],
    ['a links hash in an nwfl-issue/1 approval', { format: 'nwfl-issue/1' }, (j: Record<string, unknown>) => withPath(j, ['approval', 'linksSha256'], HASH), /approval: unknown field linksSha256/],
    ['an nwfl-issue/2 bundle with no links', { format: 'nwfl-issue/2' }, (j: Record<string, unknown>) => withPath(j, ['links'], undefined), /links must be a JSON object/],
    ['an nwfl-issue/2 approval with no links hash', { format: 'nwfl-issue/2' }, (j: Record<string, unknown>) => withPath(j, ['approval', 'linksSha256'], undefined), /approval\.linksSha256 must be 64 lower-case hex digits/],
    ['a links hash that is not hex', { format: 'nwfl-issue/2' }, (j: Record<string, unknown>) => withPath(j, ['approval', 'linksSha256'], 'Z'.repeat(64)), /approval\.linksSha256/],
    ['a link with the wrong scheme', { format: 'nwfl-issue/2' }, (j: Record<string, unknown>) => withPath(j, ['links', 'public', 0, 'url'], 'http://example.org/games/1'), /links\.public\[0\]\.url/],
    ['an unknown link field', { format: 'nwfl-issue/2' }, (j: Record<string, unknown>) => withPath(j, ['links', 'members', 0, 'text'], 'Game night'), /links\.members\[0\]: unknown field text/],
    ['a third format', { format: 'nwfl-issue/2' }, (j: Record<string, unknown>) => withPath(j, ['format'], 'nwfl-issue/3'), /the bundle's format must be nwfl-issue\/1 or nwfl-issue\/2/],
  ] as const)('refuses %s', async (_label, options, change, message) => {
    const json = change(await bundleJson(options));
    expect(() => parseBundle(json)).toThrow(LoadError);
    expect(() => parseBundle(json)).toThrow(message);
  });

  it('refuses links other than the approved ones, naming the hash it computed', async () => {
    const json = await bundleJson({ format: 'nwfl-issue/2', linksSha256: HASH });
    const files = { public: sha256(Buffer.from(String((json['pdfs'] as Record<string, string>)['public']), 'base64')).toString('hex'), members: (json['approval'] as Record<string, string>)['membersSha256'] as string };
    expect(() => parseBundle(json)).toThrow(`the links are not the approved ones: their sha256 is ${linksSha256(files, LINKS)}`);
  });

  it("refuses links approved for another issue's files: the hash binds both files' sha256", async () => {
    const other = await bundleJson({ format: 'nwfl-issue/2', period: '2026-08' });
    const json = withPath(await bundleJson({ format: 'nwfl-issue/2' }), ['approval', 'linksSha256'], (other['approval'] as Record<string, string>)['linksSha256']);
    expect(() => parseBundle(json)).toThrow(/^the links are not the approved ones/);
  });
});

describe('parseLinksBundle, nwfl-links/1', () => {
  const json = (): Record<string, unknown> => linksBundleJson({ publicSha256: 'b'.repeat(64), membersSha256: 'c'.repeat(64), publicInputHash: 'd'.repeat(64) });

  it('reads the slug, both files by sha256, the links and the approval', () => {
    expect(LINKS_FORMAT).toBe('nwfl-links/1');
    expect(parseLinksBundle(json())).toEqual({
      slug: 'pensa-mensa-2026-10',
      sha256: { public: 'b'.repeat(64), members: 'c'.repeat(64) },
      links: LINKS,
      approval: { reference: 'LINKS', linksSha256: linksSha256(FILES, LINKS), publicInputHash: 'd'.repeat(64) },
    });
  });

  it.each([
    ['not an object', () => 'links', /the links bundle must be a JSON object/],
    ['an unknown field', (j: Record<string, unknown>) => ({ ...j, pdfs: {} }), /the links bundle: unknown field pdfs/],
    ['another format', (j: Record<string, unknown>) => withPath(j, ['format'], 'nwfl-issue/2'), /the links bundle's format must be nwfl-links\/1/],
    ['a slug that is not an issue', (j: Record<string, unknown>) => withPath(j, ['issue'], 'about-us'), /issue must be an issue's slug, pensa-mensa-YYYY-MM/],
    ['a month 13', (j: Record<string, unknown>) => withPath(j, ['issue'], 'pensa-mensa-2026-13'), /issue must be/],
    ['an unknown sha256 field', (j: Record<string, unknown>) => withPath(j, ['sha256', 'officers'], HASH), /sha256: unknown field officers/],
    ['a file hash that is not hex', (j: Record<string, unknown>) => withPath(j, ['sha256', 'members'], 'x'), /sha256\.members must be 64 lower-case hex digits/],
    ['no public file hash', (j: Record<string, unknown>) => withPath(j, ['sha256', 'public'], undefined), /sha256\.public/],
    ['an unknown approval field', (j: Record<string, unknown>) => withPath(j, ['approval', 'marksSha256'], HASH), /approval: unknown field marksSha256/],
    ['an approval reference with free text', (j: Record<string, unknown>) => withPath(j, ['approval', 'reference'], 'ok from Pat'), /approval\.reference/],
    ['an input hash that is not hex', (j: Record<string, unknown>) => withPath(j, ['approval', 'publicInputHash'], 'A'.repeat(64)), /approval\.publicInputHash/],
    ['a bad link', (j: Record<string, unknown>) => withPath(j, ['links', 'public', 1, 'url'], 'mailto:'), /links\.public\[1\]\.url/],
  ] as const)('refuses %s', (_label, change, message) => {
    const value = change(json());
    expect(() => parseLinksBundle(value)).toThrow(LoadError);
    expect(() => parseLinksBundle(value)).toThrow(message);
  });

  it('refuses links other than the approved ones, naming the hash it computed', () => {
    expect(() => parseLinksBundle(withPath(json(), ['approval', 'linksSha256'], HASH))).toThrow(`the links are not the approved ones: their sha256 is ${linksSha256(FILES, LINKS)}`);
  });

  it("refuses links approved for other files: either file's sha256 changed, or the two swapped", () => {
    for (const sha of [{ ...FILES, public: 'd'.repeat(64) }, { ...FILES, members: 'd'.repeat(64) }, { public: FILES.members, members: FILES.public }]) {
      expect(() => parseLinksBundle(withPath(json(), ['sha256'], sha))).toThrow(/^the links are not the approved ones/);
    }
  });

  it('refuses a bundle with no links at all: there is nothing to attach', () => {
    const empty = linksBundleJson({ publicSha256: 'b'.repeat(64), membersSha256: 'c'.repeat(64), publicInputHash: 'd'.repeat(64), links: { public: [], members: [] } });
    expect(() => parseLinksBundle(empty)).toThrow(/the links bundle has no links/);
  });
});

describe('runAttach, before the database', () => {
  async function run(argv: string[], env: Record<string, string>, stdin = stdinOf('{}')): Promise<{ code: number; lines: string[] }> {
    const lines: string[] = [];
    const code = await runAttach(argv, env, stdin, (line) => lines.push(line));
    return { code, lines };
  }

  it.each([
    ['no argument', []],
    ['a file path', ['/mnt/links.json']],
    ['stdin and a path', ['-', 'links.json']],
  ])('refuses %s: the bundle is read from stdin only', async (_label, argv) => {
    const { code, lines } = await run(argv, NO_DB);
    expect(code).toBe(2);
    expect(lines).toEqual(['usage: node dist/load/links-cli.js -   (the links bundle is read from stdin only: never a path, URL or mounted file)']);
  });

  it.each(['file', 'device', 'other'] as const)('refuses stdin that is a %s in production mode', async (kind) => {
    const { code, lines } = await run(['-'], PRODUCTION, stdinOf('{}', kind));
    expect(code).toBe(2);
    expect(lines.join('\n')).toMatch(/^links: in production the bundle must arrive on a pipe/);
  });

  it('reads a pipe in production mode on to the bundle check', async () => {
    const { code, lines } = await run(['-'], PRODUCTION, stdinOf('not json', 'pipe'));
    expect(code).toBe(2);
    expect(lines).toEqual(['links: the bundle is not valid JSON']);
  });

  it('refuses bytes that are not UTF-8, and a bundle that is not a links bundle', async () => {
    expect((await run(['-'], NO_DB, stdinOf(Buffer.from([0x7b, 0xff, 0x7d])))).lines).toEqual(['links: the bundle is not valid JSON']);
    const wrong = await run(['-'], NO_DB, stdinOf(JSON.stringify(await bundleJson())));
    expect(wrong.code).toBe(2);
    expect(wrong.lines.join('\n')).toMatch(/^links: the links bundle: unknown field/);
  });

  it('refuses a bundle over 4 MiB without reading all of it', async () => {
    const chunk = Buffer.alloc(1024 * 1024, 0x20);
    let read = 0;
    const chunks = (function* () {
      for (let n = 0; n < 16; n++) {
        read++;
        yield chunk;
      }
    })();
    const { code, lines } = await run(['-'], NO_DB, { kind: 'pipe', chunks });
    expect(code).toBe(2);
    expect(lines).toEqual(['links: the bundle is larger than 4 MiB']);
    expect(read).toBe(MAX_LINKS_BUNDLE_BYTES / chunk.length + 1);
  });

  it('exits 1, nothing applied, naming only the driver code, when the database cannot be reached', async () => {
    const json = JSON.stringify(linksBundleJson({ publicSha256: 'b'.repeat(64), membersSha256: 'c'.repeat(64), publicInputHash: 'd'.repeat(64) }));
    const { code, lines } = await run(['-'], NO_DB, stdinOf(json));
    expect(code).toBe(1);
    expect(lines).toEqual(['links failed, nothing applied: ECONNREFUSED']);
  });

  it('exits 1 when the connection settings are refused, never as a crash', async () => {
    const json = JSON.stringify(linksBundleJson({ publicSha256: 'b'.repeat(64), membersSha256: 'c'.repeat(64), publicInputHash: 'd'.repeat(64) }));
    const { code, lines } = await run(['-'], { ...NO_DB, PGSSLMODE: 'prefer' }, stdinOf(json));
    expect(code).toBe(1);
    expect(lines).toEqual(['links failed, nothing applied: error']);
  });
});
