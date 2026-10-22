import { expect, test, type Page } from '@playwright/test';
import { SIZE_COOKIE, THEME_COOKIE } from '../server/prefs.mjs';
import { setPrefs } from './prefs';

const html = (page: Page) => page.locator('html');
const panel = (page: Page) => page.locator('#reader-menu');
const readingBar = (page: Page) => page.getByRole('form', { name: 'Reading' });

test.describe('with JavaScript off', () => {
  test.use({ javaScriptEnabled: false });

  // One page rendered on request, one prerendered: both must honour the cookie.
  for (const path of ['/officers', '/about']) {
    test(`the Aa panel's size and theme round-trip through the cookie, from ${path}`, async ({ page, context }) => {
      await page.goto(path);
      await expect(html(page)).toHaveAttribute('data-size', '1');
      await expect(html(page)).not.toHaveAttribute('data-theme', /.*/);
      await page.getByRole('banner').getByRole('link', { name: /^Aa\b/ }).click();

      await panel(page).getByRole('button', { name: /^A\+ Larger/ }).click();
      await expect(page).toHaveURL(new RegExp(`${path}#reader-menu$`));
      await expect(html(page)).toHaveAttribute('data-size', '2');
      // The panel stays open for the next press, and says where the size is now.
      await expect(panel(page)).toBeVisible();
      await expect(panel(page).locator('.size-now')).toHaveText('Now 125 %. The whole site grows, menus included.', { useInnerText: true });
      await panel(page).getByRole('button', { name: /^A\+ Larger/ }).click();
      await expect(html(page)).toHaveAttribute('data-size', '3');
      await panel(page).getByRole('button', { name: /^A− Smaller/ }).click();
      await expect(html(page)).toHaveAttribute('data-size', '2');

      await expect(panel(page).getByRole('button', { name: 'Match my phone or computer Chosen', exact: true })).toBeVisible();
      await panel(page).getByRole('button', { name: /^Dark/ }).click();
      await expect(html(page)).toHaveAttribute('data-theme', 'dark');
      // The current choice says so, to the eye and to a screen reader.
      await expect(panel(page).getByRole('button', { name: 'Dark Chosen', exact: true })).toBeVisible();
      await expect(panel(page).getByRole('button', { name: 'Light', exact: true })).toBeVisible();
      await expect(panel(page).getByRole('button', { name: 'Match my phone or computer', exact: true })).toBeVisible();

      for (const other of ['/', '/governance', '/calendar', '/no-such-page']) {
        await page.goto(other);
        await expect(html(page), other).toHaveAttribute('data-size', '2');
        await expect(html(page), other).toHaveAttribute('data-theme', 'dark');
      }

      // The browser kept both as host-only cookies: no leading dot, so no subdomain or parent shares them.
      const jar = Object.fromEntries((await context.cookies()).map((c) => [c.name, c]));
      expect(jar[SIZE_COOKIE]).toMatchObject({ value: '2', domain: 'localhost', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' });
      expect(jar[THEME_COOKIE]).toMatchObject({ value: 'dark', domain: 'localhost', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' });
      expect(jar[SIZE_COOKIE]!.expires - Date.now() / 1000).toBeGreaterThan(360 * 24 * 3600);

      await page.goto(`${path}#reader-menu`);
      await panel(page).getByRole('button', { name: /^Match my phone or computer/ }).click();
      await expect(html(page)).not.toHaveAttribute('data-theme', /.*/);
      expect((await context.cookies()).map((c) => c.name)).not.toContain(THEME_COOKIE);
    });
  }

  test('the reading bar is on reading pages only, and changes size and theme in one press each', async ({ page }) => {
    await page.goto('/');
    await expect(readingBar(page)).toHaveCount(0);
    await page.goto('/governance');
    await expect(readingBar(page)).toBeVisible();
    await page.goto('/about');
    await readingBar(page).getByRole('button', { name: /^A\+ Larger/ }).click();
    await expect(page).toHaveURL(/\/about$/);
    await expect(html(page)).toHaveAttribute('data-size', '2');
    await readingBar(page).getByRole('button', { name: /^A− Smaller/ }).click();
    await expect(html(page)).toHaveAttribute('data-size', '1');
    // Each press moves to the next theme; a screen reader hears which one is on.
    for (const [theme, label] of [
      ['light', 'Light'],
      ['dark', 'Dark'],
      ['contrast', 'High contrast'],
      [null, 'matching your device'],
    ] as const) {
      await readingBar(page).getByRole('button', { name: /^Theme/ }).click();
      if (theme) await expect(html(page)).toHaveAttribute('data-theme', theme);
      else await expect(html(page)).not.toHaveAttribute('data-theme', /.*/);
      await expect(readingBar(page).getByRole('button', { name: `Theme (now ${label})`, exact: true })).toBeVisible();
    }
  });
});

test('the reading bar sits at the foot of the screen, with the bottom bar at the end of the page', async ({ page }) => {
  await page.goto('/about');
  const bar = (await readingBar(page).boundingBox())!;
  const { width, height } = page.viewportSize()!;
  expect(bar.y + bar.height).toBeCloseTo(height, 0);
  if (width < 900) {
    const nav = page.locator('.bottom-nav');
    expect((await nav.boundingBox())!.y).toBeGreaterThanOrEqual(height);
    await nav.scrollIntoViewIfNeeded();
    // At the end of the page the reading bar comes to rest above it.
    const atEnd = (await readingBar(page).boundingBox())!;
    expect(atEnd.y + atEnd.height).toBeLessThanOrEqual((await nav.boundingBox())!.y + 1);
  }
});

test('at 200 % the reading bar keeps its place at the foot of the screen', async ({ page, context, baseURL }) => {
  await setPrefs(context, baseURL!, { size: 5 });
  await page.goto('/about');
  const bar = (await readingBar(page).boundingBox())!;
  expect(bar.y + bar.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
  expect(bar.y).toBeLessThan(page.viewportSize()!.height);
});

test('every reader control shows a focus ring of at least 3px when reached by keyboard', async ({ page }) => {
  await page.goto('/about#reader-menu');
  // .all() does not wait: let the panel open on its fragment first.
  await expect(panel(page)).toBeVisible();
  const controls = [
    ...(await panel(page).getByRole('button').all()),
    ...(await readingBar(page).getByRole('button').all()),
  ];
  expect(controls.length).toBe(9);
  for (const control of controls) {
    // Arrive by keyboard: step off the control and back with the Tab key.
    await control.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    const ring = await control.evaluate((el) => {
      const s = getComputedStyle(el);
      return { focused: el === document.activeElement, visible: el.matches(':focus-visible'), style: s.outlineStyle, width: parseFloat(s.outlineWidth) };
    });
    expect(ring, (await control.textContent()) ?? '').toMatchObject({ focused: true, visible: true });
    expect(ring.style).not.toBe('none');
    expect(ring.width).toBeGreaterThanOrEqual(3);
  }
});

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`nothing moves on its own (reduced motion: ${reducedMotion})`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    await page.goto('/about#reader-menu');
    const moving = await page.evaluate(() =>
      [...document.querySelectorAll('*')]
        .map((el) => [el, getComputedStyle(el)] as const)
        .filter(([, s]) => s.animationName !== 'none' || s.transitionDuration.split(',').some((d) => parseFloat(d) > 0))
        .map(([el]) => el.tagName),
    );
    expect(moving).toEqual([]);
  });
}

/** The class of every element that stays on screen while the page scrolls. */
const pinned = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('body *')]
      .filter((el) => ['sticky', 'fixed'].includes(getComputedStyle(el).position) && getComputedStyle(el).display !== 'none')
      .map((el) => el.className),
  );

