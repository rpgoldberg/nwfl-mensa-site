// EDITOR E7a: the red team's attacks on the officers' editor, on the REAL stack
// (playwright.editor-real.config.ts). Each is a test: another office's item and occurrence by id, on the
// pages and on the API; the Admin acting for an office, recorded as such; a cross-site post to every form
// and to the auto-save; a GET of the auto-save; two tabs and a double submit (the base conflict keeps the
// text, a stale save of exactly what is saved changes nothing); markup injection in the text and in an
// event's fields; a body one byte over 48 KiB, a 64 KiB form, nesting at and past the cap, and bracket
// bombs, each answered fast; a sign-in that lapses mid-edit, with the text kept and the auto-save stopped;
// and a pasted list of people, accepted with only the warning (a known limit). Synthetic data only.
import { type Page, expect, test } from '@playwright/test';
import { ContentKind, ItemVisibility, VersionStatus } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { addDays, centralToday } from '../stand-in';
import { as, codeOf, content, events, tokenFor } from './api';
import { EDIT, LIST, createItem, marker, person, problemsRegion, saveTop, textBox } from './helpers';
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

const ORIGIN = { Origin: EDITOR_REAL.siteUrl };

/** The edit form as a page posts it, with the base it was opened from. */
function editForm(base: string, markup: string, title = 'Edited', visibility = 'public') {
  return { base, title, summary: '', visibility, markup };
}

/** The base the edit page was opened from (its hidden field). */
const baseOf = (page: Page) => page.locator('form[data-editor] input[name="base"]').inputValue();

/** A President's draft, made on the API, with its id and markup. */
async function presidentDraft(markup: string): Promise<{ id: string; title: string }> {
  const token = await tokenFor('officer');
  const title = `President note ${marker('p')}`;
  const made = await content.createItem({ kind: ContentKind.ANNOUNCEMENT, officeId: fixture.ids['president']!, slug: marker('pn-'), title }, as(token));
  const id = made.item!.id;
  await content.saveDraft({ itemId: id, title, summary: '', visibility: ItemVisibility.PUBLIC, bodyMarkup: markup }, as(token));
  return { id, title };
}

const markupOf = async (id: string) => (await content.getWorkingItem({ itemId: id }, as(await tokenFor('officer')))).item?.working?.bodyMarkup;
const historyOf = async (id: string) => (await content.listItemHistory({ itemId: id }, as(await tokenFor('officer')))).entries;

