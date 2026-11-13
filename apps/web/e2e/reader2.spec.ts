// READER2 (the editor, 2026-11-10): the reader's four asks, in a real browser.
// 1. DARKPDF: the pages follow the site's theme, live; dark recolours the page and never a picture;
//    Light pages shows them as printed (e2e/synthetic-pdf.mjs PICTURE_PDF: a photo, red over blue).
// 2. Search within the issue: a magnifier opens a search row in the bar, "n of N", previous and next,
//    Escape to close; matches marked in the text layer and scrolled to; only the copy served is searched.
// 3. Zoomed wider than the frame on a computer: a scrollbar at the foot of the window, the wheel sideways,
//    Shift and the wheel, and a hand tool that drags the page (a press without a drag still follows a link).
// 4. |<< < [n] of N > >>|, the page typed; one row of 44 px targets at 300 to 390 px, what has no room in
//    a More menu (the editor's order: page controls, then search, then Fit, then zoom, then Download and Open).
// No native select; neither text box raises a CSP violation, in WebKit too.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import sharp from 'sharp';
import { NO_TEXT } from '../public/scripts/viewer-find.js';
import { noPage } from '../public/scripts/viewer.js';
import { SIZES } from '../server/prefs.mjs';
import { setPrefs } from './prefs';
import { NEWSLETTER } from './stand-in';
import { PICTURE_ID, REPEAT_ID } from './synthetic-pdf.mjs';
import { barControls, control, more, moreList, onBar, pageBox, pickZoom } from './viewer-bar';

const READ = `/read/${NEWSLETTER.issues[0]!.publicPdf}`;
const PICTURES = `/read/${PICTURE_ID}`;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'wcag2aaa', 'best-practice'];
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const sheet = (page: Page, n: number) => page.locator(`#page-${n} canvas.viewer-sheet`);
const viewer = (page: Page) => page.locator('[data-viewer]');
const findBox = (page: Page) => page.getByRole('textbox', { name: 'Search this issue' });
const findCount = (page: Page) => page.locator('[data-viewer-find-count]');
const marks = (page: Page) => page.locator('mark.viewer-hit');
const box = async (l: Locator) => (await l.boundingBox())!;

async function opened(page: Page, path = READ) {
  await page.goto(path);
  await expect(sheet(page, 1)).toHaveCount(1);
}

async function rows(locators: Locator[]): Promise<number> {
  const tops = new Set<number>();
  for (const l of locators) tops.add(Math.round((await box(l)).y / 8));
  return tops.size;
}

/** What the reader sees of page 1, fitted whole on the screen: a pixel at (x, y), as fractions of the page. */
async function seen(page: Page): Promise<(x: number, y: number) => [number, number, number]> {
  await (await control(page, 'fit-page')).click();
  await page.keyboard.press('Escape');
  await page.locator('#page-1').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(150);
  const clip = await box(page.locator('#page-1'));
  const png = await page.screenshot({ clip });
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return (x, y) => {
    const px = Math.min(info.width - 1, Math.round(x * info.width));
    const py = Math.min(info.height - 1, Math.round(y * info.height));
    const i = (py * info.width + px) * info.channels;
    return [data[i]!, data[i + 1]!, data[i + 2]!];
  };
}
// On page 1 of PICTURE_PDF (612 x 792 pt): blank paper near the foot, and the photo's red and blue halves.
const PAPER: [number, number] = [0.9, 0.95];
const RED: [number, number] = [0.36, 0.5];
const BLUE: [number, number] = [0.36, 0.72];

