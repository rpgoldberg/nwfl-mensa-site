// EDITOR E4: the approver's and publisher's screens, through the browser, against the stand-in API's
// workflow (e2e/workflow.mjs, with A1's two steps and A3b's link gate): S6 "Approve news", S7 the review
// page with its links panel, "Acting as", Approve, break-glass and Send back, the Publish confirm (with the
// tick that puts a taken-down item back) and S9's Take down confirm, and the officer area's counts. With
// no script (plain form posts, post/redirect/get), then the script that keeps typed notes in the tab. A
// sign-in that ran out says "Sign in again; your saved answers are kept". Accessibility in every theme;
// at the largest text on a 320 px screen nothing scrolls sideways and every button is 48 px tall.
// Each browser project changes only its own seeds (e2e/stand-in.ts REVIEW.own); the shared ones are only
// ever refused.
import AxeBuilder from '@axe-core/playwright';
import { type Locator, type Page, expect, test } from '@playwright/test';
import { SIZES } from '../server/prefs.mjs';
import { THEMES, setPrefs } from './prefs';
import { SITE_URL } from './servers';
import { signIn } from './signin';
import { REVIEW, WORKFLOW } from './stand-in';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'wcag2aaa', 'best-practice'];
const QUEUE = '/officer-area/approvals';
const review = (id: string) => `${QUEUE}/${id}`;
const APPROVE_NOTE = 'This does not publish it yet. The Webmaster publishes it.';

