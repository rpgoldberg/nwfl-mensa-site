// A14 (S5a, S5b): /news as a signed-in reader. The site forwards the reader's
// token on ListPublishedItems and ReadFile only, and the stand-in API
// (e2e/api.mjs) answers it as the API would: a member gets each issue's
// members copy, the members passage, the members article and the members PDF;
// an officer the same and never an officers article; a pending account the
// public view with a box saying so; a lapsed token the public view and a line
// to sign in again; a refused one the public view and a line to ask for help,
// with no sign-in link that would only be refused again; never a 503. The
// stand-in refuses a token on every other RPC, so a route that started
// forwarding one would fail here. A member's answer carries redacted nodes as
// well (a privacy mark the API withholds from members): the page still reads
// the whole answer as a member's, and says only that a part is not shown.
// D1 (11-03): the public, and any reader without member access, sees each
// members article by title and summary with a "Members only, sign in to read"
// box, never its body or files. D4 with AC6 (b): the members view needs an
// nwfl enrolee group in the session's claim (nwfl-users, or nwfl-members set
// by hand) AND member standing in the API's records ("enrolee" has both). A
// session with no enrolee group is the public's view, whatever the records
// say: its token is never sent ("stale", "officer-only"), and a lapsed token
// there is not called expired ("lapsed-outsider"). Pending standing with the
// group is the public's view too ("enrolee-pending").
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { SIZES } from '../server/prefs.mjs';
import { PUBLIC_COPY } from '../src/lib/reader';
import { setPrefs } from './prefs';
import { crawlSeeds } from './routes';
import { signIn, signOutButton } from './signin';
import { ARTICLES, BOARD_GAMES, MEMBERS_PDF_MARK, MIXED, NEWSLETTER, SOURCE_PDFS, centralToday } from './stand-in';

// As in a11y.spec.ts: WCAG 2.2 A and AA, plus AAA and best practice.
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'wcag2aaa', 'best-practice'];
const RULE = "Members only, please don't forward";
const EXPIRED = 'Your sign-in has expired for members-only reading.';
const REFUSED = 'Members-only reading is not available for this sign-in.';
const NOT_SHOWN = 'Part of this text is not shown.';
const NO_ACCESS = 'Your account does not have member access yet.';

const [current, ...past] = NEWSLETTER.issues;
const pdf = (id: string) => `/documents/${id}.pdf`;
// PDFVIEW: an issue is read in the site, at /read/<id>; a small "PDF file" link keeps each file itself.
const reader = (id: string) => `/read/${id}`;
const MEMBERS_IDS = [...NEWSLETTER.issues.map((i) => i.membersPdf), ARTICLES.open.membersPdf];
/** What only a member may see on /news, and what nobody may. The members articles' titles and summaries are public teasers (D1). */
const MEMBERS_TEXT = [ARTICLES.open.passage, ARTICLES.members.body, NOT_SHOWN];
const TEASERS = [ARTICLES.members, ARTICLES.withheld];
const TEASER_BOX = 'Members only, sign in to read.';
const TEASER_NO_ACCESS = 'Members only. Your account does not have member access yet.';
const NEVER = [ARTICLES.officers.title, ARTICLES.officers.body, ARTICLES.officers.pdf, NEWSLETTER.membersOnly.title, ...SOURCE_PDFS];

