// EV1 round 2 (the editor, 11-12): the events toolbar adapts to its room instead of squeezing words. Where the
// period and the full List | Week | Month switch fit one row, that is the toolbar. Where they do not,
// one "Week ▾" view picker (a disclosure of real links: no script needed, Back works) sits between
// ‹ and ›, the range leaves the toolbar for the heading line under the day cells ("Nov 29 – Dec 5",
// "Central Time"; a month's name under its grid), and "Events" and the controls share one line
// whenever they fit. Chosen by the calendar's width, never the device or the text size. Text sizes:
// 100 and 175 are the site's own (its cookie); 125, 150 and 200 are a reader's browser default font
// size, which the site's rem sizes follow (set here on the root element, as the browser setting does).
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { THEMES, setPrefs } from './prefs';
import { addDays } from './stand-in';

const TEXT = [100, 125, 150, 175, 200];
const WIDTHS = [300, 320, 344, 360, 375, 390, 412, 600, 768, 1024, 1280];
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'wcag2aaa', 'best-practice'];

/** Every period from November 2026 through December 2027: each week (month- and year-crossing ones
 * among them), each month's grid and each month's list. */
function periods(): string[] {
  const out: string[] = [];
  for (let sunday = '2026-11-01'; sunday <= '2027-12-26'; sunday = addDays(sunday, 7)) out.push(`/events?view=week&d=${sunday}`);
  for (let y = 2026, m = 11; y < 2028; m === 12 ? ((y += 1), (m = 1)) : (m += 1)) {
    const month = `${y}-${String(m).padStart(2, '0')}-01`;
    out.push(`/events?view=month&d=${month}`, `/events?view=list&d=${month}`);
  }
  return out;
}

/** The site's own sizes by its cookie; the others as a browser's default font size. */
async function useText(context: BrowserContext, baseURL: string, size: number): Promise<void> {
  await setPrefs(context, baseURL, { size: size === 175 ? 175 : 100 });
}
async function applyText(page: Page, size: number): Promise<void> {
  if (size !== 100 && size !== 175) await page.evaluate((s) => (document.documentElement.style.fontSize = `${s}%`), size);
}

interface Look {
  mode: 'full' | 'compact' | 'both' | 'neither';
  problems: string[];
}

/** Everything round 2 asks of the toolbar and the cells at this size and width. `wholePage`: the page as
 * a whole never scrolls sideways (at 200 % only the toolbar, the cells and the heading lines are held to
 * it: the event cards' longest words outgrow a 300 px screen at that size, before and after EV1). */
