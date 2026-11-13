// EDITOR E3: the officers' writer screens, through the browser, against the stand-in API's workflow
// (e2e/workflow.mjs): S1's link, S2 "Our news", S3 a new item, S4 the edit page and S5 preview and send.
// First with no script (plain form posts, post/redirect/get), then with it (the toolbar, the live word
// count, the tab's unsent copy, the leaving warning). The sign-in that ran out keeps the text, whether
// the session is gone or only its token. Who may write: an office's holders and the Admin; an officer
// of another office, an officer with no seat, the Webmaster and a member may not. Accessibility in every
// theme, at the largest text on a 320 px screen with nothing to scroll sideways, 48 px targets.
// Every test that changes something writes its own item, with a title of its own (the seeds are read-only).
import AxeBuilder from '@axe-core/playwright';
import { type Browser, type Page, expect, test } from '@playwright/test';
import { SIZES } from '../server/prefs.mjs';
import { THEMES, setPrefs } from './prefs';
import { SITE_URL } from './servers';
import { signIn } from './signin';
import { WORKFLOW } from './stand-in';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'wcag2aaa', 'best-practice'];
const LIST = '/officer-area/news';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const EDIT = new RegExp(`/officer-area/news/(${UUID})(\\?.*)?$`);

async function axe(page: Page): Promise<string[]> {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** A title no other test uses. */
const titled = (what: string) => `${what} ${test.info().project.name} ${test.info().workerIndex}-${Date.now().toString(36)}`;

/** The item id from the edit page's address. */
const idOf = (page: Page) => EDIT.exec(page.url())?.[1] as string;

/**
 * An item's row in "Our news": a row of the table where the list is wide enough for one (fix 1), else
 * its card. Either holds its status chip and its Open link.
 */
async function rowOf(page: Page, title: string) {
  const table = page.getByRole('table', { name: 'Our news' });
  if (await table.isVisible()) return table.getByRole('row').filter({ has: page.getByRole('rowheader', { name: title, exact: true }) });
  return page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}

const textBox = (page: Page) => page.getByRole('textbox', { name: 'The text', exact: true });
const saveTop = (page: Page) => page.getByRole('button', { name: 'Save draft' }).first();
const saveBottom = (page: Page) => page.getByRole('button', { name: 'Save draft' }).last();

/** S3: a new item by its kind and title (and office, for someone who holds more than one); on its edit page after. */
async function createItem(page: Page, title: string, kind = 'Announcement', office?: string) {
  await page.goto(LIST);
  await page.getByRole('link', { name: 'Write something new' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Write something new');
  await page.getByRole('radio', { name: kind, exact: true }).check();
  if (office) await page.getByRole('group', { name: 'Posting as' }).getByRole('radio', { name: office, exact: true }).check();
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill(title);
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page).toHaveURL(EDIT);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
  return idOf(page);
}

test.describe('writing news, with no script', () => {
  test.use({ javaScriptEnabled: false });

  test('an officer writes, saves, sees each bad address by line, cannot send it until fixed, then sends it', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'officer');
    await page.goto('/officer-area');
    await page.getByRole('link', { name: 'Write news' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Our news');
    const title = titled('Lunch moves');
    await page.getByRole('link', { name: 'Write something new' }).click();
    // One office: no "Posting as" to choose.
    await expect(page.getByRole('group', { name: 'Posting as' })).toHaveCount(0);
    await expect(page.getByText('Posting as President.')).toBeVisible();
    await page.getByRole('radio', { name: 'Announcement', exact: true }).check();
    await page.getByRole('textbox', { name: 'Title', exact: true }).fill(title);
    await page.getByRole('button', { name: 'Create draft' }).click();
    await expect(page).toHaveURL(EDIT);
    const id = idOf(page);
    await expect(page.locator('.item-header .eyebrow')).toHaveText('Announcement · President');
    await expect(page.locator('.item-header .chip')).toHaveText('Draft – only officers can see it');

    // The page's fixed parts: the sign-in line, the roster warning, the format box; no toolbar without script.
    await expect(page.locator('[data-sign-in]')).toHaveText(/^Your sign-in lasts until \d{1,2}:\d{2} (am|pm|noon) Central time\. Save before then\.$/);
    await expect(page.getByText("Never paste birthday, new-member or Mensaversary lists, or anything from Mensa's roster.")).toBeVisible();
    await expect(page.getByRole('heading', { name: 'How to format' })).toBeVisible();
    await expect(page.locator('[data-toolbar]')).toBeHidden();
    await expect(page.locator('[data-length]')).toHaveText('No words yet.');

    await textBox(page).fill('Lunch moves to Thursday.\nSee http://club.example/lunch for the menu, or www.club.example.');
    await saveTop(page).click();
    await expect(page).toHaveURL(new RegExp(`/officer-area/news/${id}\\?saved=1$`));
    await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
    const problems = page.getByRole('region', { name: 'Fix these before you send it for approval' });
    await expect(problems.getByRole('link')).toHaveText([
      'Line 2: the address "http://club.example/lunch" must start with https://, not http://',
      'Line 2: the address "www.club.example" must be written in full, starting with https://',
    ]);
    await expect(problems.getByRole('link').first()).toHaveAttribute('href', '#markup');
    await expect(textBox(page)).toHaveValue('Lunch moves to Thursday.\nSee http://club.example/lunch for the menu, or www.club.example.');
    await expect(page.locator('[data-length]')).toHaveText('11 words, about 1 newsletter page.');

    // Preview: the problems again, and no Send for approval.
    await page.getByRole('link', { name: 'Preview and send' }).click();
    await expect(page).toHaveURL(`${SITE_URL}/officer-area/news/${id}/preview`);
    await expect(page.getByRole('heading', { name: 'What the public sees' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'What members see' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Fix these before you send it for approval' }).getByRole('listitem')).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'Send for approval' })).toHaveCount(0);
    // Posted anyway, it is refused before the API is asked.
    const forced = await page.request.post(`${SITE_URL}/officer-area/news/${id}/preview`, { form: { website: 'yes' }, headers: { Origin: SITE_URL }, maxRedirects: 0 });
    expect(forced.status()).toBe(409);

    await page.getByRole('link', { name: 'Back to editing' }).click();
    await textBox(page).fill('Lunch moves to Thursday.\nSee [the menu](https://club.example/lunch).');
    await saveBottom(page).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Fix these before you send it for approval' })).toHaveCount(0);

    await page.getByRole('link', { name: 'Preview and send' }).click();
    await expect(page.getByRole('region', { name: 'What the public sees' })).toContainText('Lunch moves to Thursday.');
    const showOn = page.getByRole('group', { name: 'Show on' });
    await expect(showOn.getByRole('checkbox', { name: 'Website' })).toBeChecked();
    await expect(showOn.getByRole('checkbox', { name: 'Also in the newsletter' })).toBeChecked();
    await expect(showOn).toContainText('the next issue');
    await page.getByRole('button', { name: 'Send for approval' }).click();
    await expect(page).toHaveURL(`${SITE_URL}${LIST}?sent=1`);
    await expect(page.getByRole('status').filter({ hasText: 'Sent for approval.' })).toBeVisible();
    const row = await rowOf(page, title);
    await expect(row.locator('.chip')).toHaveText('Waiting for approval');
    await expect(row.getByRole('link', { name: `Open ${title}` })).toHaveAttribute('href', `/officer-area/news/${id}`);
  });

  test("a form's problems are listed at the top, each a link to its field, and the text is kept", async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'officer');
    await createItem(page, titled('Problems'));
    await page.getByRole('textbox', { name: 'Title', exact: true }).fill('');
    await page.getByRole('textbox', { name: 'Summary' }).fill(':members[not here]');
    await textBox(page).fill('Kept words.');
    await saveTop(page).click();
    const summary = page.locator('[data-error-summary]');
    await expect(summary.getByRole('heading')).toHaveText('There is a problem with what you wrote');
    await expect(summary.getByRole('link')).toHaveText(['Give it a title.', 'A summary is always public: put members-only words in the text.']);
    await expect(summary.getByRole('link').first()).toHaveAttribute('href', '#title');
    await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveAttribute('aria-invalid', 'true');
    await expect(textBox(page)).toHaveValue('Kept words.');
  });

  test('the public preview leaves out a members passage, which members see; officers-only items cannot go to the newsletter', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'officer');
    const id = await createItem(page, titled('Members bit'));
    await textBox(page).fill('Open words. :members[The gate code is 4321.]');
    await saveTop(page).click();
    await page.goto(`/officer-area/news/${id}/preview`);
    await expect(page.getByRole('region', { name: 'What the public sees' })).toContainText('Open words.');
    await expect(page.getByRole('region', { name: 'What the public sees' })).not.toContainText('4321');
    await expect(page.getByRole('region', { name: 'What members see' })).toContainText('The gate code is 4321.');

    await page.goto(`/officer-area/news/${id}`);
    await page.getByRole('radio', { name: 'Officers only' }).check();
    await saveTop(page).click();
    await page.goto(`/officer-area/news/${id}/preview`);
    await expect(page.getByRole('group', { name: 'Show on' }).getByRole('checkbox', { name: 'Also in the newsletter' })).toHaveCount(0);
    await expect(page.getByText('Officers-only items are not printed in the newsletter.')).toBeVisible();
  });

  test('the Admin chooses the office to post as, marked "for the office" where they do not hold it', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'admin');
    const title = titled('For the Social Chair');
    await page.goto('/officer-area/news/new');
    await expect(page.getByRole('group', { name: 'Posting as' }).getByRole('radio', { name: 'Social Chair (for the office)' })).toBeVisible();
    await createItem(page, title, 'News article', 'Social Chair (for the office)');
    await expect(page.locator('.item-header .eyebrow')).toHaveText('News article · Social Chair');
    await page.goto(LIST);
    await expect(await rowOf(page, title)).toContainText('Social Chair');
  });

  test("an item part of which is held back from the officer never opens in the editor", async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'officer');
    await page.goto(`/officer-area/news/${WORKFLOW.withheld.id}`);
    await expect(page.getByText('Part of this item is held back from you, so it cannot be edited here. Ask the Webmaster or the Admin.')).toBeVisible();
    await expect(textBox(page)).toHaveCount(0);
    expect(await page.content()).not.toContain(WORKFLOW.withheld.canary);
  });

  test('an approved item waiting to be published says so, in the list and on its page', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'officer');
    await page.goto(LIST);
    const row = await rowOf(page, WORKFLOW.cleared.title);
    await expect(row.locator('.chip')).toHaveText('Approved, ready to publish');
    await page.goto(`/officer-area/news/${WORKFLOW.cleared.id}`);
    await expect(page.getByText('It is approved. If you save a change, it needs approving again.')).toBeVisible();
  });

  test("a President's report lists the office's events beside the text, live on the calendar", async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'officer');
    await createItem(page, titled('Our year'), "President's report");
    const events = page.getByRole('region', { name: 'Events in this report' });
    await expect(events).toContainText('Wednesday Lunchers');
    await expect(events.getByRole('link', { name: 'See the calendar' })).toHaveAttribute('href', '/events');
    // Not for an announcement.
    await createItem(page, titled('Not a report'));
    await expect(page.getByRole('region', { name: 'Events in this report' })).toHaveCount(0);
  });
});

