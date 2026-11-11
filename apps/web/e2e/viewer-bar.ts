// READER2: the reader's bar, as the e2e specs reach it. The bar holds |<< < [n] of N > >>|, search, zoom,
// Fit, Light pages (where the theme recolours the pages), Download and Open in another app; on a narrow
// bar the later groups move into the More menu, which holds a copy of each (the script measures). A test that
// presses a control presses whichever copy shows, as a reader would.
import { expect, type Locator, type Page } from '@playwright/test';

export type Act = 'find' | 'zoom-out' | 'zoom-in' | 'fit-width' | 'fit-page' | 'tone' | 'download' | 'open';

const ON_BAR: Record<Act, string> = {
  find: '[data-viewer-find]',
  'zoom-out': '[data-viewer-zoom-out]',
  'zoom-in': '[data-viewer-zoom-in]',
  'fit-width': '[data-viewer-fit-width]',
  'fit-page': '[data-viewer-fit-page]',
  tone: '[data-viewer-tone]',
  download: '[data-viewer-bar] > [data-ov="file"] a[href$="?download=1"]',
  open: '[data-viewer-bar] > [data-ov="file"] a[target="_blank"]',
};
const IN_MENU = (act: Act) =>
  act === 'download' ? '[data-viewer-more-list] a[href$="?download=1"]'
  : act === 'open' ? '[data-viewer-more-list] a[target="_blank"]'
  : `[data-viewer-more-list] [data-viewer-act="${act}"]`;

export const bar = (page: Page) => page.locator('[data-viewer-bar]');
export const more = (page: Page) => page.locator('[data-viewer-more]');
export const moreList = (page: Page) => page.locator('[data-viewer-more-list]');
export const pageBox = (page: Page) => page.locator('[data-viewer-page]');
export const zoomShown = (page: Page) => page.locator('[data-viewer-zoom]').textContent();
/** The bar's own copy of a control, shown or not (for its attributes). */
export const onBar = (page: Page, act: Act) => page.locator(ON_BAR[act]);

/** Every control the bar shows, outside its menus and the search row: its buttons, links and the page box. */
export async function barControls(page: Page): Promise<Locator[]> {
  const out: Locator[] = [];
  for (const c of await bar(page).locator('button, select, a, input').all()) {
    if (!(await c.isVisible())) continue;
    if (await c.evaluate((el) => !!el.closest('.vpick__list, .viewer-find'))) continue;
    // One hidden between the two looks (the script wiring the bar) has no box: it is not shown.
    if ((await c.boundingBox()) === null) continue;
    out.push(c);
  }
  return out;
}

/** A control by what it does: the bar's own where it shows, else its copy in the More menu, the menu opened. */
export async function control(page: Page, act: Act): Promise<Locator> {
  const own = onBar(page, act);
  if (await own.isVisible()) return own;
  if (await moreList(page).isHidden()) await more(page).click();
  const copy = page.locator(IN_MENU(act));
  await expect(copy).toBeVisible();
  return copy;
}

/** A zoom step: from the zoom picker where it shows, else by the More menu's Zoom in and Zoom out. */
export async function pickZoom(page: Page, label: string) {
  const picker = page.locator('[data-viewer-zoom]');
  if (await picker.isVisible()) {
    await picker.click();
    await page.locator('[data-viewer-zoom-list]').getByRole('button', { name: label, exact: true }).click();
    return;
  }
  const want = parseInt(label, 10);
  for (let i = 0; i < 12 && (await zoomShown(page)) !== label; i++) {
    const now = parseInt((await zoomShown(page)) ?? '0', 10);
    await (await control(page, now < want ? 'zoom-in' : 'zoom-out')).click();
  }
  await expect.poll(() => zoomShown(page)).toBe(label);
}

/** Goes to a page by typing it in the page box, then Enter. */
export async function typePage(page: Page, n: number) {
  await pageBox(page).fill(String(n));
  await pageBox(page).press('Enter');
}
