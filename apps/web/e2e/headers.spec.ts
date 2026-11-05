import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { expect, test, type APIResponse } from '@playwright/test';
import { SESSION_COOKIE, parseCsp, securityHeaders } from '../server/policy.mjs';
import { LINKS_COOKIE, SIZES, SIZE_COOKIE, THEME_COOKIE, sizeSlider } from '../server/prefs.mjs';
import { ALL_PAGES, PRERENDERED } from './pages';
import { BACKEND_URL, IDP_ORIGIN } from './servers';
import { LINKS } from './stand-in';

// With the test identity provider configured, forms may lead to it (sign-out).
const SECURITY_HEADERS = securityHeaders({ formAction: [IDP_ORIGIN] });

function expectSecurityHeaders(res: APIResponse): void {
  const headers = res.headers();
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(headers[name.toLowerCase()], name).toBe(value);
}

test('every page, prerendered or not, carries the security headers and the anonymous cache rule', async ({ request }) => {
  for (const path of ALL_PAGES) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(200);
    expectSecurityHeaders(res);
    expect(res.headers()['cache-control'], path).toBe('public, max-age=60, stale-while-revalidate=60');
    expect(res.headers()['vary'], path).toBe('Cookie');
  }
});

test('a request with the session cookie gets private, no-store, on prerendered and on-request pages', async ({ request }) => {
  for (const path of ['/', '/officers', ...PRERENDERED]) {
    const res = await request.get(path, { headers: { cookie: `${SESSION_COOKIE}=x` } });
    expect(res.headers()['cache-control'], path).toBe('private, no-store');
    expectSecurityHeaders(res);
  }
});

test('About, Join and Governance are the files built at deploy time; the rest render on request', async ({ request }) => {
  for (const path of PRERENDERED) {
    const res = await request.get(path);
    expect(await res.text(), path).toBe(readFileSync(`dist/client${path}.html`, 'utf8'));
  }
  for (const path of ALL_PAGES.filter((p) => !PRERENDERED.includes(p))) {
    expect(existsSync(`dist/client${path === '/' ? '/index' : path}.html`), path).toBe(false);
  }
});

test("a prerendered page differs from the built file only in the reader's html tag and size slider", async ({ request }) => {
  const built = readFileSync('dist/client/about.html', 'utf8');
  // Old cookies, read in the new terms: size 5 is 175 %, and the old high contrast is warm white.
  const res = await request.get('/about', { headers: { cookie: `${SIZE_COOKIE}=5; ${THEME_COOKIE}=contrast` } });
  expect(built).toContain(sizeSlider(SIZES[3]));
  expect(await res.text()).toBe(built.replace(/<html[^>]*>/, `<html lang="en" data-size="${SIZES[6]}" data-theme="contrast-white">`).replace(sizeSlider(SIZES[3]), sizeSlider(SIZES[6])));
  expect(res.headers()['cache-control']).toBe('public, max-age=60, stale-while-revalidate=60');
  expect(res.headers()['vary']).toBe('Cookie');
});

test('the reader controls post to a handler that sets the cookies, is never stored, and stays on this site', async ({ request, baseURL }) => {
  const res = await request.post('/prefs', {
    headers: { Origin: baseURL! },
    form: { size: 'larger', back: '//evil.example/' },
    maxRedirects: 0,
  });
  expect(res.status()).toBe(303);
  expect(res.headers()['location']).toBe('/');
  expect(res.headers()['set-cookie']).toContain(`${SIZE_COOKIE}=${SIZES[4]}`);
  expect(res.headers()['cache-control']).toBe('private, no-store');
  expectSecurityHeaders(res);
});

test('a post from another site is refused and sets nothing', async ({ request }) => {
  const res = await request.post('/prefs', {
    headers: { Origin: 'https://evil.example' },
    form: { size: 'larger', back: '/' },
    maxRedirects: 0,
  });
  expect(res.status()).toBe(403);
  expect(res.headers()['set-cookie']).toBeUndefined();
});

