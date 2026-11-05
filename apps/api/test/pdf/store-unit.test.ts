// REDACT R3b: what keys a redacted copy. Two audiences share a copy exactly
// when the engine would be given the same inputs for the same original.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { DEFAULT_LINK_ORIGIN, ENGINE_VERSION, canonicalInputs, inputHash, inputHashV1, linkOrigin } from '../../src/pdf/store.js';

const version = (name: string): string => (JSON.parse(readFileSync(new URL(`../../node_modules/${name}/package.json`, import.meta.url), 'utf8')) as { version: string }).version;
const SHA = Buffer.alloc(32, 1);

describe('ENGINE_VERSION', () => {
  it('names each installed engine library at its version, so an upgrade remakes every copy', () => {
    expect(ENGINE_VERSION).toContain(`pdfium-${version('@embedpdf/pdfium')}`);
    expect(ENGINE_VERSION).toContain(`pdf-lib-${version('@cantoo/pdf-lib')}`);
    expect(ENGINE_VERSION).toContain(`pdfjs-${version('pdfjs-dist')}`);
  });

  it('names the boxes\' revision, so no copy boxed the old, widened way is taken for an exact-fit one (REDACT-LOOK)', () => {
    // 0022 leaves the members' and the officers' inputs as they were: only this keys their copies anew.
    expect(ENGINE_VERSION.split('+')).toContain('box-exact');
    expect(ENGINE_VERSION).not.toBe('pdfium-2.15.1+pdf-lib-2.11.1+pdfjs-6.4.299+gate-r3b');
  });

  it('names the links\' revision (LINKS L3), the first bump after the two issues were loaded under box-exact', () => {
    expect(ENGINE_VERSION).toBe('pdfium-2.15.1+pdf-lib-2.11.1+pdfjs-6.4.299+gate-r3b+box-exact+links-1');
  });
});

describe('inputHash', () => {
  it('is 32 bytes and ignores the order, repeats and spacing of the quotes', () => {
    const a = inputHash(SHA, { quotes: ['Bo', ' Quillon Brask '], redactsAny: true });
    expect(a).toHaveLength(32);
    expect(inputHash(SHA, { quotes: ['Quillon Brask', 'Bo', 'Bo', ''], redactsAny: true }).equals(a)).toBe(true);
  });

  it('changes with the original, the quotes, redactsAny, the image action and the engine', () => {
    const base = inputHash(SHA, { quotes: ['Bo'], redactsAny: true });
    expect(inputHash(Buffer.alloc(32, 2), { quotes: ['Bo'], redactsAny: true }).equals(base)).toBe(false);
    expect(inputHash(SHA, { quotes: ['Bob'], redactsAny: true }).equals(base)).toBe(false);
    expect(inputHash(SHA, { quotes: ['Bo'], redactsAny: false }).equals(base)).toBe(false);
    expect(inputHash(SHA, { quotes: ['Bo'], redactsAny: true }, 'another-engine').equals(base)).toBe(false);
    expect(inputHash(SHA, { quotes: ['Bo'], redactsAny: true, image: 'show' }).equals(base)).toBe(true);
    expect(inputHash(SHA, { quotes: ['Bo'], redactsAny: true, image: 'blur' }).equals(base)).toBe(false);
    expect(inputHash(SHA, { quotes: ['Bo'], redactsAny: true, image: 'hide' }).equals(inputHash(SHA, { quotes: ['Bo'], redactsAny: true, image: 'blur' }))).toBe(false);
  });
});

describe('inputHashV1 (LINKS L3 fix 2, N5): the key of a copy made before links-1, for the ledger\'s older rows', () => {
  const BOX_EXACT = 'pdfium-2.15.1+pdf-lib-2.11.1+pdfjs-6.4.299+gate-r3b+box-exact';
  it('is the hash of exactly the text main\'s inputHash hashed: version 1, no origin and no links', () => {
    const request = { quotes: [' Kestrel Ambry', 'Bo Tamsin', 'Kestrel Ambry'], redactsAny: true, image: 'blur' as const, origin: 'https://ignored.example', links: [] };
    const text = `{"v":1,"engine":"${BOX_EXACT}","original":"${SHA.toString('hex')}","redactsAny":true,"quotes":["Bo Tamsin","Kestrel Ambry"],"image":"blur"}`;
    expect(inputHashV1(SHA, request, BOX_EXACT)).toEqual(createHash('sha256').update(text).digest());
    expect(inputHashV1(SHA, { quotes: [], redactsAny: false }, BOX_EXACT)).toEqual(createHash('sha256').update(`{"v":1,"engine":"${BOX_EXACT}","original":"${SHA.toString('hex')}","redactsAny":false,"quotes":[],"image":"show"}`).digest());
    expect(inputHashV1(SHA, request, BOX_EXACT)).not.toEqual(inputHash(SHA, request, BOX_EXACT));
  });
});

