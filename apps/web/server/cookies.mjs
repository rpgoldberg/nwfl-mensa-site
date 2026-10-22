// @ts-check
// One parser for every cookie the site reads: cookie@2, which the session code
// (W4) will use too, so the cache rule and the session never disagree. It trims
// only the space and tab a Cookie header may carry, and matches names exactly:
// a sibling's "\xa0__Host-…" or "__HOST-…" (accepted by browsers with a
// Domain, as neither is a __Host- name to them) is never taken for ours.
import { parseCookie } from 'cookie';

/**
 * @param {string | null | undefined} header the Cookie request header
 * @param {string} name
 * @returns {string | undefined}
 */
export function readCookie(header, name) {
  return header ? parseCookie(header)[name] : undefined;
}
