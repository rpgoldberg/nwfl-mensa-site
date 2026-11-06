// @ts-check
// The response policy for every answer the server sends: the security headers
// (ported from fc-mobile's nginx config) and the cache rule (R26). The server
// wrapper (serve.mjs) applies both, so prerendered pages, build assets and
// on-request pages all carry the same set.
import { readCookie } from './cookies.mjs';

/** The cookie the OIDC session will live in (W7). Its presence makes a response private. */
export const SESSION_COOKIE = '__Host-nwfl-session';

/** @param {string[]} formAction origins a form may lead to, besides this site */
const csp = (formAction) =>
  [
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
    // Sign-out posts here and is redirected to the sign-in provider, which
    // browsers check against form-action: its origin comes from config (W4).
    ["form-action 'self'", ...formAction].join(' '),
  ].join('; ');

/**
 * @param {{ formAction?: string[] }} opts
 * @returns {Readonly<Record<string, string>>}
 */
export function securityHeaders({ formAction = [] }) {
  return Object.freeze({
    'Content-Security-Policy': csp(formAction),
    'Strict-Transport-Security': 'max-age=31536000',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
}

/**
 * LINKS L4: the leaving page /out/<id>, and anything under /out, in any case, behind
 * any number of slashes (the router serves //out/<id> as the page).
 */
const LEAVING_PAGE = /^\/+out(\/|$)/i;

/**
 * The leaving page, by any of the paths given (the raw one, the one the handler serves).
 *
 * @param {...(string | undefined)} paths
 */
export function isLeavingPage(...paths) {
  return paths.some((path) => path !== undefined && LEAVING_PAGE.test(path));
}

/**
 * The Referrer-Policy for a path: none at all on the leaving page, so the site a
 * reader leaves for (by Continue, the countdown or the 303) learns nothing of the
 * page they came from; the site's policy everywhere else. A handler may make it
 * stricter, never looser: its no-referrer stands on any path (as cacheControl
 * keeps a handler's private), and any other value it set is the site's.
 *
 * @param {string} path
 * @param {string | number | string[] | undefined} [handler] the Referrer-Policy the handler set, if any
 */
export function referrerPolicy(path, handler) {
  const strict = handler !== undefined && String(handler).split(',').some((token) => token.trim().toLowerCase() === 'no-referrer');
  return strict || isLeavingPage(path) ? 'no-referrer' : 'strict-origin-when-cross-origin';
}

/** The headers with no sign-in provider configured. */
export const SECURITY_HEADERS = securityHeaders({});

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

/** An anonymous page: shared caches keep it a minute, and may serve it a minute stale while they fetch a fresh copy. */
export const PUBLIC_CACHE = 'public, max-age=60, stale-while-revalidate=60';

/**
 * The Cache-Control for one response. Anonymous pages are public, briefly; a
 * request with the session cookie, or a response that sets any cookie, is never
 * stored (R26); an error, the reader's or the server's, and the health probe
 * are never stored, so a page that is back a moment later is not kept missing.
 * A handler may make its response private (A14: a members copy read with a
 * reader's token), never looser: any other Cache-Control it set is overridden.
 * The leaving page (LINKS L4) depends on the reader's cookie and token, so every
 * answer under it, the 301 of a trailing slash too, is private.
 *
 * @param {{ path: string, served?: ReadonlyArray<string | undefined>, cookieHeader: string | undefined, status: number, setsCookie: boolean, handler?: string | number | string[] | undefined }} r
 *   served: the other forms of the path the handler may serve it as (decoded, or as the request
 *   target wrote it); handler: the Cache-Control the handler set, if any
 */
export function cacheControl(r) {
  const handlerPrivate = r.handler !== undefined && /(^|,)\s*private\s*(,|$)/i.test(String(r.handler));
  if (r.setsCookie || handlerPrivate || hasCookie(r.cookieHeader, SESSION_COOKIE) || isLeavingPage(r.path, ...(r.served ?? []))) return 'private, no-store';
  if (r.status >= 400 || r.path === '/healthz') return 'no-store';
  if (HASHED_ASSET.test(r.path) && r.status === 200) return 'public, max-age=31536000, immutable';
  return PUBLIC_CACHE;
}

/**
 * D6: a private response tells a CDN too. Cloudflare ignores Vary: Cookie, and a
 * zone rule can override the origin's Cache-Control, but not CDN-Cache-Control.
 * Nothing on any other response, so an anonymous one keeps its headers.
 *
 * @param {string} cache the response's Cache-Control (cacheControl)
 * @returns {string | undefined}
 */
export function cdnCacheControl(cache) {
  return cache.startsWith('private') ? 'no-store' : undefined;
}
