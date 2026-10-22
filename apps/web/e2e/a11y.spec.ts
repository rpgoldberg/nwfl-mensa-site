import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { ALL_PAGES } from './pages';

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

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} (system setting)`, () => {
    test.use({ colorScheme: scheme });

    test('every page passes axe', async ({ page }) => {
      for (const path of ALL_PAGES) {
        await page.goto(path);
        expect(await axe(page), path).toEqual([]);
      }
    });

    test('every page passes axe at 200 % text', async ({ page }) => {
      for (const path of ALL_PAGES) {
        await page.goto(path);
        await page.evaluate(() => (document.documentElement.dataset['size'] = '5'));
        expect(await axe(page), path).toEqual([]);
      }
    });
  });
}
