// ARCHIVE-SEARCH S4: /search against the stand-in API (e2e/api.mjs), whose made-up answers depend on the
// words asked for. The page works with no JavaScript, says each state in plain words, is never stored or
// indexed, shows any markup in a snippet as text, and passes axe at 320, 412 and 1280 px wide, in every
// theme, at the site's largest text and at 200 % browser zoom. With SEARCH_SHOTS set to a folder, the
// accessibility runs leave a screenshot of each there.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { SIZES } from '../server/prefs.mjs';
import { THEMES, setPrefs } from './prefs';
import { signIn } from './signin';
import { NEWSLETTER } from './stand-in';

// As in a11y.spec.ts: WCAG 2.2 A and AA, plus AAA and best practice.
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'wcag2aaa', 'best-practice'];
const WIDTHS = [320, 412, 1280] as const;
const SHOTS = process.env['SEARCH_SHOTS'];

async function axe(page: Page): Promise<string[]> {
  // At the end of the page the phone's sticky bottom bar is back in its own space.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const results = (page: Page) => page.locator('[data-search-results]');
const hits = (page: Page) => results(page).getByRole('listitem');
const box = (page: Page) => page.getByRole('searchbox', { name: 'Search the newsletter archive' });
const newest = NEWSLETTER.issues[0]!;

test.describe('a search', () => {
  test('says the count in the title and a heading, then lists each result as a plainly labelled link', async ({ page }) => {
    const res = await page.goto('/search?q=picnic+lunch');
    expect(res?.status()).toBe(200);
    await expect(page).toHaveTitle('Search: 4 results for picnic lunch | Northwest Florida Mensa');
    await expect(page.getByRole('heading', { level: 2, name: '4 results' })).toBeVisible();
    await expect(page.getByRole('region', { name: '4 results' })).toBeVisible();
    await expect(box(page)).toHaveValue('picnic lunch');
    await expect(results(page).getByRole('list')).toHaveCount(1);
    await expect(hits(page)).toHaveCount(4);
    const first = hits(page).first();
    await expect(first.getByRole('link', { name: `${newest.title}, page 2`, exact: true })).toHaveAttribute('href', `/read/${newest.publicPdf}#page=2&find=picnic%20lunch`);
    await expect(first.getByRole('link', { name: `PDF file, page 2 of ${newest.title}` })).toHaveAttribute('href', `/documents/${newest.publicPdf}.pdf#page=2`);
    await expect(first.locator('mark')).toHaveText('picnic');
    await expect(hits(page).last().getByRole('link', { name: 'A new home for the Wednesday lunch' })).toHaveAttribute('href', '/news#item-a-new-home-for-the-wednesday-lunch');
    await expect(hits(page).last()).toContainText('Newsletter article, Tuesday, 3 March 2026');
    // The results region never repeats the words searched for, except as the words found in a snippet.
    expect(await results(page).evaluate((el) => (el.textContent ?? '').includes('picnic lunch'))).toBe(false);
  });

  test('shows any markup in a snippet as text: nothing in it runs, loads or links', async ({ page }) => {
    const asked: string[] = [];
    page.on('request', (r) => asked.push(r.url()));
    await page.goto('/search?q=picnic');
    const hostile = hits(page).nth(2);
    await expect(hostile).toContainText("<script>document.title='SNIPPET-RAN'</script>");
    await expect(hostile).toContainText('<mark>not a mark</mark> &amp; <a href="https://example.org/">a link</a>');
    await expect(hostile.locator('mark')).toHaveText(['picnic']);
    expect(await hostile.locator('.hit__snippet').evaluate((el) => [...el.querySelectorAll('*')].map((e) => e.tagName))).toEqual(['MARK']);
    await expect(page).toHaveTitle(/^Search: 4 results for picnic/);
    expect(asked.filter((u) => !u.startsWith(new URL(page.url()).origin))).toEqual([]);
  });

  test('is never stored or indexed, with or without a query, whatever the answer', async ({ request }) => {
    for (const [query, status] of [['', 200], ['?q=picnic', 200], ['?q=zebra', 200], ['?q=a', 400], ['?q=busy+day', 503], ['?q=offline+day', 503]] as const) {
      const res = await request.get(`/search${query}`);
      expect(res.status(), query).toBe(status);
      expect(res.headers()['cache-control'], query).toBe('private, no-store');
      expect(res.headers()['cdn-cache-control'], query).toBe('no-store');
      expect(res.headers()['x-robots-tag'], query).toBe('noindex');
      expect(await res.text(), query).toContain('<meta name="robots" content="noindex">');
      expect(res.headers()['set-cookie'], query).toBeUndefined();
    }
  });

  test('works with JavaScript off: the form is a plain GET, and Previous and Next are links', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, ignoreHTTPSErrors: true, baseURL: baseURL! });
    const page = await context.newPage();
    await page.goto('/search');
    await box(page).fill('many things');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page).toHaveURL(/\/search\?q=many\+things$/);
    await expect(page).toHaveTitle(/^Search: results 1 to 10 for many things/);
    await expect(hits(page)).toHaveCount(10);
    await expect(page.getByRole('link', { name: 'Previous results' })).toHaveCount(0);
    await page.getByRole('navigation', { name: 'More results' }).getByRole('link', { name: 'Next results' }).click();
    await expect(page).toHaveURL(/\/search\?q=many\+things&page=2$/);
    await expect(page.getByRole('heading', { level: 2, name: 'Results 11 to 20' })).toBeVisible();
    // The list goes on from 11, so a result's number is the same wherever it is read.
    await expect(results(page).getByRole('list')).toHaveAttribute('start', '11');
    await page.getByRole('link', { name: 'Next results' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Results 21 to 25' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Next results' })).toHaveCount(0);
    await page.getByRole('link', { name: 'Previous results' }).click();
    await expect(page).toHaveURL(/\/search\?q=many\+things&page=2$/);
    await context.close();
  });

  test('stops at the hundredth result, and says so', async ({ page }) => {
    await page.goto('/search?q=endless&page=10');
    await expect(page.getByRole('heading', { level: 2, name: 'Results 91 to 100' })).toBeVisible();
    await expect(results(page)).toContainText('Only the first 100 results are shown. Add a word to narrow the search.');
    await expect(page.getByRole('link', { name: 'Next results' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Previous results' })).toHaveAttribute('href', '/search?q=endless&page=9');
  });

  test('says each state in plain words: nothing found, too short, too long, too many words, busy, unavailable', async ({ page }) => {
    const states: [string, number, string, string][] = [
      ['zebra', 200, 'Search: no results for zebra', 'Nothing in the archive matches those words. Check the spelling, or try fewer or different words.'],
      ['a', 400, 'Search: please type at least 2 characters', 'Please type at least 2 letters or numbers, then search again.'],
      ['x'.repeat(101), 400, 'Search: that search is too long', 'That search is too long. Please use 100 characters or fewer.'],
      ['a b c d e f g h i', 400, 'Search: that search has too many words', 'That search has too many words. Please use 8 words or fewer.'],
      ['unplain words', 400, 'Search: we could not search for that', 'We could not search for that. Please use plain words.'],
      ['busy day', 503, 'Search is busy', 'Search is busy right now. Please wait a moment, then try again.'],
      ['offline day', 503, 'Search is temporarily unavailable', 'Search is temporarily unavailable. Please try again in a few minutes. The rest of the site still works.'],
    ];
    for (const [query, status, title, words] of states) {
      const res = await page.goto(`/search?q=${encodeURIComponent(query)}`);
      expect(res?.status(), query).toBe(status);
      await expect(page, query).toHaveTitle(`${title} | Northwest Florida Mensa`);
      await expect(page.getByRole('main'), query).toContainText(words);
      // The form stays, with the words in it, so the visitor can change them and try again.
      await expect(box(page), query).toHaveValue(query);
      await expect(page.getByRole('main'), query).not.toContainText(/error|exception|invalid|argument|exhausted|grpc|50[0-9]|40[0-9]/i);
    }
    expect((await page.request.get('/search?q=busy+day')).headers()['retry-after']).toBe('10');
  });

  test('a message about the query is tied to the box, so a screen reader reads it there', async ({ page }) => {
    await page.goto('/search?q=a');
    await expect(box(page)).toHaveAccessibleDescription('Please type at least 2 letters or numbers, then search again.');
  });

  test("holds one visitor, by the edge's address header, to 20 searches a minute: then 429, a time to wait, and plain words", async ({ request }, testInfo) => {
    // An address of this project's own (TEST-NET-3), so the projects running side by side do not share a bucket.
    const visitor = { 'CF-Connecting-IP': `203.0.113.${10 + ['http', 'chromium-desktop', 'chromium-phone', 'webkit-iphone'].indexOf(testInfo.project.name)}` };
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) statuses.push((await request.get('/search?q=zebra', { headers: visitor })).status());
    expect(statuses.slice(0, 20)).toEqual(Array<number>(20).fill(200));
    const refused = await request.get('/search?q=zebra', { headers: visitor });
    expect(statuses[20]).toBe(429);
    expect(refused.status()).toBe(429);
    expect(Number(refused.headers()['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Number(refused.headers()['retry-after'])).toBeLessThanOrEqual(3);
    expect(refused.headers()['cache-control']).toBe('private, no-store');
    expect(await refused.text()).toContain('You have searched many times in a short while. Please wait a moment, then try again.');
    // The form itself is never held back, and nor is anyone else.
    expect((await request.get('/search', { headers: visitor })).status()).toBe(200);
    expect((await request.get('/search?q=zebra', { headers: { 'CF-Connecting-IP': '198.51.100.7' } })).status()).toBe(200);
  });

  test('a result for an article opens /news at that article', async ({ page }) => {
    await page.goto('/search?q=picnic');
    await hits(page).last().getByRole('link', { name: 'A new home for the Wednesday lunch' }).click();
    await expect(page).toHaveURL(/\/news#item-a-new-home-for-the-wednesday-lunch$/);
    const article = page.locator('#item-a-new-home-for-the-wednesday-lunch');
    await expect(article.getByRole('heading', { level: 3, name: 'A new home for the Wednesday lunch' })).toBeVisible();
    await expect(article).toBeInViewport();
  });

  test('a result for an issue opens it in the reader, with the page and the words after the #, which no server is sent', async ({ page }) => {
    const asked: string[] = [];
    page.on('request', (r) => asked.push(r.url()));
    await page.goto('/search?q=quokka');
    asked.length = 0;
    await hits(page).first().getByRole('link', { name: `${newest.title}, page 2`, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/read/${newest.publicPdf}#page=2&find=quokka$`));
    await expect(page.getByRole('heading', { level: 1, name: 'Read the newsletter' })).toBeVisible();
    expect(asked.filter((u) => u.includes('quokka'))).toEqual([]);
  });

  test("a member's search is asked with their token: the results are their copies, and are never stored", async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'member');
    const res = await page.goto('/search?q=picnic');
    expect(res?.headers()['cache-control']).toBe('private, no-store');
    await expect(hits(page).first()).toContainText('From the members copy:');
    await expect(hits(page).first().getByRole('link', { name: `${newest.title}, page 2`, exact: true })).toHaveAttribute('href', new RegExp(`^/read/${newest.membersPdf}#page=2`));
  });

  test('the public search is asked with no token, signed in or not as someone with no member access', async ({ page }) => {
    await page.goto('/search?q=picnic');
    await expect(hits(page).first()).toContainText('From the public copy:');
    await page.goto('/');
    await signIn(page, 'stale');
    await page.goto('/search?q=picnic');
    await expect(hits(page).first()).toContainText('From the public copy:');
  });
});

test.describe('reading the results', () => {
  test('by keyboard: the box, the button, then each result in order, its PDF after it, then Next', async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', 'WebKit tabs to links only with a system setting');
    await page.goto('/search?q=many');
    await box(page).focus();
    const order: string[] = [];
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab');
      order.push(await page.evaluate(() => (document.activeElement?.textContent ?? '').trim()));
    }
    expect(order).toEqual(['Search', 'Pensa Mensa, June-July 2026, page 1', 'PDF file, page 1 of Pensa Mensa, June-July 2026', 'Pensa Mensa, June-July 2026, page 2', 'PDF file, page 2 of Pensa Mensa, June-July 2026']);
    // Every focused link shows a ring the eye can find.
    expect(await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle)).not.toBe('none');
  });

  test('every link and button in the results is at least 48 px tall, and results never sit closer than 8 px', async ({ page }) => {
    await page.goto('/search?q=many');
    const sizes = await page.getByRole('main').locator('.hit__link, .hit .pdf-files a, .pager a, .search-form button, .search-form input').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)));
    expect(sizes.length).toBeGreaterThan(20);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(48);
    const gaps = await hits(page).evaluateAll((els) => els.slice(1).map((el, i) => Math.round(el.getBoundingClientRect().top - els[i]!.getBoundingClientRect().bottom)));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(8);
  });
});

