// S2: wherever a reader is sent to sign in and a short note fits, they are told in plain, large
// words that this is not their American Mensa password (the site never asks for that one).
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { PASSWORD_NOTE } from '../src/lib/auth/password-note';
import { SIGN_IN_OFF_URL } from './servers';
import { signIn } from './signin';

const NOTE = `${PASSWORD_NOTE.lead} ${PASSWORD_NOTE.rest}`;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'wcag2aaa', 'best-practice'];

const note = (page: Page) => page.getByRole('main').getByRole('note').filter({ hasText: NOTE });

async function large(locator: Locator) {
  // The lead size (21 px), in the page's own ink: plain text, never muted.
  expect(await locator.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(21);
}

async function axe(page: Page): Promise<string[]> {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

test('/sign-in, when signing in is not available, says which password to use', async ({ page }) => {
  const res = await page.goto(`${SIGN_IN_OFF_URL}/sign-in`);
  expect(res?.status()).toBe(503);
  await expect(note(page)).toHaveCount(1);
  await expect(note(page)).toBeVisible();
  await large(note(page));
  expect(await axe(page)).toEqual([]);
});

test('a refused sign-in says it beside the link to start again', async ({ page }) => {
  const res = await page.goto('/auth/callback?code=x&state=y');
  expect(res?.status()).toBe(400);
  await expect(note(page)).toHaveCount(1);
  await large(note(page));
  await expect(page.getByRole('link', { name: 'Start signing in again' })).toBeVisible();
  const box = await page.getByRole('link', { name: 'Start signing in again' }).boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(48);
});

test('/news says it once to a signed-out reader where sign-in works, and never where it does not', async ({ page }) => {
  await page.goto('/news');
  await expect(note(page)).toHaveCount(1);
  await large(note(page));
  expect(await axe(page)).toEqual([]);
  await page.goto(`${SIGN_IN_OFF_URL}/news`);
  await expect(page.getByText(PASSWORD_NOTE.lead)).toHaveCount(0);
});

test('/news says it to a reader whose sign-in has lapsed, beside Sign in again; never to one signed in', async ({ page }) => {
  await page.goto('/news');
  await signIn(page, 'member');
  await page.goto('/news');
  await expect(page.getByText(PASSWORD_NOTE.lead)).toHaveCount(0);
  await page.context().clearCookies();
  await page.goto('/news');
  await signIn(page, 'lapsed');
  await page.goto('/news');
  await expect(page.getByRole('link', { name: 'Sign in again' })).toBeVisible();
  await expect(note(page)).toHaveCount(1);
});

test('/account says it beside Sign in again when its sign-in has run out', async ({ page }) => {
  await page.goto('/');
  await signIn(page, 'lapsed');
  await page.goto('/account');
  await expect(page.getByRole('link', { name: 'Sign in again' })).toBeVisible();
  await expect(note(page)).toHaveCount(1);
  await large(note(page));
  expect(await axe(page)).toEqual([]);
});
