// Signing in at the local test identity provider (e2e/idp.mjs), as one of its
// made-up people, from any page with the site header; done once the site shows
// them signed in.
import { expect, type Locator, type Page } from '@playwright/test';
import { IDP_ORIGIN } from './servers';

export const AT_PROVIDER = new RegExp(`^${IDP_ORIGIN.replaceAll('.', '\\.')}/`);

export const banner = (page: Page) => page.getByRole('banner');

export async function signIn(page: Page, login: 'member' | 'mixed' | 'officer' | 'pending' | 'long-name' | 'refused' | 'lapsed' | 'articles-down' | 'stale' | 'officer-only' | 'enrolee' | 'enrolee-pending' | 'lapsed-outsider' | 'admin' | 'webmaster' | 'lone-admin' | 'lapsed-admin' | 'newcomer' | 'invitee' | 'approver' | 'turned-down' | 'lone-approver' | 'lone-webmaster' | 'reopen-desktop' | 'reopen-phone' | 'reopen-iphone' | 'seat-only' | 'seat-refused') {
  await banner(page).getByRole('link', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(AT_PROVIDER);
  await page.locator('input[name="login"]').fill(login);
  await page.locator('input[name="password"]').fill('any');
  await page.getByRole('button', { name: 'Sign-in' }).click();
  // Back on the site and signed in, before the test goes anywhere else: the
  // click returns while the provider is still redirecting. W-LOOK2: Sign out
  // is in the row on a wide screen, and in the Account menu below 1200 px.
  await expect(banner(page).locator('[data-account="signed-in"]')).toBeAttached();
}

/** The header's Account button (W-LOOK2), the menu's <summary>: shown below 1200 px wide. */
export const accountButton = (page: Page) => page.locator('[data-account-menu] > summary');

/**
 * The signed-in header's controls wherever this width shows them: the Account menu, opened, below
 * 1200 px; the header's own row above it.
 */
export async function openAccount(page: Page): Promise<Locator> {
  const button = accountButton(page);
  if (!(await button.isVisible())) return banner(page);
  const menu = page.locator('[data-account-menu]');
  if ((await menu.getAttribute('open')) === null) await button.click();
  await expect(menu).toHaveAttribute('open', '');
  return menu;
}

/** Sign out, wherever this width shows it: in the header's row, or in the Account menu, opened. */
export async function signOutButton(page: Page): Promise<Locator> {
  return (await openAccount(page)).getByRole('button', { name: 'Sign out' });
}
