// The route registry the redaction leak test crawls (e2e/routes.ts) is the
// pages folder, exactly: a new page or endpoint fails here until it is either
// crawled as a LIVE route or listed as STATIC (REDACT R2b, "every output format").
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LIVE, STATIC, crawlSeeds, patternOf, routeOf } from '../e2e/routes';

const PAGES = 'src/pages';
const files = readdirSync(PAGES, { recursive: true })
  .map(String)
  .filter((f) => /\.(astro|ts|js|mjs|md|mdx|html)$/.test(f));
const byRoute = new Map(files.map((f) => [routeOf(f), f]));

describe('the route registry (e2e/routes.ts)', () => {
  it('names every route under src/pages/, once, and nothing else', () => {
    const listed = [...Object.keys(LIVE), ...Object.keys(STATIC)];
    expect(listed.filter((r) => r in LIVE && r in STATIC)).toEqual([]);
    expect(listed.sort()).toEqual([...byRoute.keys()].sort());
  });

  it('lists as STATIC only pages that read nothing from the API', () => {
    const readers = Object.keys(STATIC).filter((route) => {
      const source = readFileSync(path.join(PAGES, byRoute.get(route)!), 'utf8');
      return /\bliveData\b|lib\/api\//.test(source);
    });
    expect(readers).toEqual([]);
  });

  it('lists as LIVE every page that reads the API', () => {
    const notReaders = Object.keys(LIVE).filter((route) => !/\bliveData\b/.test(readFileSync(path.join(PAGES, byRoute.get(route)!), 'utf8')));
    expect(notReaders).toEqual([]);
  });

  it('maps a file to its route', () => {
    expect(routeOf('index.astro')).toBe('/');
    expect(routeOf('officer-area/index.astro')).toBe('/officer-area');
    expect(routeOf('events/[id].ics.ts')).toBe('/events/[id].ics');
    expect(routeOf(String.raw`events\[id].astro`)).toBe('/events/[id]');
    expect(routeOf('robots.txt.ts')).toBe('/robots.txt');
  });

  it('matches a path to its route, the most specific first', () => {
    expect(patternOf('/finances')).toBe('/finances');
    expect(patternOf('/events/0b9c1f5e-4c1a-4d55-9a3e-2f7d8e6a1b20')).toBe('/events/[id]');
    expect(patternOf('/events/0b9c1f5e-4c1a-4d55-9a3e-2f7d8e6a1b20_2026-11-04.ics')).toBe('/events/[id].ics');
    expect(patternOf('/no/such/thing')).toBeUndefined();
  });

  it('seeds the crawl with every route, an event by the id the API gave and a series date as <series>_<date>', () => {
    const seeds = crawlSeeds({ eventIds: ['3e4f5a6b-7c8d-4e9f-a0b1-c2d3e4f5a6b7', '0b9c1f5e-4c1a-4d55-9a3e-2f7d8e6a1b20:2026-11-04'], months: ['2026-11'] });
    expect(seeds).toContain('/events/3e4f5a6b-7c8d-4e9f-a0b1-c2d3e4f5a6b7.ics');
    expect(seeds).toContain('/events/0b9c1f5e-4c1a-4d55-9a3e-2f7d8e6a1b20_2026-11-04');
    expect(seeds).toContain('/events?month=2026-11');
    const covered = new Set(seeds.map((url) => patternOf(new URL(url, 'https://x.invalid').pathname)));
    expect([...Object.keys(LIVE), ...Object.keys(STATIC)].filter((r) => !covered.has(r))).toEqual([]);
  });
});
