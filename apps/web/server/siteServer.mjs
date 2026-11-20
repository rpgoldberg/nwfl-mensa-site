// @ts-check
// The http server in front of Astro's standalone handler. Astro middleware runs
// only for on-request pages; prerendered pages and build assets are served as
// files, so the response policy is applied here, once, for every response.
// Prerendered pages are served from memory with the reader's text size and
// theme stamped on <html>, as the layout does for on-request pages.
import { AsyncResource } from 'node:async_hooks';
import http from 'node:http';
import { stampAccount } from './account.mjs';
import { logEntry } from './log.mjs';
import { cacheControl, cdnCacheControl, isHostOnlyCookie, isLeavingPage, isMachinePath, referrerPolicy, securityHeaders } from './policy.mjs';
import { readPrefs, stampHtml } from './prefs.mjs';
import { renamedPath, resolveOldUrl } from './redirects.mjs';
import { readSession } from './session.mjs';
import { sharedTokenStore } from './token-store.mjs';
import { newTrace, runWithTrace } from './trace.mjs';

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
    console.error(logEntry({ level: 'error', msg: 'dropped a cookie that is not host-only', path: logPath(path), cookie: name }));
    return false;
  });
  if (kept.length > 0) res.setHeader('Set-Cookie', kept);
  else res.removeHeader('Set-Cookie');
}

/**
 * Clear-Site-Data never clears cookies: "cookies" (and "*") reach every cookie
 * of the registered domain, the sign-in provider's too: its issuer origin, the
 * SITE_ORIGIN profile's (server/auth-config.mjs), shares that domain. The other
 * directives are this origin's own, and stay.
 *
 * @param {http.ServerResponse} res
 * @param {string} path
 */
function keepOwnSiteData(res, path) {
  const directives = String(res.getHeader('clear-site-data')).split(',').map((d) => d.trim());
  const kept = directives.filter((d) => d !== '"cookies"' && d !== '"*"');
  if (kept.length === directives.length) return;
  console.error(logEntry({ level: 'error', msg: 'dropped Clear-Site-Data directives that clear cookies', path: logPath(path) }));
  if (kept.length > 0) res.setHeader('Clear-Site-Data', kept.join(', '));
  else res.removeHeader('Clear-Site-Data');
}

/**
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} path
 * @param {Readonly<Record<string, string>>} headers the security headers
 * @param {string | undefined} [decoded] the path as the handler reads it
 */