// Fix 1: "Our news" keeps published and taken-down items, so an officer can find one to correct, with
// when each last changed; a table where the list is wide enough, cards where it is not.
test.describe('Our news: every item of the office, newest change first', () => {
  test.use({ javaScriptEnabled: false });
  const WHEN = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec), \d{1,2}:\d{2} (am|pm|noon)$/;

  test('lists the published, the changing and the taken-down items in words, each with its last change', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'officer');
    await page.goto(LIST);
    await expect(page.getByText('leaves this list')).toHaveCount(0);
    for (const [title, words] of [
      [WORKFLOW.published.title, 'Published'],
      [`${WORKFLOW.changing.title}, changed`, 'Published – a change is waiting for approval'],
      [WORKFLOW.takenDown.title, /^Taken down on [A-Z][a-z]+ \d{1,2}, \d{4}$/],
      [WORKFLOW.cleared.title, 'Approved, ready to publish'],
    ] as const) {
      const row = await rowOf(page, title);
      await expect(row.locator('.chip'), title).toHaveText(words);
      await expect(row.locator('[data-last-change]'), title).toHaveText(WHEN);
    }
  });

  test('opens a published item to correct it', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'officer');
    await page.goto(LIST);
    await (await rowOf(page, WORKFLOW.published.title)).getByRole('link', { name: `Open ${WORKFLOW.published.title}` }).click();
    await expect(page).toHaveURL(`${SITE_URL}/officer-area/news/${WORKFLOW.published.id}`);
    await expect(page.locator('.item-header .chip')).toHaveText('Published');
    await expect(textBox(page)).toHaveValue('Thank you all.');
  });

  test('is a table on a wide screen: a caption, a header for each column, a header for each row', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    await signIn(page, 'officer');
    await page.goto(LIST);
    const table = page.getByRole('table', { name: 'Our news' });
    await expect(table).toBeVisible();
    await expect(table.getByRole('columnheader')).toHaveText(['Title', 'Office', 'Status', 'Last change', 'Open it']);
    await expect(table.locator('thead th')).toHaveCount(5);
    for (const th of await table.locator('thead th').all()) await expect(th).toHaveAttribute('scope', 'col');
    await expect(table.getByRole('rowheader', { name: WORKFLOW.published.title, exact: true })).toHaveAttribute('scope', 'row');
    await expect(page.locator('.writer-list')).toBeHidden();
  });

  test('is cards on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await signIn(page, 'officer');
    await page.goto(LIST);
    await expect(page.getByRole('table')).toBeHidden();
    await expect(page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: WORKFLOW.published.title, exact: true }) })).toBeVisible();
  });

});

