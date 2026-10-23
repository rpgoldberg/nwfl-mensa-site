// @ts-check
// The http server in front of Astro's standalone handler. Astro middleware runs
// only for on-request pages; prerendered pages and build assets are served as
// files, so the response policy is applied here, once, for every response.
// Prerendered pages are served from memory with the reader's text size and
// theme stamped on <html>, as the layout does for on-request pages.
import http from 'node:http';
import { stampAccount } from './account.mjs';
import { cacheControl, isHostOnlyCookie, securityHeaders } from './policy.mjs';
import { readPrefs, stampHtml } from './prefs.mjs';
import { renamedPath, resolveOldUrl } from './redirects.mjs';
import { readSession } from './session.mjs';
import { sharedTokenStore } from './token-store.mjs';

/** @typedef {(req: http.IncomingMessage, res: http.ServerResponse) => unknown} Handler */

/**
 * Run `listener` just before the status line and headers go out, however the
 * handler sends them: `writeHead` with or without headers, or implicitly on
 * the first write (Node calls `this.writeHead` for that too).
 *
 * @param {http.ServerResponse} res
 * @param {() => void} listener
 */
function beforeHeaders(res, listener) {
  const writeHead = res.writeHead;
  /**
   * @this {http.ServerResponse}
   * @param {number} status
   * @param {...any} rest
   */
  function patched(status, ...rest) {
    const reason = typeof rest[0] === 'string' ? rest.shift() : undefined;
    const headers = rest[0];
    // Fold the handler's headers in first, so the policy has the last word.
    if (Array.isArray(headers)) {
      for (let i = 0; i < headers.length; i += 2) this.setHeader(headers[i], headers[i + 1]);
    } else if (headers) {
      for (const [name, value] of Object.entries(headers)) if (value !== undefined) this.setHeader(name, value);
    }
    this.statusCode = status;
    listener();
    res.writeHead = writeHead;
    // The policy may change the status (a retired URL's page is always 410).
    return reason === undefined || this.statusCode !== status
      ? writeHead.call(this, this.statusCode)
      : writeHead.call(this, status, reason);
  }
  // writeHead returns the polymorphic `this`, which a plain function cannot state.
  res.writeHead = /** @type {typeof res.writeHead} */ (/** @type {unknown} */ (patched));
}

/**
 * MT-30: whatever a page or handler tries, only host-only cookies leave the
 * server. Any other is dropped and logged by name (never by value).
 *
 * @param {http.ServerResponse} res
 * @param {string} path
 */
function keepHostOnlyCookies(res, path) {
  const header = res.getHeader('set-cookie');
  const cookies = Array.isArray(header) ? header : [String(header)];
  const kept = cookies.filter((cookie) => {
    if (isHostOnlyCookie(cookie)) return true;
    const name = cookie.replace(/=.*$/s, '').trim();
    console.error(JSON.stringify({ level: 'error', msg: 'dropped a cookie that is not host-only', path, cookie: name }));
    return false;
  });
  if (kept.length > 0) res.setHeader('Set-Cookie', kept);
  else res.removeHeader('Set-Cookie');
}

/**
 * Clear-Site-Data never clears cookies: "cookies" (and "*") reach every cookie
 * of the registered domain, the sign-in provider's at login.nwflorida.us too.
 * The other directives are this origin's own, and stay.
 *
 * @param {http.ServerResponse} res
 * @param {string} path
 */
function keepOwnSiteData(res, path) {
  const directives = String(res.getHeader('clear-site-data')).split(',').map((d) => d.trim());
  const kept = directives.filter((d) => d !== '"cookies"' && d !== '"*"');
  if (kept.length === directives.length) return;
  console.error(JSON.stringify({ level: 'error', msg: 'dropped Clear-Site-Data directives that clear cookies', path }));
  if (kept.length > 0) res.setHeader('Clear-Site-Data', kept.join(', '));
  else res.removeHeader('Clear-Site-Data');
}

/**
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} path
 * @param {Readonly<Record<string, string>>} headers the security headers
 */
function applyPolicy(req, res, path, headers) {
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  const setsCookie = res.hasHeader('set-cookie');
  if (setsCookie) keepHostOnlyCookies(res, path);
  if (res.hasHeader('clear-site-data')) keepOwnSiteData(res, path);
  const cache = cacheControl({
    path,
    cookieHeader: req.headers.cookie,
    status: res.statusCode,
    setsCookie,
  });
  res.setHeader('Cache-Control', cache);
  // A page differs by cookie (session, reader settings), so a cache keyed on
  // the URL alone must not hand one reader's copy to another.
  if (!cache.endsWith('immutable')) res.setHeader('Vary', 'Cookie');
}

/**
 * A prerendered page, in the reader's text size and theme, and with their own
 * account area when signed in (it was built with Sign in).
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} html
 * @param {Buffer | undefined} key
 */