function applyPolicy(req, res, path, headers, decoded) {
  const handlerReferrer = res.getHeader('referrer-policy');
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  // LINKS L4: the leaving page by the raw path, the one the handler serves, or the request target
  // as written: new URL reads //out/<id> as host "out", and the handler serves it as the page.
  const served = [decoded, normalisePath(String(req.url).replace(/[?#][\s\S]*$/, ''))];
  // No referrer from it, and a handler's own no-referrer is never loosened, on any path.
  if (isLeavingPage(path, ...served) || referrerPolicy(path, handlerReferrer) === 'no-referrer') res.setHeader('Referrer-Policy', 'no-referrer');
  const setsCookie = res.hasHeader('set-cookie');
  if (setsCookie) keepHostOnlyCookies(res, path);
  if (res.hasHeader('clear-site-data')) keepOwnSiteData(res, path);
  const cache = cacheControl({
    path,
    served,
    cookieHeader: req.headers.cookie,
    status: res.statusCode,
    setsCookie,
    handler: res.getHeader('cache-control'),
  });
  res.setHeader('Cache-Control', cache);
  const cdn = cdnCacheControl(cache);
  if (cdn) res.setHeader('CDN-Cache-Control', cdn);
  // A page differs by cookie (session, reader settings), so a cache keyed on
  // the URL alone must not hand one reader's copy to another. Browsers honour
  // Vary; many CDNs do not, so a page is private too (CACHEPREF, policy.mjs).
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

/**
 * LAUNCH-FIX-1: the paths of the site's own error page (src/pages/500.astro, built at deploy time).
 * Asked for by name it answers 500, as it does when a request fails: never 200, so nothing stores it
 * or lists it as a page.
 */
const ERROR_PAGE = '/500';
const ERROR_PATHS = new Set([ERROR_PAGE, `${ERROR_PAGE}.html`]);

/**
 * MACHINE-ROUTE: a fault on a call under the machine route's prefixes, as a Connect error with the
 * route's own fixed words for `internal` (machine-route.mjs CODE_MESSAGES).
 */
export const MACHINE_FAULT = JSON.stringify({ code: 'internal', message: 'the call failed' });

/**
 * The error page, status 500, in the reader's text size and theme. Signed out as it was built: it
 * reads no session, so what failed cannot fail it too. Nothing of the failure is in it.
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} html
 */
function serveErrorPage(req, res, html) {
  const body = stampHtml(html, readPrefs(req.headers.cookie));
  res.statusCode = 500;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(req.method === 'HEAD' ? undefined : body);
}

/** @typedef {import('./redirects.mjs').Tables} Redirects */
/**
 * @typedef {{ pages?: ReadonlyMap<string, string>, redirects?: Redirects, sessionKey?: Buffer | undefined, formAction?: string[], machine?: import('./machine-route.mjs').MachineHandler }} SiteOptions
 * pages: prerendered HTML by path; redirects: the old-site table; sessionKey: to
 * read the session on prerendered pages; formAction: origins a form may lead to
 * (the sign-in provider); machine: the machine clients' route (MACHINE-ROUTE), none
 * in a public-only build or with no API
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
 * does carry them goes on to Astro, which compares the origin. The one exception,
 * in serve: a POST to the machine route (MACHINE-ROUTE), whose clients are no
 * browser and send none. It reads and sets no cookie, so a cross-site form has no
 * session to ride on, and it is refused without a bearer, which a cross-site
 * browser cannot attach (that takes a preflight, and the route answers none).
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
 * LG-N3: a path as it may be logged: a URL's pathname, cut at a query or fragment that was
 * percent-encoded into it (%3F, %23), which the pathname keeps and decoding would turn back into
 * one. The request's own query never reaches a pathname.
 *
 * @param {string} pathname
 * @returns {string}
 */
export function logPath(pathname) {
  return pathname.replace(/[?#][\s\S]*$|%(3f|23)[\s\S]*$/i, '');
}

/**
 * The class name of a failure, safe to log: a bounded identifier or a fixed word, never free text.
 *
 * @param {unknown} err
 * @returns {string}
 */
function errorName(err) {
  if (!(err instanceof Error)) return 'NonError';
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(err.name) ? err.name : 'Error';
}

/** The calendar feed's two paths (fc CALFEED): /calendar.ics, and /events.ics, the same feed. */
const FEED_PATHS = new Set(['/calendar.ics', '/events.ics']);
const UA_MAX = 200;

/**
 * fc CALFEED: one line per fetch of the calendar feed, so a calendar service's fetches can be seen at
 * the origin: the path (never the query), the status, the body's bytes and the User-Agent, cut to one
 * bounded printable line. Never the address it came from.
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} path
 */
function logFeedFetch(req, res, path) {
  let bytes = 0;
  /** @param {unknown} chunk @param {unknown} [encoding] */
  const count = (chunk, encoding) => {
    if (typeof chunk === 'string') bytes += Buffer.byteLength(chunk, typeof encoding === 'string' ? /** @type {BufferEncoding} */ (encoding) : 'utf8');
    else if (chunk instanceof Uint8Array) bytes += chunk.byteLength;
  };
  const write = res.write;
  const end = res.end;
  /** @type {any} */ (res).write = function (/** @type {unknown[]} */ ...args) {
    count(args[0], args[1]);
    return write.apply(this, /** @type {any} */ (args));
  };
  /** @type {any} */ (res).end = function (/** @type {unknown[]} */ ...args) {
    if (typeof args[0] !== 'function') count(args[0], args[1]);
    return end.apply(this, /** @type {any} */ (args));
  };
  // Bound to the request's context: 'close' fires from the socket, outside it, and the line carries its trace id.
  res.once('close', AsyncResource.bind(() => {
    const ua = String(req.headers['user-agent'] ?? '').replace(/[^\x20-\x7e]/g, '?').slice(0, UA_MAX);
    console.log(logEntry({ level: 'info', msg: 'calendar feed', path, status: res.statusCode, bytes: req.method === 'HEAD' ? 0 : bytes, ua }));
  }));
}

/**
 * The request's URL, read as a path on this site and never as an authority: only an origin-form
 * target (one that starts with "/") is read, after a fixed authority, so //host/x is the path
 * //host/x and nothing in a target can make the URL unreadable. A backslash in the path is kept
 * as one (%5C, which normalisePath refuses), never read as a "/". null for anything else: an
 * absolute-form target, the asterisk form.
 *
 * @param {string | undefined} target
 * @returns {URL | null}
 */
export function originFormUrl(target) {
  if (!target?.startsWith('/')) return null;
  const path = target.replace(/^[^?#]*/, (p) => p.replaceAll('\\', '%5C'));
  return URL.parse(`http://site.invalid${path}`);
}

/**
 * A decoded path as a Location value: each segment percent-encoded again, so a renamed page whose
 * path decodes to a non-ASCII or reserved character redirects to that same path.
 *
 * @param {string} path
 */
function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
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
export function withSitePolicy(handler, { pages = new Map(), redirects, sessionKey, formAction = [], machine } = {}) {
  const headers = securityHeaders({ formAction });
  // LG-N3: each request is served inside a trace minted here (trace.mjs: never a browser's).
  return (req, res) => runWithTrace(newTrace(), () => serve(req, res));
  /** @type {http.RequestListener} */
  function serve(req, res) {
    const url = originFormUrl(req.url);
    const raw = url?.pathname ?? '';
    /** What a fault answers: set once the path is read. */
    const call = { machine: false };
    /** @param {unknown} err */
    const fail = (err) => {
      // The pathname only (logPath): the query of /auth/callback carries the OIDC code and state. The
      // error's name only: its message can echo what the request sent.
      console.error(logEntry({ level: 'error', msg: 'request failed', path: logPath(raw), err: errorName(err) }));
      if (res.headersSent) {
        res.destroy();
        return;
      }
      // LAUNCH-FIX-1: the site's own error page, for a fault before the handler as for one in it. The
      // plain line where none was built, or where reading or sending it fails too: fail never throws.
      try {
        // MACHINE-ROUTE: a call under the two prefixes gets a Connect error, as the route's own
        // refusals are, never the page; its client reads no HTML.
        if (call.machine) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(MACHINE_FAULT);
          return;
        }
        const errorPage = pages.get(ERROR_PAGE);
        if (errorPage !== undefined) {
          serveErrorPage(req, res, errorPage);
          return;
        }
      } catch {
        // Fall through to the plain line.
      }
      res.statusCode = 500;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Internal Server Error');
    };
    // Everything a request runs here is inside the guard: no request may end the process.
    try {
      route(req, res, url, raw, fail, call);
    } catch (err) {
      fail(err);
    }
  }

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @param {URL | null} url
   * @param {string} raw
   * @param {(err: unknown) => void} fail
   * @param {{ machine: boolean }} call
   */
  function route(req, res, url, raw, fail, call) {
    dropForwardedHost(req);
    // A fixed reason only: the target is the caller's text.
    if (!url) console.log(logEntry({ level: 'warn', msg: 'bad request target', reason: 'not a path on this site' }));
    const path = url ? normalisePath(raw) : undefined;
    // MACHINE-ROUTE: by the decoded path, exactly the two prefixes; no old URL or renamed page is under them.
    const machinePath = isMachinePath(path);
    call.machine = machinePath;
    const renamed = path === undefined || machinePath ? undefined : renamedPath(path);
    const old = redirects && path !== undefined && !renamed && !machinePath ? resolveOldUrl(path, redirects) : undefined;
    beforeHeaders(res, () => {
      if (old?.status === 410) res.statusCode = 410;
      // The cache rule reads the raw path: only a plain /_astro/ name is immutable.
      applyPolicy(req, res, raw, headers, path);
    });
    if (path !== undefined && FEED_PATHS.has(path)) logFeedFetch(req, res, path);
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
      res.writeHead(301, { Location: `${encodePath(renamed)}${/** @type {URL} */ (url).search}` });
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
    if (originUnknown(req) && !(machinePath && req.method === 'POST')) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Forbidden');
      return;
    }
    if (machinePath) {
      // Never Astro: the route, or nothing at all. Inside the guard, as Astro is: no request may end the process.
      // A throw before its first await reaches serve's own guard; a rejection, fail.
      if (machine) Promise.resolve(machine(req, res, /** @type {string} */ (path))).catch(fail);
      else {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Not found');
      }
      return;
    }
    const html = pages.get(path);
    if (html !== undefined && (req.method === 'GET' || req.method === 'HEAD')) {
      if (ERROR_PATHS.has(path)) serveErrorPage(req, res, html);
      else servePrerendered(req, res, html, sessionKey);
      return;
    }
    try {
      Promise.resolve(handler(req, res)).catch(fail);
    } catch (err) {
      fail(err);
    }
  }
}

/**
 * @param {Handler} handler
 * @param {SiteOptions} [opts]
 */
export function createSiteServer(handler, opts) {
  return http.createServer(withSitePolicy(handler, opts));
}
