// EDITOR E7b: rollout 2's round trip on the REAL stack (playwright.editor-real.config.ts), every step on
// its screen: the Treasurer writes a piece with a Facebook link and an event page, and the Treasurer's own
// upcoming event carries a web address too (S7: the office's events join the piece's link gate); a second
// officer  checks the links and answers yes on the
// Facebook one; until then the President's Approve is refused; the saved answer survives a reload and a
// fresh sign-in; the President approves; the Webmaster publishes; the public reads it with the members
// span withheld and a member reads the span. Synthetic data only.
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { expect, test } from '@playwright/test';
import { VersionStatus } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { EventVisibility, OccurrenceStatus } from '../../src/gen/nwfl/mensa/v1/event_pb.js';
import { as, content, events, tokenFor } from './api';
import { LIST, createItem, marker, person, publicBodies, rowOf, saveTop, textBox } from './helpers';
import { EDITOR_REAL } from './servers';

let ids: Record<string, string>;
test.beforeAll(async ({ playwright }) => {
  const ctx = await playwright.request.newContext();
  ids = (
    (await (await ctx.get(`${EDITOR_REAL.stackUrl}/fixture`)).json()) as {
      ids: Record<string, string>;
    }
  ).ids;
  await ctx.dispose();
});

const REVIEW = (id: string) => `/officer-area/approvals/${id}`;

