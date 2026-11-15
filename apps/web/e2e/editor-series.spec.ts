// SERIES-UI: the officers' recurring events, on the stand-in API (e2e/events-model.mjs SaveSeries). "Our
// events" lists the series of the person's offices with a plain pattern and its next date; start one in
// plain choices, see its next dates before saving, change it, and stop it after a plain "are you sure";
// another office's series, or none, is the not-found page; the problem list; all of it with no script;
// axe in every theme; 320 px wide at the largest text with nothing scrolling sideways. Each browser project
// starts series of its own (its name in the title), so runs in parallel never meet.
import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';
import { SIZES } from '../server/prefs.mjs';
import { THEMES, setPrefs } from './prefs';
import { signIn } from './signin';
import { EVENT_EDITS, centralToday } from './stand-in';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'wcag2aaa', 'best-practice'];
const LUNCH = EVENT_EDITS.lunchSeries;
const HAPPY_HOUR = '1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5';

async function signedIn(page: Page, who: Parameters<typeof signIn>[1]) {
  await page.goto('/');
  await signIn(page, who);
}

async function axe(page: Page): Promise<string[]> {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return result.violations.map((v) => `${v.impact}: ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

/** Fills the start form for a series on the last Monday of the month, from today. */
async function fillLastMonday(page: Page, title: string) {
  await page.getByLabel('Title').fill(title);
  await page.getByRole('radio', { name: 'Something else' }).check();
  await page.getByRole('radio', { name: 'Once a month' }).check();
  await page.getByRole('radio', { name: 'On a day of the week, such as the second Friday' }).check();
  await page.getByRole('group', { name: 'On a day of the week: which one in the month' }).getByRole('radio', { name: 'Last' }).check();
  await page.getByRole('group', { name: 'On a day of the week: which day' }).getByRole('radio', { name: 'Monday' }).check();
  await page.getByLabel('First date').fill(centralToday());
  await page.getByLabel('Start time, in Central time').fill('19:00');
  await page.getByLabel('How long, in minutes').fill('120');
  await page.getByRole('radio', { name: 'Okaloosa County' }).check();
}

test.describe('recurring events', () => {
  test('the President sees their series, starts one, changes it and stops it', async ({ page }, info) => {
    const title = `Games night (${info.project.name})`;
    await signedIn(page, 'officer');
    await page.goto('/officer-area/events');
    const list = page.getByRole('region', { name: 'Recurring events' });
    await expect(list).toContainText('Wednesday Lunchers');
    await expect(list).toContainText('Every Wednesday. Next:');
    await expect(list).not.toContainText('Happy Hour');

    await page.getByRole('link', { name: 'Start a recurring event' }).click();
    await expect(page).toHaveURL(/\/officer-area\/events\/series\/new$/);
    await fillLastMonday(page, title);
    await page.getByRole('button', { name: 'Show the next dates' }).click();
    const preview = page.getByRole('region', { name: 'The next dates' });
    await expect(preview.getByRole('listitem')).toHaveCount(5);
    for (const item of await preview.getByRole('listitem').allTextContents()) expect(item).toMatch(/^Monday, (2[5-9]|3[01]) /);
    await expect(page.getByLabel('Title')).toHaveValue(title);
    await page.getByRole('button', { name: 'Start it' }).click();

    await expect(page).toHaveURL(/\/officer-area\/events\?series=saved$/);
    await expect(page.getByRole('status')).toContainText('Saved. The public calendar shows its dates now.');
    const mine = list.getByRole('listitem').filter({ hasText: title });
    await expect(mine).toContainText('Last Monday of the month.');

    await mine.getByRole('link', { name: `Change ${title}, the recurring event` }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Change: ${title}`);
    await expect(page.getByRole('radio', { name: 'Once a month' })).toBeChecked();
    await expect(page.getByRole('group', { name: 'On a day of the week: which one in the month' }).getByRole('radio', { name: 'Last' })).toBeChecked();
    await page.getByRole('radio', { name: 'Every 2 weeks' }).check();
    await page.getByRole('checkbox', { name: 'Tuesday' }).check();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status')).toContainText('Saved.');
    await expect(list.getByRole('listitem').filter({ hasText: title })).toContainText('Every other Tuesday.');

    await list.getByRole('link', { name: `Change ${title}, the recurring event` }).click();
    await page.getByRole('button', { name: 'Stop this recurring event' }).click();
    await expect(page.getByRole('heading', { name: `Stop ${title}?` })).toBeVisible();
    await page.getByRole('button', { name: 'Yes, stop it' }).click();
    await expect(page.getByRole('status')).toContainText('Stopped.');
    await expect(list).not.toContainText(title);
  });

  test('"No, keep it" changes nothing', async ({ page }) => {
    await signedIn(page, 'officer');
    await page.goto(`/officer-area/events/series/${LUNCH}`);
    await expect(page.getByRole('radio', { name: 'Every week' })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Wednesday' })).toBeChecked();
    await expect(page.getByRole('region', { name: 'The next dates' }).getByRole('listitem')).toHaveCount(5);
    await page.getByRole('button', { name: 'Stop this recurring event' }).click();
    await page.getByRole('link', { name: 'No, keep it' }).click();
    await expect(page).toHaveURL(new RegExp(`/officer-area/events/series/${LUNCH}$`));
    await page.goto('/officer-area/events');
    await expect(page.getByRole('region', { name: 'Recurring events' })).toContainText('Wednesday Lunchers');
  });

  test('another office’s series, or no series, is not found', async ({ page }) => {
    await signedIn(page, 'officer');
    for (const path of [`/officer-area/events/series/${HAPPY_HOUR}`, '/officer-area/events/series/0b9c1f5e-4c1a-4d55-9a3e-000000000000', '/officer-area/events/series/x']) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(404);
    }
  });

  test('a problem is listed at the top, linked to its field, and what was typed is kept', async ({ page }) => {
    await signedIn(page, 'officer');
    await page.goto('/officer-area/events/series/new');
    await page.getByLabel('Title').fill('Half filled');
    await page.getByRole('radio', { name: 'Every week' }).check();
    await page.getByRole('button', { name: 'Start it' }).click();
    const summary = page.locator('[data-error-summary]');
    await expect(summary).toBeFocused();
    await expect(summary).toContainText('Days of the week: Choose at least one day of the week.');
    await expect(summary).toContainText('Kind of event: Choose what kind of event it is.');
    await summary.getByRole('link', { name: /Days of the week/ }).click();
    await expect(page.getByRole('checkbox', { name: 'Monday' })).toBeFocused();
    await expect(page.getByLabel('Title')).toHaveValue('Half filled');
  });
});