async function look(page: Page, wholePage = true): Promise<Look> {
  return page.evaluate((wholePage) => {
    const problems: string[] = [];
    const shown = (el: Element | null): el is HTMLElement => !!el && (el as HTMLElement).offsetParent !== null && el.getBoundingClientRect().width > 0;
    const r = (el: Element) => el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const view = document.querySelector('[data-cal]')?.getAttribute('data-cal');
    const label = [...document.querySelectorAll('.calstep__label [aria-hidden="true"]')].filter(shown);
    const switcher = document.querySelector('.calviews');
    const picker = document.querySelector('.calpick summary');
    const full = shown(switcher) && label.length > 0;
    const compact = shown(picker);
    const mode = full && compact ? 'both' : full ? 'full' : compact ? 'compact' : 'neither';
    const [prev, next] = [...document.querySelectorAll('.calstep__arrow')].filter(shown);
    if (!prev || !next) problems.push('arrows not both shown');
    if (full) {
      const [step, views] = [r(document.querySelector('.calstep')!), r(switcher!)];
      if (Math.abs(step.top - views.top) > 1) problems.push('period and switch on two rows');
      const box = r(document.querySelector('.calstep__label')!);
      for (const w of label) if (r(w).right > box.right + 0.5 || r(w).left < box.left - 0.5) problems.push('range spills');
    }
    if (compact && prev && next) {
      if (label.length > 0) problems.push('range still in the compact toolbar');
      const [a, p, b] = [r(prev), r(picker!), r(next)];
      if (!(a.right <= p.left + 0.5 && p.right <= b.left + 0.5)) problems.push('not ‹ picker › in order');
      if (Math.max(a.top, p.top, b.top) - Math.min(a.top, p.top, b.top) > 1) problems.push('‹ picker › not on one row');
      // The range in the heading line under the cells: the week's or list's heading; the month's name under its grid.
      if (view === 'month') {
        const cap = document.querySelector('.month caption');
        const grid = document.querySelector('.month tbody');
        if (!cap || r(cap).height < 10 || getComputedStyle(cap).clipPath !== 'none' || r(cap).top < r(grid!).bottom - 1) problems.push('month name not shown under the grid');
      } else {
        const head = document.querySelector('#list-title');
        if (!shown(head)) problems.push('no heading line');
      }
      if (![...document.querySelectorAll('.agenda__head .tz')].some(shown)) problems.push('no Central Time');
    }
    // Round 3: one header row. "Events" and the controls share a line whenever they fit together, the
    // heading's extra size given up first (never below the body text); the full switch only beside it.
    // Wrapped, the controls sit under "Events", at its left.
    const body = parseFloat(getComputedStyle(document.body).fontSize);
    const h1 = document.querySelector('.calendar h1');
    const tool = document.querySelector('.caltool');
    if (!h1 || !tool) problems.push('no heading or toolbar in the calendar');
    else {
      const parts = [...tool.children].filter(shown).map(r);
      const width = parts.reduce((s, b) => s + b.width, 0) + 4 * (parts.length - 1);
      const head = r(h1.parentElement!);
      const h1px = parseFloat(getComputedStyle(h1).fontSize);
      if (h1px < body - 0.1) problems.push(`"Events" (${h1px} px) under the body text (${body} px)`);
      const atBody = (r(h1).width * body) / h1px;
      // The gap, and 12 px the layout keeps to spare (it reckons "Events" at its widest, 3.4 em).
      const fits = atBody + width + parseFloat(getComputedStyle(h1.parentElement!).columnGap) + 12 <= head.width;
      const sameLine = r(tool).top < r(h1).bottom - 1;
      if (mode === 'full' && !sameLine) problems.push('the full toolbar on a row of its own, not beside "Events"');
      if (mode === 'compact' && fits && !sameLine) problems.push(`Events and the controls fit one line (${Math.round(atBody + width)} of ${Math.round(head.width)} px) but wrap`);
      if (!sameLine && Math.abs(r(tool).left - head.left) > 1) problems.push('wrapped controls not at the left under "Events"');
    }
    // Round 3: the heading line under the cells, at the body text's size and weight: the bare range
    // (week), the list's words, the month's name; Central Time beside it where it fits.
    const lines = (el: Element) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return new Set([...range.getClientRects()].filter((b) => b.width > 0).map((b) => Math.round(b.top))).size;
    };
    const asBody = (el: Element, what: string) => {
      const cs = getComputedStyle(el);
      if (Math.abs(parseFloat(cs.fontSize) - body) > 0.5 || Number(cs.fontWeight) > 400) problems.push(`${what} not body text (${cs.fontSize} ${cs.fontWeight})`);
    };
    const title = document.querySelector('#list-title');
    if (title && shown(title)) {
      asBody(title, 'the heading line');
      const words = (title.textContent ?? '').trim();
      if (view === 'week') {
        if (!/^[A-Z][a-z]{2} \d{1,2} – ([A-Z][a-z]{2} )?\d{1,2}$/.test(words)) problems.push(`the week's heading is not the bare range: "${words}"`);
        // One line up to 175 %; at 200 % a 300 px screen has less room than the longest range needs.
        if (wholePage && lines(title) > 1) problems.push(`the range takes ${lines(title)} lines`);
      }
      const tz = title.parentElement!.querySelector('.tz')!;
      const room = r(title.parentElement!).width;
      if (r(title).width + r(tz).width + parseFloat(getComputedStyle(title.parentElement!).columnGap) + 1 <= room && Math.abs(r(tz).top - r(title).top) > r(title).height / 2) problems.push('Central Time below the range though it fits beside it');
    }
    const cap = document.querySelector('.month caption');
    if (cap && shown(cap) && getComputedStyle(cap).clipPath === 'none') asBody(cap, "the month's name");
    // Never clipped, never sideways scroll, 44 px targets.
    if (wholePage && document.documentElement.scrollWidth > vw) problems.push(`page scrolls sideways ${document.documentElement.scrollWidth - vw} px`);
    // What is drawn (a visually hidden name, clipped to nothing, is not: WebKit places a hidden caption off to the side).
    for (const part of [...document.querySelectorAll('.calhead, .calhead *, .tiles--week, .month, .month__cap, .agenda__head')].filter((el) => shown(el) && getComputedStyle(el).clipPath === 'none')) {
      if (r(part).right > vw + 0.5 || r(part).left < -0.5) problems.push(`past the screen's edge: ${part.className || part.tagName}`);
    }
    for (const t of [...document.querySelectorAll('.caltool a, .caltool summary')].filter(shown)) {
      const b = r(t);
      if (b.left < -0.5 || b.right > vw + 0.5) problems.push(`clipped: ${t.textContent?.trim() || t.getAttribute('aria-label')}`);
      if (b.width < 44 || b.height < 44) problems.push(`under 44 px: ${t.textContent?.trim() || t.getAttribute('aria-label')}`);
    }
    // The day cells: weekday, date and icons inside their cell, the cell growing as it needs.
    for (const cell of document.querySelectorAll('.tiles--week .tile, .month td')) {
      const c = r(cell);
      for (const part of cell.querySelectorAll('.tile__wd, .tile__n, .ind, .n')) {
        if (!shown(part)) {
          if (part.closest('.tile') || (part.classList.contains('n') && !cell.classList.contains('out'))) problems.push(`hidden ${part.className} in ${cell.textContent?.trim()}`);
          continue;
        }
        const p = r(part);
        if (p.left < c.left - 0.5 || p.right > c.right + 0.5 || p.top < c.top - 0.5 || p.bottom > c.bottom + 0.5) problems.push(`${part.className} cut in ${(cell.textContent ?? '').trim().replace(/\s+/g, ' ')}`);
      }
    }
    return { mode, problems: [...new Set(problems)] };
  }, wholePage);
}

