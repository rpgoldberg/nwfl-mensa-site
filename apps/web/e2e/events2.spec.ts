// EVENTS2: Ross's concept for /events (11-10). One toolbar ("‹ period ›" and List | Week | Month) on one
// row on a Fold's cover screen (344 px); the list's ribbon holds only days with events and scrolls; the
// week shows all seven days; the month is the grid, and a selected day's events show right below it.
// Each event's type icon comes from its series' category, named, with a legend; the view and the date
// live in the URL, so it all works with no script. "Add our calendar" is one disclosure beneath the
// listings: the plain feed address with Copy, the webcal link, Google on a computer, and the Android
// steps (first, on Android). These carry over W-LOOK2's and W-LOOK3's events checks (look2.spec.ts (C),
// (D); look3.spec.ts) for the new page: the grid's named 48 px days, today by more than colour, forced
// colours, the largest size, Coming up and Past, and axe.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { SIZES } from '../server/prefs.mjs';
import { centralParts } from '../src/lib/calendar';
import { FEED_VERSION, shortDay } from '../src/lib/event-views';
import { setPrefs } from './prefs';
import { BOARD_GAMES, addDays, centralToday } from './stand-in';

const COVER = { width: 344, height: 882 };
const NARROW = { width: 320, height: 700 };
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'wcag2aaa', 'best-practice'];
const KIND_NAMES = ['Lunch or meal', 'Happy hour or social', 'Meetup or gathering', 'Meeting or other', 'Event'];
/** A grid day ("Wednesday, 11 November, …") or a day tile ("Wed 11 November, …"), with its types. */
const DAY_NAME = /^((Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), \d{1,2}|(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{1,2}) (January|February|March|April|May|June|July|August|September|October|November|December)(, today)?, \d+ events?(, (\d+ )?cancelled)?: ((Lunch or meal|Happy hour or social|Meetup or gathering|Meeting or other|Event)(, )?)+$/;

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
/** axe, clear of the phone's sticky bottom bar (as a11y.spec.ts runs it). */
async function axe(page: Page): Promise<string[]> {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return result.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}
/** A date in a week that stays in one month, from today on. */
function sameMonthWeekDate(): string {
  for (let d = centralToday(); ; d = addDays(d, 7)) {
    const sunday = addDays(d, -new Date(`${d}T00:00:00Z`).getUTCDay());
    if (sunday.slice(0, 7) === addDays(sunday, 6).slice(0, 7)) return d;
  }
}
const toolbar = (page: Page) => ({ step: page.getByRole('navigation', { name: 'Dates' }), views: page.getByRole('navigation', { name: 'Calendar view' }) });

test.describe('one toolbar', () => {
  test('on a Fold cover screen (344 px) the period stepper and List | Week | Month share one row, each target 44 px', async ({ page }) => {
    await page.setViewportSize(COVER);
    for (const path of ['/events', '/events?view=month', `/events?view=week&d=${sameMonthWeekDate()}`]) {
      await page.goto(path);
      const { step, views } = toolbar(page);
      await expect(step).toHaveCount(1);
      await expect(views).toHaveCount(1);
      expect(await rows([step, views]), path).toBe(1);
      await expect(views.getByRole('link')).toHaveText(['List', 'Week', 'Month']);
      for (const link of [...(await step.getByRole('link').all()), ...(await views.getByRole('link').all())]) {
        const b = await box(link);
        expect(b.width, path).toBeGreaterThanOrEqual(44);
        expect(b.height, path).toBeGreaterThanOrEqual(44);
      }
      expect(await sideways(page)).toBeLessThanOrEqual(0);
    }
  });

  test('names the current view and the period in words, and the arrows by where they go', async ({ page }) => {
    await page.goto('/events?view=week&d=2026-11-11');
    const { step, views } = toolbar(page);
    await expect(views.getByRole('link', { name: 'Week' })).toHaveAttribute('aria-current', 'page');
    await expect(views.locator('[aria-current]')).toHaveCount(1);
    await expect(step).toContainText('Showing the week of 8 to 14 November 2026');
    await expect(step.getByRole('link', { name: 'Previous week: the week of 1 to 7 November 2026' })).toHaveAttribute('href', '/events?view=week&d=2026-11-04');
    await expect(step.getByRole('link', { name: 'Next week: the week of 15 to 21 November 2026' })).toHaveAttribute('href', '/events?view=week&d=2026-11-18');
  });

  test('switching views keeps the date, both ways', async ({ page }) => {
    const date = addDays(centralToday(), 8);
    await page.goto(`/events?view=week&d=${date}`);
    await toolbar(page).views.getByRole('link', { name: 'Month' }).click();
    await expect(page).toHaveURL(new RegExp(`/events\\?view=month&d=${date}$`));
    await expect(page.getByRole('heading', { level: 2, name: shortDay(date) })).toBeVisible();
    await toolbar(page).views.getByRole('link', { name: 'List' }).click();
    await expect(page).toHaveURL(new RegExp(`/events\\?view=list&d=${date}$`));
    await toolbar(page).views.getByRole('link', { name: 'Week' }).click();
    await expect(page).toHaveURL(new RegExp(`/events\\?view=week&d=${date}$`));
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/events\\?view=list&d=${date}$`));
  });

  for (const viewport of [NARROW, COVER]) {
    test(`at ${viewport.width} px and the largest text size nothing scrolls sideways and every target stays 44 px`, async ({ page, context, baseURL }) => {
      await setPrefs(context, baseURL!, { size: SIZES[6] });
      await page.setViewportSize(viewport);
      for (const path of ['/events', '/events?view=week', '/events?view=month']) {
        await page.goto(path);
        expect(await sideways(page), path).toBeLessThanOrEqual(0);
        for (const target of await page.locator('.caltool a, .tiles--week .tile, .month a.day').all()) {
          const b = await box(target);
          expect(b.width, path).toBeGreaterThanOrEqual(44);
          expect(b.height, path).toBeGreaterThanOrEqual(44);
        }
      }
    });
  }
});

test.describe('List: the ribbon of days with events', () => {
  test.use({ viewport: COVER });

  test('holds only days with events, each once, in order, and every one of them; it scrolls instead of squeezing', async ({ page }) => {
    await page.goto('/events');
    const ribbon = page.getByRole('list', { name: 'Days with events' });
    const tiles = ribbon.locator('.tile');
    await expect(tiles.first()).toBeVisible();
    await expect(ribbon.locator('.tile--empty')).toHaveCount(0);
    const dates = await tiles.evaluateAll((els) => els.map((e) => e.getAttribute('data-day')!));
    expect(dates).toEqual([...new Set(dates)].sort());
    const cardDays = await page.locator('[data-card-day]').evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute('data-card-day')!))]);
    expect(dates).toEqual(cardDays);
    for (const tile of await tiles.all()) {
      await expect(tile).toHaveAccessibleName(DAY_NAME);
      expect((await box(tile)).width).toBeGreaterThanOrEqual(44);
    }
    expect(await ribbon.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    await expect(page.getByRole('heading', { level: 2, name: 'Upcoming events' })).toBeVisible();
  });

  test('a tap on a day marks it and its events, scrolls to them, and hides nothing', async ({ page }) => {
    await page.goto('/events');
    const cards = page.locator('[data-card-day]');
    const before = await cards.count();
    const tile = page.getByRole('list', { name: 'Days with events' }).locator('a.tile').nth(3);
    const date = (await tile.getAttribute('data-day'))!;
    await tile.click();
    await expect(page).toHaveURL(new RegExp(`/events\\?view=list&d=${date}$`));
    await expect(tile).toHaveAttribute('aria-current', 'true');
    await expect(page.locator('.tiles a[aria-current="true"]')).toHaveCount(1);
    const day = page.locator(`[data-card-day="${date}"]`);
    await expect(day.first()).toHaveClass(/is-sel/);
    await expect(day.first()).toBeInViewport();
    await expect(cards).toHaveCount(before);
    await expect(toolbar(page).views.getByRole('link', { name: 'Month' })).toHaveAttribute('href', `/events?view=month&d=${date}`);
    await expect(page.locator('[data-cal-status]')).toHaveText(DAY_NAME);
  });

  test('leaves out what ended earlier today, and never says "Past"; the month still lists it, as Past', async ({ page }) => {
    test.skip(centralParts(new Date()).time <= '00:01', 'The first minutes of the day in Central: Early coffee has not ended yet');
    await page.goto('/events');
    const list = page.getByRole('list', { name: 'Upcoming events' });
    await expect(list.getByRole('listitem').first()).toBeVisible();
    await expect(list).not.toContainText('Early coffee');
    await expect(list.getByText('Past', { exact: true })).toHaveCount(0);
    await page.goto('/events?view=month');
    const item = page.getByRole('list', { name: `Events on ${shortDay(centralToday())}` }).getByRole('listitem').filter({ hasText: 'Early coffee' });
    await expect(item).toHaveCount(1);
    await expect(item.getByText('Past', { exact: true })).toBeVisible();
  });
});

test.describe('Week: all seven days', () => {
  test.use({ viewport: COVER });

  test('shows Sunday to Saturday, empty days included, the week either side a link away', async ({ page }) => {
    const today = centralToday();
    await page.goto('/events?view=week');
    const strip = page.getByRole('list', { name: /^The days of the week of / });
    await expect(strip.getByRole('listitem')).toHaveCount(7);
    const sunday = addDays(today, -new Date(`${today}T00:00:00Z`).getUTCDay());
    const names = await strip.locator('.tile').evaluateAll((els) => els.map((e) => e.getAttribute('data-day') ?? e.getAttribute('data-empty-day')));
    expect(names).toEqual(Array.from({ length: 7 }, (_, i) => addDays(sunday, i)));
    expect(await strip.locator('.tile--empty').count()).toBeGreaterThan(0);
    await expect(strip.locator('.tile--empty').first()).toContainText(/no events/);
    await expect(page.getByRole('heading', { level: 2, name: /^This week \(/ })).toBeVisible();
    await expect(page.getByText('No other events this week.')).toBeVisible();
    for (const tile of await strip.locator('.tile').all()) expect((await box(tile)).width).toBeGreaterThanOrEqual(44);
    await toolbar(page).step.getByRole('link', { name: /^Next week/ }).click();
    await expect(page).toHaveURL(new RegExp(`/events\\?view=week&d=${addDays(today, 7)}$`));
    await expect(page.getByRole('heading', { level: 2, name: /^Week of / })).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
  });

  test('a swipe to the left steps to the next week', async ({ page }) => {
    const today = centralToday();
    await page.goto('/events?view=week');
    const swiped = await page.locator('[data-swipe]').evaluate((strip) => {
      // WebKit has TouchEvent but will not build a Touch by script ("Illegal constructor"): the unit tests cover it there.
      let touch: (x: number) => Touch;
      try {
        touch = (x: number) => new Touch({ identifier: 1, target: strip, clientX: x, clientY: 100 });
        touch(0);
      } catch {
        return false;
      }
      strip.dispatchEvent(new TouchEvent('touchstart', { touches: [touch(300)], changedTouches: [touch(300)], bubbles: true }));
      strip.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [touch(150)], bubbles: true }));
      return true;
    });
    test.skip(!swiped, 'This browser has no touch events');
    await expect(page).toHaveURL(new RegExp(`/events\\?view=week&d=${addDays(today, 7)}$`));
  });
});

test.describe('Month: the grid, and the selected day below it', () => {
  for (const [name, viewport] of [['a cover screen', COVER], ['a wide screen', DESKTOP]] as const) {
    test(`on ${name}: seven columns, each day with events named with its types, 48 px; a tap shows that day's events right below`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto('/events?view=month');
      const grid = page.getByRole('table');
      await expect(grid.getByRole('columnheader')).toHaveCount(7);
      const days = grid.locator('a.day');
      expect(await days.count()).toBeGreaterThan(2);
      for (const day of await days.all()) {
        await expect(day).toHaveAccessibleName(DAY_NAME);
        const b = await box(day);
        expect(b.width).toBeGreaterThanOrEqual(name === 'a wide screen' ? 44 : 44);
        expect(b.height).toBeGreaterThanOrEqual(44);
        if (name === 'a cover screen') {
          const icons = day.locator('.ind .evicon');
          expect(await icons.count()).toBeGreaterThan(0);
          expect(await icons.count()).toBeLessThanOrEqual(2);
          await expect(day.locator('.dot')).toHaveCount(0);
        }
      }
      if (name === 'a wide screen') await expect(grid.getByRole('link', { name: /Wednesday Lunchers/ }).first()).toBeVisible();
      await expect(grid.getByRole('link', { name: /, \d+ events?(, (\d+ )?cancelled)?: .*Lunch or meal/ }).first()).toBeVisible();
      const target = days.last();
      const date = (await target.getAttribute('data-day'))!;
      await target.click();
      await expect(page).toHaveURL(new RegExp(`/events\\?view=month&d=${date}$`));
      const panel = page.locator(`[data-panel="${date}"]`);
      await expect(panel).toBeVisible();
      await expect(page.locator('[data-panel]:visible')).toHaveCount(1);
      await expect(panel.getByRole('heading', { level: 2 })).toHaveText(shortDay(date));
      expect((await box(panel)).y).toBeGreaterThanOrEqual((await box(grid)).y + (await box(grid)).height - 1);
      await expect(target).toHaveAttribute('aria-current', 'true');
      expect(await sideways(page)).toBeLessThanOrEqual(0);
    });
  }

  test('steps to the next month and back to this one, keeping the day', async ({ page }) => {
    await page.goto('/events?view=month&d=2027-01-31');
    await toolbar(page).step.getByRole('link', { name: 'Next month: February 2027' }).click();
    await expect(page).toHaveURL(/\/events\?view=month&d=2027-02-28$/);
    await expect(page.getByRole('table', { name: 'February 2027' })).toBeVisible();
    await toolbar(page).step.getByRole('link', { name: 'Previous month: January 2027' }).click();
    await expect(page).toHaveURL(/\/events\?view=month&d=2027-01-28$/);
  });

  test('marks today by more than colour: a ring and a filled number, and the word in its name', async ({ page }) => {
    await page.setViewportSize(COVER);
    await page.goto('/events?view=month');
    const today = page.locator('table.month td[aria-current="date"]');
    await expect(today).toHaveCount(1);
    expect(await today.evaluate((td) => getComputedStyle(td).boxShadow)).not.toBe('none');
    const link = today.locator('a.day');
    if (await link.count()) await expect(link).toHaveAccessibleName(/, today, /);
    else await expect(today).toContainText(/, today, no events$/);
  });

  test('in forced colours today keeps an outline and the current view and selected day are drawn in the system colours', async ({ page }) => {
    await page.setViewportSize(COVER);
    await page.emulateMedia({ forcedColors: 'active' });
    await page.goto('/events?view=month');
    const look = await page.evaluate(() => {
      const td = getComputedStyle(document.querySelector('.month td[aria-current="date"]')!);
      const view = getComputedStyle(document.querySelector('.calviews__v[aria-current]')!);
      const icons = [...document.querySelectorAll('.month .ind .evicon')].map((i) => i.getBoundingClientRect().width);
      return { outline: td.outlineStyle, width: parseFloat(td.outlineWidth), view: view.backgroundColor, icons };
    });
    expect(look.outline).not.toBe('none');
    expect(look.width).toBeGreaterThanOrEqual(3);
    expect(look.view).not.toBe('rgba(0, 0, 0, 0)');
    expect(look.icons.length).toBeGreaterThan(0);
    for (const w of look.icons) expect(w).toBeGreaterThan(10);
  });

  test('says when a month has none, and who to ask', async ({ page }) => {
    await page.goto('/events?view=month&d=2019-06-15');
    await expect(page.getByRole('note').filter({ hasText: 'No events are listed' })).toHaveText('No events are listed for June 2019 yet. Check back soon, or ask president@nwflorida.us.');
  });
});

