import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SIZE_COOKIE, THEME_COOKIE } from '../prefs.mjs';
import { SECURITY_HEADERS, SESSION_COOKIE, cacheControl, cdnCacheControl, hasCookie, isHostOnlyCookie, parseCsp, referrerPolicy, securityHeaders } from '../policy.mjs';

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

describe('referrerPolicy (LINKS L4)', () => {
  it('sends no referrer at all from the leaving page, so the site a reader leaves for learns nothing of where they came from', () => {
    for (const path of ['/out', '/out/', '/out/abcdefghijklmnopqrstuvwxyz', '/out/x/y', '/OUT/abcdefghijklmnopqrstuvwxyz', '/Out/x']) expect(referrerPolicy(path), path).toBe('no-referrer');
  });

  it("keeps the site's policy everywhere else", () => {
    for (const path of ['/', '/outings', '/about', '/documents/x.pdf', '/news/out', '/out-of-date']) expect(referrerPolicy(path), path).toBe('strict-origin-when-cross-origin');
  });

  it('knows the leaving page behind repeated slashes, which the router serves as the page', () => {
    for (const path of ['//out/abcdefghijklmnopqrstuvwxyz', '///out/x', '//OUT/x', '//out']) expect(referrerPolicy(path), path).toBe('no-referrer');
    for (const path of ['//outings', '//news/out', '/x//out/y']) expect(referrerPolicy(path), path).toBe('strict-origin-when-cross-origin');
  });

  it("never loosens a handler's no-referrer, on any path; a looser one the handler set is the site's", () => {
    for (const handler of ['no-referrer', 'No-Referrer', ' no-referrer ', 'strict-origin, no-referrer', ['no-referrer']]) expect(referrerPolicy('/about', handler), String(handler)).toBe('no-referrer');
    for (const handler of [undefined, 'unsafe-url', 'origin', 'no-referrer-when-downgrade', 7]) expect(referrerPolicy('/about', handler), String(handler)).toBe('strict-origin-when-cross-origin');
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

const UUID = 'f1000000-0000-4000-8000-000000000010';
/** CACHEPREF: what a shared cache may keep; nothing on it reads a cookie. */
const SHARED = ['/calendar.ics', '/events.ics', `/events/${UUID}.ics`, '/robots.txt', '/sitemap.xml', '/manifest.webmanifest', '/fonts/OFL-Lexend.txt', '/icons/icon-192.png', '/licences/pdfjs-LICENSE.txt', '/scripts/size.js'];

describe('cacheControl (R26)', () => {
  const anon = { path: '/', cookieHeader: undefined, status: 200, setsCookie: false };
  const PUBLIC = 'public, max-age=60, stale-while-revalidate=60';
  const PRIVATE = 'private, max-age=60, stale-while-revalidate=60';

  it("keeps a page in the reader's own browser only, for 60 seconds, cookie or not: its bytes differ by cookie (CACHEPREF)", () => {
    for (const cookieHeader of [undefined, `${THEME_COOKIE}=dark`, `${SIZE_COOKIE}=175`, 'other=1']) {
      for (const path of ['/', '/about', '/news', '/events', `/events/${UUID}`, `/read/${UUID}`, '/officers', '/search']) {
        const cache = cacheControl({ ...anon, path, cookieHeader });
        expect(cache, `${path} ${cookieHeader}`).toBe(PRIVATE);
        // D6: a CDN is told too, so a zone rule that overrides Cache-Control still keeps no copy.
        expect(cdnCacheControl(cache), path).toBe('no-store');
      }
    }
  });

  it("keeps a public file private too: the API serves a member a different copy under the same URL (CACHEPREF)", () => {
    expect(cacheControl({ ...anon, path: `/documents/${UUID}.pdf` })).toBe(PRIVATE);
  });

  it('lets a shared cache keep only what no cookie changes: the feeds, robots.txt, the sitemap and the files in public/', () => {
    for (const cookieHeader of [undefined, `${THEME_COOKIE}=dark`]) {
      for (const path of SHARED) expect(cacheControl({ ...anon, path, cookieHeader }), `${path} ${cookieHeader}`).toBe(PUBLIC);
    }
  });

  it('shares nothing that only looks like one of them: a page, a folder, a deeper or an encoded path', () => {
    for (const path of ['/calendar.ics/x', '/calendar', '/events/x/y.ics', `/events/${UUID}`, '/scripts/', '/scripts/a/b.js', '/scripts/..%2fabout', '/icons', '/fonts/%2e%2e', '/robots.txt/', '/sitemap.xml.html', '/x/manifest.webmanifest']) {
      expect(cacheControl({ ...anon, path }), path).toBe(PRIVATE);
    }
  });

  it('shares every file in public/ (served as it is, to every reader)', () => {
    const root = fileURLToPath(new URL('../../public', import.meta.url));
    const files = readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => `/${relative(root, join(e.parentPath, e.name)).split(sep).join('/')}`);
    expect(files.length).toBeGreaterThan(10);
    for (const path of files) expect(cacheControl({ ...anon, path }), path).toBe(PUBLIC);
  });

  it('shares an endpoint only if its source reads no cookie, session or reader', () => {
    for (const route of ['calendar.ics.ts', 'events.ics.ts', 'events/[id].ics.ts', 'robots.txt.ts', 'sitemap.xml.ts']) {
      // The code, not its comments: a comment may say who the feed is for.
      const source = readFileSync(fileURLToPath(new URL(`../../src/pages/${route}`, import.meta.url)), 'utf8').replace(/\/\/.*$/gm, '');
      expect(source, route).toMatch(/export const GET/);
      expect(source, route).not.toMatch(/cookie|session|locals|prefs|reader/i);
    }
  });

  it('caches a redirect like a page: it is not an error', () => {
    for (const status of [301, 302, 303, 307, 308]) expect(cacheControl({ ...anon, status }), String(status)).toBe(PRIVATE);
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
      expect(cacheControl({ ...anon, path }), path).toBe(PRIVATE);
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

// A14: a members response stays private even if a handler is the only one that knows it is one, and a CDN
// rule that overrides the origin's Cache-Control still sees CDN-Cache-Control (D6).
describe('the leaving page is never stored (LINKS L4)', () => {
  const anon = { cookieHeader: undefined, setsCookie: false };
  it('whatever its answer: the page, the 303, the 301 of a trailing slash and the 404', () => {
    for (const status of [200, 301, 303, 404]) {
      for (const path of ['/out/abcdefghijklmnopqrstuvwxyz', '/out/x/', '//out/x', '/OUT/x']) expect(cacheControl({ ...anon, path, status }), `${status} ${path}`).toBe('private, no-store');
    }
  });

  it('by the path the handler serves, when the raw one hides it', () => {
    expect(cacheControl({ ...anon, path: '/%6Fut/x/', served: ['/out/x/'], status: 301 })).toBe('private, no-store');
    expect(cacheControl({ ...anon, path: '/x/', served: [undefined, '//out/x/'], status: 301 })).toBe('private, no-store');
    expect(cacheControl({ ...anon, path: '/outings', served: ['/outings', undefined], status: 200 })).toBe('private, max-age=60, stale-while-revalidate=60');
  });
});

describe('a handler that marks its response private (A14)', () => {
  const anon = { path: '/documents/f1000000-0000-4000-8000-000000000010.pdf', cookieHeader: undefined, status: 200, setsCookie: false };

  it('keeps it private and unstored, cookie or not', () => {
    expect(cacheControl({ ...anon, handler: 'private, no-store' })).toBe('private, no-store');
    expect(cacheControl({ ...anon, handler: 'Private' })).toBe('private, no-store');
    expect(cacheControl({ ...anon, handler: ['no-cache', 'private'] })).toBe('private, no-store');
  });

  it('never lets a handler loosen the rule: anything else it set is overridden as before', () => {
    expect(cacheControl({ ...anon, handler: 'public, max-age=99999' })).toBe('private, max-age=60, stale-while-revalidate=60');
    expect(cacheControl({ ...anon, path: '/calendar.ics', handler: 'public, max-age=99999' })).toBe('public, max-age=60, stale-while-revalidate=60');
    expect(cacheControl({ ...anon, handler: 'public, max-age=99999', cookieHeader: `${SESSION_COOKIE}=abc` })).toBe('private, no-store');
    expect(cacheControl({ ...anon, handler: 'no-store', status: 404 })).toBe('no-store');
    expect(cacheControl({ ...anon, handler: undefined })).toBe('private, max-age=60, stale-while-revalidate=60');
  });
});

// SIGNOUT: sign-out clears no cache (Clear-Site-Data "cache" stalled the installed app), which is safe
// only while no members' copy is ever stored. Each members-only answer is private, no-store, a CDN
// told so too, whatever its status and whatever its handler set. e2e/signout.spec.ts asks the server.
describe('every members-only answer is never stored (SIGNOUT)', () => {
  const MEMBERS_ONLY = [
    '/read/f1000000-0000-4000-8000-000000000011',
    '/documents/f1000000-0000-4000-8000-000000000011.pdf',
    '/account',
    '/officer-area',
    '/officer-area/approval-rules',
    '/officer-area/sign-ups',
    '/news',
  ];
  const signedIn = { cookieHeader: `__Host-nwfl-size=4; ${SESSION_COOKIE}=v1.abc`, setsCookie: false };

  it('to a signed-in reader, at every status, whatever the handler set', () => {
    for (const path of MEMBERS_ONLY) {
      for (const status of [200, 303, 403, 404, 503]) {
        for (const handler of [undefined, 'public, max-age=31536000, immutable', 'no-store', 'private', 'private, no-store']) {
          const cache = cacheControl({ ...signedIn, path, status, handler });
          expect(cache, `${path} ${status} ${handler}`).toBe('private, no-store');
          expect(cdnCacheControl(cache)).toBe('no-store');
        }
      }
    }
  });

  it('the members copy and its page as the handler marks them, even with no session cookie on the request', () => {
    for (const path of MEMBERS_ONLY.slice(0, 2)) expect(cacheControl({ path, cookieHeader: undefined, status: 200, setsCookie: false, handler: 'private, no-store' })).toBe('private, no-store');
  });
});

describe('cdnCacheControl (D6)', () => {
  it('is no-store whenever the rule is private, and absent otherwise, so an anonymous response keeps its headers', () => {
    expect(cdnCacheControl('private, no-store')).toBe('no-store');
    expect(cdnCacheControl('private, max-age=60, stale-while-revalidate=60')).toBe('no-store');
    for (const rule of ['public, max-age=60, stale-while-revalidate=60', 'no-store', 'public, max-age=31536000, immutable']) expect(cdnCacheControl(rule), rule).toBeUndefined();
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
