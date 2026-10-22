import { expect, test, type Page } from '@playwright/test';
import { PRIMARY_NAV, SITE_NAME, currentNav, sectionFor, trailFor } from '../src/lib/site';
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

    test('names the site as text over the teal-and-sand stripe, with Aa, Help and Sign in, each a 48px target', async ({ page }) => {
      await page.goto(path);
      const banner = page.getByRole('banner');
      const name = banner.getByRole('link', { name: SITE_NAME, exact: true });
      await expect(name).toBeVisible();
      await expect(name).toHaveAttribute('href', '/');
      await expect(banner.locator('img')).toHaveCount(0);
      const stripe = banner.locator('.horizon');
      await expect(stripe).toBeVisible();
      expect((await stripe.boundingBox())!.height).toBeGreaterThanOrEqual(4);
      expect(await stripe.evaluate((el) => getComputedStyle(el).backgroundImage)).toMatch(/linear-gradient/);
      const controls = [
        [banner.getByRole('link', { name: /^Aa\b/ }), '#reader-menu'],
        [banner.getByRole('link', { name: 'Help', exact: true }), '/help'],
        [banner.getByRole('link', { name: 'Sign in', exact: true }), `/sign-in?return=${encodeURIComponent(path)}`],
      ] as const;
      for (const [link, href] of controls) {
        await expect(link).toBeVisible();
        await expect(link).toHaveAttribute('href', href);
        const box = (await link.boundingBox())!;
        expect(box.width, href).toBeGreaterThanOrEqual(48);
        expect(box.height, href).toBeGreaterThanOrEqual(48);
      }
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

    test('has the five nav items, each a 48px target with a word (under its icon in the bottom bar)', async ({ page }) => {
      await page.goto(path);
      const nav = mainNav(page);
      await expect(nav).toHaveCount(1);
      const links = nav.getByRole('link');
      await expect(links).toHaveText(PRIMARY_NAV.map((n) => n.label));
      const bottomBar = page.viewportSize()!.width < 900;
      // On a reading page the bottom bar sits at the end of the page (reader.spec.ts).
      if (bottomBar && sectionFor(path)?.reading) await nav.scrollIntoViewIfNeeded();
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
  // Join is not a reading page: there the bottom bar stays on screen (reader.spec.ts).
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

  for (const size of [1, 5]) {
    test(`no page scrolls sideways at text size ${size}, with the Aa panel open or closed`, async ({ page, context, baseURL }) => {
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

    test('shows every amount whole, on one line, at text sizes 1 to 5', async ({ page, context, baseURL }) => {
      const cut: string[] = [];
      for (const size of [1, 2, 3, 4, 5]) {
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

// The reading bar stays on screen only where it fits one row and takes at most
// a quarter of the screen's height; anywhere else it sits at the end of the page.
for (const viewport of [{ width: 320, height: 640 }, { width: 375, height: 667 }, { width: 412, height: 915 }, { width: 568, height: 320 }, { width: 1280, height: 800 }]) {
  test(`the reading bar at ${viewport.width}x${viewport.height} is sticky only in one row, a quarter of the screen at most`, async ({ page, context, baseURL }) => {
    await page.setViewportSize(viewport);
    const seen: string[] = [];
    for (const size of [1, 2, 3, 4, 5]) {
      await setPrefs(context, baseURL!, { size });
      await page.goto('/about');
      await expect(page.locator('html')).toHaveAttribute('data-size', String(size));
      const bar = await page.evaluate(() => {
        const el = document.querySelector<HTMLElement>('.reading-bar')!;
        const rows = new Set([...el.querySelectorAll('button')].map((b) => Math.round(b.getBoundingClientRect().top))).size;
        const footer = document.querySelector('.site-footer')!;
        return {
          rows,
          sticky: getComputedStyle(el).position === 'sticky',
          share: el.getBoundingClientRect().height / innerHeight,
          afterFooter: el.getBoundingClientRect().top + scrollY >= footer.getBoundingClientRect().bottom + scrollY - 0.5,
        };
      });
      seen.push(`size ${size}: ${bar.sticky ? 'sticky' : 'static'}, ${bar.rows} row(s), ${Math.round(bar.share * 100)} %`);
      if (bar.sticky) {
        expect(bar.rows, seen.at(-1)).toBe(1);
        expect(bar.share, seen.at(-1)).toBeLessThanOrEqual(0.25);
      } else {
        expect(bar.rows > 1 || bar.share > 0.25, seen.at(-1)).toBe(true);
        expect(bar.afterFooter, `${seen.at(-1)}: at the end of the page`).toBe(true);
      }
    }
    // The challenger's cases: at 200 % on 320x640 and 568x320 the bar is not on screen while reading.
    if ((viewport.width === 320 && viewport.height === 640) || viewport.width === 568) expect(seen.at(-1)).toMatch(/static/);
    // A 412 px phone at 200 % keeps it: one row, and a seventh of the screen.
    if (viewport.width === 412) expect(seen.at(-1)).toMatch(/sticky/);
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

    for (const size of [1, 2, 3, 4, 5]) {
      test(`no page breaks a word at text size ${size}`, async ({ page, context, baseURL }) => {
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

  for (const size of [1, 5]) {
    test(`a long name, the Officer area and Sign out fit at text size ${size}, each control a 48px target`, async ({ page, context, baseURL }) => {
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

for (const width of [320, 412]) {
  test.describe(`bottom bar at ${width}px`, () => {
    test.use({ viewport: { width, height: 800 } });

    for (const size of [1, 2, 3, 4, 5]) {
      test(`at text size ${size}, never breaks a word; when five do not fit, the first row holds three`, async ({ page, context, baseURL }) => {
        await setPrefs(context, baseURL!, { size });
        await page.goto('/about');
        await page.evaluate(() => document.fonts.ready);
        expect(await brokenWords(page, '.bottom-nav .nav-label, .reading-bar .rb')).toEqual([]);
        const tops = await page.locator('.bottom-nav li').evaluateAll((items) => items.map((li) => Math.round(li.getBoundingClientRect().top)));
        const rows = [...new Set(tops)].map((top) => tops.filter((t) => t === top).length);
        expect([[5], [3, 2], [2, 2, 1], [1, 1, 1, 1, 1]]).toContainEqual(rows);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow).toBeLessThanOrEqual(0);
      });
    }
  });
}

test('the bottom bar keeps all five in one row where they fit whole', async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 900 });
  await page.goto('/');
  const tops = await page.locator('.bottom-nav li').evaluateAll((items) => items.map((li) => Math.round(li.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
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
    await expect(page).toHaveURL(/\/calendar$/);
    await expect(page.locator('h1')).toHaveText('Calendar');
    await page.goto('/2015-mind-games.html');
    await expect(page.locator('h1')).toHaveText('This page is no longer here');
  });

  test('the nav and the search form work', async ({ page }) => {
    await page.goto('/');
    await mainNav(page).getByRole('link', { name: 'Calendar', exact: true }).click();
    await expect(page).toHaveURL(/\/calendar$/);
    await mainNav(page).getByRole('link', { name: 'Search', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Search the newsletter archive' }).fill('picnic');
    await page.getByRole('button', { name: 'Search' }).click();
    await expect(page).toHaveURL(/\/search\?q=picnic$/);
    await expect(page.getByRole('main')).toContainText('picnic');
  });
});