describe('inputHash v2 (LINKS L3): the origin and the links that pass', () => {
  const ORIGIN = 'https://nwflorida.us';
  const id = (c: string): string => c.repeat(26);
  const LINKS = [
    { id: id('b'), page: 2, rect: [72, 600, 200.25, 614] as const, label: 'Link to site.example' },
    { id: id('a'), page: 1, rect: [72, 700, 200, 714] as const, label: 'Link to mail.example' },
  ];
  const URLS = { [id('a')]: 'mailto:games~@mail.example', [id('b')]: 'https://site.example/p' };
  const request = { quotes: ['Bo'], redactsAny: true, origin: ORIGIN, links: LINKS };

  it('is canonical: version 2, every input by name, the links sorted by id with their urls, rects to hundredths', () => {
    expect(canonicalInputs(SHA, request, 'e', URLS)).toBe(
      JSON.stringify({
        v: 2,
        engine: 'e',
        original: '01'.repeat(32),
        redactsAny: true,
        quotes: ['Bo'],
        image: 'show',
        origin: ORIGIN,
        links: [
          { id: id('a'), page: 1, rect: [72, 700, 200, 714], url: 'mailto:games~@mail.example', label: 'Link to mail.example' },
          { id: id('b'), page: 2, rect: [72, 600, 200.25, 614], url: 'https://site.example/p', label: 'Link to site.example' },
        ],
      }),
    );
  });

  it('ignores the order of the links and a rect moved less than half a hundredth', () => {
    const base = inputHash(SHA, request, 'e', URLS);
    expect(inputHash(SHA, { ...request, links: [...LINKS].reverse() }, 'e', URLS).equals(base)).toBe(true);
    expect(inputHash(SHA, { ...request, links: [{ ...LINKS[0]!, rect: [72.004, 600, 200.25, 614] }, LINKS[1]!] }, 'e', URLS).equals(base)).toBe(true);
  });

  it('changes with the origin and with each field of each link: id, page, rect, url and label', () => {
    const base = inputHash(SHA, request, 'e', URLS);
    const differs = (changed: Parameters<typeof inputHash>[1], urls: Record<string, string> = URLS): boolean => !inputHash(SHA, changed, 'e', urls).equals(base);
    expect(differs({ ...request, origin: 'https://nwflmensa.us' })).toBe(true);
    expect(differs({ ...request, links: [LINKS[0]!] })).toBe(true);
    expect(differs({ ...request, links: [] })).toBe(true);
    expect(differs({ ...request, links: [{ ...LINKS[0]!, id: id('c') }, LINKS[1]!] }, { ...URLS, [id('c')]: 'https://site.example/p' })).toBe(true);
    expect(differs({ ...request, links: [{ ...LINKS[0]!, page: 3 }, LINKS[1]!] })).toBe(true);
    expect(differs({ ...request, links: [{ ...LINKS[0]!, rect: [72, 600, 200.26, 614] }, LINKS[1]!] })).toBe(true);
    expect(differs({ ...request, links: [{ ...LINKS[0]!, label: 'Link to else.example' }, LINKS[1]!] })).toBe(true);
    expect(differs(request, { ...URLS, [id('b')]: 'https://site.example/q' })).toBe(true);
  });

  it('refuses a link with no url to hash, rather than hash it as nothing', () => {
    expect(() => inputHash(SHA, request, 'e', { [id('a')]: 'mailto:games~@mail.example' })).toThrow('every link needs its url to be hashed');
  });

  it('takes the origin from LINK_ORIGIN, the site by default, and refuses one that is not https and a host', () => {
    expect(DEFAULT_LINK_ORIGIN).toBe('https://nwflorida.us');
    expect(linkOrigin({})).toBe('https://nwflorida.us');
    expect(linkOrigin({ LINK_ORIGIN: 'https://nwflmensa.us' })).toBe('https://nwflmensa.us');
    for (const bad of ['http://nwflorida.us', 'https://nwflorida.us/', 'https://evil.example/out/x', '']) expect(() => linkOrigin({ LINK_ORIGIN: bad }), bad).toThrow('LINK_ORIGIN must be https:// and the site\'s host, with no path');
    // In production (NODE_ENV=production, as the image sets it) no localhost, with a port or without (N5); tests and e2e keep it.
    for (const local of ['https://localhost', 'https://localhost:4321']) {
      expect(() => linkOrigin({ NODE_ENV: 'production', LINK_ORIGIN: local }), local).toThrow('LINK_ORIGIN must be the site\'s public https host in production, not localhost');
      expect(linkOrigin({ NODE_ENV: 'test', LINK_ORIGIN: local }), local).toBe(local);
    }
    expect(linkOrigin({ NODE_ENV: 'production', LINK_ORIGIN: 'https://nwflmensa.us' })).toBe('https://nwflmensa.us');
    // A request without an origin is hashed with LINK_ORIGIN's, as inputsFor gives it.
    expect(inputHash(SHA, { quotes: ['Bo'], redactsAny: true }).equals(inputHash(SHA, { quotes: ['Bo'], redactsAny: true, origin: linkOrigin(), links: [] }))).toBe(true);
  });
});