test.describe('with no script', () => {
  test.use({ javaScriptEnabled: false });
  test('start a series and see its dates, by plain form posts', async ({ page }, info) => {
    const title = `No-script quiz (${info.project.name})`;
    await signedIn(page, 'officer');
    await page.goto('/officer-area/events/series/new');
    await fillLastMonday(page, title);
    await page.getByRole('button', { name: 'Show the next dates' }).click();
    await expect(page.getByRole('region', { name: 'The next dates' }).getByRole('listitem')).toHaveCount(5);
    await page.getByRole('button', { name: 'Start it' }).click();
    await expect(page).toHaveURL(/\/officer-area\/events\?series=saved$/);
    await expect(page.getByRole('region', { name: 'Recurring events' })).toContainText(title);
  });
});

test.describe('axe in every theme, and 320 px at the largest text', () => {
  /** Our events, a change with its next dates, and a new one showing its problems and next dates. */
  async function screens(page: Page, visit: (label: string) => Promise<void>) {
    await page.goto('/officer-area/events');
    await visit('Our events');
    await page.goto(`/officer-area/events/series/${LUNCH}`);
    await visit('change');
    await page.getByRole('button', { name: 'Stop this recurring event' }).click();
    await visit('stop?');
    await page.goto('/officer-area/events/series/new');
    await page.getByRole('button', { name: 'Start it' }).click();
    await expect(page.locator('[data-error-summary]')).toBeVisible();
    await visit('new, with problems');
  }

  for (const theme of THEMES) {
    for (const size of [SIZES[0], SIZES[6]]) {
      test(`axe: no violations in the ${theme} theme at ${size} % text`, async ({ page, context, baseURL }) => {
        await setPrefs(context, baseURL!, { size, theme });
        await signedIn(page, 'admin');
        const found: string[] = [];
        await screens(page, async (label) => {
          await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
          found.push(...(await axe(page)).map((v) => `${label}: ${v}`));
        });
        expect(found).toEqual([]);
      });
    }
  }

  test.describe('at 320 px wide', () => {
    test.use({ viewport: { width: 320, height: 640 } });
    for (const size of [SIZES[0], SIZES[6]]) {
      test(`nothing scrolls sideways at ${size} % text, and every choice is 48 px tall`, async ({ page, context, baseURL }, info) => {
        await setPrefs(context, baseURL!, { size });
        await signedIn(page, 'admin');
        const wide: string[] = [];
        await screens(page, async (label) => {
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          if (overflow > 0) wide.push(`${label}: ${overflow} px`);
        });
        expect(wide).toEqual([]);
        for (const choice of await page.locator('.series-form .choice').all()) expect((await choice.boundingBox())!.height).toBeGreaterThanOrEqual(48);
        await page.screenshot({ path: info.outputPath(`series-new-320-${size}.png`) });
      });
    }
  });
});
