// EV1 (Ross, 11-12): "abbreviate to keep that header to one row always." The events toolbar, "‹ period ›"
// and List | Week | Month, stays on one row for every period of the year in all three views, from a
// 300 px cover screen up, the period's words getting shorter as the room runs out (chosen by the
// toolbar's width, never the device). Every target stays 44 px, the views keep their words, and the
// period is still named in full for a screen reader.
//
// Where even the shortest words cannot fit beside 44 px targets at a large text size, the toolbar is
// one row from FLOOR up and, below it, wraps cleanly: nothing scrolls sideways, nothing is cut off.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { THEMES, setPrefs } from './prefs';
import { addDays } from './stand-in';

/** Phones (a Fold or Razr cover screen first), then a tablet and a desktop. */
const WIDTHS = [300, 320, 344, 360, 390, 412, 768, 1280];
/** The narrowest screen on which every period's toolbar is one row, by text size (measured: the floor
 * tests below hold it to the pixel). 100 %: every width. 140 % and 175 %: the 44 px arrows, the three
 * views in words and the period stacked on two lines need more than a cover screen has. */
const FLOOR: Record<number, number> = { 100: 300, 140: 358, 175: 421 };
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'wcag2aaa', 'best-practice'];

/** Every period from November 2026 through December 2027: each week (the month- and year-crossing
 * ones among them), each month's grid and each month's list. */
function periods(): string[] {
  const out: string[] = [];
  for (let sunday = '2026-11-01'; sunday <= '2027-12-26'; sunday = addDays(sunday, 7)) out.push(`/events?view=week&d=${sunday}`);
  for (let y = 2026, m = 11; y < 2028; m === 12 ? ((y += 1), (m = 1)) : (m += 1)) {
    const month = `${y}-${String(m).padStart(2, '0')}-01`;
    out.push(`/events?view=month&d=${month}`, `/events?view=list&d=${month}`);
  }
  return out;
}

interface Fit {
  oneRow: boolean;
  sideways: number;
  /** The toolbar's own overflow, and the period's words past their box or under an arrow. */
  spill: number;
  /** The period's words on screen; stacked ones as "11/29 / –12/5". */
  shown: string[];
  small: string[];
}

/** How the toolbar sits: the two navs on one top, nothing spilling, one set of words shown, 44 px targets. */
async function fit(page: Page): Promise<Fit> {
  return page.evaluate(() => {
    const rect = (el: Element) => el.getBoundingClientRect();
    const tool = document.querySelector('.caltool')!;
    const [step, views] = [rect(document.querySelector('.calstep')!), rect(document.querySelector('.calviews')!)];
    const label = document.querySelector('.calstep__label')!;
    const [prev, next] = [...document.querySelectorAll('.calstep__arrow')].map(rect) as [DOMRect, DOMRect];
    const words = [...label.querySelectorAll('[aria-hidden="true"]')].filter((el) => (el as HTMLElement).offsetParent !== null && rect(el).width > 0);
    let spill = Math.max(0, tool.scrollWidth - tool.clientWidth);
    for (const el of words) {
      const r = rect(el);
      spill = Math.max(spill, prev.right - r.left, r.right - next.left, label.scrollWidth - label.clientWidth);
    }
    const small = [...tool.querySelectorAll('a')].filter((a) => rect(a).width < 44 || rect(a).height < 44).map((a) => a.textContent || a.getAttribute('aria-label') || '');
    return {
      oneRow: Math.abs(step.top - views.top) <= 1,
      sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      spill: Math.round(spill * 10) / 10,
      // The stacked words line by line: "11/29 / –12/5".
      shown: words.map((el) => (el.children.length > 0 ? [...el.children].map((c) => c.textContent).join(' / ') : (el.textContent ?? '').trim())),
      small,
    };
  });
}

