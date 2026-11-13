// EDITOR E7a: the officers' editor on the REAL stack (playwright.editor-real.config.ts): the built site
// with sign-in on, the real API over a throwaway Postgres, and the test identity provider. Synthetic data
// only. The story, in order:
//   - the Treasurer writes a long report (over 40 KiB, under 48), saves it, lets the auto-save fire, finds
//     Send for approval blocked by an http:// link listed by its line, fixes it, and sends it ("Waiting for
//     approval");
//   - another officer sees it waiting (the Admin in Our news; the President, whose approval screen is E4's,
//     in the API's queue); the writer cannot approve it; the public and a member see nothing of it on any
//     page or feed, nor through the API;
//   - the President approves it ("Approved, ready to publish"), and still nobody outside sees it; the
//     Webmaster publishes it; the public then reads it with the members span withheld, and a member reads
//     the span.
// Approve and Publish have no screen yet (E4): they are called on the API with each person's own token.
// Then the events: the President cancels a series date and adds a one-off, and /events and calendar.ics
// show both at once; the Treasurer cannot change the President's event, on the page or on the API.
import { type Page, expect, test } from '@playwright/test';
import { ContentKind, VersionStatus } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { Area, EventCategory, EventVisibility, OccurrenceStatus } from '../../src/gen/nwfl/mensa/v1/event_pb.js';
import { addDays, centralToday } from '../stand-in';
import { as, codeOf, content, events, tokenFor } from './api';
import { LIST, createItem, longReport, marker, person, postedBytes, problemsRegion, publicBodies, rowOf, saveTop, textBox } from './helpers';
import { EDITOR_REAL } from './servers';

interface Fixture {
  ids: Record<string, string>;
}
let fixture: Fixture;
test.beforeAll(async ({ playwright }) => {
  const ctx = await playwright.request.newContext();
  fixture = (await (await ctx.get(`${EDITOR_REAL.stackUrl}/fixture`)).json()) as Fixture;
  await ctx.dispose();
});

/** Every public page and feed, none of which holds any of `secrets`. */
async function nothingPublic(secrets: string[], query: string, why: string) {
  const bodies = await publicBodies([], query);
  for (const [path, { status, body }] of bodies) {
    expect(status, `${path} answers (${why})`).toBeLessThan(500);
    for (const secret of secrets) expect(body.includes(secret), `${path} holds ${secret.slice(0, 12)}... (${why})`).toBe(false);
  }
}

/** The member's own reads of the same pages, signed in: none holds any of `secrets`. */
async function nothingForMember(page: Page, secrets: string[], why: string) {
  for (const path of ['/', '/news', '/finances', '/events', '/calendar.ics']) {
    const res = await page.request.get(path);
    const body = await res.text();
    for (const secret of secrets) expect(body.includes(secret), `the member's ${path} holds ${secret.slice(0, 12)}... (${why})`).toBe(false);
  }
}

