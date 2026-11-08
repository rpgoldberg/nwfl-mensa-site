// W-LOOK2: Ross's review on his Android phone, as the installed app, signed in as an admin (2026-11-07).
// (A) the header took three rows; (B) the reader's controls took half the screen; (C) a phone had no
// month calendar; (D) "Coming up" listed today's finished event as "Past". Phone width here is 390 x 844
// in both projects; the wide screen is 1280. axe checks /, /events, /news and /read/<id> signed out and
// in, with the Account menu open.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { SIZES } from '../server/prefs.mjs';
import { centralParts } from '../src/lib/calendar';
import { setPrefs } from './prefs';
import { accountButton, banner, openAccount, signIn } from './signin';
import { NEWSLETTER } from './stand-in';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'wcag2aaa', 'best-practice'];
const READ = `/read/${NEWSLETTER.issues[0]!.publicPdf}`;
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };

/** axe, as e2e/read.spec.ts runs it: a link the PDF draws in its text may be as small as 24 px (WCAG 2.5.8's inline exception). */
async function axe(page: Page): Promise<string[]> {
  // As e2e/a11y.spec.ts and e2e/read.spec.ts do: clear of the phone's sticky bottom bar, which mid-page
  // overlays links (axe would count them as crowded); on the reader, the first page's links mid-screen.
  await page.evaluate(() => {
    const link = document.querySelector('#page-1 .annotationLayer a');
    if (link) link.scrollIntoView({ block: 'center' });
    else window.scrollTo(0, document.documentElement.scrollHeight);
  });
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const out: string[] = [];
  for (const v of result.violations) {
    const nodes = v.id === 'target-size' ? v.nodes.filter((n) => !/^#pdfjs_internal_id_\w+$/.test(String(n.target[0]))) : v.nodes;
    if (nodes.length > 0) out.push(`${v.id}: ${nodes.map((n) => n.target.join(' ')).join(', ')}`);
  }
  return out;
}

const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const box = async (l: Locator) => (await l.boundingBox())!;
/** How many rows the elements sit on: one starts where an element is wholly below the row before. */
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

test.describe('(A) the header on a phone', () => {
  test.use({ viewport: PHONE });

  for (const size of [SIZES[0], SIZES[3], SIZES[6]]) {
    test(`signed out at ${size} %: one row of the monogram, the name, Aa and Sign in`, async ({ page, context, baseURL }) => {
      await setPrefs(context, baseURL!, { size });
      await page.goto('/');
      const header = banner(page);
      const pieces = [header.locator('.monogram'), header.locator('.wordmark__text'), header.getByRole('link', { name: 'Aa Text size and theme' }), header.getByRole('link', { name: 'Sign in', exact: true })];
      for (const p of pieces) await expect(p).toBeVisible();
      expect(await rows(pieces)).toBe(1);
      expect((await box(page.locator('.site-header__bar'))).height).toBeLessThanOrEqual(72);
      expect(await sideways(page)).toBeLessThanOrEqual(0);
    });
  }

  for (const size of [SIZES[0], SIZES[3], SIZES[6]]) {
    test(`signed in as an admin at ${size} %: one row, with one Account button, a person icon over its word`, async ({ page, context, baseURL }) => {
      await setPrefs(context, baseURL!, { size });
      await page.goto('/');
      await signIn(page, 'admin');
      const header = banner(page);
      const account = accountButton(page);
      await expect(account).toBeVisible();
      await expect(account).toHaveText('Account');
      await expect(account.locator('svg')).toHaveAttribute('aria-hidden', 'true');
      expect(await rows([header.locator('.monogram'), header.locator('.wordmark__text'), header.getByRole('link', { name: 'Aa Text size and theme' }), account])).toBe(1);
      expect((await box(page.locator('.site-header__bar'))).height).toBeLessThanOrEqual(72);
      // Closed, the menu's items are not on the page at all.
      for (const name of ['Your account', 'Officer area']) await expect(header.getByRole('link', { name })).toHaveCount(0);
      await expect(header.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
      expect(await sideways(page)).toBeLessThanOrEqual(0);
    });
  }
});

test.describe('(A) the Account menu', () => {
  test.use({ viewport: PHONE });

  test('opens on a tap or click with the name, the role, Your account, the Officer area and Sign out, each a 48 px target on screen', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'admin');
    const account = accountButton(page);
    await account.click();
    const menu = page.locator('[data-account-menu]');
    await expect(menu).toHaveAttribute('open', '');
    await expect(menu.locator('.account__who')).toHaveText('Signed in as Pat Example Administrator');
    for (const control of [menu.getByRole('link', { name: 'Your account' }), menu.getByRole('link', { name: 'Officer area' }), menu.getByRole('button', { name: 'Sign out' })]) {
      await expect(control).toBeVisible();
      const b = await box(control);
      expect(b.height).toBeGreaterThanOrEqual(48);
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(PHONE.width);
    }
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    // A tap elsewhere on the page closes it (left of the menu, which covers the heading).
    await page.mouse.click(8, 600);
    await expect(menu).not.toHaveAttribute('open', '');
  });

  test('works from the keyboard: Enter opens it, Tab reaches each item, Escape closes it and gives the focus back', async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', 'WebKit’s Tab skips links by default, as Safari does');
    await page.goto('/');
    await signIn(page, 'admin');
    const account = accountButton(page);
    await account.focus();
    await page.keyboard.press('Enter');
    const menu = page.locator('[data-account-menu]');
    await expect(menu).toHaveAttribute('open', '');
    for (const name of ['Your account', 'Officer area', 'Sign out']) {
      await page.keyboard.press('Tab');
      await expect(page.locator(':focus')).toHaveAccessibleName(name);
      expect(await page.locator(':focus').evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe('none');
    }
    await page.keyboard.press('Escape');
    await expect(menu).not.toHaveAttribute('open', '');
    await expect(account).toBeFocused();
    // Tabbing on past the menu closes it.
    await page.keyboard.press('Enter');
    await expect(menu).toHaveAttribute('open', '');
    for (let i = 0; i < 4; i++) await page.keyboard.press('Tab');
    await expect(menu).not.toHaveAttribute('open', '');
  });

  test('Sign out in the menu signs the reader out', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'admin');
    await (await openAccount(page)).getByRole('button', { name: 'Sign out' }).click();
    await page.getByRole('button', { name: 'Yes, sign me out' }).click();
    await expect(page).toHaveURL(/\/signed-out$/);
    await expect(banner(page).getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.locator('[data-account-menu]')).toHaveCount(0);
  });

  test.describe('with JavaScript off', () => {
    test.use({ javaScriptEnabled: false });

    test('still opens and closes, and Sign out still posts', async ({ page }) => {
      await page.goto('/');
      await signIn(page, 'member');
      const menu = page.locator('[data-account-menu]');
      await accountButton(page).click();
      await expect(menu).toHaveAttribute('open', '');
      await expect(menu.locator('.account__who')).toHaveText('Signed in as Jordan Example Member');
      await accountButton(page).click();
      await expect(menu).not.toHaveAttribute('open', '');
      await accountButton(page).click();
      await menu.getByRole('button', { name: 'Sign out' }).click();
      await page.getByRole('button', { name: 'Yes, sign me out' }).click();
      await expect(page).toHaveURL(/\/signed-out$/);
    });
  });
});

