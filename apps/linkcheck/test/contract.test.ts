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
export const LINKS_CONTRACT_SHA256 = 'b0e3eed8d272e27cd59f4cc6c4647d992b7204c402719e9194fc26c355276269';

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

  it.each(cases.filter((c) => c.out !== null).map((c) => c.out as string))('the kept form %j is L2-shaped', (out) => {
    expect(l2Accepts(out)).toBe(true);
  });

  it.each(cases.map((c) => [c.in, c.in === c.out] as const))('L2 accepts %j exactly when it is its own kept form (%s)', (input, kept) => {
    expect(l2Accepts(input)).toBe(kept);
  });
});

// CONTRACT 6 and 7, as a property: a copy of L2's url rules (links-l2 0897636, apps/api/src/load/links.ts
// urlOf, webUrl, HOST and MAILTO), run over the fixture and a generated corpus. Every keptForm is null or
// L2-shaped and its own kept form, and L2 accepts an input exactly when keptForm leaves it as it is.
const L2_PRINTABLE = /^[!-~]+$/;
const L2_HOST = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const L2_MAILTO = /^mailto:[A-Za-z0-9.!$&'*+/=^_`{|}~-]+@([^@]+)$/;

function l2Accepts(value: string): boolean {
  if (value.length > 2048 || !L2_PRINTABLE.test(value)) return false;
  if (value.startsWith('mailto:')) {
    const domain = L2_MAILTO.exec(value)?.[1];
    return domain !== undefined && L2_HOST.test(domain);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.href === value && parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' && parsed.port === '' && L2_HOST.test(parsed.hostname);
}

/** A seeded generator (mulberry32), so the corpus is the same on every run. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function corpus(): string[] {
  const chars = [...Array.from({ length: 0x7f - 0x20 }, (_, i) => String.fromCharCode(0x20 + i)), 'ü', 'İ', 'ß', '。', 'Ａ', '­', '․', '﹒'];
  const hex = Array.from({ length: 256 }, (_, i) => i.toString(16).toUpperCase().padStart(2, '0'));
  const out = cases.flatMap((c) => (c.out === null ? [c.in] : [c.in, c.out]));
  for (const c of chars) {
    out.push(`https://a${c}b.example.org/`, `https://${c}a.example.org/`, `https://a${c}.example.org/`, `https://example.a${c}/`, `https://example.${c}a/`);
    out.push(`http://a${c}b.example.org/p`, `https://example.org/${c}`, `https://example.org/?q=${c}`, `https://example.org/#${c}`, `https://example.org${c}/`);
    out.push(`mailto:a${c}b@example.org`, `mailto:x~@a${c}b.example.org`, `mailto:x~@example.org${c}`, `mailto:x~@${c}example.org`);
  }
  for (const h of hex) out.push(`mailto:a%${h}b@example.org`, `https://a%${h}b.example.org/`, `mailto:x~@a%${h}b.example.org`, `https://example.org/%${h}`);
  const random = seeded(20261105);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
  const pieces = ['a', 'b', 'z', '0', '9', '-', '_', '.', '..', 'xn--', '%41', '%2e', '%23', 'ü', 'İ', '。', 'A', '~', '#', '?', '@', ':', '[', ']', '!', '$', "'", '"', '`', '{', '|', '\\', '/'];
  const label = (): string => Array.from({ length: 1 + Math.floor(random() * 6) }, () => pick(pieces)).join('');
  for (let i = 0; i < 4000; i += 1) {
    const host = Array.from({ length: 1 + Math.floor(random() * 4) }, label).join('.');
    const scheme = pick(['https://', 'http://', 'HTTPS://', 'www.', 'mailto:', 'mailto:x~@', 'mailto:a.b+c@']);
    const tail = pick(['', '/', '/p?q=1', '/#f', '?subject=x', '.', '..', ':443/', `/${'a'.repeat(2030)}`, `/${'ü'.repeat(400)}`]);
    out.push(`${scheme}${host}${tail}`);
  }
  return out;
}

describe('every kept form is L2-shaped (property, CONTRACT 6, 7)', () => {
  const inputs = corpus();

  it(`holds over ${String(inputs.length)} inputs`, () => {
    const bad: string[] = [];
    for (const input of inputs) {
      const out = keptForm(input);
      if (out !== null && !(l2Accepts(out) && keptForm(out) === out)) bad.push(`kept ${JSON.stringify(input)} -> ${JSON.stringify(out)}`);
      if (l2Accepts(input) !== (out === input)) bad.push(`L2 ${String(l2Accepts(input))} on ${JSON.stringify(input)} -> ${JSON.stringify(out)}`);
    }
    expect(bad.slice(0, 40)).toEqual([]);
  });

  it('the corpus holds refused and kept inputs of both kinds', () => {
    const outs = inputs.map((i) => keptForm(i));
    expect(outs.filter((o) => o === null).length).toBeGreaterThan(1000);
    expect(outs.filter((o) => o?.startsWith('https:')).length).toBeGreaterThan(300);
    expect(outs.filter((o) => o?.startsWith('mailto:')).length).toBeGreaterThan(100);
  });
});
