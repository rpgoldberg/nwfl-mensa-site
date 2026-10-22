import { expect, test, type APIResponse } from '@playwright/test';
import { SECURITY_HEADERS, SESSION_COOKIE } from '../server/policy.mjs';
import { ALL_PAGES, PRERENDERED } from './pages';

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

test('About, Join and Governance are served as files built at deploy time', async ({ request }) => {
  for (const path of PRERENDERED) {
    const res = await request.get(path);
    // `send` serves files with a validator; an on-request render has none.
    expect(res.headers()['last-modified'], path).toBeTruthy();
  }
  const ssr = await request.get('/officers');
  expect(ssr.headers()['last-modified']).toBeUndefined();
});

test('the stylesheet is a hashed file, cached for a year, and the pages ship no script', async ({ request }) => {
  const html = await (await request.get('/')).text();
  expect(html).not.toMatch(/<script/i);
  expect(html).not.toMatch(/<style/i);
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
