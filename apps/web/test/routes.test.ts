// The route registry the redaction leak test crawls (e2e/routes.ts) is the
// pages folder, exactly: a new page or endpoint fails here until it is either
// crawled as a LIVE route or listed as STATIC (REDACT R2b, "every output format").
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LIVE, OFFICER, SIGNED_IN, STATIC, crawlSeeds, patternOf, routeOf } from '../e2e/routes';

const PAGES = 'src/pages';
const files = readdirSync(PAGES, { recursive: true })
  .map(String)
  .filter((f) => /\.(astro|ts|js|mjs|md|mdx|html)$/.test(f));
const byRoute = new Map(files.map((f) => [routeOf(f), f]));

describe('the route registry (e2e/routes.ts)', () => {
  it('names every route under src/pages/, once, and nothing else', () => {
    const listed = [...Object.keys(LIVE), ...Object.keys(STATIC), ...Object.keys(OFFICER), ...Object.keys(SIGNED_IN)];
    expect(listed.filter((r, i) => listed.indexOf(r) !== i)).toEqual([]);
    expect(listed.sort()).toEqual([...byRoute.keys()].sort());
  });

  it('lists as STATIC only pages that read nothing from the API', () => {
    const readers = Object.keys(STATIC).filter((route) => {
      const source = readFileSync(path.join(PAGES, byRoute.get(route)!), 'utf8');
      return /\bliveData\b|lib\/api\//.test(source);
    });
    // W-SIGNUP D3: the callback alone, and only for the session a sign-in has just opened (below).
    expect(readers).toEqual(['/auth/callback']);
  });

  it('lets the callback read the API only for the session a completed sign-in has just opened, with the person\'s own token (W-SIGNUP D3)', () => {
    const source = readFileSync(path.join(PAGES, byRoute.get('/auth/callback')!), 'utf8');
    expect(source).not.toMatch(/\bliveData\b|lib\/api\/officer/);
    expect([...source.matchAll(/lib\/api\/[a-z]+/g)].map((m) => m[0])).toEqual(['lib/api/membership']);
    expect([...source.matchAll(/membershipApi\(\)/g)]).toHaveLength(1);
    expect(source).toMatch(/out\.session === undefined \? out\.location : await firstStop\(out\.session, out\.location, membershipApi\(\), deps\)/);
  });

  it('lists as OFFICER only pages that read the API with the officer\'s own client, and send the public to sign in', () => {
    for (const route of Object.keys(OFFICER)) {
      const source = readFileSync(path.join(PAGES, byRoute.get(route)!), 'utf8');
      expect(source, route).not.toMatch(/\bliveData\b/);
      expect(source, route).toMatch(/lib\/api\/(officer|membership|editor)/);
      // EDITOR E3: the edit page alone keeps the text of a save posted after the session ended (below).
      if (route === '/officer-area/news/[id]') expect(source, route).toMatch(/if \(!session && kept === undefined\) return (Astro\.redirect|signInFirst)\(/);
      // Round 2: the auto-save endpoint answers a script, so no session is a plain 401, never a page.
      else if (route === '/officer-area/news/[id]/autosave') expect(source, route).toMatch(/if \(!session\) return answer\(401, /);
      else expect(source, route).toMatch(/if \(!session\) return (Astro\.redirect|signInFirst)\(/);
    }
  });

  it("keeps a session-less save's text on the edit page from the post alone, reading nothing from the API (EDITOR E3)", () => {
    const source = readFileSync(path.join(PAGES, byRoute.get('/officer-area/news/[id]')!), 'utf8');
    // Only a post, only with no session, and only from what was posted: before any API call is made.
    expect(source).toMatch(/const kept = !session && Astro\.request\.method === 'POST' \? await keptText\(Astro\.request\) : undefined;/);
    expect(source.indexOf('const kept =')).toBeLessThan(source.indexOf('editorApi()'));
  });

  it('lists the writer screens as OFFICER routes (EDITOR E3)', () => {
    expect(Object.keys(OFFICER)).toEqual(
      expect.arrayContaining(['/officer-area/news', '/officer-area/news/new', '/officer-area/news/[id]', '/officer-area/news/[id]/preview', '/officer-area/news/[id]/autosave']),
    );
  });

  it('lists as SIGNED_IN only pages that read the API with the person\'s own token, and send the public to sign in (W-SIGNUP)', () => {
    expect(Object.keys(SIGNED_IN)).toEqual(['/account']);
    for (const route of Object.keys(SIGNED_IN)) {
      const source = readFileSync(path.join(PAGES, byRoute.get(route)!), 'utf8');
      expect(source, route).not.toMatch(/\bliveData\b|lib\/api\/officer/);
      expect(source, route).toMatch(/lib\/api\/membership/);
      expect(source, route).toMatch(/if \(!session\) return (Astro\.redirect|signInFirst)\(/);
    }
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
    expect(patternOf('/documents/3e4f5a6b-7c8d-4e9f-a0b1-c2d3e4f5a6b7.pdf')).toBe('/documents/[id].pdf');
    expect(patternOf('/no/such/thing')).toBeUndefined();
  });

  it('seeds the crawl with every route, an event and a file by the id the API gave and a series date as <series>_<date>', () => {
    const seeds = crawlSeeds({
      eventIds: ['3e4f5a6b-7c8d-4e9f-a0b1-c2d3e4f5a6b7', '0b9c1f5e-4c1a-4d55-9a3e-2f7d8e6a1b20:2026-11-04'],
      months: ['2026-11'],
      fileIds: ['9c51279e-6426-43e6-a52c-3fa78711e10b'],
    });
    expect(seeds).toContain('/documents/9c51279e-6426-43e6-a52c-3fa78711e10b.pdf');
    expect(seeds).toContain('/events/3e4f5a6b-7c8d-4e9f-a0b1-c2d3e4f5a6b7.ics');
    expect(seeds).toContain('/events/0b9c1f5e-4c1a-4d55-9a3e-2f7d8e6a1b20_2026-11-04');
    expect(seeds).toContain('/events?month=2026-11');
    const covered = new Set(seeds.map((url) => patternOf(new URL(url, 'https://x.invalid').pathname)));
    expect([...Object.keys(LIVE), ...Object.keys(STATIC), ...Object.keys(OFFICER), ...Object.keys(SIGNED_IN)].filter((r) => !covered.has(r))).toEqual([]);
  });
});
