// PROFILE-ERASE, through the browser: the Admin's member records in the officer area. Each decided
// sign-up is a card with real buttons (48 px); erasing asks first, on a step that names everything
// that will be erased; a number is corrected through a labelled form, with one of three labelled reasons
// (fix 1: no free text), and a step that shows the change.
// Only the Admin has the page or its link. Every step works from the keyboard alone, on a 412 px
// phone, at the largest text size and at 200 % text, with nothing to scroll sideways. Axe on each state.
// Every person and address here is made up.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { SIZES } from '../server/prefs.mjs';
import { setPrefs } from './prefs';
import { SITE_URL } from './servers';
import { signIn } from './signin';
import { RECORDS, SIGNUP_QUEUE } from './stand-in';

const HERE = '/officer-area/member-records';
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'wcag2aaa', 'best-practice'];
/** A correction's reason as the form posts it (its code), and the words the Admin reads for it. */
const REASON = 'card_differs';
const REASON_WORDS = 'The member’s card shows a different number';
const CHOICES = ['Typed wrong at sign-up', 'The member’s card shows a different number', 'Mensa issued a new number'] as const;
const NEW_NUMBER = '000044009';

async function axe(page: Page): Promise<string[]> {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

/** Phone parity: nothing wider than the screen. */
async function fits(page: Page): Promise<void> {
  // On a failure, the elements that reach past the screen's edge are named.
  const wide = await page.evaluate(() => {
    const edge = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth <= edge) return [];
    return [...document.querySelectorAll('body *')]
      .filter((el) => el.getBoundingClientRect().right > edge + 0.5)
      .map((el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${typeof el.className === 'string' && el.className ? `.${el.className.replace(/\s+/g, '.')}` : ''} ${Math.round(el.getBoundingClientRect().right)}>${edge}`);
  });
  expect(wide).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}

const post = (page: Page, form: Record<string, string>) => page.request.post(`${SITE_URL}${HERE}`, { form, headers: { Origin: SITE_URL }, maxRedirects: 0 });
const card = (page: Page, name: string) => page.locator('.record-card').filter({ hasText: name });
const fact = (within: Locator, label: string) => within.locator('div').filter({ has: within.page().getByText(label, { exact: true }) }).locator('dd');

async function asAdmin(page: Page): Promise<void> {
  await page.goto('/');
  await signIn(page, 'admin');
  await page.goto(HERE);
}

/** Reaches a control with the Tab key alone, from wherever the focus is, and checks its focus shows. */
async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((el) => el === document.activeElement)) {
      expect(await target.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe('none');
      return;
    }
  }
  throw new Error('the Tab key never reached the control');
}

test.describe('PROFILE-ERASE: who has the member records', () => {
  test('sends anyone not signed in to sign in first', async ({ page }) => {
    const res = await page.request.get(`${SITE_URL}${HERE}`, { maxRedirects: 0 });
    expect(res.status()).toBe(303);
    expect(res.headers()['location']).toBe('/sign-in?return=%2Fofficer-area%2Fmember-records');
  });

  for (const login of ['approver', 'webmaster', 'officer', 'member'] as const) {
    test(`gives the ${login} the plain not-found page, on a visit and on a post, and no link to it`, async ({ page }) => {
      await page.goto('/');
      await signIn(page, login);
      const res = await page.goto(HERE);
      expect(res?.status()).toBe(404);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found');
      const html = await page.content();
      for (const text of [RECORDS.member.name, RECORDS.member.number, RECORDS.rejected.email, 'Erase this record']) expect(html).not.toContain(text);
      expect((await post(page, { action: 'erase', request: RECORDS.rejected.id, confirmed: 'yes' })).status()).toBe(404);
      expect((await post(page, { action: 'correct', step: 'apply', request: RECORDS.member.id, membershipNumber: NEW_NUMBER, reason: REASON })).status()).toBe(404);
      if (login !== 'member') {
        await page.goto('/officer-area');
        await expect(page.getByRole('link', { name: 'Member records' })).toHaveCount(0);
      }
    });
  }

  test('the Admin finds it from the officer area', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'admin');
    await page.goto('/officer-area');
    await page.getByRole('link', { name: 'Member records' }).click();
    await expect(page).toHaveURL(`${SITE_URL}${HERE}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Member records');
    await expect(page).toHaveTitle(/^Member records \| /);
    expect((await page.request.get(`${SITE_URL}${HERE}`)).headers()['cache-control']).toBe('private, no-store');
  });
});

test.describe('PROFILE-ERASE: the records, as the Admin reads them', () => {
  test('each record is a card in words: who, what they typed if still held, the decision and its day, the account; never the Admin\'s own', async ({ page }) => {
    await asAdmin(page);
    await expect(page.locator('.record-card')).toHaveCount(4);
    for (const record of [RECORDS.member, RECORDS.rejected, RECORDS.reopened]) {
      const c = card(page, record.name);
      await expect(c.getByRole('heading', { level: 2 })).toHaveText(record.name);
      await expect(c).toContainText(record.email);
      await expect(fact(c, 'First name')).toHaveText(record.first);
      await expect(fact(c, 'Last name')).toHaveText(record.last);
      await expect(fact(c, 'Membership number')).toHaveText(record.number);
      await expect(fact(c, 'Decision')).toHaveText(record.decision);
      await expect(fact(c, 'Account')).toHaveText(record.account);
    }
    // A removed member: the removal erased the profile, so there is none to show.
    const removed = card(page, RECORDS.removed.name);
    await expect(removed.locator('dt')).toHaveText(['Decision', 'Account']);
    await expect(fact(removed, 'Account')).toHaveText('Removed');
    expect(await page.content()).not.toContain(RECORDS.ownNumber);
    expect(await axe(page)).toEqual([]);
    await fits(page);
  });

  test('every record has an Erase button of 48 px named by its person; only an approved member has Correct the number', async ({ page }) => {
    await asAdmin(page);
    for (const record of [RECORDS.member, RECORDS.removed, RECORDS.rejected, RECORDS.reopened]) {
      const button = card(page, record.name).getByRole('button', { name: 'Erase this record' });
      const box = await button.boundingBox();
      expect(box?.height, record.name).toBeGreaterThanOrEqual(48);
      await expect(button).toHaveAccessibleDescription(record.name);
    }
    const correct = card(page, RECORDS.member.name).getByRole('link', { name: 'Correct the number' });
    expect((await correct.boundingBox())?.height).toBeGreaterThanOrEqual(48);
    await expect(correct).toHaveAccessibleDescription(RECORDS.member.name);
    await expect(page.getByRole('link', { name: 'Correct the number' })).toHaveCount(1);
  });
});

test.describe('PROFILE-ERASE: erasing a record', () => {
  test('asks first, naming everything that will be erased; Cancel changes nothing', async ({ page }) => {
    await asAdmin(page);
    await card(page, RECORDS.member.name).getByRole('button', { name: 'Erase this record' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Erase this record?' })).toBeVisible();
    const main = page.locator('main');
    await expect(main).toContainText(`${RECORDS.member.name} (${RECORDS.member.email}).`);
    await expect(page.getByRole('list', { name: 'This will be erased:' }).getByRole('listitem')).toHaveText([
      `The name and email address from their sign-in: ${RECORDS.member.name}, ${RECORDS.member.email}.`,
      `Their first name and last name: ${RECORDS.member.first} ${RECORDS.member.last}.`,
      `Their membership number: ${RECORDS.member.number}.`,
    ]);
    await expect(main).toContainText('This cannot be undone. Only the date and the decision are kept. Their member access ends as well.');
    expect((await page.getByRole('button', { name: 'Yes, erase it' }).boundingBox())?.height).toBeGreaterThanOrEqual(48);
    expect(await axe(page)).toEqual([]);
    await fits(page);
    await page.getByRole('link', { name: 'Cancel' }).click();
    await expect(page).toHaveURL(`${SITE_URL}${HERE}`);
    await expect(card(page, RECORDS.member.name)).toHaveCount(1);
  });

  test('names only what is still held, and no end of access, for a removed member', async ({ page }) => {
    await asAdmin(page);
    await card(page, RECORDS.removed.name).getByRole('button', { name: 'Erase this record' }).click();
    await expect(page.getByRole('list', { name: 'This will be erased:' }).getByRole('listitem')).toHaveText([
      `The name and email address from their sign-in: ${RECORDS.removed.name}, ${RECORDS.removed.email}.`,
    ]);
    await expect(page.locator('main')).toContainText('This cannot be undone. Only the date and the decision are kept.');
    await expect(page.locator('main')).not.toContainText('member access ends');
  });

  test('from the keyboard alone: Tab to the button, Enter, Tab to Yes, Enter; the record is gone and the page says so', async ({ page }) => {
    await asAdmin(page);
    await page.locator('h1').evaluate((el) => { (el as HTMLElement).tabIndex = -1; (el as HTMLElement).focus(); });
    await tabTo(page, card(page, RECORDS.rejected.name).getByRole('button', { name: 'Erase this record' }));
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 2, name: 'Erase this record?' })).toBeVisible();
    await page.locator('h1').evaluate((el) => { (el as HTMLElement).tabIndex = -1; (el as HTMLElement).focus(); });
    await tabTo(page, page.getByRole('button', { name: 'Yes, erase it' }));
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`${SITE_URL}${HERE}?done=erased`);
    await expect(page.getByRole('status')).toHaveText('Erased. Only the date and the decision are kept.');
    await expect(card(page, RECORDS.rejected.name)).toHaveCount(0);
    expect(await page.content()).not.toContain(RECORDS.rejected.number);
    expect(await axe(page)).toEqual([]);
    // Sent again (a stale page): nothing more to erase, said plainly.
    const again = await post(page, { action: 'erase', request: RECORDS.rejected.id, confirmed: 'yes' });
    expect(again.status()).toBe(303);
    expect(again.headers()['location']).toBe(`${HERE}?done=already`);
  });

  test('an approved member\'s erasure says their member access has ended', async ({ page }) => {
    await asAdmin(page);
    await card(page, RECORDS.member.name).getByRole('button', { name: 'Erase this record' }).click();
    await page.getByRole('button', { name: 'Yes, erase it' }).click();
    await expect(page).toHaveURL(`${SITE_URL}${HERE}?done=erased-access`);
    await expect(page.getByRole('status')).toHaveText('Erased. Only the date and the decision are kept, and the person’s member access has ended.');
    await expect(card(page, RECORDS.member.name)).toHaveCount(0);
  });

  test('refuses the Admin\'s own record, a record that does not exist and a form it cannot read, in words, changing nothing', async ({ page }) => {
    await asAdmin(page);
    const own = await post(page, { action: 'erase', request: RECORDS.ownId, confirmed: 'yes' });
    expect(own.status()).toBe(409);
    expect(await own.text()).toContain('Nothing was changed: only the Admin erases a record, and never their own.');
    const gone = await post(page, { action: 'erase', request: 'd1000000-0000-4000-8000-0000000000ff', confirmed: 'yes' });
    expect(gone.status()).toBe(409);
    expect(await gone.text()).toContain('Nothing was changed: this record is no longer in the list');
    // Not confirmed, and not in the list: no confirmation step for it.
    const unlisted = await post(page, { action: 'erase', request: RECORDS.ownId });
    expect(unlisted.status()).toBe(400);
    expect(await unlisted.text()).toContain('Nothing was changed: start again from the list below.');
    const bad = await post(page, { action: 'erase', request: 'not-an-id', confirmed: 'yes' });
    expect(bad.status()).toBe(400);
    expect(await bad.text()).toContain('Nothing was changed: start again from the list below.');
    await page.goto(HERE);
    await expect(page.locator('.record-card')).toHaveCount(4);
  });
});

