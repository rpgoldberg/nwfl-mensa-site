// SIGNOUT: in the installed app (Android Chrome, standalone), Sign out did nothing: its 303 carried
// Clear-Site-Data "cache", "storage", and the browser held the navigation while it cleared. Sign-out
// now clears no site data, which is safe only while both of these hold, so both are pinned here:
//   - every members-only answer is private, no-store, so no members' copy is ever in a cache to clear
//     (the members copy in /read, its PDF bytes, /account, the Officer area and /news signed in);
//   - the site keeps nothing in the browser's storage (no localStorage, sessionStorage, IndexedDB,
//     Cache Storage or service worker), so "storage" had nothing to clear. A change that stores
//     anything fails here, and must bring back the "storage" directive with it.
// With JavaScript on, as the installed app runs, and a tap on a phone.
import { expect, test, type Page } from '@playwright/test';
import { MEMBERS_COPY } from '../src/lib/reader';
import { IDP_ORIGIN } from './servers';
import { accountButton, banner, openAccount, signIn } from './signin';
import { NEWSLETTER } from './stand-in';

const MEMBERS_ID = NEWSLETTER.issues[0]!.membersPdf;

/** Each answer's status and cache headers, for the paths given, as this browser's session asks. */
async function cacheOf(page: Page, paths: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const path of paths) {
    const res = await page.request.get(path, { maxRedirects: 0 });
    out.push(`${path} ${res.status()} ${res.headers()['cache-control']} | cdn ${res.headers()['cdn-cache-control']}`);
  }
  return out;
}

const NEVER_STORED = 'private, no-store | cdn no-store';

test('every members-only answer to a member is private and never stored, by the browser or any cache', async ({ page }) => {
  await page.goto('/news');
  await signIn(page, 'member');
  const paths = [`/read/${MEMBERS_ID}`, `/documents/${MEMBERS_ID}.pdf`, `/documents/${MEMBERS_ID}.pdf?download=1`, '/account', '/news'];
  const seen = await cacheOf(page, paths);
  expect(seen).toEqual(paths.map((p) => `${p} 200 ${NEVER_STORED}`));
  // The members copy really is what was answered: the reader says so.
  await page.goto(`/read/${MEMBERS_ID}`);
  await expect(page.getByText(MEMBERS_COPY, { exact: true })).toBeVisible();
});

test('every Officer area answer to the Admin is private and never stored', async ({ page }) => {
  await page.goto('/about');
  // The Admin reaches every page of it: the approval rule and the sign-ups queue are not every officer's.
  await signIn(page, 'admin');
  const paths = ['/officer-area', '/officer-area/approval-rules', '/officer-area/sign-ups'];
  expect(await cacheOf(page, paths)).toEqual(paths.map((p) => `${p} 200 ${NEVER_STORED}`));
});

test('the site keeps nothing in the browser’s storage, even after a member reads the members copy', async ({ page }) => {
  await page.goto('/news');
  await signIn(page, 'member');
  await page.goto(`/read/${MEMBERS_ID}`);
  await expect(page.locator('[data-viewer-page-list] button')).toHaveCount(2);
  await page.goto('/account');
  const kept = await page.evaluate(async () => ({
    localStorage: localStorage.length,
    sessionStorage: sessionStorage.length,
    indexedDB: typeof indexedDB.databases === 'function' ? (await indexedDB.databases()).length : 0,
    cacheStorage: 'caches' in self ? (await caches.keys()).length : 0,
    serviceWorkers: 'serviceWorker' in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 0,
  }));
  expect(kept).toEqual({ localStorage: 0, sessionStorage: 0, indexedDB: 0, cacheStorage: 0, serviceWorkers: 0 });
});

test('Sign out, tapped with JavaScript on, goes on at once: no Clear-Site-Data on the way, the provider’s session ended', async ({ page, isMobile, browserName }) => {
  await page.goto('/news');
  await signIn(page, 'member');
  const cleared: string[] = [];
  page.on('response', async (r) => {
    const value = (await r.allHeaders())['clear-site-data'];
    if (value !== undefined) cleared.push(`${r.url()} ${value}`);
  });
  // The request, not its answer: WebKit's tooling never reports the 303 itself. Its process swap on
  // the cross-site redirect reports the POST as "Frame load interrupted" and the provider's GET as a
  // fresh request, while the page goes on to the provider as it should.
  const posted = page.waitForRequest((r) => new URL(r.url()).pathname === '/sign-out' && r.method() === 'POST');
  const endSession = page.waitForRequest((r) => r.url().startsWith(`${IDP_ORIGIN}/session/end?`));
  // W-LOOK2: below 1200 px Sign out is in the Account menu, so a phone taps that open first.
  const account = accountButton(page);
  if (isMobile) {
    await expect(account).toBeVisible();
    await account.tap();
    await expect(page.locator('[data-account-menu]')).toHaveAttribute('open', '');
  }
  const button = (await openAccount(page)).getByRole('button', { name: 'Sign out' });
  if (isMobile) await button.tap();
  else await button.click();
  const post = await posted;
  // Only the sign-out's answer sends the reader to end the provider's session with this token.
  const end = await endSession;
  expect(new URL(end.url()).searchParams.get('id_token_hint')).toBeTruthy();
  if (browserName === 'chromium') {
    // Chromium reports the hop: this very POST answered 303, with no Clear-Site-Data.
    expect(`${end.redirectedFrom()?.method()} ${end.redirectedFrom()?.url()}`).toBe(`POST ${post.url()}`);
    const res = await post.response();
    expect(res?.status()).toBe(303);
    expect((await res!.allHeaders())['clear-site-data']).toBeUndefined();
  }
  await expect(page.locator('h1')).toHaveText('Sign out of the provider?');
  await page.getByRole('button', { name: 'Yes, sign me out' }).click();
  await expect(page).toHaveURL(/\/signed-out$/);
  await expect(banner(page).getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  expect(cleared).toEqual([]);
});
