// robots.txt and sitemap.xml (R16). Only the canonical host is indexed; any
// other (www before Cloudflare redirects it, the canary, a local run) asks
// search engines to stay out, so no copy of the site competes with it.
import { MORE_PAGES } from './site';

export const CANONICAL_HOST = 'nwflorida.us';

export function robotsTxt(host: string): string {
  if (host !== CANONICAL_HOST) return 'User-agent: *\nDisallow: /\n';
  return [
    'User-agent: *',
    'Disallow: /prefs',
    'Disallow: /sign-in',
    'Disallow: /sign-out',
    'Disallow: /signed-out',
    'Disallow: /auth/',
    'Disallow: /officer-area',
    '',
    `Sitemap: https://${CANONICAL_HOST}/sitemap.xml`,
    '',
  ].join('\n');
}

/** Home, the sections and the public help pages, as absolute https URLs. */
export function sitemapXml(): string {
  const urls = ['/', ...MORE_PAGES.map((p) => p.path)].map((path) => `  <url><loc>https://${CANONICAL_HOST}${path}</loc></url>`);
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">', ...urls, '</urlset>', ''].join('\n');
}
