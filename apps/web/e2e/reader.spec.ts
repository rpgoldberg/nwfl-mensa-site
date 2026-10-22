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

test('the reading bar sits at the foot of the screen, above the bottom bar on a phone', async ({ page }) => {
  await page.goto('/about');
  const bar = (await readingBar(page).boundingBox())!;
  const { width, height } = page.viewportSize()!;
  if (width < 900) {
    const nav = (await page.locator('.bottom-nav').boundingBox())!;
    expect(bar.y + bar.height).toBeLessThanOrEqual(nav.y + 1);
    expect(nav.y + nav.height).toBeCloseTo(height, 0);
  } else {
    expect(bar.y + bar.height).toBeCloseTo(height, 0);
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
