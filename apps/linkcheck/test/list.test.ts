import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { LIST_FORMAT, type LinksByAudience, canonicalJson, linksSha256, mintId, parseLinkList, type ListedLink } from '../src/list.js';

/** The superseded v1 hash, links only: no longer accepted. */
const v1 = (links: LinksByAudience): string => createHash('sha256').update(canonicalJson({ v: 1, links })).digest('hex');

const link = (over: Partial<ListedLink> = {}): ListedLink => ({
  id: 'aaaaaaaaaaaaaaaaaaaaaaaaaa',
  page: 1,
  rect: [72, 700.5, 200.25, 714],
  url: 'https://example.org/a',
  kind: 'web',
  confirm: false,
  ...over,
});

describe('canonicalJson (the same as apps/api src/content/hash.ts)', () => {
  it('sorts keys at every depth and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 'x', c: null }, 2] })).toBe('{"a":[{"c":null,"d":"x"},2],"b":1}');
  });
});

describe('mintId', () => {
  it('is 26 lower-case base32 characters from 128 random bits', () => {
    expect(mintId(() => Buffer.alloc(16, 0))).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(mintId(() => Buffer.alloc(16, 0xff))).toBe('77777777777777777777777774');
    expect(mintId()).toMatch(/^[a-z2-7]{26}$/);
    expect(mintId()).not.toBe(mintId());
  });

  it('refuses a source that gives other than 16 bytes', () => {
    expect(() => mintId(() => Buffer.alloc(15))).toThrow(/16 random bytes/);
  });
});

describe('linksSha256', () => {
  const SHA = { public: '1'.repeat(64), members: '2'.repeat(64) };

  it('is pinned: sha256 of canonical {v:2, sha256:{public,members}, links:{public,members}}, each list sorted by id', () => {
    const a = link({ id: 'bbbbbbbbbbbbbbbbbbbbbbbbbb' });
    const b = link({ id: 'aaaaaaaaaaaaaaaaaaaaaaaaaa', page: 2, kind: 'mail', url: 'mailto:editor@example.org', confirm: false });
    const c = link({ id: 'cccccccccccccccccccccccccc', url: 'https://www.facebook.com/groups/example', confirm: true });
    // The test vector L2's loader must reproduce (src/load/links.ts, CONTRACT 4); computed independently with
    // Python's json.dumps(sort_keys=True, separators=(',', ':')).
    expect(linksSha256({ public: [a, b], members: [c] }, SHA)).toBe('59ac3705ac3b1d00c13c0865375092a973f4c636929b08fb7371439b1fe70375');
    expect(linksSha256({ public: [b, a], members: [c] }, SHA)).toBe(linksSha256({ public: [a, b], members: [c] }, SHA));
  });

  it('changes with every field, with the audience and with each file sha256 (links for one issue cannot attach to another)', () => {
    const base = linksSha256({ public: [link()], members: [] }, SHA);
    for (const over of [{ id: 'baaaaaaaaaaaaaaaaaaaaaaaaa' }, { page: 2 }, { rect: [72, 700.5, 200.25, 714.01] as ListedLink['rect'] }, { url: 'https://example.org/b' }, { kind: 'mail' as const }, { confirm: true }]) {
      expect(linksSha256({ public: [link(over)], members: [] }, SHA)).not.toBe(base);
    }
    expect(linksSha256({ public: [], members: [link()] }, SHA)).not.toBe(base);
    expect(linksSha256({ public: [link()], members: [] }, { ...SHA, public: '3'.repeat(64) })).not.toBe(base);
    expect(linksSha256({ public: [link()], members: [] }, { ...SHA, members: '3'.repeat(64) })).not.toBe(base);
    expect(linksSha256({ public: [link()], members: [] }, { public: SHA.members, members: SHA.public })).not.toBe(base);
  });
});

