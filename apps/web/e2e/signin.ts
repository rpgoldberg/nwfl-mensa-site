// Signing in at the local test identity provider (e2e/idp.mjs), as one of its
// made-up people, from any page with the site header; done once the site shows
// them signed in.
import { expect, type Page } from '@playwright/test';
import { IDP_ORIGIN } from './servers';

export const AT_PROVIDER = new RegExp(`^${IDP_ORIGIN.replaceAll('.', '\\.')}/`);

export const banner = (page: Page) => page.getByRole('banner');

export async function signIn(page: Page, login: 'member' | 'officer' | 'pending' | 'long-name') {
  await banner(page).getByRole('link', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(AT_PROVIDER);
  await page.locator('input[name="login"]').fill(login);
  await page.locator('input[name="password"]').fill('any');
  await page.getByRole('button', { name: 'Sign-in' }).click();
  // Back on the site and signed in, before the test goes anywhere else: the
  // click returns while the provider is still redirecting.
  await expect(banner(page).getByRole('button', { name: 'Sign out' })).toBeVisible();
}
