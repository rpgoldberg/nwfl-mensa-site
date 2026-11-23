// EDITOR E7b: the red team's attacks on rollout 2's approve and publish screens and the link gate, on the
// REAL stack (playwright.editor-real.config.ts). Each is a test: who may approve and publish (the writer,
// an editor of the version, the Admin's break-glass, one approver), an edit after approval and a takedown
// each voiding the approval, stale hashes on Approve, Publish and the link answers (one item's links hash
// replayed on another), two tabs and a double publish, cross-site posts and other methods on every new
// form, a reviewer with part of the piece hidden (on the API, as the site's own guard is partial-view's),
// cancelled events and members-passage links in the gate, and a sign-in that lapses mid-review. Synthetic
// data only.
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { createClient } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import { expect, test } from '@playwright/test';
import { MarkField, MarkSubjectKind, RedactionCategory, RedactionPolicyService } from '../../../api/src/gen/nwfl/mensa/v1/redaction_pb';
import { ApprovalRule, ApprovalRuleService, ApprovalScope } from '../../src/gen/nwfl/mensa/v1/approval_pb.js';
import { ContentKind, ItemState, ItemVisibility, VersionStatus } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { EventVisibility, OccurrenceStatus } from '../../src/gen/nwfl/mensa/v1/event_pb.js';
import { answerEveryLink, as, codeOf, content, events, tokenFor } from './api';
import { marker, person, publicBodies } from './helpers';
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

const transport = createGrpcTransport({
  baseUrl: EDITOR_REAL.apiUrl,
  defaultTimeoutMs: 10_000,
});
const rules = createClient(ApprovalRuleService, transport);
/** As partial-view.spec.ts types it: the site generates no redaction client. */
interface Marks {
  addRedactionMark(
    mark: {
      subjectKind: MarkSubjectKind;
      subjectId: string;
      field: MarkField;
      quote: string;
      category: RedactionCategory;
    },
    options: ReturnType<typeof as>,
  ): Promise<unknown>;
}
const marks = createClient(RedactionPolicyService, transport) as unknown as Marks;

const REVIEW = (id: string) => `/officer-area/approvals/${id}`;
const WEBSITE = { website: true, newsletter: false, email: false };
const tok = (login: string) => tokenFor(login);

/** A piece of `office`'s, written (and sent for approval, unless `send` is false) by `writer`, on the API. */
async function piece(markup: string, { office = 'treasurer', writer = 'treasurer', send = true } = {}): Promise<{ id: string; title: string }> {
  const t = await tok(writer);
  const title = `E7b ${marker('x')}`;
  const made = await content.createItem(
    {
      kind: ContentKind.ARTICLE,
      officeId: ids[office]!,
      slug: marker('e7b-'),
      title,
    },
    as(t),
  );
  const id = made.item!.id;
  await content.saveDraft(
    {
      itemId: id,
      title,
      summary: '',
      visibility: ItemVisibility.PUBLIC,
      bodyMarkup: markup,
    },
    as(t),
  );
  if (send) await content.markReady({ itemId: id, targets: WEBSITE }, as(t));
  return { id, title };
}
const itemAs = async (id: string, login = 'officer') => (await content.getWorkingItem({ itemId: id }, as(await tok(login)))).item!;
const hashAs = async (id: string, login = 'officer') => (await itemAs(id, login)).working!.contentHash;
const approveAs = async (id: string, login: string) => content.approve({ itemId: id, contentHash: await hashAs(id, login) }, as(await tok(login)));
const publishAs = async (id: string, login = 'webmaster') => content.publish({ itemId: id, contentHash: await hashAs(id, login) }, as(await tok(login)));
/** Yes on each of `urls`, by `login`, with the list hash they read. */
async function answerYes(id: string, login: string, urls: string[]) {
  const t = await tok(login);
  const list = await content.getItemLinks({ itemId: id }, as(t));
  return content.confirmLinks(
    {
      itemId: id,
      linksSha256: list.linksSha256,
      answers: urls.map((url) => ({ url, yes: true, note: '' })),
    },
    as(t),
  );
}
/** The Treasurer changes the text (a new sentence), and sends it again unless `send` is false. */
async function edit(id: string, title: string, markup: string, send = true) {
  const t = await tok('treasurer');
  await content.saveDraft(
    {
      itemId: id,
      title,
      summary: '',
      visibility: ItemVisibility.PUBLIC,
      bodyMarkup: markup,
    },
    as(t),
  );
  if (send) await content.markReady({ itemId: id, targets: WEBSITE }, as(t));
}
const actions = async (id: string) => (await content.listItemHistory({ itemId: id }, as(await tok('admin')))).entries.map((e) => e.action);

