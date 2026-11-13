// EDITOR E6: the officers' event screens, S10 "Our events" and S11 (the form for one date), on the
// stand-in API's calendar (e2e/events-model.mjs), which has every save in its reads at once. Each browser
// project changes dates and events of its own (e2e/stand-in.ts EVENT_EDITS), so runs in parallel never
// meet. Cancel a series date, and /events and /calendar.ics say so; add a one-off; the Admin changes
// another office's event; the Treasurer cannot change the President's; a members event stays off the
// public calendar; times in Central around both clock changes of 2027; a bad web address keeps what
// was typed and says why on its field; all of it with no script; axe in every theme; 320 px wide at the
// largest text with nothing scrolling sideways; buttons 48 px tall.
import AxeBuilder from '@axe-core/playwright';
import { type Browser, type Page, expect, test } from '@playwright/test';
import { SIZES } from '../server/prefs.mjs';
import { THEMES, setPrefs } from './prefs';
import { SITE_URL } from './servers';
import { signIn } from './signin';
import { EVENT_EDITS, addDays, centralToday } from './stand-in';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'wcag2aaa', 'best-practice'];
const LUNCH = EVENT_EDITS.lunchSeries;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** As the site writes a date: "Wednesday, 20 January 2027". */
const longDate = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
const weekday = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();
/** The Wednesday `weeks` weeks after the next one (today, if a Wednesday). */
const wednesday = (weeks: number) => {
  const today = centralToday();
  return addDays(today, ((3 - weekday(today) + 7) % 7) + 7 * weeks);
};
/** A day this project alone adds its one-offs on: 70 to 80 days ahead, past what other specs read. */
const ownDay = (project: string) => addDays(centralToday(), 70 + Object.keys(EVENT_EDITS.lunchWeeks).indexOf(project) * 3);

async function signedIn(page: Page, who: Parameters<typeof signIn>[1]) {
  await page.goto('/');
  await signIn(page, who);
}

/** A fresh browser context as the public: no session. */
async function publicPage(browser: Browser) {
  const context = await browser.newContext({ baseURL: SITE_URL, ignoreHTTPSErrors: true });
  return { page: await context.newPage(), close: () => context.close() };
}

const unfold = (text: string) => text.replace(/\r\n /g, '');

