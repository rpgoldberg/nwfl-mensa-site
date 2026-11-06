// REOPEN, through the browser: the Admin and the Membership Officer see the rejected sign-ups that
// can be reopened in the officer area's sign-ups page, each with a real Reopen button (48 px) and a
// confirmation step; a membership approver without the seat sees neither. After a reopening the
// rejected person's /account offers the sign-up form again, and they can send it. Axe on each state.
// Every person and address here is made up.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import { SITE_URL } from './servers';
import { signIn } from './signin';
import { REJECTED } from './stand-in';

const ACCOUNT = '/account';
const QUEUE = '/officer-area/sign-ups';
const FAKE_NUMBER = '000012345';
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'wcag2aaa', 'best-practice'];

async function axe(page: Page): Promise<string[]> {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

/** Phone parity: nothing wider than the screen. */
async function fits(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}

const post = (page: Page, form: Record<string, string>) => page.request.post(`${SITE_URL}${QUEUE}`, { form, headers: { Origin: SITE_URL }, maxRedirects: 0 });
/** The stand-in's request id of each project's rejected person (api.mjs REJECTED). */
const REJECTED_IDS = {
  'reopen-desktop': 'c1000000-0000-4000-8000-000000000001',
  'reopen-phone': 'c1000000-0000-4000-8000-000000000002',
  'reopen-iphone': 'c1000000-0000-4000-8000-000000000003',
} as const;
const rejectedCard = (page: Page, name: string) => page.locator('.rejected-card').filter({ hasText: name });

/** This browser project's own rejected person, so the projects' runs never reopen the same one. */
function ownPerson(info: TestInfo): 'reopen-desktop' | 'reopen-phone' | 'reopen-iphone' {
  const login = `reopen-${info.project.name.split('-')[1] ?? ''}`;
  if (login !== 'reopen-desktop' && login !== 'reopen-phone' && login !== 'reopen-iphone') throw new Error(`no rejected person for ${info.project.name}`);
  return login;
}

async function signedIn(browser: Browser, login: Parameters<typeof signIn>[1]): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/');
  await signIn(page, login);
  return page;
}

test.describe('REOPEN: the rejected sign-ups in the officer area', () => {
  test('the Membership Officer sees each rejection in words, with a Reopen button of 48 px, never a number or a last name', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'approver');
    await page.goto(QUEUE);
    await expect(page.getByRole('heading', { level: 2, name: 'Rejected sign-ups' })).toBeVisible();
    const card = rejectedCard(page, REJECTED.kept.name);
    await expect(card.getByRole('heading', { level: 3 })).toHaveText(REJECTED.kept.name);
    await expect(card).toContainText(REJECTED.kept.email);
    await expect(card).toContainText(REJECTED.kept.check);
    await expect(card.locator('div').filter({ has: page.getByText('Rejected on', { exact: true }) }).locator('dd')).toHaveText(REJECTED.kept.rejected);
    const button = card.getByRole('button', { name: 'Reopen' });
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(48);
    expect(box?.width).toBeGreaterThanOrEqual(48);
    expect(await page.content()).not.toMatch(/membership_number|lastName|last_name/);
    expect(await axe(page)).toEqual([]);
    await fits(page);
  });

  test('the Admin sees them too', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'admin');
    await page.goto(QUEUE);
    await expect(rejectedCard(page, REJECTED.kept.name).getByRole('button', { name: 'Reopen' })).toBeVisible();
  });

  test('a membership approver without the seat sees no rejections and no Reopen button, and a forged reopening changes nothing', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'lone-approver');
    await page.goto(QUEUE);
    await expect(page.locator('.signup-card').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Rejected sign-ups' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Reopen' })).toHaveCount(0);
    expect(await page.content()).not.toContain(REJECTED.kept.name);
    const res = await post(page, { decision: 'reopen', request: 'c1000000-0000-4000-8000-000000000004', confirmed: 'yes' });
    expect(res.status()).toBe(409);
    expect(await res.text()).toContain('Nothing was changed: only the Admin or the Membership Officer reopens a sign-up, and never their own.');
  });

  test('the Membership Officer\'s seat without the approvers group finds the page from the officer area, and sees the rejections only', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'seat-only');
    await page.goto('/officer-area');
    await page.getByRole('link', { name: 'Rejected sign-ups to reopen' }).click();
    await expect(page).toHaveURL(`${SITE_URL}${QUEUE}`);
    await expect(page.locator('.lead')).toHaveText('Sign-ups that were rejected and can be reopened. The membership number and last name they typed are never shown here.');
    await expect(page.locator('.signup-card')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    await expect(page.locator('main')).not.toContainText('cannot be shown');
    const button = rejectedCard(page, REJECTED.kept.name).getByRole('button', { name: 'Reopen' });
    expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(48);
    await button.click();
    await expect(page.getByRole('heading', { name: 'Reopen this sign-up?' })).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await page.getByRole('link', { name: 'Cancel' }).click();
    await expect(rejectedCard(page, REJECTED.kept.name)).toHaveCount(1);
    expect(await axe(page)).toEqual([]);
    await fits(page);
  });

  test('the seat without the approvers group whose token the API refuses is told to sign in again, not that the list is down', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'seat-refused');
    await page.goto(QUEUE);
    await expect(page.getByRole('main').getByRole('link', { name: 'Sign in again' })).toBeVisible();
    await expect(page.locator('main')).not.toContainText('cannot be shown');
    await expect(page.getByRole('heading', { name: 'Rejected sign-ups' })).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
  });

  test('cancelling the confirmation changes nothing; a stale reopening says so', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'approver');
    await page.goto(QUEUE);
    await rejectedCard(page, REJECTED.kept.name).getByRole('button', { name: 'Reopen' }).click();
    await expect(page.getByRole('heading', { name: 'Reopen this sign-up?' })).toBeVisible();
    await page.getByRole('link', { name: 'Cancel' }).click();
    await expect(page).toHaveURL(`${SITE_URL}${QUEUE}`);
    await expect(rejectedCard(page, REJECTED.kept.name)).toHaveCount(1);
    const res = await post(page, { decision: 'reopen', request: 'c1000000-0000-4000-8000-0000000000ff', confirmed: 'yes' });
    expect(res.status()).toBe(409);
    expect(await res.text()).toContain('Nothing was changed: this sign-up can no longer be reopened.');
  });
});

