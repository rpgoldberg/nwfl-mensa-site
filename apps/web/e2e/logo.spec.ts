// LOGO-UNIT: the Mensa logo in the footer, in a browser: once, on a solid tile that stands out from
// the page in every theme, never stretched, never touching the words beside it, at a phone's 320
// and 412 px and a computer's 1280 px, at the site's largest text and at the browser's text
// doubled, with no sideways scroll; and axe on the page with it in view.
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { SIZES } from '../server/prefs.mjs';
import { THEMES, setPrefs } from './prefs';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'wcag2aaa', 'best-practice'];
const WIDTHS = [320, 412, 1280];
/** The approved picture with its clear space: 238 by 77. */
const RATIO = 238 / 77;
/** LOGO_SHOTS=<folder>: keep a picture of the footer from every run below. */
const SHOTS = process.env['LOGO_SHOTS'];

interface Seen {
  count: number;
  logo: { x: number; y: number; width: number; height: number; natural: number; complete: boolean; transform: string; tile: string; image: string; page: string };
  words: { x: number; y: number; width: number; height: number; text: string };
  links: { bottom: number };
  footer: { left: number; right: number };
  sideways: number;
}

async function seen(page: Page): Promise<Seen> {
  await page.locator('.foot-logo').scrollIntoViewIfNeeded();
  await expect(page.locator('.foot-logo')).toHaveJSProperty('complete', true);
  return page.evaluate(() => {
    const logo = document.querySelector<HTMLImageElement>('footer .foot-logo')!;
    const words = document.querySelector<HTMLElement>('footer .foot-brand p')!;
    const footer = document.querySelector<HTMLElement>('footer')!;
    // The words' own box: the text's lines, not the paragraph's column.
    const range = document.createRange();
    range.selectNodeContents(words);
    const [l, w, f] = [logo.getBoundingClientRect(), range.getBoundingClientRect(), footer.getBoundingClientRect()];
    const style = getComputedStyle(logo);
    return {
      count: document.querySelectorAll('img[src*="mensa-logo"]').length,
      logo: { x: l.x, y: l.y, width: l.width, height: l.height, natural: logo.naturalWidth / logo.naturalHeight, complete: logo.complete && logo.naturalWidth > 0, transform: style.transform, tile: style.backgroundColor, image: style.backgroundImage, page: getComputedStyle(document.body).backgroundColor },
      words: { x: w.x, y: w.y, width: w.width, height: w.height, text: words.textContent!.trim() },
      links: { bottom: document.querySelector('footer .foot-links')!.getBoundingClientRect().bottom },
      footer: { left: f.left + Number.parseFloat(getComputedStyle(footer).paddingLeft), right: f.right - Number.parseFloat(getComputedStyle(footer).paddingRight) },
      sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}

function luminance(rgb: string): number {
  const [r, g, b] = rgb.match(/[\d.]+/g)!.slice(0, 3).map((c) => {
    const s = Number(c) / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The rules a reader can see broken, checked on what the browser drew. */
function held(s: Seen, width: number): void {
  expect(s.count).toBe(1);
  expect(s.logo.complete).toBe(true);
  expect(s.words.text).toBe('Northwest Florida Mensa, a local group of American Mensa');
  // Never stretched, upright: the drawn box keeps the picture's proportions, with no transform.
  expect(s.logo.width / s.logo.height).toBeCloseTo(RATIO, 1);
  expect(s.logo.natural).toBeCloseTo(RATIO, 2);
  expect(s.logo.transform).toBe('none');
  // Its full size wherever the page has room for it; never wider than the footer's column.
  expect(s.logo.width).toBeLessThanOrEqual(238.5);
  expect(s.logo.x).toBeGreaterThanOrEqual(s.footer.left - 0.5);
  expect(s.logo.x + s.logo.width).toBeLessThanOrEqual(s.footer.right + 0.5);
  if (s.footer.right - s.footer.left >= 238) expect(s.logo.width).toBeCloseTo(238, 0);
  // A solid tile, 3:1 at least against the page, and the white mark 4.5:1 at least on it.
  expect(s.logo.image).toBe('none');
  expect(contrast(s.logo.tile, s.logo.page)).toBeGreaterThanOrEqual(3);
  expect(contrast('rgb(255, 255, 255)', s.logo.tile)).toBeGreaterThanOrEqual(4.5);
  // Nothing on the tile: the words are beside it or below it, the links above it.
  const beside = s.words.x >= s.logo.x + s.logo.width;
  const below = s.words.y >= s.logo.y + s.logo.height;
  expect(beside || below, `words at ${s.words.x},${s.words.y}; logo ${s.logo.x},${s.logo.y} ${s.logo.width}x${s.logo.height}`).toBe(true);
  expect(s.links.bottom).toBeLessThanOrEqual(s.logo.y + 0.5);
  expect(s.sideways, `sideways scroll at ${width} px`).toBeLessThanOrEqual(0);
}

async function axe(page: Page): Promise<string[]> {
  // At the end of the page, where the footer is and the phone's bottom bar is back in its own space.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

async function shot(page: Page, name: string, project: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.locator('footer').screenshot({ path: join(SHOTS, `${project}-${name}.png`) });
}

for (const width of WIDTHS) {
  test.describe(`the footer's Mensa logo at ${width} px`, () => {
    test.use({ viewport: { width, height: 800 } });

    for (const theme of THEMES) {
      test(`${theme} theme`, async ({ page, context, baseURL }, info) => {
        await setPrefs(context, baseURL!, { theme });
        await page.goto('/about');
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        held(await seen(page), width);
        expect(await axe(page)).toEqual([]);
        await shot(page, `${width}-${theme}`, info.project.name);
      });

      test(`${theme} theme at the site's largest text, with the browser's text doubled`, async ({ page, context, baseURL }, info) => {
        await setPrefs(context, baseURL!, { theme, size: SIZES[6] });
        await page.goto('/about');
        await expect(page.locator('html')).toHaveAttribute('data-size', String(SIZES[6]));
        const largest = await seen(page);
        held(largest, width);
        await shot(page, `${width}-${theme}-175`, info.project.name);
        // The browser's own text size at 200 %: the root's size doubled, as a reader's setting does it
        // (the site's sizes are percentages of it). Set on the element; the page's policy allows no injected sheet.
        await page.goto('/about');
        await page.evaluate(() => {
          document.documentElement.dataset['size'] = '100';
          document.documentElement.style.fontSize = '200%';
        });
        expect(await page.evaluate(() => Number.parseFloat(getComputedStyle(document.body).fontSize))).toBeCloseTo(36, 0);
        held(await seen(page), width);
        expect(await axe(page)).toEqual([]);
        await shot(page, `${width}-${theme}-200`, info.project.name);
      });
    }

    for (const [name, media] of [['a device set to dark', { colorScheme: 'dark' }], ['a device that asks for more contrast', { contrast: 'more' }]] as const) {
      test(name, async ({ page }, info) => {
        await page.emulateMedia(media);
        await page.goto('/about');
        await expect(page.locator('html')).not.toHaveAttribute('data-theme');
        held(await seen(page), width);
        expect(await axe(page)).toEqual([]);
        await shot(page, `${width}-device-${'colorScheme' in media ? 'dark' : 'contrast'}`, info.project.name);
      });
    }

    test('forced colours (Windows High Contrast): the tile stays behind the white mark', async ({ page, browserName }, info) => {
      test.skip(browserName !== 'chromium', 'forced colours are Chromium\'s to emulate');
      await page.emulateMedia({ forcedColors: 'active' });
      await page.goto('/about');
      const s = await seen(page);
      expect(contrast('rgb(255, 255, 255)', s.logo.tile)).toBeGreaterThanOrEqual(4.5);
      await shot(page, `${width}-forced-colours`, info.project.name);
    });
  });
}

test('the logo is served from the site itself, cached as the other icons are, and nothing moves as it loads', async ({ page, request }) => {
  for (const file of ['mensa-logo.png', 'mensa-logo-2x.png', 'mensa-logo-3x.png']) {
    const res = await request.get(`/icons/${file}`);
    expect(res.status(), file).toBe(200);
    expect(res.headers()['content-type'], file).toBe('image/png');
    expect(res.headers()['cache-control'], file).toBe('public, max-age=60, stale-while-revalidate=60');
  }
  // Held back until the page is laid out: the room the footer keeps for the picture before it arrives is
  // the room it takes after. Measured from the logo's own corner, so a font arriving above changes nothing here.
  let release = () => {};
  const waiting = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/icons/mensa-logo*', async (route) => {
    await waiting;
    await route.continue();
  });
  await page.goto('/about', { waitUntil: 'domcontentloaded' });
  const place = () => page.evaluate(() => {
    const logo = document.querySelector<HTMLImageElement>('.foot-logo')!;
    const [l, w] = [logo.getBoundingClientRect(), document.querySelector('.foot-brand p')!.getBoundingClientRect()];
    return { complete: logo.complete, size: [l.width, l.height], wordsFromLogo: w.x - l.x };
  });
  const before = await place();
  expect(before.complete).toBe(false);
  expect(before.size).toEqual([238, 77]);
  release();
  await expect(page.locator('.foot-logo')).toHaveJSProperty('complete', true);
  expect(await place()).toEqual({ ...before, complete: true });
});
