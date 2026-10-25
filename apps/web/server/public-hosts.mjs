// The hosts this site answers to, in one place: Astro's security.allowedDomains
// (astro.config.mjs) trusts them to set the request's origin, and publicOrigin
// (src/lib/origin.ts) trusts only them when a page builds an absolute URL.

/** @typedef {{ hostname: string, protocol: 'http' | 'https' }} PublicHost */

/** The configured site: where every other Host falls back to. */
export const SITE = 'https://nwflorida.us';

/** @type {readonly PublicHost[]} */
export const PUBLIC_HOSTS = [
  { hostname: 'nwflorida.us', protocol: 'https' },
  { hostname: 'www.nwflorida.us', protocol: 'https' },
  { hostname: 'canary.nwflorida.us', protocol: 'https' },
  // A likely future domain.
  { hostname: 'nwflmensa.us', protocol: 'https' },
  { hostname: 'www.nwflmensa.us', protocol: 'https' },
  // The first canary's address, until its tunnel route is gone.
  { hostname: 'nwfl-canary.mindsignals1.com', protocol: 'https' },
];

/**
 * Local runs: `npm start` in Chromium over http://localhost (which keeps Secure
 * cookies on loopback), and the e2e suite through its TLS edge.
 *
 * @type {readonly PublicHost[]}
 */
export const LOCAL_HOSTS = [
  { hostname: 'localhost', protocol: 'http' },
  { hostname: 'localhost', protocol: 'https' },
];
