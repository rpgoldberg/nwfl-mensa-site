// The links contract shared with L2 (CONTRACT.md): one fixture of URL cases, committed byte for byte
// at apps/linkcheck/test/fixtures/links-contract.json and apps/api/test/load/fixtures/links-contract.json.
// Each case is { in, out }: out is the form the checker keeps for in, or null when in is refused. The
// loader (L2) accepts a link's url exactly when it is a kept form (in === out), and every out.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LIST_FORMAT, type ListedLink, linksSha256, parseLinkList } from '../src/list.js';
import { keptForm } from '../src/urls.js';

/** The sha256 of the fixture; the same constant in L2's suite. */
export const LINKS_CONTRACT_SHA256 = '081f392b43481492d6cecd6ce100babd515fc87ee01b1a1f0982e1840e8b910f';

interface Case {
  in: string;
  out: string | null;
}

const bytes = readFileSync(new URL('./fixtures/links-contract.json', import.meta.url));
const cases = JSON.parse(bytes.toString('utf8')) as Case[];

describe('the links contract fixture', () => {
  it('is the pinned file, in its one serialisation, sorted by "in" with no repeats', () => {
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(LINKS_CONTRACT_SHA256);
    expect(bytes.toString('utf8')).toBe(`${JSON.stringify(cases, null, 2)}\n`);
    const ins = cases.map((c) => c.in);
    expect(ins).toEqual([...ins].sort());
    expect(new Set(ins).size).toBe(ins.length);
    expect(cases.every((c) => Object.keys(c).join() === 'in,out' && typeof c.in === 'string' && (c.out === null || typeof c.out === 'string'))).toBe(true);
  });

  it.each(cases.map((c) => [c.in, c.out] as const))('keptForm(%j) is %j', (input, out) => {
    expect(keptForm(input)).toBe(out);
  });

  it.each(cases.filter((c) => c.out !== null).map((c) => c.out as string))('the kept form %j is its own kept form', (out) => {
    expect(keptForm(out)).toBe(out);
  });

  const SHA = { public: 'a'.repeat(64), members: 'b'.repeat(64) };
  const listOf = (url: string) => {
    const link: ListedLink = { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaa', page: 1, rect: [1, 2, 3, 4], url, kind: url.toLowerCase().startsWith('mailto:') ? 'mail' : 'web', confirm: false };
    const links = { public: [link], members: [] };
    return { format: LIST_FORMAT, sha256: SHA, links, linksSha256: linksSha256(links, SHA) };
  };

  it.each(cases.map((c) => [c.in, c.in === c.out] as const))('links.json with the url %j is accepted: %s', (input, accepted) => {
    if (accepted) expect(parseLinkList(listOf(input)).links.public[0]?.url).toBe(input);
    else expect(() => parseLinkList(listOf(input))).toThrow(/url must be/);
  });
});
