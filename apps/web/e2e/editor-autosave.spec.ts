// EDITOR E3 round 2: a draft saves itself, with guards, through the browser, against the stand-in API's
// workflow (e2e/workflow.mjs, which answers SaveDraft's base and auto as the API does). The page's clock
// is Playwright's, so "a minute after the last change" takes no real minute. A draft saves itself a
// minute after typing and says so; a hidden page saves at once; a second tab's save first stops the
// first tab's auto-save with the text kept; an item waiting for approval never saves itself; the
// lapsing sign-in saves before it ends. With no script nothing saves itself, and a save from a stale
// page is refused with the text kept. Accessibility in every theme with the status line showing.
// Every test writes its own item, with a title of its own.
import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';
import { THEMES, setPrefs } from './prefs';
import { SITE_URL } from './servers';
import { signIn } from './signin';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'wcag2aaa', 'best-practice'];
const LIST = '/officer-area/news';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const EDIT = new RegExp(`/officer-area/news/(${UUID})(\\?.*)?$`);
const SAVED = /^Saved automatically at \d{1,2}:\d{2} (am|pm|noon)\.$/;
const CONFLICT = 'Not saved: someone else changed this draft. Your text is kept here.';

const titled = (what: string) => `${what} ${test.info().project.name} ${test.info().workerIndex}-${Date.now().toString(36)}`;
const textBox = (page: Page) => page.getByRole('textbox', { name: 'The text', exact: true });
const status = (page: Page) => page.locator('[data-autosave-status]');

/** As editor-writer.spec.ts runs it: from the foot of the page, so no fixed bar sits over a field mid-scroll. */
async function axe(page: Page): Promise<string[]> {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

/** S3: a new item; on its edit page after, its id. */
async function createItem(page: Page, title: string): Promise<string> {
  await page.goto(LIST);
  await page.getByRole('link', { name: 'Write something new' }).click();
  await page.getByRole('radio', { name: 'Announcement', exact: true }).check();
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill(title);
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page).toHaveURL(EDIT);
  return EDIT.exec(page.url())?.[1] as string;
}

/** The page's clock under the test's hand from here on, and the auto-saves it sends, counted. */
async function controlled(page: Page): Promise<{ sent: () => number }> {
  let sent = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/autosave')) sent += 1;
  });
  await page.clock.install();
  await page.reload();
  return { sent: () => sent };
}