test('the Treasurer writes a long report, it waits for approval, is approved and published, and the public reads it with the members span withheld', async ({ browser }) => {
  const pub = marker('e7apublic');
  const span = marker('e7aspan');
  const title = `Quarter report ${marker('t')}`;
  const report = longReport({ pub, span }, 44 * 1024);
  expect(postedBytes(report.markup), 'over 40 KiB as posted').toBeGreaterThan(40 * 1024);
  expect(postedBytes(report.markup), 'under 48 KiB as posted').toBeLessThanOrEqual(48 * 1024);
  const fixed = report.markup.replace('http://club.example/old-ledger', 'https://club.example/old-ledger');

  const treasurer = await person(browser, 'treasurer');
  const t = treasurer.page;
  let id = '';

  await test.step('write, save, and see the http:// link listed by its line', async () => {
    id = await createItem(t, title);
    await expect(t.locator('.item-header .chip')).toHaveText('Draft – only officers can see it');
    await textBox(t).fill(report.markup);
    await saveTop(t).click();
    await expect(t).toHaveURL(new RegExp(`/officer-area/news/${id}\\?saved=1$`));
    await expect(t.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
    await expect(problemsRegion(t).getByRole('link')).toHaveText([
      `Line ${report.httpLine}: the link "http://club.example/old-ledger" must start with https://, not http://`,
    ]);
    // What was saved is what was typed, every byte of it.
    await expect(textBox(t)).toHaveValue(report.markup);
  });

  await test.step('the auto-save fires on the real API and its new base is kept', async () => {
    await t.clock.install();
    await t.reload();
    const answers: number[] = [];
    t.on('response', (r) => {
      if (r.url().endsWith(`/officer-area/news/${id}/autosave`)) answers.push(r.status());
    });
    await textBox(t).press('Control+End');
    await textBox(t).pressSequentially(' More.');
    await t.clock.runFor(61_000);
    await expect(t.locator('[data-autosave-status]')).toHaveText(/^Saved automatically at \d{1,2}:\d{2} (am|pm|noon)\.$/);
    expect(answers).toEqual([200]);
    // The API holds the auto-saved text: the officer's own read gives it back.
    const item = (await content.getWorkingItem({ itemId: id }, as(await tokenFor('treasurer')))).item;
    expect(item?.working?.bodyMarkup.endsWith(' More.')).toBe(true);
  });

  await test.step('Send for approval is blocked by the http:// link, line listed, and a forced post is refused', async () => {
    await t.goto(`/officer-area/news/${id}/preview`);
    await expect(problemsRegion(t).getByRole('listitem')).toHaveCount(1);
    await expect(problemsRegion(t)).toContainText(`Line ${report.httpLine}`);
    await expect(t.getByRole('button', { name: 'Send for approval' })).toHaveCount(0);
    const forced = await t.request.post(`/officer-area/news/${id}/preview`, { form: { website: 'yes' }, headers: { Origin: EDITOR_REAL.siteUrl }, maxRedirects: 0 });
    expect(forced.status()).toBe(409);
    // Nor will the API mark it ready, asked directly.
    const tToken = await tokenFor('treasurer');
    expect(await codeOf(() => content.markReady({ itemId: id }, as(tToken)))).toBe('FailedPrecondition');
  });

  await test.step('fix the link, save, and send it: "Waiting for approval"', async () => {
    await t.goto(`/officer-area/news/${id}`);
    await textBox(t).fill(fixed);
    await saveTop(t).click();
    await expect(t.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
    await expect(problemsRegion(t)).toHaveCount(0);
    await t.getByRole('link', { name: 'Preview and send' }).click();
    await expect(t.getByRole('region', { name: 'What the public sees' })).toContainText(pub);
    await expect(t.getByRole('region', { name: 'What the public sees' })).not.toContainText(span);
    await expect(t.getByRole('region', { name: 'What members see' })).toContainText(span);
    await t.getByRole('button', { name: 'Send for approval' }).click();
    await expect(t).toHaveURL(`${EDITOR_REAL.siteUrl}${LIST}?sent=1`);
    await expect((await rowOf(t, title)).locator('.chip')).toHaveText('Waiting for approval');
  });

  const secrets = [pub, span, title];
  const member = await person(browser, 'member');
  const slug = (await content.getWorkingItem({ itemId: id }, as(await tokenFor('treasurer')))).item?.slug ?? '';
  expect(slug).not.toBe('');

  await test.step('another officer sees it waiting; the writer cannot approve it', async () => {
    const admin = await person(browser, 'admin');
    await admin.page.goto(LIST);
    await expect((await rowOf(admin.page, title)).locator('.chip')).toHaveText('Waiting for approval');
    await admin.context.close();
    // The President's approval screen is E4's: their queue on the API lists it as ready.
    const queue = await content.listWorkingItems({ versionStatuses: [VersionStatus.READY] }, as(await tokenFor('officer')));
    expect(queue.items.map((i) => i.id)).toContain(id);
    const tToken = await tokenFor('treasurer');
    const hash = (await content.getWorkingItem({ itemId: id }, as(tToken))).item?.working?.contentHash ?? new Uint8Array();
    expect(hash.length).toBe(32);
    expect(await codeOf(() => content.approve({ itemId: id, contentHash: hash }, as(tToken)))).toBe('PermissionDenied');
    expect(await codeOf(() => content.publish({ itemId: id, contentHash: hash }, as(tToken)))).toBe('PermissionDenied');
  });

  await test.step('waiting: the public and a member see nothing of it, on any page, feed or API read', async () => {
    await nothingPublic(secrets, 'ledger', 'waiting');
    await nothingForMember(member.page, secrets, 'waiting');
    const published = await content.listPublishedItems({ kind: ContentKind.ARTICLE });
    expect(published.items.map((i) => i.id)).not.toContain(id);
    expect(await codeOf(() => content.getPublishedItem({ slug }))).toBe('NotFound');
    expect(await codeOf(async () => content.getWorkingItem({ itemId: id }, as(await tokenFor('member'))))).toBe('PermissionDenied');
    expect(await codeOf(() => content.getWorkingItem({ itemId: id }))).toBe('Unauthenticated');
  });

  await test.step('the President approves it: "Approved, ready to publish", and still nobody outside sees it', async () => {
    const pToken = await tokenFor('officer');
    const hash = (await content.getWorkingItem({ itemId: id }, as(pToken))).item?.working?.contentHash ?? new Uint8Array();
    const approved = await content.approve({ itemId: id, contentHash: hash }, as(pToken));
    expect(approved.item?.working?.status).toBe(VersionStatus.CLEARED);
    await t.goto(LIST);
    await expect((await rowOf(t, title)).locator('.chip')).toHaveText('Approved, ready to publish');
    await nothingPublic(secrets, 'ledger', 'approved, not published');
    await nothingForMember(member.page, secrets, 'approved, not published');
    expect(await codeOf(() => content.getPublishedItem({ slug }))).toBe('NotFound');
    // An approver who is not the Webmaster or the Admin cannot publish it.
    expect(await codeOf(() => content.publish({ itemId: id, contentHash: hash }, as(pToken)))).toBe('PermissionDenied');
  });

  await test.step('the Webmaster publishes it; the public reads it with the members span withheld, and a member reads the span', async () => {
    const wToken = await tokenFor('webmaster');
    const hash = (await content.getWorkingItem({ itemId: id }, as(wToken))).item?.working?.contentHash ?? new Uint8Array();
    await content.publish({ itemId: id, contentHash: hash }, as(wToken));
    const bodies = await publicBodies([], 'ledger');
    const news = bodies.get('/news')!;
    expect(news.body).toContain(title);
    expect(news.body).toContain(pub);
    expect(news.body.includes(span), 'the public /news holds the members span').toBe(false);
    for (const [path, { body }] of bodies) expect(body.includes(span), `${path} holds the members span`).toBe(false);
    await member.page.goto('/news');
    const article = member.page.locator('article.item', { has: member.page.getByRole('heading', { name: title }) });
    await expect(article).toContainText(pub);
    await expect(article).toContainText(span);
    // The anonymous API read withholds it too.
    const read = JSON.stringify((await content.getPublishedItem({ slug })).item?.live?.body ?? {}, (_, v: unknown) => (typeof v === 'bigint' ? String(v) : v));
    expect(read.includes(pub)).toBe(true);
    expect(read.includes(span)).toBe(false);
  });

  await member.context.close();
  await treasurer.context.close();
});

test('the President cancels a series date and adds a one-off: /events and calendar.ics show both at once; the Treasurer cannot change them', async ({ browser }) => {
  const pToken = await tokenFor('officer');
  const today = centralToday();
  const seriesTitle = `Tuesday Lunchers ${marker('s')}`;
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const series = (
    await events.saveSeries(
      {
        series: {
          slug: marker('e7a-lunch-'),
          title: seriesTitle,
          category: EventCategory.LUNCH,
          recurrence: 'FREQ=WEEKLY;BYDAY=TU',
          cadenceLabel: 'Every Tuesday',
          defaultStart: { hours: 11, minutes: 30 },
          defaultDurationMinutes: 90,
          defaultVenueId: fixture.ids['bistro']!,
          area: Area.OKALOOSA,
          hostOfficeId: fixture.ids['president']!,
          visibility: EventVisibility.PUBLIC,
          startsOn: { year: y, month: m, day: d },
        },
      },
      as(pToken),
    )
  ).series!;
  // The Tuesday two weeks on.
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  const date = addDays(today, ((2 - weekday + 7) % 7) + 14);
  const note = `Hall closed ${marker('n')}`;

  const president = await person(browser, 'officer');
  const p = president.page;
  await p.goto(`/officer-area/events/${series.id}_${date}`);
  await expect(p.getByRole('heading', { level: 1 })).toHaveText(`Change: ${seriesTitle}`);
  await p.getByRole('radio', { name: 'Cancelled' }).check();
  await p.getByLabel('Note shown on the calendar').fill(note);
  await p.getByRole('button', { name: 'Save' }).click();
  await expect(p).toHaveURL(/\/officer-area\/events\/[0-9a-f-]{36}\?saved=1$/);
  const cancelledId = new URL(p.url()).pathname.split('/').pop()!;

  const oneOffTitle = `Board games ${marker('g')}`;
  const oneOffDate = addDays(today, 20);
  await p.goto('/officer-area/events/new');
  await p.getByLabel('Title').fill(oneOffTitle);
  await p.getByLabel('Date', { exact: true }).fill(oneOffDate);
  await p.getByLabel('Start time, in Central time').fill('18:30');
  await p.getByRole('radio', { name: 'Sample Bistro' }).check();
  await p.getByRole('radio', { name: 'Everyone' }).check();
  await p.getByRole('button', { name: 'Add the event' }).click();
  await expect(p).toHaveURL(/\/officer-area\/events\/[0-9a-f-]{36}\?saved=1$/);
  const oneOffId = new URL(p.url()).pathname.split('/').pop()!;

  // At once, for the public: no cache to wait out.
  const anon = await person(browser);
  await anon.page.goto(`/events?view=week&d=${date}`);
  const card = anon.page.locator(`li.ecard[data-card-day="${date}"]`, { hasText: seriesTitle });
  await expect(card).toContainText('Cancelled');
  await expect(card).toContainText(note);
  await anon.page.goto(`/events?view=week&d=${oneOffDate}`);
  await expect(anon.page.locator(`li.ecard[data-card-day="${oneOffDate}"]`, { hasText: oneOffTitle })).toBeVisible();
  const ics = (await (await anon.page.request.get('/calendar.ics')).text()).replace(/\r\n /g, '');
  const entries = ics.split('BEGIN:VEVENT');
  const cancelled = entries.find((e) => e.includes(`DTSTART;TZID=America/Chicago:${date.replaceAll('-', '')}T113000`) && e.includes(seriesTitle));
  expect(cancelled).toContain('STATUS:CANCELLED');
  expect(entries.some((e) => e.includes(`DTSTART;TZID=America/Chicago:${oneOffDate.replaceAll('-', '')}T183000`) && e.includes(oneOffTitle))).toBe(true);
  await anon.context.close();

  // The Treasurer: the page is not found, a post changes nothing, and the API refuses.
  const treasurer = await person(browser, 'treasurer');
  for (const target of [cancelledId, oneOffId, `${series.id}_${addDays(date, 7)}`]) {
    const res = await treasurer.page.goto(`/officer-area/events/${target}`);
    expect(res?.status(), `the Treasurer opens ${target}`).toBe(404);
    const post = await treasurer.page.request.post(`/officer-area/events/${target}`, {
      multipart: { title: 'Taken over', date: oneOffDate, time: '09:00', status: 'scheduled', statusNote: '', visibility: 'public', venue: 'later' },
      headers: { Origin: EDITOR_REAL.siteUrl },
      maxRedirects: 0,
    });
    expect(post.status(), `the Treasurer posts to ${target}`).toBe(404);
  }
  const tToken = await tokenFor('treasurer');
  const occurrence = (await events.getOccurrence({ id: oneOffId }, as(pToken))).occurrence!;
  expect(await codeOf(() => events.saveOccurrence({ occurrence: { ...occurrence, title: 'Taken over' } }, as(tToken)))).toBe('PermissionDenied');
  expect(await codeOf(() => events.saveOccurrence({ occurrence: { ...occurrence, status: OccurrenceStatus.CANCELLED } }, as(tToken)))).toBe('PermissionDenied');
  expect(await codeOf(() => events.saveSeries({ series: { ...series, title: 'Taken over' } }, as(tToken)))).toBe('PermissionDenied');
  const after = (await events.getOccurrence({ id: oneOffId }, as(pToken))).occurrence!;
  expect(after.title).toBe(oneOffTitle);
  await treasurer.context.close();
  await president.context.close();
});
