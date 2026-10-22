// @ts-check
// The response policy for every answer the server sends: the security headers
// (ported from fc-mobile's nginx config) and the cache rule (R26). The server
// wrapper (serve.mjs) applies both, so prerendered pages, build assets and
// on-request pages all carry the same set.
import { readCookie } from './cookies.mjs';

/** The cookie the OIDC session will live in (W7). Its presence makes a response private. */
export const SESSION_COOKIE = '__Host-nwfl-session';

const CSP = [
  "default-src 'self'",
  // Same-origin files only, never inline: the install button (R27) now, the
  // service worker later. Every page works without them.
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

/** @type {Readonly<Record<string, string>>} */
export const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': CSP,
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
});

/**
 * @param {string} policy
 * @returns {Record<string, string[]>}
 */
export function parseCsp(policy) {
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const part of policy.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out[name] = sources;
  }
  return out;
}

/**
 * @param {string | undefined} cookieHeader
 * @param {string} name
 */
export function hasCookie(cookieHeader, name) {
  return readCookie(cookieHeader, name) !== undefined;
}

/**
 * MT-30: a cookie this site may set. Only a __Host- cookie (Secure, Path=/, no
 * Domain) stays on this exact host; the staging host shares a parent domain
 * with other apps, so anything wider could reach or be shadowed by them.
 *
 * @param {string} setCookie one Set-Cookie value
 */
export function isHostOnlyCookie(setCookie) {
  const [pair = '', ...rest] = setCookie.split(';').map((part) => part.trim());
  const attrs = rest.map((a) => a.toLowerCase());
  return (
    pair.startsWith('__Host-') &&
    attrs.includes('secure') &&
    attrs.includes('path=/') &&
    !attrs.some((a) => a.startsWith('domain'))
  );
}

/**
 * Astro's build output: the file name carries a content hash, so it never
 * changes. A plain name on the raw path only: an encoded path such as
 * /_astro/..%2fabout would otherwise be a page, cached for a year.
 */
const HASHED_ASSET = /^\/_astro\/[\w.-]+$/;

/**
 * The Cache-Control for one response. Anonymous pages are public for 60 s; a
 * request with the session cookie, or a response that sets any cookie, is never
 * stored (R26); a server error and the health probe are never stored.
 *
 * @param {{ path: string, cookieHeader: string | undefined, status: number, setsCookie: boolean }} r
 */
export function cacheControl(r) {
  if (r.setsCookie || hasCookie(r.cookieHeader, SESSION_COOKIE)) return 'private, no-store';
  if (r.status >= 500 || r.path === '/healthz') return 'no-store';
  if (HASHED_ASSET.test(r.path) && r.status === 200) return 'public, max-age=31536000, immutable';
  return 'public, max-age=60';
}