async function axe(page: Page): Promise<string[]> {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const own = () => REVIEW.own(test.info().project.name);
/** A link's row in the panel, by its heading (its words, else its address). */
const row = (page: Page, heading: string) => page.locator('.link-row').filter({ has: page.getByRole('heading', { name: heading, exact: true }) });
const status = (page: Page) => page.locator('.item-header .chip');
/** A piece in one of S6's lists: its table row where the list is wide enough for one, else its card. */
async function entry(page: Page, list: Locator, title: string): Promise<Locator> {
  const table = list.getByRole('table');
  if (await table.isVisible()) return table.getByRole('row').filter({ has: page.getByRole('rowheader', { name: title, exact: true }) });
  return list.getByRole('listitem').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}

test.describe('approving, with no script', () => {
  test.use({ javaScriptEnabled: false });

  test('the queue lists what waits and what is approved, marking what you changed', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'officer');
    await page.goto('/officer-area');
    await page.getByRole('link', { name: /^Approve news \(\d+ waiting\)$/ }).click();
    await expect(page).toHaveURL(`${SITE_URL}${QUEUE}`);
    const waiting = page.getByRole('region', { name: /^Waiting for approval/ });
    await expect(await entry(page, waiting, REVIEW.links.title)).toContainText('You changed this version, so another officer must approve it.');
    await expect(await entry(page, waiting, WORKFLOW.waiting.title)).not.toContainText('You changed');
    const toPublish = page.getByRole('region', { name: /^Approved, ready to publish/ });
    await expect(await entry(page, toPublish, REVIEW.frozen.title)).toBeVisible();
    await expect(toPublish).toContainText('The Webmaster publishes these, or the Admin as backup.');
  });

  // Round 1: as "Our news" (E3 fix 1), each list is a table where it is wide enough, a card each where it is not.
  test('the queue is a table on a wide screen, with the title as its Review link, and cards on a phone', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'webmaster');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(QUEUE);
    const waiting = page.getByRole('table', { name: 'Waiting for approval, oldest first' });
    const toPublish = page.getByRole('table', { name: 'Approved, ready to publish, oldest first' });
    await expect(waiting).toBeVisible();
    await expect(toPublish).toBeVisible();
    for (const table of [waiting, toPublish]) {
      await expect(table.getByRole('columnheader')).toHaveText(['Title', 'What it is', 'Office', 'Status', 'When']);
    }
    const frozen = toPublish.getByRole('row').filter({ has: page.getByRole('rowheader', { name: REVIEW.frozen.title, exact: true }) });
    await expect(frozen.getByRole('link', { name: REVIEW.frozen.title, exact: true })).toHaveAttribute('href', review(REVIEW.frozen.id));
    await expect(frozen.getByRole('cell')).toHaveText(['Announcement', 'President', 'Approved, ready to publish', /^Approved [A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}, .+ by the Treasurer$/]);
    await expect(page.locator('.review-list').first()).toBeHidden();

    await page.setViewportSize({ width: 412, height: 900 });
    await page.goto(QUEUE);
    await expect(waiting).toBeHidden();
    await expect(toPublish).toBeHidden();
    const card = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: REVIEW.frozen.title, exact: true }) });
    await expect(card).toBeVisible();
    await expect(card.getByRole('link', { name: `Review ${REVIEW.frozen.title}` })).toHaveAttribute('href', review(REVIEW.frozen.id));
  });

  test('a reviewer checks the links by hand: a no holds Approve, a sign-in link needs a yes, then Approve does not publish', async ({ page }) => {
    const { links } = own();
    await page.goto('/');
    await signIn(page, 'treasurer');
    await page.goto(review(links.id));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(links.title);
    await expect(page.locator('.acting-as')).toHaveText('Acting as: Treasurer');
    await expect(page.getByText('0 of 3 links checked.')).toBeVisible();
    const facebook = row(page, 'our Facebook group');
    await expect(facebook).toContainText('Needs a sign-in to check');
    const open = facebook.getByRole('link', { name: 'Open the link (opens a new tab)' });
    await expect(open).toHaveAttribute('href', REVIEW.urls.facebook);
    await expect(open).toHaveAttribute('target', '_blank');
    await expect(open).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(page.getByText(APPROVE_NOTE)).toBeVisible();

    // Approve first: the sign-in link has no yes.
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'It was not approved' })).toHaveText(
      'It was not approved: 1 link needs a sign-in to check (such as Facebook): someone other than the writer must open it and answer yes before this is approved.',
    );

    // The map is the wrong one: no, with a note; the Facebook group is right.
    await row(page, REVIEW.urls.map).getByRole('radio', { name: 'No' }).check();
    await row(page, REVIEW.urls.map).getByRole('textbox', { name: 'Note (optional)' }).fill('It shows last year’s park.');
    await facebook.getByRole('radio', { name: 'Yes' }).check();
    await page.getByRole('button', { name: 'Save my answers' }).click();
    await expect(page.getByRole('status')).toHaveText('Your answers are saved.');
    await expect(page.getByText('2 of 3 links checked.')).toBeVisible();
    await expect(facebook).toContainText('Checked by Treasurer: it shows the right page.');
    await expect(row(page, REVIEW.urls.map)).toContainText('Treasurer answered no: it does not show the right page.');

    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'It was not approved' })).toContainText(`a reviewer answered no for the link "${REVIEW.urls.map}"`);

    // Changed to yes in the same form as Approve: the answer is saved first, then it is approved.
    await row(page, REVIEW.urls.map).getByRole('radio', { name: 'Yes' }).check();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText(`Approved. ${APPROVE_NOTE}`);
    await expect(status(page)).toHaveText('Approved, ready to publish');
    await expect(page.getByRole('note').filter({ hasText: 'Approved by the Treasurer' })).toContainText('The Webmaster publishes it, or the Admin as backup.');
    await expect(page.getByRole('link', { name: 'Publish', exact: true })).toHaveCount(0);
  });

  test('a list of links changed since the page opened is shown again, the notes kept', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'treasurer');
    await page.goto(review(REVIEW.links.id));
    await row(page, 'the picnic page').getByRole('radio', { name: 'Yes' }).check();
    await row(page, 'the picnic page').getByRole('textbox', { name: 'Note (optional)' }).fill('Kept across the reload');
    // As if the office's events had changed the list since: the page's copy of its hash is old.
    await page.locator('input[name="links_hash"]').evaluate((el: HTMLInputElement) => (el.value = '0'.repeat(64)));
    await page.getByRole('button', { name: 'Save my answers' }).click();
    await expect(page.getByRole('alert')).toContainText('The links of this piece changed since you opened the page, so nothing was saved.');
    await expect(row(page, 'the picnic page').getByRole('textbox', { name: 'Note (optional)' })).toHaveValue('Kept across the reload');
    await expect(row(page, 'the picnic page').getByRole('radio', { name: 'Yes' })).not.toBeChecked();
    await expect(page.getByText('0 of 3 links checked.')).toBeVisible();
  });

  // E4 fix round 1 (S3): the link is in a passage marked for officers only, so the check that it is absent
  // cannot pass for want of a link. Round 2 (P24): the API gives such a reviewer no hash, so nothing to
  // approve with: the page says an officer who sees it all approves it, and offers only Send back.
  test('a reviewer outside the officers group, with part of a piece hidden, is offered only Send back', async ({ browser, page }) => {
    const officer = await browser.newContext({ javaScriptEnabled: false, ignoreHTTPSErrors: true });
    const seen = await officer.newPage();
    await seen.goto(SITE_URL);
    await signIn(seen, 'treasurer');
    await seen.goto(`${SITE_URL}${review(REVIEW.membersLink.id)}`);
    await expect(seen.getByText('0 of 1 link checked.')).toBeVisible();
    await expect(row(seen, "our members' group").getByRole('link', { name: /^Open the link/ })).toHaveAttribute('href', REVIEW.membersLink.url);
    await expect(seen.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
    await officer.close();

    await page.goto('/');
    await signIn(page, 'lone-webmaster');
    await page.goto(review(REVIEW.membersLink.id));
    await expect(page.getByRole('note').filter({ hasText: 'Parts of this piece are hidden from you' })).toHaveText(
      'Parts of this piece are hidden from you, so an officer who can see all of it must approve it. You can still send it back.',
    );
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /break-glass/ })).toHaveCount(0);
    await expect(page.getByRole('radio')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save my answers' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Send back' })).toBeVisible();
    // Round 3: the hidden part holds a link, so the panel never says the piece has none.
    const panel = page.getByRole('region', { name: 'Check the links' });
    await expect(panel).toContainText('An officer who can see all of this piece checks its links.');
    await expect(panel).not.toContainText('This piece has no links.');
    await expect(panel).not.toContainText(/\d+ of \d+ links? checked/);
    expect(await page.content()).not.toContain(REVIEW.membersLink.url);
    // The queue lists it, saying so, and the officer area does not count it as theirs to approve.
    await page.goto(QUEUE);
    const waiting = page.getByRole('region', { name: /^Waiting for approval/ });
    await expect(await entry(page, waiting, REVIEW.membersLink.title)).toContainText('Parts are hidden from you, so an officer who can see all of it must approve it.');
  });

  // E4 fix round 1 (S1): answers go by row (its place and a short key), never by address, so a long list fits.
  test('two hundred links, or forty of 2,048 characters, save with a long note; Approve and Send back go through', async ({ page }) => {
    test.setTimeout(180_000);
    const o = own();
    const NOTE = 'N'.repeat(2000);
    await page.goto('/');
    await signIn(page, 'treasurer');
    for (const [saved, back] of [[o.many, o.manyBack], [o.long, o.longBack]] as const) {
      await page.goto(review(saved.id));
      await expect(page.getByText(`0 of ${saved.count} links checked.`)).toBeVisible();
      await page.locator('input[type="radio"][value="yes"]').evaluateAll((els) => els.forEach((el) => ((el as HTMLInputElement).checked = true)));
      await page.locator('.link-row textarea').first().fill(NOTE);
      await page.getByRole('textbox', { name: 'Note for the writer' }).fill('Typed, not sent');
      const [post] = await Promise.all([page.waitForResponse((r) => r.request().method() === 'POST'), page.getByRole('button', { name: 'Save my answers' }).click()]);
      console.log(`S1 ${saved.title}: Save posted ${post.request().postDataBuffer()?.length} bytes -> ${post.status()}`);
      expect(post.status()).toBe(303);
      await expect(page.getByRole('status')).toHaveText('Your answers are saved.');
      await expect(page.getByText(`${saved.count} of ${saved.count} links checked.`)).toBeVisible();
      await page.getByRole('button', { name: 'Approve', exact: true }).click();
      await expect(page.getByRole('status')).toHaveText(`Approved. ${APPROVE_NOTE}`);

      await page.goto(review(back.id));
      await page.locator('input[type="radio"][value="yes"]').evaluateAll((els) => els.forEach((el) => ((el as HTMLInputElement).checked = true)));
      await page.locator('.link-row textarea').first().fill(NOTE);
      await page.getByRole('textbox', { name: 'Note for the writer' }).fill(NOTE);
      const [sent] = await Promise.all([page.waitForResponse((r) => r.request().method() === 'POST'), page.getByRole('button', { name: 'Send back' }).click()]);
      console.log(`S1 ${back.title}: Send back posted ${sent.request().postDataBuffer()?.length} bytes -> ${sent.status()}`);
      await expect(page).toHaveURL(`${SITE_URL}${QUEUE}?done=sent-back`);
    }
  });

  test('a form too large to send says so in plain words, and how to get back what was typed', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'treasurer');
    await page.goto(review(REVIEW.links.id));
    const hash = await page.locator('input[name="hash"]').inputValue();
    const res = await page.request.post(`${SITE_URL}${review(REVIEW.links.id)}`, {
      form: { hash, step: 'links', 'row-0': '0', 'answer-0': 'yes', 'note-0': 'é'.repeat(40_000) },
      headers: { Origin: SITE_URL },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(413);
    const html = await res.text();
    expect(html).toContain('Too much was sent at once, so nothing was saved.');
    expect(html).not.toContain('Too large.');
    // The page itself, with its form: the tab's copy of what was typed fills it again.
    expect(html).toContain('Check the links');
  });

  // E4 fix round 1 (S2): an answer the API did not keep is named, never called saved.
  test('an answer the API did not keep is said, and the others are saved', async ({ page }) => {
    const { tooLong } = own();
    await page.goto('/');
    await signIn(page, 'treasurer');
    await page.goto(review(tooLong.id));
    for (const heading of ['the picnic page', 'the full map']) await row(page, heading).getByRole('radio', { name: 'Yes' }).check();
    await page.getByRole('button', { name: 'Save my answers' }).click();
    await expect(page.getByRole('alert')).toHaveText('1 answer was not saved: that link is no longer in this piece. The list below is the current one. Your other answer is saved.');
    await expect(page.getByText('Your answers are saved.')).toHaveCount(0);
    await expect(page.getByText('1 of 2 links checked.')).toBeVisible();
    await expect(row(page, 'the picnic page')).toContainText('Checked by Treasurer');
    await expect(row(page, 'the full map')).toContainText('Not checked yet.');
  });

  // E4 fix round 1 (S5): a mail link writes an email in this tab; only a web link opens a new one.
  test('a mail link says "Write an email to" its address and opens no new tab', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'treasurer');
    await page.goto(review(REVIEW.mailLink.id));
    const mail = row(page, 'the events desk').getByRole('link', { name: /^Write an email to/ });
    // The visually hidden words after the address are a block of their own to the name: a space may come between.
    await expect(mail).toHaveAccessibleName(/^Write an email to events@example\.org ?: the events desk$/);
    expect(REVIEW.mailLink.address).toBe('events@example.org');
    await expect(mail).toHaveAttribute('href', `mailto:${REVIEW.mailLink.address}`);
    await expect(mail).not.toHaveAttribute('target', /./);
    await expect(row(page, 'the events desk')).not.toContainText('opens a new tab');
    const web = row(page, 'the picnic page').getByRole('link', { name: /^Open the link \(opens a new tab\)/ });
    await expect(web).toHaveAttribute('target', '_blank');
    await expect(web).toHaveAttribute('rel', 'noopener noreferrer');
  });

  test('answers to a piece sent for approval again since the page opened are refused, and the list comes back, notes kept', async ({ browser, page }) => {
    const { readyAgain } = own();
    await page.goto('/');
    await signIn(page, 'treasurer');
    await page.goto(review(readyAgain.id));
    await row(page, 'the picnic page').getByRole('radio', { name: 'Yes' }).check();
    await row(page, 'the picnic page').getByRole('textbox', { name: 'Note (optional)' }).fill('Typed before it was sent again');
    // Meanwhile the President saves it (back to a draft) and sends it for approval again: a new round.
    const writer = await browser.newContext({ javaScriptEnabled: false, ignoreHTTPSErrors: true });
    const other = await writer.newPage();
    await other.goto(SITE_URL);
    await signIn(other, 'officer');
    await other.goto(`${SITE_URL}/officer-area/news/${readyAgain.id}`);
    await other.getByRole('button', { name: 'Save draft' }).first().click();
    await other.goto(`${SITE_URL}/officer-area/news/${readyAgain.id}/preview`);
    await other.getByRole('button', { name: 'Send for approval' }).click();
    await expect(other).toHaveURL(`${SITE_URL}/officer-area/news?sent=1`);
    await writer.close();
    await page.getByRole('button', { name: 'Save my answers' }).click();
    await expect(page.getByRole('alert')).toContainText('The links of this piece changed since you opened the page, so nothing was saved.');
    await expect(row(page, 'the picnic page').getByRole('textbox', { name: 'Note (optional)' })).toHaveValue('Typed before it was sent again');
    // The page now holds the new round's hash: answering again is kept.
    await row(page, 'the picnic page').getByRole('radio', { name: 'Yes' }).check();
    await page.getByRole('button', { name: 'Save my answers' }).click();
    await expect(page.getByRole('status')).toHaveText('Your answers are saved.');
    await expect(row(page, 'the picnic page')).toContainText('Checked by Treasurer');
  });

  test('the writer cannot approve or answer for their own version; the Admin may by break-glass, with a reason', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'officer');
    await page.goto(review(REVIEW.links.id));
    await expect(page.getByText('You changed this version, so someone else must check its links.')).toBeVisible();
    await expect(page.getByRole('radio')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
    await expect(page.getByText('You changed this version, so another officer must approve it.')).toBeVisible();
    await expect(page.getByRole('button', { name: /break-glass/ })).toHaveCount(0);

    await page.context().clearCookies();
    await page.goto('/');
    await signIn(page, 'admin');
    await page.goto(review(REVIEW.adminWrote.id));
    await expect(page.getByRole('note').filter({ hasText: 'Entered for President by the Admin' })).toBeVisible();
    await page.getByRole('button', { name: 'Approve my own change (break-glass)' }).click();
    await expect(page.locator('[data-error-summary]')).toContainText('Write why you are approving your own change.');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(REVIEW.adminWrote.title);
  });

  // E4 fix round 1 (N2): a break-glass post by someone not offered it lists the problem without a link to a field not there.
  test('a break-glass post by a reviewer who is not the Admin links no problem to a field the page lacks', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'treasurer');
    await page.goto(review(REVIEW.links.id));
    await expect(page.locator('#reason')).toHaveCount(0);
    const hash = await page.locator('input[name="hash"]').inputValue();
    const res = await page.request.post(`${SITE_URL}${review(REVIEW.links.id)}`, { form: { hash, step: 'break-glass' }, headers: { Origin: SITE_URL }, maxRedirects: 0 });
    expect(res.status()).toBe(400);
    await page.setContent(await res.text());
    const summary = page.locator('[data-error-summary]');
    await expect(summary).toContainText('Write why you are approving your own change.');
    const targets = await summary.locator('a').evaluateAll((els) => els.map((a) => a.getAttribute('href')));
    for (const href of targets) expect(await page.locator(href!).count(), href!).toBe(1);
    await expect(summary.locator('a[href="#reason"]')).toHaveCount(0);
  });

  // E4 fix round 1 (N5): Astro's origin check, by E4's own suite: a post from another site changes nothing.
  test('a send back or a publish posted from another site is refused, and nothing changes', async ({ page }) => {
    const { forgedBack, forgedPublish } = own();
    await page.goto('/');
    await signIn(page, 'webmaster');
    await page.goto(review(forgedBack.id));
    const back = { hash: await page.locator('input[name="hash"]').inputValue(), links_hash: await page.locator('input[name="links_hash"]').inputValue(), step: 'send-back', note: 'Forged' };
    await page.goto(`${review(forgedPublish.id)}/publish`);
    const publish = { hash: await page.locator('input[name="hash"]').inputValue() };
    for (const [path, form] of [[review(forgedBack.id), back], [`${review(forgedPublish.id)}/publish`, publish]] as const) {
      const res = await page.request.post(`${SITE_URL}${path}`, { form, headers: { Origin: 'https://evil.example' }, maxRedirects: 0 });
      expect(res.status(), path).toBe(403);
    }
    await page.goto(review(forgedBack.id));
    await expect(status(page)).toHaveText('Waiting for approval');
    await page.goto(review(forgedPublish.id));
    await expect(status(page)).toHaveText('Approved, ready to publish');
    // The same posts from this site go through: the refusal was the origin's.
    expect((await page.request.post(`${SITE_URL}${review(forgedBack.id)}`, { form: back, headers: { Origin: SITE_URL }, maxRedirects: 0 })).status()).toBe(303);
    expect((await page.request.post(`${SITE_URL}${review(forgedPublish.id)}/publish`, { form: publish, headers: { Origin: SITE_URL }, maxRedirects: 0 })).status()).toBe(303);
  });

  test('an officer in two seats picks the one they act for; one seat is said in words', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'two-seats');
    await page.goto(review(WORKFLOW.waiting.id));
    const acting = page.getByRole('group', { name: 'Acting as' });
    await expect(acting.getByRole('radio')).toHaveCount(2);
    await expect(acting.getByRole('radio', { name: 'Member at Large' })).toBeVisible();
    await expect(acting.getByRole('radio', { name: 'Secretary' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Note for the writer' }).fill('Typed before choosing');
    await page.getByRole('button', { name: 'Send back' }).click();
    await expect(page.locator('[data-error-summary]')).toContainText('Choose which of your offices you act for.');
    await expect(page.getByRole('textbox', { name: 'Note for the writer' })).toHaveValue('Typed before choosing');
    await expect(status(page)).toHaveText('Waiting for approval');
  });

  test('send back needs a note, then goes to the writer', async ({ page }) => {
    const { sendBack } = own();
    await page.goto('/');
    await signIn(page, 'treasurer');
    await page.goto(review(sendBack.id));
    await page.getByRole('button', { name: 'Send back' }).click();
    await expect(page.locator('[data-error-summary]')).toContainText('Write a note for the author.');
    await page.getByRole('textbox', { name: 'Note for the writer' }).fill('Please add the start time.');
    await page.getByRole('button', { name: 'Send back' }).click();
    await expect(page).toHaveURL(`${SITE_URL}${QUEUE}?done=sent-back`);
    await expect(page.getByRole('status')).toHaveText('Sent back to the writer with your note.');
    await page.goto(review(sendBack.id));
    await expect(status(page)).toHaveText('Sent back – please read the note');
  });

  test('the Webmaster publishes an approved piece after a confirm; a reviewer who is no publisher has no Publish', async ({ page }) => {
    const { toPublish } = own();
    await page.goto('/');
    await signIn(page, 'treasurer');
    await page.goto(review(toPublish.id));
    await expect(page.getByRole('link', { name: 'Publish', exact: true })).toHaveCount(0);
    await page.context().clearCookies();
    await page.goto('/');
    await signIn(page, 'webmaster');
    await page.goto(review(toPublish.id));
    await page.getByRole('link', { name: 'Publish', exact: true }).click();
    await expect(page).toHaveURL(`${SITE_URL}${review(toPublish.id)}/publish`);
    await expect(page.getByRole('note')).toHaveText('This goes on the website now. It was approved by the Treasurer.');
    await page.getByRole('button', { name: 'Publish' }).click();
    await expect(page).toHaveURL(`${SITE_URL}${review(toPublish.id)}?done=published`);
    await expect(page.getByRole('status')).toHaveText('Published. It is on the website now.');
    await expect(status(page)).toHaveText('Published');
  });

  test('the Admin cannot publish their own break-glass approval, and the server says so in plain words', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'admin');
    await page.goto(review(REVIEW.selfApproved.id));
    await expect(page.getByRole('note').filter({ hasText: 'Approved by the Admin' })).toContainText('someone other than that approver publishes it');
    await expect(page.getByRole('link', { name: 'Publish', exact: true })).toHaveCount(0);
    // The confirm page sends them back to the review; a post made anyway is refused by the API, in words.
    await page.goto(`${review(REVIEW.selfApproved.id)}/publish`);
    await expect(page).toHaveURL(`${SITE_URL}${review(REVIEW.selfApproved.id)}`);
    const hash = await page.locator('input[name="hash"]').inputValue();
    const res = await page.request.post(`${SITE_URL}${review(REVIEW.selfApproved.id)}/publish`, { form: { hash }, headers: { Origin: SITE_URL }, maxRedirects: 0 });
    expect(res.status()).toBe(403);
    expect(await res.text()).toContain('It was not published: you approved your own change; someone else must publish it.');
  });

  test('an approved piece for an edition frozen for print is refused at Publish, and points to Send back', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'webmaster');
    await page.goto(`${review(REVIEW.frozen.id)}/publish`);
    await page.getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByRole('note').filter({ hasText: 'frozen for print' })).toHaveText(
      `This piece is for ${REVIEW.frozen.edition}, which is now frozen for print. Send it back so the author can pick another edition.`,
    );
    await expect(page.getByRole('link', { name: 'Send it back' })).toHaveAttribute('href', `${review(REVIEW.frozen.id)}#send-back`);
  });

  test('a taken-down item goes back on the website only with the tick, which says when and by whom it was taken down', async ({ page }) => {
    const { putBack } = own();
    await page.goto('/');
    await signIn(page, 'webmaster');
    await page.goto(`${review(putBack.id)}/publish`);
    const group = page.getByRole('group', { name: 'It was taken down' });
    await expect(group).toContainText(/This item was taken down on [A-Z][a-z]+ \d{1,2}, \d{4} by the President\. Publishing puts it back on the website\./);
    await page.getByRole('button', { name: 'Publish' }).click();
    await expect(page.locator('[data-error-summary]')).toContainText('Tick the box to put it back on the website.');
    await page.getByRole('checkbox', { name: 'Yes, put it back on the website' }).check();
    await page.getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByRole('status')).toHaveText('Published. It is on the website now.');
    await expect(status(page)).toHaveText('Published');
  });

  test('the office takes its published piece down after a confirm (S9)', async ({ page }) => {
    const { live } = own();
    await page.goto('/');
    await signIn(page, 'officer');
    await page.goto(review(live.id));
    await page.getByRole('link', { name: 'Take down' }).click();
    await expect(page.getByRole('note')).toHaveText('It disappears from the website at once.');
    await page.getByRole('button', { name: 'Take it down' }).click();
    await expect(page.getByRole('status')).toHaveText('Taken down. It is no longer on the website.');
    await expect(status(page)).toHaveText(/^Taken down on /);
    await expect(page.getByRole('link', { name: 'Take down' })).toHaveCount(0);
  });

  test('the edit page (S4) of a published piece links to Take down; a piece not on the website has none', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'officer');
    await page.goto(`/officer-area/news/${WORKFLOW.published.id}`);
    await expect(page.getByRole('link', { name: 'Take down' })).toHaveAttribute('href', `${review(WORKFLOW.published.id)}/take-down`);
    await page.goto(`/officer-area/news/${WORKFLOW.takenDown.id}`);
    await expect(page.getByRole('link', { name: 'Take down' })).toHaveCount(0);
  });

  test('who may not: the public goes to sign in; a member finds nothing', async ({ page }) => {
    for (const path of [QUEUE, review(REVIEW.links.id), `${review(REVIEW.frozen.id)}/publish`, `${review(WORKFLOW.published.id)}/take-down`]) {
      const res = await page.request.get(`${SITE_URL}${path}`, { maxRedirects: 0 });
      expect(res.status(), path).toBe(303);
      expect(res.headers()['location'], path).toBe(`/sign-in?return=${encodeURIComponent(path)}`);
    }
    await page.goto('/');
    await signIn(page, 'member');
    for (const path of [QUEUE, review(REVIEW.links.id), `${review(REVIEW.frozen.id)}/publish`]) {
      expect((await page.goto(path))?.status(), path).toBe(404);
    }
  });

  test('the officer area counts what waits for you, and for a publisher what waits to be published', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'webmaster');
    await page.goto('/officer-area');
    const counts = page.getByRole('list', { name: 'Waiting for you' });
    await expect(counts.getByRole('listitem')).toHaveText([/^(No pieces|1 piece|\d+ pieces) waits? for your approval\.$/, /^(No pieces|1 piece|\d+ pieces) (is|are) approved and ready to publish\.$/]);
    await page.context().clearCookies();
    await page.goto('/');
    await signIn(page, 'treasurer');
    await page.goto('/officer-area');
    await expect(page.getByRole('list', { name: 'Waiting for you' }).getByRole('listitem')).toHaveCount(1);
  });
});