test.describe('another office, by id', () => {
  test("the Treasurer cannot read, save, send or auto-save the President's item on the pages, nor on the API", async ({ browser }) => {
    const original = `Untouched ${marker('u')}`;
    const { id } = await presidentDraft(original);
    const { context, page } = await person(browser, 'treasurer');
    for (const path of [`/officer-area/news/${id}`, `/officer-area/news/${id}/preview`]) {
      expect((await page.goto(path))?.status(), `GET ${path}`).toBe(404);
    }
    const posts = [
      { path: `/officer-area/news/${id}`, form: editForm('', 'Taken over') },
      { path: `/officer-area/news/${id}/autosave`, form: editForm('', 'Taken over') },
      { path: `/officer-area/news/${id}/preview`, form: { website: 'yes' } },
    ];
    for (const { path, form } of posts) {
      const res = await page.request.post(path, { multipart: form, headers: ORIGIN, maxRedirects: 0 });
      expect([403, 404], `POST ${path}: ${res.status()}`).toContain(res.status());
    }
    expect(await markupOf(id)).toBe(original);
    const t = await tokenFor('treasurer');
    expect(await codeOf(() => content.saveDraft({ itemId: id, title: 'Taken over', visibility: ItemVisibility.PUBLIC, bodyMarkup: 'Taken over' }, as(t)))).toBe('PermissionDenied');
    expect(await codeOf(() => content.saveDraft({ itemId: id, title: 'Taken over', visibility: ItemVisibility.PUBLIC, bodyMarkup: 'Taken over', auto: true }, as(t)))).toBe('PermissionDenied');
    expect(await codeOf(() => content.markReady({ itemId: id }, as(t)))).toBe('PermissionDenied');
    expect(await codeOf(() => content.withdraw({ itemId: id }, as(t)))).toBe('PermissionDenied');
    expect(await codeOf(() => content.createItem({ kind: ContentKind.ANNOUNCEMENT, officeId: fixture.ids['president']!, slug: marker('x-'), title: 'Posing' }, as(t)))).toBe('PermissionDenied');
    // An id that is no item, and one that is not an id: not found, the same as another office's.
    expect((await page.goto('/officer-area/news/00000000-0000-4000-8000-000000000000'))?.status()).toBe(404);
    expect([400, 404]).toContain((await page.goto('/officer-area/news/..%2f..%2fadmin'))?.status());
    expect(await markupOf(id)).toBe(original);
    await context.close();
  });

  test('the Admin writes for the Treasurer: allowed, and each step is recorded as the Admin, for that office', async ({ browser }) => {
    const { context, page } = await person(browser, 'admin');
    const title = `For the office ${marker('a')}`;
    await page.goto(LIST);
    await page.getByRole('link', { name: 'Write something new' }).click();
    await page.getByRole('radio', { name: 'News article', exact: true }).check();
    await page.getByRole('group', { name: 'Posting as' }).getByRole('radio', { name: 'Treasurer (for the office)', exact: true }).check();
    await page.getByRole('textbox', { name: 'Title', exact: true }).fill(title);
    await page.getByRole('button', { name: 'Create draft' }).click();
    await expect(page).toHaveURL(EDIT);
    const id = EDIT.exec(page.url())?.[1] as string;
    await textBox(page).fill('Written by the Admin for the office.');
    await saveTop(page).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
    const entries = await historyOf(id);
    expect(entries.map((e) => [e.action, e.actingOfficeId, e.actorLabel])).toEqual([
      ['create', fixture.ids['treasurer'], 'Admin'],
      ['save', fixture.ids['treasurer'], 'Admin'],
    ]);
    await context.close();
  });
});

