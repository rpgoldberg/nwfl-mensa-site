// READER2, panning sideways on a computer, with the scrollbars a reader has: headless Chromium hides
// them unless told not to (so this file stands alone: the launch flag needs its own browser). The foot
// bar is a real one, as wide as the frame, its track as wide as the pages; a drag of it moves the pages
// the whole way; a page wider than the first brings it.
import { expect, test, type Page } from '@playwright/test';
import { NEWSLETTER } from './stand-in';
import { SPREAD_ID } from './synthetic-pdf.mjs';
import { pickZoom } from './viewer-bar';

test.use({ viewport: { width: 1280, height: 800 }, launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });
test.skip(({ isMobile, browserName }) => isMobile || browserName !== 'chromium', 'Chromium on a computer: a launch flag shows real scrollbars');

const READ = `/read/${NEWSLETTER.issues[0]!.publicPdf}`;
const sheet = (page: Page, n: number) => page.locator(`#page-${n} canvas.viewer-sheet`);
const viewer = (page: Page) => page.locator('[data-viewer]');
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const box = async (page: Page, selector: string) => (await page.locator(selector).boundingBox())!;

async function opened(page: Page, path = READ) {
  await page.goto(path);
  await expect(sheet(page, 1)).toHaveCount(1);
}
const state = (page: Page) =>
  page.evaluate(() => {
    const pan = document.querySelector<HTMLElement>('[data-viewer-pan]')!;
    const pages = document.querySelector<HTMLElement>('[data-viewer-pages]')!;
    return { hidden: pan.hidden, height: pan.offsetHeight, width: pan.clientWidth, track: pan.scrollWidth, framed: pages.clientWidth, wide: pages.scrollWidth };
  });

test('the foot bar is a real scrollbar: tall enough to see and press, the frame wide, its track the pages wide; a press on its track moves the pages (N4)', async ({ page }) => {
  await opened(page);
  await pickZoom(page, '300%');
  await expect(viewer(page)).toHaveClass(/viewer--wide/);
  const s = await state(page);
  expect(s.hidden).toBe(false);
  expect(s.height).toBeGreaterThanOrEqual(10);
  expect(Math.abs(s.width - s.framed)).toBeLessThanOrEqual(1);
  expect(s.track).toBe(s.wide);
  const pan = await box(page, '[data-viewer-pan]');
  await page.mouse.click(pan.x + pan.width - 40, pan.y + pan.height / 2);
  // The press scrolls smoothly; once it settles, the pages and the bar sit at the same place, past the start.
  const both = () => page.evaluate(() => [document.querySelector('[data-viewer-pan]')!.scrollLeft, document.querySelector('[data-viewer-pages]')!.scrollLeft]);
  await expect.poll(async () => { const a = await both(); await page.waitForTimeout(100); const b = await both(); return a.join() === b.join() && Math.abs(b[0]! - b[1]!) <= 1 && b[1]! > 0; }).toBe(true);
});

test('dragging the foot bar, frame by frame, moves the pages the whole way (S3)', async ({ page }) => {
  await opened(page);
  await pickZoom(page, '300%');
  // As a drag of its thumb does: the bar's scrollLeft moves on each frame (headless cannot drag a thumb).
  const trail = await page.locator('[data-viewer-pan]').evaluate(async (el) => {
    const pages = document.querySelector('[data-viewer-pages]')!;
    for (let i = 0; i < 25; i++) {
      el.scrollLeft += 24;
      await new Promise((r) => requestAnimationFrame(r));
    }
    await new Promise((r) => setTimeout(r, 200));
    return [el.scrollLeft, pages.scrollLeft];
  });
  expect(trail).toEqual([600, 600]);
});

test('a page wider than the first (a landscape spread), once drawn, brings the foot bar and the hand tool (S2)', async ({ page }) => {
  await opened(page, `/read/${SPREAD_ID}`);
  await expect(viewer(page)).not.toHaveClass(/viewer--wide/);
  await page.getByRole('button', { name: 'Last page' }).click();
  await expect(sheet(page, 2)).toHaveCount(1);
  await expect(viewer(page)).toHaveClass(/viewer--wide/);
  const s = await state(page);
  expect(s.hidden).toBe(false);
  expect(s.track).toBe(s.wide);
  expect(s.wide).toBeGreaterThan(s.framed + 1);
  await expect(page.getByRole('button', { name: 'Hand tool: drag to move the page' })).toBeVisible();
  expect(await sideways(page)).toBeLessThanOrEqual(0);
});