test.describe('a draft saves itself', () => {
  test('a minute after the last change, saying so; the text is there on reload, with no copy to offer back', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'officer');
    await createItem(page, titled('Saves itself'));
    const autosaves = await controlled(page);
    await expect(status(page)).toHaveText('A draft saves itself a minute after you stop typing.');
    await expect(status(page)).toHaveAttribute('role', 'status');
    await textBox(page).fill('Typed, saved by itself.');
    await page.clock.runFor(59_000);
    expect(autosaves.sent()).toBe(0);
    await page.clock.runFor(1_000);
    await expect(status(page)).toHaveText(SAVED);
    expect(autosaves.sent()).toBe(1);
    // Nothing changed since: no more saves.
    await page.clock.runFor(5 * 60_000);
    expect(autosaves.sent()).toBe(1);
    await page.reload();
    await expect(textBox(page)).toHaveValue('Typed, saved by itself.');
    await expect(page.getByRole('region', { name: 'Text you had not saved' })).toBeHidden();
  });

  test('at once when the page is hidden', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'officer');
    await createItem(page, titled('Hidden'));
    const autosaves = await controlled(page);
    await textBox(page).fill('Typed, then the tab hidden.');
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(status(page)).toHaveText(SAVED);
    expect(autosaves.sent()).toBe(1);
    await page.reload();
    await expect(textBox(page)).toHaveValue('Typed, then the tab hidden.');
  });

  test('stops when another tab saved first, keeping the text, with the way to the latest', async ({ page, context }) => {
    await page.goto('/');
    await signIn(page, 'officer');
    const id = await createItem(page, titled('Two tabs'));
    const autosaves = await controlled(page);
    const other = await context.newPage();
    await other.goto(`/officer-area/news/${id}`);
    await textBox(other).fill('The other tab saved first.');
    await other.getByRole('button', { name: 'Save draft' }).first().click();
    await expect(other.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();

    await textBox(page).fill('Mine, typed after.');
    await page.clock.runFor(60_000);
    await expect(status(page)).toHaveText(CONFLICT);
    const note = page.getByRole('note').filter({ hasText: 'Someone else changed this draft since you opened it.' });
    await expect(note).toBeVisible();
    await expect(note).toContainText('Copy what you need, then open the latest version (opens a new tab).');
    await expect(note.getByRole('link', { name: 'open the latest version (opens a new tab)' })).toHaveAttribute('target', '_blank');
    await expect(textBox(page)).toHaveValue('Mine, typed after.');
    expect(await page.evaluate((key) => sessionStorage.getItem(key), `nwfl-draft:${id}`)).toContain('Mine, typed after.');
    // Stopped for good.
    await textBox(page).fill('Mine, typed after, and more.');
    await page.clock.runFor(10 * 60_000);
    expect(autosaves.sent()).toBe(1);
    await other.reload();
    await expect(textBox(other)).toHaveValue('The other tab saved first.');
    // Save draft, pressed now, is refused too: the text stays, nothing is written.
    await page.getByRole('button', { name: 'Save draft' }).first().click();
    await expect(page.getByRole('alert')).toContainText('Nothing was saved: someone else changed this draft since you opened it.');
    await expect(textBox(page)).toHaveValue('Mine, typed after, and more.');
    await other.reload();
    await expect(textBox(other)).toHaveValue('The other tab saved first.');
  });

  test('never for an item waiting for approval', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'officer');
    const id = await createItem(page, titled('Waiting'));
    await textBox(page).fill('Ready to go.');
    await page.getByRole('button', { name: 'Save draft' }).first().click();
    await page.goto(`/officer-area/news/${id}/preview`);
    await page.getByRole('button', { name: 'Send for approval' }).click();
    await expect(page).toHaveURL(`${SITE_URL}${LIST}?sent=1`);
    await page.goto(`/officer-area/news/${id}`);
    const autosaves = await controlled(page);
    await expect(page.getByRole('note').filter({ hasText: 'It is waiting for approval.' })).toBeVisible();
    await expect(status(page)).toHaveCount(0);
    await textBox(page).fill('A change, not saved by itself.');
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.clock.runFor(10 * 60_000);
    expect(autosaves.sent()).toBe(0);
  });

  test('before the sign-in ends', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('/');
    await signIn(page, 'writer-lapsing');
    await createItem(page, titled('Before the end'));
    const autosaves = await controlled(page);
    // The token lives 45 seconds: its last two minutes are now, so a change saves within five seconds.
    await textBox(page).fill('Saved before the sign-in ends.');
    await page.clock.runFor(5_000);
    await expect(status(page)).toHaveText(SAVED);
    expect(autosaves.sent()).toBe(1);
  });

  for (const theme of THEMES) {
    test(`passes axe with the status line showing, in the ${theme ?? 'default'} theme`, async ({ page, context, baseURL }) => {
      await setPrefs(context, baseURL!, theme ? { theme } : {});
      await page.goto('/');
      await signIn(page, 'officer');
      await createItem(page, titled('Axe'));
      await controlled(page);
      await textBox(page).fill('Checked.');
      await page.clock.runFor(60_000);
      await expect(status(page)).toHaveText(SAVED);
      expect(await axe(page)).toEqual([]);
    });
  }
});

test.describe('with no script', () => {
  test.use({ javaScriptEnabled: false });

  test('nothing saves itself, and a save from a page someone else has changed since is refused, the text kept', async ({ page, browser }) => {
    await page.goto('/');
    await signIn(page, 'officer');
    const id = await createItem(page, titled('No script'));
    await expect(status(page)).toBeHidden();
    await textBox(page).fill('Mine, from the first page.');

    const second = await browser.newContext({ javaScriptEnabled: false, ignoreHTTPSErrors: true, baseURL: SITE_URL });
    const other = await second.newPage();
    await other.goto('/');
    await signIn(other, 'officer');
    await other.goto(`/officer-area/news/${id}`);
    await textBox(other).fill('The second page saved first.');
    await other.getByRole('button', { name: 'Save draft' }).first().click();
    await expect(other.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();

    const answer = page.waitForResponse((r) => r.request().method() === 'POST' && EDIT.test(r.url()));
    await page.getByRole('button', { name: 'Save draft' }).last().click();
    expect((await answer).status()).toBe(409);
    await expect(page.getByRole('alert')).toContainText('Nothing was saved: someone else changed this draft since you opened it.');
    await expect(page.getByRole('alert').getByRole('link', { name: 'Open the latest version (opens a new tab)' })).toHaveAttribute('href', `/officer-area/news/${id}`);
    await expect(textBox(page)).toHaveValue('Mine, from the first page.');
    await other.reload();
    await expect(textBox(other)).toHaveValue('The second page saved first.');
    await second.close();
  });
});
