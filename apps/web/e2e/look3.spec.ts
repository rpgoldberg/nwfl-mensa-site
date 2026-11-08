// W-LOOK3: Ross's mockup of the reader (2026-11-08): a slim breadcrumb, a pill tag for the copy, and the
// issue in ONE rounded, thin frame whose top edge is the toolbar: back, a page select and next; zoom out,
// a zoom select and zoom in; Fit width (pressed, the default) and Fit page; Download; Open in another app.
// The words show beside Fit, Download and Open on a computer; a phone shows icons only, each with its
// spoken name and a tooltip; every target stays 44 px. The page fills the frame's width, with no gap
// under the bar. Events: the month arrows in the grid's caption row, and one "Add to your calendar"
// disclosure for the subscription links.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { SIZES } from '../server/prefs.mjs';
import { MEMBERS_RULE } from '../src/lib/document';
import { MEMBERS_COPY, PUBLIC_TAG, PUBLIC_TAG_NOTE } from '../src/lib/reader';
import { setPrefs } from './prefs';
import { signIn } from './signin';
import { NEWSLETTER } from './stand-in';

const PUBLIC_READ = `/read/${NEWSLETTER.issues[0]!.publicPdf}`;
const MEMBERS_READ = `/read/${NEWSLETTER.issues[0]!.membersPdf}`;
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'wcag2aaa', 'best-practice'];

const box = async (l: Locator) => (await l.boundingBox())!;
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
/** How many rows the boxes sit on: one starts where a box is wholly below the row before. */
async function rows(locators: Locator[]): Promise<number> {
  const boxes = (await Promise.all(locators.map(box))).sort((a, b) => a.y - b.y);
  let count = 0;
  let bottom = -Infinity;
  for (const b of boxes) {
    if (b.y >= bottom - 1) {
      count++;
      bottom = b.y + b.height;
    } else bottom = Math.max(bottom, b.y + b.height);
  }
  return count;
}
const bar = (page: Page) => page.locator('[data-viewer-bar]');
/** Every control the bar shows: its buttons, its two selects and its two links. */
async function visibleControls(page: Page): Promise<Locator[]> {
  const out: Locator[] = [];
  for (const c of await bar(page).locator('button, select, a').all()) if (await c.isVisible()) out.push(c);
  return out;
}
async function opened(page: Page, path = PUBLIC_READ) {
  await page.goto(path);
  await expect(page.locator('#page-1 canvas')).toHaveCount(1);
}

