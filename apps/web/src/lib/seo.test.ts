import { describe, expect, it } from 'vitest';
import { CANONICAL_HOST, robotsTxt, sitemapXml } from './seo';

describe('robots.txt', () => {
  it('lets search engines index the canonical host, apart from sign-in and the reader controls', () => {
    expect(CANONICAL_HOST).toBe('nwflorida.us');
    expect(robotsTxt('nwflorida.us')).toBe(
      ['User-agent: *', 'Disallow: /prefs', 'Disallow: /sign-in', 'Disallow: /sign-out', 'Disallow: /signed-out', 'Disallow: /auth/', 'Disallow: /officer-area', '', 'Sitemap: https://nwflorida.us/sitemap.xml', ''].join('\n'),
    );
  });

  it('keeps every other host, the canary included, out of search engines', () => {
    for (const host of ['nwfl-canary.mindsignals1.com', 'localhost', 'www.nwflorida.us']) {
      expect(robotsTxt(host), host).toBe('User-agent: *\nDisallow: /\n');
    }
  });
});

describe('sitemap.xml', () => {
  const xml = sitemapXml();
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

  it('is a sitemap of absolute https URLs on the canonical host', () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')).toBe(true);
    for (const url of urls) expect(url).toMatch(/^https:\/\/nwflorida\.us\//);
  });

  it('lists the nine sections, Search, Help and the home-screen how-to, and nothing behind sign-in', () => {
    expect(urls).toEqual(
      ['/', '/about', '/join', '/officers', '/governance', '/news', '/minutes', '/events', '/finances', '/search', '/help', '/home-screen'].map((p) => `https://nwflorida.us${p}`),
    );
  });
});