async function axe(page: Page): Promise<string[]> {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

/** /news as sent, signed in or not; the HTML escapes the passage's apostrophes and the like, so compare unescaped text too. */
async function newsHtml(request: APIRequestContext): Promise<{ status: number; headers: Record<string, string>; html: string }> {
  const res = await request.get('/news');
  return { status: res.status(), headers: res.headers(), html: await res.text() };
}

const noneOf = (html: string, needles: readonly string[]) => needles.filter((n) => html.includes(n));

test.describe('/news signed in as a member', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/news');
    await signIn(page, 'member');
    await expect(page).toHaveURL(/\/news$/);
  });

  test('the current issue has a second button for the members copy, with the line not to forward it', async ({ page }) => {
    const card = page.getByRole('region', { name: current!.title });
    await expect(card.getByRole('link', { name: 'Read this issue', exact: true })).toHaveAttribute('href', reader(current!.publicPdf));
    await expect(card.getByRole('link', { name: 'Members copy', exact: true })).toHaveAttribute('href', reader(current!.membersPdf));
    await expect(card.getByText(RULE)).toBeVisible();
    await expect(card.getByRole('link', { name: /^PDF file/ })).toHaveAttribute('href', pdf(current!.publicPdf));
    await expect(card.getByRole('link', { name: /^Members PDF file/ })).toHaveAttribute('href', pdf(current!.membersPdf));
    const others = page.getByRole('region', { name: 'Past issues' });
    for (const issue of past) {
      const row = others.getByRole('listitem').filter({ hasText: issue.title });
      await expect(row.getByRole('link', { name: issue.title, exact: true })).toHaveAttribute('href', reader(issue.publicPdf));
      await expect(row.getByRole('link', { name: `${issue.title}, members copy`, exact: true })).toHaveAttribute('href', reader(issue.membersPdf));
      await expect(row.getByRole('link', { name: /^PDF file/ })).toHaveAttribute('href', pdf(issue.publicPdf));
      await expect(row.getByRole('link', { name: /^Members PDF file/ })).toHaveAttribute('href', pdf(issue.membersPdf));
    }
  });

  test('shows no line to sign in, nor the public-copy notice: the members copy is already there', async ({ page }) => {
    await expect(page.getByRole('link', { name: 'Members copy', exact: true })).toBeVisible();
    await expect(page.getByText('to read the members copy')).toHaveCount(0);
    await expect(page.getByText(PUBLIC_COPY)).toHaveCount(0);
    await expect(page.getByRole('main').getByRole('link', { name: 'sign in', exact: true })).toHaveCount(0);
  });

  test('shows the members passage in its labelled box, the members article marked members only, and the members PDF; never an officers article', async ({ page }) => {
    const articles = page.getByRole('region', { name: 'From the newsletter' });
    const open = articles.getByRole('article').filter({ hasText: ARTICLES.open.title });
    await expect(open).toContainText(ARTICLES.open.plain);
    const box = open.getByRole('complementary', { name: 'Members only' });
    await expect(box).toContainText(RULE);
    await expect(box).toContainText(ARTICLES.open.passage);
    await expect(open.getByRole('link', { name: /members copy, PDF/ })).toHaveAttribute('href', pdf(ARTICLES.open.membersPdf));
    const members = articles.getByRole('article').filter({ hasText: ARTICLES.members.title });
    await expect(members).toContainText(RULE);
    await expect(members).toContainText(ARTICLES.members.body);
    const html = await page.content();
    expect(noneOf(html, NEVER)).toEqual([]);
    expect(html).not.toContain(EXPIRED);
  });

  test("reads the whole answer as a member's: a redacted node beside the passage, in the members article, or as a whole article says only that a part is not shown", async ({ page }) => {
    const articles = page.getByRole('region', { name: 'From the newsletter' });
    const open = articles.getByRole('article').filter({ hasText: ARTICLES.open.title });
    await expect(open).toContainText(ARTICLES.open.passage);
    await expect(open.getByText(NOT_SHOWN)).toBeVisible();
    await expect(articles.getByRole('article').filter({ hasText: ARTICLES.members.title }).getByText(NOT_SHOWN)).toBeVisible();
    const whole = articles.getByRole('article').filter({ hasText: ARTICLES.withheld.title });
    await expect(whole).toContainText(RULE);
    await expect(whole.getByText(NOT_SHOWN)).toBeVisible();
    const html = await page.content();
    expect(noneOf(html, [NO_ACCESS, 'Members-only passage', EXPIRED, REFUSED])).toEqual([]);
  });

  test('/news is private, never stored by any cache, a CDN included', async ({ page }) => {
    const { status, headers } = await newsHtml(page.request);
    expect(status).toBe(200);
    expect(headers['cache-control']).toBe('private, no-store');
    expect(headers['cdn-cache-control']).toBe('no-store');
    expect(headers['vary']).toBe('Cookie');
  });

  test('the members copy opens: the members bytes, inline, under the same name as the public copy, never stored', async ({ page }) => {
    for (const id of [current!.membersPdf, ARTICLES.open.membersPdf]) {
      const res = await page.request.get(pdf(id));
      expect(res.status(), id).toBe(200);
      expect(res.headers()['content-type']).toBe('application/pdf');
      expect(res.headers()['content-disposition']).toBe('inline; filename="pensa-mensa.pdf"');
      expect(res.headers()['cache-control']).toBe('private, no-store');
      expect(res.headers()['cdn-cache-control']).toBe('no-store');
      expect((await res.body()).toString('latin1')).toContain(MEMBERS_PDF_MARK);
    }
    // The public copy, read as the member, is the public bytes, still never stored.
    const pub = await page.request.get(pdf(current!.publicPdf));
    expect(pub.status()).toBe(200);
    expect((await pub.body()).toString('latin1')).not.toContain(MEMBERS_PDF_MARK);
    expect(pub.headers()['cache-control']).toBe('private, no-store');
  });

  test('the calendar files are byte for byte the public ones: no feed forwards a token', async ({ page, playwright, baseURL }) => {
    const anonymous = await playwright.request.newContext({ baseURL: baseURL!, ignoreHTTPSErrors: true });
    const stamp = (text: string) => text.replace(/^DTSTAMP:.*$/gm, '');
    for (const url of ['/calendar.ics', '/events.ics', `/events/${BOARD_GAMES}.ics`]) {
      const signedIn = await page.request.get(url);
      const plain = await anonymous.get(url);
      expect(signedIn.status(), url).toBe(200);
      expect(stamp(await signedIn.text()), url).toBe(stamp(await plain.text()));
    }
    await anonymous.dispose();
  });

  test('every route answers without a server error: no other read forwards the token (the stand-in refuses it anywhere else)', async ({ page }) => {
    const failed: string[] = [];
    for (const url of crawlSeeds({ eventIds: [BOARD_GAMES], months: [centralToday().slice(0, 7)], fileIds: [current!.publicPdf, current!.membersPdf] })) {
      const res = await page.request.get(url, { maxRedirects: 0 });
      if (res.status() >= 500) failed.push(`${url}: ${res.status()}`);
    }
    expect(failed).toEqual([]);
  });

  test("one reader's answer never reaches another: a member's read, then the public's, alone and at once", async ({ page, playwright, baseURL }) => {
    const anonymous = await playwright.request.newContext({ baseURL: baseURL!, ignoreHTTPSErrors: true });
    const after = await newsHtml(anonymous);
    expect(noneOf(after.html, [...MEMBERS_IDS, ...MEMBERS_TEXT])).toEqual([]);
    const together = await Promise.all([newsHtml(page.request), newsHtml(anonymous), newsHtml(page.request), newsHtml(anonymous), newsHtml(anonymous)]);
    for (const [n, got] of together.entries()) {
      const member = n === 0 || n === 2;
      expect(got.html.includes(current!.membersPdf), String(n)).toBe(member);
      if (!member) expect(noneOf(got.html, [...MEMBERS_IDS, ...MEMBERS_TEXT]), String(n)).toEqual([]);
    }
    await anonymous.dispose();
  });

  test('signed out, /news is the public page again', async ({ page }) => {
    await (await signOutButton(page)).click();
    await page.getByRole('button', { name: 'Yes, sign me out' }).click();
    await expect(page).toHaveURL(/\/signed-out$/);
    const res = await page.goto('/news');
    const html = await res!.text();
    expect(noneOf(html, [...MEMBERS_IDS, ...MEMBERS_TEXT, ...NEVER])).toEqual([]);
  });
});

