import { describe, expect, it } from 'vitest';
import { CANONICAL_HOST, robotsTxt, sitemapXml } from './seo';

describe('robots.txt', () => {
  it('lets search engines index the canonical host, apart from sign-in, the reader controls and the leaving page (LINKS L4)', () => {
    expect(CANONICAL_HOST).toBe('nwflorida.us');
    expect(robotsTxt('nwflorida.us')).toBe(
      ['User-agent: *', 'Disallow: /prefs', 'Disallow: /sign-in', 'Disallow: /sign-out', 'Disallow: /signed-out', 'Disallow: /auth/', 'Disallow: /officer-area', 'Disallow: /account', 'Disallow: /out/', '', 'Sitemap: https://nwflorida.us/sitemap.xml', ''].join('\n'),
    );
  });

  it('keeps every other host, the canary included, out of search engines, but lets Google Calendar fetch the feed', () => {
    for (const host of ['canary.nwflorida.us', 'canary.nwflmensa.us', 'localhost', 'www.nwflorida.us']) {
      expect(robotsTxt(host), host).toBe('User-agent: *\nAllow: /calendar.ics\nDisallow: /\n');
    }
  });

  it('does not block the feed on the canonical host', () => {
    const lines = robotsTxt('nwflorida.us').split('\n');
    expect(lines).not.toContain('Disallow: /');
    expect(lines).not.toContain('Disallow: /calendar.ics');
    expect(lines.filter((l) => l.startsWith('Disallow:')).every((l) => !'/calendar.ics'.startsWith(l.slice('Disallow: '.length)))).toBe(true);
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
