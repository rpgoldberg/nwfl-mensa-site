// W-SIGNUP part 1, through the browser: the first stop after signing in, the sign-up
// form on /account (first name, prefilled from the sign-in's given name, last name and membership
// number, all required, for everyone, invited or not), a member's standing and (PROFILE-ID) profile,
// and the approvers' queue, with what each sign-up typed, in the officer area, with axe on each state; and the
// same sign-up and decisions with no script at all (the pages have none). The
// stand-in API keeps sign-ups and decisions per sign-in (e2e/api.mjs), so the two browsers' runs
// cannot disturb each other. Every number here is obviously fake.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { SITE_URL } from './servers';
import { openAccount, signIn, signOutButton } from './signin';
import { ALL_PAGES } from './pages';
import { ALL_NUMBERS, EARLIER_CLAIM, MEMBER_CHECKED_ON, MEMBER_PROFILE, SIGNUP_QUEUE, VET_CONFIRMS, VET_WARNINGS } from './stand-in';

const ACCOUNT = '/account';
const QUEUE = '/officer-area/sign-ups';
const FAKE_NUMBER = '000012345';
const WAITING = 'Your sign-up is waiting for an officer to approve it.';
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

const post = (page: Page, path: string, form: Record<string, string>, origin = SITE_URL) => page.request.post(`${SITE_URL}${path}`, { form, headers: { Origin: origin }, maxRedirects: 0 });