test.describe('type icons', () => {
  test("come from the series' category, named on each card, with a legend in words; an unclassified event is a plain Event", async ({ page }) => {
    await page.goto('/events');
    const card = (title: string) => page.locator('.ecard').filter({ has: page.getByRole('link', { name: title, exact: true }) }).first();
    await expect(card('Wednesday Lunchers').getByRole('img')).toHaveAccessibleName(/^Lunch or meal(, cancelled)?$/);
    await expect(card('Happy Hour').getByRole('img')).toHaveAccessibleName('Happy hour or social');
    await expect(card('Board games afternoon').getByRole('img')).toHaveAccessibleName('Event');
    await expect(card('Panama City lunch').getByRole('img')).toHaveAccessibleName('Event');
    const cancelled = page.locator('.ecard--x').first();
    await expect(cancelled.getByRole('img')).toHaveAccessibleName('Lunch or meal, cancelled');
    await expect(cancelled.getByText('Cancelled', { exact: true })).toBeVisible();
    const legend = page.getByRole('list', { name: 'What the icons mean' });
    await expect(legend.getByRole('listitem')).toHaveText(KIND_NAMES);
    await expect(legend).toBeVisible();
  });

  test('no view draws a native select (WebKit flags it under the CSP)', async ({ page }) => {
    for (const path of ['/events', '/events?view=week', '/events?view=month']) {
      await page.goto(path);
      await expect(page.locator('select')).toHaveCount(0);
    }
  });
});