for (const [name, viewport] of [['a computer', DESKTOP], ['a phone', PHONE]] as const) {
  test.describe(`the reader on ${name}`, () => {
    test.use({ viewport });

    test('one slim breadcrumb with a home link and no separate Back link, then the heading', async ({ page }) => {
      await opened(page);
      const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' });
      await expect(crumbs.getByRole('listitem')).toHaveText(['Home', 'Read the newsletter']);
      await expect(crumbs.getByRole('link', { name: 'Home', exact: true })).toHaveAttribute('href', '/');
      await expect(crumbs.getByRole('link', { name: 'Home', exact: true }).locator('svg:visible')).toHaveCount(1);
      await expect(page.getByRole('link', { name: /^Back to / })).toHaveCount(0);
      const home = await box(crumbs.getByRole('link', { name: 'Home', exact: true }));
      expect(home.height).toBeGreaterThanOrEqual(44);
      expect(home.width).toBeGreaterThanOrEqual(44);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Read the newsletter');
    });

    test('the public copy: a pill tag, then "Members can sign in for the full issue" with the link', async ({ page }) => {
      await opened(page);
      const tag = page.locator('.copy-tag');
      await expect(tag.locator('.copy-pill')).toHaveText(PUBLIC_TAG);
      await expect(tag.locator('.copy-pill svg')).toHaveCount(1);
      await expect(tag.locator('.copy-note')).toHaveText(PUBLIC_TAG_NOTE);
      await expect(tag.getByRole('link', { name: 'sign in', exact: true })).toHaveAttribute('href', `/sign-in?return=${encodeURIComponent(PUBLIC_READ)}`);
      // One line on a computer: the pill and the note side by side.
      if (name === 'a computer') expect(await rows([tag.locator('.copy-pill'), tag.locator('.copy-note')])).toBe(1);
    });

    test('the members copy: the pill says so, and the note asks not to forward it', async ({ page }) => {
      await page.goto('/news');
      await signIn(page, 'member');
      await opened(page, MEMBERS_READ);
      const tag = page.locator('.copy-tag');
      await expect(tag.locator('.copy-pill')).toHaveText(MEMBERS_COPY);
      await expect(tag.locator('.copy-note')).toHaveText(MEMBERS_RULE);
      await expect(page.locator('main .members-rule')).toHaveCount(0);
    });

    test('one rounded thin frame whose top edge is a single-row bar of at most 52 px, the page filling it with no gap', async ({ page }) => {
      await opened(page);
      const frame = page.locator('[data-viewer]');
      const style = await frame.evaluate((el) => {
        const s = getComputedStyle(el);
        return { width: s.borderTopWidth, radius: parseFloat(s.borderTopLeftRadius) };
      });
      expect(style.width).toBe('1px');
      expect(style.radius).toBeGreaterThan(0);
      const [f, b] = [await box(frame), await box(bar(page))];
      expect(b.y - f.y).toBeLessThanOrEqual(1);
      expect(b.height).toBeLessThanOrEqual(52);
      expect(await rows(await visibleControls(page))).toBe(1);
      // The page fills the frame's width at Fit width, the default, straight under the bar.
      const pages = await box(page.locator('[data-viewer-pages]'));
      const first = await box(page.locator('#page-1'));
      expect(Math.abs(first.width - pages.width)).toBeLessThanOrEqual(2);
      expect(first.y - (b.y + b.height)).toBeLessThanOrEqual(1);
      await expect(page.getByRole('button', { name: 'Fit width' })).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('[data-viewer-fit-page]')).toHaveAttribute('aria-pressed', 'false');
      expect(await sideways(page)).toBeLessThanOrEqual(0);
    });

    test('every control in the bar is a 44 px target with a spoken name and a tooltip, Download and Open among them', async ({ page }) => {
      await opened(page);
      const controls = await visibleControls(page);
      // A phone: zoom out and in give way to the zoom select, and Fit page (upright, the same as Fit width).
      expect(controls.length).toBe(name === 'a computer' ? 10 : 7);
      for (const c of controls) {
        const b = await box(c);
        const label = (await c.getAttribute('title')) ?? '';
        expect(label, await c.evaluate((el) => el.outerHTML.slice(0, 80))).not.toBe('');
        expect(b.width, label).toBeGreaterThanOrEqual(44);
        expect(b.height, label).toBeGreaterThanOrEqual(44);
        expect(b.x + b.width, label).toBeLessThanOrEqual(viewport.width);
      }
      for (const label of ['Previous page', 'Next page', 'Fit width', 'Fit page', 'Zoom out', 'Zoom in']) {
        const button = bar(page).locator(`button[aria-label="${label}"]`);
        await expect(button).toHaveAttribute('title', label);
        await expect(button).toBeVisible({ visible: name === 'a computer' || !['Fit page', 'Zoom out', 'Zoom in'].includes(label) });
      }
      await expect(bar(page).getByLabel('Page', { exact: true })).toHaveValue('1');
      await expect(bar(page).getByRole('combobox', { name: 'Zoom', exact: true })).toBeVisible();
      const download = bar(page).getByRole('link', { name: 'Download', exact: true });
      const other = bar(page).getByRole('link', { name: /^Open in another app/ });
      await expect(download).toHaveAttribute('href', `${PUBLIC_READ.replace('/read/', '/documents/')}.pdf?download=1`);
      await expect(other).toHaveAttribute('href', `${PUBLIC_READ.replace('/read/', '/documents/')}.pdf`);
      await expect(other).toHaveAttribute('title', 'Open in another app');
      // Words beside Fit, Download and Open on a computer; icons only on a phone (Ross's mockup).
      for (const word of ['Fit width', 'Fit page', 'Download', 'Open in another app']) {
        const visible = await bar(page).getByText(word, { exact: true }).isVisible();
        expect(visible, word).toBe(name === 'a computer');
      }
      for (const label of ['Previous page', 'Next page']) {
        expect((await bar(page).getByRole('button', { name: label }).innerText()).trim()).toBe('');
      }
    });

    test('the page select goes to a page, and the zoom select to a step', async ({ page }) => {
      await opened(page);
      const select = bar(page).getByLabel('Page', { exact: true });
      await expect(select.locator('option')).toHaveText(['1 / 3', '2 / 3', '3 / 3']);
      await select.selectOption('3');
      await expect(page.locator('#page-3 canvas')).toHaveCount(1);
      await expect(page.locator('#page-3')).toBeInViewport();
      const zoom = bar(page).getByRole('combobox', { name: 'Zoom', exact: true });
      await zoom.selectOption('2');
      await expect(zoom.locator('option:checked')).toHaveText('200%');
      await expect(page.getByRole('button', { name: 'Fit width' })).toHaveAttribute('aria-pressed', 'false');
      await page.getByRole('button', { name: 'Fit width' }).click();
      await expect(page.getByRole('button', { name: 'Fit width' })).toHaveAttribute('aria-pressed', 'true');
    });

    test('every control shows its focus when reached by the keyboard', async ({ page }) => {
      await opened(page);
      await bar(page).locator('button, select, a').first().focus();
      const seen = new Set<string>();
      for (let i = 0; i < 12; i++) {
        const focused = page.locator(':focus');
        if (!(await focused.evaluate((el) => !!el.closest('[data-viewer-bar]')))) break;
        const name = (await focused.getAttribute('title')) ?? '';
        seen.add(name);
        expect(await focused.evaluate((el) => getComputedStyle(el).outlineStyle), name).not.toBe('none');
        await page.keyboard.press('Tab');
      }
      expect(seen.size).toBe(name === 'a computer' ? 10 : 7);
    });

    test('at the largest text size the bar takes at most two rows, and nothing scrolls sideways', async ({ page, context, baseURL }) => {
      await setPrefs(context, baseURL!, { size: SIZES.at(-1)! });
      await page.goto(PUBLIC_READ);
      await expect(bar(page)).toBeVisible();
      expect(await rows(await visibleControls(page))).toBeLessThanOrEqual(2);
      expect(await sideways(page)).toBeLessThanOrEqual(0);
    });

    test('at 140 % the bar is still one row', async ({ page, context, baseURL }) => {
      await setPrefs(context, baseURL!, { size: 140 });
      await opened(page);
      expect(await rows(await visibleControls(page))).toBe(1);
      expect(await sideways(page)).toBeLessThanOrEqual(0);
    });

    for (const theme of ['light', 'dark', 'contrast-yellow', 'contrast-white'] as const) {
      test(`axe, ${theme}: no violation`, async ({ page, context, baseURL }) => {
        await setPrefs(context, baseURL!, { theme });
        await opened(page);
        await page.evaluate(() => document.querySelector('#page-1 .annotationLayer a')?.scrollIntoView({ block: 'center' }));
        const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
        const out = result.violations.flatMap((v) => {
          const nodes = v.id === 'target-size' ? v.nodes.filter((n) => !/^#pdfjs_internal_id_\w+$/.test(String(n.target[0]))) : v.nodes;
          return nodes.length > 0 ? [`${v.id}: ${nodes.map((n) => n.target.join(' ')).join(', ')}`] : [];
        });
        expect(out).toEqual([]);
      });
    }
  });
}

