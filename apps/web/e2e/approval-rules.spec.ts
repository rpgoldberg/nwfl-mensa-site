// SOLO-APPROVE, through the browser with no script: the one-approver note on the officer area, the
// Admin's switch (two plain forms, a confirmation step and a reason), and who may not see either.
// The stand-in API keeps one setting per signed-in subject (e2e/stand-in.ts APPROVAL): "officer"
// reads publishing as one approver, "long-name" as two approvers, and the Admin flips their own. The
// member is seeded at one approver on both scopes and answered as a buggy API would, so a page that
// ever asked for a member would show it.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { SIZES } from '../server/prefs.mjs';
import { setPrefs } from './prefs';
import { SITE_URL } from './servers';
import { signIn } from './signin';
import { APPROVAL, MONTHS, centralToday } from './stand-in';

const HERE = '/officer-area/approval-rules';
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'wcag2aaa', 'best-practice'];

async function axe(page: Page): Promise<string[]> {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

/** Today as the note says it, by the Central calendar. */
function today(): string {
  const [y, m, d] = centralToday().split('-').map(Number) as [number, number, number];
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

const post = (page: Page, form: Record<string, string>, origin = SITE_URL) => page.request.post(`${SITE_URL}${HERE}`, { form, headers: { Origin: origin }, maxRedirects: 0 });

test.describe('the one-approver note', () => {
  test.use({ javaScriptEnabled: false });

  test('an officer sees it where approval happens while publishing is set to one approver, and no switch', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'officer');
    await page.goto('/officer-area');
    await expect(page.getByRole('note').filter({ hasText: 'One approver' })).toHaveText(APPROVAL.oneApproverNote);
    await expect(page.getByRole('link', { name: 'Approval setting' })).toHaveCount(0);
  });

  test('an officer under the usual two approvers sees none', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'long-name');
    await page.goto('/officer-area');
    await expect(page.getByRole('heading', { name: 'Officer area' })).toBeVisible();
    expect(await page.content()).not.toContain('One approver');
  });

  test('the public and members never see it, nor the switch\'s address, on any page', async ({ page }) => {
    const pages = ['/', '/news', '/events', '/officers', '/about', '/more', '/help'];
    /** Nothing of the approval rule: not the note, not the could-not-check line, not the switch. */
    const nothingOfIt = async (path: string): Promise<void> => {
      await expect(page.locator('.notice--rule'), path).toHaveCount(0);
      // Every page has a role=note (the in-app browser hint, Base.astro), so: none about approval.
      await expect(page.getByRole('note').filter({ hasText: /approv/i }), path).toHaveCount(0);
      const html = await page.content();
      for (const text of ['One approver', 'approval setting', APPROVAL.unknownNote, 'approval-rules']) expect(html, `${path}: ${text}`).not.toContain(text);
    };
    // Signed out, /officer-area sends to sign in: that page too.
    for (const path of [...pages, '/officer-area']) {
      await page.goto(path);
      await nothingOfIt(path);
    }
    await page.goto('/');
    await signIn(page, 'member');
    for (const path of [...pages, '/officer-area']) {
      await page.goto(path);
      await nothingOfIt(path);
    }
  });
});

test.describe('who may open the switch', () => {
  test.use({ javaScriptEnabled: false });

  test('sends anyone not signed in to sign in first', async ({ page }) => {
    const res = await page.request.get(`${SITE_URL}${HERE}`, { maxRedirects: 0 });
    expect(res.status()).toBe(303);
    expect(res.headers()['location']).toBe('/sign-in?return=%2Fofficer-area%2Fapproval-rules');
  });

  for (const login of ['officer', 'webmaster'] as const) {
    test(`gives the ${login} the plain not-found page, on a visit and on a post, and no link to it`, async ({ page }) => {
      await page.goto('/');
      await signIn(page, login);
      const res = await page.goto(HERE);
      expect(res?.status()).toBe(404);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found');
      expect((await post(page, { step: 'apply', scope: 'content', rule: 'one_approver', reason: 'mine now' })).status()).toBe(404);
      await page.goto('/officer-area');
      await expect(page.getByRole('link', { name: 'Approval setting' })).toHaveCount(0);
    });
  }

  test('refuses the Admin\'s form posted from another site', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'admin');
    const res = await post(page, { step: 'apply', scope: 'content', rule: 'one_approver', reason: 'forged' }, 'https://elsewhere.example.org');
    expect(res.status()).toBe(403);
  });
});