test.describe('a sign-in that runs out while reviewing', () => {
  test.use({ javaScriptEnabled: false });

  test('says "Sign in again; your saved answers are kept", and gives back what was typed', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/');
    // The Treasurer whose token outlives the site's 30-second margin by 15 seconds.
    await signIn(page, 'writer-lapsing');
    await page.goto(review(REVIEW.links.id));
    await row(page, 'the picnic page').getByRole('textbox', { name: 'Note (optional)' }).fill('My note on the picnic page');
    await row(page, 'the picnic page').getByRole('radio', { name: 'No' }).check();
    await page.getByRole('textbox', { name: 'Note for the writer' }).fill('My note for the writer');
    await page.waitForTimeout(17_000);
    await page.getByRole('button', { name: 'Save my answers' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Sign in again' })).toContainText('Sign in again; your saved answers are kept.');
    await expect(page.getByRole('link', { name: 'Sign in again (opens a new tab)' })).toHaveAttribute('target', '_blank');
    const kept = page.getByRole('region', { name: 'What you typed' });
    await expect(kept).toContainText('My note for the writer');
    await expect(kept).toContainText(/Your note on link \d: My note on the picnic page/);
    await expect(kept).toContainText(/Your answer on link \d: No/);
  });
});

test.describe('approving, with script', () => {
  test('a typed note is kept in the tab and put back when the page opens again', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'treasurer');
    await page.goto(review(REVIEW.links.id));
    await page.getByRole('textbox', { name: 'Note for the writer' }).fill('Typed, then the tab reloaded');
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Note for the writer' })).toHaveValue('Typed, then the tab reloaded');
    expect(await page.evaluate(() => Object.keys(window.localStorage).filter((k) => k.startsWith('nwfl-review')))).toEqual([]);
  });

  // E4 fix round 1 (N3): a Yes or No chosen and not saved is kept in the tab, as the notes are.
  test('a Yes or No chosen and not saved is kept in the tab and put back, never in localStorage', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'treasurer');
    await page.goto(review(REVIEW.links.id));
    await row(page, REVIEW.urls.map).getByRole('radio', { name: 'No' }).check();
    await row(page, 'the picnic page').getByRole('radio', { name: 'Yes' }).check();
    await page.reload();
    await expect(row(page, REVIEW.urls.map).getByRole('radio', { name: 'No' })).toBeChecked();
    await expect(row(page, 'the picnic page').getByRole('radio', { name: 'Yes' })).toBeChecked();
    for (const radio of await row(page, 'our Facebook group').getByRole('radio').all()) await expect(radio).not.toBeChecked();
    expect(await page.evaluate(() => Object.keys(window.localStorage).filter((k) => k.startsWith('nwfl-review')))).toEqual([]);
  });

  // E4 fix round 1 (S4): the Publish confirm's error summary takes focus, as S7's does.
  test('the Publish confirm\'s list of problems takes focus as the page opens', async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'webmaster');
    await page.goto(`${review(REVIEW.takenDown.id)}/publish`);
    await page.getByRole('button', { name: 'Publish' }).click();
    const summary = page.locator('[data-error-summary]');
    await expect(summary).toContainText('Tick the box to put it back on the website.');
    await expect(summary).toBeFocused();
  });

  // E4 fix round 1 (N6): an office title with no place to break wraps rather than push the page sideways.
  test('a long office name in the header wraps at the largest text on a 320 px screen', async ({ page, context, baseURL }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await setPrefs(context, baseURL!, { size: SIZES[6] });
    await page.goto('/');
    await signIn(page, 'treasurer');
    await page.goto(review(REVIEW.links.id));
    await page.locator('.item-header .eyebrow').evaluate((el) => (el.textContent = `Announcement · ${'Officeholdertitlewithnobreaks'.padEnd(40, 'x')}`));
    expect(await sideways(page)).toBeLessThanOrEqual(0);
  });
});