// PDFVIEW fix 2 (decision 4): a signed-in member sees no public-copy notice at the top, even when the API lists an
// issue or two as a public copy alone; each such issue says so by itself, in its own card or row, in plain text.
const PUBLIC_ONLY_LINE = 'Public copy only';
test.describe('/news as a member for whom some issues have no members copy', () => {
  test('no notice at the top; each public-copy-only issue says "Public copy only" once, in its card or its row, and the rest say nothing', async ({ page }) => {
    await page.goto('/news');
    await signIn(page, 'mixed');
    await expect(page).toHaveURL(/\/news$/);
    const main = page.getByRole('main');
    await expect(main.locator('.copy-notice')).toHaveCount(0);
    await expect(main.getByText(PUBLIC_COPY)).toHaveCount(0);
    await expect(main.getByText(PUBLIC_ONLY_LINE)).toHaveCount(2);
    // The card is the newest issue, whose members copy this reader is not offered.
    const card = page.getByRole('region', { name: MIXED.card.title });
    await expect(card.getByText(PUBLIC_ONLY_LINE, { exact: true })).toBeVisible();
    await expect(card.getByRole('link', { name: 'Members copy', exact: true })).toHaveCount(0);
    await expect(card.getByRole('link', { name: 'Read this issue', exact: true })).toHaveAttribute('href', reader(MIXED.card.publicPdf));
    // The oldest is a row of the past issues; the two between keep their members copies and say nothing.
    const rows = page.getByRole('region', { name: 'Past issues' }).getByRole('listitem');
    const row = rows.filter({ hasText: MIXED.row.title });
    await expect(row.getByText(PUBLIC_ONLY_LINE, { exact: true })).toBeVisible();
    await expect(row.getByRole('link', { name: /members copy/i })).toHaveCount(0);
    for (const issue of past.filter((i) => i !== MIXED.row)) {
      const other = rows.filter({ hasText: issue.title });
      await expect(other.getByText(PUBLIC_ONLY_LINE)).toHaveCount(0);
      await expect(other.getByRole('link', { name: `${issue.title}, members copy` })).toHaveAttribute('href', reader(issue.membersPdf));
    }
    // Plain words, at the muted text colour the rows already use: no new colour, and nothing for a screen reader to miss.
    const line = row.getByText(PUBLIC_ONLY_LINE, { exact: true });
    await expect(line).toHaveClass(/muted/);
    expect(await line.evaluate((el) => getComputedStyle(el).color)).toBe(await row.locator('.muted').first().evaluate((el) => getComputedStyle(el).color));
    expect(await axe(page)).toEqual([]);
  });

  test('a reader with no members copy on any issue still gets exactly one notice at the top, and no "Public copy only" line', async ({ page }) => {
    await page.goto('/news');
    const main = page.getByRole('main');
    await expect(main.locator('.copy-notice')).toHaveCount(1);
    await expect(main.getByText(PUBLIC_COPY)).toHaveCount(1);
    await expect(main.getByText(PUBLIC_ONLY_LINE)).toHaveCount(0);
  });
});