test('the stylesheet is a hashed file, cached for a year, and no page has an inline script or style', async ({ request }) => {
  for (const path of ALL_PAGES) {
    const page = await (await request.get(path)).text();
    expect(page, path).not.toMatch(/<style/i);
    // Script only as same-origin files (CSP script-src 'self'); the page works without them.
    for (const tag of page.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) ?? []) expect(tag, path).toMatch(/^<script\b[^>]*\bsrc="\/[^/][^"]*"[^>]*><\/script>$/);
  }
  const html = await (await request.get('/')).text();
  const href = /<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/.exec(html)?.[1] ?? /href="(\/_astro\/[^"]+\.css)"/.exec(html)?.[1];
  expect(href).toMatch(/^\/_astro\//);
  const css = await request.get(href as string);
  expect(css.status()).toBe(200);
  expect(css.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
  expectSecurityHeaders(css);
});

test('a missing page is a 404 with the same headers, never stored', async ({ request }) => {
  const res = await request.get('/no-such-page');
  expect(res.status()).toBe(404);
  expectSecurityHeaders(res);
  expect(res.headers()['cache-control']).toBe('no-store');
});

test('the health probe answers ok and is never stored', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(await res.text()).toBe('ok');
  expect(res.headers()['cache-control']).toBe('no-store');
});

test('the fonts are our own files, and their licences are served beside them', async ({ request }) => {
  const html = await (await request.get('/')).text();
  const href = /href="(\/_astro\/[^"]+\.css)"/.exec(html)?.[1];
  const css = await (await request.get(href as string)).text();
  expect(css).not.toMatch(/googleapis|gstatic|https?:\/\//);
  const faces = [...css.matchAll(/font-family:\s*['"]?([^;'"]+)['"]?;[^}]*?src:\s*url\(([^)]+)\)/g)];
  const families = new Set(faces.map((m) => m[1]));
  expect([...families].sort()).toEqual(['Atkinson Hyperlegible', 'Lexend']);
  for (const [, , url] of faces) expect(url, url).toMatch(/^\/_astro\/[^/]+\.woff2$/);
  const font = await request.get(faces[0]![2]!);
  expect(font.status()).toBe(200);
  expect(font.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
  for (const name of ['OFL-Atkinson-Hyperlegible.txt', 'OFL-Lexend.txt']) {
    const licence = await request.get(`/fonts/${name}`);
    expect(licence.status(), name).toBe(200);
    expect(await licence.text(), name).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/i);
  }
});

/** A raw request, so the test can send the Host header cloudflared sends. */
function rawPost(headers: Record<string, string>, body: string) {
  return new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = http.request(`${BACKEND_URL}/prefs`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers } }, resolve);
    req.on('error', reject);
    req.end(body);
  });
}

test('behind the tunnel, a post from the site itself is accepted and its cookies are Secure', async () => {
  const tunnel = { host: 'nwflorida.us', 'x-forwarded-proto': 'https' };
  const ok = await rawPost({ ...tunnel, origin: 'https://nwflorida.us' }, 'theme=dark&back=%2Fabout');
  expect(ok.statusCode).toBe(303);
  expect(ok.headers['location']).toBe('/about');
  const cookies = ok.headers['set-cookie'] ?? [];
  // Size, theme and (LINKS L4) the leaving page's choice.
  expect(cookies.length).toBe(3);
  for (const c of cookies) expect(c).toMatch(/^__Host-.*; Secure$/);
  const forged = await rawPost({ ...tunnel, origin: 'https://evil.example' }, 'theme=dark&back=%2F');
  expect(forged.statusCode).toBe(403);
  expect(forged.headers['set-cookie']).toBeUndefined();
});

