// The origin a page may print in an absolute URL (the calendar's webcal link,
// each event's link back in the .ics). Astro.url is built from the Host only if
// security.allowedDomains lists it, and otherwise says localhost:8080 (what the
// calendar buttons showed on the canary), so pages never print it. This reads
// the Host the reader asked for and trusts it only if it is one of ours;
// anything else gets the configured site: the running server's SITE_ORIGIN
// profile when it has one (S2; Astro's own site is fixed at build), else
// Astro's. Forwarded headers are never read.
import { LOCAL_HOSTS, PUBLIC_HOSTS, SITE, profileSite } from '../../server/public-hosts.mjs';

const trusted = new Set(PUBLIC_HOSTS.map((h) => h.hostname));
const local = new Set(LOCAL_HOSTS.map((h) => h.hostname));

type Env = Record<string, string | undefined>;

/** @param site Astro's configured `site`; the built-in one if none. @param env the server's, for SITE_ORIGIN */
export function publicOrigin(request: Request, site: URL | undefined, env: Env = process.env): string {
  const fallback = profileSite(env) ?? (site ?? new URL(SITE)).origin;
  const host = request.headers.get('host')?.trim().toLowerCase();
  if (!host || !/^[a-z0-9.-]+(:\d{1,5})?$/.test(host)) return fallback;
  const [name] = host.split(':') as [string];
  if (trusted.has(name)) return `https://${name}`;
  // A local run keeps its own port and scheme; the pod's fallback address is not a Host the reader sent.
  if (local.has(name)) return `${new URL(request.url).protocol}//${host}`;
  return fallback;
}

/** The calendar feed as a phone subscribes to it: webcal needs no scheme but the host. */
export function feedWebcal(request: Request, site: URL | undefined, env: Env = process.env): string {
  return `webcal://${new URL(publicOrigin(request, site, env)).host}/calendar.ics`;
}