test.describe('on a reading page on a phone (412 x 915)', () => {
  test.use({ viewport: { width: 412, height: 915 } });

  for (const size of [1, 2, 3, 4, 5]) {
    test(`at text size ${size} only the reading bar stays on screen, in one row, and the bottom bar sits at the end of the page`, async ({ page, context, baseURL }) => {
      await setPrefs(context, baseURL!, { size });
      await page.goto('/about');
      expect(await pinned(page)).toEqual(['reading-bar']);
      const tops = await readingBar(page).getByRole('button').evaluateAll((buttons) => buttons.map((b) => Math.round(b.getBoundingClientRect().top)));
      expect(new Set(tops).size).toBe(1);
      expect((await page.locator('.bottom-nav').boundingBox())!.y).toBeGreaterThanOrEqual(915);
    });
  }

  for (const size of [1, 5]) {
    test(`at text size ${size} keyboard focus is never hidden behind the reading bar`, async ({ page, context, baseURL }) => {
      await setPrefs(context, baseURL!, { size });
      await page.goto('/about');
      for (const link of await page.getByRole('main').getByRole('link').all()) {
        await link.focus();
        const box = (await link.boundingBox())!;
        const bar = (await readingBar(page).boundingBox())!;
        expect(box.y + box.height, (await link.textContent()) ?? '').toBeLessThanOrEqual(bar.y + 1);
      }
    });
  }

  test('elsewhere the rule is unchanged: at the two smaller sizes the bottom bar stays on screen', async ({ page, context, baseURL }) => {
    await setPrefs(context, baseURL!, { size: 1 });
    await page.goto('/more');
    expect(await pinned(page)).toEqual(['dock']);
  });
});