async function axe(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return result.violations.flatMap((v) => {
    const nodes = v.id === 'target-size' ? v.nodes.filter((n) => !/^#pdfjs_internal_id_\w+$/.test(String(n.target[0]))) : v.nodes;
    return nodes.length > 0 ? [`${v.id} (${v.impact}): ${nodes.map((n) => n.target.join(' ')).join(', ')}`] : [];
  });
}

test.describe('page controls: |<< < [n] of N > >>|', () => {
  test('a page typed and Enter, or the box left, goes there; one not in the issue is said, and the box given back', async ({ page }) => {
    await opened(page);
    const input = page.getByRole('textbox', { name: 'Page number, 1 to 3' });
    await expect(input).toHaveValue('1');
    await expect(page.locator('[data-viewer-count]')).toHaveText('3');
    await expect(input).toHaveAttribute('inputmode', 'numeric');
    await expect(input).toHaveAttribute('enterkeyhint', 'go');
    await input.fill('3');
    await input.press('Enter');
    await expect(page.locator('#page-3')).toBeInViewport();
    // Said politely, until the page is drawn (as next and back say theirs).
    await expect(page.locator('[data-viewer-status]')).toHaveText(/^(Page 3 of 3|Loading page 3|)$/);
    await input.fill('9');
    await input.press('Enter');
    await expect(page.locator('[data-viewer-status]')).toHaveText(noPage(3));
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(input).toHaveValue('3');
    // Left, as an iPhone's number pad (no Enter) leaves it.
    await input.fill('2');
    await input.blur();
    await expect(input).toHaveValue('2');
    await expect(page.locator('#page-2')).toBeInViewport();
    await expect(input).not.toHaveAttribute('aria-invalid', 'true');
    await page.getByRole('button', { name: 'First page' }).click();
    await expect(input).toHaveValue('1');
    await expect(page.getByRole('button', { name: 'First page' })).toHaveAttribute('aria-disabled', 'true');
    await page.getByRole('button', { name: 'Last page' }).click();
    await expect(input).toHaveValue('3');
    await expect(page.getByRole('button', { name: 'Last page' })).toHaveAttribute('aria-disabled', 'true');
  });

  for (const width of [300, 320, 344, 360, 390]) {
    test(`at ${width} px: one row of 44 px targets inside the screen, the page controls always, the rest in More`, async ({ page }) => {
      await page.setViewportSize({ width, height: 780 });
      await opened(page);
      const controls = await barControls(page);
      expect(await rows(controls)).toBe(1);
      for (const c of controls) {
        const b = await box(c);
        const name = (await c.getAttribute('title')) ?? '';
        expect(b.width, name).toBeGreaterThanOrEqual(44);
        expect(b.height, name).toBeGreaterThanOrEqual(44);
        expect(b.x, name).toBeGreaterThanOrEqual(0);
        expect(b.x + b.width, name).toBeLessThanOrEqual(width);
      }
      for (const name of ['First page', 'Previous page', 'Next page', 'Last page', 'More controls']) await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
      await expect(pageBox(page)).toBeVisible();
      // Search stays on the bar down to the Fold's cover (344 px); below, it is the first thing in More.
      await expect(onBar(page, 'find')).toBeVisible({ visible: width >= 344 });
      expect(await sideways(page)).toBeLessThanOrEqual(0);
      await more(page).click();
      const menu = moreList(page);
      await expect(menu).toBeVisible();
      const m = await box(menu);
      expect(m.x).toBeGreaterThanOrEqual(0);
      expect(m.x + m.width).toBeLessThanOrEqual(width);
      const items = menu.locator('.vmore__item:visible');
      const names = await items.evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? el.textContent!.trim()));
      expect(names).toEqual([...(width < 344 ? ['Search this issue'] : []), 'Fit width', 'Fit page', expect.stringMatching(/^Zoom \d+%$/), 'Zoom out', 'Zoom in', 'Download', expect.stringMatching(/^Open in another app/)]);
      for (const item of await menu.locator('.vpick__choice:visible').all()) expect((await box(item)).height).toBeGreaterThanOrEqual(44);
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
      await expect(more(page)).toBeFocused();
    });
  }

  // S7: a group moves into More only when the bar would not fit it on one row, by measure: Download and
  // Open stay on the bar wherever they fit (a tablet held upright, 768 or 820 px, at the default size).
  test('Download and Open stay on the bar wherever they fit; More holds exactly what the bar has no room for, at every width and size', async ({ page, context, baseURL, isMobile }) => {
    test.skip(isMobile, 'widths up to a computer');
    for (const size of [100, 175]) {
      await setPrefs(context, baseURL!, { theme: 'dark', size });
      await page.setViewportSize({ width: 1280, height: 800 });
      await opened(page);
      for (const width of [1280, 1024, 820, 768, 700, 600, 480, 390, 300]) {
        await page.setViewportSize({ width, height: 800 });
        await expect.poll(async () => rows(await barControls(page)), String(width)).toBe(1);
        expect(await sideways(page)).toBeLessThanOrEqual(0);
        const shed = (await viewer(page).getAttribute('class'))!.split(' ').filter((c) => c.startsWith('viewer--shed-')).map((c) => c.slice(13));
        if (width >= 1024 || (width >= 768 && size === 100)) expect(shed, `${width} at ${size} %`).toEqual([]);
        // In order: Light pages first, then Download and Open, then zoom, then Fit, then search.
        expect(['tone', 'file', 'zoom', 'fit', 'find'].slice(0, shed.length), String(width)).toEqual(shed);
        for (const act of ['download', 'open'] as const) await expect(onBar(page, act)).toBeVisible({ visible: !shed.includes('file') });
        await expect(more(page)).toBeVisible({ visible: shed.length > 0 });
        if (shed.length === 0) continue;
        await more(page).click();
        const groups = await moreList(page).locator('.vmore__item:visible').evaluateAll((els) => [...new Set(els.map((el) => el.getAttribute('data-ov-item')))]);
        expect(groups.sort(), String(width)).toEqual([...shed].sort());
        await page.keyboard.press('Escape');
      }
    }
  });

  test('a control on the bar keeps the focus while the window narrows, so long as it still fits', async ({ page, isMobile }) => {
    test.skip(isMobile, 'a window a computer resizes');
    await page.setViewportSize({ width: 1280, height: 800 });
    await opened(page);
    const download = onBar(page, 'download');
    await download.focus();
    for (const width of [1200, 1100, 1024, 900]) {
      await page.setViewportSize({ width, height: 800 });
      await page.waitForTimeout(100);
      await expect(download).toBeFocused();
    }
  });

  test('at the largest text size on the narrowest screen, at most two rows, and nothing scrolls sideways', async ({ page, context, baseURL }) => {
    await page.setViewportSize({ width: 300, height: 700 });
    await setPrefs(context, baseURL!, { size: SIZES.at(-1)! });
    await page.goto(READ);
    await expect(page.locator('[data-viewer-page]')).toBeVisible();
    expect(await rows(await barControls(page))).toBeLessThanOrEqual(2);
    expect(await sideways(page)).toBeLessThanOrEqual(0);
  });

  test('neither text box, nor the menus, raise a CSP violation (WebKit flags a native select), and there is no select', async ({ page }) => {
    await page.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { __csp: string[] }).__csp = seen;
      document.addEventListener('securitypolicyviolation', (e) => seen.push(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`));
    });
    await opened(page);
    await expect(page.locator('select')).toHaveCount(0);
    await pageBox(page).click();
    await page.keyboard.type('2');
    await page.keyboard.press('Enter');
    await expect(pageBox(page)).toHaveValue('2');
    await (await control(page, 'find')).click();
    await page.keyboard.type('picnic');
    await page.keyboard.press('Enter');
    await expect(findCount(page)).toHaveText('1 of 1');
    await page.keyboard.press('Escape');
    if (await more(page).isVisible()) {
      await more(page).click();
      await page.keyboard.press('Escape');
    }
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
  });
});

/** WCAG relative luminance of an sRGB pixel, and the contrast of two. */
const luminance = ([r, g, b]: number[]) => {
  const f = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
};
const contrastOf = (a: number[], b: number[]) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};
/** The contrast of the text inside a box on the screen: its commonest colour (the ground) against the one farthest from it (the glyphs' core). */
async function textContrast(page: Page, l: Locator): Promise<number> {
  await l.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' }));
  await page.waitForTimeout(150);
  const b = await box(l);
  const png = await page.screenshot({ clip: { x: b.x + 3, y: b.y + 3, width: b.width - 6, height: b.height - 6 } });
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const px: number[][] = [];
  for (let i = 0; i < data.length; i += info.channels) px.push([data[i]!, data[i + 1]!, data[i + 2]!]);
  const counts = new Map<string, number>();
  for (const p of px) counts.set(p.join(), (counts.get(p.join()) ?? 0) + 1);
  const ground = [...counts.entries()].sort((p, q) => q[1] - p[1])[0]![0].split(',').map(Number);
  const glyph = px.reduce((far, p) => (Math.abs(luminance(p) - luminance(ground)) > Math.abs(luminance(far) - luminance(ground)) ? p : far), ground);
  return Math.round(contrastOf(ground, glyph) * 100) / 100;
}

test.describe('search within the issue', () => {
  // S6: the text under a match, the current one and the others, keeps 4.5:1 in every theme.
  for (const theme of ['light', 'dark', 'contrast-yellow', 'contrast-white'] as const) {
    test(`text under a match keeps 4.5:1 or more, current and others (${theme})`, async ({ page, context, baseURL }) => {
      await setPrefs(context, baseURL!, { theme });
      await opened(page);
      await pickZoom(page, '200%');
      await (await control(page, 'find')).click();
      await findBox(page).fill('public');
      await expect(findCount(page)).toHaveText(/^1 of /);
      const current = page.locator('#page-1 mark.viewer-hit--current');
      expect.soft(await textContrast(page, current), 'current match').toBeGreaterThanOrEqual(4.5);
      await findBox(page).fill('o');
      await expect(findCount(page)).toHaveText(/^1 of /);
      const other = page.locator('#page-1 mark.viewer-hit:not(.viewer-hit--current)').nth(1);
      expect(await textContrast(page, other), 'another match').toBeGreaterThanOrEqual(4.5);
    });
  }

  test('finds each match in the copy served, says which of how many, marks it and goes to it; Escape closes and takes the marks away', async ({ page }) => {
    await opened(page);
    const opener = await control(page, 'find');
    await opener.click();
    await expect(findBox(page)).toBeFocused();
    await findBox(page).fill('PUBLIC   copy');
    await expect(findCount(page)).toHaveText('1 of 3');
    const current = page.locator('#page-1 mark.viewer-hit--current');
    await expect(current).toHaveText('Public copy');
    await expect(current).toBeInViewport();
    expect(await current.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
    await findBox(page).press('Enter');
    await expect(findCount(page)).toHaveText('2 of 3');
    await expect(page.locator('#page-2 mark.viewer-hit--current')).toBeInViewport();
    await expect(pageBox(page)).toHaveValue('2');
    await page.getByRole('button', { name: 'Previous match' }).click();
    await expect(findCount(page)).toHaveText('1 of 3');
    await findBox(page).press('Shift+Enter');
    await expect(findCount(page)).toHaveText('3 of 3');
    // The members copy's own words are not in the public copy: nothing is found.
    await findBox(page).fill('members copy');
    await expect(findCount(page)).toHaveText('No matches');
    await expect(marks(page)).toHaveCount(0);
    await findBox(page).fill('picnic');
    await expect(findCount(page)).toHaveText('1 of 1');
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-viewer-find-bar]')).toBeHidden();
    await expect(marks(page)).toHaveCount(0);
    await expect(onBar(page, 'find')).toHaveAttribute('aria-expanded', 'false');
    await expect(onBar(page, 'find')).toBeFocused();
  });

  test('"/" opens it from the page; never from a text box', async ({ page }) => {
    await opened(page);
    await page.locator('h1').click();
    await page.keyboard.press('/');
    await expect(findBox(page)).toBeFocused();
    await page.keyboard.press('Escape');
    await pageBox(page).focus();
    await page.keyboard.press('/');
    await expect(page.locator('[data-viewer-find-bar]')).toBeHidden();
  });

  test('a scanned page (no text) says it has no searchable text', async ({ page }) => {
    await opened(page, PICTURES);
    await (await control(page, 'find')).click();
    await expect(page.locator('[data-viewer-find-note]')).toBeHidden();
    await page.getByRole('button', { name: 'Last page' }).click();
    await expect(page.locator('[data-viewer-find-note]')).toHaveText(NO_TEXT);
    await expect(page.locator('[data-viewer-find-note]')).toBeVisible();
    await findBox(page).fill('photo');
    await expect(findCount(page)).toHaveText('1 of 2');
  });
});

test.describe('DARKPDF: the pages follow the theme', () => {
  test('dark recolours the page, light text on dark, and leaves the photo as it is; Light pages shows it as printed', async ({ page, context, baseURL }) => {
    await setPrefs(context, baseURL!, { theme: 'dark' });
    await opened(page, PICTURES);
    await expect(viewer(page)).toHaveAttribute('data-tone', 'dark');
    await expect(page.locator('#page-1 canvas.viewer-photo')).toHaveCount(1);
    expect(await sheet(page, 1).evaluate((el) => getComputedStyle(el).filter)).toContain('invert');
    expect(await page.locator('#page-1 canvas.viewer-photo').evaluate((el) => getComputedStyle(el).filter)).toBe('none');
    // The scanned page is one picture: as printed.
    await page.getByRole('button', { name: 'Last page' }).click();
    await expect(page.locator('#page-2 canvas.viewer-sheet--picture')).toHaveCount(1);
    expect(await page.locator('#page-2 canvas.viewer-sheet').evaluate((el) => getComputedStyle(el).filter)).toBe('none');
    const dark = await seen(page);
    const [r0, g0, b0] = dark(...PAPER);
    expect(Math.max(r0, g0, b0), 'the paper is dark').toBeLessThan(40);
    const [r1, g1, b1] = dark(...RED);
    expect([r1 > 200, g1 < 60, b1 < 60], `the red stays red: ${[r1, g1, b1]}`).toEqual([true, true, true]);
    const [r2, , b2] = dark(...BLUE);
    expect([r2 < 60, b2 > 200], `the blue stays blue: ${[r2, b2]}`).toEqual([true, true]);
    const light = await control(page, 'tone');
    await expect(light).toHaveAccessibleName('Light pages');
    await light.click();
    await expect(onBar(page, 'tone')).toHaveAttribute('aria-pressed', 'true');
    await expect(viewer(page)).toHaveClass(/viewer--light-pages/);
    const printed = await seen(page);
    expect(Math.min(...printed(...PAPER)), 'the paper is white again').toBeGreaterThan(235);
  });

  test('one photo drawn four times in a row (which pdf.js does not record) is never a negative: the page shows as printed (S1)', async ({ page, context, baseURL }) => {
    await setPrefs(context, baseURL!, { theme: 'dark' });
    await opened(page, `/read/${REPEAT_ID}`);
    await expect(viewer(page)).toHaveAttribute('data-tone', 'dark');
    await expect(page.locator('#page-1 canvas.viewer-sheet--picture')).toHaveCount(1);
    const dark = await seen(page);
    // Each photo's red half, on page 1 of REPEAT_PDF (100 pt squares from x = 72 every 120 pt, y 300 to 400).
    for (const k of [0, 1, 2, 3]) {
      const [r, g, b] = dark((122 + k * 120) / 612, 417 / 792);
      expect([r > 200, g < 60, b < 60], `photo ${k + 1} stays red: ${[r, g, b]}`).toEqual([true, true, true]);
    }
  });

  test('light shows the page as printed, with no Light pages control', async ({ page, context, baseURL }) => {
    await setPrefs(context, baseURL!, { theme: 'light' });
    await opened(page, PICTURES);
    await expect(viewer(page)).toHaveAttribute('data-tone', 'light');
    expect(await sheet(page, 1).evaluate((el) => getComputedStyle(el).filter)).toBe('none');
    await expect(onBar(page, 'tone')).toBeHidden();
    await expect(page.locator('[data-viewer-more-list] [data-viewer-act="tone"]')).toBeHidden();
    const printed = await seen(page);
    expect(Math.min(...printed(...PAPER))).toBeGreaterThan(235);
  });

  test('high contrast tints the paper to the theme, the photo untouched', async ({ page, context, baseURL }) => {
    await setPrefs(context, baseURL!, { theme: 'contrast-yellow' });
    await opened(page, PICTURES);
    await expect(viewer(page)).toHaveAttribute('data-tone', 'tint');
    expect(await sheet(page, 1).evaluate((el) => getComputedStyle(el).mixBlendMode)).toBe('multiply');
    const tinted = await seen(page);
    const [r, g, b] = tinted(...PAPER);
    expect([r > 240, g > 235, b > 175 && b < 215], `soft yellow paper: ${[r, g, b]}`).toEqual([true, true, true]);
    const [r1, g1, b1] = tinted(...RED);
    expect([r1 > 200, g1 < 60, b1 < 60], `the red stays red: ${[r1, g1, b1]}`).toEqual([true, true, true]);
  });

  test("with no theme chosen, the pages follow the device's, live, with nothing drawn again", async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await opened(page, PICTURES);
    await expect(viewer(page)).toHaveAttribute('data-tone', 'light');
    await sheet(page, 1).evaluate((el) => el.setAttribute('data-kept', ''));
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(viewer(page)).toHaveAttribute('data-tone', 'dark');
    expect(await sheet(page, 1).evaluate((el) => getComputedStyle(el).filter)).toContain('invert');
    await expect(page.locator('#page-1 canvas.viewer-sheet[data-kept]')).toHaveCount(1);
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(viewer(page)).toHaveAttribute('data-tone', 'light');
  });
});

test.describe('panning sideways on a computer, zoomed wider than the frame', () => {
  test.skip(({ isMobile }) => isMobile, 'a phone pans with the finger, as the browser does');
  test.use({ viewport: { width: 1280, height: 800 } });

  test('a scrollbar at the foot of the window, the wheel sideways and Shift with the wheel; the left edge and the right reachable; the page never scrolls sideways', async ({ page }) => {
    await opened(page);
    await pickZoom(page, '300%');
    await expect(viewer(page)).toHaveClass(/viewer--wide/);
    const pages = page.locator('[data-viewer-pages]');
    const left = () => pages.evaluate((el) => el.scrollLeft);
    const pan = page.locator('[data-viewer-pan]');
    await expect(pan).toBeVisible();
    await expect(pan).toBeInViewport();
    expect(await pan.evaluate((el) => el.scrollWidth)).toBe(await pages.evaluate((el) => el.scrollWidth));
    // The page's left edge shows at the start: nothing of it is cut off.
    expect((await box(page.locator('#page-1'))).x).toBeGreaterThanOrEqual((await box(pages)).x - 1);
    const p = await box(pages);
    await page.mouse.move(p.x + p.width / 2, 400);
    await page.mouse.wheel(240, 0);
    await expect.poll(left).toBeGreaterThan(0);
    await expect.poll(() => pan.evaluate((el) => el.scrollLeft)).toBe(await left());
    await pages.evaluate((el) => (el.scrollLeft = 0));
    await page.keyboard.down('Shift');
    await page.mouse.wheel(0, 240);
    await page.keyboard.up('Shift');
    await expect.poll(left).toBeGreaterThan(0);
    // The scrollbar at the foot moves the pages.
    await pan.evaluate((el) => (el.scrollLeft = 123));
    await expect.poll(left).toBe(123);
    await pages.evaluate((el) => (el.scrollLeft = el.scrollWidth));
    const end = await box(page.locator('#page-1'));
    expect(end.x + end.width).toBeLessThanOrEqual(p.x + p.width + 1);
    expect(await sideways(page)).toBeLessThanOrEqual(0);
  });

  test('the hand tool drags the page both ways; a press without a drag still follows a link; the bar stays one row', async ({ page, context, baseURL }) => {
    await setPrefs(context, baseURL!, { theme: 'dark' });
    await opened(page);
    await pickZoom(page, '300%');
    expect(await rows(await barControls(page))).toBe(1);
    const hand = page.getByRole('button', { name: 'Hand tool: drag to move the page' });
    await expect(hand).toBeVisible();
    await hand.click();
    await expect(hand).toHaveAttribute('aria-pressed', 'true');
    const pages = page.locator('[data-viewer-pages]');
    expect(await pages.evaluate((el) => getComputedStyle(el).cursor)).toBe('grab');
    await page.locator('#page-1').evaluate((el) => el.scrollIntoView({ block: 'start' }));
    const x0 = await pages.evaluate((el) => el.scrollLeft);
    const y0 = await page.evaluate(() => window.scrollY);
    await page.mouse.move(640, 500);
    await page.mouse.down();
    await page.mouse.move(440, 400, { steps: 6 });
    await page.mouse.up();
    await expect.poll(() => pages.evaluate((el) => el.scrollLeft)).toBeGreaterThan(x0 + 150);
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(y0 + 50);
    // "Go to page 3", a link within the issue, by a plain press with the hand on.
    const link = page.locator('#page-1 .annotationLayer a[href="#"]');
    await pages.evaluate((el) => (el.scrollLeft = 0));
    await link.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' }));
    await link.click();
    await expect(pageBox(page)).toHaveValue('3');
  });
});

test.describe('axe', () => {
  test('dark, with search open and its matches marked: no violation', async ({ page, context, baseURL }) => {
    await setPrefs(context, baseURL!, { theme: 'dark' });
    await opened(page);
    await (await control(page, 'find')).click();
    await findBox(page).fill('public copy');
    await expect(findCount(page)).toHaveText('1 of 3');
    expect(await axe(page)).toEqual([]);
  });

  test('light, on a phone, with the More menu open: no violation', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await opened(page);
    await more(page).click();
    await expect(moreList(page)).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });

  test('dark, zoomed wider than the frame on a computer: no violation', async ({ page, context, baseURL, isMobile }) => {
    test.skip(isMobile, 'a computer');
    await page.setViewportSize({ width: 1280, height: 800 });
    await setPrefs(context, baseURL!, { theme: 'dark' });
    await opened(page, PICTURES);
    await pickZoom(page, '300%');
    await expect(page.locator('[data-viewer-pan]')).toBeVisible();
    expect(await axe(page)).toEqual([]);
  });
});
