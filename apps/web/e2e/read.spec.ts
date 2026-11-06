// PDFVIEW: /read/<id>, an issue read inside the site. The stand-in API (e2e/api.mjs) serves the newest
// issue's copies as made-up PDFs with pages, text and the copies' links (e2e/synthetic-pdf.mjs). The
// page shows the copy /documents/<id>.pdf gives this reader, says which, draws it with pdf.js page by
// page, and offers Open in another app and Download; without JavaScript it says the reader needs it.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { PUBLIC_CACHE } from '../server/policy.mjs';
import { SIZES } from '../server/prefs.mjs';
import { MEMBERS_COPY, NEEDS_SCRIPT, PUBLIC_COPY } from '../src/lib/reader';
import { setPrefs } from './prefs';
import { SIGN_IN_OFF_URL, SITE_URL } from './servers';
import { signIn } from './signin';
import { LINKS, NEWSLETTER } from './stand-in';
import { LONG_ID, LONG_PAGES, ORIGINAL_ID, ORIGINAL_OUT, OUTSIDE_LINKS, linkRect } from './synthetic-pdf.mjs';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'wcag2aaa', 'best-practice'];
const [newest, older] = NEWSLETTER.issues;
const PUBLIC_ID = newest!.publicPdf;
const MEMBERS_ID = newest!.membersPdf;
const read = (id: string) => `/read/${id}`;

