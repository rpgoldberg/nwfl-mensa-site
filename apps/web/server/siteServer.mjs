// @ts-check
// The http server in front of Astro's standalone handler. Astro middleware runs
// only for on-request pages; prerendered pages and build assets are served as
// files, so the response policy is applied here, once, for every response.
// Prerendered pages are served from memory with the reader's text size and
// theme stamped on <html>, as the layout does for on-request pages.
import http from 'node:http';
import { SECURITY_HEADERS, cacheControl, isHostOnlyCookie } from './policy.mjs';
import { readPrefs, stampHtml } from './prefs.mjs';

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
    return reason === undefined ? writeHead.call(this, status) : writeHead.call(this, status, reason);
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
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} path
 */
function applyPolicy(req, res, path) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  const setsCookie = res.hasHeader('set-cookie');
  if (setsCookie) keepHostOnlyCookies(res, path);
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
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} html
 */
function servePrerendered(req, res, html) {
  const body = stampHtml(html, readPrefs(req.headers.cookie));
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(req.method === 'HEAD' ? undefined : body);
}

/**
 * Wrap a request handler so every response carries the site policy, serve the
 * prerendered pages, and answer the health probe without touching Astro.
 *
 * @param {Handler} handler
 * @param {{ pages?: ReadonlyMap<string, string> }} [opts] prerendered HTML by path
 * @returns {http.RequestListener}
 */
export function withSitePolicy(handler, { pages = new Map() } = {}) {
  return (req, res) => {
    const path = new URL(req.url ?? '/', 'http://site.invalid').pathname;
    beforeHeaders(res, () => applyPolicy(req, res, path));
    if (req.url === '/healthz') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('ok');
      return;
    }
    const html = pages.get(path);
    if (html !== undefined && (req.method === 'GET' || req.method === 'HEAD')) {
      servePrerendered(req, res, html);
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
 * @param {{ pages?: ReadonlyMap<string, string> }} [opts]
 */
export function createSiteServer(handler, opts) {
  return http.createServer(withSitePolicy(handler, opts));
}
