// Sign-in (W4) end to end, against the local test identity provider
// (e2e/idp.mjs), with JavaScript off: the site needs none, and neither do the
// provider's own forms.
import { expect, test, type BrowserContext } from '@playwright/test';
import { IDP_ORIGIN } from './servers';
import { AT_PROVIDER, banner, signIn } from './signin';

test.use({ javaScriptEnabled: false });

const cookie = async (context: BrowserContext, name: string) => (await context.cookies()).find((c) => c.name === name);

test('a member signs in from a page, comes back to it, and the header names them', async ({ page, context }) => {
  await page.goto('/calendar');
  await signIn(page, 'member');
  await expect(page).toHaveURL(/\/calendar$/);
  await expect(banner(page)).toContainText('Jordan Example');
  await expect(banner(page).getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expect(banner(page).getByRole('link', { name: 'Sign in', exact: true })).toHaveCount(0);
  await expect(banner(page).getByRole('link', { name: 'Officer area' })).toHaveCount(0);

  // A prerendered page shows the same header, and nothing signed in is cached.
  const about = await page.goto('/about');
  await expect(banner(page)).toContainText('Jordan Example');
  expect(about?.headers()['cache-control']).toBe('private, no-store');

  // The session is a host-only cookie; no token is in it, or anywhere in the browser.
  const session = await cookie(context, '__Host-nwfl-session');
  expect(session).toMatchObject({ domain: 'localhost', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' });
  expect(session!.value).toMatch(/^v1\./);
  expect(session!.value.length).toBeLessThan(3500);
  for (const c of await context.cookies()) expect(c.value, c.name).not.toMatch(/^eyJ|\.eyJ/);
  expect(await cookie(context, '__Host-nwfl-auth')).toBeUndefined();
});

test('the sign-in transaction is a host-only cookie that lasts ten minutes, and asks for PKCE, state and nonce', async ({ page, context }) => {
  await page.goto('/');
  const asked = page.waitForRequest((r) => r.url().startsWith(`${IDP_ORIGIN}/auth?`));
  await banner(page).getByRole('link', { name: 'Sign in', exact: true }).click();
  const authorize = new URL((await asked).url());
  expect(authorize.searchParams.get('response_type')).toBe('code');
  expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
  expect(authorize.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/);
  expect(authorize.searchParams.get('state')).toMatch(/^[\w-]{20,}$/);
  expect(authorize.searchParams.get('nonce')).toMatch(/^[\w-]{20,}$/);
  await expect(page).toHaveURL(AT_PROVIDER);
  const tx = await cookie(context, '__Host-nwfl-auth');
  expect(tx).toMatchObject({ domain: 'localhost', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' });
  expect(tx!.expires - Date.now() / 1000).toBeGreaterThan(590);
  expect(tx!.expires - Date.now() / 1000).toBeLessThanOrEqual(600);
});

test('an officer gets the Officer area; a member is told it is not theirs', async ({ page, browser, baseURL }) => {
  await page.goto('/');
  await signIn(page, 'officer');
  await expect(banner(page)).toContainText('Alex Sample');
  await banner(page).getByRole('link', { name: 'Officer area' }).click();
  await expect(page.locator('h1')).toHaveText('Officer area');
  await expect(page.getByRole('main')).toContainText('Welcome, Alex Sample.');

  const other = await browser.newContext({ javaScriptEnabled: false, ignoreHTTPSErrors: true, baseURL: baseURL! });
  const memberPage = await other.newPage();
  await memberPage.goto('/');
  await signIn(memberPage, 'member');
  const res = await memberPage.goto('/officer-area');
  expect(res?.status()).toBe(403);
  await expect(memberPage.getByRole('main')).toContainText("This area is for the club's officers.");
  await other.close();
});

test('the Officer area sends someone not signed in to sign in first', async ({ page }) => {
  await page.goto('/officer-area');
  await expect(page).toHaveURL(AT_PROVIDER);
});

test('signing out ends the provider’s session too, then clears the site, and keeps text size and theme', async ({ page, context }) => {
  await page.goto('/about#reader-menu');
  await page.locator('#reader-menu').getByRole('button', { name: /^A\+ Larger/ }).click();
  await page.locator('#reader-menu').getByRole('button', { name: /^Dark/ }).click();
  await signIn(page, 'member');
  await expect(banner(page)).toContainText('Jordan Example');

  const landed = page.waitForResponse((r) => r.url().includes('/signed-out?state='));
  await banner(page).getByRole('button', { name: 'Sign out' }).click();
  // The provider still has its session, so it asks to end it.
  await expect(page).toHaveURL(AT_PROVIDER);
  await page.getByRole('button', { name: 'Yes, sign me out' }).click();
  // Bound to this browser, the way back clears the site (its header is checked
  // below, from the API: WebKit's tooling does not report it on a redirect).
  expect((await landed).headers()['location']).toMatch(/^\/signed-out\?restore=v1\./);

  await expect(page).toHaveURL(/\/signed-out$/);
  await expect(page.locator('h1')).toHaveText('You are signed out');
  await expect(page.locator('html')).toHaveAttribute('data-size', '2');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect((await context.cookies()).map((c) => c.name).filter((n) => n.startsWith('__Host-')).sort()).toEqual(['__Host-nwfl-size', '__Host-nwfl-theme']);
  await expect(banner(page).getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();

  // The provider's session ended: signing in asks who you are again.
  await banner(page).getByRole('link', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('input[name="login"]')).toBeVisible();
});

test('sign-out answers a POST only, and only from this site', async ({ page, request, baseURL }) => {
  const get = await page.goto('/sign-out');
  expect(get?.status()).toBe(405);
  const foreign = await request.post('/sign-out', { headers: { Origin: 'https://evil.example' }, maxRedirects: 0 });
  expect(foreign.status()).toBe(403);
  const ours = await request.post('/sign-out', { headers: { Origin: baseURL! }, maxRedirects: 0 });
  expect(ours.status()).toBe(303);
  expect(ours.headers()['clear-site-data']).toBe('"storage"');
  expect(ours.headers()['location']).toMatch(new RegExp(`^${IDP_ORIGIN.replaceAll('.', '\\.')}/session/end\\?`));
});

test('the way back from sign-out clears the site for the browser that signed out, and for no one else', async ({ request, playwright, baseURL }) => {
  const ours = await request.post('/sign-out', { headers: { Origin: baseURL! }, maxRedirects: 0 });
  const state = new URL(ours.headers()['location']!).searchParams.get('state')!;

  const stranger = await playwright.request.newContext({ baseURL: baseURL!, ignoreHTTPSErrors: true });
  const forged = await stranger.get(`/signed-out?state=${state}`, { maxRedirects: 0 });
  expect(forged.status()).toBe(303);
  expect(forged.headers()['location']).toBe('/signed-out');
  expect(forged.headers()['clear-site-data']).toBeUndefined();
  await stranger.dispose();

  const back = await request.get(`/signed-out?state=${state}`, { maxRedirects: 0 });
  expect(back.status()).toBe(303);
  expect(back.headers()['location']).toBe(`/signed-out?restore=${state}`);
  expect(back.headers()['clear-site-data']).toBe('"cookies", "storage"');
  // Once only: the binding went with it.
  expect((await request.get(`/signed-out?state=${state}`, { maxRedirects: 0 })).headers()['clear-site-data']).toBeUndefined();
});

test.describe('the callback refuses, in plain words', () => {
  test('a cancelled sign-in, without repeating what the provider said', async ({ page }) => {
    await page.goto('/');
    await banner(page).getByRole('link', { name: 'Sign in', exact: true }).click();
    await page.getByRole('link', { name: '[ Cancel ]' }).click();
    await expect(page).toHaveURL(/\/auth\/callback\?/);
    await expect(page.locator('h1')).toHaveText('We could not sign you in');
    await expect(page.getByRole('main')).toContainText('Sign-in was cancelled.');
    expect(await page.content()).not.toContain('End-User aborted interaction');
  });

  test('a state that is not this browser’s', async ({ page, context }) => {
    // Two sign-ins started; the browser keeps the first one's transaction and
    // comes back from the second: what a forged sign-in link looks like.
    const loginForm = page.locator('input[name="login"]');
    await page.goto('/');
    await banner(page).getByRole('link', { name: 'Sign in', exact: true }).click();
    await expect(loginForm).toBeVisible();
    const first = (await cookie(context, '__Host-nwfl-auth'))!;
    await page.goto('/');
    await banner(page).getByRole('link', { name: 'Sign in', exact: true }).click();
    await expect(loginForm).toBeVisible();
    expect((await cookie(context, '__Host-nwfl-auth'))!.value).not.toBe(first.value);
    await context.addCookies([first]);
    await page.locator('input[name="login"]').fill('member');
    await page.locator('input[name="password"]').fill('any');
    await page.getByRole('button', { name: 'Sign-in' }).click();
    await expect(page.locator('h1')).toHaveText('We could not sign you in');
    await expect(page.getByRole('main')).toContainText('does not match the one started in this browser');
    await expect(banner(page).getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  });

  test('a callback used a second time, even with its transaction cookie put back', async ({ page, context }) => {
    let callback = '';
    page.on('request', (r) => {
      if (r.url().includes('/auth/callback?')) callback = r.url();
    });
    await page.goto('/');
    await banner(page).getByRole('link', { name: 'Sign in', exact: true }).click();
    await expect(page.locator('input[name="login"]')).toBeVisible();
    const tx = (await cookie(context, '__Host-nwfl-auth'))!;
    await page.locator('input[name="login"]').fill('member');
    await page.locator('input[name="password"]').fill('any');
    await page.getByRole('button', { name: 'Sign-in' }).click();
    await expect(banner(page)).toContainText('Jordan Example');

    await context.clearCookies();
    await context.addCookies([tx]);
    const replay = await page.goto(callback);
    expect(replay?.status()).toBe(400);
    await expect(page.getByRole('main')).toContainText('has already been used');
    expect(await cookie(context, '__Host-nwfl-session')).toBeUndefined();
  });
});
