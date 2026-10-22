import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { expect, test, type APIResponse } from '@playwright/test';
import { SESSION_COOKIE, parseCsp, securityHeaders } from '../server/policy.mjs';
import { SIZE_COOKIE, THEME_COOKIE } from '../server/prefs.mjs';
import { ALL_PAGES, PRERENDERED } from './pages';
import { BACKEND_URL, IDP_ORIGIN } from './servers';

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
    expect(res.headers()['cache-control'], path).toBe('public, max-age=60');
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

test("a prerendered page differs from the built file only in the reader's html tag", async ({ request }) => {
  const built = readFileSync('dist/client/about.html', 'utf8');
  const res = await request.get('/about', { headers: { cookie: `${SIZE_COOKIE}=5; ${THEME_COOKIE}=contrast` } });
  expect(await res.text()).toBe(built.replace(/<html[^>]*>/, '<html lang="en" data-size="5" data-theme="contrast">'));
  expect(res.headers()['cache-control']).toBe('public, max-age=60');
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
  expect(res.headers()['set-cookie']).toContain(`${SIZE_COOKIE}=2`);
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

test('a missing page is a 404 with the same headers', async ({ request }) => {
  const res = await request.get('/no-such-page');
  expect(res.status()).toBe(404);
  expectSecurityHeaders(res);
  expect(res.headers()['cache-control']).toBe('public, max-age=60');
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
  expect(cookies.length).toBe(2);
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
  expect(cookies.length).toBe(2);
  for (const cookie of cookies) {
    const [pair, ...rest] = cookie.split(';').map((part) => part.trim());
    const attrs = rest.map((a) => a.toLowerCase());
    expect(pair).toMatch(/^__Host-[\w-]+=/);
    expect(attrs).toEqual(expect.arrayContaining(['secure', 'path=/', 'samesite=lax', 'httponly']));
    expect(attrs.filter((a) => a.startsWith('domain'))).toEqual([]);
  }
});

test('the full build has the same strict CSP on every response as the canary', async ({ request }) => {
  for (const path of [...ALL_PAGES, '/no-such-page', '/manifest.webmanifest', '/scripts/install.js']) {
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
