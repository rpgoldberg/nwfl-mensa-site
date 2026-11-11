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
import { barControls, control, moreList, onBar, pageBox, pickZoom, typePage } from './viewer-bar';

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
/** Every control the bar shows: its buttons, its links and (READER2) the page box. */
const visibleControls = barControls;
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
      await expect(onBar(page, 'fit-width')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('[data-viewer-fit-page]')).toHaveAttribute('aria-pressed', 'false');
      expect(await sideways(page)).toBeLessThanOrEqual(0);
    });

    test('every control in the bar is a 44 px target with a spoken name and a tooltip, Download and Open among them', async ({ page }) => {
      await opened(page);
      const controls = await visibleControls(page);
      // READER2: a computer shows them all; a phone the page controls, search and More, which holds the rest.
      expect(controls.length).toBe(name === 'a computer' ? 13 : 7);
      for (const c of controls) {
        const b = await box(c);
        const label = (await c.getAttribute('title')) ?? '';
        expect(label, await c.evaluate((el) => el.outerHTML.slice(0, 80))).not.toBe('');
        expect(b.width, label).toBeGreaterThanOrEqual(44);
        expect(b.height, label).toBeGreaterThanOrEqual(44);
        expect(b.x + b.width, label).toBeLessThanOrEqual(viewport.width);
      }
      for (const label of ['First page', 'Previous page', 'Next page', 'Last page', 'Fit width', 'Fit page', 'Zoom out', 'Zoom in']) {
        const button = bar(page).locator(`.viewer-group button[aria-label="${label}"]`);
        await expect(button).toHaveAttribute('title', label);
        await expect(button).toBeVisible({ visible: name === 'a computer' || !['Fit width', 'Fit page', 'Zoom out', 'Zoom in'].includes(label) });
      }
      await expect(bar(page).getByRole('textbox', { name: 'Page number, 1 to 3', exact: true })).toBeVisible();
      await expect(bar(page).getByRole('button', { name: 'Search this issue', exact: true })).toBeVisible();
      await expect(bar(page).getByRole('button', { name: /^Zoom \d+%$/ })).toBeVisible({ visible: name === 'a computer' });
      const download = onBar(page, 'download');
      const other = onBar(page, 'open');
      await expect(download).toHaveAttribute('href', `${PUBLIC_READ.replace('/read/', '/documents/')}.pdf?download=1`);
      await expect(other).toHaveAttribute('href', `${PUBLIC_READ.replace('/read/', '/documents/')}.pdf`);
      await expect(other).toHaveAttribute('title', 'Open in another app');
      // Words beside Fit, Download and Open on a computer; icons only on a phone (Ross's mockup).
      for (const word of ['Fit width', 'Fit page', 'Download', 'Open in another app']) {
        const visible = await bar(page).locator('.viewer-group').getByText(word, { exact: true }).isVisible();
        expect(visible, word).toBe(name === 'a computer');
      }
      for (const label of ['First page', 'Previous page', 'Next page', 'Last page']) {
        expect((await bar(page).getByRole('button', { name: label }).innerText()).trim()).toBe('');
      }
      // On a phone, Download and Open in another app are in the More menu, with their names.
      if (name === 'a phone') {
        for (const act of ['download', 'open'] as const) {
          const copy = await control(page, act);
          await expect(copy).toHaveAccessibleName(act === 'download' ? 'Download' : /^Open in another app/);
          expect((await copy.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        }
      }
    });

    test('the page box goes to a page, and the zoom picker to a step', async ({ page }) => {
      await opened(page);
      await expect(pageBox(page)).toHaveValue('1');
      await expect(bar(page).locator('[data-viewer-count]')).toHaveText('3');
      await expect(bar(page).locator('.vpage__word')).toBeVisible();
      await typePage(page, 3);
      await expect(page.locator('#page-3 canvas')).toHaveCount(1);
      await expect(page.locator('#page-3')).toBeInViewport();
      await pickZoom(page, '200%');
      await expect(bar(page).locator('[data-viewer-zoom]')).toHaveText('200%');
      await expect(onBar(page, 'fit-width')).toHaveAttribute('aria-pressed', 'false');
      await (await control(page, 'fit-width')).click();
      await expect(onBar(page, 'fit-width')).toHaveAttribute('aria-pressed', 'true');
    });

    test('every control shows its focus when reached by the keyboard', async ({ page }) => {
      await opened(page);
      await bar(page).locator('button, select, a').first().focus();
      const seen = new Set<string>();
      for (let i = 0; i < 16; i++) {
        const focused = page.locator(':focus');
        if (!(await focused.evaluate((el) => !!el.closest('[data-viewer-bar]')))) break;
        const name = (await focused.getAttribute('title')) ?? '';
        seen.add(name);
        expect(await focused.evaluate((el) => getComputedStyle(el).outlineStyle), name).not.toBe('none');
        await page.keyboard.press('Tab');
      }
      expect(seen.size).toBe(name === 'a computer' ? 13 : 7);
    });

    test('at the largest text size the bar takes at most two rows, and nothing scrolls sideways', async ({ page, context, baseURL }) => {
      await setPrefs(context, baseURL!, { size: SIZES.at(-1)! });
      // READER2: once wired, as the More menu then takes what has no room.
      await page.goto(PUBLIC_READ);
      await expect(page.locator('[data-viewer].viewer--js')).toHaveCount(1);
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

// W-LOOK3 fix: WebKit raises a style-src-attr violation for a native select under the site's CSP (no
// 'unsafe-inline'), which Chromium does not; so the reader must hold none, wherever it is run.
test('the reader holds no native select, which WebKit cannot draw under the site\'s CSP', async ({ page }) => {
  await opened(page);
  await expect(page.locator('select')).toHaveCount(0);
  // An open picker, or on a phone the More menu, stays inside the screen.
  const zoom = page.locator('[data-viewer-zoom]');
  if (await zoom.isVisible()) await zoom.click();
  else await page.locator('[data-viewer-more]').click();
  const list = await box((await zoom.isVisible()) ? page.locator('[data-viewer-zoom-list]') : moreList(page));
  expect(list.x).toBeGreaterThanOrEqual(0);
  expect(list.x + list.width).toBeLessThanOrEqual(page.viewportSize()!.width);
});

test.describe('the reader without JavaScript', () => {
  test.use({ javaScriptEnabled: false });
  test('the bar keeps Download and Open in another app, and shows no control that needs the script', async ({ page }) => {
    await page.goto(PUBLIC_READ);
    await expect(bar(page)).toBeVisible();
    await expect(bar(page).getByRole('link', { name: 'Download', exact: true })).toBeVisible();
    await expect(bar(page).getByRole('link', { name: /^Open in another app/ })).toBeVisible();
    await expect(bar(page).getByRole('button')).toHaveCount(0);
    for (const picker of await bar(page).locator('[data-viewer-page], [data-viewer-zoom]').all()) await expect(picker).toBeHidden();
  });
});

// The events caption row and "Add to your calendar": EVENTS2 replaced them (Ross's concept, 11-10); e2e/events2.spec.ts
// checks the one toolbar and "Add our calendar" at 320, 344 and 390 px and the largest text size.