test('MT-30: no response sets a cookie with Domain=, and every cookie is host-only: __Host-, Secure, Path=/, SameSite=Lax', async ({ request, baseURL }) => {
  for (const path of ALL_PAGES) expect((await request.get(path)).headers()['set-cookie'], path).toBeUndefined();
  const res = await request.post('/prefs', {
    headers: { Origin: baseURL! },
    form: { size: 'larger', theme: 'dark', back: '/' },
    maxRedirects: 0,
  });
  expect(res.status()).toBe(303);
  const cookies = res.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie').map((h) => h.value);
  // Size, theme and (LINKS L4) the leaving page's choice.
  expect(cookies.length).toBe(3);
  for (const cookie of cookies) {
    const [pair, ...rest] = cookie.split(';').map((part) => part.trim());
    const attrs = rest.map((a) => a.toLowerCase());
    expect(pair).toMatch(/^__Host-[\w-]+=/);
    expect(attrs).toEqual(expect.arrayContaining(['secure', 'path=/', 'samesite=lax', 'httponly']));
    expect(attrs.filter((a) => a.startsWith('domain'))).toEqual([]);
  }
});

test('the full build has the same strict CSP on every response as the canary', async ({ request }) => {
  for (const path of [...ALL_PAGES, '/no-such-page', '/manifest.webmanifest', '/scripts/install.js', '/scripts/size.js', '/scripts/error-summary.js']) {
    const policy = (await request.get(path)).headers()['content-security-policy'] ?? '';
    const csp = parseCsp(policy);
    expect(csp['script-src'], path).toEqual(["'self'"]);
    expect(policy, path).not.toMatch(/unsafe-/);
    expect(csp['object-src'], path).toEqual(["'none'"]);
    expect(csp['base-uri'], path).toEqual(["'none'"]);
    expect(csp['frame-ancestors'], path).toEqual(["'none'"]);
  }
});

test('the full build keeps sign-in: it starts at the provider, and the header links to it', async ({ request }) => {
  const res = await request.get('/sign-in', { maxRedirects: 0 });
  expect(res.status()).toBe(303);
  expect(res.headers()['location']).toMatch(new RegExp(`^${IDP_ORIGIN.replaceAll('.', '\\.')}/auth\\?`));
  expect(await (await request.get('/about')).text()).toMatch(/href="\/sign-in\?return=%2Fabout"/);
});

test('the full build shows the submitted content the canary hides (the other half of canary condition 3)', async ({ request }) => {
  for (const path of ['/officers', '/minutes', '/finances']) {
    expect(await (await request.get(path)).text(), path).toMatch(/data-source="submitted"/);
  }
});

