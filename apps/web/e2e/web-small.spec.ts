// WEB-SMALL-1: four small fixes, each checked at 320, 412 and 1280 px, at the browser's usual text size and
// at 200 % browser text (the browser's own default font size doubled, as a reader sets it in the browser's
// settings; Chromium only, where the test can set it), with axe.
//   1. EV-CARDS200: an event card's long words wrap; the events list never scrolls sideways, also at 300 px.
//   2. E4-FOLLOWUPS: a long title on the officers' review page wraps.
//   3. E7B-N5: the review page's "done" banner says only what the piece read from the API shows.
//   4. SERIES-UI-2: the series form shows only the follow-up questions that match the choice, by CSS alone.
import AxeBuilder from '@axe-core/playwright';
import { type Locator, type Page, type TestInfo, expect, test } from '@playwright/test';
import { SIZES } from '../server/prefs.mjs';
import { setPrefs } from './prefs';
import { signIn } from './signin';
import { EVENT_EDITS, REVIEW, WORKFLOW } from './stand-in';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'wcag2aaa', 'best-practice'];
const WIDTHS = [320, 412, 1280];
const TEXTS = [100, 200] as const;
const QUEUE = '/officer-area/approvals';
const review = (id: string) => `${QUEUE}/${id}`;
/** Words with no place to break, longer than a 320 px screen at any text size. */
const LONG_WORD = 'Pseudopseudohypoparathyroidism';
const LONG_TITLE = `${LONG_WORD} and Antidisestablishmentarianism`;

/** Nothing when the page does not scroll sideways; else how far, and the parts that reach past the screen's edge. */
const sideways = (page: Page) =>
  page.evaluate(() => {
    const root = document.documentElement;
    const over = root.scrollWidth - root.clientWidth;
    if (over <= 0) return [];
    const clipped = (el: Element) => {
      for (let up = el.parentElement; up && up !== document.body; up = up.parentElement) if (getComputedStyle(up).overflowX !== 'visible') return true;
      return false;
    };
    const past = [...document.body.querySelectorAll('*')]
      .filter((el) => el.getClientRects().length > 0 && el.getBoundingClientRect().right > root.clientWidth + 0.5 && !clipped(el))
      .map((el) => `${el.tagName.toLowerCase()}.${String(el.getAttribute('class') ?? '')}#${el.id} "${(el.textContent ?? '').trim().slice(0, 20)}" to ${Math.round(el.getBoundingClientRect().right)} px`);
    return [`${over} px sideways`, ...past.slice(0, 12)];
  });