test.describe('who may approve and publish', () => {
  test('an editor of the version and its writer are refused; the Admin break-glass needs the gate and someone else publishes', async ({ browser }) => {
    const fb = `https://www.facebook.com/e7b-${marker('')}`;
    const { id, title } = await piece(`Photos are [here](${fb}).`, {
      send: false,
    });
    // The Admin edits the Treasurer's draft: an editor of this version from now on.
    await content.saveDraft(
      {
        itemId: id,
        title,
        summary: '',
        visibility: ItemVisibility.PUBLIC,
        bodyMarkup: `Photos, the Admin's words, are [here](${fb}).`,
      },
      as(await tok('admin')),
    );
    await content.markReady({ itemId: id, targets: WEBSITE }, as(await tok('treasurer')));
    const seen = (await itemAs(id, 'admin')).working!;
    expect([seen.callerEdited, seen.callerMayApprove]).toEqual([true, false]);
    const hash = seen.contentHash;
    expect(await codeOf(async () => content.approve({ itemId: id, contentHash: hash }, as(await tok('admin'))))).toBe('PermissionDenied');
    expect(await codeOf(async () => content.approve({ itemId: id, contentHash: hash }, as(await tok('treasurer'))))).toBe('PermissionDenied');
    expect(await codeOf(() => answerYes(id, 'admin', [fb]))).toBe('PermissionDenied');
    expect(await codeOf(() => answerYes(id, 'treasurer', [fb]))).toBe('PermissionDenied');

    const { context, page } = await person(browser, 'admin');
    await page.goto(REVIEW(id));
    await expect(page.getByText('You changed this version, so another officer must approve it.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save my answers' })).toHaveCount(0);
    await expect(page.getByText('You changed this version, so someone else must check its links.')).toBeVisible();
    // A forged Approve from the Admin's own page: refused by the API, nothing approved.
    const forged = await page.request.post(REVIEW(id), {
      form: {
        step: 'approve',
        hash: Buffer.from(hash).toString('hex'),
        links_hash: '',
      },
      headers: { Origin: EDITOR_REAL.siteUrl },
      maxRedirects: 0,
    });
    expect(forged.status()).toBe(403);
    // Break-glass waits on the gate too: the Facebook link needs a yes from someone who did not edit it.
    await page.getByLabel('Approve my own change (break-glass): your reason').fill('The Treasurer is away; the picnic is Saturday.');
    await page.getByRole('button', { name: 'Approve my own change (break-glass)' }).click();
    await expect(page.getByRole('alert')).toContainText('1 link needs a sign-in to check');
    expect((await itemAs(id)).working!.status).toBe(VersionStatus.READY);
    await answerYes(id, 'officer', [fb]);
    await page.goto(REVIEW(id));
    await page.getByLabel('Approve my own change (break-glass): your reason').fill('The Treasurer is away; the picnic is Saturday.');
    await page.getByRole('button', { name: 'Approve my own change (break-glass)' }).click();
    await expect(page).toHaveURL(new RegExp(`${REVIEW(id)}\\?done=approved$`));
    const cleared = (await itemAs(id, 'admin')).working!;
    expect([cleared.status, cleared.approvalKindSelf, cleared.callerMayPublish]).toEqual([VersionStatus.CLEARED, true, false]);
    // Its approver cannot publish it: no Publish on the page, the confirm page sends them back, a forced post is refused.
    await expect(page.getByRole('link', { name: 'Publish', exact: true })).toHaveCount(0);
    await expect(page.getByText('It was approved as its approver’s own change, so someone other than that approver publishes it.')).toBeVisible();
    await page.goto(`${REVIEW(id)}/publish`);
    await expect(page).toHaveURL(new RegExp(`${REVIEW(id)}$`));
    const forcedPublish = await page.request.post(`${REVIEW(id)}/publish`, {
      form: { hash: Buffer.from(cleared.contentHash).toString('hex') },
      headers: { Origin: EDITOR_REAL.siteUrl },
      maxRedirects: 0,
    });
    expect(forcedPublish.status()).toBe(403);
    expect(await codeOf(() => publishAs(id, 'admin'))).toBe('PermissionDenied');
    expect((await itemAs(id)).state).not.toBe(ItemState.PUBLISHED);
    await context.close();
    await publishAs(id, 'webmaster');
    expect((await itemAs(id)).state).toBe(ItemState.PUBLISHED);
    expect(await actions(id)).toEqual(expect.arrayContaining(['approve_self', 'publish']));
  });

  test('under one approver an officer still cannot approve their own piece; the Admin may, but cannot publish it, and the rule is read again at Publish', async () => {
    const admin = await tok('admin');
    const setRule = async (rule: ApprovalRule) => {
      const now = (await rules.getApprovalRules({}, as(admin))).settings.find((s) => s.scope === ApprovalScope.CONTENT);
      if (now?.rule === rule) return;
      await rules.setApprovalRule(
        {
          scope: ApprovalScope.CONTENT,
          rule,
          reason: 'E7b red team, put back after',
        },
        as(admin),
      );
    };
    await setRule(ApprovalRule.ONE_APPROVER);
    try {
      const own = await piece('A plain note, no links.');
      expect(await codeOf(() => approveAs(own.id, 'treasurer'))).toBe('PermissionDenied');
      // The Admin writes for the Treasurer and approves it alone (self_single); someone else publishes it.
      const mine = await piece('The Admin, for the Treasurer.', {
        writer: 'admin',
      });
      await approveAs(mine.id, 'admin');
      const cleared = (await itemAs(mine.id, 'admin')).working!;
      expect([cleared.status, cleared.approvalKindSelf]).toEqual([VersionStatus.CLEARED, true]);
      expect(await codeOf(() => publishAs(mine.id, 'admin'))).toBe('PermissionDenied');
      // A second one, approved alone, then the rule goes back to two people before anyone publishes (N5).
      const later = await piece('The Admin, for the Treasurer, again.', {
        writer: 'admin',
      });
      await approveAs(later.id, 'admin');
      await setRule(ApprovalRule.TWO_PERSON);
      expect(await codeOf(() => publishAs(later.id, 'webmaster'))).toBe('FailedPrecondition');
      expect(await codeOf(() => publishAs(mine.id, 'webmaster'))).toBe('FailedPrecondition');
      expect((await itemAs(mine.id)).state).not.toBe(ItemState.PUBLISHED);
    } finally {
      await setRule(ApprovalRule.TWO_PERSON);
    }
  });
});