test.describe('the first sign-in (D3) and the sign-up (D1)', () => {
  test('a person with no account goes to /account first, whatever page they signed in from, and the form says what it is for', async ({ page }) => {
    await page.goto('/news');
    await signIn(page, 'newcomer');
    await expect(page).toHaveURL(`${SITE_URL}${ACCOUNT}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Your account' })).toBeVisible();
    await expect(page.locator('.lead')).toContainText('tell us your name and your Mensa membership number');
    // SIGNOUT (B): the verifier only as an external service, never how it checks.
    await expect(page.locator('.lead')).toContainText('An external membership verification service confirms them, then an officer approves your account.');
    await expect(page.locator('main')).not.toContainText(/membership list|roster/i);
    // PROFILE-ID: the first name, prefilled from the sign-in's given name, and editable.
    await expect(page.getByLabel('First name')).toHaveValue('Sky');
    await expect(page.getByLabel('First name')).toHaveAttribute('autocomplete', 'given-name');
    await expect(page.getByLabel('Last name')).toHaveAttribute('autocomplete', 'family-name');
    await expect(page.getByLabel('Mensa membership number')).toHaveAttribute('inputmode', 'numeric');
    // PROFILE-ID (the editor): one line by the number, read with it. With no SITE_ADMIN_CONTACT set (as here),
    // its link is the officers page, never an empty or a mailto link.
    const locked = 'Once you send it, your number can’t be changed. If it needs correcting, contact the site administrator.';
    await expect(page.locator('#membershipNumber-locked')).toHaveText(locked);
    await expect(page.getByRole('link', { name: 'site administrator' })).toHaveAttribute('href', '/officers');
    await expect(page.getByLabel('Mensa membership number')).toHaveAccessibleDescription(new RegExp(`${locked.replace(/[.?]/g, '\\$&')}$`));
    await expect(page.locator('main')).not.toContainText(/erase|never shown|not kept/i);
    expect(await axe(page)).toEqual([]);
    await fits(page);
  });

  test('every field is required, each problem is said by its field, and the number is never given back', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'newcomer');
    await page.getByLabel('First name').fill('');
    await page.getByRole('button', { name: 'Send my sign-up' }).click();
    await expect(page.getByText('Problem: Enter your first name.')).toBeVisible();
    await expect(page.getByLabel('First name')).toHaveAttribute('aria-invalid', 'true');
    await page.getByLabel('First name').fill('Sky');
    await page.getByRole('button', { name: 'Send my sign-up' }).click();
    await expect(page.getByText('Problem: Enter your last name.')).toBeVisible();
    await expect(page.getByText('Problem: Enter your membership number.')).toBeVisible();
    await expect(page.getByLabel('Last name')).toHaveAttribute('aria-invalid', 'true');
    expect(await axe(page)).toEqual([]);

    await page.getByLabel('Last name').fill('Fakename');
    await page.getByLabel('Mensa membership number').fill(`${FAKE_NUMBER}x`);
    await page.getByRole('button', { name: 'Send my sign-up' }).click();
    await expect(page.getByText('Problem: Enter your membership number using digits only, up to 12 of them.')).toBeVisible();
    await expect(page.getByLabel('Last name')).toHaveValue('Fakename');
    await expect(page.getByLabel('Mensa membership number')).toHaveValue('');
    expect(await page.content()).not.toContain(FAKE_NUMBER);
  });

  test('a sign-up with both fields is sent, and the page then says it waits for an officer', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'newcomer');
    await page.getByLabel('Last name').fill('Fakename');
    await page.getByLabel('Mensa membership number').fill(FAKE_NUMBER);
    await page.getByRole('button', { name: 'Send my sign-up' }).click();
    await expect(page).toHaveURL(`${SITE_URL}${ACCOUNT}?sent=1`);
    await expect(page.getByRole('status')).toHaveText('Thank you. Your sign-up has been sent.');
    await expect(page.locator('.lead')).toHaveText(WAITING);
    await expect(page.getByRole('button', { name: 'Send my sign-up' })).toHaveCount(0);
    expect(await page.content()).not.toContain(FAKE_NUMBER);
    expect(await axe(page)).toEqual([]);
    // Pending now, so the rest of the site is theirs to read, unredirected.
    await page.goto('/news');
    await expect(page).toHaveURL(`${SITE_URL}/news`);
  });

  test('VET fix 1: a number typed with spaces and dashes is taken as its digits, and never given back', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'newcomer');
    await expect(page.getByText('Up to 12 digits; spaces or dashes between them are fine.')).toBeVisible();
    await page.getByLabel('Last name').fill('Fakename');
    // The stand-in API, like the real one, takes digits only: the site sends just those.
    await page.getByLabel('Mensa membership number').fill('000-012 345');
    await page.getByRole('button', { name: 'Send my sign-up' }).click();
    await expect(page).toHaveURL(`${SITE_URL}${ACCOUNT}?sent=1`);
    await expect(page.locator('.lead')).toHaveText(WAITING);
    expect(await page.content()).not.toMatch(/000-012|012 345|000012345/);
  });

  test('VET fix 1: a letter among the dashes is still refused, in the same words, and the number is not given back', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'newcomer');
    await page.getByLabel('Last name').fill('Fakename');
    await page.getByLabel('Mensa membership number').fill('000-O12-345');
    await page.getByRole('button', { name: 'Send my sign-up' }).click();
    await expect(page.getByText('Problem: Enter your membership number using digits only, up to 12 of them.')).toBeVisible();
    await expect(page.getByLabel('Mensa membership number')).toHaveValue('');
    expect(await page.content()).not.toMatch(/O12|000-/);
    expect(await axe(page)).toEqual([]);
  });

  test('an invited person gives their number too (D2), and then waits the same way', async ({ page }) => {
    await page.goto('/about');
    await signIn(page, 'invitee');
    await expect(page).toHaveURL(`${SITE_URL}${ACCOUNT}`);
    await page.getByLabel('First name').fill('Taylor');
    await page.getByLabel('Last name').fill('Fakename');
    await page.getByRole('button', { name: 'Send my sign-up' }).click();
    await expect(page.getByText('Problem: Enter your membership number.')).toBeVisible();
    await page.getByLabel('Mensa membership number').fill(FAKE_NUMBER);
    await page.getByRole('button', { name: 'Send my sign-up' }).click();
    await expect(page.locator('.lead')).toHaveText(WAITING);
  });

  test('a member goes back where they were, and /account shows their standing and the day it was checked', async ({ page }) => {
    await page.goto('/about');
    await signIn(page, 'member');
    await expect(page).toHaveURL(`${SITE_URL}/about`);
    await page.goto(ACCOUNT);
    await expect(page.locator('.lead')).toHaveText('Your account has member access.');
    await expect(page.getByText(`It was last confirmed on ${MEMBER_CHECKED_ON}.`)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send my sign-up' })).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
  });

  test('a pending enrolee goes back where they were, and /account says their sign-up waits', async ({ page }) => {
    await page.goto('/events');
    await signIn(page, 'enrolee-pending');
    await expect(page).toHaveURL(`${SITE_URL}/events`);
    await page.goto(ACCOUNT);
    await expect(page.locator('.lead')).toHaveText(WAITING);
  });

  test('an account that is not the group\'s gets a plain line, no form, and a sign-up it posts is refused', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'pending');
    await page.goto(ACCOUNT);
    await expect(page.locator('.lead')).toHaveText('This sign-in is not one of the group’s accounts, so there is nothing to sign up for here.');
    await expect(page.getByRole('button', { name: 'Send my sign-up' })).toHaveCount(0);
    expect((await post(page, ACCOUNT, { lastName: 'Fakename', membershipNumber: FAKE_NUMBER })).status()).toBe(403);
  });

  test('signed out, /account sends to sign in and back; a cross-site or non-form post is refused', async ({ page }) => {
    const res = await page.request.get(`${SITE_URL}${ACCOUNT}`, { maxRedirects: 0 });
    expect(res.status()).toBe(303);
    expect(res.headers()['location']).toBe('/sign-in?return=%2Faccount');
    // Fix 1 (NOTE-7): the redirect itself is never stored by a shared cache.
    expect(res.headers()['cache-control']).toBe('private, no-store');
    await page.goto('/');
    await signIn(page, 'newcomer');
    expect((await post(page, ACCOUNT, { lastName: 'Fakename', membershipNumber: FAKE_NUMBER }, 'https://evil.example.org')).status()).toBe(403);
    const json = await page.request.post(`${SITE_URL}${ACCOUNT}`, { data: { lastName: 'Fakename' }, headers: { Origin: SITE_URL }, maxRedirects: 0 });
    expect(json.status()).toBe(415);
    const fresh = await page.request.get(`${SITE_URL}${ACCOUNT}`);
    expect(fresh.headers()['cache-control']).toBe('private, no-store');
    expect(fresh.headers()['vary']).toContain('Cookie');
  });
});

test.describe('the approvers\' queue (D4)', () => {
  test('an approver finds it in the officer area and sees each sign-up in words, with what it typed (PROFILE-ID)', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'approver');
    await page.goto('/officer-area');
    await page.getByRole('link', { name: 'Sign-ups to approve' }).click();
    await expect(page).toHaveURL(`${SITE_URL}${QUEUE}`);
    const cards = page.locator('.signup-card');
    await expect(cards).toHaveCount(SIGNUP_QUEUE.length);
    for (const [i, s] of SIGNUP_QUEUE.entries()) {
      const card = cards.nth(i);
      await expect(card.getByRole('heading', { level: 2 })).toHaveText(s.name);
      await expect(card).toContainText(s.email);
      await expect(card).toContainText(s.route);
      await expect(card).toContainText(s.check);
      for (const [label, value] of [['First name', s.first], ['Last name', s.last], ['Membership number', s.number]] as const) {
        await expect(card.locator('dl.facts').first().locator('div').filter({ has: page.getByText(label, { exact: true }) }).locator('dd')).toHaveText(value);
      }
    }
    await expect(page.locator('.lead')).toHaveText('People who signed up and are waiting for member access. Approve a sign-up to give the account member access, or reject it.');
    await expect(page.locator('main')).not.toContainText(/erase|never shown/i);
    // Found in another local group: no Approve, only Reject, and words saying why.
    const other = cards.filter({ hasText: 'Harper Placeholder' });
    await expect(other.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    await expect(other.getByRole('button', { name: 'Reject' })).toHaveCount(1);
    await expect(other).toContainText('cannot be approved as a member here');
    expect(await axe(page)).toEqual([]);
    await fits(page);
  });

  test('PROFILE-ID: a duplicate claim shows what the earlier claim typed beside its own; a claim since closed shows none', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'approver');
    await page.goto(QUEUE);
    const cardOf = (name: string) => page.locator('.signup-card').filter({ has: page.getByRole('heading', { level: 2, name, exact: true }) });
    const earlier = EARLIER_CLAIM['Drew Secondclaim'];
    const section = cardOf('Drew Secondclaim').getByRole('region', { name: `The earlier claim (${earlier.name})` });
    for (const [label, value] of [['First name', earlier.first], ['Last name', earlier.last], ['Membership number', earlier.number]] as const) {
      await expect(section.locator('div').filter({ has: page.getByText(label, { exact: true }) }).locator('dd')).toHaveText(value);
    }
    await expect(cardOf('Eli Thirdclaim').locator('.earlier-claim')).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
    await fits(page);
  });

  test('VET: an email mismatch and a duplicate claim each say in words what to do before approving, and the Approve button says it too', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'approver');
    await page.goto(QUEUE);
    // By the card's own heading, so a warning naming another person never picks the wrong card.
    const cardOf = (name: string) => page.locator('.signup-card').filter({ has: page.getByRole('heading', { level: 2, name, exact: true }) });
    for (const [name, warning] of Object.entries(VET_WARNINGS)) {
      const card = cardOf(name);
      const note = card.getByRole('note');
      await expect(note).toHaveText(`Before approving: ${warning}`);
      await expect(card.getByRole('button', { name: 'Approve' })).toHaveAccessibleDescription(`${name} Before approving: ${warning}`);
      await expect(card.getByRole('button', { name: 'Reject' })).toHaveCount(1);
      // Fix 1: a box to tick first, by its own label, worded for the outcome, described by the warning.
      const box = card.getByRole('checkbox', { name: VET_CONFIRMS[name as keyof typeof VET_CONFIRMS], exact: true });
      await expect(box).not.toBeChecked();
      await expect(box).toHaveAttribute('required', '');
      await expect(box).toHaveAccessibleDescription(`Before approving: ${warning}`);
    }
    // No warning and no box on the others: a local match, not found, another group, not checked.
    for (const s of SIGNUP_QUEUE.filter((q) => !(q.name in VET_WARNINGS))) {
      await expect(cardOf(s.name).getByRole('note')).toHaveCount(0);
      await expect(cardOf(s.name).getByRole('checkbox')).toHaveCount(0);
    }
    expect(await axe(page)).toEqual([]);
    await fits(page);
  });

  test('VET fix 1: a warning outcome is approved only with its box ticked, by the browser and by the API, and says so', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'approver');
    await page.goto(QUEUE);
    const cardOf = (name: string) => page.locator('.signup-card').filter({ has: page.getByRole('heading', { level: 2, name, exact: true }) });
    // Unticked, the browser keeps the form: nothing is sent.
    const dana = cardOf('Dana Mismatch');
    await dana.getByRole('button', { name: 'Approve' }).click();
    await expect(page).toHaveURL(`${SITE_URL}${QUEUE}`);
    await expect(page.getByRole('status')).toHaveCount(0);
    expect(await dana.getByRole('checkbox').evaluate((box: HTMLInputElement) => box.validity.valueMissing)).toBe(true);
    // Ticked, by its label, it is approved.
    await dana.getByText(VET_CONFIRMS['Dana Mismatch']).click();
    await expect(dana.getByRole('checkbox')).toBeChecked();
    await dana.getByRole('button', { name: 'Approve' }).click();
    await expect(page).toHaveURL(`${SITE_URL}${QUEUE}?done=approved`);
    await expect(cardOf('Dana Mismatch')).toHaveCount(0);
    // A post without the box (no browser check at all) is refused by the API, and the page says why.
    const drew = 'b1000000-0000-4000-8000-000000000006';
    const refused = await post(page, QUEUE, { decision: 'approve', request: drew });
    expect(refused.status()).toBe(409);
    expect(await refused.text()).toContain('Nothing was changed: tick the box by the warning to say you confirmed it, then approve.');
    await page.goto(QUEUE);
    await expect(cardOf('Drew Secondclaim')).toHaveCount(1);
    const done = await post(page, QUEUE, { decision: 'approve', request: drew, confirmed: 'yes' });
    expect(done.status()).toBe(303);
    expect(done.headers()['location']).toBe(`${QUEUE}?done=approved`);
    await page.goto(QUEUE);
    await expect(cardOf('Drew Secondclaim')).toHaveCount(0);
    // The other outcomes are approved as before, one press, no box.
    await cardOf('Kendall Sample').getByRole('button', { name: 'Approve' }).click();
    await expect(page).toHaveURL(`${SITE_URL}${QUEUE}?done=approved`);
    expect(await axe(page)).toEqual([]);
  });

  test('approving takes one press; rejecting asks first; neither can be done to one\'s own sign-up', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'approver');
    await page.goto(QUEUE);
    const card = (name: string) => page.locator('.signup-card').filter({ hasText: name });

    await card('Kendall Sample').getByRole('button', { name: 'Approve' }).click();
    await expect(page).toHaveURL(`${SITE_URL}${QUEUE}?done=approved`);
    await expect(page.getByRole('status')).toHaveText('Approved. The account now has member access.');
    await expect(card('Kendall Sample')).toHaveCount(0);

    await card('Jesse Example').getByRole('button', { name: 'Reject' }).click();
    await expect(page.getByRole('heading', { name: 'Reject this sign-up?' })).toBeVisible();
    await expect(page.getByText('A rejected sign-up is removed from the queue. Only the Admin or the Membership Officer can reopen it, so the person can sign up again.')).toBeVisible();
    expect(await axe(page)).toEqual([]);
    await page.getByRole('button', { name: 'Yes, reject it' }).click();
    await expect(page).toHaveURL(`${SITE_URL}${QUEUE}?done=rejected`);
    await expect(card('Jesse Example')).toHaveCount(0);

    await card('Blair Example').getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByRole('alert')).toHaveText('Nothing was changed: no one approves or rejects their own sign-up.');
    await expect(card('Blair Example')).toHaveCount(1);
  });

  test('a stale or forged decision changes nothing and says so', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'approver');
    await page.goto(QUEUE);
    const res = await post(page, QUEUE, { decision: 'approve', request: 'b1000000-0000-4000-8000-000000000003' });
    expect(res.status()).toBe(409);
    expect(await res.text()).toContain('Nothing was changed: this sign-up was already decided, or it cannot be approved as a member.');
    expect((await post(page, QUEUE, { decision: 'grant', request: 'b1000000-0000-4000-8000-000000000002' })).status()).toBe(400);
    expect((await post(page, QUEUE, { decision: 'approve', request: 'b1000000-0000-4000-8000-000000000002' }, 'https://evil.example.org')).status()).toBe(403);
  });

  test('the Admin has it too', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'admin');
    await page.goto('/officer-area');
    await expect(page.getByRole('link', { name: 'Sign-ups to approve' })).toBeVisible();
    await page.goto(QUEUE);
    await expect(page.locator('.signup-card')).toHaveCount(SIGNUP_QUEUE.length);
  });

  for (const login of ['officer', 'member', 'webmaster'] as const) {
    test(`it is not found for ${login}, and never linked`, async ({ page }) => {
      await page.goto('/');
      await signIn(page, login);
      const res = await page.goto(QUEUE);
      expect(res?.status()).toBe(404);
      expect(await page.content()).not.toContain('Jesse Example');
      if (login !== 'member') {
        await page.goto('/officer-area');
        await expect(page.getByRole('link', { name: 'Sign-ups to approve' })).toHaveCount(0);
      }
    });
  }

  test('signed out, it sends to sign in and back', async ({ page }) => {
    const res = await page.request.get(`${SITE_URL}${QUEUE}`, { maxRedirects: 0 });
    expect(res.status()).toBe(303);
    expect(res.headers()['location']).toBe('/sign-in?return=%2Fofficer-area%2Fsign-ups');
    expect(res.headers()['cache-control']).toBe('private, no-store');
  });
});

test.describe('fix 1: a rejected sign-up (SHOULD-1)', () => {
  test('goes back where they were, and /account says plainly it was not approved and whom to contact, never that it waits', async ({ page }) => {
    await page.goto('/events');
    await signIn(page, 'turned-down');
    await expect(page).toHaveURL(`${SITE_URL}/events`);
    await page.goto(ACCOUNT);
    await expect(page.locator('.lead')).toHaveText('Your sign-up was not approved.');
    await expect(page.locator('main')).toContainText("If you think this is a mistake, please contact the club's Membership Officer.");
    await expect(page.getByRole('link', { name: 'Membership Officer' })).toHaveAttribute('href', '/officers');
    await expect(page.locator('main')).not.toContainText(WAITING);
    await expect(page.getByRole('button', { name: 'Send my sign-up' })).toHaveCount(0);
    expect(await axe(page)).toEqual([]);
    await fits(page);
  });

  test('cannot sign up again: a posted sign-up gets the on-file answer', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'turned-down');
    const res = await post(page, ACCOUNT, { firstName: 'Morgan', lastName: 'Fakename', membershipNumber: FAKE_NUMBER });
    expect(res.status()).toBe(409);
    expect(await res.text()).toContain('A sign-up is already on file for this account.');
  });
});

test.describe('fix 1: officers and the Admin need no member account (SHOULD-2, NOTE-8)', () => {
  for (const login of ['officer', 'approver', 'admin', 'lone-admin', 'officer-only'] as const) {
    test(`${login} goes back where they were after signing in, and /account says the officer area needs no account, with no form`, async ({ page }) => {
      await page.goto('/about');
      await signIn(page, login);
      await expect(page).toHaveURL(`${SITE_URL}/about`);
      await page.goto(ACCOUNT);
      await expect(page.locator('.lead')).toHaveText('You need no member account to use the officer area.');
      await expect(page.getByRole('link', { name: 'Go to the officer area' })).toHaveAttribute('href', '/officer-area');
      await expect(page.getByRole('button', { name: 'Send my sign-up' })).toHaveCount(0);
      await expect(page.locator('main')).not.toContainText('not one of the group');
      expect(await axe(page)).toEqual([]);
    });
  }

  test('one of the group\'s enrolees with no account, not an officer, is stopped at /account after each sign-in until they sign up', async ({ page }) => {
    for (let round = 0; round < 2; round += 1) {
      await page.goto('/news');
      await signIn(page, 'newcomer');
      await expect(page).toHaveURL(`${SITE_URL}${ACCOUNT}`);
      await (await signOutButton(page)).click();
      await page.getByRole('button', { name: 'Yes, sign me out' }).click();
      await expect(page).toHaveURL(/\/signed-out$/);
    }
    // A membership approver who is no officer signs up like anyone else.
    await page.goto('/news');
    await signIn(page, 'lone-approver');
    await expect(page).toHaveURL(`${SITE_URL}${ACCOUNT}`);
  });
});

test.describe('fix 1: the officer area admits each role, with only its own links', () => {
  const links = (page: Page) => page.locator('main .link-list a');
  // EDITOR E3: "Write news" for everyone the editor admits (an officer, the Admin, the Webmaster).
  // EDITOR E6: "Our events" for whom the events pages admit (an officer or the Admin): not a lone Webmaster.
  const cases = [
    { login: 'lone-approver', links: ['Sign-ups to approve'] },
    { login: 'lone-webmaster', links: ['Write news'] },
    { login: 'lone-admin', links: ['Write news', 'Our events', 'Sign-ups to approve', 'Approval setting'] },
    { login: 'admin', links: ['Write news', 'Our events', 'Sign-ups to approve', 'Approval setting'] },
    { login: 'approver', links: ['Write news', 'Our events', 'Sign-ups to approve'] },
    { login: 'officer', links: ['Write news', 'Our events'] },
    { login: 'webmaster', links: ['Write news', 'Our events'] },
  ] as const;
  for (const c of cases) {
    test(`${c.login}: let in, linked from the header, and shown ${c.links.join(' and ')}`, async ({ page }) => {
      await page.goto('/');
      await signIn(page, c.login);
      await (await openAccount(page)).getByRole('link', { name: 'Officer area' }).click();
      await expect(page).toHaveURL(`${SITE_URL}/officer-area`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.locator('.lead')).toContainText('Welcome,');
      await expect(links(page)).toHaveText([...c.links]);
      expect(await axe(page)).toEqual([]);
    });
  }

  test('the lone approver reaches the queue from it', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'lone-approver');
    await page.goto('/officer-area');
    await page.getByRole('link', { name: 'Sign-ups to approve' }).click();
    await expect(page.locator('.signup-card')).toHaveCount(SIGNUP_QUEUE.length);
  });

  for (const login of ['member', 'enrolee', 'invitee', 'pending'] as const) {
    test(`${login}: 403, and no header link`, async ({ page }) => {
      await page.goto('/');
      await signIn(page, login);
      await expect(page.getByRole('banner').locator('a[href="/officer-area"]')).toHaveCount(0);
      const res = await page.goto('/officer-area');
      expect(res?.status()).toBe(403);
      await expect(page.locator('main .link-list')).toHaveCount(0);
    });
  }
});

test.describe('fix 1: Your account in the header (the group\'s enrolees)', () => {
  test('a member finds it on every page, a 48px target, and it opens their account', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'member');
    for (const path of ['/', '/about', '/news']) {
      await page.goto(path);
      const link = (await openAccount(page)).getByRole('link', { name: 'Your account' });
      await expect(link).toBeVisible();
      const box = (await link.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(48);
      await fits(page);
    }
    await (await openAccount(page)).getByRole('link', { name: 'Your account' }).click();
    await expect(page).toHaveURL(`${SITE_URL}${ACCOUNT}`);
    await expect(page.locator('.lead')).toHaveText('Your account has member access.');
  });

  test('is not there signed out, nor for a sign-in that is not one of the group\'s', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('banner').locator('a[href="/account"]')).toHaveCount(0);
    await signIn(page, 'lone-admin');
    await expect(page.getByRole('banner').locator('a[href="/account"]')).toHaveCount(0);
  });
});

test.describe('fix 1: a form with problems opens with a summary that takes focus (NOTE-6)', () => {
  test('the summary is at the top, has focus, links to each field, and a link puts the cursor in its field', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'newcomer');
    await page.getByRole('button', { name: 'Send my sign-up' }).click();
    const summary = page.locator('[data-error-summary]');
    await expect(summary).toBeFocused();
    await expect(summary.getByRole('heading', { level: 2 })).toHaveText('There is a problem with your sign-up');
    await expect(summary.getByRole('link')).toHaveText(['Enter your last name.', 'Enter your membership number.']);
    await expect(summary.getByRole('link').nth(0)).toHaveAttribute('href', '#lastName');
    await expect(summary.getByRole('link').nth(1)).toHaveAttribute('href', '#membershipNumber');
    // Above the form: the first thing in the page after the heading.
    expect(await page.evaluate(() => document.querySelector('[data-error-summary]')!.compareDocumentPosition(document.querySelector('form.rule-form')!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBeTruthy();
    expect(await axe(page)).toEqual([]);
    await summary.getByRole('link', { name: 'Enter your membership number.' }).click();
    await expect(page.getByLabel('Mensa membership number')).toBeFocused();
    await fits(page);
  });

  test('one problem, one entry; no summary on a page with none', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'newcomer');
    await expect(page.locator('[data-error-summary]')).toHaveCount(0);
    await page.getByLabel('Mensa membership number').fill(FAKE_NUMBER);
    await page.getByRole('button', { name: 'Send my sign-up' }).click();
    await expect(page.locator('[data-error-summary]').getByRole('link')).toHaveText(['Enter your last name.']);
    expect(await page.content()).not.toContain(FAKE_NUMBER);
  });
});

test.describe('with no script at all', () => {
  test.use({ javaScriptEnabled: false });

  test('a form with problems still opens with its summary, each problem a link to its field', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'newcomer');
    await page.getByRole('button', { name: 'Send my sign-up' }).click();
    await expect(page.locator('[data-error-summary]').getByRole('link')).toHaveText(['Enter your last name.', 'Enter your membership number.']);
  });

  test('a newcomer signs up by a plain form post', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'newcomer');
    await expect(page).toHaveURL(`${SITE_URL}${ACCOUNT}`);
    await page.getByLabel('Last name').fill('Fakename');
    await page.getByLabel('Mensa membership number').fill(FAKE_NUMBER);
    await page.getByRole('button', { name: 'Send my sign-up' }).click();
    await expect(page.locator('.lead')).toHaveText(WAITING);
  });

  test('an approver approves and rejects by plain form posts', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'approver');
    await page.goto(QUEUE);
    const card = (name: string) => page.locator('.signup-card').filter({ hasText: name });
    await card('Jesse Example').getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByRole('status')).toHaveText('Approved. The account now has member access.');
    await card('Kendall Sample').getByRole('button', { name: 'Reject' }).click();
    await page.getByRole('button', { name: 'Yes, reject it' }).click();
    await expect(page.getByRole('status')).toHaveText('Rejected. The sign-up has been removed from the queue.');
    await expect(page.locator('.signup-card')).toHaveCount(SIGNUP_QUEUE.length - 2);
  });
});

// PROFILE-ID: an approved member's profile on /account: the two names, labelled, with a Save button of
// 48 px, and the membership number shown as text, never as a field, with no explanation.
test.describe('the member\'s profile (PROFILE-ID)', () => {
  const numberShown = (page: Page) => page.locator('dl.facts div').filter({ has: page.getByText('Membership number', { exact: true }) }).locator('dd');

  test('shows the names to change and the number to read, and saves new names', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'member');
    await page.goto(ACCOUNT);
    const profile = page.getByRole('region', { name: 'Your profile' });
    await expect(profile.getByLabel('First name')).toHaveValue(MEMBER_PROFILE.first);
    await expect(profile.getByLabel('Last name')).toHaveValue(MEMBER_PROFILE.last);
    await expect(numberShown(page)).toHaveText(MEMBER_PROFILE.number);
    // Read-only: no field anywhere holds it or takes it.
    await expect(page.locator(`input[value="${MEMBER_PROFILE.number}"], input[name="membershipNumber"]`)).toHaveCount(0);
    await expect(profile).not.toContainText(/erase|can’t be changed|cannot be changed|visible|approver/i);
    const save = profile.getByRole('button', { name: 'Save' });
    const box = await save.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(48);
    expect(await axe(page)).toEqual([]);
    await fits(page);

    await profile.getByLabel('First name').fill('Jordana');
    await profile.getByLabel('Last name').fill('Example-Smith');
    await save.click();
    await expect(page).toHaveURL(`${SITE_URL}${ACCOUNT}?saved=1`);
    await expect(page.getByRole('status')).toHaveText('Your profile has been saved.');
    await expect(page.getByRole('region', { name: 'Your profile' }).getByLabel('First name')).toHaveValue('Jordana');
    await expect(page.getByRole('region', { name: 'Your profile' }).getByLabel('Last name')).toHaveValue('Example-Smith');
    await expect(numberShown(page)).toHaveText(MEMBER_PROFILE.number);
  });

  test('says each problem by its field, and a number posted with the names changes nothing', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'member');
    await page.goto(ACCOUNT);
    const profile = page.getByRole('region', { name: 'Your profile' });
    await profile.getByLabel('First name').fill('');
    await profile.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('[data-error-summary]').getByRole('link')).toHaveText(['Enter your first name.']);
    await expect(page.locator('[data-error-summary]').getByRole('link')).toHaveAttribute('href', '#profile-firstName');
    await expect(profile.getByLabel('First name')).toHaveAttribute('aria-invalid', 'true');
    expect(await axe(page)).toEqual([]);
    const forged = await post(page, ACCOUNT, { form: 'profile', firstName: 'Jordan', lastName: 'Example', membershipNumber: '999999999' });
    expect(forged.status()).toBe(303);
    await page.goto(ACCOUNT);
    await expect(numberShown(page)).toHaveText(MEMBER_PROFILE.number);
    expect(await page.content()).not.toContain('999999999');
  });

  test('a member with no profile gets no profile section, and a change they post is refused in words', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'mixed');
    await page.goto(ACCOUNT);
    await expect(page.locator('.lead')).toHaveText('Your account has member access.');
    await expect(page.getByRole('region', { name: 'Your profile' })).toHaveCount(0);
    const res = await post(page, ACCOUNT, { form: 'profile', firstName: 'Ellis', lastName: 'Example' });
    expect(res.status()).toBe(409);
    expect(await res.text()).toContain('Your profile can only be changed once your account has member access.');
  });
});

// PROFILE-ID, item 8: a number is shown only to its owner (/account) and to the approvers and the Admin
// (the queue). Another member walks every page they can read and finds none.
test.describe('no membership number for another member (PROFILE-ID)', () => {
  test('walks every member-facing page, and /account, as another member and finds no number', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'mixed');
    for (const path of [...ALL_PAGES, ACCOUNT]) {
      await page.goto(path);
      const html = await page.content();
      for (const number of ALL_NUMBERS) expect(html, `${path} shows ${number}`).not.toContain(number);
    }
    expect((await page.goto(QUEUE))?.status()).toBe(404);
  });

  test('the owner sees their own number on /account alone', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'member');
    for (const path of ALL_PAGES) {
      await page.goto(path);
      expect(await page.content(), path).not.toContain(MEMBER_PROFILE.number);
    }
    await page.goto(ACCOUNT);
    expect(await page.content()).toContain(MEMBER_PROFILE.number);
  });
});

test.describe('the profile with no script at all', () => {
  test.use({ javaScriptEnabled: false });

  test('a member saves new names by a plain form post', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'member');
    await page.goto(ACCOUNT);
    const profile = page.getByRole('region', { name: 'Your profile' });
    await profile.getByLabel('Last name').fill('Examplesson');
    await profile.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status')).toHaveText('Your profile has been saved.');
    await expect(page.getByRole('region', { name: 'Your profile' }).getByLabel('Last name')).toHaveValue('Examplesson');
  });
});