// axe runs in the page: these have script on.
test.describe('Our news: reflow', () => {
  for (const [width, size, what, shape] of [
    [1280, SIZES[6], 'the largest text on a wide screen', 'cards'],
    [1280, 140, 'large text, still a table', 'table'],
    [640, 100, 'a wide screen at 200 % zoom', 'cards'],
    [320, SIZES[6], 'the largest text on a 320 px screen', 'cards'],
  ] as const) {
    test(`nothing scrolls sideways at ${what}`, async ({ page, context, baseURL }) => {
      await page.setViewportSize({ width, height: 800 });
      await setPrefs(context, baseURL!, { size });
      await page.goto('/');
      await signIn(page, 'officer');
      await page.goto(LIST);
      await expect(page.getByRole('table', { name: 'Our news' })).toBeVisible({ visible: shape === 'table' });
      expect(await sideways(page)).toBeLessThanOrEqual(0);
      expect(await axe(page)).toEqual([]);
    });
  }
});

test.describe('who may write', () => {
  test.use({ javaScriptEnabled: false });

  test('a member gets the not-found page for every writer screen', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'member');
    for (const path of [LIST, '/officer-area/news/new', `/officer-area/news/${WORKFLOW.published.id}`, `/officer-area/news/${WORKFLOW.published.id}/preview`]) {
      const res = await page.goto(path);
      expect(res?.status(), path).toBe(404);
    }
    await page.goto('/officer-area');
    await expect(page.getByRole('link', { name: 'Write news' })).toHaveCount(0);
  });

  for (const login of ['officer-only', 'webmaster'] as const) {
    test(`${login} sees the list but nothing to write with`, async ({ page }) => {
      await page.goto('/');
      await signIn(page, login);
      await page.goto('/officer-area');
      await page.getByRole('link', { name: 'Write news' }).click();
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Our news');
      await expect(page.getByText('You hold no office that writes news, so there is nothing here for you to write.')).toBeVisible();
      await expect(page.getByRole('link', { name: 'Write something new' })).toHaveCount(0);
      const res = await page.goto('/officer-area/news/new');
      expect(res?.status()).toBe(403);
      await expect(page.getByRole('button', { name: 'Create draft' })).toHaveCount(0);
    });
  }

  test("an officer of another office can neither open the President's item nor save over it", async ({ page, browser }) => {
    const title = titled('Not yours');
    const id = await asOfficer(browser, async (writer) => {
      const made = await createItem(writer, title);
      await textBox(writer).fill('The President wrote this.');
      await saveTop(writer).click();
      return made;
    });
    await page.goto('/');
    await signIn(page, 'seat-only');
    for (const path of [`/officer-area/news/${id}`, `/officer-area/news/${id}/preview`]) expect((await page.goto(path))?.status(), path).toBe(404);
    await page.goto(LIST);
    await expect(page.getByText(title)).toHaveCount(0);
    const save = await page.request.post(`${SITE_URL}/officer-area/news/${id}`, {
      multipart: { title: 'Taken over', summary: '', visibility: 'public', markup: 'Overwritten.' },
      headers: { Origin: SITE_URL },
      maxRedirects: 0,
    });
    expect(save.status()).toBe(404);
    const send = await page.request.post(`${SITE_URL}/officer-area/news/${id}/preview`, { form: { website: 'yes' }, headers: { Origin: SITE_URL }, maxRedirects: 0 });
    expect(send.status()).toBe(404);
    await asOfficer(browser, async (writer) => {
      await writer.goto(`/officer-area/news/${id}`);
      await expect(writer.getByRole('heading', { level: 1 })).toHaveText(title);
      await expect(textBox(writer)).toHaveValue('The President wrote this.');
      await expect(writer.locator('.item-header .chip')).toHaveText('Draft – only officers can see it');
    });
  });

  test('a cross-site post is refused before anything is read', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'officer');
    const res = await page.request.post(`${SITE_URL}/officer-area/news/new`, { form: { kind: 'announcement', title: 'From elsewhere' }, headers: { Origin: 'https://evil.example' }, maxRedirects: 0 });
    expect(res.status()).toBe(403);
  });
});

