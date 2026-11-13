// /news, the newsletter: the issues the issue loader published, read from the
// stand-in API (e2e/api.mjs), each linked to its public PDF only. With no issue
// published yet, the bundled sample stays: a second site, whose API has none.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { SIZES } from '../server/prefs.mjs';
import { setPrefs } from './prefs';
import { PUBLIC_COPY } from '../src/lib/reader';
import { NO_ISSUES_SITE_URL, SIGN_IN_OFF_URL } from './servers';
import { ARTICLES, NEWSLETTER, SOURCE_PDFS } from './stand-in';

// As in a11y.spec.ts: WCAG 2.2 A and AA, plus AAA and best practice.
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'wcag2aaa', 'best-practice'];

async function axe(page: Page): Promise<string[]> {
  // At the end of the page the phone's sticky bottom bar is back in its own space.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

const [current, ...past] = NEWSLETTER.issues;
const pdf = (id: string) => `/documents/${id}.pdf`;
// PDFVIEW: an issue is read in the site, at /read/<id>; a small "PDF file" link keeps the file itself.
const reader = (id: string) => `/read/${id}`;

test.describe('/news with issues published', () => {
  test('shows the newest issue with its public PDF, then every other issue by year, newest first, each with its own', async ({ page }) => {
    await page.goto('/news');
    const card = page.getByRole('region', { name: current!.title });
    await expect(card.getByRole('heading', { level: 2 })).toHaveText(current!.title);
    await expect(card).toContainText(current!.summary);
    await expect(card.getByRole('link', { name: 'Read this issue', exact: true })).toHaveAttribute('href', reader(current!.publicPdf));
    await expect(card.getByRole('link', { name: /^PDF file/ })).toHaveAttribute('href', pdf(current!.publicPdf));
    const others = page.getByRole('region', { name: 'Past issues' });
    await expect(others.getByRole('heading', { level: 3 })).toHaveText(['2026', '2025']);
    // Each row also holds the "PDF file" link (below): count the issues only.
    await expect(others.locator('a[href^="/read/"]')).toHaveText(past.map((i) => i.title));
    for (const issue of past) {
      const row = others.getByRole('listitem').filter({ hasText: issue.title });
      await expect(row.getByRole('link', { name: issue.title, exact: true })).toHaveAttribute('href', reader(issue.publicPdf));
      await expect(row.getByRole('link', { name: /^PDF file/ })).toHaveAttribute('href', pdf(issue.publicPdf));
      await expect(row).toContainText(issue.summary);
    }
    await expect(page.locator('main [data-source="pipeline"]')).toHaveCount(NEWSLETTER.issues.length);
  });

  test('drops the bundled sample: no sample notice, and none of its made-up issues', async ({ page }) => {
    await page.goto('/news');
    await expect(page.getByRole('heading', { level: 2, name: current!.title })).toBeVisible();
    await expect(page.getByRole('note').filter({ hasText: 'Sample entries' })).toHaveCount(0);
    for (const sample of ['October and November 2026', 'June and July 2025', 'No copy known', 'arrive with the archive']) await expect(page.getByText(sample), sample).toHaveCount(0);
  });

  test('lists no members issue, and no document that is not an issue', async ({ page }) => {
    await page.goto('/news');
    await expect(page.getByRole('heading', { level: 2, name: current!.title })).toBeVisible();
    await expect(page.getByText(NEWSLETTER.membersOnly.title)).toHaveCount(0);
    await expect(page.getByText(NEWSLETTER.other.title)).toHaveCount(0);
  });

  test('no members file, and no hash or size of any file, is in the anonymous page, as sent or as the browser holds it', async ({ page }) => {
    const res = await page.goto('/news');
    expect(res?.status()).toBe(200);
    for (const html of [await res!.text(), await page.content()]) {
      // The positive control: the public files are there.
      for (const issue of NEWSLETTER.issues) expect(html).toContain(pdf(issue.publicPdf));
      for (const issue of [...NEWSLETTER.issues, NEWSLETTER.membersOnly]) expect(html, issue.title).not.toContain(issue.membersPdf);
      expect(html).not.toContain(NEWSLETTER.membersOnly.publicPdf);
      expect(html).not.toContain(NEWSLETTER.other.publicPdf);
      // A14: the article's members PDF, its members passage, the members article's body, the officers article.
      // D1: the members articles' titles are public now (teasers), their bodies never.
      for (const secret of [ARTICLES.open.membersPdf, ARTICLES.open.passage, ARTICLES.members.body, ARTICLES.officers.title, ARTICLES.officers.pdf, ...SOURCE_PDFS]) expect(html).not.toContain(secret);
      expect(html.toLowerCase()).not.toContain(NEWSLETTER.sha256Hex.slice(0, 16));
      expect(html).not.toContain(Buffer.from(NEWSLETTER.sha256Hex, 'hex').toString('base64').slice(0, 16));
      expect(html).not.toMatch(/987[,.\s]?654/);
    }
    await expect(page.getByRole('main')).not.toContainText(/\d\s*(bytes|[kKM]i?B)\b/);
  });

  // The API gives an item's id in its slug field when anything in it is withheld; the page never reads the slug.
  test('lists the issue whose slug the API withheld by its title, with its own PDF, and shows no item id', async ({ page }) => {
    const withheld = NEWSLETTER.issues[1]!;
    const res = await page.goto('/news');
    await expect(page.getByRole('link', { name: withheld.title, exact: true })).toHaveAttribute('href', reader(withheld.publicPdf));
    const html = await res!.text();
    for (const issue of NEWSLETTER.issues) expect(html).not.toContain(issue.id);
  });

  test('the PDF file link opens the public PDF', async ({ page, request }) => {
    await page.goto('/news');
    const href = await page.getByRole('region', { name: current!.title }).getByRole('link', { name: /^PDF file/ }).getAttribute('href');
    const file = await request.get(href!);
    expect(file.status()).toBe(200);
    expect(file.headers()['content-type']).toBe('application/pdf');
    expect((await file.body()).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  test.describe('on a narrow phone at the largest text size', () => {
    test.use({ viewport: { width: 320, height: 640 } });

    test('nothing scrolls sideways, and every issue and PDF link is a whole, full-size target', async ({ page, context, baseURL }) => {
      await setPrefs(context, baseURL!, { size: SIZES.at(-1)! });
      await page.goto('/news');
      await expect(page.locator('html')).toHaveAttribute('data-size', String(SIZES.at(-1)));
      expect(await sideways(page)).toBeLessThanOrEqual(0);
      const links = page.locator('main a[href^="/documents/"]');
      // Each issue's public PDF file, and the published article's (A14).
      await expect(links).toHaveCount(NEWSLETTER.issues.length + 1);
      await expect(page.locator('main a[href^="/read/"]')).toHaveCount(NEWSLETTER.issues.length);
      for (const link of [...(await links.all()), ...(await page.locator('main a[href^="/read/"]').all())]) {
        const box = (await link.boundingBox())!;
        expect(box.height, await link.innerText()).toBeGreaterThanOrEqual(48);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(320);
      }
    });
  });
});

test.describe('/news with no issue published yet', () => {
  test('keeps the bundled sample and says so: the current issue, past issues by year, missing ones honestly, and no PDF', async ({ page }) => {
    await page.goto(`${NO_ISSUES_SITE_URL}/news`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('News');
    await expect(page.getByRole('note').filter({ hasText: 'Sample entries' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'October and November 2026' })).toBeVisible();
    await expect(page.getByText('Large-type reading and the PDF arrive with the archive.')).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Past issues' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 3, name: '2026' })).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: 'June and July 2025' })).toContainText('No copy known');
    await expect(page.locator('[data-source="pipeline"]').first()).toBeVisible();
    await expect(page.locator('main a[href^="/documents/"]')).toHaveCount(0);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`axe, ${scheme} system setting`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(`${NO_ISSUES_SITE_URL}/news`);
      await expect(page.getByRole('note').filter({ hasText: 'Sample entries' })).toBeVisible();
      expect(await axe(page)).toEqual([]);
    });
  }

  test('axe at the largest text size, Aa panel open', async ({ page, context }) => {
    await setPrefs(context, NO_ISSUES_SITE_URL, { size: SIZES.at(-1)! });
    await page.goto(`${NO_ISSUES_SITE_URL}/news#reader-menu`);
    await expect(page.locator('html')).toHaveAttribute('data-size', String(SIZES.at(-1)));
    expect(await axe(page)).toEqual([]);
  });

  test.describe('on a narrow phone at the largest text size', () => {
    test.use({ viewport: { width: 320, height: 640 } });

    test('nothing scrolls sideways', async ({ page, context }) => {
      await setPrefs(context, NO_ISSUES_SITE_URL, { size: SIZES.at(-1)! });
      await page.goto(`${NO_ISSUES_SITE_URL}/news`);
      await expect(page.locator('html')).toHaveAttribute('data-size', String(SIZES.at(-1)));
      expect(await sideways(page)).toBeLessThanOrEqual(0);
    });
  });
});

// The editor, 11-04, then PDFVIEW (11-05): the notice that these are the public copies, with some personal
// details hidden, and that members can sign in for the full issue. Fix 1: once, above the issue list,
// not by each issue. "sign in" is a link only where sign-in works (the main site), never on Home;
// elsewhere the notice is the same, in plain text.
test.describe('/news, the public-copy notice', () => {
  test('shows once, above the issue list, with "sign in" a link back to /news', async ({ page }) => {
    await page.goto('/news');
    const main = page.getByRole('main');
    const lines = main.getByText(PUBLIC_COPY);
    await expect(lines).toHaveCount(1);
    const card = page.getByRole('region', { name: current!.title });
    await expect(card.getByText(PUBLIC_COPY)).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Past issues' }).getByText(PUBLIC_COPY)).toHaveCount(0);
    // Above the current issue, the first of the list.
    expect((await lines.boundingBox())!.y).toBeLessThan((await card.boundingBox())!.y);
    const links = lines.getByRole('link', { name: 'sign in', exact: true });
    await expect(links).toHaveCount(1);
    await expect(links).toHaveAttribute('href', '/sign-in?return=%2Fnews');
    expect(await links.evaluate((el) => getComputedStyle(el).textDecorationLine)).toContain('underline');
    // The old line is gone: the notice replaces it, so nothing repeats.
    await expect(page.getByText('to read the members copy')).toHaveCount(0);
  });

  test('is the same for every signed-out reader, and the page is kept by no shared cache', async ({ request }) => {
    const first = await request.get('/news');
    const second = await request.get('/news');
    expect(first.headers()['cache-control']).toBe('private, max-age=60, stale-while-revalidate=60');
    const lines = (html: string) => html.split(' for the full issue.').length - 1;
    expect(lines(await first.text())).toBe(1);
    expect(lines(await second.text())).toBe(1);
  });

  test('is in plain text of a readable size and holds at the narrowest phone width', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto('/news');
    const line = page.getByRole('main').getByText(PUBLIC_COPY).first();
    await expect(line).toBeVisible();
    expect(await line.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
    expect(await sideways(page)).toBeLessThanOrEqual(0);
  });

  test('is not on Home, whose newsletter card only leads to /news', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'See every issue' })).toBeVisible();
    await expect(page.getByText(PUBLIC_COPY)).toHaveCount(0);
  });

  test('where sign-in is not set up, since /sign-in would answer 503, says the same with "sign in" in plain text', async ({ page, request }) => {
    expect((await request.get(`${SIGN_IN_OFF_URL}/sign-in`)).status()).toBe(503);
    await page.goto(`${SIGN_IN_OFF_URL}/news`);
    await expect(page.getByRole('region', { name: 'Past issues' }).getByRole('link', { name: past[0]!.title, exact: true })).toBeVisible();
    await expect(page.getByRole('main').getByText(PUBLIC_COPY)).toHaveCount(1);
    await expect(page.locator('main a[href^="/sign-in"]')).toHaveCount(0);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`axe with the notice, ${scheme} system setting`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto('/news');
      await expect(page.getByRole('main').getByText(PUBLIC_COPY)).toHaveCount(1);
      expect(await axe(page)).toEqual([]);
    });
  }
});