/** Console errors, uncaught errors and CSP violations, from the first byte of the page on. */
async function watch(page: Page): Promise<string[]> {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`error: ${e.message}`));
  await page.addInitScript(() => {
    const said: string[] = [];
    (window as unknown as { __said: string[] }).__said = said;
    document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP ${e.violatedDirective} ${e.blockedURI}`));
    new MutationObserver(() => {
      const text = document.querySelector('[data-viewer-status]')?.textContent ?? '';
      if (text && said.at(-1) !== text) said.push(text);
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  return problems;
}

const viewerPage = (page: Page, n: number) => page.locator(`#page-${n}`);
const drawn = (page: Page, n: number) => viewerPage(page, n).locator('canvas');

/** Whether any pixel of the canvas is neither blank nor white. */
const inked = (canvas: Locator) =>
  canvas.evaluate((el: HTMLCanvasElement) => {
    const data = el.getContext('2d')!.getImageData(0, 0, el.width, el.height).data;
    for (let i = 0; i < data.length; i += 4) if (data[i + 3]! > 0 && (data[i]! < 250 || data[i + 1]! < 250 || data[i + 2]! < 250)) return true;
    return false;
  });

/**
 * axe, every rule. One allowance, for the PDF's own links only: target-size on a link the copy draws in
 * its text, where the page's layout sets its size and spacing (WCAG 2.5.8's inline exception), so long as
 * each is at least 24 px each way, as the reader makes it (the zoom buttons make it larger still).
 */
async function axe(page: Page): Promise<string[]> {
  // The first page's links in the middle of the screen, clear of the sticky bar and the phone's bottom bar.
  await page.evaluate(() => document.querySelector('#page-1 .annotationLayer a')?.scrollIntoView({ block: 'center' }));
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const out: string[] = [];
  for (const v of result.violations) {
    const nodes = v.id === 'target-size' ? v.nodes.filter((n) => !/^#pdfjs_internal_id_\w+$/.test(String(n.target[0]))) : v.nodes;
    if (v.id === 'target-size') {
      for (const n of v.nodes.filter((n) => !nodes.includes(n))) {
        const box = (await page.locator(String(n.target[0])).boundingBox())!;
        if (box.width < 24 || box.height < 24) out.push(`target-size: ${String(n.target[0])} is ${box.width} x ${box.height}`);
      }
    }
    if (nodes.length > 0) out.push(`${v.id}: ${nodes.map((n) => n.target.join(' ')).join(', ')}`);
  }
  return out;
}

const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const press = (isMobile: boolean, target: Locator) => (isMobile ? target.tap() : target.click());

test.describe('/read, the public copy', () => {
  test('draws a multi-page PDF inside the site: a canvas with ink, the text layer, Page 1 of 3', async ({ page }) => {
    const problems = await watch(page);
    const res = await page.goto(read(PUBLIC_ID));
    expect(res?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Read the newsletter');
    await expect(drawn(page, 1)).toHaveCount(1);
    expect(await inked(drawn(page, 1))).toBe(true);
    await expect(viewerPage(page, 1).locator('.textLayer')).toContainText('Public copy, page 1');
    await expect(page.getByLabel('Page', { exact: true })).toHaveValue('1');
    await expect(page.locator('[data-viewer-count]')).toHaveText('3');
    await expect(page.getByText(NEEDS_SCRIPT)).toBeHidden();
    expect(await page.evaluate(() => (window as unknown as { __said: string[] }).__said)).toContain('Loading page 1');
    await expect(page.locator('[data-viewer-status]')).toHaveAttribute('role', 'status');
    expect(problems).toEqual([]);
  });

  test('draws the pages near the window only, and the rest as they come near', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(read(PUBLIC_ID));
    await expect(drawn(page, 1)).toHaveCount(1);
    await expect(drawn(page, 2)).toHaveCount(1);
    await expect(drawn(page, 3)).toHaveCount(0);
    await viewerPage(page, 3).scrollIntoViewIfNeeded();
    await expect(drawn(page, 3)).toHaveCount(1);
    expect(await inked(drawn(page, 3))).toBe(true);
  });

  test('says it is the public copy, with "sign in" a link back here, and offers the file in another app and as a download', async ({ page }) => {
    await page.goto(read(PUBLIC_ID));
    const notice = page.getByText(PUBLIC_COPY);
    await expect(notice).toBeVisible();
    await expect(notice.getByRole('link', { name: 'sign in', exact: true })).toHaveAttribute('href', `/sign-in?return=${encodeURIComponent(read(PUBLIC_ID))}`);
    await expect(page.getByText(MEMBERS_COPY, { exact: true })).toHaveCount(0);
    const open = page.getByRole('link', { name: /^Open in another app/ });
    await expect(open).toHaveAttribute('href', `/documents/${PUBLIC_ID}.pdf`);
    await expect(open).toHaveAttribute('target', '_blank');
    await expect(open).toHaveAttribute('rel', 'noopener');
    await expect(page.getByRole('link', { name: 'Download', exact: true })).toHaveAttribute('href', `/documents/${PUBLIC_ID}.pdf?download=1`);
  });

  test('where sign-in is not set up, "sign in" is plain text', async ({ page }) => {
    await page.goto(`${SIGN_IN_OFF_URL}${read(PUBLIC_ID)}`);
    await expect(page.getByText(PUBLIC_COPY)).toBeVisible();
    await expect(page.locator('main a[href^="/sign-in"]')).toHaveCount(0);
  });

  test('is publicly cached as the public copy is, the same for every reader not signed in', async ({ request }) => {
    const first = await request.get(read(PUBLIC_ID));
    const second = await request.get(read(PUBLIC_ID));
    const file = await request.get(`/documents/${PUBLIC_ID}.pdf`);
    expect(first.status()).toBe(200);
    expect(first.headers()['cache-control']).toBe(PUBLIC_CACHE);
    expect(file.headers()['cache-control']).toBe(PUBLIC_CACHE);
    expect(await first.text()).toBe(await second.text());
  });

  test('a members file, and a file that does not exist, are the same 404 to the public', async ({ request }) => {
    const members = await request.get(read(MEMBERS_ID));
    const missing = await request.get(read('00000000-0000-4000-8000-0000000000aa'));
    const junk = await request.get('/read/not-a-file');
    for (const res of [members, missing, junk]) {
      expect(res.status()).toBe(404);
      expect(res.headers()['cache-control']).toBe('no-store');
    }
    const body = async (res: typeof members, id: string) => (await res.text()).replaceAll(id, '<id>');
    expect(await body(members, MEMBERS_ID)).toBe(await body(missing, '00000000-0000-4000-8000-0000000000aa'));
    expect(await members.text()).not.toContain(`/documents/${MEMBERS_ID}.pdf`);
  });

  test('loads only its own file from this site, whatever the query names', async ({ page }) => {
    const elsewhere: string[] = [];
    page.on('request', (r) => {
      if (!r.url().startsWith(SITE_URL)) elsewhere.push(r.url());
    });
    await page.goto(`${read(PUBLIC_ID)}?file=${encodeURIComponent('https://example.com/a.pdf')}&url=//example.com/b.pdf`);
    await expect(drawn(page, 1)).toHaveCount(1);
    await expect(page.locator('[data-viewer]')).toHaveAttribute('data-pdf', `/documents/${PUBLIC_ID}.pdf`);
    expect(elsewhere).toEqual([]);
  });

  test('opens at the page in #page=N, as the leaving page links back', async ({ page }) => {
    await page.goto(`${read(PUBLIC_ID)}#page=3`);
    await expect(page.getByLabel('Page', { exact: true })).toHaveValue('3');
    await expect(drawn(page, 3)).toHaveCount(1);
  });
});

test.describe('/read controls', () => {
  test('every control works by tap or click: zoom, both fits, next, previous and the page box', async ({ page, isMobile }) => {
    await page.goto(read(PUBLIC_ID));
    await expect(drawn(page, 1)).toHaveCount(1);
    const zoom = page.locator('[data-viewer-zoom]');
    const box = page.getByLabel('Page', { exact: true });
    const fitWidth = page.getByRole('button', { name: 'Fit width' });
    const fitPage = page.getByRole('button', { name: 'Fit page' });
    // A phone opens at Fit width, a computer at Fit page.
    await expect(isMobile ? fitWidth : fitPage).toHaveAttribute('aria-pressed', 'true');
    const first = await zoom.textContent();
    await press(isMobile, page.getByRole('button', { name: 'Zoom in' }));
    await expect(zoom).not.toHaveText(first!);
    await expect(fitWidth).toHaveAttribute('aria-pressed', 'false');
    await expect(fitPage).toHaveAttribute('aria-pressed', 'false');
    await press(isMobile, page.getByRole('button', { name: 'Zoom out' }));
    const out = parseInt((await zoom.textContent())!, 10);
    expect(out).toBeLessThan(parseInt(first!, 10));
    await press(isMobile, fitWidth);
    await expect(fitWidth).toHaveAttribute('aria-pressed', 'true');
    await press(isMobile, fitPage);
    await expect(fitPage).toHaveAttribute('aria-pressed', 'true');
    await press(isMobile, page.getByRole('button', { name: 'Next page' }));
    await expect(box).toHaveValue('2');
    await expect(page.locator('[data-viewer-status]')).toHaveText(/Page 2 of 3|Loading page 2|^$/);
    await press(isMobile, page.getByRole('button', { name: 'Previous page' }));
    await expect(box).toHaveValue('1');
    await box.fill('3');
    await box.press('Enter');
    await expect(box).toHaveValue('3');
    await expect(drawn(page, 3)).toHaveCount(1);
    expect(await inked(drawn(page, 3))).toBe(true);
  });

  test('every control works from the keyboard, in order, with the focus shown', async ({ page }) => {
    await page.goto(read(PUBLIC_ID));
    await expect(drawn(page, 1)).toHaveCount(1);
    const zoom = page.locator('[data-viewer-zoom]');
    const box = page.getByLabel('Page', { exact: true });
    await page.getByRole('link', { name: 'Download', exact: true }).focus();
    const order = ['Zoom out', 'Zoom in', 'Fit width', 'Fit page', 'Previous page', 'Page', 'Next page'];
    for (const name of order) {
      await page.keyboard.press('Tab');
      const focused = page.locator(':focus');
      await expect(focused).toHaveAccessibleName(name);
      expect(await focused.evaluate((el) => getComputedStyle(el).outlineStyle), name).not.toBe('none');
    }
    await page.getByRole('button', { name: 'Zoom in' }).focus();
    const before = await zoom.textContent();
    await page.keyboard.press('Enter');
    await expect(zoom).not.toHaveText(before!);
    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: 'Zoom in' })).toBeFocused();
    await page.getByRole('button', { name: 'Fit width' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Fit width' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Next page' }).focus();
    await page.keyboard.press('Enter');
    await expect(box).toHaveValue('2');
    await page.keyboard.press('Enter');
    await expect(box).toHaveValue('3');
    // At the last page Next stays in place, still focused, and says it cannot go on.
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Next page' })).toBeFocused();
    await expect(page.getByRole('button', { name: 'Next page' })).toHaveAttribute('aria-disabled', 'true');
    await box.focus();
    await box.selectText();
    await page.keyboard.type('1');
    await page.keyboard.press('Enter');
    await expect(box).toHaveValue('1');
    await page.getByRole('button', { name: 'Zoom out' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Zoom out' })).toBeFocused();
  });

  test('every control is a visible target of at least 48 px', async ({ page }) => {
    await page.goto(read(PUBLIC_ID));
    await expect(drawn(page, 1)).toHaveCount(1);
    for (const name of ['Zoom out', 'Zoom in', 'Fit width', 'Fit page', 'Previous page', 'Next page']) {
      const box = (await page.getByRole('button', { name }).boundingBox())!;
      expect(box.height, name).toBeGreaterThanOrEqual(48);
      expect(box.width, name).toBeGreaterThanOrEqual(48);
    }
    const input = (await page.getByLabel('Page', { exact: true }).boundingBox())!;
    expect(input.height).toBeGreaterThanOrEqual(48);
    const zoom = (await page.locator('[data-viewer-zoom]').boundingBox())!;
    expect(zoom.height).toBeGreaterThanOrEqual(48);
  });

  test("the controls take the reader's text size and theme", async ({ page, context, baseURL }) => {
    await setPrefs(context, baseURL!, { size: 140, theme: 'dark' });
    await page.goto(read(PUBLIC_ID));
    await expect(drawn(page, 1)).toHaveCount(1);
    const zoomIn = page.getByRole('button', { name: 'Zoom in' });
    expect(await zoomIn.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(1.125 * 16 * 1.4 - 0.5);
    const [bar, body] = await page.evaluate(() => [getComputedStyle(document.querySelector('[data-viewer-bar]')!).backgroundColor, getComputedStyle(document.body).backgroundColor]);
    expect(bar).not.toBe('rgb(255, 255, 255)');
    expect(body).toBe('rgb(13, 26, 32)');
  });
});

test.describe('/read links', () => {
  test("a copy's link goes to this site's leaving page in the same tab, and Back returns to its page", async ({ page, context }) => {
    await page.goto(`${read(PUBLIC_ID)}#page=2`);
    const link = viewerPage(page, 2).getByRole('link', { name: 'Link to club.example' });
    await expect(link).toHaveAttribute('href', `/out/${LINKS.web.id}`);
    const pages = context.pages().length;
    await link.click();
    await expect(page).toHaveURL(`${SITE_URL}/out/${LINKS.web.id}`);
    expect(context.pages()).toHaveLength(pages);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('You are leaving the Northwest Florida Mensa site');
    await page.getByRole('link', { name: 'Back to the newsletter' }).click();
    await expect(page).toHaveURL(`${SITE_URL}${read(LINKS.file)}#page=${LINKS.web.page}`);
    await expect(page.getByLabel('Page', { exact: true })).toHaveValue(String(LINKS.web.page));
  });

  test('a link within the issue goes to its page, and links are reached by the keyboard', async ({ page }) => {
    await page.goto(read(PUBLIC_ID));
    await expect(drawn(page, 1)).toHaveCount(1);
    const links = viewerPage(page, 1).getByRole('link');
    await expect(links).toHaveCount(3);
    await expect(links.nth(0)).toHaveAccessibleName('Link to www.facebook.com');
    await expect(links.nth(1)).toHaveAccessibleName('Link to example.org');
    await links.nth(2).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Page', { exact: true })).toHaveValue('3');
  });
});

// PDFVIEW fix 1 (B1): the API serves an officer the original, with its own links (apps/api files.ts).
// None may skip the leaving page: only /out/<id> (this site's, in the same tab) and a place in the issue
// are ever a link. Every request to any other host is stopped here and counted; none may be made.
test.describe('/read, an original with outside links', () => {
  test("no outside link is drawn or followed: only this site's leaving page and a place in the issue are links", async ({ page, context, isMobile }) => {
    const outside: string[] = [];
    const popups: string[] = [];
    const dialogs: string[] = [];
    await context.route('**/*', (route) => {
      const host = new URL(route.request().url()).hostname;
      if (host === 'localhost' || host === '127.0.0.1') return route.continue();
      outside.push(route.request().url());
      return route.abort();
    });
    page.on('popup', (p) => popups.push(p.url()));
    page.on('dialog', (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    await page.goto('/news');
    await signIn(page, 'officer');
    const problems = await watch(page);
    expect((await page.goto(read(ORIGINAL_ID)))?.status()).toBe(200);
    await expect(drawn(page, 1)).toHaveCount(1);
    const layer = viewerPage(page, 1).locator('.annotationLayer');
    await expect(layer.getByRole('link', { name: 'IN-ISSUE' })).toHaveAttribute('href', '#');
    const hrefs = await layer.locator('a').evaluateAll((as) => as.map((a) => `${a.getAttribute('aria-label')} ${a.getAttribute('href')} ${a.getAttribute('target')}`));
    expect(hrefs.sort()).toEqual([...ORIGINAL_OUT.map(([name]) => `${name} /out/${LINKS.web.id} null`), 'IN-ISSUE # null'].sort());
    for (const [name] of OUTSIDE_LINKS) await expect(layer.getByRole('link', { name }), name).toHaveCount(0);
    // A tap or click where each outside link is in the PDF goes nowhere.
    const where = viewerPage(page, 1);
    for (const [k, [name]] of OUTSIDE_LINKS.entries()) {
      const [x1, y1, x2, y2] = linkRect(k);
      await where.evaluate((el, y) => window.scrollBy(0, el.getBoundingClientRect().top + (y * el.getBoundingClientRect().height) / 792 - window.innerHeight / 2), 792 - (y1 + y2) / 2);
      const box = (await where.boundingBox())!;
      const scale = box.height / 792;
      const [x, y] = [box.x + ((x1 + x2) / 2) * scale, box.y + (792 - (y1 + y2) / 2) * scale];
      if (isMobile) await page.touchscreen.tap(x, y);
      else await page.mouse.click(x, y);
      await page.waitForTimeout(200);
      expect(page.url(), name).toBe(`${SITE_URL}${read(ORIGINAL_ID)}`);
    }
    expect(outside).toEqual([]);
    expect(popups).toEqual([]);
    expect(dialogs).toEqual([]);
    expect(problems).toEqual([]);
    // An /out/<id> the original names on another origin is still only this site's leaving page, in this tab.
    await layer.getByRole('link', { name: 'OUT-EVILOUT' }).click();
    await expect(page).toHaveURL(`${SITE_URL}/out/${LINKS.web.id}`);
    expect(context.pages()).toHaveLength(1);
    expect(outside).toEqual([]);
  });
});

// PDFVIEW fix 1 (B2): pinned at the top, the bar of a large text size took the whole of a landscape
// phone's window. It stays pinned only while it takes at most a third of the window.
const visibleOfPage = (page: Page, n: number) =>
  page.evaluate((n) => {
    const bar = document.querySelector('[data-viewer-bar]')!.getBoundingClientRect();
    const box = document.querySelector(`#page-${n}`)!.getBoundingClientRect();
    const covered = bar.bottom > 0 && bar.top < innerHeight ? bar.bottom : 0;
    return { visible: Math.max(0, Math.min(innerHeight, box.bottom) - Math.max(0, box.top, covered)), height: innerHeight, bar: Math.round(bar.height) };
  }, n);

for (const [width, height] of [
  [667, 375],
  [740, 360],
] as const) {
  for (const size of [140, 175]) {
    test.describe(`/read on a landscape phone, ${width} x ${height}, at ${size} % text`, () => {
      test.use({ viewport: { width, height } });

      test('after Next page, at least half the window shows the page, and a link reached by the keyboard is not under the bar', async ({ page, context, baseURL }) => {
        await setPrefs(context, baseURL!, { size });
        await page.goto(read(PUBLIC_ID));
        await viewerPage(page, 1).scrollIntoViewIfNeeded();
        await expect(drawn(page, 1)).toHaveCount(1);
        await page.getByRole('button', { name: 'Next page' }).click();
        await expect(page.getByLabel('Page', { exact: true })).toHaveValue('2');
        await page.waitForTimeout(300);
        const shown = await visibleOfPage(page, 2);
        expect(shown.visible, JSON.stringify(shown)).toBeGreaterThanOrEqual(shown.height / 2);
        await expect(drawn(page, 2)).toHaveCount(1);
        const link = viewerPage(page, 2).getByRole('link', { name: 'Link to club.example' });
        await link.focus();
        const r = await link.evaluate((a) => {
          const bar = document.querySelector('[data-viewer-bar]')!.getBoundingClientRect();
          const box = a.getBoundingClientRect();
          return { top: box.top, bottom: box.bottom, barTop: bar.top, barBottom: bar.bottom, vh: innerHeight };
        });
        expect(r.top < r.barBottom && r.bottom > r.barTop, JSON.stringify(r)).toBe(false);
        expect(r.bottom > 0 && r.top < r.vh, JSON.stringify(r)).toBe(true);
      });
    });
  }
}

test.describe('/read on a computer', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('the bar stays at the top while reading, where it takes little of the window', async ({ page }) => {
    await page.goto(read(PUBLIC_ID));
    await expect(drawn(page, 1)).toHaveCount(1);
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(page.getByLabel('Page', { exact: true })).toHaveValue('2');
    const bar = (await page.locator('[data-viewer-bar]').boundingBox())!;
    expect(bar.y).toBeGreaterThanOrEqual(0);
    expect(bar.y).toBeLessThan(2);
    await expect(page.getByRole('button', { name: 'Next page' })).toBeInViewport();
    const shown = await visibleOfPage(page, 2);
    expect(shown.visible).toBeGreaterThanOrEqual(shown.height / 2);
  });
});

test.describe('/read on a short computer window', () => {
  test.use({ viewport: { width: 1280, height: 600 } });

  test('the bar lets go of the top as soon as the reader picks a text size that makes it too tall, with no resize', async ({ page }) => {
    await page.goto(read(PUBLIC_ID));
    await expect(drawn(page, 1)).toHaveCount(1);
    const viewer = page.locator('[data-viewer]');
    await expect(viewer).not.toHaveClass(/viewer--unpinned/);
    // What the text size panel (public/scripts/size.js) does: the page's own size, at once.
    await page.evaluate(() => (document.documentElement.dataset['size'] = '175'));
    await expect(viewer).toHaveClass(/viewer--unpinned/);
    expect(await page.locator('[data-viewer-bar]').evaluate((el) => getComputedStyle(el).position)).toBe('static');
    await page.getByRole('button', { name: 'Next page' }).click();
    const shown = await visibleOfPage(page, 2);
    expect(shown.visible, JSON.stringify(shown)).toBeGreaterThanOrEqual(shown.height / 2);
  });
});

// PDFVIEW fix 1 (S1): past MAX_PAGES the reader draws nothing and says, politely, that the file is too
// long to show here, leaving Open in another app and Download; a file of 200,000 pages hung the tab.
test.describe('/read, a very long file', () => {
  test('says it is too long to show here, and offers Open in another app and Download', async ({ page }) => {
    test.setTimeout(60_000);
    const problems = await watch(page);
    expect((await page.goto(read(LONG_ID)))?.status()).toBe(200);
    // The words themselves are pinned in test/viewer-script.test.ts (TOO_LONG); MAX_PAGES there is 1000.
    const status = page.locator('[data-viewer-status]');
    await expect(status).toHaveText(/^This issue is too long to show here\. You can open it in another app, or download it\.$/, { timeout: 30_000 });
    await expect(status).toBeVisible();
    await expect(page.locator('[data-viewer-count]')).not.toHaveText(String(LONG_PAGES));
    await expect(page.locator('.viewer-page')).toHaveCount(0);
    await expect(page.locator('[data-viewer-bar]')).toBeHidden();
    await expect(page.getByRole('link', { name: /^Open in another app/ })).toHaveAttribute('href', `/documents/${LONG_ID}.pdf`);
    await expect(page.getByRole('link', { name: 'Download' })).toHaveAttribute('href', `/documents/${LONG_ID}.pdf?download=1`);
    expect(problems).toEqual([]);
  });
});

test.describe('/read, the members copy', () => {
  test('a member reads the members copy, told so, never stored; the public copy still says it is the public one', async ({ page }) => {
    await page.goto('/news');
    await signIn(page, 'member');
    const problems = await watch(page);
    const res = await page.goto(read(MEMBERS_ID));
    expect(res?.status()).toBe(200);
    expect(res?.headers()['cache-control']).toBe('private, no-store');
    await expect(page.getByText(MEMBERS_COPY, { exact: true })).toBeVisible();
    await expect(page.getByText(PUBLIC_COPY)).toHaveCount(0);
    await expect(viewerPage(page, 1).locator('.textLayer')).toContainText('Members copy, page 1');
    await expect(page.locator('[data-viewer-count]')).toHaveText('2');
    expect(await inked(drawn(page, 1))).toBe(true);
    const file = await page.request.get(`/documents/${MEMBERS_ID}.pdf`);
    expect(file.headers()['cache-control']).toBe('private, no-store');
    const publicCopy = await page.goto(read(PUBLIC_ID));
    expect(publicCopy?.headers()['cache-control']).toBe('private, no-store');
    await expect(page.getByText(/^Public copy: some personal details are hidden for privacy\./)).toBeVisible();
    await expect(page.locator('main a[href^="/sign-in"]')).toHaveCount(0);
    expect(problems).toEqual([]);
  });
});

test.describe('/read, Download', () => {
  test('download=1 is the same file as an attachment, under the same name, the same cache rule, for the public and a member', async ({ page, request }) => {
    const check = async (get: (url: string) => Promise<{ status(): number; headers(): Record<string, string>; body(): Promise<Buffer> }>, id: string) => {
      const inline = await get(`/documents/${id}.pdf`);
      const attached = await get(`/documents/${id}.pdf?download=1`);
      expect(attached.status()).toBe(200);
      expect(inline.headers()['content-disposition']).toMatch(/^inline; filename="[a-z0-9-]+\.pdf"$/);
      expect(attached.headers()['content-disposition']).toBe(inline.headers()['content-disposition']!.replace(/^inline/, 'attachment'));
      for (const name of ['cache-control', 'content-type', 'content-length', 'cdn-cache-control', 'content-security-policy']) expect(attached.headers()[name], name).toBe(inline.headers()[name]);
      expect((await attached.body()).equals(await inline.body())).toBe(true);
      // Any other value is no download.
      for (const q of ['download=0', 'download=true', 'download=1x', 'download=01', 'Download=1']) expect((await get(`/documents/${id}.pdf?${q}`)).headers()['content-disposition'], q).toMatch(/^inline;/);
    };
    await check((url) => request.get(url), PUBLIC_ID);
    // download=1 cannot reach a copy the reader may not have.
    expect((await request.get(`/documents/${MEMBERS_ID}.pdf?download=1`)).status()).toBe(404);
    await page.goto('/news');
    await signIn(page, 'member');
    await check((url) => page.request.get(url), MEMBERS_ID);
    expect((await page.request.get(`/documents/${MEMBERS_ID}.pdf?download=1`)).headers()['cache-control']).toBe('private, no-store');
  });

  test('the Download button saves the file', async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', 'WebKit opens a PDF attachment in place in Playwright; the headers are checked above');
    await page.goto(read(PUBLIC_ID));
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Download', exact: true }).click()]);
    expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  });
});

test.describe('/read without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('says the reader needs JavaScript, with the notice, Open in another app and Download', async ({ page }) => {
    await page.goto(read(PUBLIC_ID));
    await expect(page.getByText(NEEDS_SCRIPT)).toBeVisible();
    await expect(page.getByText(PUBLIC_COPY)).toBeVisible();
    await expect(page.getByRole('link', { name: /^Open in another app/ })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Download', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Zoom in' })).toBeHidden();
  });
});