/** Runs `use` as the President's officer, in a browser context of its own. */
async function asOfficer<T>(browser: Browser, use: (page: Page) => Promise<T>): Promise<T> {
  const context = await browser.newContext({ baseURL: SITE_URL, ignoreHTTPSErrors: true, javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto('/');
    await signIn(page, 'officer');
    return await use(page);
  } finally {
    await context.close();
  }
}

test.describe('the sign-in ran out while writing', () => {
  test.use({ javaScriptEnabled: false });

  test('with the session gone, Save draft keeps the text; signing in again in a new tab, then Save draft, saves it', async ({ page, context }) => {
    await page.goto('/');
    await signIn(page, 'officer');
    const title = titled('Long report');
    const id = await createItem(page, title);
    const words = 'Line one of a long report.\nLine two, still typing.';
    await textBox(page).fill(words);
    await page.getByRole('textbox', { name: 'Summary' }).fill('A summary kept too');
    await context.clearCookies();
    await saveTop(page).click();
    await expect(page.getByRole('alert')).toContainText("Your sign-in timed out. Your text is still here. Use 'Sign in again' (opens a new tab), then come back to this tab and press Save draft.");
    await expect(textBox(page)).toHaveValue(words);
    await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(title);
    await expect(page.getByRole('textbox', { name: 'Summary' })).toHaveValue('A summary kept too');
    const again = page.getByRole('link', { name: 'Sign in again (opens a new tab)' });
    await expect(again).toHaveAttribute('target', '_blank');
    await expect(again).toHaveAttribute('href', `/sign-in?return=%2Fofficer-area%2Fnews%2F${id}&again=1`);

    const tab = await context.newPage();
    await tab.goto('/');
    await signIn(tab, 'officer');
    await tab.close();
    await saveTop(page).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
    await expect(textBox(page)).toHaveValue(words);
  });

  test('with only the token run out, Save draft keeps the text too', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('/');
    await signIn(page, 'writer-lapsing');
    const signedInAt = Date.now();
    const id = await createItem(page, titled('Lapsing'));
    await textBox(page).fill('Typed before the token ran out.');
    // The token lives 45 seconds; the site stops sending it 30 seconds before it ends.
    await page.waitForTimeout(Math.max(0, 16_000 - (Date.now() - signedInAt)));
    await saveTop(page).click();
    await expect(page).toHaveURL(`${SITE_URL}/officer-area/news/${id}`);
    await expect(page.getByRole('alert')).toContainText('Your sign-in timed out. Your text is still here.');
    await expect(textBox(page)).toHaveValue('Typed before the token ran out.');
  });
});

