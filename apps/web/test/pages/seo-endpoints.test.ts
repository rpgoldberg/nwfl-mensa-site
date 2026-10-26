import { describe, expect, it } from 'vitest';
import { GET as robots, prerender as robotsPrerendered } from '../../src/pages/robots.txt';
import { GET as sitemap, prerender as sitemapPrerendered } from '../../src/pages/sitemap.xml';

type Ctx = Parameters<typeof robots>[0];

describe('GET /robots.txt', () => {
  it('answers per host, on request, as plain text', async () => {
    expect(robotsPrerendered).toBe(false);
    const canonical = (await robots({ url: new URL('https://nwflorida.us/robots.txt') } as unknown as Ctx)) as Response;
    expect(canonical.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await canonical.text()).toContain('Sitemap: https://nwflorida.us/sitemap.xml');
    const canary = (await robots({ url: new URL('https://canary.nwflorida.us/robots.txt') } as unknown as Ctx)) as Response;
    expect(await canary.text()).toBe('User-agent: *\nDisallow: /\n');
    const newCanary = (await robots({ url: new URL('https://canary.nwflmensa.us/robots.txt') } as unknown as Ctx)) as Response;
    expect(await newCanary.text()).toBe('User-agent: *\nDisallow: /\n');
  });
});

describe('GET /sitemap.xml', () => {
  it('is built once, as XML', async () => {
    expect(sitemapPrerendered).toBe(true);
    const res = (await sitemap({} as unknown as Ctx)) as Response;
    expect(res.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    expect(await res.text()).toContain('<loc>https://nwflorida.us/about</loc>');
  });
});