test.describe('REOPEN: a reopened person signs up again', () => {
  // The reopening is kept for everyone in the stand-in, as in the API, so the person's own sign-in
  // can see it; a retry would find it already reopened. Each browser project has its own person.
  test.describe.configure({ retries: 0 });

  test('after the Membership Officer reopens it, /account offers the form again, and the sign-up is sent', async ({ browser }, info) => {
    const login = ownPerson(info);
    const person = REJECTED[login];

    const own = await signedIn(browser, login);
    await own.goto(ACCOUNT);
    await expect(own.locator('.lead')).toHaveText('Your sign-up was not approved.');
    await expect(own.getByRole('button', { name: 'Send my sign-up' })).toHaveCount(0);

    const officer = await signedIn(browser, 'approver');
    await officer.goto(QUEUE);
    await rejectedCard(officer, person.name).getByRole('button', { name: 'Reopen' }).click();
    await expect(officer.getByRole('heading', { name: 'Reopen this sign-up?' })).toBeVisible();
    await expect(officer.locator('main')).toContainText(`${person.name} (${person.email})`);
    await expect(officer.locator('main')).toContainText('Nothing that was erased comes back');
    const yes = officer.getByRole('button', { name: 'Yes, reopen it' });
    expect((await yes.boundingBox())?.height).toBeGreaterThanOrEqual(48);
    expect(await axe(officer)).toEqual([]);
    await fits(officer);
    await yes.click();
    await expect(officer).toHaveURL(`${SITE_URL}${QUEUE}?done=reopened`);
    await expect(officer.getByRole('status')).toHaveText('Reopened. The person can now send the sign-up form again from their account page.');
    await expect(rejectedCard(officer, person.name)).toHaveCount(0);

    await own.goto(ACCOUNT);
    await expect(own.getByRole('button', { name: 'Send my sign-up' })).toBeVisible();
    await expect(own.locator('main')).not.toContainText('Your sign-up was not approved.');
    expect(await axe(own)).toEqual([]);
    await own.getByLabel('Last name').fill('Fakename');
    await own.getByLabel('Mensa membership number').fill(FAKE_NUMBER);
    await own.getByRole('button', { name: 'Send my sign-up' }).click();
    await expect(own.locator('.lead')).toHaveText('Your sign-up is waiting for an officer to approve it.');

    // A second reopening of the same sign-up is refused, in words.
    const again = await post(officer, { decision: 'reopen', request: REJECTED_IDS[login], confirmed: 'yes' });
    expect(again.status()).toBe(409);
    expect(await again.text()).toContain('Nothing was changed: this sign-up can no longer be reopened.');
  });
});