test.describe('writing news, with script', () => {
  test('the toolbar wraps the selection, the count follows the typing, and leaving with changes asks first', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'officer');
    await createItem(page, titled('With script'));
    const toolbar = page.getByRole('group', { name: 'Format the selected text' });
    await expect(toolbar.getByRole('button')).toHaveText(['Bold', 'Italic', 'Link', 'List', 'Heading', 'Members only']);
    await textBox(page).fill('Thank you all');
    await expect(page.locator('[data-length]')).toHaveText('3 words, about 1 newsletter page.');
    await textBox(page).evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(6, 9));
    await toolbar.getByRole('button', { name: 'Bold' }).click();
    await expect(textBox(page)).toHaveValue('Thank **you** all');
    await expect(textBox(page)).toBeFocused();
    let asked = false;
    page.on('dialog', async (dialog) => {
      asked = dialog.type() === 'beforeunload';
      await dialog.dismiss();
    });
    await page.close({ runBeforeUnload: true });
    await expect.poll(() => asked).toBe(true);
  });

  test("the tab keeps the unsent text and offers it back; a save drops the tab's copy", async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'officer');
    const id = await createItem(page, titled('Kept in the tab'));
    await textBox(page).fill('Typed, never saved.');
    page.on('dialog', (dialog) => void dialog.accept());
    await page.reload();
    await expect(textBox(page)).toHaveValue('');
    const restore = page.getByRole('region', { name: 'Text you had not saved' });
    await expect(restore).toBeVisible();
    await restore.getByRole('button', { name: 'Put back my unsaved text' }).click();
    await expect(textBox(page)).toHaveValue('Typed, never saved.');
    await saveTop(page).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
    // The notice is in the page as served; the script that drops the copy runs just after it.
    await expect.poll(() => page.evaluate((key) => sessionStorage.getItem(key), `nwfl-draft:${id}`)).toBeNull();
    expect(await page.evaluate(() => localStorage.length)).toBe(0);
    await expect(page.getByRole('region', { name: 'Text you had not saved' })).toBeHidden();
  });

  test("a problem's link puts the cursor at the start of its line", async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'officer');
    await createItem(page, titled('Line link'));
    await textBox(page).fill('First line.\nSee http://club.example now.');
    await saveTop(page).click();
    await page.getByRole('link', { name: /^Line 2:/ }).click();
    await expect(textBox(page)).toBeFocused();
    expect(await textBox(page).evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(12);
  });
});

