// The live pages in a browser (W3), read from the stand-in API over gRPC:
// the calendar's list, month grid and event pages, Home, Officers, Finances.
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { banner, signIn } from './signin';
import { BOARD_GAMES, CANARIES, centralToday, monthAfter, monthLabel } from './stand-in';

const wide = (width: number | undefined) => (width ?? 0) >= 900;

test.describe('Calendar', () => {
  test('lists what is coming up, each with its time, place and status; a cancelled event stays, marked so', async ({ page }) => {
    await page.goto('/calendar');
    const list = page.getByRole('list', { name: 'Coming up' });
    await expect(list.getByRole('listitem').first()).toBeVisible();
    const lunch = list.getByRole('listitem').filter({ hasText: 'Wednesday Lunchers' }).first();
    await expect(lunch).toContainText('11:30 am · Sample Bistro, 100 Example Way, Destin');
    await expect(lunch).toContainText('Scheduled');
    await expect(list.getByRole('listitem').filter({ hasText: 'Cancelled' }).first()).toContainText('The restaurant is closed for a private party.');
    await expect(list.getByRole('listitem').filter({ hasText: 'Summer picnic planning' })).toContainText('Time to be decided');
    for (const canary of Object.values(CANARIES)) await expect(page.getByText(canary.title)).toHaveCount(0);
    await expect(page.getByText(/members event/i)).toHaveCount(0);
  });

  test('shows the month as a real table on a wide screen, and only the list on a phone', async ({ page }) => {
    await page.goto('/calendar');
    const month = centralToday().slice(0, 7);
    const grid = page.getByRole('table', { name: monthLabel(month) });
    if (wide(page.viewportSize()?.width)) {
      await expect(grid).toBeVisible();
      await expect(grid.getByRole('columnheader')).toHaveText(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
      await expect(grid.locator('th[scope="col"]')).toHaveCount(7);
      await expect(grid.locator('td[aria-current="date"]')).toHaveCount(1);
      await expect(grid.getByRole('link', { name: /Wednesday Lunchers/ }).first()).toBeVisible();
    } else {
      await expect(grid).toBeHidden();
      await expect(page.getByRole('list', { name: 'Coming up' })).toBeVisible();
    }
  });

  test('steps to the next month, and back to this one', async ({ page }) => {
    await page.goto('/calendar');
    const next = monthAfter(centralToday().slice(0, 7));
    await page.getByRole('navigation', { name: 'Months' }).getByRole('link', { name: monthLabel(next) }).click();
    await expect(page).toHaveURL(new RegExp(`/calendar\\?month=${next}$`));
    await expect(page.getByRole('heading', { level: 2, name: `${monthLabel(next)}, as a list` })).toBeVisible();
    await page.getByRole('link', { name: 'This month' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Coming up' })).toBeVisible();
  });

  test("opens an event: when and where in words, a member's home by its area, who to ask, and the labels explained", async ({ page }) => {
    await page.goto('/calendar');
    await page.getByRole('list', { name: 'Coming up' }).getByRole('link', { name: 'Board games afternoon' }).click();
    await expect(page).toHaveURL(new RegExp(`/calendar/event/${BOARD_GAMES}$`));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Board games afternoon');
    const facts = page.locator('dl.facts');
    await expect(facts).toContainText(/When\s*\w+day, \d{1,2} \w+ \d{4}, 2:00 pm to 5:00 pm/);
    await expect(facts).toContainText("A member's home in Okaloosa County. Ask president@nwflorida.us for the address.");
    await expect(facts.getByRole('link', { name: 'president@nwflorida.us' })).toHaveAttribute('href', 'mailto:president@nwflorida.us');
    await expect(page.getByRole('heading', { level: 2, name: 'What the labels mean' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to Calendar' })).toHaveAttribute('href', '/calendar');
    expect(await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'wcag2aaa', 'best-practice']).analyze().then((r) => r.violations.map((v) => v.id))).toEqual([]);
  });

  test('Add to my calendar gives that one event as a calendar file', async ({ page, browserName }) => {
    await page.goto(`/calendar/event/${BOARD_GAMES}`);
    const add = page.getByRole('link', { name: 'Add to my calendar' });
    await expect(add).toHaveAttribute('href', `/calendar/event/${BOARD_GAMES}.ics`);
    // WebKit on an iPhone hands text/calendar to the Calendar app, which a test cannot see; Chromium downloads it.
    test.skip(browserName !== 'chromium', 'the download is checked in Chromium');
    const [download] = await Promise.all([page.waitForEvent('download'), add.click()]);
    expect(download.suggestedFilename()).toMatch(/^board-games-afternoon-\d{4}-\d{2}-\d{2}\.ics$/);
    const text = readFileSync((await download.path())!, 'utf8');
    expect(text).toMatch(/^BEGIN:VCALENDAR\r\n/);
    expect(text.match(/BEGIN:VEVENT/g)).toHaveLength(1);
  });

  test('offers the whole calendar to subscribe to, and to download', async ({ page, baseURL }) => {
    await page.goto('/calendar');
    const host = new URL(baseURL!).host;
    await expect(page.getByRole('link', { name: 'Add our calendar' })).toHaveAttribute('href', `webcal://${host}/calendar.ics`);
    await expect(page.getByRole('link', { name: 'Download the calendar file' })).toHaveAttribute('href', '/calendar.ics');
  });

  test('a signed-in reader sees the same public calendar: the site never passes their token to the API', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'officer');
    await expect(banner(page)).toContainText('Alex Sample');
    const res = await page.goto('/calendar');
    expect(res?.status()).toBe(200);
    await expect(page.getByRole('list', { name: 'Coming up' }).getByRole('listitem').first()).toBeVisible();
    for (const canary of Object.values(CANARIES)) await expect(page.getByText(canary.title)).toHaveCount(0);
  });
});

test('Home shows this week, the President’s latest report and the announcements, from the API', async ({ page }) => {
  await page.goto('/');
  const week = page.getByRole('region', { name: 'This week' });
  await expect(week.getByRole('link', { name: 'Board games afternoon' })).toBeVisible();
  await expect(week.getByRole('link', { name: 'See the whole calendar' })).toHaveAttribute('href', '/calendar');
  const president = page.getByRole('region', { name: 'From the President' });
  await expect(president.getByRole('heading', { level: 3, name: 'A busy autumn' })).toBeVisible();
  await expect(president).toContainText('Members-only passage, sign in to read.');
  await expect(president.getByRole('link', { name: 'American Mensa' })).toHaveAttribute('href', 'https://www.us.mensa.org/');
  const news = page.getByRole('region', { name: 'Announcements' });
  await expect(news.getByRole('heading', { level: 3 })).toHaveText(['Dues go up in January', 'Helpers wanted']);
  await expect(page.locator('[data-source="submitted"]').first()).toBeVisible();
  await expect(page.getByRole('note').filter({ hasText: 'Sample entries' })).toHaveCount(0);
});

test('Officers lists every office from the API, every holder of a seat with several, and only addresses known to work', async ({ page }) => {
  await page.goto('/officers');
  const roster = page.getByRole('list', { name: 'Officers' });
  await expect(roster.getByRole('listitem')).toHaveCount(8);
  const atLarge = roster.getByRole('listitem').filter({ hasText: 'Member at Large' });
  await expect(atLarge).toContainText('Taylor Sample');
  await expect(atLarge).toContainText('Quinn Example');
  await expect(atLarge.getByRole('link', { name: 'mal@nwflorida.us' })).toHaveAttribute('href', 'mailto:mal@nwflorida.us');
  await expect(roster.getByRole('listitem').filter({ hasText: 'Membership Officer' })).toContainText('Vacant');
  await expect(roster.getByRole('listitem').filter({ hasText: 'Social Chair' })).toContainText('Avery Placeholder (acting)');
  await expect(roster.getByRole('listitem').filter({ hasText: 'Treasurer' })).not.toContainText('@');
  await expect(page.getByRole('note').filter({ hasText: 'Sample entries' })).toHaveCount(0);
});

test('Finances shows each summary the Treasurer published, with the day it was published', async ({ page }) => {
  await page.goto('/finances');
  const q3 = page.getByRole('region', { name: 'July to September' });
  await expect(q3).toContainText('Closing balance: $2,777.35');
  await expect(q3).toContainText(/Published on \w+day, \d{1,2} \w+ \d{4}\./);
  await expect(page.getByRole('region', { name: 'April to June' })).toBeVisible();
  await expect(page.getByRole('note').filter({ hasText: 'Sample entries' })).toHaveCount(0);
});
