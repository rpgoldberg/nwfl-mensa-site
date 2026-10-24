import { expect, test, type Page } from '@playwright/test';
import { SIZES } from '../server/prefs.mjs';
import { PRIMARY_NAV, SITE_NAME, currentNav, trailFor } from '../src/lib/site';
import { ALL_PAGES, titleOf } from './pages';
import { setPrefs } from './prefs';
import { signIn } from './signin';

const headingOf = (path: string): string => (path === '/' ? SITE_NAME : titleOf(path));

/** The one primary nav a reader can see at this width (the other is display:none). */
const mainNav = (page: Page) => page.getByRole('navigation', { name: 'Main' });

for (const path of ALL_PAGES) {
  test.describe(`page ${path}`, () => {
    test('has lang, a zoomable viewport, one heading and a description', async ({ page }) => {
      await page.goto(path);
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      const viewport = (await page.locator('meta[name="viewport"]').getAttribute('content')) ?? '';
      expect(viewport).toContain('width=device-width');
      expect(viewport).not.toMatch(/user-scalable|maximum-scale|minimum-scale/);
      await expect(page.locator('h1')).toHaveCount(1);
      await expect(page.locator('h1')).toHaveText(headingOf(path));
      await expect(page.locator('main p').first()).not.toBeEmpty();
    });

    test('starts with a skip link to the main content', async ({ page, browserName }) => {
      await page.goto(path);
      const skip = page.getByRole('link', { name: 'Skip to main content' });
      await expect(skip).toHaveAttribute('href', '#main');
      await expect(page.locator('main#main')).toHaveCount(1);
      if (browserName === 'webkit') {
        // WebKit's Tab skips links by default (as Safari does), so check document order instead.
        const first = await page.locator('a[href], button, input, select, textarea').first().textContent();
        expect(first?.trim()).toBe('Skip to main content');
        return;
      }
      await page.keyboard.press('Tab');
      await expect(skip).toBeFocused();
      await expect(skip).toBeInViewport();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/#main$/);
    });

    test('names the site as text beside the NWFL monogram, over the teal-and-sand stripe, with Aa and Sign in in one row, each a 48px target', async ({ page }) => {
      await page.goto(path);
      const banner = page.getByRole('banner');
      const name = banner.getByRole('link', { name: SITE_NAME, exact: true });
      await expect(name).toBeVisible();
      await expect(name).toHaveAttribute('href', '/');
      // The monogram is decoration: the link's name stays the site's name.
      const monogram = banner.locator('img');
      await expect(monogram).toHaveCount(1);
      await expect(monogram).toHaveAttribute('alt', '');
      await expect(monogram).toHaveAttribute('src', '/icons/icon-192.png');
      if (page.viewportSize()!.width >= 360) expect((await monogram.boundingBox())!.width).toBe(40);
      // Help is on More and in the footer now, not in the header.
      await expect(banner.getByRole('link', { name: 'Help', exact: true })).toHaveCount(0);
      await expect(page.getByRole('contentinfo').getByRole('link', { name: 'Help', exact: true })).toHaveAttribute('href', '/help');
      const stripe = banner.locator('.horizon');
      await expect(stripe).toBeVisible();
      expect((await stripe.boundingBox())!.height).toBeGreaterThanOrEqual(4);
      expect(await stripe.evaluate((el) => getComputedStyle(el).backgroundImage)).toMatch(/linear-gradient/);
      const controls = [
        [banner.getByRole('link', { name: /^Aa\b/ }), '#reader-menu'],
        [banner.getByRole('link', { name: 'Sign in', exact: true }), `/sign-in?return=${encodeURIComponent(path)}`],
      ] as const;
      for (const [link, href] of controls) {
        await expect(link).toBeVisible();
        await expect(link).toHaveAttribute('href', href);
        const box = (await link.boundingBox())!;
        expect(box.width, href).toBeGreaterThanOrEqual(48);
        expect(box.height, href).toBeGreaterThanOrEqual(48);
      }
      // One row: the name, Aa and Sign in share a line.
      const boxes = await Promise.all([name, ...controls.map(([link]) => link)].map(async (l) => (await l.boundingBox())!));
      for (const b of boxes) expect(b.y < boxes[0]!.y + boxes[0]!.height && b.y + b.height > boxes[0]!.y).toBe(true);
    });

    test('shows breadcrumbs and a Back link everywhere but Home', async ({ page }) => {
      await page.goto(path);
      const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' });
      // Inside the breadcrumb landmark, so no content sits outside a landmark.
      const back = crumbs.getByRole('link', { name: /^Back to / });
      if (path === '/') {
        await expect(crumbs).toHaveCount(0);
        await expect(page.getByRole('link', { name: /^Back to / })).toHaveCount(0);
        return;
      }
      const trail = trailFor(path, titleOf(path));
      await expect(crumbs.getByRole('listitem')).toHaveText(trail.map((c) => c.label));
      await expect(crumbs.getByRole('link', { name: 'Home', exact: true })).toHaveAttribute('href', '/');
      await expect(crumbs.locator('[aria-current="page"]')).toHaveText(titleOf(path));
      const parent = trail.at(-2)!;
      await expect(back).toBeVisible();
      await expect(back).toHaveText(`Back to ${parent.label}`);
      await expect(back).toHaveAttribute('href', parent.href);
    });

    test('has the four nav items, each a 48px target with a word (under its icon in the bottom bar)', async ({ page }) => {
      await page.goto(path);
      const nav = mainNav(page);
      await expect(nav).toHaveCount(1);
      const links = nav.getByRole('link');
      await expect(links).toHaveText(PRIMARY_NAV.map((n) => n.label));
      const bottomBar = page.viewportSize()!.width < 900;
      for (const item of PRIMARY_NAV) {
        const link = nav.getByRole('link', { name: item.label, exact: true });
        await expect(link).toHaveAttribute('href', item.href);
        await expect(link).toBeInViewport();
        const box = (await link.boundingBox())!;
        expect(box.width, item.label).toBeGreaterThanOrEqual(48);
        expect(box.height, item.label).toBeGreaterThanOrEqual(48);
        const word = link.locator('.nav-label');
        await expect(word).toBeVisible();
        if (bottomBar) {
          const icon = (await link.locator('svg').boundingBox())!;
          expect((await word.boundingBox())!.y, item.label).toBeGreaterThanOrEqual(icon.y + icon.height - 1);
        } else {
          // The design draft's top nav is words only.
          await expect(link.locator('svg')).toHaveCount(0);
        }
      }
      const current = currentNav(path);
      if (current) await expect(nav.locator('[aria-current="page"]')).toHaveAttribute('href', current);
      else await expect(nav.locator('[aria-current="page"]')).toHaveCount(0);
    });
  });
}