async function axe(page: Page): Promise<string[]> {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return result.violations.map((v) => `${v.impact}: ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

/** Fills the new-event form (S11) and saves it; the page is then the event's own page. */
async function addEvent(page: Page, e: { title: string; date: string; time: string; venue?: string; members?: boolean; detail?: string }) {
  await page.goto('/officer-area/events');
  await page.getByRole('link', { name: 'Add a one-off event' }).click();
  await expect(page).toHaveURL(/\/officer-area\/events\/new$/);
  await page.getByLabel('Title').fill(e.title);
  await page.getByLabel('Date', { exact: true }).fill(e.date);
  await page.getByLabel('Start time, in Central time').fill(e.time);
  await page.getByRole('radio', { name: e.venue ?? 'Decided later' }).check();
  if (e.detail) await page.getByLabel('Details').fill(e.detail);
  await page.getByRole('radio', { name: e.members ? 'Members only' : 'Everyone' }).check();
  await expect(page.getByText('Saving changes the public calendar at once.')).toBeVisible();
  await page.getByRole('button', { name: 'Add the event' }).click();
  await expect(page).toHaveURL(/\/officer-area\/events\/[0-9a-f-]{36}\?saved=1$/);
  await expect(page.getByRole('status')).toContainText('Saved. The public calendar shows the change now.');
  return new URL(page.url()).pathname.split('/').pop()!;
}

test.describe('the event screens, signed in', () => {
  test('cancel a series date (<series>:<date>): /events and the ICS show it cancelled at once', async ({ page, browser }, info) => {
    const date = wednesday(EVENT_EDITS.lunchWeeks[info.project.name]!);
    const note = `Closed for a private party (${info.project.name})`;
    await signedIn(page, 'officer');
    await page.goto('/officer-area/events');
    await expect(page.getByRole('heading', { level: 1, name: 'Our events' })).toBeVisible();
    const day = page.getByRole('region', { name: longDate(date) });
    await expect(day.getByRole('heading', { name: 'Wednesday Lunchers' })).toBeVisible();
    await expect(day).toContainText('Scheduled');
    await expect(day).toContainText('11:30 am to 1:00 pm. Sample Bistro.');
    await day.getByRole('link', { name: `Change Wednesday Lunchers, ${longDate(date)}` }).click();
    await expect(page).toHaveURL(new RegExp(`/officer-area/events/${LUNCH}_${date}$`));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Change: Wednesday Lunchers');
    await expect(page.getByText(`Date: ${longDate(date)}`)).toBeVisible();
    await expect(page.getByLabel('Start time, in Central time')).toHaveValue('11:30');
    await page.getByRole('radio', { name: 'Cancelled' }).check();
    await page.getByLabel('Note shown on the calendar').fill(note);
    await page.getByRole('button', { name: 'Save' }).click();
    // Its own event now, with an id of its own.
    await expect(page).toHaveURL(/\/officer-area\/events\/[0-9a-f-]{36}\?saved=1$/);
    await expect(page.getByRole('status')).toContainText('Saved.');
    await expect(page.getByRole('radio', { name: 'Cancelled' })).toBeChecked();
    // S10 says so too, and keeps the venue and time.
    await page.goto('/officer-area/events');
    await expect(page.getByRole('region', { name: longDate(date) })).toContainText(`Cancelled ${note}`);

    const pub = await publicPage(browser);
    try {
      await pub.page.goto(`/events?view=week&d=${date}`);
      const card = pub.page.locator(`li.ecard[data-card-day="${date}"]`, { hasText: 'Wednesday Lunchers' });
      await expect(card).toHaveClass(/ecard--x/);
      await expect(card).toContainText('Cancelled');
      await expect(card).toContainText(note);
      const ics = unfold(await (await pub.page.request.get('/calendar.ics')).text());
      const entry = ics.split('BEGIN:VEVENT').find((e) => e.includes(`DTSTART;TZID=America/Chicago:${date.replaceAll('-', '')}T113000`) && e.includes('Wednesday Lunchers'));
      expect(entry).toBeDefined();
      expect(entry).toContain('STATUS:CANCELLED');
      expect(entry).toContain('SUMMARY:Cancelled: Wednesday Lunchers');
    } finally {
      await pub.close();
    }
  });

  test('add a one-off event; the Admin, who sees every office\'s events, changes it', async ({ page, browser }, info) => {
    const title = `Talk on maps (${info.project.name})`;
    const date = ownDay(info.project.name);
    await signedIn(page, 'officer');
    const id = await addEvent(page, { title, date, time: '18:30', venue: 'Placeholder Diner', detail: 'Doors open at 6.' });
    await expect(page.getByLabel('Title')).toHaveValue(title);
    await expect(page.getByLabel('Date', { exact: true })).toHaveValue(date);
    await expect(page.getByRole('radio', { name: 'Placeholder Diner' })).toBeChecked();
    const pub = await publicPage(browser);
    try {
      await pub.page.goto(`/events/${id}`);
      await expect(pub.page.getByRole('heading', { level: 1 })).toHaveText(title);
      await expect(pub.page.locator('main')).toContainText('6:30 pm');
    } finally {
      await pub.close();
    }

    const admin = await browser.newContext({ baseURL: SITE_URL, ignoreHTTPSErrors: true });
    try {
      const a = await admin.newPage();
      await signedIn(a, 'admin');
      await a.goto('/officer-area/events');
      // Every office's: the Social Chair's board games, with its office named, and the President's talk.
      await expect(a.locator('main')).toContainText('Board games afternoon');
      await expect(a.locator('main')).toContainText('Social Chair.');
      const day = a.getByRole('region', { name: longDate(date) });
      await expect(day).toContainText('President.');
      await day.getByRole('link', { name: `Change ${title}, ${longDate(date)}` }).click();
      await a.getByLabel('Note shown on the calendar').fill('Changed by the Admin');
      await a.getByLabel('Start time, in Central time').fill('19:00');
      await a.getByRole('button', { name: 'Save' }).click();
      await expect(a).toHaveURL(new RegExp(`/officer-area/events/${id}\\?saved=1$`));
      await expect(a.getByLabel('Start time, in Central time')).toHaveValue('19:00');
    } finally {
      await admin.close();
    }
    const after = await publicPage(browser);
    try {
      await after.page.goto(`/events/${id}`);
      await expect(after.page.locator('main')).toContainText('Changed by the Admin');
      await expect(after.page.locator('main')).toContainText('7:00 pm');
    } finally {
      await after.close();
    }
  });

  test("the Treasurer cannot see or change the President's events: not found, and nothing changes", async ({ page, browser }) => {
    const date = wednesday(1);
    const path = `/officer-area/events/${LUNCH}_${date}`;
    await signedIn(page, 'treasurer');
    await page.goto('/officer-area/events');
    await expect(page.locator('main')).not.toContainText('Wednesday Lunchers');
    await expect(page.getByRole('link', { name: 'Add a one-off event' })).toBeVisible();
    expect((await page.goto(path))?.status()).toBe(404);
    const posted = await page.request.post(path, { form: { time: '11:30', status: 'cancelled', statusNote: 'Treasurer was here', venue: '', visibility: 'public' }, headers: { Origin: SITE_URL }, maxRedirects: 0 });
    expect(posted.status()).toBe(404);
    const pub = await publicPage(browser);
    try {
      const res = await pub.page.goto(`/events/${LUNCH}_${date}`);
      expect(res?.status()).toBe(200);
      await expect(pub.page.locator('main')).not.toContainText('Treasurer was here');
      // Its status chip, not the page's own list of what the labels mean.
      await expect(pub.page.locator('main .status .chip').first()).toHaveText('Scheduled');
    } finally {
      await pub.close();
    }
  });

  test('a members event stays off the public calendar and its feed', async ({ page, browser }, info) => {
    const title = `Members quiz night (${info.project.name})`;
    const date = addDays(ownDay(info.project.name), 1);
    await signedIn(page, 'officer');
    const id = await addEvent(page, { title, date, time: '19:00', members: true });
    await expect(page.getByRole('radio', { name: 'Members only' })).toBeChecked();
    await page.goto('/officer-area/events');
    await expect(page.getByRole('region', { name: longDate(date) })).toContainText('Members only.');
    const pub = await publicPage(browser);
    try {
      expect((await pub.page.goto(`/events/${id}`))?.status()).toBe(404);
      await pub.page.goto(`/events?view=week&d=${date}`);
      await expect(pub.page.locator('main')).not.toContainText(title);
      expect(await (await pub.page.request.get('/calendar.ics')).text()).not.toContain(title);
    } finally {
      await pub.close();
    }
  });

  test('times are Central around both clock changes of 2027, and the hour skipped in spring is refused in words', async ({ page, browser }, info) => {
    await signedIn(page, 'officer');
    // 14 March 2027: clocks go forward at 2 am. 7 November 2027: back at 2 am, so 1:30 am happens twice.
    const spring = await addEvent(page, { title: `Spring change brunch (${info.project.name})`, date: '2027-03-14', time: '10:00' });
    await expect(page.getByLabel('Start time, in Central time')).toHaveValue('10:00');
    const autumn = await addEvent(page, { title: `Autumn change owl walk (${info.project.name})`, date: '2027-11-07', time: '01:30' });
    await expect(page.getByLabel('Start time, in Central time')).toHaveValue('01:30');
    const pub = await publicPage(browser);
    try {
      await pub.page.goto(`/events/${spring}`);
      await expect(pub.page.locator('main')).toContainText('10:00 am');
      expect(unfold(await (await pub.page.request.get(`/events/${spring}.ics`)).text())).toContain('DTSTART;TZID=America/Chicago:20270314T100000');
      await pub.page.goto(`/events/${autumn}`);
      await expect(pub.page.locator('main')).toContainText('1:30 am');
      expect(unfold(await (await pub.page.request.get(`/events/${autumn}.ics`)).text())).toContain('DTSTART;TZID=America/Chicago:20271107T013000');
    } finally {
      await pub.close();
    }
    await page.goto('/officer-area/events/new');
    await page.getByLabel('Title').fill('Never at 2:30');
    await page.getByLabel('Date', { exact: true }).fill('2027-03-14');
    await page.getByLabel('Start time, in Central time').fill('02:30');
    await page.getByRole('button', { name: 'Add the event' }).click();
    const message = 'There is no 2:30 am on Sunday, 14 March 2027 in Central time: the clocks go forward an hour that night. Choose 3:00 am or later.';
    await expect(page.locator('[data-error-summary]')).toContainText(`Start time: ${message}`);
    await expect(page.getByLabel('Start time, in Central time')).toHaveValue('02:30');
    await expect(page.getByLabel('Title')).toHaveValue('Never at 2:30');
  });

  test('a bad web address is refused: the reasons on their fields, at the top as links, and everything typed kept', async ({ page }, info) => {
    const title = `Refused address (${info.project.name})`;
    await signedIn(page, 'officer');
    await page.goto('/officer-area/events/new');
    await page.getByLabel('Title').fill(title);
    await page.getByLabel('Date', { exact: true }).fill(ownDay(info.project.name));
    await page.getByLabel('Start time, in Central time').fill('12:00');
    await page.getByRole('radio', { name: 'Tentative' }).check();
    await page.getByLabel('Note shown on the calendar').fill('Maybe');
    await page.getByLabel('Details').fill('Parking:\nsee https://example.org:8080/parking please');
    await page.getByLabel('Web address (if there is one)').fill('http://example.org/e6');
    await page.getByRole('button', { name: 'Add the event' }).click();
    await expect(page).toHaveURL(/\/officer-area\/events\/new$/);
    const summary = page.locator('[data-error-summary]');
    await expect(summary.getByRole('link', { name: 'Web address: The address "http://example.org/e6" must start with https://, not http://.' })).toHaveAttribute('href', '#url');
    await expect(summary.getByRole('link', { name: /^Details: Line 2: the address "https:\/\/example\.org:8080\/parking" names a port/ })).toHaveAttribute('href', '#detail');
    await expect(page.locator('#url-error')).toContainText('must start with https://, not http://');
    await expect(page.getByLabel('Web address (if there is one)')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByLabel('Title')).toHaveValue(title);
    await expect(page.getByLabel('Web address (if there is one)')).toHaveValue('http://example.org/e6');
    await expect(page.getByLabel('Details')).toHaveValue('Parking:\nsee https://example.org:8080/parking please');
    await expect(page.getByLabel('Note shown on the calendar')).toHaveValue('Maybe');
    await expect(page.getByLabel('Start time, in Central time')).toHaveValue('12:00');
    await expect(page.getByRole('radio', { name: 'Tentative' })).toBeChecked();
    // Nothing was saved.
    await page.goto('/officer-area/events');
    await expect(page.locator('main')).not.toContainText(title);
  });

  test('sends a member, the Webmaster without an office group, and no one signed in away', async ({ page, browser }) => {
    await signedIn(page, 'member');
    for (const path of ['/officer-area/events', '/officer-area/events/new', `/officer-area/events/${LUNCH}_${wednesday(1)}`]) expect((await page.goto(path))?.status(), path).toBe(404);
    const pub = await publicPage(browser);
    try {
      for (const path of ['/officer-area/events', '/officer-area/events/new', `/officer-area/events/${LUNCH}_${wednesday(1)}`]) {
        const res = await pub.page.request.get(path, { maxRedirects: 0 });
        expect(res.status(), path).toBe(303);
        expect(res.headers()['location'], path).toBe(`/sign-in?return=${encodeURIComponent(path)}`);
        const post = await pub.page.request.post(path, { form: { time: '11:30' }, headers: { Origin: 'https://evil.example' }, maxRedirects: 0 });
        expect(post.status(), path).toBe(403);
      }
    } finally {
      await pub.close();
    }
    const lone = await browser.newContext({ baseURL: SITE_URL, ignoreHTTPSErrors: true });
    try {
      const w = await lone.newPage();
      await signedIn(w, 'lone-webmaster');
      expect((await w.goto('/officer-area/events'))?.status()).toBe(404);
    } finally {
      await lone.close();
    }
  });

  test('an officer with no office is told so, with nothing to add; an id that is no event is not found', async ({ page }) => {
    await signedIn(page, 'officer-only');
    await page.goto('/officer-area/events');
    await expect(page.locator('main')).toContainText('You hold no office, so there are no events for you to change.');
    await expect(page.getByRole('link', { name: 'Add a one-off event' })).toHaveCount(0);
    await page.goto('/officer-area/events/new');
    await expect(page.locator('main')).toContainText('You hold no office, so you cannot add an event.');
    await expect(page.getByRole('button', { name: 'Add the event' })).toHaveCount(0);
    for (const path of ['/officer-area/events/not-an-id', `/officer-area/events/${LUNCH}_2026-02-30`, '/officer-area/events/c0000000-0000-4000-8000-0000000000ff']) expect((await page.goto(path))?.status(), path).toBe(404);
  });

  test('buttons and choices are 48 px tall with words, and the Change links say which event', async ({ page }) => {
    await signedIn(page, 'officer');
    await page.goto('/officer-area/events');
    const change = page.getByRole('link', { name: /^Change Wednesday Lunchers, / }).first();
    expect((await change.boundingBox())!.height).toBeGreaterThanOrEqual(48);
    await expect(change).toHaveText('Change');
    expect((await page.getByRole('link', { name: 'Add a one-off event' }).boundingBox())!.height).toBeGreaterThanOrEqual(48);
    await change.click();
    for (const target of [page.getByRole('button', { name: 'Save' }), page.locator('.event-form').getByRole('link', { name: 'Back to our events' })]) expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(48);
    for (const choice of await page.locator('.event-form .choice').all()) expect((await choice.boundingBox())!.height).toBeGreaterThanOrEqual(48);
  });
});

test.describe('with no script', () => {
  test.use({ javaScriptEnabled: false });
  test('add a one-off, see the problem list, then change it, all by plain form posts', async ({ page }, info) => {
    const title = `No-script supper (${info.project.name})`;
    const date = addDays(ownDay(info.project.name), 2);
    await signedIn(page, 'officer');
    await page.goto('/officer-area/events/new');
    await page.getByLabel('Title').fill(title);
    await page.getByLabel('Date', { exact: true }).fill(date);
    await page.getByRole('button', { name: 'Add the event' }).click();
    await expect(page.locator('[data-error-summary]')).toContainText('Start time: Give the start time.');
    await expect(page.getByLabel('Title')).toHaveValue(title);
    await page.getByLabel('Start time, in Central time').fill('17:45');
    await page.getByRole('radio', { name: 'Sample Bistro' }).check();
    await page.getByRole('button', { name: 'Add the event' }).click();
    await expect(page).toHaveURL(/\/officer-area\/events\/[0-9a-f-]{36}\?saved=1$/);
    await page.getByRole('radio', { name: 'Moved' }).check();
    await page.getByLabel('Note shown on the calendar').fill('Moved to the patio');
    await page.getByRole('radio', { name: 'Decided later' }).check();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status')).toContainText('Saved.');
    await expect(page.getByRole('radio', { name: 'Moved' })).toBeChecked();
    await expect(page.getByRole('radio', { name: 'Decided later' })).toBeChecked();
    await page.goto('/officer-area/events');
    await expect(page.getByRole('region', { name: longDate(date) })).toContainText('Moved Moved to the patio');
    await expect(page.getByRole('region', { name: longDate(date) })).toContainText('From 5:45 pm. Place to be decided.');
  });
});

test.describe('axe in every theme, and 320 px at the largest text', () => {
  /** S10, S11 for a series date, and S11 for a new event showing its problems. */
  async function screens(page: Page, visit: (label: string) => Promise<void>) {
    await page.goto('/officer-area/events');
    await visit('S10');
    await page.goto(`/officer-area/events/${LUNCH}_${wednesday(1)}`);
    await visit('S11 change');
    await page.goto('/officer-area/events/new');
    await page.getByLabel('Web address (if there is one)').fill('http://example.org/');
    await page.getByRole('button', { name: 'Add the event' }).click();
    await expect(page.locator('[data-error-summary]')).toBeVisible();
    await visit('S11 new, with problems');
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

  for (const scheme of ['light', 'dark'] as const) {
    test(`axe: no violations with the ${scheme} system setting`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await signedIn(page, 'officer');
      const found: string[] = [];
      await screens(page, async (label) => found.push(...(await axe(page)).map((v) => `${label}: ${v}`)));
      expect(found).toEqual([]);
    });
  }

  test.describe('at 320 px wide', () => {
    test.use({ viewport: { width: 320, height: 640 } });
    for (const size of [SIZES[0], SIZES[6]]) {
      test(`nothing scrolls sideways at ${size} % text`, async ({ page, context, baseURL }) => {
        await setPrefs(context, baseURL!, { size });
        await signedIn(page, 'admin');
        const wide: string[] = [];
        await screens(page, async (label) => {
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          if (overflow > 0) wide.push(`${label}: ${overflow} px`);
        });
        expect(wide).toEqual([]);
      });
    }
  });
});
