import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { THEMES, setPrefs } from './prefs';

const GROUPS = [
  ['The club', [['About us', '/about'], ['Officers', '/officers'], ['Governance', '/governance'], ['Meeting minutes', '/minutes'], ['Finances', '/finances']]],
  ['What’s on', [['Events', '/events'], ['News', '/news'], ['Search', '/search']]],
  ['Join and get help', [['Join Mensa', '/join'], ['Help', '/help'], ['Contact an officer', '/officers'], ['Put the club on your home screen', '/home-screen']]],
] as const;

test.describe('the More page', () => {
  test('has the heading More, three group headings and twelve links with their hrefs', async ({ page }) => {
    await page.goto('/more');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('More');
    await expect(page.getByRole('main').getByRole('heading', { level: 2 })).toHaveText(GROUPS.map(([title]) => title));
    for (const [title, rows] of GROUPS) {
      const group = page.getByRole('region', { name: title });
      await expect(group.getByRole('link')).toHaveCount(rows.length);
      for (const [name, href] of rows) await expect(group.getByRole('link', { name, exact: true })).toHaveAttribute('href', href);
    }
    await expect(page.getByRole('main').getByRole('link')).toHaveCount(12);
  });

  test('makes each row one link covering the row, named by its title and described by the line under it', async ({ page }) => {
    await page.goto('/more');
    for (const [, rows] of GROUPS) {
      for (const [name] of rows) {
        const link = page.getByRole('main').getByRole('link', { name, exact: true });
        await expect(link).toHaveCount(1);
        await expect(link.locator('a')).toHaveCount(0);
        expect(await link.evaluate((a) => a.getAttribute('aria-describedby'))).toBeTruthy();
        // The link covers the whole row: a click on the tile, the words or the chevron lands on it.
        const row = link.locator('xpath=ancestor::li');
        expect((await row.boundingBox())!.height, name).toBeGreaterThanOrEqual(64);
        expect(await row.evaluate((li) => {
          li.scrollIntoView({ block: 'center' });
          const r = li.getBoundingClientRect();
          return [r.left + 20, r.left + r.width / 2, r.right - 6].map((x) => document.elementFromPoint(x, r.top + r.height / 2)?.closest('a')?.textContent);
        }), name).toEqual([name, name, name]);
        await expect(row.locator('svg[aria-hidden="true"]')).toHaveCount(2);
      }
    }
  });

  test('no longer says "Every part of the site in one list."', async ({ page }) => {
    await page.goto('/more');
    await expect(page.getByText('Every part of the site')).toHaveCount(0);
    expect(await page.locator('meta[name="description"]').getAttribute('content')).not.toMatch(/Every part/);
  });

  test('shows a 48 px icon tile, and a 4 px top edge on each card', async ({ page }) => {
    await page.goto('/more');
    const tile = (await page.locator('.more-tile').first().boundingBox())!;
    expect([Math.round(tile.width), Math.round(tile.height)]).toEqual([48, 48]);
    for (const card of await page.locator('.more-card').all()) {
      expect(await card.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('4px');
    }
  });

  test('is two columns from 900 px, one below', async ({ page }) => {
    await page.goto('/more');
    const lefts = await page.locator('.more-group').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().left)));
    const wide = page.viewportSize()!.width >= 900;
    expect(new Set(lefts).size).toBe(wide ? 2 : 1);
  });

  const SCHEMES = [
    ['the device (dark)', undefined],
    ...THEMES.map((t) => [`${t} theme`, t] as const),
  ] as const;
  for (const [label, theme] of SCHEMES) {
    test(`is axe clean, with the AAA contrast check, on ${label}`, async ({ page, context, baseURL }) => {
      if (theme) await setPrefs(context, baseURL!, { theme });
      else await page.emulateMedia({ colorScheme: 'dark' });
      await page.goto('/more');
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const result = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'wcag2aaa', 'best-practice'])
        .analyze();
      expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
    });
  }

  test.describe('at 175 % text on a 320 px phone', () => {
    test.use({ viewport: { width: 320, height: 740 } });

    test('has no horizontal scroll, and no title or description breaks inside a word', async ({ page, context, baseURL }) => {
      await setPrefs(context, baseURL!, { size: 175 });
      await page.goto('/more');
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      const broken = await page.evaluate(() => {
        const out: string[] = [];
        for (const el of document.querySelectorAll<HTMLElement>('.more-title, .more-desc')) {
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const text = n.textContent ?? '';
            for (const m of text.matchAll(/\S+/g)) {
              const r = document.createRange();
              r.setStart(n, m.index!);
              r.setEnd(n, m.index! + m[0].length);
              if (new Set([...r.getClientRects()].map((c) => Math.round(c.top))).size > 1) out.push(m[0]);
            }
          }
        }
        return out;
      });
      expect(broken).toEqual([]);
      for (const link of await page.getByRole('main').getByRole('link').all()) {
        const box = (await link.boundingBox())!;
        expect(box.x + box.width, (await link.textContent()) ?? '').toBeLessThanOrEqual(320);
      }
    });
  });
});