test('uses the self-hosted reading and heading fonts, and asks no other origin for anything', async ({ page, baseURL }) => {
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.goto('/about');
  await page.evaluate(() => document.fonts.ready);
  const loaded = await page.evaluate(() =>
    [...document.fonts].filter((f) => f.status === 'loaded').map((f) => `${f.family.replace(/"/g, '')} ${f.weight}`),
  );
  expect(loaded).toContain('Atkinson Hyperlegible 400');
  expect(loaded).toContain('Lexend 600');
  expect(await page.locator('body').evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/^"?Atkinson Hyperlegible"?,/);
  expect(await page.locator('h1').evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/^"?Lexend"?,/);
  expect(requests.filter((u) => /\.woff2$/.test(u)).length).toBeGreaterThan(0);
  for (const url of requests) expect(url.startsWith(`${baseURL}/`), url).toBe(true);
});

test('phones get the nav at the bottom, wide screens at the top', async ({ page }) => {
  await page.goto('/join');
  const box = (await mainNav(page).boundingBox())!;
  const { height, width } = page.viewportSize()!;
  if (width < 900) expect(box.y + box.height).toBeCloseTo(height, 0);
  else expect(box.y).toBeLessThan(200);
});

test('keyboard focus is never hidden behind the bottom bar', async ({ page }) => {
  test.skip(page.viewportSize()!.width >= 900, 'the bottom bar is a phone layout');
  await page.goto('/more');
  const dock = page.locator('.dock');
  for (const link of await page.getByRole('main').getByRole('link').all()) {
    await link.focus();
    const box = (await link.boundingBox())!;
    const bar = (await dock.boundingBox())!;
    expect(box.y + box.height, (await link.textContent()) ?? '').toBeLessThanOrEqual(bar.y + 1);
  }
});

test('search inputs are at least 16px, so phones do not zoom on focus', async ({ page }) => {
  await page.goto('/search');
  const box = page.getByRole('searchbox', { name: 'Search the newsletter archive' });
  await expect(box).toBeVisible();
  const size = await box.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(size).toBeGreaterThanOrEqual(16);
});