test.describe('the Admin\'s switch', () => {
  test.use({ javaScriptEnabled: false });

  test('is linked from the officer area, and lays out both settings as plain labelled forms that pass axe', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'admin');
    await page.goto('/officer-area');
    await page.getByRole('link', { name: 'Approval setting' }).click();
    await expect(page).toHaveURL(new RegExp(`${HERE}$`));
    // W-SIGNUP fix 1: content is approved by people other than the writer; a privacy setting by officers.
    await expect(page.locator('.lead')).toHaveText('Whether a second person must approve. Two is the usual rule. Only you, as the Admin, can change it, and every change is recorded with your reason.');
    const labels: Record<string, readonly [string, string]> = {
      'Publishing content': ['Two people: someone other than the writer approves (the Admin or the Webmaster)', 'One person: the writer may approve their own edit'],
      'Loosening a public privacy setting': ['Two officers: another officer approves', 'One officer'],
    };
    for (const [scope, [two, one]] of Object.entries(labels)) {
      const group = page.getByRole('group', { name: scope, exact: true });
      await expect(group.getByRole('radio', { name: two, exact: true })).toBeVisible();
      await expect(group.getByRole('radio', { name: one, exact: true })).toBeVisible();
      await expect(group.getByRole('textbox', { name: 'Why are you making this change?' })).toHaveAttribute('maxlength', '500');
      await expect(group.getByRole('button', { name: 'Review this change' })).toBeVisible();
    }
  });

  test('renders at the largest text size with no script', async ({ page, context, baseURL }) => {
    await setPrefs(context, baseURL!, { size: SIZES[6] });
    await page.goto('/');
    await signIn(page, 'admin');
    await page.goto(HERE);
    await expect(page.getByRole('group', { name: 'Publishing content', exact: true })).toBeVisible();
    // Measured with script on in the axe block below; here the page is read as it renders with none.
    await expect(page.getByRole('button', { name: 'Review this change' }).first()).toBeVisible();
  });

  test('says what is missing next to the field, in words', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'admin');
    await page.goto(HERE);
    const group = page.getByRole('group', { name: 'Publishing content', exact: true });
    await group.getByRole('radio', { name: 'One person: the writer may approve their own edit' }).check();
    await group.getByRole('button', { name: 'Review this change' }).click();
    const box = page.getByRole('group', { name: 'Publishing content', exact: true }).getByRole('textbox', { name: 'Why are you making this change?' });
    await expect(box).toHaveAttribute('aria-invalid', 'true');
    await expect(box).toHaveAccessibleDescription(/Problem: Write why you are making this change\./);
  });

  // One project flips the Admin's own setting, so the steps never race another browser's.
  test('flips publishing to one person and back: review, confirm, saved, and a repeat changes nothing', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-desktop', 'the flip runs in one project only: the Admin\'s setting is shared by subject');
    await page.goto('/');
    await signIn(page, 'admin');
    await page.goto(HERE);
    let group = page.getByRole('group', { name: 'Publishing content', exact: true });
    await group.getByRole('radio', { name: 'One person: the writer may approve their own edit' }).check();
    await group.getByRole('textbox', { name: 'Why are you making this change?' }).fill('The Webmaster is away until Monday');
    await group.getByRole('button', { name: 'Review this change' }).click();

    await expect(page.getByRole('heading', { name: 'Check this change' })).toBeVisible();
    await expect(page.getByText("You are about to let the writer approve and publish their own edit without a second person's approval.")).toBeVisible();
    await expect(page.getByText('Reason: The Webmaster is away until Monday')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Cancel' })).toHaveAttribute('href', HERE);
    await page.getByRole('button', { name: 'Yes, make this change' }).click();

    await expect(page).toHaveURL(new RegExp(`${HERE}\\?done=content&changed=1$`));
    await expect(page.getByRole('status')).toHaveText('Publishing content: Saved.');
    const note = `One approver: a second person's approval is not required right now (set by the Admin on ${today()}).`;
    await expect(page.getByRole('note').filter({ hasText: 'One approver' })).toHaveText(note);
    await page.goto('/officer-area');
    await expect(page.getByRole('note').filter({ hasText: 'One approver' })).toHaveText(note);

    // The confirmation posted again (back, then resubmit): nothing changes.
    const again = await post(page, { step: 'apply', scope: 'content', rule: 'one_approver', reason: 'The Webmaster is away until Monday', revision: '' });
    expect(again.status()).toBe(303);
    expect(again.headers()['location']).toBe(`${HERE}?done=content&changed=0`);
    await page.goto(`${HERE}?done=content&changed=0`);
    await expect(page.getByRole('status')).toHaveText('Publishing content: No change: it was already set that way.');

    group = page.getByRole('group', { name: 'Publishing content', exact: true });
    await group.getByRole('radio', { name: 'Two people: someone other than the writer approves (the Admin or the Webmaster)' }).check();
    await group.getByRole('textbox', { name: 'Why are you making this change?' }).fill('The Webmaster is back');
    await group.getByRole('button', { name: 'Review this change' }).click();
    await expect(page.getByText('You are about to require someone other than the writer (the Admin or the Webmaster) to approve again before anything is published.')).toBeVisible();
    await page.getByRole('button', { name: 'Yes, make this change' }).click();
    await expect(page.getByRole('status')).toHaveText('Publishing content: Saved.');
    expect(await page.content()).not.toContain('One approver');
  });
});