test.describe('PROFILE-ERASE: correcting a membership number', () => {
  test('the form has real labels and three labelled reasons, says what is wrong next to each, and keeps what was typed', async ({ page }) => {
    await asAdmin(page);
    await card(page, RECORDS.member.name).getByRole('link', { name: 'Correct the number' }).click();
    await expect(page).toHaveURL(`${SITE_URL}${HERE}?correct=${RECORDS.member.id}`);
    const group = page.getByRole('group', { name: 'Correct the membership number' });
    await expect(group).toContainText(`${RECORDS.member.name} (${RECORDS.member.email}). Number now: ${RECORDS.member.number}.`);
    const number = group.getByRole('textbox', { name: 'New membership number' });
    const reasons = group.getByRole('group', { name: 'Why are you correcting it?' });
    await expect(number).toHaveAccessibleDescription(/Digits only, up to 12 of them\./);
    await expect(reasons).toHaveAccessibleDescription(/Needed\. Choose one\. It is kept in the record with your name; the number is not\./);
    // No free text: three choices, each a radio button with its own label, none chosen yet.
    await expect(group.getByRole('textbox')).toHaveCount(1);
    await expect(reasons.getByRole('radio')).toHaveCount(3);
    for (const words of CHOICES) await expect(reasons.getByRole('radio', { name: words, exact: true })).not.toBeChecked();
    expect((await number.boundingBox())?.height).toBeGreaterThanOrEqual(48);
    for (const words of CHOICES) expect((await reasons.locator('.choice').filter({ hasText: words }).boundingBox())?.height).toBeGreaterThanOrEqual(48);
    expect(await axe(page)).toEqual([]);
    await fits(page);
    await number.fill('00004400x');
    await group.getByRole('button', { name: 'Review this correction' }).click();
    const again = page.getByRole('group', { name: 'Correct the membership number' });
    await expect(again.getByRole('textbox', { name: 'New membership number' })).toHaveAttribute('aria-invalid', 'true');
    await expect(again.getByRole('textbox', { name: 'New membership number' })).toHaveAccessibleDescription(/Problem: Enter the number using digits only, up to 12 of them\./);
    await expect(again.getByRole('textbox', { name: 'New membership number' })).toHaveValue('00004400x');
    await expect(again.getByRole('group', { name: 'Why are you correcting it?' })).toHaveAccessibleDescription(/Problem: Choose why you are correcting it\./);
    // A choice made is kept when the form comes back for another problem.
    await again.getByRole('radio', { name: REASON_WORDS }).check();
    await again.getByRole('button', { name: 'Review this correction' }).click();
    await expect(page.getByRole('group', { name: 'Why are you correcting it?' }).getByRole('radio', { name: REASON_WORDS })).toBeChecked();
    await expect(page.getByRole('group', { name: 'Why are you correcting it?' })).not.toHaveAccessibleDescription(/Problem/);
    expect(await axe(page)).toEqual([]);
    await fits(page);
  });

  test('from the keyboard alone: the link, the number, a reason, the review and Yes; the card then shows the new number', async ({ page }) => {
    await asAdmin(page);
    await page.locator('h1').evaluate((el) => { (el as HTMLElement).tabIndex = -1; (el as HTMLElement).focus(); });
    await tabTo(page, card(page, RECORDS.member.name).getByRole('link', { name: 'Correct the number' }));
    await page.keyboard.press('Enter');
    const group = page.getByRole('group', { name: 'Correct the membership number' });
    await expect(group).toBeVisible();
    await page.locator('h1').evaluate((el) => { (el as HTMLElement).tabIndex = -1; (el as HTMLElement).focus(); });
    await tabTo(page, group.getByRole('textbox', { name: 'New membership number' }));
    await page.keyboard.type('0000 44-009');
    await page.keyboard.press('Tab');
    const first = group.getByRole('radio', { name: CHOICES[0] });
    await expect(first).toBeFocused();
    await page.keyboard.press('Space');
    await expect(first).toBeChecked();
    await page.keyboard.press('Tab');
    await expect(group.getByRole('button', { name: 'Review this correction' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 2, name: 'Check this correction' })).toBeVisible();
    const main = page.locator('main');
    await expect(fact(main, 'Number now')).toHaveText(RECORDS.member.number);
    await expect(fact(main, 'New number')).toHaveText(NEW_NUMBER);
    await expect(fact(main, 'Reason')).toHaveText(CHOICES[0] as string);
    await expect(main).toContainText('The reason is kept in the record with your name; the number is not.');
    expect(await axe(page)).toEqual([]);
    await fits(page);
    await page.locator('h1').evaluate((el) => { (el as HTMLElement).tabIndex = -1; (el as HTMLElement).focus(); });
    await tabTo(page, page.getByRole('button', { name: 'Yes, correct it' }));
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`${SITE_URL}${HERE}?done=corrected`);
    await expect(page.getByRole('status')).toHaveText('Corrected. The member’s account page now shows the new number.');
    await expect(fact(card(page, RECORDS.member.name), 'Membership number')).toHaveText(NEW_NUMBER);
    expect(await axe(page)).toEqual([]);
    // The same number again is refused, in words.
    const same = await post(page, { action: 'correct', step: 'apply', request: RECORDS.member.id, membershipNumber: NEW_NUMBER, reason: REASON });
    expect(same.status()).toBe(409);
    expect(await same.text()).toContain('Nothing was changed: only an approved member’s number is corrected, and the new number must differ from the one on file.');
  });

  test('offers no form for a record whose number cannot be corrected, and applies none that is posted anyway', async ({ page }) => {
    await asAdmin(page);
    for (const id of [RECORDS.rejected.id, RECORDS.removed.id, RECORDS.ownId, 'd1000000-0000-4000-8000-0000000000ff']) {
      await page.goto(`${HERE}?correct=${id}`);
      await expect(page.getByRole('group', { name: 'Correct the membership number' })).toHaveCount(0);
      await expect(page.getByRole('alert')).toHaveText('Nothing was changed: start again from the list below.');
      await expect(page.locator('.record-card')).toHaveCount(4);
    }
    const rejected = await post(page, { action: 'correct', step: 'apply', request: RECORDS.rejected.id, membershipNumber: NEW_NUMBER, reason: REASON });
    expect(rejected.status()).toBe(409);
    expect(await rejected.text()).toContain('Nothing was changed: only an approved member’s number is corrected');
    const own = await post(page, { action: 'correct', step: 'apply', request: RECORDS.ownId, membershipNumber: NEW_NUMBER, reason: REASON });
    expect(own.status()).toBe(409);
    expect(await own.text()).toContain('Nothing was changed: only the Admin corrects a number, and never their own.');
    // Before fix 1: a reason with a digit never reached the API. Now any reason not one of the three never does.
    for (const reason of ['It was 000044001', 'Two digits were swapped', 'Card shows a different number']) {
      const typed = await post(page, { action: 'correct', step: 'apply', request: RECORDS.member.id, membershipNumber: NEW_NUMBER, reason });
      expect(typed.status()).toBe(400);
      expect(await typed.text()).toContain('Problem: Choose why you are correcting it.');
      expect(await typed.text()).not.toContain(reason);
    }
    // A number already on another person's sign-up is refused in words, without saying whose.
    const taken = await post(page, { action: 'correct', step: 'apply', request: RECORDS.member.id, membershipNumber: SIGNUP_QUEUE[0].number, reason: REASON });
    expect(taken.status()).toBe(409);
    expect(await taken.text()).toContain('Nothing was changed: that number is already on another person’s sign-up.');
    expect(await taken.text()).not.toContain(SIGNUP_QUEUE[0].name);
    await page.goto(HERE);
    await expect(fact(card(page, RECORDS.member.name), 'Membership number')).toHaveText(RECORDS.member.number);
  });
});