test.describe('cross-site posts', () => {
  test('every officer form and the auto-save refuse a post from another site, and nothing changes', async ({ browser }) => {
    const { context, page } = await person(browser, 'officer');
    const original = `Kept ${marker('k')}`;
    const { id } = await presidentDraft(original);
    // The seeded potluck, a one-off of the President's.
    const occurrence = { id: fixture.ids['potluck']! };
    const before = (await events.getOccurrence({ id: occurrence.id }, as(await tokenFor('officer')))).occurrence!;
    expect(before.title).toBe('Potluck');
    const targets = [
      { path: '/officer-area/news/new', form: { kind: 'announcement', title: 'Forged' } },
      { path: `/officer-area/news/${id}`, form: editForm('', 'Forged') },
      { path: `/officer-area/news/${id}/autosave`, form: editForm('', 'Forged') },
      { path: `/officer-area/news/${id}/preview`, form: { website: 'yes' } },
      { path: '/officer-area/events/new', form: { title: 'Forged', date: addDays(centralToday(), 30), time: '10:00', status: 'scheduled', visibility: 'public', venue: 'later' } },
      { path: `/officer-area/events/${occurrence!.id}`, form: { title: 'Forged', date: addDays(centralToday(), 30), time: '10:00', status: 'cancelled', visibility: 'public', venue: 'later' } },
      { path: '/officer-area/approval-rules', form: { rule: 'one_approver' } },
    ];
    const forgers: Array<{ name: string; headers: Record<string, string>; type?: string }> = [
      { name: 'Origin of another site', headers: { Origin: 'https://evil.example' } },
      { name: 'Origin null (a sandboxed frame)', headers: { Origin: 'null' } },
      { name: 'Sec-Fetch-Site cross-site', headers: { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example' } },
      { name: 'the http origin of this host', headers: { Origin: EDITOR_REAL.siteUrl.replace('https:', 'http:') } },
      { name: 'text/plain from another site', headers: { Origin: 'https://evil.example', 'Content-Type': 'text/plain' }, type: 'text' },
      // No Origin at all, only a Referer from elsewhere: the site server refuses what Astro would let through.
      { name: 'no Origin, a cross-site Referer', headers: { Referer: 'https://evil.example/page' } },
      { name: 'upper-case form type from another site', headers: { Origin: 'https://evil.example', 'Content-Type': 'APPLICATION/X-WWW-FORM-URLENCODED' }, type: 'urlencoded' },
    ];
    for (const { path, form } of targets) {
      for (const forger of forgers) {
        const options =
          forger.type === 'text'
            ? { data: 'title=Forged', headers: forger.headers, maxRedirects: 0 }
            : forger.type === 'urlencoded'
              ? { data: new URLSearchParams(form as Record<string, string>).toString(), headers: forger.headers, maxRedirects: 0 }
              : { multipart: form, headers: forger.headers, maxRedirects: 0 };
        const res = await page.request.post(path, options);
        expect(res.status(), `${path}, ${forger.name}`).toBe(403);
      }
    }
    expect(await markupOf(id)).toBe(original);
    const after = (await events.getOccurrence({ id: occurrence!.id }, as(await tokenFor('officer')))).occurrence!;
    expect([after.title, after.status]).toEqual([before.title, before.status]);
    await context.close();
  });

  test('a GET of the auto-save finds nothing to read: 405, POST only, never cached', async ({ browser }) => {
    const { context, page } = await person(browser, 'officer');
    const { id } = await presidentDraft('Anything');
    const res = await page.request.get(`/officer-area/news/${id}/autosave`);
    expect(res.status()).toBe(405);
    expect(res.headers()['allow']).toBe('POST');
    expect(res.headers()['cache-control']).toContain('no-store');
    expect(await res.text()).not.toContain('Anything');
    await context.close();
  });
});

test.describe('two tabs and a double submit', () => {
  test('a save from a tab someone else changed since keeps its text and writes nothing; the same text again is a no-op', async ({ browser }) => {
    const { context, page: a } = await person(browser, 'treasurer');
    const id = await createItem(a, `Two tabs ${marker('tt')}`);
    const b = await context.newPage();
    const c = await context.newPage();
    await b.goto(`/officer-area/news/${id}`);
    await c.goto(`/officer-area/news/${id}`);
    await textBox(a).fill('Text from tab A.');
    await saveTop(a).click();
    await expect(a.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
    const saves = (await historyOf(id)).length;

    await textBox(b).fill('Text from tab B, typed at length.');
    await saveTop(b).click();
    await expect(b.getByRole('alert')).toContainText('Nothing was saved: someone else changed this draft since you opened it.');
    await expect(textBox(b)).toHaveValue('Text from tab B, typed at length.');
    expect(await markupOf(id)).toBe('Text from tab A.');

    // Tab C, opened before A saved, sends exactly what A saved: nobody is overwritten, nothing is written.
    await textBox(c).fill('Text from tab A.');
    await saveTop(c).click();
    await expect(c).toHaveURL(new RegExp(`/officer-area/news/${id}\\?saved=1$`));
    expect((await historyOf(id)).length).toBe(saves);
    await context.close();
  });

  test('the auto-save of a tab someone else changed since stops with its text kept, and sends nothing more', async ({ browser }) => {
    const { context, page: a } = await person(browser, 'treasurer');
    const id = await createItem(a, `Auto conflict ${marker('ac')}`);
    const b = await context.newPage();
    await b.clock.install();
    await b.goto(`/officer-area/news/${id}`);
    const sent: number[] = [];
    b.on('response', (r) => {
      if (r.url().endsWith('/autosave')) sent.push(r.status());
    });
    await textBox(a).fill('Saved first in tab A.');
    await saveTop(a).click();
    await expect(a.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
    await textBox(b).pressSequentially('Tab B types.');
    await b.clock.runFor(61_000);
    await expect(b.locator('[data-autosave-status]')).toHaveText('Not saved: someone else changed this draft. Your text is kept here.');
    await expect(b.locator('[data-autosave-conflict]')).toBeVisible();
    await textBox(b).pressSequentially(' More.');
    await b.clock.runFor(5 * 61_000);
    expect(sent).toEqual([409]);
    await expect(textBox(b)).toHaveValue('Tab B types. More.');
    expect(await markupOf(id)).toBe('Saved first in tab A.');
    await context.close();
  });

  test('Send for approval twice at once marks it ready once; two saves at once of different text: one wins, one is refused', async ({ browser }) => {
    const { context, page } = await person(browser, 'treasurer');
    const id = await createItem(page, `Double ${marker('d')}`);
    const base = await baseOf(page);
    const [one, two] = await Promise.all([
      page.request.post(`/officer-area/news/${id}`, { multipart: editForm(base, 'First of two.', 'Double'), headers: ORIGIN, maxRedirects: 0 }),
      page.request.post(`/officer-area/news/${id}`, { multipart: editForm(base, 'Second of two.', 'Double'), headers: ORIGIN, maxRedirects: 0 }),
    ]);
    expect([one.status(), two.status()].sort()).toEqual([303, 409]);
    const sends = await Promise.all([1, 2, 3].map(() => page.request.post(`/officer-area/news/${id}/preview`, { form: { website: 'yes', newsletter: 'yes' }, headers: ORIGIN, maxRedirects: 0 })));
    expect(sends.map((r) => r.status()).filter((s) => s === 303)).toHaveLength(1);
    expect(sends.map((r) => r.status()).every((s) => s === 303 || s === 409 || s === 400)).toBe(true);
    const entries = await historyOf(id);
    expect(entries.filter((e) => e.action === 'ready')).toHaveLength(1);
    expect((await content.getWorkingItem({ itemId: id }, as(await tokenFor('treasurer')))).item?.working?.status).toBe(VersionStatus.READY);

    // Approved on the hash the approver saw; then three publishes at once: one goes live, once.
    const p = await tokenFor('officer');
    const hash = (await content.getWorkingItem({ itemId: id }, as(p))).item!.working!.contentHash;
    await content.approve({ itemId: id, contentHash: hash }, as(p));
    const w = await tokenFor('webmaster');
    const publishes = await Promise.all([1, 2, 3].map(() => codeOf(() => content.publish({ itemId: id, contentHash: hash }, as(w)))));
    expect(publishes.filter((c) => c === 'OK')).toHaveLength(1);
    expect(publishes.filter((c) => c !== 'OK').every((c) => c === 'FailedPrecondition')).toBe(true);
    expect((await historyOf(id)).filter((e) => e.action === 'publish')).toHaveLength(1);
    await context.close();
  });

  test('an approval or a publish bound to a hash the version has moved on from is refused', async () => {
    const t = await tokenFor('treasurer');
    const title = `Hash ${marker('h')}`;
    const id = (await content.createItem({ kind: ContentKind.ARTICLE, officeId: fixture.ids['treasurer']!, slug: marker('h-'), title }, as(t))).item!.id;
    await content.saveDraft({ itemId: id, title, visibility: ItemVisibility.PUBLIC, bodyMarkup: 'First text.' }, as(t));
    await content.markReady({ itemId: id }, as(t));
    const p = await tokenFor('officer');
    const seen = (await content.getWorkingItem({ itemId: id }, as(p))).item!.working!.contentHash;
    await content.saveDraft({ itemId: id, title, visibility: ItemVisibility.PUBLIC, bodyMarkup: 'Changed after the approver looked.' }, as(t));
    await content.markReady({ itemId: id }, as(t));
    expect(await codeOf(() => content.approve({ itemId: id, contentHash: seen }, as(p)))).toBe('Aborted');
    const now = (await content.getWorkingItem({ itemId: id }, as(p))).item!.working!.contentHash;
    await content.approve({ itemId: id, contentHash: now }, as(p));
    expect(await codeOf(async () => content.publish({ itemId: id, contentHash: seen }, as(await tokenFor('webmaster'))))).toBe('Aborted');
  });
});

/** What a script injected into a page would leave: a flag, an element, an attribute. */
async function injected(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found: string[] = [];
    const w = window as unknown as Record<string, unknown>;
    // The text's markup may read a pair of underscores as emphasis: either name is the payload's.
    for (const name of ['__e7a', 'e7a']) if (w[name] !== undefined) found.push(`window.${name} = ${String(w[name])}`);
    for (const s of document.querySelectorAll('script')) if (s.textContent?.includes('e7a')) found.push('a script element');
    for (const s of document.querySelectorAll('style')) if (s.textContent?.includes('e7a')) found.push('a style element');
    for (const el of document.querySelectorAll('*')) {
      for (const attr of el.getAttributeNames()) if (attr.startsWith('on') && el.getAttribute(attr)?.includes('e7a')) found.push(`${el.tagName} ${attr}`);
      for (const attr of ['href', 'src', 'action', 'formaction']) {
        // As a browser reads an address: tabs, line breaks and other control characters dropped.
        const v = [...(el.getAttribute(attr) ?? '')].filter((ch) => ch.charCodeAt(0) > 0x20).join('').toLowerCase();
        if (v.startsWith('javascript:') || v.startsWith('data:') || v.startsWith('vbscript:')) found.push(`${el.tagName} ${attr}=${v.slice(0, 20)}`);
      }
    }
    return found;
  });
}

test.describe('markup injection', () => {
  const RAW = [
    '<script>window.__e7a = 1</script>',
    '<style>.e7a { display: none }</style>',
    '<img src=x onerror="window.__e7a = 2">',
    '<a href="javascript:window.__e7a=3">raw anchor</a>',
    '<svg onload="window.__e7a = 4"></svg>',
    ':members[<img src=x onerror="window.__e7a = 5">]',
    '[quote break](https://club.example/a" onmouseover="window.__e7a=6)',
    '**<b onclick="window.__e7a=7">bold</b>**',
  ];
  const SCHEMES = ['[a](javascript:window.__e7a=8)', '[b](data:text/html;base64,PHNjcmlwdD53aW5kb3cuX19lN2E9OTwvc2NyaXB0Pg==)', '[c](JaVaScRiPt:window.__e7a=10)', '[d](vbscript:msgbox)', '[e](java\tscript:window.__e7a=11)', '[f](//evil.example/x)'];

  test('script, style, handlers and javascript:/data: links in the text: the bad links are listed by line and block it; the rest is shown as text everywhere', async ({ browser }) => {
    const writer = await person(browser, 'treasurer');
    const t = writer.page;
    const title = `Injection ${marker('i')}`;
    const id = await createItem(t, title);
    const lines = [...RAW, ...SCHEMES].flatMap((l) => [l, '']);
    await textBox(t).fill(lines.join('\n'));
    await saveTop(t).click();
    await expect(t.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
    const listed = await problemsRegion(t).getByRole('link').allTextContents();
    for (const [n, line] of SCHEMES.entries()) {
      // A tab in the address makes it no link at all (CommonMark): it stays text, which injected() checks below.
      if (line.includes('\t')) continue;
      const at = 2 * (RAW.length + n) + 1;
      expect(listed.some((text) => text.startsWith(`Line ${at}:`)), `the ${line.slice(0, 12)} link on line ${at} is listed (${listed.join(' | ')})`).toBe(true);
    }
    expect(await injected(t)).toEqual([]);
    await t.goto(`/officer-area/news/${id}/preview`);
    expect(await injected(t)).toEqual([]);
    await expect(t.getByRole('button', { name: 'Send for approval' })).toHaveCount(0);

    // Without the bad links it goes through, and every reader sees the rest as text.
    await t.goto(`/officer-area/news/${id}`);
    await textBox(t).fill(RAW.flatMap((l) => [l, '']).join('\n'));
    await saveTop(t).click();
    await expect(problemsRegion(t)).toHaveCount(0);
    await t.goto(`/officer-area/news/${id}/preview`);
    expect(await injected(t)).toEqual([]);
    await t.getByRole('button', { name: 'Send for approval' }).click();
    await expect(t).toHaveURL(/\?sent=1$/);
    for (const login of ['officer', 'webmaster']) {
      const token = await tokenFor(login);
      const hash = (await content.getWorkingItem({ itemId: id }, as(token))).item?.working?.contentHash;
      if (login === 'officer') await content.approve({ itemId: id, contentHash: hash! }, as(token));
      else await content.publish({ itemId: id, contentHash: hash! }, as(token));
    }
    const anon = await person(browser);
    await anon.page.goto('/news');
    await expect(anon.page.getByRole('heading', { name: title })).toBeVisible();
    expect(await injected(anon.page)).toEqual([]);
    const html = await (await anon.page.request.get('/news')).text();
    expect(html).toMatch(/&lt;script&gt;window\.(__)?e7a = 1&lt;\/script&gt;/);
    const member = await person(browser, 'member');
    await member.page.goto('/news');
    await expect(member.page.getByRole('heading', { name: title })).toBeVisible();
    expect(await injected(member.page)).toEqual([]);
    for (const p of [anon, member, writer]) await p.context.close();
  });

  test("an event's title, note, details and address carry no script to the calendar, its page or the ICS", async ({ browser }) => {
    const { context, page } = await person(browser, 'officer');
    const date = addDays(centralToday(), 24);
    const title = `Night <script>window.__e7a=20</script> ${marker('ev')}`;
    await page.goto('/officer-area/events/new');
    await page.getByLabel('Title').fill(title);
    await page.getByLabel('Date', { exact: true }).fill(date);
    await page.getByLabel('Start time, in Central time').fill('19:00');
    await page.getByRole('radio', { name: 'Sample Bistro' }).check();
    await page.getByLabel('Details').fill('<img src=x onerror="window.__e7a=21"> Bring a game.');
    await page.getByRole('radio', { name: 'Everyone' }).check();
    for (const url of ['javascript:window.__e7a=22', 'data:text/html,<script>window.__e7a=23</script>', 'JAVASCRIPT:window.__e7a=24']) {
      await page.getByLabel(/web address/i).fill(url);
      await page.getByRole('button', { name: 'Add the event' }).click();
      await expect(page).toHaveURL(/\/officer-area\/events\/new$/);
      await expect(page.getByRole('heading', { name: /There is a problem/ })).toBeVisible();
      expect(await injected(page)).toEqual([]);
    }
    await page.getByLabel(/web address/i).fill('https://club.example/night?a="><script>window.__e7a=25</script>');
    await page.getByRole('button', { name: 'Add the event' }).click();
    await expect(page).toHaveURL(/\/officer-area\/events\/[0-9a-f-]{36}\?saved=1$/);
    const id = new URL(page.url()).pathname.split('/').pop()!;
    expect(await injected(page)).toEqual([]);
    const anon = await person(browser);
    await anon.page.goto(`/events?view=week&d=${date}`);
    await expect(anon.page.locator(`li.ecard[data-card-day="${date}"]`, { hasText: title })).toBeVisible();
    expect(await injected(anon.page), 'the week').toEqual([]);
    await anon.page.goto(`/events/${id}`);
    await expect(anon.page.getByRole('heading', { level: 1 })).toContainText(title);
    await expect(anon.page.getByText('Bring a game.')).toBeVisible();
    expect(await injected(anon.page), 'the event page').toEqual([]);
    const ics = await (await anon.page.request.get('/calendar.ics')).text();
    expect(ics).toContain('Bring a game.');
    expect(ics).not.toMatch(/^URL[^:]*:\s*javascript:/im);
    await anon.context.close();
    await context.close();
  });
});

test.describe('size, depth and bracket bombs', () => {
  test('a text one byte over 48 KiB is refused with the text kept; the API refuses it too; a 64 KiB form is refused before it is read', async ({ browser }) => {
    const { context, page } = await person(browser, 'treasurer');
    const id = await createItem(page, `Too long ${marker('l')}`);
    const over = 'x'.repeat(48 * 1024 + 1);
    await textBox(page).fill(over);
    await saveTop(page).click();
    await expect(page.locator('#markup-error')).toContainText('The text is too long: at most 48 KiB');
    expect((await textBox(page).inputValue()).length).toBe(over.length);
    const t = await tokenFor('treasurer');
    expect(await codeOf(() => content.saveDraft({ itemId: id, title: 'Too long', visibility: ItemVisibility.PUBLIC, bodyMarkup: over }, as(t)))).toBe('InvalidArgument');
    // Exactly 48 KiB saves.
    expect(await codeOf(() => content.saveDraft({ itemId: id, title: 'Too long', visibility: ItemVisibility.PUBLIC, bodyMarkup: over.slice(1) }, as(t)))).toBe('OK');
    const base = await baseOf(page);
    for (const [size, path] of [[57 * 1024, `/officer-area/news/${id}`], [64 * 1024, `/officer-area/news/${id}`], [64 * 1024, `/officer-area/news/${id}/autosave`], [80 * 1024, `/officer-area/news/${id}/autosave`]] as const) {
      const res = await page.request.post(path, { multipart: { ...editForm(base, 'y'.repeat(size)), title: 'Big' }, headers: ORIGIN, maxRedirects: 0 });
      expect(res.status(), `${size} bytes to ${path}`).toBe(413);
    }
    await context.close();
  });

  test('nesting: at the cap it saves; one past it is refused with the reason, and the text kept', async ({ browser }) => {
    const { context, page } = await person(browser, 'treasurer');
    const id = await createItem(page, `Deep ${marker('n')}`);
    const t = await tokenFor('treasurer');
    const quotes = (n: number) => `${'> '.repeat(n)}deep`;
    const save = (markup: string) => codeOf(() => content.saveDraft({ itemId: id, title: 'Deep', visibility: ItemVisibility.PUBLIC, bodyMarkup: markup }, as(t)));
    const outcomes: Record<number, string> = {};
    for (const n of [20, 22, 23, 24, 25, 30, 200]) outcomes[n] = await save(quotes(n));
    // Somewhere at or under 24 levels it saves, and past that it is refused; never anything else.
    const depths = Object.keys(outcomes).map(Number);
    const firstRefused = depths.find((n) => outcomes[n] !== 'OK');
    expect(firstRefused, JSON.stringify(outcomes)).toBeDefined();
    expect(firstRefused!).toBeLessThanOrEqual(25);
    for (const n of depths) expect(outcomes[n], JSON.stringify(outcomes)).toBe(n < firstRefused! ? 'OK' : 'InvalidArgument');
    await page.reload();
    await textBox(page).fill(quotes(200));
    await saveTop(page).click();
    await expect(page.getByRole('alert')).toContainText('Nothing was saved: nested too deeply');
    await expect(textBox(page)).toHaveValue(quotes(200));
    await context.close();
  });

  test('bracket bombs of 48 KiB are answered within two seconds by the API and the page', async ({ browser }) => {
    const { context, page } = await person(browser, 'treasurer');
    const id = await createItem(page, `Bomb ${marker('b')}`);
    const t = await tokenFor('treasurer');
    const fill = (unit: string) => unit.repeat(Math.floor((48 * 1024) / Buffer.byteLength(unit)));
    const bombs = { open: fill('['), members: fill(':members['), link: fill('[]('), mixed: fill('[*_`:members['), close: fill(']'), fences: fill('::: members\n') };
    const times: Record<string, number> = {};
    for (const [name, markup] of Object.entries(bombs)) {
      const started = performance.now();
      const code = await codeOf(() => content.saveDraft({ itemId: id, title: 'Bomb', visibility: ItemVisibility.PUBLIC, bodyMarkup: markup }, as(t)));
      await content.previewWorkingItem({ itemId: id }, as(t)).catch(() => undefined);
      times[name] = Math.round(performance.now() - started);
      expect(['OK', 'InvalidArgument'], `${name}: ${code}`).toContain(code);
      expect(times[name], `${name} took ${times[name]} ms`).toBeLessThan(2000);
    }
    const started = performance.now();
    await page.reload();
    await textBox(page).fill(bombs.mixed);
    await saveTop(page).click();
    await page.waitForLoadState('load');
    times['page'] = Math.round(performance.now() - started);
    expect(times['page'], `the page took ${times['page']} ms`).toBeLessThan(5000);
    test.info().annotations.push({ type: 'bracket bomb times (ms)', description: JSON.stringify(times) });
    await context.close();
  });
});

test.describe('a sign-in that lapses mid-edit', () => {
  test('the auto-save stops cleanly, Save draft keeps the text on the page and in the tab, and nothing is written', async ({ browser }) => {
    test.setTimeout(150_000);
    const { context, page } = await person(browser, 'writer-lapsing');
    const signedInAt = Date.now();
    const id = await createItem(page, `Lapsing ${marker('lp')}`);
    await page.clock.install();
    await page.reload();
    const sent: number[] = [];
    page.on('response', (r) => {
      if (r.url().endsWith('/autosave')) sent.push(r.status());
    });
    const typed = `Typed while the sign-in ran out ${marker('k')}.`;
    // The token lives 45 s, and the site sends none in its last 30: wait out the first 15, and a little more.
    await page.waitForTimeout(Math.max(0, signedInAt + 17_000 - Date.now()));
    await textBox(page).fill(typed);
    await page.clock.runFor(61_000);
    await expect(page.locator('[data-autosave-status]')).toHaveText('Not saved automatically: your sign-in has ended. Your text is kept here: press Save draft.');
    await page.clock.runFor(5 * 61_000);
    expect(sent).toEqual([401]);
    const key = await page.locator('form[data-editor]').getAttribute('data-draft-key');
    const tabCopy = await page.evaluate((k) => sessionStorage.getItem(k ?? ''), key);
    expect(tabCopy ?? '', 'the tab keeps its unsent copy').toContain(typed);
    await saveTop(page).click();
    await expect(page.getByRole('alert')).toContainText('Your sign-in timed out. Your text is still here.');
    await expect(textBox(page)).toHaveValue(typed);
    expect(await codeOf(async () => content.getWorkingItem({ itemId: id }, as(await tokenFor('officer'))))).toBe('OK');
    expect(await markupOf(id)).toBe('');
    await context.close();
  });
});

test('a pasted list of people is accepted with only the roster warning (a known limit: nothing reads the text for one)', async ({ browser }) => {
  const { context, page } = await person(browser, 'treasurer');
  await createItem(page, `New members ${marker('nm')}`);
  const list = ['New members this month:', '', '- Avery Placeholder, Destin, joined 10/03', '- Jordan Sample, Navarre, joined 10/09', '- Casey Example, Crestview, joined 10/21', '', 'Mensaversaries:', '', '- Riley Testcase, 25 years', '- Morgan Example, 10 years'].join('\n');
  await expect(page.getByText("Never paste birthday, new-member or Mensaversary lists, or anything from Mensa's roster.")).toBeVisible();
  await textBox(page).fill(list);
  await saveTop(page).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
  await expect(problemsRegion(page)).toHaveCount(0);
  await expect(textBox(page)).toHaveValue(list);
  await context.close();
});
