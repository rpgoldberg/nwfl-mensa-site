import { expect, test, type Page } from '@playwright/test';
import { SIZES, SIZE_COOKIE, THEME_COOKIE } from '../server/prefs.mjs';
import { setPrefs } from './prefs';

const html = (page: Page) => page.locator('html');
const panel = (page: Page) => page.locator('#reader-menu');
const slider = (page: Page) => panel(page).getByRole('slider', { name: 'Text size' });
const readingBar = (page: Page) => page.getByRole('form', { name: 'Reading' });
/** The size the panel shows in large figures. */
const readout = (page: Page) => panel(page).locator('.sz-now [data-for-size]:visible');

test.describe('with JavaScript off', () => {
  test.use({ javaScriptEnabled: false });

  // One page rendered on request, one prerendered: both must honour the cookie.
  for (const path of ['/officers', '/about']) {
    test(`the Aa panel's size and theme round-trip through the cookie, from ${path}`, async ({ page, context }) => {
      await page.goto(path);
      await expect(html(page)).toHaveAttribute('data-size', '100');
      await expect(html(page)).not.toHaveAttribute('data-theme', /.*/);
      await page.getByRole('banner').getByRole('link', { name: /^Aa\b/ }).click();
      await expect(readout(page)).toHaveText('100 %');
      await expect(slider(page)).toHaveValue('3');
      await expect(slider(page)).toHaveAttribute('aria-valuetext', '100 percent');

      await panel(page).getByRole('button', { name: 'A+ Larger' }).click();
      await expect(page).toHaveURL(new RegExp(`${path}#reader-menu$`));
      await expect(html(page)).toHaveAttribute('data-size', '125');
      // The panel stays open for the next press, and says where the size is now.
      await expect(panel(page)).toBeVisible();
      await expect(readout(page)).toHaveText('125 %');
      await expect(slider(page)).toHaveValue('4');
      await expect(slider(page)).toHaveAttribute('aria-valuetext', '125 percent');
      await panel(page).getByRole('button', { name: 'A+ Larger' }).click();
      await expect(html(page)).toHaveAttribute('data-size', '150');
      await panel(page).getByRole('button', { name: 'A− Smaller' }).click();
      await expect(html(page)).toHaveAttribute('data-size', '125');

      // The slider with no script: move it, then Use this size.
      await slider(page).fill('1');
      await panel(page).getByRole('button', { name: 'Use this size' }).click();
      await expect(html(page)).toHaveAttribute('data-size', '80');
      await expect(slider(page)).toHaveValue('1');

      await expect(panel(page).getByRole('button', { name: 'Match my phone or computer Chosen', exact: true })).toBeVisible();
      await panel(page).getByRole('button', { name: /^Dark/ }).click();
      await expect(html(page)).toHaveAttribute('data-theme', 'dark');
      // The current choice says so, to the eye and to a screen reader.
      await expect(panel(page).getByRole('button', { name: 'Dark Chosen', exact: true })).toBeVisible();
      await expect(panel(page).getByRole('button', { name: 'Light', exact: true })).toBeVisible();
      await expect(panel(page).getByRole('button', { name: 'Match my phone or computer', exact: true })).toBeVisible();
      // A theme press keeps the size, though the form carries the slider too.
      await expect(html(page)).toHaveAttribute('data-size', '80');

      for (const other of ['/', '/governance', '/events', '/no-such-page']) {
        await page.goto(other);
        await expect(html(page), other).toHaveAttribute('data-size', '80');
        await expect(html(page), other).toHaveAttribute('data-theme', 'dark');
      }

      // The browser kept both as host-only cookies: no leading dot, so no subdomain or parent shares them.
      const jar = Object.fromEntries((await context.cookies()).map((c) => [c.name, c]));
      expect(jar[SIZE_COOKIE]).toMatchObject({ value: '80', domain: 'localhost', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' });
      expect(jar[THEME_COOKIE]).toMatchObject({ value: 'dark', domain: 'localhost', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' });
      expect(jar[SIZE_COOKIE]!.expires - Date.now() / 1000).toBeGreaterThan(360 * 24 * 3600);

      await page.goto(`${path}#reader-menu`);
      await panel(page).getByRole('button', { name: /^Match my phone or computer/ }).click();
      await expect(html(page)).not.toHaveAttribute('data-theme', /.*/);
      expect((await context.cookies()).map((c) => c.name)).not.toContain(THEME_COOKIE);
    });
  }

  test('offers the five themes in the menu order Ross chose', async ({ page }) => {
    await page.goto('/about#reader-menu');
    await expect(panel(page).locator('.theme-btn')).toHaveText([
      /^Match my phone or computer/,
      /^Light/,
      /^Dark/,
      /^High contrast, soft yellow/,
      /^High contrast, warm white/,
    ]);
    for (const [label, theme] of [['High contrast, soft yellow', 'contrast-yellow'], ['High contrast, warm white', 'contrast-white']]) {
      await panel(page).getByRole('button', { name: new RegExp(`^${label}`) }).click();
      await expect(html(page)).toHaveAttribute('data-theme', theme!);
      await expect(panel(page).getByRole('button', { name: `${label} Chosen`, exact: true })).toBeVisible();
    }
  });

  test('an old cookie keeps its reader: size 5 is 175 %, and the old high contrast is warm white', async ({ page, context, baseURL }) => {
    await setPrefs(context, baseURL!, { size: 5, theme: 'contrast' });
    for (const path of ['/about#reader-menu', '/officers#reader-menu']) {
      await page.goto(path);
      await expect(html(page), path).toHaveAttribute('data-size', '175');
      await expect(html(page), path).toHaveAttribute('data-theme', 'contrast-white');
      await expect(slider(page), path).toHaveValue('6');
      await expect(panel(page).getByRole('button', { name: 'High contrast, warm white Chosen', exact: true }), path).toBeVisible();
    }
  });

  test('the reading bar is on reading pages only, and changes size and theme in one press each', async ({ page }) => {
    await page.goto('/');
    await expect(readingBar(page)).toHaveCount(0);
    await page.goto('/governance');
    await expect(readingBar(page)).toBeVisible();
    await page.goto('/about');
    await readingBar(page).getByRole('button', { name: /^A\+ Larger/ }).click();
    await expect(page).toHaveURL(/\/about$/);
    await expect(html(page)).toHaveAttribute('data-size', '125');
    await readingBar(page).getByRole('button', { name: /^A− Smaller/ }).click();
    await expect(html(page)).toHaveAttribute('data-size', '100');
    // Each press moves to the next theme, in menu order; a screen reader hears which one is on.
    for (const [theme, label] of [
      ['light', 'Light'],
      ['dark', 'Dark'],
      ['contrast-yellow', 'High contrast, soft yellow'],
      ['contrast-white', 'High contrast, warm white'],
      [null, 'matching your device'],
    ] as const) {
      await readingBar(page).getByRole('button', { name: /^Theme/ }).click();
      if (theme) await expect(html(page)).toHaveAttribute('data-theme', theme);
      else await expect(html(page)).not.toHaveAttribute('data-theme', /.*/);
      await expect(readingBar(page).getByRole('button', { name: `Theme (now ${label})`, exact: true })).toBeVisible();
    }
  });
});

test.describe('with JavaScript', () => {
  test('a slide shows at once and is saved to this device, with no Use this size button', async ({ page }) => {
    await page.goto('/about#reader-menu');
    await expect(panel(page).getByRole('button', { name: 'Use this size' })).toBeHidden();
    const saved = page.waitForResponse((r) => r.url().endsWith('/prefs') && r.request().method() === 'POST');
    await slider(page).focus();
    await page.keyboard.press('ArrowRight');
    await expect(html(page)).toHaveAttribute('data-size', '125');
    await expect(slider(page)).toHaveAttribute('aria-valuetext', '125 percent');
    await expect(readout(page)).toHaveText('125 %');
    expect((await saved).status()).toBe(303);
    await expect(page).toHaveURL(/\/about#reader-menu$/);
    // The device keeps it as its size: every page, every visit.
    await page.goto('/officers');
    await expect(html(page)).toHaveAttribute('data-size', '125');
  });

  test('A− and A+ change the size at once, without loading the page again, and it stays', async ({ page }) => {
    await page.goto('/officers#reader-menu');
    await page.evaluate(() => ((window as unknown as { marker: number }).marker = 1));
    await panel(page).getByRole('button', { name: 'A+ Larger' }).click();
    await expect(html(page)).toHaveAttribute('data-size', '125');
    await panel(page).getByRole('button', { name: 'A+ Larger' }).click();
    await expect(html(page)).toHaveAttribute('data-size', '150');
    await panel(page).getByRole('button', { name: 'A− Smaller' }).click();
    await expect(html(page)).toHaveAttribute('data-size', '125');
    await expect(slider(page)).toHaveValue('4');
    expect(await page.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(1);
    // Every mark and number is still drawn after a change made in place (inside a
    // fieldset, Chromium dropped them all).
    const drawn = await panel(page).locator('.tick').evaluateAll((ticks) => ticks.map((t) => t.getBoundingClientRect().width > 0));
    expect(drawn).toEqual(Array(7).fill(true));
    await expect.poll(async () => (await page.context().cookies()).find((c) => c.name === SIZE_COOKIE)?.value).toBe('125');
    await page.reload();
    await expect(html(page)).toHaveAttribute('data-size', '125');
  });

  test('a tap on a mark takes that size: the marks sit under the thumb’s centre at each notch', async ({ page }) => {
    await page.goto('/about#reader-menu');
    const marks = panel(page).locator('.tick');
    for (const k of [0, 6, 2, 5, 3]) {
      // The mark's centre: its number may be hidden at this size, the mark never is.
      const x = await marks.nth(k).evaluate((t) => t.getBoundingClientRect().left + t.getBoundingClientRect().width / 2);
      const track = (await slider(page).boundingBox())!;
      await page.mouse.click(x, track.y + track.height / 2);
      await expect(slider(page), `mark ${k}`).toHaveValue(String(k));
      await expect(html(page), `mark ${k}`).toHaveAttribute('data-size', String(SIZES[k]));
    }
  });
});

/** The notch numbers shown, and their boxes, in the panel. */
const notches = (page: Page) =>
  panel(page)
    .locator('.tick')
    .evaluateAll((ticks) =>
      ticks.map((t) => {
        const r = t.getBoundingClientRect();
        const mark = getComputedStyle(t, '::before');
        return {
          text: t.textContent ?? '',
          shown: getComputedStyle(t).visibility === 'visible',
          markShown: mark.visibility === 'visible' && parseFloat(mark.height) > 0,
          left: r.left,
          right: r.right,
          em: parseFloat(getComputedStyle(t).fontSize),
          bold: Number(getComputedStyle(t).fontWeight) >= 700,
        };
      }),
    );

const PATTERNS = [
  ['75', '80', '90', '100', '125', '150', '175'],
  ['75', '90', '125', '175'],
  ['75', '100', '175'],
  ['75', '175'],
];

for (const width of [320, 360, 412, 1280]) {
  test(`at ${width}px the notch numbers grow with the size and thin out symmetrically, never closer than 0.8em`, async ({ page, context, baseURL }) => {
    await page.setViewportSize({ width, height: 800 });
    const seen: string[] = [];
    for (const size of SIZES) {
      await setPrefs(context, baseURL!, { size });
      await page.goto('about:blank');
      await page.goto('/about#reader-menu');
      await page.evaluate(() => document.fonts.ready);
      const ticks = await notches(page);
      const shown = ticks.filter((t) => t.shown);
      const label = `${size} %: ${shown.map((t) => t.text).join(' ')}`;
      seen.push(label);
      // Every mark, always; the first and last numbers, always; a symmetric pattern.
      expect(ticks.every((t) => t.markShown), label).toBe(true);
      expect(PATTERNS, label).toContainEqual(shown.map((t) => t.text));
      for (let i = 1; i < shown.length; i++) expect(shown[i]!.left - shown[i - 1]!.right, label).toBeGreaterThanOrEqual(0.8 * shown[i]!.em - 0.5);
      // The size chosen is the bold one, when it shows.
      expect(ticks.filter((t) => t.bold).map((t) => t.text), label).toEqual([String(size)]);
      // The densest pattern that fits: the next denser one would not, give or
      // take a quarter em (the breakpoints allow for the widest number, 1.8em).
      const at = PATTERNS.findIndex((p) => p.length === shown.length);
      if (at > 0) {
        const denser = ticks.filter((t) => PATTERNS[at - 1]!.includes(t.text));
        const tight = denser.some((t, i) => i > 0 && t.left - denser[i - 1]!.right < 1.05 * t.em);
        expect(tight, `${label}: ${PATTERNS[at - 1]!.join(' ')} would have fitted`).toBe(true);
      }
    }
    // The numbers grow with the size.
    const sizes = [];
    for (const size of [75, 175]) {
      await setPrefs(context, baseURL!, { size });
      await page.goto('about:blank');
      await page.goto('/about#reader-menu');
      sizes.push((await notches(page))[0]!.em);
    }
    expect(sizes[1]!, seen.join('; ')).toBeGreaterThan(sizes[0]!);
  });
}

test('the size row stays one row at every size, A− and A+ at least 48 px, and grows with the size inside the panel', async ({ page, context, baseURL }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  const readouts: number[] = [];
  for (const size of SIZES) {
    await setPrefs(context, baseURL!, { size });
    await page.goto('about:blank');
    await page.goto('/about#reader-menu');
    const row = await panel(page)
      .locator('.sz-row > :visible')
      .evaluateAll((els) => els.map((el) => ({ top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom, w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height, button: el.tagName === 'BUTTON' })));
    expect(row).toHaveLength(3);
    const [a, , b] = row;
    expect(row.every((el) => el.top < a!.bottom && el.bottom > a!.top), `${size} %: one row`).toBe(true);
    for (const btn of [a!, b!]) expect(Math.min(btn.w, btn.h), `${size} %`).toBeGreaterThanOrEqual(48);
    readouts.push(parseFloat(await readout(page).evaluate((el) => getComputedStyle(el).fontSize)));
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  }
  expect(readouts.at(-1)!).toBeGreaterThan(readouts[0]!);
});

test('the slider is a native range of seven notches, with a thumb of at least 36 px and a target of 48', async ({ page }) => {
  await page.goto('/about#reader-menu');
  await expect(slider(page)).toHaveAttribute('type', 'range');
  await expect(slider(page)).toHaveAttribute('min', '0');
  await expect(slider(page)).toHaveAttribute('max', '6');
  await expect(slider(page)).toHaveAttribute('step', '1');
  expect((await slider(page).boundingBox())!.height).toBeGreaterThanOrEqual(48);
  const thumb = await slider(page).evaluate((el) => parseFloat(getComputedStyle(el, '::-webkit-slider-thumb').width));
  // Chromium and WebKit report the thumb's own width; it is the slider's when they cannot.
  if (!Number.isNaN(thumb)) expect(thumb).toBeGreaterThanOrEqual(36);
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

test('every reader control shows a focus ring of at least 3px when reached by keyboard', async ({ page }) => {
  await page.goto('/about#reader-menu');
  // .all() does not wait: let the panel open on its fragment first.
  await expect(panel(page)).toBeVisible();
  const controls = [
    ...(await panel(page).getByRole('button').all()),
    slider(page),
    ...(await readingBar(page).getByRole('button').all()),
  ];
  // A−, A+, five themes and the slider; Smaller, Larger and Theme (Use this size is hidden with a script).
  expect(controls.length).toBe(11);
  for (const control of controls) {
    // Arrive by keyboard: step off the control and back with the Tab key.
    await control.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    const ring = await control.evaluate((el) => {
      const s = getComputedStyle(el);
      return { focused: el === document.activeElement, visible: el.matches(':focus-visible'), style: s.outlineStyle, width: parseFloat(s.outlineWidth) };
    });
    expect(ring, (await control.getAttribute('aria-valuetext')) ?? (await control.textContent()) ?? '').toMatchObject({ focused: true, visible: true });
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

test.describe('on a phone (412 x 915)', () => {
  test.use({ viewport: { width: 412, height: 915 } });

  for (const size of [75, 125, 175]) {
    test(`at ${size} % on a reading page only the reading bar stays on screen, in one row, and the bottom bar sits at the end of the page`, async ({ page, context, baseURL }) => {
      await setPrefs(context, baseURL!, { size });
      await page.goto('/about');
      expect(await pinned(page)).toEqual(['reading-bar']);
      const tops = await readingBar(page).getByRole('button').evaluateAll((buttons) => buttons.map((b) => Math.round(b.getBoundingClientRect().top)));
      expect(new Set(tops).size).toBe(1);
      expect((await page.locator('.bottom-nav').boundingBox())!.y).toBeGreaterThanOrEqual(915);
    });

    test(`at ${size} % elsewhere the bottom bar stays on screen, one row of four`, async ({ page, context, baseURL }) => {
      await setPrefs(context, baseURL!, { size });
      await page.goto('/more');
      expect(await pinned(page)).toEqual(['dock']);
    });
  }

  for (const size of [75, 175]) {
    test(`at ${size} % keyboard focus is never hidden behind the reading bar`, async ({ page, context, baseURL }) => {
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
});

// W3, kept for seven sizes: A+ never silently does nothing, and A− neither. At
// 175 % A+ gives way to a disabled "Largest size for this screen"; on a screen
// so narrow that 175 % is capped under 150 % (below about 274 px), at 150 %
// too. At 75 % A− gives way to a disabled "Smallest size". Checked in the Aa
// panel and in the reading bar.
test.describe('A+ and A− never silently do nothing', () => {
  const rootSize = (page: Page) => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));

  for (const width of [260, 320, 390, 1280]) {
    test(`at ${width}px wide, each A+ press makes the text larger, or A+ says this is the largest size for this screen`, async ({ page, context, baseURL }) => {
      await page.setViewportSize({ width, height: 800 });
      for (const [where, controls] of [
        ['Aa panel', () => panel(page)],
        ['reading bar', () => readingBar(page)],
      ] as const) {
        for (const size of SIZES) {
          const label = `${where}, ${size} %`;
          await setPrefs(context, baseURL!, { size });
          // From a blank page, so the same URL with a #fragment is loaded again, not just scrolled to.
          await page.goto('about:blank');
          await page.goto('/about#reader-menu');
          const larger = controls().getByRole('button', { name: /A\+ Larger/ });
          const largest = controls().getByRole('button', { name: /Largest size for this screen/ });
          const before = await rootSize(page);
          if (await larger.isVisible()) {
            await expect(largest, label).toBeHidden();
            await larger.click();
            await expect(html(page), label).toHaveAttribute('data-size', String(SIZES[SIZES.indexOf(size) + 1]));
            expect(await rootSize(page), label).toBeGreaterThan(before);
          } else {
            await expect(largest, label).toBeVisible();
            await expect(largest, label).toBeDisabled();
            // Truly the largest here: the next size, if there is one, is no larger.
            const next = SIZES[SIZES.indexOf(size) + 1];
            if (next) {
              await setPrefs(context, baseURL!, { size: next });
              await page.goto('/about');
              expect(await rootSize(page), label).toBeLessThanOrEqual(before);
            }
          }
        }
      }
    });
  }

  test('at 175 % A+ is disabled and says so, in both places; at 75 % A− is', async ({ page, context, baseURL }) => {
    await setPrefs(context, baseURL!, { size: 175 });
    await page.goto('/about#reader-menu');
    for (const controls of [panel(page), readingBar(page)]) {
      await expect(controls.getByRole('button', { name: /Largest size for this screen/ })).toBeDisabled();
      await expect(controls.getByRole('button', { name: /A\+ Larger/ })).toBeHidden();
    }
    // In words in the panel; one word, as on its neighbours, in the reading bar.
    await expect(panel(page).getByText('Largest size for this screen.')).toBeVisible();
    await expect(readingBar(page).getByRole('button', { name: /Largest size for this screen/ })).toHaveText(/^\s*A\+\s*Largest/);
    await setPrefs(context, baseURL!, { size: 75 });
    await page.goto('about:blank');
    await page.goto('/about#reader-menu');
    for (const controls of [panel(page), readingBar(page)]) {
      await expect(controls.getByRole('button', { name: /Smallest size/ })).toBeDisabled();
      await expect(controls.getByRole('button', { name: /A− Smaller/ })).toBeHidden();
    }
    await expect(panel(page).getByText('Largest size for this screen.')).toBeHidden();
  });

  test.describe('at 260px wide', () => {
    test.use({ viewport: { width: 260, height: 640 } });

    test('150 % is the largest for this screen: A+ is disabled there and says so; at 125 % A+ still works', async ({ page, context, baseURL }) => {
      await setPrefs(context, baseURL!, { size: 150 });
      await page.goto('/about#reader-menu');
      await expect(panel(page).getByRole('button', { name: /Largest size for this screen/ })).toBeDisabled();
      await expect(panel(page).getByText('Largest size for this screen.')).toBeVisible();
      await setPrefs(context, baseURL!, { size: 125 });
      await page.goto('about:blank');
      await page.goto('/about#reader-menu');
      await expect(panel(page).getByRole('button', { name: /A\+ Larger/ })).toBeEnabled();
      await expect(panel(page).getByText('Largest size for this screen.')).toBeHidden();
    });
  });
});