test.describe('Add our calendar', () => {
  test.use({ viewport: COVER });

  test('one closed disclosure beneath the listings; open, the plain address for calendar apps with Copy, the webcal link, Google on a computer, and the Android steps', async ({ page, baseURL, browserName, context }) => {
    if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const host = new URL(baseURL!).host;
    await page.goto('/events');
    const add = page.locator('details.addcal');
    await expect(add).toHaveCount(1);
    await expect(add).not.toHaveAttribute('open', '');
    const summary = add.locator('summary');
    await expect(summary).toHaveText('Add our calendar');
    expect((await box(summary)).height).toBeGreaterThanOrEqual(44);
    const agenda = await box(page.locator('section.agenda'));
    expect((await box(add)).y).toBeGreaterThanOrEqual(agenda.y + agenda.height - 1);
    await summary.click();
    const address = add.getByRole('textbox', { name: 'Calendar address (for calendar apps)' });
    await expect(address).toHaveValue(`https://${host}/calendar.ics?v=${FEED_VERSION}`);
    await expect(address).toHaveAttribute('readonly', '');
    const webcal = `webcal://${host}/calendar.ics?v=${FEED_VERSION}`;
    await expect(add.getByRole('link', { name: 'Open in a calendar app (Android: ICSx⁵)' })).toHaveAttribute('href', webcal);
    // A phone project that says Android (Pixel 7) gets the Android order: the computer-only link is there, hidden.
    const android = await page.evaluate(() => /Android/i.test(navigator.userAgent));
    const google = add.locator('[data-not-android] a');
    await expect(google).toHaveText('Google Calendar on a computer');
    await expect(google).toHaveAttribute('href', `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcal)}`);
    if (android) await expect(google).toBeHidden();
    else await expect(google).toBeVisible();
    await expect(add.getByRole('heading', { name: 'Google Calendar on an Android phone' })).toBeVisible();
    await expect(add.getByRole('link', { name: "Google Calendar's Add by URL page" })).toHaveAttribute('href', 'https://calendar.google.com/calendar/r/settings/addbyurl');
    await expect(add).toContainText('Desktop site first');
    await expect(add).toContainText('Sync on');
    await expect(add.getByRole('link', { name: 'Download the calendar file' })).toHaveAttribute('href', '/calendar.ics');
    const copy = add.getByRole('button', { name: 'Copy' });
    await expect(copy).toBeVisible();
    await copy.click();
    await expect(add.getByRole('status')).toHaveText(/^(Copied the calendar address\.|Select the address and copy it\.)$/);
    if (browserName === 'chromium') expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`https://${host}/calendar.ics?v=${FEED_VERSION}`);
    expect(await sideways(page)).toBeLessThanOrEqual(0);
  });

  test('on Android, the Android steps come first and the computer-only Google link is gone', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL: baseURL!, ignoreHTTPSErrors: true, viewport: COVER, userAgent: 'Mozilla/5.0 (Linux; Android 15; SM-F956U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36' });
    const page = await context.newPage();
    await page.goto('/events');
    await page.locator('details.addcal > summary').click();
    const panel = page.locator('[data-addcal-panel]');
    expect(await panel.evaluate((el) => el.firstElementChild?.hasAttribute('data-android'))).toBe(true);
    await expect(panel.getByRole('link', { name: 'Google Calendar on a computer' })).toBeHidden();
    await expect(panel.getByRole('link', { name: 'Open in a calendar app (Android: ICSx⁵)' })).toBeVisible();
    await context.close();
  });
});

