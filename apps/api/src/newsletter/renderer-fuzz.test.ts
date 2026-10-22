// The PUBLIC renderer as a chokepoint on its own (from the round-2 challenge of
// 3add2ad, kept as a permanent test). 3,000 seeded random trees mix members
// spans and blocks, links (with members text, around members, nested), lists,
// quotes, headings and images. Every text inside a members node, and the
// target of every link whose subtree holds one, carries SECRET; public text
// carries PUB. The public render, handed the full tree, must show no SECRET,
// every SECRET must reach members, and it must say exactly what the public
// tree the site serves says.
import { describe, expect, it } from 'vitest';
import { filterForPublic, normalizeTree } from '../content/tree.js';
import { treeText } from './content-json.js';

type Json = Record<string, unknown>;

/** xorshift32, high bits: an LCG's low bits cycle, which starved the generator of whole node kinds. */
function random(seed: number): (n: number) => number {
  let state = seed;
  return (n) => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return Math.floor((state / 0x100000000) * n);
  };
}

function generator(seed: number): () => Json {
  const rnd = random(seed);
  let counter = 0;
  const inlines = (depth: number, inMembers: boolean): Json[] => Array.from({ length: 1 + rnd(3) }, () => inline(depth + 1, inMembers));
  const inline = (depth: number, inMembers: boolean): Json => {
    const pick = depth > 5 ? 0 : rnd(4);
    if (pick === 1) {
      const children = inlines(depth, inMembers);
      const holdsMembers = inMembers || JSON.stringify(children).includes('"members"');
      return { type: 'link', href: `https://example.org/${holdsMembers ? 'HREFSECRET' : 'pubhref'}${counter++}`, children };
    }
    if (pick === 2) return { type: 'members', children: inlines(depth, true) };
    if (pick === 3) return { type: 'link', href: `https://example.org/HREFSECRET${counter++}`, children: [{ type: 'members', children: inlines(depth, true) }] };
    return { type: 'text', text: `${inMembers ? 'SECRET' : 'PUB'}${counter++} `, bold: rnd(2) === 0 };
  };
  const blocks = (depth: number, inMembers: boolean): Json[] => Array.from({ length: 1 + rnd(3) }, () => block(depth + 1, inMembers));
  const block = (depth: number, inMembers: boolean): Json => {
    const pick = depth > 4 ? 0 : rnd(6);
    if (pick === 1) return { type: 'heading', level: 1 + rnd(2), children: inlines(depth, inMembers) };
    if (pick === 2) return { type: 'list', ordered: rnd(2) === 0, items: Array.from({ length: 1 + rnd(3) }, () => blocks(depth + 1, inMembers)) };
    if (pick === 3) return { type: 'quote', children: blocks(depth, inMembers) };
    if (pick === 4) return { type: 'members', children: blocks(depth, true) };
    if (pick === 5) return { type: 'image', fileId: '7a0d3d4e-1f1b-4c55-9a51-0b8f1c6a2e01', alt: `${inMembers ? 'SECRET' : 'PUBALT'}${counter++}` };
    return { type: 'paragraph', children: inlines(depth, inMembers) };
  };
  return () => ({ blocks: blocks(0, false) });
}

describe('the public renderer, fuzzed', () => {
  it('shows the public no SECRET in 3,000 random trees, members every SECRET text, and the public exactly the site’s public tree', () => {
    const next = generator(0x5eed1234);
    const totals = { secrets: 0, publicTexts: 0, membersLinks: 0, nestedPublicLinks: 0 };
    for (let n = 0; n < 3000; n += 1) {
      const raw = next();
      const text = JSON.stringify(raw);
      totals.membersLinks += (text.match(/HREFSECRET/g) ?? []).length;
      totals.nestedPublicLinks += (text.match(/"type":"link","href":"https:\/\/example\.org\/pubhref\d+","children":\[[^\]]*"type":"link"/g) ?? []).length;
      const tree = normalizeTree(raw);
      const unfiltered = treeText(tree, 'public');
      expect(unfiltered, text).not.toMatch(/SECRET/);
      // The site serves the public tree as it is; rendered without any guard it is what the site shows.
      expect(unfiltered, text).toBe(treeText(filterForPublic(tree), 'members'));
      const members = treeText(tree, 'members');
      const secretTexts = (text.match(/"text":"SECRET\d+ "/g) ?? []).map((m) => m.slice(8, -2));
      for (const secret of secretTexts) expect(members).toContain(secret);
      totals.secrets += secretTexts.length;
      totals.publicTexts += (unfiltered.match(/PUB\d+/g) ?? []).length;
    }
    // Not vacuous: every kind of case the generator aims at turned up.
    expect(totals.secrets).toBeGreaterThan(1000);
    expect(totals.publicTexts).toBeGreaterThan(1000);
    expect(totals.membersLinks).toBeGreaterThan(500);
    expect(totals.nestedPublicLinks).toBeGreaterThan(10);
  });
});
