// The hosts this site answers to, in one place: Astro's security.allowedDomains
// (astro.config.mjs) trusts them to set the request's origin, and publicOrigin
// (src/lib/origin.ts) trusts only them when a page builds an absolute URL.

import { siteProfile } from './auth-config.mjs';

/** @typedef {{ hostname: string, protocol: 'http' | 'https' }} PublicHost */

/** The fallback with no SITE_ORIGIN profile. */
export const DEFAULT_SITE = 'https://nwflorida.us';

/**
 * S2: SITE_ORIGIN, when it names one of the sign-in profiles (server/auth-config.mjs).
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string | undefined}
 */
export function profileSite(env) {
  const origin = env['SITE_ORIGIN'];
  return siteProfile(origin) ? origin : undefined;
}

/**
 * The configured site, where every other Host falls back to: the SITE_ORIGIN profile, else DEFAULT_SITE.
 *
 * @param {Record<string, string | undefined>} env
 */
export const siteFor = (env) => profileSite(env) ?? DEFAULT_SITE;

/** The configured site for this process (Astro's `site` at build; the server's fallback at run time). */
export const SITE = siteFor(process.env);

/** @type {readonly PublicHost[]} */
export const PUBLIC_HOSTS = [
  { hostname: 'nwflorida.us', protocol: 'https' },
  { hostname: 'www.nwflorida.us', protocol: 'https' },
  { hostname: 'canary.nwflorida.us', protocol: 'https' },
  // The group's new domain (DOMAIN2; ExComm vote pending).
  { hostname: 'nwflmensa.us', protocol: 'https' },
  { hostname: 'www.nwflmensa.us', protocol: 'https' },
  { hostname: 'canary.nwflmensa.us', protocol: 'https' },
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