test.describe('(A) the header on a wide screen', () => {
  test.use({ viewport: DESKTOP });

  test('keeps the name, Your account, the Officer area and Sign out in view on one row, with no Account button', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'admin');
    const header = banner(page);
    await expect(accountButton(page)).toBeHidden();
    const items = [header.locator('.account__inline .who'), header.getByRole('link', { name: 'Your account' }), header.getByRole('link', { name: 'Officer area' }), header.getByRole('button', { name: 'Sign out' })];
    for (const item of items) await expect(item).toBeVisible();
    expect(await rows([...items, header.getByRole('link', { name: 'Aa Text size and theme' }), header.locator('.wordmark__text')])).toBe(1);
  });

  test('below 1200 px, where the row would wrap, the Account menu instead', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
    await page.goto('/');
    await signIn(page, 'admin');
    await expect(accountButton(page)).toBeVisible();
    await expect(banner(page).getByRole('button', { name: 'Sign out' })).toHaveCount(0);
  });
});

test.describe('(B) the reader on a phone', () => {
  test.use({ viewport: PHONE });

  const controls = (page: Page) => {
    const bar = page.locator('[data-viewer-bar]');
    return [
      bar.getByRole('button', { name: 'Zoom out' }),
      bar.locator('[data-viewer-zoom]'),
      bar.getByRole('button', { name: 'Zoom in' }),
      bar.getByRole('button', { name: /^Fit / }),
      bar.getByRole('button', { name: 'Back a page' }),
      bar.getByLabel('Page', { exact: true }),
      bar.getByRole('button', { name: 'Next page' }),
    ];
  };

  for (const size of [SIZES[0], SIZES[2], SIZES[3], SIZES[4]]) {
    test(`at ${size} % the controls are one row, each at least 48 px, every icon with a visible word`, async ({ page, context, baseURL }) => {
      await setPrefs(context, baseURL!, { size });
      await page.goto(READ);
      await expect(page.locator('#page-1 canvas')).toHaveCount(1);
      const all = controls(page);
      expect(await rows(all)).toBe(1);
      for (const c of all) {
        const b = await box(c);
        expect(b.height, String(c)).toBeGreaterThanOrEqual(48);
        expect(b.x + b.width).toBeLessThanOrEqual(PHONE.width);
      }
      for (const button of await page.locator('[data-viewer-bar] button').all()) {
        // One icon showing, and a word beside it.
        expect(await button.locator('svg:visible').count(), (await button.getAttribute('aria-label')) ?? '').toBe(1);
        expect((await button.innerText()).trim(), (await button.getAttribute('aria-label')) ?? '').not.toBe('');
        const b = await box(button);
        expect(b.width).toBeGreaterThanOrEqual(48);
      }
      expect(await sideways(page)).toBeLessThanOrEqual(0);
    });
  }

  for (const size of [SIZES[5], SIZES[6]]) {
    test(`at ${size} % the controls take at most two rows`, async ({ page, context, baseURL }) => {
      await setPrefs(context, baseURL!, { size });
      await page.goto(READ);
      await expect(page.locator('[data-viewer-bar]')).toBeVisible();
      expect(await rows(controls(page))).toBeLessThanOrEqual(2);
      expect(await sideways(page)).toBeLessThanOrEqual(0);
    });
  }

  test('while reading, the bar stays at the top and the page gets at least 70 % of the screen', async ({ page }) => {
    await page.goto(READ);
    await expect(page.locator('#page-1 canvas')).toHaveCount(1);
    await page.locator('#page-1').evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(200);
    const bar = await box(page.locator('[data-viewer-bar]'));
    expect(Math.round(bar.y)).toBe(0);
    const dock = page.locator('.dock');
    const bottom = (await dock.isVisible()) ? (await box(dock)).y : PHONE.height;
    expect((bottom - (bar.y + bar.height)) / PHONE.height).toBeGreaterThanOrEqual(0.7);
  });

  test('Open in another app and Download sit below the issue, out of the bar', async ({ page }) => {
    await page.goto(READ);
    await expect(page.locator('#page-1 canvas')).toHaveCount(1);
    const open = page.getByRole('link', { name: /^Open in another app/ });
    const download = page.getByRole('link', { name: 'Download', exact: true });
    for (const link of [open, download]) {
      await expect(link).toHaveCount(1);
      expect(await link.evaluate((el) => !!(document.querySelector('[data-viewer-pages]')!.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
      await expect(page.locator('[data-viewer-bar]').locator('a')).toHaveCount(0);
    }
  });

  test('the one Fit control offers the other fit, and after a zoom the width again', async ({ page }) => {
    await page.goto(READ);
    await expect(page.locator('#page-1 canvas')).toHaveCount(1);
    const zoom = page.locator('[data-viewer-zoom]');
    const fit = page.locator('[data-viewer-fit]');
    // A phone opens at the width; the control offers the whole page, which held upright is no smaller.
    await expect(fit).toHaveAccessibleName('Fit whole page');
    await expect(fit).toHaveText('Whole');
    const atWidth = await zoom.textContent();
    await fit.click();
    expect(parseInt((await zoom.textContent())!, 10)).toBeLessThanOrEqual(parseInt(atWidth!, 10));
    await expect(fit).toHaveAccessibleName('Fit width');
    await expect(fit).toHaveText('Width');
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await expect(zoom).not.toHaveText(atWidth!);
    // Zoomed, it offers the fit the phone opened at, and takes the reader back there.
    await expect(fit).toHaveAccessibleName('Fit width');
    await fit.click();
    await expect(zoom).toHaveText(atWidth!);
    await expect(fit).toHaveAccessibleName('Fit whole page');
  });
});

test.describe('(C) the month grid', () => {
  for (const [name, viewport] of [['a phone', PHONE], ['a wide screen', DESKTOP]] as const) {
    test(`on ${name}: seven columns before the list, each day with events a link to its place in the list`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto('/events');
      const grid = page.locator('table.month');
      await expect(grid).toBeVisible();
      await expect(grid.locator('thead th')).toHaveCount(7);
      // Before the list, and on a phone above it.
      const list = page.getByRole('heading', { name: 'Coming up', exact: true });
      expect(await grid.evaluate((el, h) => !!(el.compareDocumentPosition(h!) & Node.DOCUMENT_POSITION_FOLLOWING), await list.elementHandle())).toBe(true);
      if (name === 'a phone') expect((await box(grid)).y + (await box(grid)).height).toBeLessThanOrEqual((await box(list)).y);
      const days = grid.locator('a.day');
      expect(await days.count()).toBeGreaterThan(2);
      const DAY = /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), \d{1,2} (January|February|March|April|May|June|July|August|September|October|November|December)(, today)?, \d+ events?(, (\d+ )?cancelled)?$/;
      for (const day of await days.all()) {
        await expect(day).toHaveAccessibleName(DAY);
        const b = await box(day);
        expect(b.height).toBeGreaterThanOrEqual(48);
        expect(b.width).toBeGreaterThanOrEqual(48);
        // A phone shows a dot for each event; a wide screen lists their titles instead.
        if (name === 'a phone') await expect(day.locator('.dots')).toBeVisible();
        else await expect(day.locator('xpath=following-sibling::ul[1]')).toBeVisible();
      }
      // The next day with an event in the list: its link goes to that day's first entry there.
      const href = (await days.last().getAttribute('href'))!;
      expect(href).toMatch(/^(#day-\d{4}-\d{2}-\d{2}|\/events\?month=\d{4}-\d{2}#day-\d{4}-\d{2}-\d{2})$/);
      const listed = grid.locator('a.day[href^="#day-"]').last();
      const target = (await listed.getAttribute('href'))!;
      await listed.click();
      await expect(page).toHaveURL(new RegExp(`${target}$`));
      await expect(page.locator(target)).toBeInViewport();
      // The months either side are still a link away.
      for (const month of await page.getByRole('navigation', { name: 'Months' }).getByRole('link').all()) await expect(month).toHaveAttribute('href', /^\/events\?month=\d{4}-\d{2}$/);
      expect(await sideways(page)).toBeLessThanOrEqual(0);
    });
  }

  test('marks today by more than colour: a ring and a filled number, and the word in its name', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto('/events');
    const today = page.locator('table.month td[aria-current="date"]');
    await expect(today).toHaveCount(1);
    const look = await today.evaluate((td) => ({ ring: getComputedStyle(td).boxShadow, fill: getComputedStyle(td.querySelector('.n')!).backgroundColor }));
    expect(look.ring).not.toBe('none');
    expect(look.fill).not.toBe('rgba(0, 0, 0, 0)');
    const link = today.locator('a.day');
    if (await link.count()) await expect(link).toHaveAccessibleName(/, today, /);
    else await expect(today).toContainText(/, today, no events$/);
  });

  test('at the largest size on a phone the grid still fits, no word broken', async ({ page, context, baseURL }) => {
    await setPrefs(context, baseURL!, { size: SIZES[6] });
    await page.setViewportSize(PHONE);
    await page.goto('/events');
    await expect(page.locator('table.month')).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    for (const day of await page.locator('table.month a.day').all()) expect((await box(day)).width).toBeGreaterThanOrEqual(48);
  });
});

test.describe('(D) Coming up', () => {
  // The stand-in API has "Early coffee" today, 00:00 to 00:01 Central: over by now, but in the first minutes of the day.
  const over = () => centralParts(new Date()).time > '00:01';

  test('leaves out what ended earlier today, on the home page and the events page, and never says "Past"', async ({ page }) => {
    test.skip(!over(), 'The first minutes of the day in Central: Early coffee has not ended yet');
    for (const [path, list] of [['/', 'Coming up this week'], ['/events', 'Coming up']] as const) {
      await page.goto(path);
      const coming = page.getByRole('list', { name: list, exact: true });
      await expect(coming.getByRole('listitem').first()).toBeVisible();
      await expect(coming).not.toContainText('Early coffee');
      await expect(coming.getByText('Past', { exact: true })).toHaveCount(0);
    }
  });

  test('the month view still lists it, as Past', async ({ page }) => {
    test.skip(!over(), 'The first minutes of the day in Central: Early coffee has not ended yet');
    const month = centralParts(new Date()).date.slice(0, 7);
    await page.goto(`/events?month=${month}`);
    const item = page.getByRole('list', { name: /, as a list$/ }).getByRole('listitem').filter({ hasText: 'Early coffee' });
    await expect(item).toHaveCount(1);
    await expect(item.getByText('Past', { exact: true })).toBeVisible();
  });
});

test.describe('axe on the pages Ross reviewed', () => {
  for (const [name, viewport] of [['phone', PHONE], ['wide', DESKTOP]] as const) {
    for (const theme of ['light', 'dark', 'contrast-yellow'] as const) {
      test(`${name}, ${theme}: signed out, then signed in with the Account menu open`, async ({ page, context, baseURL }) => {
        test.slow();
        await page.setViewportSize(viewport);
        await setPrefs(context, baseURL!, { theme });
        for (const path of ['/', '/events', '/news', READ]) {
          await page.goto(path);
          if (path === READ) await expect(page.locator('#page-1 canvas')).toHaveCount(1);
          expect(await axe(page), `${path} signed out`).toEqual([]);
        }
        await page.goto('/');
        await signIn(page, 'admin');
        for (const path of ['/', '/events', '/news', READ]) {
          await page.goto(path);
          if (path === READ) await expect(page.locator('#page-1 canvas')).toHaveCount(1);
          if (name === 'phone') await openAccount(page);
          expect(await axe(page), `${path} signed in`).toEqual([]);
        }
      });
    }
  }
});