for (const size of TEXT) {
  test(`at ${size} % text, every period and width from 300 px: the full toolbar on one row or the compact one, never clipped`, async ({ page, context, baseURL }) => {
    test.setTimeout(300_000);
    await useText(context, baseURL!, size);
    const failures: string[] = [];
    const modes = new Set<string>();
    for (const path of periods()) {
      await page.setViewportSize({ width: WIDTHS[0]!, height: 900 });
      await page.goto(path);
      await applyText(page, size);
      await page.evaluate(() => document.fonts.ready);
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        const l = await look(page, size !== 200);
        modes.add(`${width}:${l.mode}`);
        if (l.mode === 'both' || l.mode === 'neither') failures.push(`${path} @ ${width}: ${l.mode}`);
        for (const p of l.problems) failures.push(`${path} @ ${width}: ${p}`);
      }
    }
    expect(failures, failures.slice(0, 20).join('\n')).toEqual([]);
    // Both designs are in use at this size: the compact one on a cover screen, the full one on a desktop.
    expect(modes.has('300:compact'), [...modes].join(' ')).toBe(true);
    expect(modes.has('1280:full'), [...modes].join(' ')).toBe(true);
  });
}

test('at 100 % on a desktop the full toolbar: "‹ Nov 29 – Dec 5 ›" and List | Week | Month, beside "Events"', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/events?view=week&d=2026-11-29');
  expect((await look(page)).mode).toBe('full');
  await expect(page.getByRole('navigation', { name: 'Dates' })).toContainText('Nov 29 – Dec 5');
  await expect(page.getByRole('navigation', { name: 'Calendar view' }).getByRole('link')).toHaveText(['List', 'Week', 'Month']);
  const [h1, tool] = [(await page.locator('.calendar h1').boundingBox())!, (await page.locator('.caltool').boundingBox())!];
  expect(tool.y).toBeLessThan(h1.y + h1.height);
});

