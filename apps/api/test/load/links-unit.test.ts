// LINKS L2, the approved links' input rules, with no database: the links list both loaders read
// (src/load/links.ts), its hash, the issue bundle nwfl-issue/2 and the links bundle nwfl-links/1.
// Every URL here is under a reserved example name; every person is made up.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LINKS_FORMAT, MAX_LINKS_BUNDLE_BYTES, parseLinksBundle, runAttach } from '../../src/load/attach.js';
import { canonicalJson } from '../../src/content/hash.js';
import { LoadError, parseBundle } from '../../src/load/load.js';
import { type IssueLinks, type Link, MAX_LINKS_PER_FILE, hostOf, linksSha256, parseLinks } from '../../src/load/links.js';
import { LINKS, bundleJson, linkId, linksBundleJson, linksJson, mailLink, stdinOf, webLink } from './bundle.js';

const NO_DB = { DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none' };
const PRODUCTION = { ...NO_DB, NODE_ENV: 'production' };
const HASH = 'a'.repeat(64);

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
    ])('refuses a rect that is %s', (_label, rect) => {
      expect(() => parseLinks(oneLink('rect', rect))).toThrow(/links\.public\[0\]\.rect must be \[x1, y1, x2, y2\]/);
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
    });

    it.each([
      ['an https URL', 'https://example.org/'],
      ['a query', 'mailto:games@example.org?subject=hi'],
      ['no address', 'mailto:'],
      ['no domain', 'mailto:games@'],
      ['two at signs', 'mailto:games@club@example.org'],
      ['a one-label domain', 'mailto:games@localhost'],
      ['a space', 'mailto:games @example.org'],
      ['a non-ASCII address', 'mailto:spiele@bücher.example'],
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
    expect(hostOf(mailLink(1, 'mailto:Games@Example.ORG'))).toBe('example.org');
  });
});

describe('linksSha256', () => {
  /** The canonical form, pinned: L1's checker computes the same hash over the same JSON. */
  const pinned = (links: IssueLinks): string => {
    const sorted = (list: readonly Link[]) =>
      [...list].sort((a, b) => (a.id < b.id ? -1 : 1)).map((link) => ({ confirm: link.confirm, id: link.id, kind: link.kind, page: link.page, rect: [...link.rect], url: link.url }));
    return createHash('sha256').update(canonicalJson({ v: 1, links: { members: sorted(links.members), public: sorted(links.public) } })).digest('hex');
  };

  it('is SHA-256 of the canonical JSON of both lists, each sorted by id', () => {
    expect(linksSha256(LINKS)).toBe(pinned(LINKS));
    expect(linksSha256(LINKS)).toMatch(/^[0-9a-f]{64}$/);
    expect(linksSha256({ public: [webLink(1)], members: [] })).toBe(
      createHash('sha256')
        .update(`{"links":{"members":[],"public":[{"confirm":false,"id":"${linkId(1)}","kind":"web","page":1,"rect":[72,680,300,694],"url":"https://example.org/games/1"}]},"v":1}`)
        .digest('hex'),
    );
  });

  it('does not depend on the order of the links in a list', () => {
    expect(linksSha256({ public: [...LINKS.public].reverse(), members: [...LINKS.members].reverse() })).toBe(linksSha256(LINKS));
  });

  it('changes with every field of a link, and with the file a link is on', () => {
    const base = linksSha256(LINKS);
    const first = LINKS.public[0] as Link;
    const variants: Link[] = [
      { ...first, id: linkId(99) },
      { ...first, page: 2 },
      { ...first, rect: [72, 680, 300, 694.01] },
      { ...first, url: 'https://example.org/games/2' },
      { ...first, kind: 'mail' },
      { ...first, confirm: true },
    ];
    for (const variant of variants) expect(linksSha256({ ...LINKS, public: [variant, ...LINKS.public.slice(1)] })).not.toBe(base);
    expect(linksSha256({ public: LINKS.public.slice(1), members: [first, ...LINKS.members] })).not.toBe(base);
  });
});

describe('parseBundle, nwfl-issue/2', () => {
  it('reads the links and their approved hash', async () => {
    const bundle = parseBundle(await bundleJson({ format: 'nwfl-issue/2' }));
    expect(bundle.format).toBe('nwfl-issue/2');
    expect(bundle.links).toEqual(LINKS);
    expect(bundle.approval.linksSha256).toBe(linksSha256(LINKS));
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
    expect(() => parseBundle(json)).toThrow(`the links are not the approved ones: their sha256 is ${linksSha256(LINKS)}`);
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
      approval: { reference: 'LINKS', linksSha256: linksSha256(LINKS), publicInputHash: 'd'.repeat(64) },
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
    expect(() => parseLinksBundle(withPath(json(), ['approval', 'linksSha256'], HASH))).toThrow(`the links are not the approved ones: their sha256 is ${linksSha256(LINKS)}`);
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
