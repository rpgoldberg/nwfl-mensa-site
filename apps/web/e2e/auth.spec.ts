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

test('signing out expires the session, ends the provider’s session with its own cookie, and keeps text size and theme', async ({ page, context, browserName }) => {
  await page.goto('/about#reader-menu');
  await page.locator('#reader-menu').getByRole('button', { name: /^A\+ Larger/ }).click();
  await page.locator('#reader-menu').getByRole('button', { name: /^Dark/ }).click();
  await signIn(page, 'member');

  // Every Clear-Site-Data the browser sees, from here to the signed-out page.
  const cleared: string[] = [];
  page.on('response', async (r) => {
    const value = (await r.allHeaders())['clear-site-data'];
    if (value) cleared.push(value);
  });
  const endSession = page.waitForRequest((r) => r.url().startsWith(`${IDP_ORIGIN}/session/end?`));
  await banner(page).getByRole('button', { name: 'Sign out' }).click();
  const end = await endSession;
  expect(new URL(end.url()).searchParams.get('id_token_hint')).toBeTruthy();
  // The provider got its own session cookie: it asks to end that session (with
  // none, it would skip this page). Chromium reports the header too.
  await expect(page.locator('h1')).toHaveText('Sign out of the provider?');
  if (browserName === 'chromium') expect((await end.allHeaders())['cookie']).toMatch(/(^|; )_session=/);
  await page.getByRole('button', { name: 'Yes, sign me out' }).click();

  await expect(page).toHaveURL(/\/signed-out$/);
  await expect(page.locator('h1')).toHaveText("You're signed out");
  await expect(page.locator('html')).toHaveAttribute('data-size', '2');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const ours = (await context.cookies()).filter((c) => c.name.startsWith('__Host-'));
  expect(ours.map((c) => `${c.name}=${c.value}`).sort()).toEqual(['__Host-nwfl-size=2', '__Host-nwfl-theme=dark']);
  await expect(banner(page).getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  // Never "cookies" (nor "*"). Chromium reports the header on the redirect;
  // WebKit's tooling does not, and the API test below covers it there.
  for (const value of cleared) expect(value).not.toMatch(/"cookies"|"\*"/);
  if (browserName === 'chromium') expect(cleared).toContain('"cache", "storage"');

  // The provider's session ended: signing in asks who you are again.
  await banner(page).getByRole('link', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('input[name="login"]')).toBeVisible();
});

test('a session cookie kept from before sign-out, sent again, reads as nobody', async ({ page, context }) => {
  await page.goto('/');
  await signIn(page, 'officer');
  const kept = (await cookie(context, '__Host-nwfl-session'))!;
  await banner(page).getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('button', { name: 'Yes, sign me out' }).click();
  await expect(page).toHaveURL(/\/signed-out$/);

  await context.addCookies([kept]);
  for (const path of ['/', '/about']) {
    await page.goto(path);
    await expect(banner(page).getByRole('link', { name: 'Sign in', exact: true }), path).toBeVisible();
    await expect(banner(page), path).not.toContainText('Alex Sample');
  }
  await page.goto('/officer-area');
  await expect(page).toHaveURL(AT_PROVIDER);
});

test('sign-out answers a POST only, and only from this site; it clears cache and storage, never cookies', async ({ page, request, baseURL }) => {
  const get = await page.goto('/sign-out');
  expect(get?.status()).toBe(405);
  const foreign = await request.post('/sign-out', { headers: { Origin: 'https://evil.example' }, maxRedirects: 0 });
  expect(foreign.status()).toBe(403);
  const ours = await request.post('/sign-out', { headers: { Origin: baseURL! }, maxRedirects: 0 });
  expect(ours.status()).toBe(303);
  expect(ours.headers()['clear-site-data']).toBe('"cache", "storage"');
  expect(ours.headers()['location']).toMatch(new RegExp(`^${IDP_ORIGIN.replaceAll('.', '\\.')}/session/end\\?`));
  expect(new URL(ours.headers()['location']!).searchParams.get('post_logout_redirect_uri')).toBe(`${baseURL}/signed-out`);
  expect(ours.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie').map((h) => h.value)).toEqual([
    '__Host-nwfl-session=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly; Secure',
    '__Host-nwfl-auth=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly; Secure',
  ]);
});

test('the signed-out page is plain: it checks nothing and sets no cookie', async ({ request }) => {
  for (const path of ['/signed-out', '/signed-out?state=anything']) {
    const res = await request.get(path, { maxRedirects: 0 });
    expect(res.status(), path).toBe(200);
    expect(res.headers()['set-cookie'], path).toBeUndefined();
    expect(res.headers()['clear-site-data'], path).toBeUndefined();
  }
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