test.describe('the reader at 360 px, the narrowest common phone', () => {
  test.use({ viewport: { width: 360, height: 780 } });
  test('one row of 44 px targets, inside the screen', async ({ page }) => {
    await opened(page);
    const controls = await visibleControls(page);
    expect(await rows(controls)).toBe(1);
    for (const c of controls) {
      const b = await box(c);
      expect(b.width).toBeGreaterThanOrEqual(44);
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(360);
    }
    expect(await sideways(page)).toBeLessThanOrEqual(0);
  });
});

test.describe('the reader without JavaScript', () => {
  test.use({ javaScriptEnabled: false });
  test('the bar keeps Download and Open in another app, and shows no control that needs the script', async ({ page }) => {
    await page.goto(PUBLIC_READ);
    await expect(bar(page)).toBeVisible();
    await expect(bar(page).getByRole('link', { name: 'Download', exact: true })).toBeVisible();
    await expect(bar(page).getByRole('link', { name: /^Open in another app/ })).toBeVisible();
    await expect(bar(page).getByRole('button')).toHaveCount(0);
    await expect(bar(page).getByRole('combobox')).toHaveCount(0);
  });
});

for (const [name, viewport] of [['a computer', DESKTOP], ['a phone', PHONE]] as const) {
  test.describe(`events on ${name}`, () => {
    test.use({ viewport });

    test("the month arrows sit in the grid's caption row, with the month between them", async ({ page }) => {
      await page.goto('/events');
      const grid = page.locator('table.month');
      const head = page.locator('.month-head');
      const nav = head.getByRole('navigation', { name: 'Months' });
      const links = nav.getByRole('link');
      await expect(links).toHaveCount(2);
      const title = head.locator('.month-title');
      const caption = (await grid.locator('caption').textContent())!.trim();
      await expect(title).toHaveText(caption);
      expect(await rows([links.first(), title, links.last()])).toBe(1);
      const [h, g] = [await box(head), await box(grid)];
      expect(Math.abs(h.y + h.height - g.y)).toBeLessThanOrEqual(2);
      expect(Math.abs(h.x - g.x)).toBeLessThanOrEqual(2);
      for (const link of await links.all()) {
        await expect(link).toHaveAttribute('href', /^\/events\?month=\d{4}-\d{2}$/);
        const b = await box(link);
        expect(b.height).toBeGreaterThanOrEqual(44);
      }
      expect(await sideways(page)).toBeLessThanOrEqual(0);
    });

    test('above the grid only the breadcrumb, the heading and one line; one "Add to your calendar" disclosure under the grid', async ({ page }) => {
      await page.goto('/events');
      await expect(page.getByRole('link', { name: /^Back to / })).toHaveCount(0);
      const between = await page.evaluate(() => {
        const h1 = document.querySelector('main h1')!;
        const grid = document.querySelector('.monthbox')!;
        const out: string[] = [];
        for (const el of document.querySelectorAll('main > *, main .calendar > *, main .calgrid > *')) {
          if (h1.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING && el.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING && !el.contains(grid)) out.push(el.tagName);
        }
        return out;
      });
      expect(between).toEqual(['P']);
      const add = page.locator('details.addcal');
      await expect(add).toHaveCount(1);
      await expect(add).not.toHaveAttribute('open', '');
      const summary = add.locator('summary');
      await expect(summary).toHaveText('Add to your calendar');
      expect((await box(summary)).height).toBeGreaterThanOrEqual(44);
      expect((await box(add)).y).toBeGreaterThanOrEqual((await box(page.locator('table.month'))).y);
      await expect(add.getByRole('link', { name: 'Add our calendar', exact: true })).toBeHidden();
      await summary.click();
      for (const link of ['Add our calendar', 'Add to Google Calendar', 'Download the calendar file']) await expect(add.getByRole('link', { name: link, exact: true })).toBeVisible();
      await expect(add.locator('p.muted')).toContainText('iPhone, iPad and Mac');
      expect(await sideways(page)).toBeLessThanOrEqual(0);
    });
  });
}

