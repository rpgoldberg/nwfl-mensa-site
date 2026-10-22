// @ts-check
// The http server in front of Astro's standalone handler. Astro middleware runs
// only for on-request pages; prerendered pages and build assets are served as
// files, so the response policy is applied here, once, for every response.
import http from 'node:http';
import { SECURITY_HEADERS, cacheControl } from './policy.mjs';

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
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
function applyPolicy(req, res) {
  const path = new URL(req.url ?? '/', 'http://site.invalid').pathname;
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  const cache = cacheControl({
    path,
    cookieHeader: req.headers.cookie,
    status: res.statusCode,
    setsCookie: res.hasHeader('set-cookie'),
  });
  res.setHeader('Cache-Control', cache);
  // A page differs by cookie (session, reader settings), so a cache keyed on
  // the URL alone must not hand one reader's copy to another.
  if (!cache.endsWith('immutable')) res.setHeader('Vary', 'Cookie');
}

/**
 * Wrap a request handler so every response carries the site policy, and
 * answer the health probe without touching Astro.
 *
 * @param {Handler} handler
 * @returns {http.RequestListener}
 */
export function withSitePolicy(handler) {
  return (req, res) => {
    beforeHeaders(res, () => applyPolicy(req, res));
    if (req.url === '/healthz') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('ok');
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

/** @param {Handler} handler */
export function createSiteServer(handler) {
  return http.createServer(withSitePolicy(handler));
}