// Round 3: the header row and the heading line, where the editor's concept shows them.
for (const [width, size] of [[300, 100], [344, 100], [412, 100], [412, 175]] as const) {
  test(`at ${width} px and ${size} %: "Events ‹ Week ▾ ›" on one line`, async ({ page, context, baseURL }) => {
    await useText(context, baseURL!, size);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/events?view=week&d=2026-11-29');
    expect(await look(page)).toEqual({ mode: 'compact', problems: [] });
    const [h1, tool] = [(await page.locator('.calendar h1').boundingBox())!, (await page.locator('.caltool').boundingBox())!];
    expect(tool.y).toBeLessThan(h1.y + h1.height);
  });
}

test('where "Events" and the controls cannot share a line (300 px, 175 %), the controls go under it, at its left', async ({ page, context, baseURL }) => {
  await useText(context, baseURL!, 175);
  await page.setViewportSize({ width: 300, height: 900 });
  await page.goto('/events?view=week&d=2026-11-29');
  expect(await look(page)).toEqual({ mode: 'compact', problems: [] });
  const [h1, tool] = [(await page.locator('.calendar h1').boundingBox())!, (await page.locator('.caltool').boundingBox())!];
  expect(tool.y).toBeGreaterThanOrEqual(h1.y + h1.height - 1);
  expect(Math.abs(tool.x - h1.x)).toBeLessThanOrEqual(1);
});