test.describe('at 320px wide', () => {
  test.use({ viewport: { width: 320, height: 640 } });

  for (const size of [SIZES[0], SIZES[6]]) {
    test(`no page scrolls sideways at ${size} %, with the Aa panel open or closed`, async ({ page, context, baseURL }) => {
      await setPrefs(context, baseURL!, { size });
      for (const path of ALL_PAGES) {
        for (const url of [path, `${path}#reader-menu`]) {
          await page.goto(url);
          await expect(page.locator('html')).toHaveAttribute('data-size', String(size));
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          expect(overflow, `${url} at size ${size}`).toBeLessThanOrEqual(0);
        }
      }
    });
  }
});

// The challenger's finding: at 320 px and 200 % every amount was cut off
// mid-number inside the scrolling table. Each amount must show whole, on one line.
for (const viewport of [{ width: 320, height: 640 }, { width: 568, height: 320 }, { width: 412, height: 915 }]) {
  test.describe(`/finances at ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    test('shows every amount whole, on one line, at every text size', async ({ page, context, baseURL }) => {
      const cut: string[] = [];
      for (const size of SIZES) {
        await setPrefs(context, baseURL!, { size });
        await page.goto('/finances');
        await expect(page.locator('html')).toHaveAttribute('data-size', String(size));
        cut.push(
          ...(await page.evaluate((s) => {
            const out: string[] = [];
            for (const wrap of document.querySelectorAll<HTMLElement>('.table-wrap')) {
              const box = wrap.getBoundingClientRect();
              if (wrap.scrollWidth > wrap.clientWidth) out.push(`size ${s}: the table scrolls sideways`);
              for (const td of wrap.querySelectorAll<HTMLElement>('.money td')) {
                const range = document.createRange();
                range.selectNodeContents(td);
                const lines = [...range.getClientRects()].filter((r) => r.width > 0);
                const r = range.getBoundingClientRect();
                if (r.left < box.left - 0.5 || r.right > box.right + 0.5) out.push(`size ${s}: ${td.textContent} is cut off`);
                if (new Set(lines.map((l) => Math.round(l.top))).size > 1) out.push(`size ${s}: ${td.textContent} breaks over lines`);
              }
            }
            return out;
          }, size)),
        );
      }
      expect(cut).toEqual([]);
    });
  });
}

/**
 * Words split over two lines anywhere on the page. Lines wrap at spaces, and
 * after a hyphen or an address's @ already there, never inside a word.
 */
async function splitWords(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const split: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement!;
      if (parent.closest('.visually-hidden, [hidden], script, style') || parent.getClientRects().length === 0) continue;
      for (const match of node.textContent!.matchAll(/[^\s\u00a0@-]+[@-]?/g)) {
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));
        if (tops.size > 1) split.push(match[0]);
      }
    }
    return split;
  });
}

for (const viewport of [{ width: 320, height: 640 }, { width: 412, height: 915 }]) {
  test.describe(`at ${viewport.width}px wide, every word whole`, () => {
    test.use({ viewport });

    for (const size of [SIZES[0], SIZES[3], SIZES[5], SIZES[6]]) {
      test(`no page breaks a word at ${size} %`, async ({ page, context, baseURL }) => {
        test.slow(); // every page, every word
        await setPrefs(context, baseURL!, { size });
        const broken: string[] = [];
        for (const path of ALL_PAGES) {
          await page.goto(path);
          await expect(page.locator('html')).toHaveAttribute('data-size', String(size));
          for (const word of await splitWords(page)) broken.push(`${path}: "${word}"`);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          expect(overflow, `${path} scrolls sideways`).toBeLessThanOrEqual(0);
        }
        expect(broken).toEqual([]);
      });
    }
  });
}

test.describe('the signed-in header on a wide screen', () => {
  /** Top of each header piece, and whether any two overlap. */
  const pieces = (page: Page) =>
    page.evaluate(() => {
      const boxes = [...document.querySelectorAll<HTMLElement>('.wordmark, .top-nav .nav-link, .header-tools .hbtn, .account .who')].map((el) => el.getBoundingClientRect());
      const overlap = boxes.some((a, i) => boxes.some((b, j) => i < j && a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5));
      const tools = [...document.querySelectorAll<HTMLElement>('.header-tools .hbtn, .account .who')].map((el) => Math.round(el.getBoundingClientRect().top));
      return { bar: document.querySelector('.site-header__bar')!.getBoundingClientRect().height, toolRows: new Set(tools).size, overlap };
    });

  test('is one row at 1280, as high as the signed-out header', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    const out = await pieces(page);
    await signIn(page, 'officer');
    const signedIn = await pieces(page);
    expect(signedIn.bar).toBe(out.bar);
    expect(signedIn.overlap).toBe(false);
  });

  for (const width of [900, 1024, 1180]) {
    test(`wraps cleanly at ${width}: Aa, Help and the account together on one row, nothing overlapping`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/');
      await signIn(page, 'officer');
      const signedIn = await pieces(page);
      expect(signedIn.toolRows).toBe(1);
      expect(signedIn.overlap).toBe(false);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    });
  }
});

test.describe('signed in, at 320px wide', () => {
  test.use({ viewport: { width: 320, height: 640 } });

  for (const size of [SIZES[0], SIZES[6]]) {
    test(`a long name, the Officer area and Sign out fit at ${size} %, each control a 48px target`, async ({ page, context, baseURL }) => {
      await setPrefs(context, baseURL!, { size });
      await page.goto('/');
      await signIn(page, 'long-name');
      for (const path of ['/', '/about', '/officer-area']) {
        await page.goto(path);
        const banner = page.getByRole('banner');
        await expect(banner).toContainText('Maximiliana Bartholomew-Fitzgerald Examplesworth');
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `${path} at size ${size}`).toBeLessThanOrEqual(0);
        for (const control of [banner.getByRole('link', { name: 'Officer area' }), banner.getByRole('button', { name: 'Sign out' })]) {
          await expect(control).toBeVisible();
          const box = (await control.boundingBox())!;
          expect(box.width).toBeGreaterThanOrEqual(48);
          expect(box.height).toBeGreaterThanOrEqual(48);
        }
      }
    });
  }
});

/** Labels whose words are split over two lines; a word split by the line box shows as two rects. */
async function brokenWords(page: Page, selector: string): Promise<string[]> {
  return page.evaluate((sel) => {
    const broken: string[] = [];
    for (const label of document.querySelectorAll<HTMLElement>(sel)) {
      // A nav label is one word, even where markup splits it (<wbr>): one line, whole.
      if (label.matches('.nav-label')) {
        const whole = document.createRange();
        whole.selectNodeContents(label);
        if (new Set([...whole.getClientRects()].map((r) => Math.round(r.top))).size > 1) broken.push(label.textContent ?? '');
      }
      const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent ?? '';
        for (const m of text.matchAll(/\S+/g)) {
          const range = document.createRange();
          range.setStart(node, m.index);
          range.setEnd(node, m.index + m[0].length);
          const lines = new Set([...range.getClientRects()].map((r) => Math.round(r.top)));
          if (lines.size > 1) broken.push(m[0]);
        }
      }
      // A whole word that does not fit its cell would spill over the next one.
      const cell = label.closest('a, button') as HTMLElement;
      if (label.getBoundingClientRect().right > cell.getBoundingClientRect().right + 0.5) broken.push(`${label.textContent} (spills)`);
    }
    return broken;
  }, selector);
}

// W-LOOK: the chrome is fixed in px and one row, so it never grows with the
// reader's size; only the content does.
for (const width of [320, 360, 412]) {
  test.describe(`bottom bar at ${width}px`, () => {
    test.use({ viewport: { width, height: 740 } });

    test('is one row of four at every size, never breaking a word, with 24 px icons and 14 px labels, always the same height', async ({ page, context, baseURL }) => {
      const heights = new Set<number>();
      for (const size of SIZES) {
        await setPrefs(context, baseURL!, { size });
        await page.goto('/more');
        await page.evaluate(() => document.fonts.ready);
        expect(await brokenWords(page, '.bottom-nav .nav-label'), `${size} %`).toEqual([]);
        const tops = await page.locator('.bottom-nav li').evaluateAll((items) => items.map((li) => Math.round(li.getBoundingClientRect().top)));
        expect(tops, `${size} %`).toHaveLength(4);
        expect(new Set(tops).size, `${size} %`).toBe(1);
        const look = await page.locator('.bottom-nav .nav-link').first().evaluate((a) => ({
          icon: a.querySelector('svg')!.getBoundingClientRect().width,
          label: parseFloat(getComputedStyle(a.querySelector('.nav-label')!).fontSize),
        }));
        expect(look, `${size} %`).toEqual({ icon: 24, label: 14 });
        heights.add(Math.round((await page.locator('.bottom-nav').boundingBox())!.height));
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      }
      expect([...heights]).toHaveLength(1);
      // About an eleventh of a Galaxy S8's screen, at 175 % as at 75 %.
      expect([...heights][0]!).toBeLessThanOrEqual(64);
    });
  });
}

test('the header, the breadcrumbs and the Aa panel stay the same size at every text size; the content grows', async ({ page, context, baseURL }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const measure = () =>
    page.evaluate(() => {
      const px = (sel: string) => parseFloat(getComputedStyle(document.querySelector(sel)!).fontSize);
      return {
        header: Math.round(document.querySelector('.site-header')!.getBoundingClientRect().height),
        crumbs: px('.crumbs ol'),
        panel: px('.reader-panel .theme-btn'),
        legend: px('.reader-panel legend'),
        content: px('main .lead'),
      };
    });
  const seen = [];
  for (const size of [SIZES[0], SIZES[3], SIZES[6]]) {
    await setPrefs(context, baseURL!, { size });
    // From a blank page, so the same URL with a #fragment is loaded again, not just scrolled to.
    await page.goto('about:blank');
    await page.goto('/officers#reader-menu');
    seen.push(await measure());
  }
  const [small, , large] = seen;
  expect({ ...large!, content: 0 }).toEqual({ ...small!, content: 0 });
  expect(large!.content).toBeGreaterThan(small!.content * 2);
});

test('on a wide screen the current tab has the accent bar on top and bottom alike', async ({ page }) => {
  test.skip(page.viewportSize()!.width < 900, 'the top nav is a wide-screen layout');
  await page.goto('/events');
  const current = page.getByRole('navigation', { name: 'Main' }).locator('[aria-current="page"]');
  await expect(current).toHaveAttribute('href', '/events');
  const shadow = await current.evaluate((el) => getComputedStyle(el).boxShadow);
  expect(shadow).toMatch(/(^|, |\) )0px 4px 0px/);
  expect(shadow).toMatch(/(^|, |\) )0px -4px 0px/);
  expect(shadow.match(/inset/g)).toHaveLength(2);
});

test.describe('with JavaScript off', () => {
  test.use({ javaScriptEnabled: false });

  test('Aa opens the text size and theme panel, and Done closes it', async ({ page }) => {
    await page.goto('/about');
    const panel = page.locator('#reader-menu');
    await expect(panel).toBeHidden();
    await page.getByRole('banner').getByRole('link', { name: /^Aa\b/ }).click();
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'Text size and theme' })).toBeVisible();
    await panel.getByRole('link', { name: 'Done' }).click();
    await expect(panel).toBeHidden();
  });

  test('every page renders its heading and nav', async ({ page }) => {
    for (const path of ALL_PAGES) {
      const res = await page.goto(path);
      expect(res?.status(), path).toBe(200);
      await expect(page.locator('h1'), path).toHaveText(headingOf(path));
      await expect(mainNav(page), path).toBeVisible();
    }
  });

  test('a link to an old page lands on its new page', async ({ page }) => {
    await page.goto('/calendar.html');
    await expect(page).toHaveURL(/\/events$/);
    await expect(page.locator('h1')).toHaveText('Events');
    await page.goto('/newsletter');
    await expect(page).toHaveURL(/\/news$/);
    await expect(page.locator('h1')).toHaveText('News');
    await page.goto('/2015-mind-games.html');
    await expect(page.locator('h1')).toHaveText('This page is no longer here');
  });

  test('the nav and the search form work; Search and Help are on More', async ({ page }) => {
    await page.goto('/');
    await mainNav(page).getByRole('link', { name: 'Events', exact: true }).click();
    await expect(page).toHaveURL(/\/events$/);
    await mainNav(page).getByRole('link', { name: 'News', exact: true }).click();
    await expect(page).toHaveURL(/\/news$/);
    await mainNav(page).getByRole('link', { name: 'More', exact: true }).click();
    await expect(page.getByRole('main').getByRole('link', { name: 'Help', exact: true })).toHaveAttribute('href', '/help');
    await page.getByRole('main').getByRole('link', { name: 'Search', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Search the newsletter archive' }).fill('picnic');
    await page.getByRole('button', { name: 'Search' }).click();
    await expect(page).toHaveURL(/\/search\?q=picnic$/);
    await expect(page.getByRole('main')).toContainText('picnic');
  });
});
