// Every route the site serves, one entry per file under src/pages/, and how a
// test reaches it (REDACT R2b). test/routes.test.ts fails while a file there
// has no entry, or an entry has no file, so a new page or endpoint cannot ship
// until the redaction leak test (e2e/redaction/) crawls it.
//
//   LIVE    reads the API (liveData): reached with the ids and months the API
//           itself gave, so the crawl sees exactly what the public is served.
//   STATIC  reads nothing from the API (test/routes.test.ts checks its source),
//           and is crawled all the same.
import { eventPath } from '../src/lib/calendar';

export interface RouteContext {
  /** API event ids: a stored event's id, or <series>:<date>. */
  eventIds: readonly string[];
  /** YYYY-MM months to open the calendar at. */
  months: readonly string[];
  /** API file ids: a published item's PDF (REDACT R3c). */
  fileIds?: readonly string[];
}

export const LIVE: Readonly<Record<string, (c: RouteContext) => string[]>> = {
  '/': () => ['/'],
  '/events': (c) => ['/events', ...c.months.map((m) => `/events?month=${m}`)],
  '/events/[id]': (c) => c.eventIds.map(eventPath),
  '/events/[id].ics': (c) => c.eventIds.map((id) => `${eventPath(id)}.ics`),
  '/calendar.ics': () => ['/calendar.ics'],
  '/events.ics': () => ['/events.ics'],
  '/documents/[id].pdf': (c) => (c.fileIds ?? []).map((id) => `/documents/${id}.pdf`),
  '/finances': () => ['/finances'],
  '/officers': () => ['/officers'],
};

export const STATIC: Readonly<Record<string, readonly string[]>> = {
  '/404': ['/404', '/no-such-page'],
  '/about': ['/about'],
  '/auth/callback': ['/auth/callback', '/auth/callback?code=x&state=y'],
  '/gone': ['/gone'],
  '/governance': ['/governance'],
  '/help': ['/help'],
  '/home-screen': ['/home-screen'],
  '/join': ['/join'],
  '/minutes': ['/minutes'],
  '/more': ['/more'],
  // The newsletter list is the bundled fixtures until the archive arrives (MB3, C1).
  '/news': ['/news'],
  '/officer-area': ['/officer-area'],
  '/prefs': ['/prefs'],
  '/robots.txt': ['/robots.txt'],
  // A placeholder: test/search-contract.test.ts holds what it may read once built (R29).
  '/search': ['/search', '/search?q=picnic'],
  '/sign-in': ['/sign-in'],
  '/sign-out': ['/sign-out'],
  '/signed-out': ['/signed-out'],
  '/sitemap.xml': ['/sitemap.xml'],
};

/** The route a file under src/pages/ serves: /events/[id].ics for events/[id].ics.ts. */
export function routeOf(file: string): string {
  const route = file
    .replaceAll('\\', '/')
    .replace(/\.(astro|ts|js|mjs|md|mdx|html)$/, '')
    .replace(/(^|\/)index$/, '');
  return `/${route}`;
}

/** The route pattern a path matches, or undefined. */
export function patternOf(pathname: string): string | undefined {
  const all = [...Object.keys(LIVE), ...Object.keys(STATIC)];
  const exact = all.find((p) => p === pathname);
  if (exact) return exact;
  // The longest pattern first: /events/x.ics is /events/[id].ics, not /events/[id].
  return all
    .filter((p) => p.includes('[') && new RegExp(`^${p.replace(/\./g, '\\.').replace(/\[[^\]]+\]/g, '[^/]+')}$`).test(pathname))
    .sort((a, b) => b.length - a.length)[0];
}

/** Every URL to start a crawl from. */
export function crawlSeeds(c: RouteContext): string[] {
  return [...Object.values(LIVE).flatMap((urls) => urls(c)), ...Object.values(STATIC).flat()];
}