test.describe('the approver screens: accessibility', () => {
  /** S6, S7 with the links panel, and the two confirm pages. */
  const screens: [string, string][] = [
    ['S6, the queue', QUEUE],
    ['S7, with the links panel', review(REVIEW.links.id)],
    ['the Publish confirm, taken down', `${review(REVIEW.takenDown.id)}/publish`],
    ['the Take down confirm', `${review(WORKFLOW.published.id)}/take-down`],
  ];

  for (const theme of THEMES) {
    test(`axe finds nothing on S6, S7 and the confirms in the ${theme} theme`, async ({ page, context, baseURL }) => {
      await setPrefs(context, baseURL!, { theme });
      await page.goto('/');
      await signIn(page, 'webmaster');
      for (const [name, path] of screens) {
        await page.goto(path);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        expect(await axe(page), name).toEqual([]);
      }
    });
  }

  test('at the largest text on a 320 px screen, nothing scrolls sideways, and every button is 48 px tall', async ({ page, context, baseURL }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await setPrefs(context, baseURL!, { size: SIZES[6] });
    await page.goto('/');
    await signIn(page, 'webmaster');
    for (const [name, path] of screens) {
      await page.goto(path);
      expect(await sideways(page), name).toBeLessThanOrEqual(0);
      expect(await axe(page), name).toEqual([]);
      const short = await page.locator('main button:visible, main .button:visible, main .choice:visible').evaluateAll((els) =>
        els.filter((el) => el.getBoundingClientRect().height < 48).map((el) => el.textContent?.trim()),
      );
      expect(short, name).toEqual([]);
    }
  });
});