// The accessibility matrix sets its own width, so one browser project runs it.
test.describe('axe and layout on the results', () => {
  test.skip(({ viewport }) => viewport?.width !== 1280, 'sets its own viewport: run by the desktop project alone');

  for (const width of WIDTHS) {
    for (const scheme of ['light', 'dark'] as const) {
      test(`${width} px, ${scheme} system setting: results, nothing found, and a message`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.emulateMedia({ colorScheme: scheme });
        for (const [name, query] of [['results', 'picnic'], ['more', 'many'], ['none', 'zebra'], ['short', 'a'], ['busy', 'busy+day'], ['down', 'offline+day']] as const) {
          await page.goto(`/search?q=${query}`);
          expect(await sideways(page), `${name}: sideways scroll`).toBeLessThanOrEqual(0);
          expect(await axe(page), name).toEqual([]);
          await shot(page, `${name}-${width}-${scheme}`);
        }
      });
    }

    for (const theme of THEMES) {
      test(`${width} px, ${theme} theme at the largest text (${SIZES[6]} %): no violation, nothing cut off`, async ({ page, context, baseURL }) => {
        await setPrefs(context, baseURL!, { size: SIZES[6], theme });
        await page.setViewportSize({ width, height: 800 });
        await page.goto('/search?q=picnic');
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await expect(page.locator('html')).toHaveAttribute('data-size', String(SIZES[6]));
        expect(await sideways(page)).toBeLessThanOrEqual(0);
        // The text really is larger: the reader's setting is honoured, not overridden.
        expect(await hits(page).first().locator('.hit__snippet').evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(28);
        expect(await axe(page)).toEqual([]);
        await shot(page, `results-${width}-${theme}-${SIZES[6]}pct`);
      });
    }
  }

  // 200 % browser zoom on a 1280 px screen is a 640 px page at twice the pixels (WCAG 1.4.4), and on a
  // 640 px screen a 320 px page (1.4.10, reflow).
  for (const [name, width] of [['1280 px screen', 640], ['640 px screen', 320]] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      test(`200 % zoom on a ${name}, ${scheme}: the results reflow, nothing scrolls sideways, no violation`, async ({ browser, baseURL }) => {
        const context = await browser.newContext({ viewport: { width, height: 400 }, deviceScaleFactor: 2, colorScheme: scheme, ignoreHTTPSErrors: true, baseURL: baseURL! });
        const page = await context.newPage();
        await page.goto('/search?q=picnic');
        await expect(hits(page)).toHaveCount(4);
        expect(await sideways(page)).toBeLessThanOrEqual(0);
        expect(await axe(page)).toEqual([]);
        await shot(page, `results-zoom200-${width * 2}-${scheme}`);
        await context.close();
      });
    }
  }

  test('forced colours (Windows high contrast): the words found are still marked, and no violation', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await page.goto('/search?q=picnic');
    const mark = hits(page).first().locator('mark');
    expect(await mark.evaluate((el) => getComputedStyle(el).fontWeight)).toBe('700');
    expect(await axe(page)).toEqual([]);
    await shot(page, 'results-1280-forced-colours');
  });

  test('/news, opened at an article from a result: the article is outlined, and no violation', async ({ page }) => {
    await page.goto('/news#item-a-new-home-for-the-wednesday-lunch');
    expect(await page.locator('#item-a-new-home-for-the-wednesday-lunch').evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
    expect(await axe(page)).toEqual([]);
    await shot(page, 'news-article-opened-1280');
  });
});