test('an officer gets the members view and never an officers article, an officers file or a source file', async ({ page }) => {
  await page.goto('/news');
  await signIn(page, 'officer');
  await expect(page.getByRole('link', { name: 'Members copy', exact: true })).toHaveAttribute('href', reader(current!.membersPdf));
  await expect(page.getByText(ARTICLES.open.passage)).toBeVisible();
  expect(noneOf(await page.content(), NEVER)).toEqual([]);
  await expect(page.getByText('to read the members copy')).toHaveCount(0);
});

test('a pending account gets the public view, a box saying it has no member access yet, and no members id', async ({ page }) => {
  await page.goto('/news');
  await signIn(page, 'pending');
  const open = page.getByRole('article').filter({ hasText: ARTICLES.open.title });
  await expect(open).toContainText('Members-only passage. Your account does not have member access yet.');
  await expect(open.getByRole('link', { name: 'Ask for help' })).toHaveAttribute('href', '/help');
  // Signed in already: the line to sign in is for the signed-out only. PDFVIEW: the page still says,
  // once, that these are the public copies, with "sign in" in plain text, since this reader is signed in.
  await expect(page.getByText('to read the members copy')).toHaveCount(0);
  await expect(page.getByRole('main').getByText(PUBLIC_COPY)).toHaveCount(1);
  await expect(page.locator('main a[href^="/sign-in"]')).toHaveCount(0);
  const html = await page.content();
  expect(noneOf(html, [...MEMBERS_IDS, ...MEMBERS_TEXT, ...NEVER, RULE.replace("'", '&#39;'), RULE])).toEqual([]);
  // Its members copy is the same 404 as a random id's.
  const random = await page.request.get(pdf('00000000-0000-4000-8000-0000000000aa'));
  const withheld = await page.request.get(pdf(current!.membersPdf));
  expect(withheld.status()).toBe(404);
  expect(await withheld.text()).toBe(await random.text());
});