// W-LOOK3 fix (the coordinator's review): at 390 px "November 2026" ran into "December". On a phone the
// arrows carry short month names ("Oct"), the whole month still in each link's name.
for (const viewport of [{ width: 360, height: 780 }, PHONE]) {
  for (const size of [100, 140]) {
    test.describe(`events caption row at ${viewport.width} x ${viewport.height}, ${size} % text`, () => {
      test.use({ viewport });
      test('the arrows and the month never overlap, nothing scrolls sideways, and each arrow keeps its month in its name', async ({ page, context, baseURL }) => {
        await setPrefs(context, baseURL!, { size });
        await page.goto('/events');
        const nav = page.getByRole('navigation', { name: 'Months' });
        const [prev, next] = [nav.locator('.mnav--prev'), nav.locator('.mnav--next')];
        const title = page.locator('.month-title > span');
        const [p, t, n] = [await box(prev), await box(title), await box(next)];
        expect(p.x + p.width, 'previous ends before the month').toBeLessThanOrEqual(t.x);
        expect(t.x + t.width, 'the month ends before next').toBeLessThanOrEqual(n.x);
        for (const b of [p, n]) {
          expect(b.width).toBeGreaterThanOrEqual(44);
          expect(b.height).toBeGreaterThanOrEqual(44);
          expect(b.x).toBeGreaterThanOrEqual(0);
          expect(b.x + b.width).toBeLessThanOrEqual(viewport.width);
        }
        await expect(prev).toHaveAccessibleName(/^[A-Z][a-z]{2} ?, previous month, (January|February|March|April|May|June|July|August|September|October|November|December) \d{4}$/);
        await expect(next).toHaveAccessibleName(/^[A-Z][a-z]{2} ?, next month, (January|February|March|April|May|June|July|August|September|October|November|December) \d{4}$/);
        // Short names on a phone: three letters showing.
        const shown = await prev.evaluate((el) => {
          let text = '';
          const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.parentElement!.getBoundingClientRect().width > 1) text += n.textContent;
          return text.trim();
        });
        expect(shown).toMatch(/^[A-Z][a-z]{2}$/);
        expect(await sideways(page)).toBeLessThanOrEqual(0);
      });
    });
  }
}
