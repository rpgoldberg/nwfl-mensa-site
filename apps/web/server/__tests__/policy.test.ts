import { describe, expect, it } from 'vitest';
import { SECURITY_HEADERS, SESSION_COOKIE, cacheControl, hasCookie, isHostOnlyCookie, parseCsp, securityHeaders } from '../policy.mjs';

describe('security headers', () => {
  it('sends CSP, HSTS, nosniff, Referrer-Policy, Permissions-Policy and COOP, and nothing else', () => {
    expect(Object.keys(SECURITY_HEADERS).sort()).toEqual(
      [
        'Content-Security-Policy',
        'Cross-Origin-Opener-Policy',
        'Permissions-Policy',
        'Referrer-Policy',
        'Strict-Transport-Security',
        'X-Content-Type-Options',
      ].sort(),
    );
    expect(SECURITY_HEADERS['X-Content-Type-Options']).toBe('nosniff');
    expect(SECURITY_HEADERS['Strict-Transport-Security']).toMatch(/^max-age=\d{8,}$/);
    expect(SECURITY_HEADERS['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(SECURITY_HEADERS['Cross-Origin-Opener-Policy']).toBe('same-origin');
    expect(SECURITY_HEADERS['Permissions-Policy']).toMatch(/camera=\(\)/);
  });

  it('never allows inline, eval, hashes, nonces or wildcards, in any directive', () => {
    expect(SECURITY_HEADERS['Content-Security-Policy']).not.toMatch(/unsafe-|strict-dynamic|nonce-|sha(256|384|512)-|\*|data:|https?:/);
  });

  it('pins the directives the site needs and nothing wider', () => {
    const csp = parseCsp(SECURITY_HEADERS['Content-Security-Policy'] as string);
    expect(csp['default-src']).toEqual(["'self'"]);
    // Same-origin script files only (the install button; the service worker later), never inline.
    expect(csp['script-src']).toEqual(["'self'"]);
    expect(csp['style-src']).toEqual(["'self'"]);
    expect(csp['img-src']).toEqual(["'self'"]);
    expect(csp['font-src']).toEqual(["'self'"]);
    expect(csp['connect-src']).toEqual(["'self'"]);
    expect(csp['worker-src']).toEqual(["'self'"]);
    expect(csp['manifest-src']).toEqual(["'self'"]);
    expect(csp['frame-src']).toEqual(["'none'"]);
    expect(csp['frame-ancestors']).toEqual(["'none'"]);
    expect(csp['object-src']).toEqual(["'none'"]);
    expect(csp['base-uri']).toEqual(["'none'"]);
    expect(csp['form-action']).toEqual(["'self'"]);
  });

  it('lets a form lead to the sign-in provider (sign-out ends its session there), and to nothing else', () => {
    const headers = securityHeaders({ formAction: ['https://login.nwflorida.us'] });
    expect(parseCsp(headers['Content-Security-Policy'] as string)['form-action']).toEqual(["'self'", 'https://login.nwflorida.us']);
    const { ['Content-Security-Policy']: csp, ...rest } = headers;
    const { ['Content-Security-Policy']: base, ...baseRest } = SECURITY_HEADERS;
    expect(rest).toEqual(baseRest);
    expect(csp?.replace(" https://login.nwflorida.us", '')).toBe(base);
    expect(securityHeaders({})).toEqual(SECURITY_HEADERS);
  });

  it('parses a policy with stray separators', () => {
    expect(parseCsp(" default-src 'self' ;; img-src 'self' ")).toEqual({
      'default-src': ["'self'"],
      'img-src': ["'self'"],
    });
  });
});

describe('hasCookie', () => {
  it('reads the header as the session code will (cookie@2): a spaced name is still the session', () => {
    expect(hasCookie(`${SESSION_COOKIE} =abc`, SESSION_COOKIE)).toBe(true);
    expect(cacheControl({ path: '/', cookieHeader: `${SESSION_COOKIE} =abc`, status: 200, setsCookie: false })).toBe('private, no-store');
  });

  it('never takes a look-alike name for the session: a no-break space or another case', () => {
    expect(hasCookie(`\u00a0${SESSION_COOKIE}=abc`, SESSION_COOKIE)).toBe(false);
    expect(hasCookie('__HOST-nwfl-session=abc', SESSION_COOKIE)).toBe(false);
  });

  it('finds a cookie by exact name only', () => {
    expect(hasCookie('a=1; __Host-nwfl-session=x', SESSION_COOKIE)).toBe(true);
    expect(hasCookie(`${SESSION_COOKIE}=x`, SESSION_COOKIE)).toBe(true);
    expect(hasCookie('x__Host-nwfl-session=1', SESSION_COOKIE)).toBe(false);
    expect(hasCookie('a=1', SESSION_COOKIE)).toBe(false);
    expect(hasCookie(undefined, SESSION_COOKIE)).toBe(false);
  });
});

describe('cacheControl (R26)', () => {
  const anon = { path: '/', cookieHeader: undefined, status: 200, setsCookie: false };
  const PUBLIC = 'public, max-age=60, stale-while-revalidate=60';

  it('lets anyone cache an anonymous page for 60 seconds, and serve it a minute stale while it fetches a fresh copy', () => {
    expect(cacheControl(anon)).toBe(PUBLIC);
    expect(cacheControl({ ...anon, path: '/about', cookieHeader: 'other=1' })).toBe(PUBLIC);
    expect(cacheControl({ ...anon, path: '/calendar.ics' })).toBe(PUBLIC);
  });

  it('caches a redirect like a page: it is not an error', () => {
    for (const status of [301, 302, 303, 307, 308]) expect(cacheControl({ ...anon, status }), String(status)).toBe(PUBLIC);
  });

  it('never stores a response to a request that carries the session cookie', () => {
    expect(cacheControl({ ...anon, cookieHeader: `${SESSION_COOKIE}=abc` })).toBe('private, no-store');
    expect(cacheControl({ ...anon, path: '/_astro/site.abc123.css', cookieHeader: `${SESSION_COOKIE}=abc` })).toBe(
      'private, no-store',
    );
    expect(cacheControl({ ...anon, status: 503, cookieHeader: `${SESSION_COOKIE}=abc` })).toBe('private, no-store');
  });

  it('never stores a response that sets a cookie', () => {
    expect(cacheControl({ ...anon, setsCookie: true })).toBe('private, no-store');
  });

  it('caches hashed build assets for a year', () => {
    expect(cacheControl({ ...anon, path: '/_astro/site.abc123.css' })).toBe('public, max-age=31536000, immutable');
  });

  it('caches only a plain file name under /_astro/ for a year, never an encoded path out of it', () => {
    // The static handler decodes %2f, so /_astro/..%2fabout would be the About page.
    for (const path of ['/_astro/..%2fabout', '/_astro/..%2fabout.html', '/_astro/%2e%2e%2fjoin.html', '/_astro/x/y.css', '/_astro/']) {
      expect(cacheControl({ ...anon, path }), path).toBe(PUBLIC);
    }
    expect(cacheControl({ ...anon, path: '/_astro/Base.5t8Gl8HW.css' })).toBe('public, max-age=31536000, immutable');
  });

  it('never stores a missing asset', () => {
    expect(cacheControl({ ...anon, path: '/_astro/gone.css', status: 404 })).toBe('no-store');
  });

  it('never stores the health probe', () => {
    expect(cacheControl({ ...anon, path: '/healthz' })).toBe('no-store');
  });

  it("never stores an error, the reader's or the server's: a page that is back a moment later must not stay missing", () => {
    for (const status of [400, 403, 404, 410, 413, 500, 502, 503]) expect(cacheControl({ ...anon, status }), String(status)).toBe('no-store');
  });
});

describe('isHostOnlyCookie (MT-30)', () => {
  it('accepts a __Host- cookie that is Secure, on Path=/, with no Domain', () => {
    expect(isHostOnlyCookie('__Host-nwfl-size=3; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly; Secure')).toBe(true);
    expect(isHostOnlyCookie('__Host-a=; path=/; secure')).toBe(true);
  });

  it('refuses anything a parent domain or another path could share', () => {
    for (const cookie of [
      'nwfl-size=3; Path=/; Secure',
      '__host-a=1; Path=/; Secure',
      '__Host-a=1; Path=/',
      '__Host-a=1; Secure',
      '__Host-a=1; Path=/x; Secure',
      '__Host-a=1; Path=/; Secure; Domain=example.com',
      '__Host-a=1; Path=/; Secure; domain=.nwflorida.us',
      '__Secure-a=1; Path=/; Secure',
    ]) {
      expect(isHostOnlyCookie(cookie), cookie).toBe(false);
    }
  });
});