for (const size of [100, 140, 175]) {
  test(`at ${size} % text every period of the year keeps the toolbar on one row from ${FLOOR[size]} px, never spilling`, async ({ page, context, baseURL }) => {
    test.setTimeout(240_000);
    await setPrefs(context, baseURL!, { size });
    const widths = [...new Set([...WIDTHS, FLOOR[size]!])].sort((a, b) => a - b);
    const failures: string[] = [];
    for (const path of periods()) {
      await page.setViewportSize({ width: WIDTHS[0]!, height: 800 });
      await page.goto(path);
      await page.evaluate(() => document.fonts.ready);
      for (const width of widths) {
        await page.setViewportSize({ width, height: 800 });
        const f = await fit(page);
        const where = `${path} @ ${width} px`;
        if (width >= FLOOR[size]! && !f.oneRow) failures.push(`${where}: two rows (${f.shown.join(' / ')})`);
        if (f.sideways > 0) failures.push(`${where}: scrolls sideways ${f.sideways} px`);
        if (f.spill > 0.5) failures.push(`${where}: words spill ${f.spill} px (${f.shown.join(' / ')})`);
        if (f.shown.length === 0) failures.push(`${where}: no period shown`);
        if (f.small.length > 0) failures.push(`${where}: under 44 px: ${f.small.join(', ')}`);
      }
    }
    expect(failures, failures.slice(0, 20).join('\n')).toEqual([]);
  });
}

// The floor is the measured one, not a loose bound: a pixel narrower, some period takes two rows, and
// on its own row it reads in the short words, not stacked.
for (const size of [140, 175]) {
  test(`at ${size} % text the floor is tight: at ${FLOOR[size]! - 1} px some period wraps, in the short words`, async ({ page, context, baseURL }) => {
    test.setTimeout(120_000);
    await setPrefs(context, baseURL!, { size });
    await page.setViewportSize({ width: FLOOR[size]! - 1, height: 800 });
    let wrapped = 0;
    for (const path of periods()) {
      await page.goto(path);
      await page.evaluate(() => document.fonts.ready);
      const f = await fit(page);
      if (f.oneRow) continue;
      wrapped++;
      expect(f.shown, path).toHaveLength(1);
      expect(f.shown[0], path).not.toContain(' / ');
    }
    expect(wrapped).toBeGreaterThan(0);
  });
}

test('at 100 % the words shorten as the screen narrows, and a screen reader hears the week in full', async ({ page }) => {
  await page.goto('/events?view=week&d=2026-11-29');
  const step = page.getByRole('navigation', { name: 'Dates' });
  for (const [width, shown] of [[1280, ['Nov 29 – Dec 5']], [385, ['Nov 29–Dec 5']], [360, ['11/29–12/5']], [300, ['11/29 / –12/5']]] as const) {
    await page.setViewportSize({ width, height: 800 });
    expect((await fit(page)).shown, `${width} px`).toEqual(shown);
    await expect(step, `${width} px`).toContainText('Showing the week of 29 November to 5 December 2026');
    await expect(step.getByRole('link', { name: 'Previous week: the week of 22 to 28 November 2026' })).toBeVisible();
  }
  await page.goto('/events?view=month&d=2026-09-01');
  for (const [width, shown] of [[1280, 'September 2026'], [385, 'Sep 2026'], [360, 'Sep ’26'], [300, 'Sep / 2026']] as const) {
    await page.setViewportSize({ width, height: 800 });
    expect((await fit(page)).shown, `${width} px`).toEqual([shown]);
  }
});

test.describe('with no script', () => {
  test.use({ javaScriptEnabled: false });
  test('the toolbar is one row on a 300 px cover screen, the week stacked', async ({ page }) => {
    await page.setViewportSize({ width: 300, height: 800 });
    for (const path of ['/events?view=week&d=2026-12-27', '/events?view=month&d=2027-09-01', '/events?view=list&d=2027-05-01']) {
      await page.goto(path);
      const f = await fit(page);
      expect(f, path).toMatchObject({ oneRow: true, sideways: 0, spill: 0, small: [] });
    }
  });
});

// The stacked words in every theme, on the narrowest screen: axe finds nothing.
for (const theme of THEMES) {
  test(`axe at 300 px, ${theme} theme, the stacked week`, async ({ page, context, baseURL }) => {
    await setPrefs(context, baseURL!, { theme });
    await page.setViewportSize({ width: 300, height: 800 });
    await page.goto('/events?view=week&d=2026-11-29');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    expect((await fit(page)).shown).toEqual(['11/29 / –12/5']);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect(result.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  });
}