test.describe('an approval voided', () => {
  test('an edit after approval voids it: the old hash cannot publish, and the link answers count again only once given again', async () => {
    const fb = `https://www.facebook.com/e7b-${marker('')}`;
    const markup = `Photos are [here](${fb}).`;
    const { id, title } = await piece(markup);
    await answerYes(id, 'two-seats', [fb]);
    await approveAs(id, 'officer');
    const old = await hashAs(id, 'webmaster');
    await edit(id, title, `${markup}\n\nOne more line.`, false);
    expect((await itemAs(id)).working!.status).toBe(VersionStatus.DRAFT);
    expect(await actions(id)).toContain('approval_voided');
    expect(await codeOf(async () => content.publish({ itemId: id, contentHash: old }, as(await tok('webmaster'))))).toBe('FailedPrecondition');
    await content.markReady({ itemId: id, targets: WEBSITE }, as(await tok('treasurer')));
    // The yes was for the version as it was ready then: the gate holds again.
    const links = await content.getItemLinks({ itemId: id }, as(await tok('officer')));
    expect(links.links.find((l) => l.url === fb)?.answeredByLabel).toBe('');
    expect(await codeOf(() => approveAs(id, 'officer'))).toBe('FailedPrecondition');
    await answerYes(id, 'two-seats', [fb]);
    await approveAs(id, 'officer');
    await publishAs(id);
    expect((await itemAs(id)).state).toBe(ItemState.PUBLISHED);
  });

  test('Take down voids an approved change waiting to be published, and Publish then needs the explicit "put it back"', async ({ browser }) => {
    const { id, title } = await piece('First words.');
    await approveAs(id, 'officer');
    await publishAs(id);
    const changed = `Second words ${marker('w')}.`;
    await edit(id, title, changed);
    await approveAs(id, 'officer');
    expect((await itemAs(id)).working!.status).toBe(VersionStatus.CLEARED);

    const { context, page } = await person(browser, 'webmaster');
    await page.goto(REVIEW(id));
    await page.getByRole('link', { name: 'Take down', exact: true }).click();
    await expect(page.getByText('An approved change was waiting to be published; it will need approving again.')).toBeVisible();
    await page.getByRole('button', { name: 'Take it down' }).click();
    await expect(page.getByRole('status')).toHaveText('Taken down. It is no longer on the website.');
    const after = await itemAs(id);
    expect([after.state, after.working?.status]).toEqual([ItemState.WITHDRAWN, VersionStatus.DRAFT]);
    expect(await actions(id)).toEqual(expect.arrayContaining(['withdraw', 'approval_voided']));
    for (const [path, { body }] of await publicBodies([], 'words')) expect(body.includes(title), `${path} after the takedown`).toBe(false);

    // Approved again, it is published only with the tick.
    await content.markReady({ itemId: id, targets: WEBSITE }, as(await tok('treasurer')));
    await approveAs(id, 'officer');
    expect(await codeOf(() => publishAs(id))).toBe('FailedPrecondition');
    await page.goto(`${REVIEW(id)}/publish`);
    await expect(page.getByText('Publishing puts it back on the website.')).toBeVisible();
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(page.getByText('Tick the box to put it back on the website.').first()).toBeVisible();
    expect((await itemAs(id)).state).toBe(ItemState.WITHDRAWN);
    await page.getByRole('checkbox', { name: 'Yes, put it back on the website' }).check();
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Published. It is on the website now.');
    expect((await itemAs(id)).state).toBe(ItemState.PUBLISHED);
    expect((await publicBodies([], 'words')).get('/news')!.body).toContain(changed);
    await context.close();
  });
});

