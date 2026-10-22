// The public-only canary build (PUBLIC_ONLY=true), as deployed on a host under
// a parent domain shared with other apps. Run by playwright.public-only.config.ts
// against that build; the four conditions from the multi-tenancy audit.
import { expect, test, type APIResponse } from '@playwright/test';
import { isHostOnlyCookie, parseCsp } from '../../server/policy.mjs';
import { SIZE_COOKIE, THEME_COOKIE } from '../../server/prefs.mjs';
import { isSignInPath } from '../../src/lib/access';
import { ALL_PAGES } from '../pages';

const GATED = ['/sign-in', '/sign-out', '/signed-out', '/auth', '/auth/callback', '/auth/callback?code=x&state=y', '/auth/sign-out', '/officer-area', '/officer-area/new', '/officer-area/queue'];
const PUBLIC = ALL_PAGES.filter((path) => !isSignInPath(path));

const setCookies = (res: APIResponse) => res.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie').map((h) => h.value);

test('(1) no OIDC client and no session route: every sign-in route is the 404 page, for GET and POST', async ({ request, baseURL }) => {
  for (const path of GATED) {
    const get = await request.get(path, { maxRedirects: 0 });
    expect(get.status(), path).toBe(404);
    expect(await get.text(), path).toContain('Page not found');
    const post = await request.post(path, { headers: { Origin: baseURL! }, form: { code: 'x' }, maxRedirects: 0 });
    expect(post.status(), `POST ${path}`).toBe(404);
  }
});

test('(2) only the __Host- reader cookies are ever set: never a session cookie, never a Domain', async ({ request, baseURL }) => {
  const names = new Set<string>();
  const responses = [
    ...(await Promise.all([...PUBLIC, ...GATED].map((path) => request.get(path, { maxRedirects: 0 })))),
    await request.post('/prefs', { headers: { Origin: baseURL! }, form: { size: 'larger', theme: 'dark', back: '/' }, maxRedirects: 0 }),
  ];
  for (const res of responses) {
    for (const cookie of setCookies(res)) {
      expect(isHostOnlyCookie(cookie), cookie).toBe(true);
      expect(cookie, cookie).not.toMatch(/domain=/i);
      names.add(cookie.split('=')[0]!);
    }
  }
  expect([...names].sort()).toEqual([SIZE_COOKIE, THEME_COOKIE].sort());
});

test('(3) no officer- or member-submitted content, and no way to sign in, on any page', async ({ request }) => {
  for (const path of PUBLIC) {
    const html = await (await request.get(path)).text();
    expect(html, path).not.toMatch(/data-source="submitted"/);
    expect(html, path).not.toMatch(/href="\/(sign-in|auth|officer-area)\b/);
  }
  // The archive pipeline's items still show.
  expect(await (await request.get('/newsletter')).text()).toMatch(/data-source="pipeline"/);
});

test('(4) the CSP on every response: script-src self only, no unsafe-*, object-src, base-uri and frame-ancestors none', async ({ request }) => {
  for (const path of [...PUBLIC, ...GATED, '/manifest.webmanifest', '/scripts/install.js']) {
    const policy = (await request.get(path, { maxRedirects: 0 })).headers()['content-security-policy'] ?? '';
    const csp = parseCsp(policy);
    expect(csp['script-src'], path).toEqual(["'self'"]);
    expect(policy, path).not.toMatch(/unsafe-/);
    expect(csp['object-src'], path).toEqual(["'none'"]);
    expect(csp['base-uri'], path).toEqual(["'none'"]);
    expect(csp['frame-ancestors'], path).toEqual(["'none'"]);
    // No sign-in provider to lead a form to.
    expect(csp['form-action'], path).toEqual(["'self'"]);
  }
});

test('the reader still has the header controls, with no Sign in, and the site works', async ({ page }) => {
  await page.goto('/about');
  const banner = page.getByRole('banner');
  await expect(banner.getByRole('link', { name: /^Aa\b/ })).toBeVisible();
  await expect(banner.getByRole('link', { name: 'Help', exact: true })).toBeVisible();
  await expect(banner.getByRole('link', { name: 'Sign in' })).toHaveCount(0);
  await page.goto('/about#reader-menu');
  await page.locator('#reader-menu').getByRole('button', { name: /^A\+ Larger/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-size', '2');
});

// Every way the challenger found to spell a gated route (.html, encoded
// letters and dots, doubled slashes, a query), for every W4 route, by GET,
// HEAD and POST: Astro serves /sign-in for /sign-in.html.
const SPELLINGS = (route: string) => {
  const rest = route.slice(2);
  const first = route.charCodeAt(1).toString(16);
  return [route, `${route}.html`, `/%${first}${rest}.html`, `/%${first}${rest}`, `${route}%2ehtml`, `/${route}.html`, `/${route}`, `${route}.html?x=1`, `/.${route}.html`, `${route}/index.html`];
};

test('(5) the gate holds however the path is spelled, for every sign-in route and method', async ({ request, baseURL }) => {
  for (const route of ['/sign-in', '/sign-out', '/signed-out', '/auth/callback', '/officer-area', '/officer-area/new']) {
    for (const path of SPELLINGS(route)) {
      // Joined by hand: a leading // would otherwise be read as another host.
      const url = `${baseURL}${path}`;
      const get = await request.get(url, { maxRedirects: 0 });
      expect(get.status(), `GET ${path}`).toBe(404);
      expect(await get.text(), `GET ${path}`).toContain('Page not found');
      expect((await request.head(url, { maxRedirects: 0 })).status(), `HEAD ${path}`).toBe(404);
      expect((await request.post(url, { headers: { Origin: baseURL! }, form: { a: 'b' }, maxRedirects: 0 })).status(), `POST ${path}`).toBe(404);
    }
  }
});