test('a lapsed token gives the public view and a line to sign in again: never a 503', async ({ page }) => {
  await page.goto('/news');
  await signIn(page, 'lapsed');
  const res = await page.goto('/news');
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('note').filter({ hasText: EXPIRED })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in again' })).toHaveAttribute('href', '/sign-in?return=%2Fnews&again=1');
  const html = await page.content();
  expect(noneOf(html, [...MEMBERS_IDS, ...MEMBERS_TEXT, ...NEVER, REFUSED])).toEqual([]);
  const withheld = await page.request.get(pdf(current!.membersPdf));
  expect(withheld.status()).toBe(404);
});

test('a refused token gives the public view and a line to ask for help, never one to sign in again, which would only be refused again: never a 503', async ({ page }) => {
  await page.goto('/news');
  await signIn(page, 'refused');
  const res = await page.goto('/news');
  expect(res?.status()).toBe(200);
  const note = page.getByRole('note').filter({ hasText: REFUSED });
  await expect(note).toBeVisible();
  await expect(note.getByRole('link', { name: 'Ask for help' })).toHaveAttribute('href', '/help');
  await expect(page.getByRole('link', { name: 'Sign in again' })).toHaveCount(0);
  await expect(page.locator('main a[href^="/sign-in"]')).toHaveCount(0);
  const open = page.getByRole('article').filter({ hasText: ARTICLES.open.title });
  await expect(open).toContainText(`Members-only passage. ${NO_ACCESS}`);
  const html = await page.content();
  expect(noneOf(html, [...MEMBERS_IDS, ...MEMBERS_TEXT, ...NEVER, EXPIRED])).toEqual([]);
  const withheld = await page.request.get(pdf(current!.membersPdf));
  expect(withheld.status()).toBe(404);
});

test('articles the API cannot give leave the issues listed, members copies too, with a line in their place: a 503, never stored', async ({ page }) => {
  await page.goto('/news');
  await signIn(page, 'articles-down');
  const res = await page.goto('/news');
  expect(res?.status()).toBe(503);
  expect(res?.headers()['cache-control']).toContain('no-store');
  const card = page.getByRole('region', { name: current!.title });
  await expect(card.getByRole('link', { name: 'Read this issue', exact: true })).toHaveAttribute('href', reader(current!.publicPdf));
  await expect(card.getByRole('link', { name: 'Members copy', exact: true })).toHaveAttribute('href', reader(current!.membersPdf));
  await expect(page.getByRole('note').filter({ hasText: 'The list of articles is temporarily unavailable.' })).toBeVisible();
  await expect(page.getByText('The list of issues is temporarily unavailable.')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'From the newsletter' })).toHaveCount(0);
});

/** D1: each members article is a teaser, by title and summary with the box, never the rule not to forward it, nor a file. */
async function teasers(page: Page, box: string, link: { name: string; href: string }) {
  for (const t of TEASERS) {
    const item = page.getByRole('article').filter({ hasText: t.title });
    await expect(item.getByRole('heading', { level: 3 })).toHaveText(t.title);
    await expect(item).toContainText(t.summary);
    const note = item.locator('.members-note');
    await expect(note).toHaveText(link.name === 'sign in' ? box : `${box} ${link.name}`);
    await expect(note.getByRole('link', { name: link.name, exact: true })).toHaveAttribute('href', link.href);
    await expect(item.getByText(RULE)).toHaveCount(0);
    await expect(item.getByRole('link', { name: /PDF/ })).toHaveCount(0);
  }
}