test.describe('/read accessibility', () => {
  test('axe at the largest text size, drawn', async ({ page, context, baseURL }) => {
    await setPrefs(context, baseURL!, { size: SIZES.at(-1)! });
    const problems = await watch(page);
    await page.goto(read(PUBLIC_ID));
    await expect(page.locator('html')).toHaveAttribute('data-size', '175');
    // On a phone at this size page 1 starts more than a screen down: it is drawn as it comes near.
    await viewerPage(page, 1).scrollIntoViewIfNeeded();
    await expect(drawn(page, 1)).toHaveCount(1);
    expect(await axe(page)).toEqual([]);
    expect(problems).toEqual([]);
  });

  for (const theme of ['contrast-yellow', 'contrast-white'] as const) {
    test(`axe in high contrast (${theme}), drawn`, async ({ page, context, baseURL }) => {
      await setPrefs(context, baseURL!, { theme });
      await page.goto(read(PUBLIC_ID));
      await expect(drawn(page, 1)).toHaveCount(1);
      expect(await axe(page)).toEqual([]);
    });
  }

  // axe runs in the page, so the reader's own script is kept from loading instead: the page as without it.
  test('axe without the reader script, as with JavaScript off', async ({ page }) => {
    await page.route('**/scripts/viewer.js', (route) => route.abort());
    await page.goto(read(PUBLIC_ID));
    await expect(page.getByText(NEEDS_SCRIPT)).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });

  test.describe('on a narrow phone at the largest text size', () => {
    test.use({ viewport: { width: 320, height: 640 } });

    test('nothing scrolls sideways, and the page fits the width', async ({ page, context, baseURL }) => {
      await setPrefs(context, baseURL!, { size: SIZES.at(-1)! });
      await page.goto(read(PUBLIC_ID));
      // At this size the notice, the buttons and the bar fill more than a screen: page 1 is drawn as it comes near.
      await viewerPage(page, 1).scrollIntoViewIfNeeded();
      await expect(drawn(page, 1)).toHaveCount(1);
      expect(await sideways(page)).toBeLessThanOrEqual(0);
      const box = (await viewerPage(page, 1).boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(320);
      for (const name of ['Zoom out', 'Zoom in', 'Fit width', 'Fit page', 'Previous page', 'Next page']) {
        const b = (await page.getByRole('button', { name }).boundingBox())!;
        expect(b.x + b.width, name).toBeLessThanOrEqual(320);
      }
    });
  });
});

test.describe('/news leads to the reader', () => {
  test('"Read this issue" and each past issue go to /read, and a small "PDF file" link keeps the file itself', async ({ page }) => {
    await page.goto('/news');
    const card = page.getByRole('region', { name: newest!.title });
    await expect(card.getByRole('link', { name: 'Read this issue', exact: true })).toHaveAttribute('href', read(PUBLIC_ID));
    await expect(card.getByRole('link', { name: /^PDF file/ })).toHaveAttribute('href', `/documents/${PUBLIC_ID}.pdf`);
    const row = page.getByRole('region', { name: 'Past issues' }).getByRole('listitem').filter({ hasText: older!.title });
    await expect(row.getByRole('link', { name: older!.title, exact: true })).toHaveAttribute('href', read(older!.publicPdf));
    await expect(row.getByRole('link', { name: /^PDF file/ })).toHaveAttribute('href', `/documents/${older!.publicPdf}.pdf`);
    for (const issues of [card, page.getByRole('region', { name: 'Past issues' })]) await expect(issues.getByText('(PDF)')).toHaveCount(0);
    await card.getByRole('link', { name: 'Read this issue', exact: true }).click();
    await expect(page).toHaveURL(`${SITE_URL}${read(PUBLIC_ID)}`);
    await expect(drawn(page, 1)).toHaveCount(1);
  });
});