/** A raw post to the server as cloudflared sends it, declared or chunked. */
function bigPost(bytes: number, chunked: boolean) {
  return new Promise<number>((resolve, reject) => {
    const headers: Record<string, string> = {
      host: 'nwflorida.us',
      'x-forwarded-proto': 'https',
      origin: 'https://nwflorida.us',
      'content-type': 'application/x-www-form-urlencoded',
    };
    if (!chunked) headers['content-length'] = String(bytes + 5);
    const req = http.request(`${BACKEND_URL}/prefs`, { method: 'POST', headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.write('back=');
    req.end('a'.repeat(bytes));
  });
}

test('a reader-control post bigger than the form is refused with 413, declared or chunked', async () => {
  expect(await bigPost(2 * 1024 * 1024, false)).toBe(413);
  expect(await bigPost(100 * 1024, true)).toBe(413);
});

test('an encoded path out of /_astro/ is refused, never served as a page cached for a year', async ({ request }) => {
  for (const path of ['/_astro/..%2fabout', '/_astro/..%2fabout.html', '/_astro/%2e%2e%2fjoin.html']) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(400);
    expect(res.headers()['cache-control'], path).not.toMatch(/immutable/);
    expect(await res.text(), path).not.toContain('<h1>About us</h1>');
  }
});

test('a post with no Origin, from a foreign page, is refused with 403 and sets nothing', async () => {
  const res = await rawPost({ host: 'nwflorida.us', 'x-forwarded-proto': 'https', referer: 'https://evil.example/' }, 'size=larger&back=%2F');
  expect(res.statusCode).toBe(403);
  expect(res.headers['set-cookie']).toBeUndefined();
});

/** A request to the server as cloudflared sends it, with the Host given. */
function asked(path: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BACKEND_URL}${path}`, { headers: { 'X-Forwarded-Proto': 'https', ...headers } });
    req.on('response', (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.end();
  });
}

test('robots.txt answers for the Host asked for: a forwarded host cannot make the canary indexable', async () => {
  expect(await asked('/robots.txt', { Host: 'nwflorida.us' })).toContain('Sitemap: https://nwflorida.us/sitemap.xml');
  for (const spoof of [{ 'X-Forwarded-Host': 'nwflorida.us' }, { 'X-Forwarded-Host': 'nwflorida.us', 'X-Forwarded-Port': '443' }]) {
    expect(await asked('/robots.txt', { Host: 'canary.nwflorida.us', ...spoof })).toBe('User-agent: *\nDisallow: /\n');
  }
});

// LINKS L4: the leaving page /out/<id>. Never stored (it depends on the reader's cookie and token), no
// referrer to the site the reader leaves for, not for search engines, the site's CSP unchanged, no
// inline script; the direct choice is a 303 to the approved URL alone.
test.describe('the leaving page (LINKS L4)', () => {
  const out = (id: string) => `/out/${id}`;

  test('shows the approved link, private and never stored, with no referrer, noindex and the CSP unchanged', async ({ request }) => {
    const about = await request.get('/about');
    for (const id of [LINKS.web.id, LINKS.mail.id, LINKS.off.id]) {
      const res = await request.get(out(id));
      expect(res.status(), id).toBe(200);
      const headers = res.headers();
      expect(headers['cache-control'], id).toBe('private, no-store');
      expect(headers['cdn-cache-control'], id).toBe('no-store');
      expect(headers['referrer-policy'], id).toBe('no-referrer');
      expect(headers['content-security-policy'], id).toBe(about.headers()['content-security-policy']);
      expect(headers['cross-origin-opener-policy'], id).toBe('same-origin');
      const html = await res.text();
      expect(html, id).toContain('<meta name="robots" content="noindex">');
      // Same-origin script files only: no inline script, no handler attribute, no javascript: URL.
      for (const tag of html.match(/<script\b[^>]*>/g) ?? []) expect(tag, id).toMatch(/ src="\/scripts\/[a-z-]+\.js"/);
      expect(html, id).not.toMatch(/<script\b[^>]*>[^<]+<\/script>|\son[a-z]+=|javascript:/i);
    }
  });

  test('answers every id it has no link for with the same 404, under the same headers', async ({ request }) => {
    const pages = new Set<string>();
    for (const id of [LINKS.unknown.id, LINKS.members.id, LINKS.script.id, LINKS.angles.id, LINKS.rtl.id, LINKS.web.id.toUpperCase(), `${LINKS.web.id}a`, LINKS.web.id.slice(1), 'x']) {
      const res = await request.get(out(id));
      expect(res.status(), id).toBe(404);
      expect(res.headers()['cache-control'], id).toBe('private, no-store');
      expect(res.headers()['referrer-policy'], id).toBe('no-referrer');
      const html = await res.text();
      expect(html, id).toContain('This link is not available');
      for (const leak of ['javascript:', '<script>alert', 'members-night', 'club.example']) expect(html, `${id}: ${leak}`).not.toContain(leak);
      // The page differs only where it names its own address (the Aa panel's way back, Sign in's return).
      pages.add(html.replaceAll(`/out/${id}`, '/out/ID').replaceAll(`%2Fout%2F${encodeURIComponent(id)}`, '%2Fout%2FID'));
    }
    expect(pages.size).toBe(1);
  });

  test('a direct choice answers 303 to the approved URL, with no referrer and never stored; a mail link and a turned-off one still show the page', async ({ request }) => {
    const headers = { cookie: `${LINKS_COOKIE}=direct` };
    const res = await request.get(out(LINKS.web.id), { headers, maxRedirects: 0 });
    expect(res.status()).toBe(303);
    expect(res.headers()['location']).toBe(LINKS.web.url);
    expect(res.headers()['referrer-policy']).toBe('no-referrer');
    expect(res.headers()['cache-control']).toBe('private, no-store');
    for (const id of [LINKS.mail.id, LINKS.off.id]) expect((await request.get(out(id), { headers, maxRedirects: 0 })).status(), id).toBe(200);
    expect((await request.get(out(LINKS.unknown.id), { headers, maxRedirects: 0 })).status()).toBe(404);
  });

  test('no query or path variant leads anywhere but the approved URL: there is no open redirect', async ({ request }) => {
    for (const cookie of ['', `${LINKS_COOKIE}=direct`]) {
      for (const path of [
        `${out(LINKS.web.id)}?url=https://evil.example/`,
        `${out(LINKS.web.id)}?to=//evil.example&next=https%3A%2F%2Fevil.example`,
        `${out(LINKS.web.id)}?saved=0&url=https://evil.example/`,
      ]) {
        const res = await request.get(path, { headers: cookie ? { cookie } : {}, maxRedirects: 0 });
        const where = res.headers()['location'];
        if (res.status() === 303) expect(where, path).toBe(LINKS.web.url);
        else {
          // The query is only ever echoed as this page's own address (the Aa panel, Sign in), escaped: never a way out.
          const html = await res.text();
          expect(html, path).toContain(`href="${LINKS.web.url.replace('&', '&amp;')}" target="_blank" rel="noopener noreferrer" data-out-continue`);
          expect(html, path).not.toMatch(/(href|action|src)="(https?:)?\/\/evil\.example/);
        }
      }
      for (const path of [`/out/${LINKS.web.id}/..%2F..%2Fevil.example`, `/out/..%2F${LINKS.web.id}`, `/out/https:%2F%2Fevil.example`, '/out/https://evil.example', `/out/${LINKS.web.id}%0d%0aLocation:%20https://evil.example`]) {
        const res = await request.get(path, { headers: cookie ? { cookie } : {}, maxRedirects: 0 });
        expect([400, 404], path).toContain(res.status());
        expect(res.headers()['location'], path).toBeUndefined();
      }
    }
  });

  test('a forged or unknown links cookie is the guard: the page, never a redirect', async ({ request }) => {
    for (const value of ['DIRECT', 'redirect', 'https://evil.example/', 'direct,direct', '1']) {
      const res = await request.get(out(LINKS.web.id), { headers: { cookie: `${LINKS_COOKIE}=${value}` }, maxRedirects: 0 });
      expect(res.status(), value).toBe(200);
      expect(await res.text(), value).not.toContain('data-out-countdown');
    }
    // The name without its prefix, which a sibling subdomain could set, is never read.
    expect((await request.get(out(LINKS.web.id), { headers: { cookie: 'nwfl-links=direct' }, maxRedirects: 0 })).status()).toBe(200);
  });

  test('the Next time choice posts to /prefs, sets the links cookie host-only, and comes back to the page, saved, not redirected', async ({ request, baseURL }) => {
    const back = `${out(LINKS.web.id)}?saved=1`;
    const res = await request.post('/prefs', { headers: { Origin: baseURL! }, form: { links: 'direct', back }, maxRedirects: 0 });
    expect(res.status()).toBe(303);
    expect(res.headers()['location']).toBe(back);
    const set = res.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie').map((h) => h.value);
    expect(set).toContain(`${LINKS_COOKIE}=direct; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly; Secure`);
    const saved = await request.get(back, { headers: { cookie: `${LINKS_COOKIE}=direct` }, maxRedirects: 0 });
    expect(saved.status()).toBe(200);
    expect(await saved.text()).toContain('Saved. Next time you follow a link to another site, we will take you straight there.');
  });
});