test('the heading line is the bare range in body text, Central Time beside it; one line at 175 % on a cover screen', async ({ page, context, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/events?view=week&d=2026-11-29');
  await expect(page.locator('#list-title')).toHaveText('Nov 29 – Dec 5');
  expect((await look(page)).problems).toEqual([]);
  await useText(context, baseURL!, 175);
  await page.setViewportSize({ width: 300, height: 900 });
  await page.goto('/events?view=week&d=2026-11-29');
  await expect(page.locator('#list-title')).toHaveText('Nov 29 – Dec 5');
  expect((await look(page)).problems).toEqual([]);
  // The section is still named by it, and the spoken range stays in full in the toolbar.
  await expect(page.getByRole('region', { name: 'Nov 29 – Dec 5' })).toHaveCount(1);
  await expect(page.getByRole('navigation', { name: 'Dates' })).toContainText('Showing the week of 29 November to 5 December 2026');
});

test.describe('the compact toolbar on a 344 px cover screen', () => {
  test.use({ viewport: { width: 344, height: 882 } });

  test('is "Events" then ‹ Week ▾ ›; the range is the heading line under the cells; a screen reader hears it all', async ({ page }) => {
    await page.goto('/events?view=week&d=2026-11-29');
    expect(await look(page)).toEqual({ mode: 'compact', problems: [] });
    const step = page.getByRole('navigation', { name: 'Dates' });
    await expect(step.getByText('Nov 29 – Dec 5')).toBeHidden();
    await expect(step).toContainText('Showing the week of 29 November to 5 December 2026');
    await expect(step.getByRole('link', { name: 'Previous week: the week of 22 to 28 November 2026' })).toBeVisible();
    await expect(step.getByRole('link', { name: 'Next week: the week of 6 to 12 December 2026' })).toBeVisible();
    const picker = page.getByRole('navigation', { name: 'Calendar view' }).locator('summary');
    await expect(picker).toHaveAccessibleName('View: Week');
    // On screen: only "Week" (the other names only size it, unseen).
    expect((await picker.innerText()).replace('View:', '').trim()).toBe('Week');
    await expect(page.locator('.agenda__head')).toContainText('Nov 29 – Dec 5');
    await expect(page.locator('.agenda__head')).toContainText('Central Time');
    const [cells, head] = [(await page.locator('.tiles--week').boundingBox())!, (await page.locator('.agenda__head').boundingBox())!];
    expect(head.y).toBeGreaterThanOrEqual(cells.y + cells.height);
  });

  test('the month says its name under the grid', async ({ page }) => {
    await page.goto('/events?view=month&d=2026-11-11');
    expect(await look(page)).toEqual({ mode: 'compact', problems: [] });
    await expect(page.locator('.month caption')).toHaveText('November 2026');
    await expect(page.locator('.month caption')).toBeVisible();
  });

  test('the picker opens List, Week and Month, each a 44 px link keeping the date, the current one marked', async ({ page }) => {
    await page.goto('/events?view=week&d=2026-11-29');
    const nav = page.getByRole('navigation', { name: 'Calendar view' });
    await nav.locator('summary').click();
    const options = nav.getByRole('link');
    await expect(options).toHaveText(['List', 'Week', 'Month']);
    await expect(nav.getByRole('link', { name: 'Week' })).toHaveAttribute('aria-current', 'page');
    await expect(nav.getByRole('link', { name: 'Month' })).toHaveAttribute('href', '/events?view=month&d=2026-11-29');
    for (const o of await options.all()) {
      const b = (await o.boundingBox())!;
      expect(b.width).toBeGreaterThanOrEqual(44);
      expect(b.height).toBeGreaterThanOrEqual(44);
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(344);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });

  test('the picker sits in exactly the same place in all three views', async ({ page }) => {
    const places = [];
    for (const path of ['/events?view=list&d=2026-11-29', '/events?view=week&d=2026-11-29', '/events?view=month&d=2026-11-29']) {
      await page.goto(path);
      places.push(await page.locator('.calpick summary').boundingBox());
    }
    expect(places[1]).toEqual(places[0]);
    expect(places[2]).toEqual(places[0]);
  });

  test('with a script, Escape and a tap elsewhere close the picker', async ({ page }) => {
    await page.goto('/events?view=week&d=2026-11-29');
    const details = page.locator('.calpick details');
    await page.locator('.calpick summary').click();
    await expect(details).toHaveAttribute('open', '');
    await page.keyboard.press('Escape');
    await expect(details).not.toHaveAttribute('open', '');
    await expect(page.locator('.calpick summary')).toBeFocused();
    await page.locator('.calpick summary').click();
    await page.locator('h1').click();
    await expect(details).not.toHaveAttribute('open', '');
  });
});

test.describe('with no script', () => {
  test.use({ javaScriptEnabled: false, viewport: { width: 300, height: 800 } });
  test('the picker opens and its links switch the view, keeping the date; Back returns', async ({ page }) => {
    await page.goto('/events?view=week&d=2026-12-27');
    expect(await look(page)).toEqual({ mode: 'compact', problems: [] });
    const nav = page.getByRole('navigation', { name: 'Calendar view' });
    await nav.locator('summary').click();
    await nav.getByRole('link', { name: 'Month' }).click();
    await expect(page).toHaveURL(/\/events\?view=month&d=2026-12-27$/);
    await expect(page.locator('.calpick summary')).toHaveAccessibleName('View: Month');
    await page.goBack();
    await expect(page).toHaveURL(/\/events\?view=week&d=2026-12-27$/);
  });
});

// The compact toolbar, its picker open, at the largest site size and on the narrowest screen, in every theme.
for (const theme of THEMES) {
  test(`axe at 300 px and 175 %, ${theme} theme, the picker open`, async ({ page, context, baseURL }) => {
    await setPrefs(context, baseURL!, { theme, size: 175 });
    await page.setViewportSize({ width: 300, height: 800 });
    await page.goto('/events?view=week&d=2026-11-29');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    expect((await look(page)).mode).toBe('compact');
    await page.locator('.calpick summary').click();
    // Clear of the phone's sticky bottom bar, as a11y.spec.ts runs it.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect(result.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  });
}

// The same at every text size, on the narrowest screen and the Fold's, the picker open.
for (const size of TEXT) {
  test(`axe at ${size} % text on 300 and 344 px, week and month, the picker open`, async ({ page, context, baseURL }) => {
    await useText(context, baseURL!, size);
    const found: string[] = [];
    for (const width of [300, 344]) {
      for (const path of ['/events?view=week&d=2026-11-29', '/events?view=month&d=2027-09-01']) {
        await page.setViewportSize({ width, height: 800 });
        await page.goto(path);
        await applyText(page, size);
        await page.locator('.calpick summary').click();
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
        for (const v of result.violations) found.push(`${width} ${path}: ${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
      }
    }
    // At 200 % on a cover screen the week's tiles show two-letter weekdays ("We 2"), which their names
    // ("Wed 2 December, …") do not contain: WCAG 2.5.3, an open decision in the report. Nothing else.
    const known = size === 200 ? found.filter((f) => /label-content-name-mismatch \(serious\): (a\[data-day="[\d-]+"\](, )?)+$/.test(f)) : [];
    expect(found.filter((f) => !known.includes(f))).toEqual([]);
  });
}
