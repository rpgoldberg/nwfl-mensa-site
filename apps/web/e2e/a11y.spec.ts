import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { ALL_PAGES } from './pages';
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

    test('high-contrast system setting', async ({ page }) => {
      await page.emulateMedia({ contrast: 'more' });
      await page.goto(path);
      expect(await axe(page)).toEqual([]);
    });

    // The reader's own choice, by cookie, at 100 % and 200 %, with the Aa panel
    // open so its controls are checked too.
    for (const theme of THEMES) {
      for (const size of [1, 5]) {
        test(`${theme} theme at ${size === 1 ? 100 : 200} % text, Aa panel open`, async ({ page, context, baseURL }) => {
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

// Signed in (W4): the header's account area, the Officer area, and the pages
// sign-in can end on.
test.describe('axe, signed in', () => {
  for (const theme of THEMES) {
    for (const size of [1, 5]) {
      test(`an officer, ${theme} theme at ${size === 1 ? 100 : 200} % text: Home and the Officer area`, async ({ page, context, baseURL }) => {
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