test.describe('a stale switch, and the Admin without the officers group', () => {
  test.use({ javaScriptEnabled: false });

  test('links the Admin who is not in the officers group to the switch from the officer area, not to a refusal', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'lone-admin');
    const res = await page.goto('/officer-area');
    expect(res?.status()).toBe(200);
    await expect(page.getByText("This area is for the club's officers.")).toHaveCount(0);
    await page.getByRole('link', { name: 'Approval setting' }).click();
    await expect(page).toHaveURL(new RegExp(`${HERE}$`));
    await expect(page.getByRole('group', { name: 'Publishing content', exact: true })).toBeVisible();
  });

  test('opens the switch for the Admin who is not in the officers group, with the setting read', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'lone-admin');
    const res = await page.goto(HERE);
    expect(res?.status()).toBe(200);
    await expect(page.getByRole('group', { name: 'Publishing content', exact: true }).getByText(/^Now: /)).toBeVisible();
    expect(await page.content()).not.toContain('Sign in again');
  });

  // "lone-admin" is its own subject: only this test flips it, in one project.
  test('refuses a confirmation sent again after a later switch: nothing changes, and the page says so', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-desktop', 'the flip runs in one project only: the setting is shared by subject');
    await page.goto('/');
    await signIn(page, 'lone-admin');
    const review = async (rule: string, reason: string): Promise<Record<string, string>> => {
      await page.goto(HERE);
      const group = page.getByRole('group', { name: 'Publishing content', exact: true });
      await group.getByRole('radio', { name: rule }).check();
      await group.getByRole('textbox', { name: 'Why are you making this change?' }).fill(reason);
      await group.getByRole('button', { name: 'Review this change' }).click();
      await expect(page.getByRole('heading', { name: 'Check this change' })).toBeVisible();
      const fields: Record<string, string> = {};
      for (const input of await page.locator('form input[type="hidden"]').all()) fields[(await input.getAttribute('name'))!] = (await input.getAttribute('value')) ?? '';
      await page.getByRole('button', { name: 'Yes, make this change' }).click();
      await expect(page.getByRole('status')).toHaveText('Publishing content: Saved.');
      return fields;
    };
    const away = await review('One person: the writer may approve their own edit', 'The Webmaster is away this week');
    expect(away).toMatchObject({ step: 'apply', scope: 'content', rule: 'one_approver', revision: '' });
    await review('Two people: someone other than the writer approves (the Admin or the Webmaster)', 'The Webmaster is back');

    const stale = await post(page, away);
    expect(stale.status()).toBe(409);
    const body = await stale.text();
    expect(body).toContain('Nothing was changed: this setting was changed after you looked at it.');
    expect(body).toContain('Now: Two people: someone other than the writer approves (the Admin or the Webmaster)');
    await page.goto(HERE);
    expect(await page.content()).not.toContain('One approver');
  });
});

// axe runs in the page, so these have script on; the pages are the same without it.
test.describe('axe on the officer pages', () => {
  test('the officer area with the note', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'officer');
    await page.goto('/officer-area');
    await expect(page.getByRole('note').filter({ hasText: 'One approver' })).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });

  test('the officer area as the Admin who is not in the officers group', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'lone-admin');
    await page.goto('/officer-area');
    await expect(page.getByRole('link', { name: 'Approval setting' })).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });

  for (const size of [SIZES[0], SIZES[6]]) {
    test(`the switch, a refused form and the confirmation, at ${size} % text, with nothing to scroll sideways`, async ({ page, context, baseURL }) => {
      await setPrefs(context, baseURL!, { size });
      await page.goto('/');
      await signIn(page, 'admin');
      await page.goto(HERE);
      expect(await axe(page)).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      const group = page.getByRole('group', { name: 'Publishing content', exact: true });
      await group.getByRole('button', { name: 'Review this change' }).click();
      await expect(page.getByText('Problem: Write why you are making this change.').first()).toBeVisible();
      expect(await axe(page)).toEqual([]);
      const again = page.getByRole('group', { name: 'Loosening a public privacy setting', exact: true });
      await again.getByRole('radio', { name: 'One officer' }).check();
      await again.getByRole('textbox', { name: 'Why are you making this change?' }).fill('A trial week');
      await again.getByRole('button', { name: 'Review this change' }).click();
      await expect(page.getByRole('heading', { name: 'Check this change' })).toBeVisible();
      await expect(page.getByText("You are about to let one officer loosen a public privacy setting without another officer's approval.")).toBeVisible();
      expect(await axe(page)).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    });
  }
});