test.describe('stale hashes', () => {
  test('a page opened before a change: its answers, its Approve and its Publish are refused, and so are the old hashes on the API', async ({ browser }) => {
    const fb = `https://www.facebook.com/e7b-${marker('')}`;
    const markup = `Photos are [here](${fb}), the hall is [here](https://hall.example/e7b).`;
    const { id, title } = await piece(markup);
    const oldLinks = (await content.getItemLinks({ itemId: id }, as(await tok('two-seats')))).linksSha256;
    const oldHash = await hashAs(id);
    const second = await person(browser, 'two-seats');
    const president = await person(browser, 'officer');
    await second.page.goto(REVIEW(id));
    await president.page.goto(REVIEW(id));
    // The Treasurer changes it and sends it again while both pages are open.
    await edit(id, title, `${markup}\n\nA line added.`);

    // The answers: the list's hash moved on (its ready time), so nothing is saved and the list is shown again.
    const panel = second.page.getByRole('region', { name: 'Check the links' });
    await panel
      .getByRole('listitem')
      .filter({
        has: second.page.getByRole('heading', { name: 'here', exact: true }),
      })
      .first()
      .getByRole('radio', { name: 'Yes' })
      .check();
    const [answer] = await Promise.all([second.page.waitForResponse((r) => r.request().method() === 'POST'), panel.getByRole('button', { name: 'Save my answers' }).click()]);
    expect(answer.status()).toBe(409);
    await expect(second.page.getByRole('alert')).toContainText('The links of this piece changed since you opened the page, so nothing was saved.');
    expect(
      await codeOf(async () =>
        content.confirmLinks(
          {
            itemId: id,
            linksSha256: oldLinks,
            answers: [{ url: fb, yes: true, note: '' }],
          },
          as(await tok('two-seats')),
        ),
      ),
    ).toBe('FailedPrecondition');
    expect((await content.getItemLinks({ itemId: id }, as(await tok('officer')))).links.filter((l) => l.answeredByLabel !== '')).toEqual([]);

    // Approve from the page opened before: refused, still waiting. (L-ITEM: every link answered, so only the hash refuses.)
    await answerEveryLink(id);
    const [approve] = await Promise.all([president.page.waitForResponse((r) => r.request().method() === 'POST'), president.page.getByRole('button', { name: 'Approve', exact: true }).click()]);
    expect(approve.status()).toBe(409);
    await expect(president.page.getByRole('alert')).toContainText('It was not approved: it changed since you opened it.');
    expect(await codeOf(async () => content.approve({ itemId: id, contentHash: oldHash }, as(await tok('officer'))))).toBe('Aborted');
    expect((await itemAs(id)).working!.status).toBe(VersionStatus.READY);

    // Publish from a confirm page opened before a change: refused, not published.
    await approveAs(id, 'officer');
    const webmaster = await person(browser, 'webmaster');
    await webmaster.page.goto(`${REVIEW(id)}/publish`);
    const clearedHash = await hashAs(id);
    await edit(id, title, `${markup}\n\nAnother line.`);
    await answerEveryLink(id);
    await approveAs(id, 'officer');
    const [publish] = await Promise.all([webmaster.page.waitForResponse((r) => r.request().method() === 'POST'), webmaster.page.getByRole('button', { name: 'Publish', exact: true }).click()]);
    expect(publish.status()).toBe(409);
    await expect(webmaster.page.getByRole('alert')).toContainText('It was not published: it changed since you opened it.');
    expect(await codeOf(async () => content.publish({ itemId: id, contentHash: clearedHash }, as(await tok('webmaster'))))).toBe('Aborted');
    expect((await itemAs(id)).state).not.toBe(ItemState.PUBLISHED);
    for (const p of [second, president, webmaster]) await p.context.close();
  });

  test("one piece's links hash and rows, replayed on another with the same links, are refused", async ({ browser }) => {
    const fb = `https://www.facebook.com/e7b-${marker('')}`;
    const markup = `Same links: [here](${fb}).`;
    const a = await piece(markup);
    const b = await piece(markup);
    const t = await tok('two-seats');
    const listA = await content.getItemLinks({ itemId: a.id }, as(t));
    const listB = await content.getItemLinks({ itemId: b.id }, as(t));
    expect(listA.links.map((l) => [l.url, l.where])).toEqual(listB.links.map((l) => [l.url, l.where]));
    // Bound to each version's ready time, so the two hashes differ even for the same list.
    expect(Buffer.from(listA.linksSha256).equals(Buffer.from(listB.linksSha256))).toBe(false);
    expect(
      await codeOf(() =>
        content.confirmLinks(
          {
            itemId: b.id,
            linksSha256: listA.linksSha256,
            answers: [{ url: fb, yes: true, note: '' }],
          },
          as(t),
        ),
      ),
    ).toBe('FailedPrecondition');
    // On the site: A's page's form posted to B's page.
    const { context, page } = await person(browser, 'two-seats');
    await page.goto(REVIEW(a.id));
    const form = Object.fromEntries(
      await page.locator('form[data-review] input[type="hidden"]').evaluateAll((inputs) => inputs.map((i) => [(i as HTMLInputElement).name, (i as HTMLInputElement).value])),
    ) as Record<string, string>;
    const res = await page.request.post(REVIEW(b.id), {
      form: { ...form, 'answer-0': 'yes', step: 'links' },
      headers: { Origin: EDITOR_REAL.siteUrl },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(409);
    expect((await content.getItemLinks({ itemId: b.id }, as(t))).links.filter((l) => l.answeredByLabel !== '')).toEqual([]);
    // And A's content hash cannot approve B.
    expect(await codeOf(async () => content.approve({ itemId: b.id, contentHash: await hashAs(a.id) }, as(await tok('officer'))))).not.toBe('OK');
    expect((await itemAs(b.id)).working!.status).toBe(VersionStatus.READY);
    await context.close();
  });
});

test.describe('two tabs and a double publish', () => {
  test('Approve twice and Publish twice from two tabs: one of each lands, the second is told plainly, and the API refuses a second publish', async ({ browser }) => {
    const { id } = await piece('Two tabs.');
    const { context, page } = await person(browser, 'officer');
    const tab2 = await context.newPage();
    await page.goto(REVIEW(id));
    await tab2.goto(REVIEW(id));
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Approved.');
    const [second] = await Promise.all([tab2.waitForResponse((r) => r.request().method() === 'POST'), tab2.getByRole('button', { name: 'Approve', exact: true }).click()]);
    expect(second.status()).toBe(409);
    await expect(tab2.getByRole('alert')).toContainText('It was not approved');
    await context.close();

    const clearedHash = await hashAs(id);
    const w = await person(browser, 'webmaster');
    const wTab2 = await w.context.newPage();
    await w.page.goto(`${REVIEW(id)}/publish`);
    await wTab2.goto(`${REVIEW(id)}/publish`);
    await w.page.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(w.page.getByRole('status')).toHaveText('Published. It is on the website now.');
    const [again] = await Promise.all([wTab2.waitForResponse((r) => r.request().method() === 'POST'), wTab2.getByRole('button', { name: 'Publish', exact: true }).click()]);
    expect(again.status()).toBe(409);
    await expect(wTab2.getByRole('alert')).toContainText('It was not published');
    expect(await codeOf(async () => content.publish({ itemId: id, contentHash: clearedHash }, as(await tok('webmaster'))))).toBe('FailedPrecondition');
    const history = await actions(id);
    expect(history.filter((a) => a === 'approve')).toHaveLength(1);
    expect(history.filter((a) => a === 'publish')).toHaveLength(1);
    await w.context.close();
  });
});

test.describe('cross-site posts and other methods', () => {
  test('every review, publish and take-down form refuses a post from another site, and no other method changes anything', async ({ browser }) => {
    const fb = `https://www.facebook.com/e7b-${marker('')}`;
    const waiting = await piece(`Photos [here](${fb}).`);
    const cleared = await piece('Approved, waiting.');
    await approveAs(cleared.id, 'officer');
    const live = await piece('On the website.');
    await approveAs(live.id, 'officer');
    await publishAs(live.id);
    const hex = async (id: string) => Buffer.from(await hashAs(id)).toString('hex');
    const linksHex = Buffer.from((await content.getItemLinks({ itemId: waiting.id }, as(await tok('webmaster')))).linksSha256).toString('hex');
    const targets: { path: string; form: Record<string, string> }[] = [
      {
        path: REVIEW(waiting.id),
        form: {
          step: 'links',
          links_hash: linksHex,
          'row-0': 'x',
          'answer-0': 'yes',
        },
      },
      {
        path: REVIEW(waiting.id),
        form: {
          step: 'approve',
          hash: await hex(waiting.id),
          links_hash: linksHex,
        },
      },
      {
        path: REVIEW(waiting.id),
        form: {
          step: 'break-glass',
          hash: await hex(waiting.id),
          reason: 'Forged',
        },
      },
      { path: REVIEW(waiting.id), form: { step: 'send-back', note: 'Forged' } },
      {
        path: `${REVIEW(cleared.id)}/publish`,
        form: { hash: await hex(cleared.id) },
      },
      { path: `${REVIEW(live.id)}/take-down`, form: {} },
    ];
    const forgers: {
      name: string;
      headers: Record<string, string>;
      type?: 'text' | 'urlencoded';
    }[] = [
      {
        name: 'Origin of another site',
        headers: { Origin: 'https://evil.example' },
      },
      { name: 'Origin null', headers: { Origin: 'null' } },
      {
        name: 'Sec-Fetch-Site cross-site',
        headers: {
          'Sec-Fetch-Site': 'cross-site',
          Origin: 'https://evil.example',
        },
      },
      {
        name: 'the http origin of this host',
        headers: { Origin: EDITOR_REAL.siteUrl.replace('https:', 'http:') },
      },
      {
        name: 'text/plain from another site',
        headers: {
          Origin: 'https://evil.example',
          'Content-Type': 'text/plain',
        },
        type: 'text',
      },
      {
        name: 'no Origin, a cross-site Referer',
        headers: { Referer: 'https://evil.example/page' },
      },
      {
        name: 'upper-case form type from another site',
        headers: {
          Origin: 'https://evil.example',
          'Content-Type': 'APPLICATION/X-WWW-FORM-URLENCODED',
        },
        type: 'urlencoded',
      },
    ];
    // The Admin may do every one of these, so only the origin check stands between a forger and each.
    const { context, page } = await person(browser, 'admin');
    for (const { path, form } of targets) {
      for (const forger of forgers) {
        const options =
          forger.type === 'text'
            ? {
                data: new URLSearchParams(form).toString(),
                headers: forger.headers,
                maxRedirects: 0,
              }
            : forger.type === 'urlencoded'
              ? {
                  data: new URLSearchParams(form).toString(),
                  headers: forger.headers,
                  maxRedirects: 0,
                }
              : { form, headers: forger.headers, maxRedirects: 0 };
        const res = await page.request.post(path, options);
        expect(res.status(), `${path} ${form['step'] ?? ''}, ${forger.name}`).toBe(403);
      }
      // GET (the form as a query), PUT, PATCH and DELETE, same site: none acts.
      const query = `${path}?${new URLSearchParams(form).toString()}`;
      for (const method of ['GET', 'PUT', 'PATCH', 'DELETE'] as const) {
        const res = await page.request.fetch(method === 'GET' ? query : path, {
          method,
          headers: { Origin: EDITOR_REAL.siteUrl },
          ...(method === 'GET' ? {} : { form }),
          maxRedirects: 0,
        });
        expect(res.status(), `${method} ${path}`).toBeLessThan(500);
      }
    }
    expect((await itemAs(waiting.id)).working!.status).toBe(VersionStatus.READY);
    expect((await content.getItemLinks({ itemId: waiting.id }, as(await tok('officer')))).links.filter((l) => l.answeredByLabel !== '')).toEqual([]);
    expect((await itemAs(cleared.id)).working!.status).toBe(VersionStatus.CLEARED);
    expect((await itemAs(cleared.id)).state).not.toBe(ItemState.PUBLISHED);
    expect((await itemAs(live.id)).state).toBe(ItemState.PUBLISHED);
    await context.close();
  });
});

test.describe('a reviewer with part of the piece hidden', () => {
  test('on the API directly: no answers, no Approve, no break-glass, no Publish, even with an officer hash; Send back works', async ({ browser }) => {
    const phone = '850-555-0177';
    const fine = 'https://example.org/e7b-fine';
    const president = await tok('officer');
    const make = async () => {
      const { id } = await piece(`Call ${phone}, or see ${fine}.`, {
        office: 'president',
        writer: 'officer',
        send: false,
      });
      await marks.addRedactionMark(
        {
          subjectKind: MarkSubjectKind.CONTENT_ITEM,
          subjectId: id,
          field: MarkField.BODY,
          quote: phone,
          category: RedactionCategory.MEMBER_PHONE,
        },
        as(president),
      );
      await content.markReady({ itemId: id, targets: WEBSITE }, as(president));
      return id;
    };
    const waiting = await make();
    const approved = await make();
    // L-ITEM: every link needs a yes first (no link checker runs on this stack).
    await answerEveryLink(approved);
    await approveAs(approved, 'treasurer');
    const lone = await tok('lone-webmaster');
    expect((await content.getWorkingItem({ itemId: waiting }, as(lone))).item!.working!.contentHash).toHaveLength(0);
    const officerHash = await hashAs(waiting, 'treasurer');
    const list = await content.getItemLinks({ itemId: waiting }, as(lone));
    expect(
      await codeOf(() =>
        content.confirmLinks(
          {
            itemId: waiting,
            linksSha256: list.linksSha256,
            answers: [{ url: fine, yes: true, note: '' }],
          },
          as(lone),
        ),
      ),
    ).toBe('FailedPrecondition');
    expect(await codeOf(() => content.approve({ itemId: waiting, contentHash: officerHash }, as(lone)))).toBe('FailedPrecondition');
    expect(
      await codeOf(() =>
        content.approve(
          {
            itemId: waiting,
            contentHash: officerHash,
            breakGlass: true,
            breakGlassReason: 'Forged',
          },
          as(lone),
        ),
      ),
    ).not.toBe('OK');
    expect(
      await codeOf(async () =>
        content.publish(
          {
            itemId: approved,
            contentHash: await hashAs(approved, 'treasurer'),
          },
          as(lone),
        ),
      ),
    ).toBe('FailedPrecondition');
    expect((await itemAs(waiting)).working!.status).toBe(VersionStatus.READY);
    expect((await itemAs(approved)).state).not.toBe(ItemState.PUBLISHED);

    // On the page: only Send back, and it works.
    const { context, page } = await person(browser, 'lone-webmaster');
    await page.goto(REVIEW(approved));
    await expect(page.getByRole('link', { name: 'Publish', exact: true })).toHaveCount(0);
    await page.goto(REVIEW(waiting));
    await expect(page.locator('form[data-review] button')).toHaveText(['Send back']);
    await page.getByLabel('Note for the writer').fill('Please check the phone number with the member first.');
    await page.getByRole('button', { name: 'Send back' }).click();
    // WEB-SMALL-1: the queue's done banner names the piece sent back (its id), so it can read it.
    await expect(page).toHaveURL(new RegExp(`/officer-area/approvals\\?done=sent-back&id=${waiting}$`));
    expect((await itemAs(waiting)).working!.status).toBe(VersionStatus.DRAFT);
    await context.close();
  });
});

test.describe('the link gate', () => {
  test('a cancelled event stays in the gate, and a link inside the members passage is listed for every reviewer', async () => {
    const m = marker('');
    const eventFb = `https://www.facebook.com/events/e7b-${m}`;
    const membersFb = `https://www.facebook.com/groups/e7b-members-${m}`;
    const treasurer = await tok('treasurer');
    const saved = await events.saveOccurrence(
      {
        occurrence: {
          title: `Dues night ${m}`,
          startsAt: timestampFromDate(new Date(Date.now() + 12 * 86_400_000)),
          visibility: EventVisibility.PUBLIC,
          status: OccurrenceStatus.SCHEDULED,
          url: eventFb,
          ownerOfficeId: ids['treasurer']!,
        },
        venueDecidedLater: true,
      },
      as(treasurer),
    );
    // Out of every later piece's window when done (92 days with no edition): there is no delete, and a
    // cancelled event stays in the gate, so a later Treasurer's piece in this run would list it.
    const away = async () => {
      const now = (await events.getOccurrence({ id: saved.occurrence!.id }, as(treasurer))).occurrence!;
      await events.saveOccurrence(
        {
          occurrence: {
            ...now,
            startsAt: timestampFromDate(new Date(Date.now() + 200 * 86_400_000)),
          },
          venueDecidedLater: true,
        },
        as(treasurer),
      );
    };
    try {
      const { id } = await piece(`Open words. :members[Members see [the members page](${membersFb}).]`);
      for (const login of ['two-seats', 'officer', 'webmaster', 'admin', 'lone-webmaster', 'lone-admin']) {
        const urls = (await content.getItemLinks({ itemId: id }, as(await tok(login)))).links.map((l) => l.url);
        expect(urls, `${login}'s list`).toEqual(expect.arrayContaining([eventFb, membersFb]));
      }
      await events.saveOccurrence(
        {
          occurrence: {
            ...saved.occurrence!,
            status: OccurrenceStatus.CANCELLED,
            statusNote: 'Hall closed',
          },
          venueDecidedLater: true,
        },
        as(treasurer),
      );
      const after = await content.getItemLinks({ itemId: id }, as(await tok('officer')));
      expect(after.links.map((l) => l.url)).toContain(eventFb);
      const refused = await content.approve({ itemId: id, contentHash: await hashAs(id) }, as(await tok('officer'))).then(
        () => 'OK',
        (e: Error) => e.message,
      );
      expect(refused).toContain('2 links need a sign-in to check');
      await answerYes(id, 'two-seats', [eventFb, membersFb]);
      await approveAs(id, 'officer');
      expect((await itemAs(id)).working!.status).toBe(VersionStatus.CLEARED);
    } finally {
      await away();
    }
  });
});

test.describe('a sign-in that lapses mid-review', () => {
  test('the answers saved before it are kept; what was typed after is shown back, and nothing else is saved', async ({ browser }) => {
    test.setTimeout(120_000);
    const fb = `https://www.facebook.com/e7b-${marker('')}`;
    const other = 'https://hall.example/e7b-lapse';
    // The President's piece: the Treasurer reviews it, with a token that lives 45 s (the site sends none in its last 30).
    const { id } = await piece(`Photos [here](${fb}); the hall is [there](${other}).`, { office: 'president', writer: 'officer' });
    const { context, page } = await person(browser, 'writer-lapsing');
    const signedInAt = Date.now();
    await page.goto(REVIEW(id));
    const panel = page.getByRole('region', { name: 'Check the links' });
    const row = (name: string) => panel.getByRole('listitem').filter({ has: page.getByRole('heading', { name, exact: true }) });
    await row('here').getByRole('radio', { name: 'Yes' }).check();
    await panel.getByRole('button', { name: 'Save my answers' }).click();
    await expect(page.getByRole('status')).toHaveText('Your answers are saved.');
    await page.waitForTimeout(Math.max(0, signedInAt + 17_000 - Date.now()));
    const note = `Typed after the sign-in ran out ${marker('n')}`;
    await row('there').getByRole('radio', { name: 'No' }).check();
    await row('there')
      .getByLabel(/^Note \(optional\)/)
      .fill(note);
    await panel.getByRole('button', { name: 'Save my answers' }).click();
    await expect(page.getByRole('alert')).toContainText('Sign in again; your saved answers are kept.');
    await expect(page.getByRole('region', { name: 'What you typed' })).toContainText(note);
    const links = (await content.getItemLinks({ itemId: id }, as(await tok('officer')))).links;
    expect(links.find((l) => l.url === fb)).toMatchObject({
      accepted: true,
      answeredByLabel: 'Treasurer',
    });
    expect(links.find((l) => l.url === other)?.answeredByLabel).toBe('');
    await context.close();
  });
});