test.describe('PROFILE-ERASE: large text', () => {
  for (const size of [SIZES[6], 200] as const) {
    test(`the list, the erase step, the form with its problems and the review, at ${size} % text, with nothing to scroll sideways`, async ({ page, context, baseURL }) => {
      // 175 % is the site's own largest size (the reader's menu). 200 % is the browser's text zoom, set as the root size.
      if (size === SIZES[6]) await setPrefs(context, baseURL!, { size });
      else await context.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = '200%'; }));
      await asAdmin(page);
      if (size === 200) expect(await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))).toBeGreaterThanOrEqual(32);
      await expect(page.locator('.record-card')).toHaveCount(4);
      expect(await axe(page)).toEqual([]);
      await fits(page);
      await card(page, RECORDS.member.name).getByRole('button', { name: 'Erase this record' }).click();
      await expect(page.getByRole('button', { name: 'Yes, erase it' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Cancel' })).toBeVisible();
      expect(await axe(page)).toEqual([]);
      await fits(page);
      await page.getByRole('link', { name: 'Cancel' }).click();
      await card(page, RECORDS.member.name).getByRole('link', { name: 'Correct the number' }).click();
      await page.getByRole('button', { name: 'Review this correction' }).click();
      await expect(page.getByText('Problem: Enter the new membership number.')).toBeVisible();
      await expect(page.getByText('Problem: Choose why you are correcting it.')).toBeVisible();
      expect(await axe(page)).toEqual([]);
      await fits(page);
      await page.getByRole('textbox', { name: 'New membership number' }).fill(NEW_NUMBER);
      await page.getByRole('radio', { name: REASON_WORDS }).check();
      await page.getByRole('button', { name: 'Review this correction' }).click();
      await expect(page.getByRole('button', { name: 'Yes, correct it' })).toBeVisible();
      expect(await axe(page)).toEqual([]);
      await fits(page);
    });
  }

  test('renders with no script', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, ignoreHTTPSErrors: true, baseURL: SITE_URL });
    const page = await context.newPage();
    await asAdmin(page);
    await card(page, RECORDS.reopened.name).getByRole('button', { name: 'Erase this record' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Erase this record?' })).toBeVisible();
    await page.getByRole('button', { name: 'Yes, erase it' }).click();
    await expect(page.getByRole('status')).toHaveText('Erased. Only the date and the decision are kept.');
    await context.close();
  });
});