test('anonymous: each members article by title and summary, with a box and a real sign-in link (D1); the page is the same for every anonymous reader, and no shared cache keeps it', async ({ page, playwright, baseURL }) => {
  const res = await page.goto('/news');
  await teasers(page, TEASER_BOX, { name: 'sign in', href: '/sign-in?return=%2Fnews&again=1' });
  const html = await res!.text();
  expect(noneOf(html, [...MEMBERS_IDS, ...MEMBERS_TEXT, ...NEVER, RULE.replace("'", '&#39;'), RULE])).toEqual([]);
  expect(res?.headers()['cache-control']).toBe('private, max-age=60, stale-while-revalidate=60');
  expect(res?.headers()['cdn-cache-control']).toBe('no-store');
  const others = await Promise.all([0, 1].map(async () => {
    const ctx = await playwright.request.newContext({ baseURL: baseURL!, ignoreHTTPSErrors: true });
    const got = await newsHtml(ctx);
    await ctx.dispose();
    return got;
  }));
  for (const other of others) {
    expect(other.html).toBe(html);
    expect(other.headers['cache-control']).toBe('private, max-age=60, stale-while-revalidate=60');
  }
  // The sign-in link looks like a link (underlined, bold), in text large enough to read.
  const link = page.getByRole('article').filter({ hasText: ARTICLES.members.title }).getByRole('link', { name: 'sign in', exact: true });
  const style = await link.evaluate((a) => ({ line: getComputedStyle(a).textDecorationLine, weight: getComputedStyle(a).fontWeight, size: getComputedStyle(a).fontSize }));
  expect(style.line).toContain('underline');
  expect(Number(style.weight)).toBeGreaterThanOrEqual(700);
  expect(Number.parseFloat(style.size)).toBeGreaterThanOrEqual(16);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`anonymous /news with the teasers passes axe, ${scheme} system setting`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/news');
    await expect(page.getByText(TEASER_BOX).first()).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });
}

const D4_PUBLIC = {
  stale: 'member standing in the records but no enrolee group in the claim',
  'officer-only': 'the officers group without an enrolee group',
  'enrolee-pending': 'nwfl-users in the claim but pending standing in the records',
} as const;
for (const login of Object.keys(D4_PUBLIC) as (keyof typeof D4_PUBLIC)[]) {
  test(`D4: ${D4_PUBLIC[login]} gives the public's view, with the box that says so, and no members id`, async ({ page }) => {
    await page.goto('/news');
    await signIn(page, login);
    const res = await page.goto('/news');
    expect(res?.status()).toBe(200);
    await teasers(page, TEASER_NO_ACCESS, { name: 'Ask for help', href: '/help' });
    const open = page.getByRole('article').filter({ hasText: ARTICLES.open.title });
    await expect(open).toContainText(`Members-only passage. ${NO_ACCESS}`);
    await expect(page.locator('main a[href^="/sign-in"]')).toHaveCount(0);
    const html = await page.content();
    expect(noneOf(html, [...MEMBERS_IDS, ...MEMBERS_TEXT, ...NEVER, RULE.replace("'", '&#39;'), RULE, EXPIRED, REFUSED])).toEqual([]);
    expect(res?.headers()['cache-control']).toBe('private, no-store');
    expect(res?.headers()['cdn-cache-control']).toBe('no-store');
    const random = await page.request.get(pdf('00000000-0000-4000-8000-0000000000aa'));
    const withheld = await page.request.get(pdf(current!.membersPdf));
    expect(withheld.status()).toBe(404);
    expect(await withheld.text()).toBe(await random.text());
  });
}

test('AC6 b: nwfl-users alone in the claim, with member standing in the records, gets the members view', async ({ page }) => {
  await page.goto('/news');
  await signIn(page, 'enrolee');
  const res = await page.goto('/news');
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('link', { name: 'Members copy', exact: true })).toHaveAttribute('href', reader(current!.membersPdf));
  const open = page.getByRole('article').filter({ hasText: ARTICLES.open.title });
  await expect(open.getByRole('complementary', { name: 'Members only' })).toContainText(ARTICLES.open.passage);
  await expect(page.getByRole('article').filter({ hasText: ARTICLES.members.title })).toContainText(ARTICLES.members.body);
  const html = await page.content();
  expect(noneOf(html, [...NEVER, NO_ACCESS, TEASER_NO_ACCESS, EXPIRED, REFUSED])).toEqual([]);
  expect(res?.headers()['cache-control']).toBe('private, no-store');
  const members = await page.request.get(pdf(current!.membersPdf));
  expect(members.status()).toBe(200);
  expect((await members.body()).toString('latin1')).toContain(MEMBERS_PDF_MARK);
});