async function axe(page: Page): Promise<string[]> {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return result.violations.map((v) => `${v.impact}: ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

/**
 * The screen at this width, and the browser's own default text size at this percent. 200 % is set as a
 * reader sets it (the browser's font size, here over the DevTools protocol), so only Chromium runs it.
 */
async function screen(page: Page, browserName: string, width: number, text: number) {
  test.skip(text !== 100 && browserName !== 'chromium', 'the browser text size is set over the DevTools protocol');
  await page.setViewportSize({ width, height: 800 });
  if (text !== 100) {
    const session = await page.context().newCDPSession(page);
    await session.send('Page.setFontSizes', { fontSizes: { standard: (16 * text) / 100, fixed: (13 * text) / 100 } });
  }
}

/** The root text size the page ended up with, in px: the site's size (100 %) of the browser's. */
const rootPx = (page: Page) => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));

/** The parts of `scope` that reach past its right edge, or past the screen's. */
const spilling = (scope: Locator) =>
  scope.evaluateAll((boxes) => {
    const screenWidth = document.documentElement.clientWidth;
    const out: string[] = [];
    for (const box of boxes) {
      const edge = Math.min(box.getBoundingClientRect().right, screenWidth) + 0.5;
      for (const el of [box, ...box.querySelectorAll('*')]) {
        if (el.closest('.visually-hidden') || el.getClientRects().length === 0) continue;
        const right = el.getBoundingClientRect().right;
        if (right > edge) out.push(`${el.tagName.toLowerCase()}.${String(el.getAttribute('class') ?? '')} "${(el.textContent ?? '').trim().slice(0, 24)}" +${Math.round(right - edge)} px`);
      }
    }
    return out;
  });

/** A picture of the screen; `whole` asks for the whole page (a whole-page picture resets the browser's text size, so only at 100 %). */
const shot = (page: Page, info: TestInfo, name: string, whole = false) => page.screenshot({ path: info.outputPath(`${name}-${info.project.name}.png`), fullPage: whole });

test.describe('EV-CARDS200: event cards wrap long words', () => {
  for (const width of [300, ...WIDTHS]) {
    for (const text of TEXTS) {
      test(`at ${width} px and ${text} % browser text, nothing scrolls sideways and no card spills`, async ({ page, browserName }, info) => {
        await screen(page, browserName, width, text);
        await page.goto('/events');
        expect(await rootPx(page)).toBeCloseTo((16 * text) / 100, 0);
        const cards = page.locator('.ecard');
        expect(await cards.count()).toBeGreaterThan(0);
        await cards.first().scrollIntoViewIfNeeded();
        await shot(page, info, `cards-${width}-${text}`);
        expect(await spilling(cards), 'the cards as seeded').toEqual([]);
        expect(await sideways(page), 'the page as seeded').toEqual([]);
        expect(await axe(page)).toEqual([]);

        // A title, a place and a town with no place to break.
        await cards.first().locator('.ecard__link').evaluate((el, word) => (el.textContent = `${word} lunch`), LONG_WORD);
        await cards.first().locator('.ecard__t > p').evaluateAll((els, word) => els.forEach((el) => (el.textContent = `11:30 am · ${word}`)), LONG_WORD);
        await cards.first().scrollIntoViewIfNeeded();
        await shot(page, info, `cards-long-${width}-${text}`);
        expect(await spilling(cards), 'a card with long words').toEqual([]);
        expect(await sideways(page), 'the page with long words').toEqual([]);
        // Still readable: the title keeps its size, and the whole card can be opened.
        expect(await cards.first().locator('h3').evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(Math.min(20, width * 0.09) - 0.01);
        expect((await cards.first().boundingBox())!.height).toBeGreaterThanOrEqual(48);
      });
    }
  }

  // Readable: the wrap rule breaks a word only when the word alone is wider than the card.
  for (const width of [412, 1280]) {
    test(`at ${width} px, no seeded word is broken`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/events');
      const texts = page.locator('.ecard__t');
      expect(await texts.count()).toBeGreaterThan(0);
      const heights = () => texts.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
      const wrapped = await heights();
      await texts.evaluateAll((els) => els.forEach((el) => ((el as HTMLElement).style.overflowWrap = 'normal')));
      expect(await heights()).toEqual(wrapped);
    });
  }
});

test.describe('E4-FOLLOWUPS: the review page title wraps', () => {
  for (const width of WIDTHS) {
    for (const text of TEXTS) {
      test(`at ${width} px and ${text} % browser text, a long title stays on the screen`, async ({ page, browserName }, info) => {
        await screen(page, browserName, width, text);
        await page.goto('/');
        await signIn(page, 'webmaster');
        await page.goto(review(REVIEW.links.id));
        expect(await rootPx(page)).toBeCloseTo((16 * text) / 100, 0);
        const header = page.locator('.item-header');
        const title = header.getByRole('heading', { level: 1 });
        await expect(title).toHaveText(REVIEW.links.title);
        expect(await spilling(header), 'the header as seeded').toEqual([]);

        await title.evaluate((el, words) => (el.textContent = words), LONG_TITLE);
        await shot(page, info, `review-title-${width}-${text}`);
        expect(await spilling(header), 'the header with a long title').toEqual([]);
        expect(await sideways(page), 'the page with a long title').toEqual([]);
        // The whole title is there to read: nothing is cut off.
        expect(await title.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
        expect(await title.evaluate((el) => getComputedStyle(el).overflow)).toBe('visible');
        expect(await axe(page)).toEqual([]);
      });
    }
  }

  test('at 320 px and the site’s largest text, a long title stays on the screen', async ({ page, context, baseURL }, info) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await setPrefs(context, baseURL!, { size: SIZES[6] });
    await page.goto('/');
    await signIn(page, 'webmaster');
    for (const path of [review(REVIEW.links.id), `${review(REVIEW.takenDown.id)}/publish`, `${review(WORKFLOW.published.id)}/take-down`]) {
      await page.goto(path);
      const header = page.locator('.item-header');
      await header.getByRole('heading', { level: 1 }).evaluate((el, words) => (el.textContent = words), LONG_TITLE);
      expect(await spilling(header), path).toEqual([]);
      expect(await sideways(page), path).toEqual([]);
    }
    await shot(page, info, 'review-title-320-largest');
  });
});

test.describe('E7B-N5: the "done" banner is the piece’s real state', () => {
  const PUBLISHED = 'Published. It is on the website now.';

  test('a crafted ?done= on a piece that did not take that step shows no banner', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'webmaster');
    const chip = page.locator('.item-header .chip');
    // Waiting for approval, read from the API: none of the steps happened to it.
    for (const step of ['published', 'approved', 'taken-down', 'answers', 'sent-back']) {
      const res = await page.goto(`${review(WORKFLOW.waiting.id)}?done=${step}`);
      expect(res?.status(), step).toBe(200);
      await expect(chip).toHaveText('Waiting for approval');
      await expect(page.getByRole('status'), step).toHaveCount(0);
      await expect(page.getByText(PUBLISHED), step).toHaveCount(0);
      await expect(page.getByText(/^(Approved\.|Taken down\.|Your answers are saved\.|Sent back)/), step).toHaveCount(0);
    }
    // Approved and not yet published: "Published." would be false, "Approved." is true.
    await page.goto(`${review(WORKFLOW.cleared.id)}?done=published`);
    await expect(chip).toHaveText('Approved, ready to publish');
    await expect(page.getByRole('status')).toHaveCount(0);
    await page.goto(`${review(WORKFLOW.cleared.id)}?done=approved`);
    await expect(page.getByRole('status')).toHaveText('Approved. This does not publish it yet. The Webmaster publishes it.');
    // Published: "Published." is true, "Taken down." would be false.
    await page.goto(`${review(WORKFLOW.published.id)}?done=published`);
    await expect(chip).toHaveText('Published');
    await expect(page.getByRole('status')).toHaveText(PUBLISHED);
    await page.goto(`${review(WORKFLOW.published.id)}?done=taken-down`);
    await expect(page.getByRole('status')).toHaveCount(0);
  });

  test('the queue, which reads no single piece, says only "sent back"', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'webmaster');
    for (const step of ['published', 'approved', 'taken-down', 'answers']) {
      await page.goto(`${QUEUE}?done=${step}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByRole('status'), step).toHaveCount(0);
    }
    await page.goto(`${QUEUE}?done=sent-back`);
    await expect(page.getByRole('status')).toHaveText('Sent back to the writer with your note.');
  });
});