function servePrerendered(req, res, html, key) {
  const session = readSession(req.headers.cookie, key, Math.floor(Date.now() / 1000), sharedTokenStore());
  const body = stampAccount(stampHtml(html, readPrefs(req.headers.cookie)), session);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(req.method === 'HEAD' ? undefined : body);
}

/** @typedef {import('./redirects.mjs').Tables} Redirects */
/**
 * @typedef {{ pages?: ReadonlyMap<string, string>, redirects?: Redirects, sessionKey?: Buffer | undefined, formAction?: string[] }} SiteOptions
 * pages: prerendered HTML by path; redirects: the old-site table; sessionKey: to
 * read the session on prerendered pages; formAction: origins a form may lead to
 * (the sign-in provider)
 */

const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];
const FORWARDED_HOST = ['x-forwarded-host', 'x-forwarded-port'];

/**
 * The site sees the Host the reader asked for, never a forwarded host or port:
 * Astro would build the request URL from them, so a spoofed one could make the
 * canary's robots.txt the canonical one. The edge's X-Forwarded-Proto stays.
 *
 * @param {http.IncomingMessage} req
 */
function dropForwardedHost(req) {
  for (const name of FORWARDED_HOST) delete req.headers[name];
  const raw = req.rawHeaders;
  for (let i = raw.length - 2; i >= 0; i -= 2) if (FORWARDED_HOST.includes(String(raw[i]).toLowerCase())) raw.splice(i, 2);
}

/**
 * A state-changing request must say where it comes from. Astro's origin check
 * lets one through that carries neither an Origin nor a Sec-Fetch-Site header;
 * every browser sends at least one, so such a request is refused here. One that
 * does carry them goes on to Astro, which compares the origin.
 *
 * @param {http.IncomingMessage} req
 */
function originUnknown(req) {
  return !SAFE_METHODS.includes(String(req.method)) && !req.headers.origin && req.headers['sec-fetch-site'] !== 'same-origin';
}

/**
 * The path as the static handler will read it: percent-decoded. undefined when
 * decoding would make it another path (an encoded / or \\, which the handler
 * would follow out of a folder), when it holds an encoded NUL, or when the
 * encoding is broken. The policy then decides on the very path served.
 *
 * @param {string} raw the URL's pathname, dot segments already resolved
 * @returns {string | undefined}
 */
export function normalisePath(raw) {
  if (/%(2f|5c|00)/i.test(raw)) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

/**
 * Wrap a request handler so every response carries the site policy, answer
 * old URLs (R16) and the site's own renamed pages, serve the prerendered pages, and answer the health probe
 * without touching Astro.
 *
 * @param {Handler} handler
 * @param {SiteOptions} [opts]
 * @returns {http.RequestListener}
 */
export function withSitePolicy(handler, { pages = new Map(), redirects, sessionKey, formAction = [] } = {}) {
  const headers = securityHeaders({ formAction });
  return (req, res) => {
    dropForwardedHost(req);
    const url = new URL(req.url ?? '/', 'http://site.invalid');
    const raw = url.pathname;
    const path = normalisePath(raw);
    const renamed = path === undefined ? undefined : renamedPath(path);
    const old = redirects && path !== undefined && !renamed ? resolveOldUrl(path, redirects) : undefined;
    beforeHeaders(res, () => {
      if (old?.status === 410) res.statusCode = 410;
      // The cache rule reads the raw path: only a plain /_astro/ name is immutable.
      applyPolicy(req, res, raw, headers);
    });
    if (path === undefined) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Bad request');
      return;
    }
    if (req.url === '/healthz') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('ok');
      return;
    }
    if (renamed) {
      // The query goes along: a month of the calendar is still that month.
      res.writeHead(301, { Location: `${renamed}${url.search}` });
      res.end();
      return;
    }
    if (old && 'location' in old) {
      res.writeHead(old.status, { Location: old.location });
      res.end();
      return;
    }
    if (old) {
      // GET and HEAD get the site's own gone page; anything else a bare 410.
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.end();
        return;
      }
      req.url = '/gone';
    }
    if (originUnknown(req)) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Forbidden');
      return;
    }
    const html = pages.get(path);
    if (html !== undefined && (req.method === 'GET' || req.method === 'HEAD')) {
      servePrerendered(req, res, html, sessionKey);
      return;
    }
    /** @param {unknown} err */
    const fail = (err) => {
      console.error(JSON.stringify({ level: 'error', msg: 'request failed', path: req.url, err: String(err) }));
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.statusCode = 500;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Internal Server Error');
    };
    try {
      Promise.resolve(handler(req, res)).catch(fail);
    } catch (err) {
      fail(err);
    }
  };
}

/**
 * @param {Handler} handler
 * @param {SiteOptions} [opts]
 */
export function createSiteServer(handler, opts) {
  return http.createServer(withSitePolicy(handler, opts));
}