test('the Treasurer writes, a second officer checks the Facebook link, the President approves, the Webmaster publishes, and the public reads it with the members span withheld', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const m = marker('');
  const pub = `e7bpublic${m}`;
  const span = `e7bspan${m}`;
  const title = `Picnic fund ${marker('t')}`;
  const facebook = `https://www.facebook.com/groups/e7b-synthetic-${m}`;
  const eventPage = `https://events.example/e7b-picnic-${m}`;
  const officeEventUrl = `https://club.example/e7b-tickets-${m}`;
  const eventTitle = `Picnic tickets ${marker('ev')}`;

  // The Treasurer's own upcoming event, with a web address: S7 puts it in the piece's links.
  await events.saveOccurrence(
    {
      occurrence: {
        title: eventTitle,
        startsAt: timestampFromDate(new Date(Date.now() + 10 * 86_400_000)),
        visibility: EventVisibility.PUBLIC,
        status: OccurrenceStatus.SCHEDULED,
        url: officeEventUrl,
        ownerOfficeId: ids['treasurer']!,
      },
      venueDecidedLater: true,
    },
    as(await tokenFor('treasurer')),
  );

  const markup = [
    `Picnic fund ${pub}: the totals are in.`,
    '',
    `Members note :members[the gate code is ${span}] for the day.`,
    '',
    `Photos are on [our Facebook page](${facebook}).`,
    '',
    `Tickets are on [the event page](${eventPage}).`,
  ].join('\n');

  const treasurer = await person(browser, 'treasurer');
  const t = treasurer.page;
  const id = await createItem(t, title);
  await textBox(t).fill(markup);
  await saveTop(t).click();
  await expect(t.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
  await t.getByRole('link', { name: 'Preview and send' }).click();
  await t.getByRole('button', { name: 'Send for approval' }).click();
  await expect(t).toHaveURL(`${EDITOR_REAL.siteUrl}${LIST}?sent=1`);
  await expect((await rowOf(t, title)).locator('.chip')).toHaveText('Waiting for approval');

  await test.step('before any answer, the President cannot approve: the Facebook link needs a sign-in to check', async () => {
    const president = await person(browser, 'officer');
    const p = president.page;
    await p.goto(REVIEW(id));
    await p.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(p.getByRole('alert')).toContainText('1 link needs a sign-in to check (such as Facebook)');
    expect((await content.getWorkingItem({ itemId: id }, as(await tokenFor('officer')))).item?.working?.status).toBe(VersionStatus.READY);
    await president.context.close();
  });

  const second = await person(browser, 'two-seats');
  const s = second.page;
  const panel = s.getByRole('region', { name: 'Check the links' });
  const rowFor = (text: string) => panel.getByRole('listitem').filter({ has: s.getByRole('heading', { name: text, exact: true }) });

  await test.step('a second officer finds it in Approve news, and the links panel lists all three, the Facebook one as needing a sign-in', async () => {
    await s.goto('/officer-area/approvals');
    await s.getByRole('table').getByRole('link', { name: title, exact: true }).click();
    await expect(s).toHaveURL(new RegExp(`${REVIEW(id)}$`));
    await expect(panel).toContainText('0 of 3 links checked.');
    await expect(rowFor('our Facebook page')).toContainText(facebook);
    await expect(rowFor('our Facebook page')).toContainText('Needs a sign-in to check');
    await expect(rowFor('the event page')).toContainText(eventPage);
    await expect(rowFor('the event page')).not.toContainText('Needs a sign-in to check');
    const eventRow = rowFor(officeEventUrl);
    await expect(eventRow).toContainText(eventTitle);
    // Open: a new tab, no opener.
    const open = rowFor('our Facebook page').getByRole('link', {
      name: /^Open the link \(opens a new tab\)/,
    });
    await expect(open).toHaveAttribute('target', '_blank');
    await expect(open).toHaveAttribute('rel', 'noopener noreferrer');
  });

  await test.step('they answer yes on the Facebook link, and Save my answers', async () => {
    // The stack's roster holds the President's and the Treasurer's offices only, so a holder of two other
    // seats acts as an officer: the "Acting as" choice is the stand-in suite's (editor-review.spec.ts).
    await expect(s.locator('#acting')).toHaveText('Acting as: Officer');
    await rowFor('our Facebook page').getByRole('radio', { name: 'Yes' }).check();
    await panel.getByRole('button', { name: 'Save my answers' }).click();
    await expect(s).toHaveURL(new RegExp(`${REVIEW(id)}\\?done=answers#links$`));
    await expect(s.getByRole('status')).toHaveText('Your answers are saved.');
    await expect(panel).toContainText('1 of 3 links checked.');
    await expect(rowFor('our Facebook page')).toContainText('Checked by Officer: it shows the right page.');
  });

  await test.step('the saved answer survives a reload, and a fresh sign-in with no tab copy', async () => {
    await s.reload();
    await expect(rowFor('our Facebook page').getByRole('radio', { name: 'Yes' })).toBeChecked();
    await expect(rowFor('our Facebook page')).toContainText('Checked by Officer');
    await second.context.close();
    const again = await person(browser, 'two-seats');
    await again.page.goto(REVIEW(id));
    const row = again.page
      .getByRole('region', { name: 'Check the links' })
      .getByRole('listitem')
      .filter({
        has: again.page.getByRole('heading', {
          name: 'our Facebook page',
          exact: true,
        }),
      });
    await expect(row.getByRole('radio', { name: 'Yes' })).toBeChecked();
    await expect(row).toContainText('Checked by Officer: it shows the right page.');
    await again.context.close();
  });

  await test.step('the President approves on the screen: approved, not yet published, and no Publish for them', async () => {
    const president = await person(browser, 'officer');
    const p = president.page;
    await p.goto(REVIEW(id));
    await expect(p.locator('#acting')).toContainText('Acting as: President');
    await p.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(p).toHaveURL(new RegExp(`${REVIEW(id)}\\?done=approved$`));
    await expect(p.getByRole('status')).toHaveText('Approved. This does not publish it yet. The Webmaster publishes it.');
    await expect(p.getByRole('link', { name: 'Publish', exact: true })).toHaveCount(0);
    await expect(p.getByText('The Webmaster publishes it, or the Admin as backup.')).toBeVisible();
    await t.goto(LIST);
    await expect((await rowOf(t, title)).locator('.chip')).toHaveText('Approved, ready to publish');
    const bodies = await publicBodies([], 'picnic');
    for (const [path, { body }] of bodies) {
      for (const secret of [pub, span, title]) expect(body.includes(secret), `${path} holds ${secret.slice(0, 12)}... before Publish`).toBe(false);
    }
    await president.context.close();
  });

  await test.step('the Webmaster publishes from its confirm page', async () => {
    const webmaster = await person(browser, 'webmaster');
    const w = webmaster.page;
    await w.goto(REVIEW(id));
    await expect(w.getByText('Approved by the President. It is ready to publish.')).toBeVisible();
    await w.getByRole('link', { name: 'Publish', exact: true }).click();
    await expect(w).toHaveURL(new RegExp(`${REVIEW(id)}/publish$`));
    await w.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(w).toHaveURL(new RegExp(`${REVIEW(id)}\\?done=published$`));
    await expect(w.getByRole('status')).toHaveText('Published. It is on the website now.');
    await webmaster.context.close();
  });

  await test.step('the public reads it with the members span withheld; a member reads the span', async () => {
    const bodies = await publicBodies([], 'picnic');
    const news = bodies.get('/news')!;
    expect(news.body).toContain(title);
    expect(news.body).toContain(pub);
    for (const [path, { body }] of bodies) expect(body.includes(span), `${path} holds the members span`).toBe(false);
    const anon = await person(browser);
    await anon.page.goto('/news');
    const anonArticle = anon.page.locator('article.item', {
      has: anon.page.getByRole('heading', { name: title }),
    });
    await expect(anonArticle).toContainText(pub);
    await expect(anonArticle).not.toContainText(span);
    await anon.context.close();
    const member = await person(browser, 'member');
    await member.page.goto('/news');
    const article = member.page.locator('article.item', {
      has: member.page.getByRole('heading', { name: title }),
    });
    await expect(article).toContainText(pub);
    await expect(article).toContainText(span);
    await member.context.close();
    const slug = (await content.getWorkingItem({ itemId: id }, as(await tokenFor('treasurer')))).item?.slug ?? '';
    const read = JSON.stringify((await content.getPublishedItem({ slug })).item?.live?.body ?? {}, (_, v: unknown) => (typeof v === 'bigint' ? String(v) : v));
    expect(read).toContain(pub);
    expect(read.includes(span)).toBe(false);
  });

  await treasurer.context.close();
});