test.describe('SERIES-UI-2: the series form asks only what matches the choice, with no script', () => {
  test.use({ javaScriptEnabled: false });

  const NEW = '/officer-area/events/series/new';
  const group = (page: Page, name: string) => page.getByRole('group', { name, exact: true });
  /** Every follow-up question, by the words that say what it is for. */
  const followUps = (page: Page) => ({
    everyN: page.getByLabel('For "Every few weeks": how many weeks apart'),
    days: group(page, 'For a weekly event: on which days'),
    monthly: group(page, 'For a monthly event: which day of the month'),
    ordinal: group(page, 'For a monthly event on a day of the week: which one in the month'),
    weekday: group(page, 'For a monthly event on a day of the week: which day'),
    monthDay: page.getByLabel('For a monthly event on a date: the day of the month'),
    count: page.getByLabel('For "After a number of dates": how many dates'),
    until: page.getByLabel('For "On a date": the last date'),
  });
  type Question = keyof ReturnType<typeof followUps>;
  /** Exactly these follow-up questions are shown. */
  async function shows(page: Page, shown: Question[], when: string) {
    for (const [name, question] of Object.entries(followUps(page))) {
      if (shown.includes(name as Question)) await expect(question, `${name}, ${when}`).toBeVisible();
      else await expect(question, `${name}, ${when}`).toBeHidden();
    }
  }
  const formHeight = async (page: Page) => Math.round((await page.locator('.series-form').boundingBox())!.height);

  for (const width of WIDTHS) {
    for (const text of TEXTS) {
      test(`at ${width} px and ${text} % browser text, each choice shows its own questions`, async ({ page, browserName }, info) => {
        await screen(page, browserName, width, text);
        await page.goto('/');
        await signIn(page, 'officer');
        await page.goto(NEW);
        expect(await rootPx(page)).toBeCloseTo((16 * text) / 100, 0);

        // Nothing chosen yet (it keeps going, by default): no follow-up question.
        await shot(page, info, `series-new-${width}-${text}`, text === 100);
        const heights = [`new ${await formHeight(page)}`];
        await shows(page, [], 'nothing chosen');
        expect(await sideways(page)).toEqual([]);

        await page.getByRole('radio', { name: 'Every week', exact: true }).check();
        await shows(page, ['days'], 'every week');
        await page.getByRole('radio', { name: 'Every 2 weeks' }).check();
        await shows(page, ['days'], 'every 2 weeks');
        await page.getByRole('radio', { name: 'Every few weeks' }).check();
        await shows(page, ['everyN', 'days'], 'every few weeks');
        await page.getByRole('checkbox', { name: 'Tuesday' }).check();

        // The weekly days go once it is monthly; the monthly questions come one choice at a time.
        await page.getByRole('radio', { name: 'Once a month' }).check();
        await shows(page, ['monthly'], 'once a month');
        await page.getByRole('radio', { name: 'On a day of the week, such as the second Friday' }).check();
        await shows(page, ['monthly', 'ordinal', 'weekday'], 'monthly, on a day of the week');
        heights.push(`monthly by weekday ${await formHeight(page)}`);
        await shot(page, info, `series-monthly-${width}-${text}`, text === 100);
        expect(await sideways(page)).toEqual([]);
        await page.getByRole('radio', { name: 'On a date, such as the 15th' }).check();
        await shows(page, ['monthly', 'monthDay'], 'monthly, on a date');
        await page.getByRole('radio', { name: 'On the last day of the month' }).check();
        await shows(page, ['monthly'], 'monthly, on the last day');

        await page.getByRole('radio', { name: 'After a number of dates' }).check();
        await shows(page, ['monthly', 'count'], 'ends after a number of dates');
        await page.getByRole('radio', { name: 'On a date', exact: true }).check();
        await shows(page, ['monthly', 'until'], 'ends on a date');
        await page.getByRole('radio', { name: 'It keeps going' }).check();
        await shows(page, ['monthly'], 'it keeps going');

        // Back to weekly: the day ticked before is still ticked, and every shown choice is 48 px tall.
        await page.getByRole('radio', { name: 'Every week', exact: true }).check();
        await shows(page, ['days'], 'every week again');
        await expect(page.getByRole('checkbox', { name: 'Tuesday' })).toBeChecked();
        for (const choice of await page.locator('.series-form .choice:visible').all()) expect((await choice.boundingBox())!.height).toBeGreaterThanOrEqual(48);
        expect(await rootPx(page), 'the browser text size held to the end').toBeCloseTo((16 * text) / 100, 0);
        info.annotations.push({ type: 'form height, css px', description: heights.join('; ') });
        console.log(`SERIES-UI-2 form height ${info.project.name} ${width} px ${text} %: ${heights.join('; ')}`);
      });
    }
  }

  test('a problem keeps its question shown, and its link from the list at the top works', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'officer');
    await page.goto(NEW);
    await page.getByLabel('Title').fill('Half filled');
    await page.getByRole('radio', { name: 'Every week', exact: true }).check();
    await page.getByRole('button', { name: 'Start it' }).click();
    const summary = page.locator('[data-error-summary]');
    await expect(summary).toContainText('Days of the week: Choose at least one day of the week.');
    await shows(page, ['days'], 'weekly, with its problem');
    // Changed to monthly before sending again: the days, with their problem, stay until the form is sent.
    await page.getByRole('radio', { name: 'Once a month' }).check();
    await shows(page, ['days', 'monthly'], 'monthly, the days still with a problem');
    await summary.getByRole('link', { name: /Days of the week/ }).click();
    await expect(page.getByRole('checkbox', { name: 'Monday' })).toBeInViewport();
  });

  test('a series opened to change shows the questions of its own pattern', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'officer');
    await page.goto(`/officer-area/events/series/${EVENT_EDITS.lunchSeries}`);
    await expect(page.getByRole('radio', { name: 'Every week', exact: true })).toBeChecked();
    await shows(page, ['days'], 'the weekly lunch');
    await expect(page.getByRole('checkbox', { name: 'Wednesday' })).toBeChecked();
  });
});

// axe needs the page's script engine, so it runs apart from the no-script checks above.
test.describe('SERIES-UI-2: the series form, with questions hidden and shown, passes axe', () => {
  for (const width of WIDTHS) {
    for (const text of TEXTS) {
      test(`at ${width} px and ${text} % browser text`, async ({ page, browserName }) => {
        await screen(page, browserName, width, text);
        await page.goto('/');
        await signIn(page, 'officer');
        await page.goto('/officer-area/events/series/new');
        await expect(page.getByRole('group', { name: 'For a weekly event: on which days' })).toBeHidden();
        expect(await axe(page), 'nothing chosen').toEqual([]);
        await page.getByRole('radio', { name: 'Once a month' }).check();
        await page.getByRole('radio', { name: 'On a day of the week, such as the second Friday' }).check();
        await page.getByRole('radio', { name: 'After a number of dates' }).check();
        await expect(page.getByRole('group', { name: 'For a monthly event on a day of the week: which day' })).toBeVisible();
        expect(await axe(page), 'monthly, on a day of the week, ending after a number').toEqual([]);
        expect(await rootPx(page), 'the browser text size held to the end').toBeCloseTo((16 * text) / 100, 0);
        expect(await sideways(page)).toEqual([]);
      });
    }
  }
});