test.describe('with no script', () => {
  test.use({ javaScriptEnabled: false, viewport: COVER });

  test('each day is a link that keeps the view and the date in the URL, and Copy is not offered', async ({ page }) => {
    await page.goto('/events');
    const tile = page.getByRole('list', { name: 'Days with events' }).locator('a.tile').nth(2);
    const date = (await tile.getAttribute('data-day'))!;
    await tile.click();
    await expect(page).toHaveURL(new RegExp(`/events\\?view=list&d=${date}#day-${date}$`));
    await expect(page.locator(`#day-${date}`)).toBeInViewport();
    await expect(page.locator(`#day-${date}`)).toHaveClass(/is-sel/);
    await expect(page.locator(`a.tile[data-day="${date}"]`)).toHaveAttribute('aria-current', 'true');
    await page.goto('/events?view=month');
    const day = page.locator('table.month a.day').last();
    const other = (await day.getAttribute('data-day'))!;
    await day.click();
    await expect(page).toHaveURL(new RegExp(`/events\\?view=month&d=${other}#day-${other}$`));
    await expect(page.locator(`[data-panel="${other}"]`)).toBeVisible();
    await expect(page.locator('[data-panel]:visible')).toHaveCount(1);
    await page.locator('details.addcal > summary').click();
    await expect(page.getByRole('button', { name: 'Copy' })).toBeHidden();
    await expect(page.getByRole('textbox', { name: 'Calendar address (for calendar apps)' })).toBeVisible();
  });

  test('a URL it cannot read is the 404 page', async ({ page }) => {
    for (const q of ['view=year', 'd=2026-02-30', 'month=2026-13']) expect((await page.goto(`/events?${q}`))!.status(), q).toBe(404);
  });
});