test('a lapsed token on a session with no enrolee group is never told its sign-in expired: the boxes say the account has no member access', async ({ page }) => {
  await page.goto('/news');
  await signIn(page, 'lapsed-outsider');
  const res = await page.goto('/news');
  expect(res?.status()).toBe(200);
  await teasers(page, TEASER_NO_ACCESS, { name: 'Ask for help', href: '/help' });
  const open = page.getByRole('article').filter({ hasText: ARTICLES.open.title });
  await expect(open).toContainText(`Members-only passage. ${NO_ACCESS}`);
  await expect(page.getByRole('link', { name: 'Sign in again' })).toHaveCount(0);
  await expect(page.locator('main a[href^="/sign-in"]')).toHaveCount(0);
  const html = await page.content();
  expect(noneOf(html, [...MEMBERS_IDS, ...MEMBERS_TEXT, ...NEVER, EXPIRED, REFUSED])).toEqual([]);
});

test('anonymous: the public article with its passage hidden behind a sign-in link, and none of the members content', async ({ page }) => {
  const res = await page.goto('/news');
  const open = page.getByRole('article').filter({ hasText: ARTICLES.open.title });
  await expect(open).toContainText(ARTICLES.open.plain);
  await expect(open.getByRole('link', { name: 'sign in' })).toHaveAttribute('href', '/sign-in?return=%2Fnews&again=1');
  await expect(open.getByRole('link', { name: /\(PDF\)$/ })).toHaveAttribute('href', pdf(ARTICLES.open.publicPdf));
  for (const html of [await res!.text(), await page.content()]) expect(noneOf(html, [...MEMBERS_IDS, ...MEMBERS_TEXT, ...NEVER, RULE])).toEqual([]);
  expect(res?.headers()['cache-control']).toBe('private, max-age=60, stale-while-revalidate=60');
  expect(res?.headers()['cdn-cache-control']).toBe('no-store');
});

test.describe('the members view, for every reader', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/news');
    await signIn(page, 'member');
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`axe, ${scheme} system setting`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto('/news');
      await expect(page.getByRole('link', { name: 'Members copy', exact: true })).toBeVisible();
      expect(await axe(page)).toEqual([]);
    });
  }

  test('axe at the largest text size, Aa panel open', async ({ page, context, baseURL }) => {
    await setPrefs(context, baseURL!, { size: SIZES.at(-1)! });
    // Signed in on /news already: a fragment alone would not load the page again.
    await page.goto('/about');
    await page.goto('/news#reader-menu');
    await expect(page.locator('html')).toHaveAttribute('data-size', String(SIZES.at(-1)));
    expect(await axe(page)).toEqual([]);
  });

  test.describe('on a narrow phone at the largest text size', () => {
    test.use({ viewport: { width: 320, height: 640 } });

    test('nothing scrolls sideways, and every PDF link and button is a whole, full-size target', async ({ page, context, baseURL }) => {
      await setPrefs(context, baseURL!, { size: SIZES.at(-1)! });
      await page.goto('/news');
      await expect(page.locator('html')).toHaveAttribute('data-size', String(SIZES.at(-1)));
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      const links = page.locator('main a[href^="/documents/"]');
      // Public and members copy of each issue, and both PDFs of the article.
      await expect(links).toHaveCount(NEWSLETTER.issues.length * 2 + 2);
      const read = page.locator('main a[href^="/read/"]');
      await expect(read).toHaveCount(NEWSLETTER.issues.length * 2);
      for (const link of [...(await links.all()), ...(await read.all())]) {
        const box = (await link.boundingBox())!;
        expect(box.height, await link.innerText()).toBeGreaterThanOrEqual(48);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(320);
      }
    });
  });
});