describe('parseLinkList', () => {
  const sha = 'a'.repeat(64);
  const good = () => {
    const links = { public: [link()], members: [link({ id: 'bbbbbbbbbbbbbbbbbbbbbbbbbb', confirm: true, url: 'https://www.facebook.com/x' })] };
    const sha256 = { public: sha, members: 'b'.repeat(64) };
    return { format: LIST_FORMAT, sha256, links, linksSha256: linksSha256(links, sha256) };
  };

  it('accepts a well-formed list and returns it', () => {
    expect(parseLinkList(good())).toEqual(good());
  });

  const broken: [string, (json: ReturnType<typeof good>) => unknown, RegExp][] = [
    ['not an object', () => [], /must be a JSON object/],
    ['an unknown top-level field', (j) => ({ ...j, extra: 1 }), /unknown field extra/],
    ['a wrong format', (j) => ({ ...j, format: 'nwfl-link-list/2' }), /format must be/],
    ['a bad file sha256', (j) => ({ ...j, sha256: { public: 'x', members: sha } }), /sha256.public/],
    ['a hash mismatch', (j) => ({ ...j, linksSha256: 'c'.repeat(64) }), /linksSha256 does not match/],
    ['a file sha256 the hash was not made over', (j) => ({ ...j, sha256: { ...j.sha256, members: 'c'.repeat(64) } }), /linksSha256 does not match/],
    ['the v1 hash (links only)', (j) => ({ ...j, linksSha256: v1(j.links) }), /linksSha256 does not match/],
    ['a mailto with a query', (j) => ({ ...j, links: { ...j.links, public: [link({ kind: 'mail', url: 'mailto:editor@example.org?subject=Hi' })] } }), /url must be/],
    ['an explicit port', (j) => ({ ...j, links: { ...j.links, public: [link({ url: 'https://example.org:80/a' })] } }), /url must be/],
    ['an IP literal', (j) => ({ ...j, links: { ...j.links, public: [link({ url: 'https://[2606:4700::1]/' })] } }), /url must be/],
    ['a dotless host', (j) => ({ ...j, links: { ...j.links, public: [link({ url: 'https://localhost/' })] } }), /url must be/],
    ['an unknown link field', (j) => ({ ...j, links: { ...j.links, public: [{ ...link(), text: 'x' }] } }), /unknown field text/],
    ['a bad id', (j) => ({ ...j, links: { ...j.links, public: [link({ id: 'AAAAAAAAAAAAAAAAAAAAAAAAAA' })] } }), /id must be/],
    ['a duplicated id', (j) => ({ ...j, links: { public: [link()], members: [link()] } }), /twice/],
    ['page 0', (j) => ({ ...j, links: { ...j.links, public: [link({ page: 0 })] } }), /page must be/],
    ['an unrounded rect', (j) => ({ ...j, links: { ...j.links, public: [link({ rect: [1.001, 2, 3, 4] })] } }), /rect must be/],
    ['a NaN rect', (j) => ({ ...j, links: { ...j.links, public: [{ ...link(), rect: [null, 2, 3, 4] }] } }), /rect must be/],
    ['an inverted rect', (j) => ({ ...j, links: { ...j.links, public: [link({ rect: [5, 2, 3, 4] })] } }), /rect must be/],
    ['an http url', (j) => ({ ...j, links: { ...j.links, public: [link({ url: 'http://example.org/' })] } }), /url must be/],
    ['a javascript url', (j) => ({ ...j, links: { ...j.links, public: [link({ url: 'javascript:alert(1)' })] } }), /url must be/],
    ['a mail kind on a web url', (j) => ({ ...j, links: { ...j.links, public: [link({ kind: 'mail' })] } }), /kind/],
    ['a bad kind', (j) => ({ ...j, links: { ...j.links, public: [{ ...link(), kind: 'tel' }] } }), /kind/],
    ['a non-boolean confirm', (j) => ({ ...j, links: { ...j.links, public: [{ ...link(), confirm: 'yes' }] } }), /confirm/],
    ['a links object with a third audience', (j) => ({ ...j, links: { ...j.links, officers: [] } }), /unknown field officers/],
    ['a links list that is not a list', (j) => ({ ...j, links: { ...j.links, public: {} } }), /must be a list/],
    ['over 500 links in a file', (j) => ({ ...j, links: { ...j.links, public: Array.from({ length: 501 }, () => link()) } }), /at most 500/],
  ];

  it.each(broken)('refuses %s', (_name, mutate, message) => {
    expect(() => parseLinkList(mutate(good()))).toThrow(message);
  });
});