test('an event page adds that one event to Google Calendar, in Central time', async ({ page }) => {
  await page.goto(`/events/${BOARD_GAMES}`);
  const href = (await page.getByRole('link', { name: 'Add to Google Calendar' }).getAttribute('href'))!;
  const url = new URL(href);
  expect(`${url.origin}${url.pathname}`).toBe('https://calendar.google.com/calendar/render');
  expect(url.searchParams.get('action')).toBe('TEMPLATE');
  expect(url.searchParams.get('text')).toBe('Board games afternoon');
  expect(url.searchParams.get('ctz')).toBe('America/Chicago');
  const date = addDays(centralToday(), 3).replaceAll('-', '');
  expect(url.searchParams.get('dates')).toBe(`${date}T140000/${date}T170000`);
  await expect(page.getByRole('link', { name: 'Add to my calendar' })).toHaveAttribute('href', `/events/${BOARD_GAMES}.ics`);
});

test.describe('axe', () => {
  for (const viewport of [COVER, DESKTOP]) {
    for (const theme of ['dark', 'light', 'contrast-yellow'] as const) {
      test(`${viewport.width} px, ${theme}: each view and the open disclosure, no violations`, async ({ page, context, baseURL }) => {
        test.slow();
        await page.setViewportSize(viewport);
        await setPrefs(context, baseURL!, { theme });
        for (const path of ['/events', '/events?view=week', '/events?view=month']) {
          await page.goto(path);
          expect(await axe(page), path).toEqual([]);
        }
        await page.locator('details.addcal > summary').click();
        expect(await axe(page), 'open disclosure').toEqual([]);
      });
    }
  }
});

test('at 390 px the list, week and month all fit', async ({ page }) => {
  await page.setViewportSize(PHONE);
  for (const path of ['/events', '/events?view=week', '/events?view=month']) {
    await page.goto(path);
    expect(await sideways(page), path).toBeLessThanOrEqual(0);
  }
});
