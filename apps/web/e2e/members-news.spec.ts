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
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { SIZES } from '../server/prefs.mjs';
import { setPrefs } from './prefs';
import { crawlSeeds } from './routes';
import { banner, signIn } from './signin';
import { ARTICLES, BOARD_GAMES, MEMBERS_PDF_MARK, NEWSLETTER, SOURCE_PDFS, centralToday } from './stand-in';

// As in a11y.spec.ts: WCAG 2.2 A and AA, plus AAA and best practice.
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'wcag2aaa', 'best-practice'];
const RULE = "Members only, please don't forward";
const EXPIRED = 'Your sign-in has expired for members-only reading.';
const REFUSED = 'Members-only reading is not available for this sign-in.';
const NOT_SHOWN = 'Part of this text is not shown.';
const NO_ACCESS = 'Your account does not have member access yet.';

const [current, ...past] = NEWSLETTER.issues;
const pdf = (id: string) => `/documents/${id}.pdf`;
const MEMBERS_IDS = [...NEWSLETTER.issues.map((i) => i.membersPdf), ARTICLES.open.membersPdf];
/** What only a member may see on /news, and what nobody may. */
const MEMBERS_TEXT = [ARTICLES.open.passage, ARTICLES.members.body, ARTICLES.members.title, ARTICLES.withheld.title, NOT_SHOWN];
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
    await expect(card.getByRole('link', { name: 'Read this issue (PDF)' })).toHaveAttribute('href', pdf(current!.publicPdf));
    await expect(card.getByRole('link', { name: 'Members copy (PDF)', exact: true })).toHaveAttribute('href', pdf(current!.membersPdf));
    await expect(card.getByText(RULE)).toBeVisible();
    const others = page.getByRole('region', { name: 'Past issues' });
    for (const issue of past) {
      const row = others.getByRole('listitem').filter({ hasText: issue.title });
      await expect(row.getByRole('link', { name: `${issue.title} (PDF)` })).toHaveAttribute('href', pdf(issue.publicPdf));
      await expect(row.getByRole('link', { name: `${issue.title}, members copy (PDF)` })).toHaveAttribute('href', pdf(issue.membersPdf));
    }
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
    await banner(page).getByRole('button', { name: 'Sign out' }).click();
    await page.getByRole('button', { name: 'Yes, sign me out' }).click();
    await expect(page).toHaveURL(/\/signed-out$/);
    const res = await page.goto('/news');
    const html = await res!.text();
    expect(noneOf(html, [...MEMBERS_IDS, ...MEMBERS_TEXT, ...NEVER])).toEqual([]);
  });
});

test('an officer gets the members view and never an officers article, an officers file or a source file', async ({ page }) => {
  await page.goto('/news');
  await signIn(page, 'officer');
  await expect(page.getByRole('link', { name: 'Members copy (PDF)', exact: true })).toHaveAttribute('href', pdf(current!.membersPdf));
  await expect(page.getByText(ARTICLES.open.passage)).toBeVisible();
  expect(noneOf(await page.content(), NEVER)).toEqual([]);
});

test('a pending account gets the public view, a box saying it has no member access yet, and no members id', async ({ page }) => {
  await page.goto('/news');
  await signIn(page, 'pending');
  const open = page.getByRole('article').filter({ hasText: ARTICLES.open.title });
  await expect(open).toContainText('Members-only passage. Your account does not have member access yet.');
  await expect(open.getByRole('link', { name: 'Ask for help' })).toHaveAttribute('href', '/help');
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
  await expect(card.getByRole('link', { name: 'Read this issue (PDF)' })).toHaveAttribute('href', pdf(current!.publicPdf));
  await expect(card.getByRole('link', { name: 'Members copy (PDF)', exact: true })).toHaveAttribute('href', pdf(current!.membersPdf));
  await expect(page.getByRole('note').filter({ hasText: 'The list of articles is temporarily unavailable.' })).toBeVisible();
  await expect(page.getByText('The list of issues is temporarily unavailable.')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'From the newsletter' })).toHaveCount(0);
});

test('anonymous: the public article with its passage hidden behind a sign-in link, and none of the members content', async ({ page }) => {
  const res = await page.goto('/news');
  const open = page.getByRole('article').filter({ hasText: ARTICLES.open.title });
  await expect(open).toContainText(ARTICLES.open.plain);
  await expect(open.getByRole('link', { name: 'sign in' })).toHaveAttribute('href', '/sign-in?return=%2Fnews&again=1');
  await expect(open.getByRole('link', { name: /\(PDF\)$/ })).toHaveAttribute('href', pdf(ARTICLES.open.publicPdf));
  for (const html of [await res!.text(), await page.content()]) expect(noneOf(html, [...MEMBERS_IDS, ...MEMBERS_TEXT, ...NEVER, RULE])).toEqual([]);
  expect(res?.headers()['cache-control']).toBe('public, max-age=60, stale-while-revalidate=60');
  expect(res?.headers()['cdn-cache-control']).toBeUndefined();
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
      await expect(page.getByRole('link', { name: 'Members copy (PDF)', exact: true })).toBeVisible();
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
      for (const link of await links.all()) {
        const box = (await link.boundingBox())!;
        expect(box.height, await link.innerText()).toBeGreaterThanOrEqual(48);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(320);
      }
    });
  });
});
