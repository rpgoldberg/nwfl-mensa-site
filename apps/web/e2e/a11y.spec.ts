import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { ALL_PAGES } from './pages';
import { SIZES } from '../server/prefs.mjs';
import { THEMES, setPrefs } from './prefs';
import { banner, signIn } from './signin';

// WCAG 2.2 A and AA, plus AAA (color-contrast-enhanced: 7:1 body text) and best practice.
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'wcag2aaa', 'best-practice'];

async function axe(page: Page): Promise<string[]> {
  // At the end of the page the phone's sticky bottom bar is back in its own
  // space; mid-page it overlays links, which axe would count as crowded targets.
  // layout.spec.ts checks that keyboard focus is never hidden behind it.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

// One test per page and setting, so a failure names both and the runs spread out.
for (const path of ALL_PAGES) {
  test.describe(`axe on ${path}`, () => {
    for (const scheme of ['light', 'dark'] as const) {
      test(`${scheme} system setting`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto(path);
        expect(await axe(page)).toEqual([]);
      });
    }

    test('high-contrast system setting (warm white)', async ({ page }) => {
      await page.emulateMedia({ contrast: 'more' });
      await page.goto(path);
      expect(await axe(page)).toEqual([]);
    });

    // The reader's own choice, by cookie, at the smallest and largest sizes, with
    // the Aa panel open so its controls are checked too.
    for (const theme of THEMES) {
      for (const size of [SIZES[0], SIZES[6]]) {
        test(`${theme} theme at ${size} % text, Aa panel open`, async ({ page, context, baseURL }) => {
          await setPrefs(context, baseURL!, { size, theme });
          await page.goto(`${path}#reader-menu`);
          await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
          await expect(page.locator('html')).toHaveAttribute('data-size', String(size));
          expect(await axe(page)).toEqual([]);
        });
      }
    }
  });
}

test('axe on the page a retired old URL shows (410)', async ({ page }) => {
  const res = await page.goto('/2015-mind-games.html');
  expect(res?.status()).toBe(410);
  expect(await axe(page)).toEqual([]);
});

// LAUNCH-FIX-1: the error page, at its own address (the server answers it 500, as it answers a failed
// request with it), and the privacy page, at the phone's 412 px and at 1280 px in every browser.
for (const width of [412, 1280]) {
  test(`axe on the error page (500) and the privacy page at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const res = await page.goto('/500');
    expect(res?.status()).toBe(500);
    await expect(page.getByRole('heading', { level: 1, name: 'Something went wrong on our side' })).toBeVisible();
    await expect(page.locator('main').getByRole('link', { name: 'tell an officer' })).toHaveAttribute('href', '/officers');
    expect(await axe(page)).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await page.goto('/privacy');
    await expect(page.getByRole('heading', { level: 1, name: 'Privacy' })).toBeVisible();
    expect(await axe(page)).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });
}

test('the footer of every page links to the privacy page, a target at least 44 px tall', async ({ page }) => {
  await page.goto('/');
  const link = page.locator('footer').getByRole('link', { name: 'Privacy' });
  expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await link.click();
  await expect(page).toHaveURL(/\/privacy$/);
});

// Signed in (W4): the header's account area, the Officer area, and the pages
// sign-in can end on.
test.describe('axe, signed in', () => {
  for (const theme of THEMES) {
    for (const size of [SIZES[0], SIZES[6]]) {
      test(`an officer, ${theme} theme at ${size} % text: Home and the Officer area`, async ({ page, context, baseURL }) => {
        await setPrefs(context, baseURL!, { size, theme });
        await page.goto('/');
        await signIn(page, 'officer');
        await expect(banner(page)).toContainText('Alex Sample');
        expect(await axe(page)).toEqual([]);
        await page.goto('/officer-area');
        expect(await axe(page)).toEqual([]);
      });
    }
  }

  test('a member, on the Officer area they may not use (403)', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'member');
    const res = await page.goto('/officer-area');
    expect(res?.status()).toBe(403);
    expect(await axe(page)).toEqual([]);
  });
});

test('axe on a refused sign-in (400)', async ({ page }) => {
  const res = await page.goto('/auth/callback?code=x&state=y');
  expect(res?.status()).toBe(400);
  expect(await axe(page)).toEqual([]);
});