test.describe('the writer screens: accessibility', () => {
  /** Each screen, with something to show: the list, a new item with its problems, an edit page with problems, a preview. */
  async function screens(page: Page): Promise<[string, () => Promise<void>][]> {
    const id = await createItem(page, titled('Axe'));
    await textBox(page).fill('# A heading\n\nSee http://club.example now. :members[Members words.]\n\n- one\n- two');
    await saveTop(page).click();
    return [
      ['Our news', async () => void (await page.goto(LIST))],
      ['a new item, refused', async () => {
        await page.goto('/officer-area/news/new');
        await page.getByRole('button', { name: 'Create draft' }).click();
        await expect(page.locator('[data-error-summary]')).toBeVisible();
      }],
      ['the edit page, with problems', async () => void (await page.goto(`/officer-area/news/${id}`))],
      ['the preview', async () => void (await page.goto(`/officer-area/news/${id}/preview`))],
    ];
  }

  for (const theme of THEMES) {
    test(`axe finds nothing on S2-S5 in the ${theme} theme`, async ({ page, context, baseURL }) => {
      // Four screens, each checked whole: slow on WebKit in a capped container.
        await setPrefs(context, baseURL!, { theme });
      await page.goto('/');
      await signIn(page, 'officer');
      for (const [name, open] of await screens(page)) {
        await open();
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        expect(await axe(page), name).toEqual([]);
      }
    });
  }

  test('at the largest text on a 320 px screen, nothing scrolls sideways, and every button is 48 px tall', async ({ page, context, baseURL }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await setPrefs(context, baseURL!, { size: SIZES[6] });
    await page.goto('/');
    await signIn(page, 'officer');
    for (const [name, open] of await screens(page)) {
      await open();
      expect(await sideways(page), name).toBeLessThanOrEqual(0);
      expect(await axe(page), name).toEqual([]);
      const short = await page.locator('main button:visible, main .button:visible, main .choice:visible').evaluateAll((els) =>
        els.filter((el) => el.getBoundingClientRect().height < 48).map((el) => el.textContent?.trim()),
      );
      expect(short, name).toEqual([]);
    }
  });
});
