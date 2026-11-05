// LINKS L4: the leaving page /out/<id> in a real browser, desktop and phone. The guard waits for a
// press on Continue, which opens a new tab with no opener and no referrer; the countdown goes on in
// this tab after 5 seconds unless Stop (which has the focus) is pressed or the reader does anything
// else on the page (any key or press, Stop included, the wheel, a touch scroll, the radio, Back), and
// is the guard with JavaScript off; direct goes straight there. The same choice is in the Aa panel on every page. An officer, served the original,
// is shown the public copy's link (the site asks again as the public). A mail link always shows the page; a link turned off
// shows that it was, with no URL. Keyboard alone reaches Continue, Back and Stop. axe is clean in all
// three modes, at 175 % text and in both high contrast themes, and a 320 px phone never scrolls
// sideways. No test leaves this machine: the other site is answered by the browser's own route (the
// direct choice's 303, which a route cannot follow, is in out-direct.spec.ts).
import AxeBuilder from '@axe-core/playwright';
import { type BrowserContext, type Page, expect, test } from '@playwright/test';
import { LINKS_COOKIE, SIZES } from '../server/prefs.mjs';
import { setPrefs } from './prefs';
import { signIn } from './signin';
import { LINKS } from './stand-in';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'wcag2aaa', 'best-practice'];
const out = (id: string) => `/out/${id}`;
const back = (page: number) => `/documents/${LINKS.file}.pdf#page=${page}`;

async function axe(page: Page): Promise<string[]> {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

/** Every request to the other sites is answered here, with what it asked for: nothing leaves this machine. */
async function otherSites(context: BrowserContext): Promise<Array<{ url: string; referer: string | undefined }>> {
  const seen: Array<{ url: string; referer: string | undefined }> = [];
  await context.route(/^https:\/\/(club|parked)\.example\//, async (route) => {
    seen.push({ url: route.request().url(), referer: (await route.request().allHeaders())['referer'] });
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html lang="en"><title>Elsewhere</title><h1>Elsewhere</h1></html>' });
  });
  return seen;
}

const host = (page: Page) => page.locator('.out-host');
const continueLink = (page: Page) => page.locator('a[data-out-continue]');

test.describe('the guard (the default)', () => {
  test('shows the host large, the full URL, the last check and the way back, and waits', async ({ page, context }) => {
    const seen = await otherSites(context);
    await page.goto(out(LINKS.web.id));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('You are leaving the Northwest Florida Mensa site');
    await expect(host(page)).toHaveText(LINKS.web.host);
    await expect(page.locator('.out-url')).toHaveText(LINKS.web.url);
    await expect(page.getByText(`We last checked this link on ${LINKS.checked}.`)).toBeVisible();
    const go = continueLink(page);
    await expect(go).toHaveText(`Continue to ${LINKS.web.host} (opens in a new tab)`);
    await expect(go).toHaveAttribute('href', LINKS.web.url);
    await expect(go).toHaveAttribute('target', '_blank');
    await expect(go).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(page.getByRole('link', { name: 'Back to the newsletter' })).toHaveAttribute('href', back(LINKS.web.page));
    await expect(page.getByRole('radio', { name: /wait until I choose Continue/ })).toBeChecked();
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
    await expect(page.locator('[data-out-countdown]')).toHaveCount(0);
    // The host is large: bigger than the body text, which is itself at least 16 px.
    const sizes = await page.evaluate(() => [parseFloat(getComputedStyle(document.querySelector('.out-host')!).fontSize), parseFloat(getComputedStyle(document.body).fontSize)]);
    expect(sizes[0]).toBeGreaterThan(sizes[1]! * 1.5);
    await page.waitForTimeout(6000);
    expect(page.url()).toContain(out(LINKS.web.id));
    expect(seen).toEqual([]);
  });

  test('Continue opens the URL in a new tab, with no opener and no referrer, and this page stays', async ({ page, context }) => {
    const seen = await otherSites(context);
    await page.goto(out(LINKS.web.id));
    const [tab] = await Promise.all([context.waitForEvent('page'), continueLink(page).click()]);
    await tab.waitForLoadState();
    expect(tab.url()).toBe(LINKS.web.url);
    expect(await tab.evaluate(() => [window.opener === null, document.referrer])).toEqual([true, '']);
    expect(seen).toEqual([{ url: LINKS.web.url, referer: undefined }]);
    expect(page.url()).toContain(out(LINKS.web.id));
  });

  test('the keyboard alone reaches Continue, then Back, then the choice for next time', async ({ page, browserName }) => {
    await page.goto(out(LINKS.web.id));
    if (browserName === 'webkit') {
      // WebKit's Tab skips links by default (as Safari does; layout.spec.ts), so check the document order instead.
      const order = await page.locator('main a[data-out-continue], main a[href^="/documents/"], main input[name="links"]').evaluateAll((els) => els.map((el) => el.getAttribute('data-out-continue') !== null ? 'continue' : el.tagName === 'A' ? 'back' : 'choice'));
      expect(order.slice(0, 3)).toEqual(['continue', 'back', 'choice']);
      return;
    }
    await page.locator('h1').click();
    const reached: string[] = [];
    for (let i = 0; i < 40 && reached.length < 3; i++) {
      await page.keyboard.press('Tab');
      const name = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (el?.matches('a[data-out-continue]')) return 'continue';
        if (el?.matches('a[href^="/documents/"]')) return 'back';
        if (el?.matches('input[name="links"]')) return 'choice';
        return '';
      });
      if (name && !reached.includes(name)) reached.push(name);
    }
    expect(reached).toEqual(['continue', 'back', 'choice']);
  });

  test('says when a link is on a site that may need a sign-in', async ({ page }) => {
    await page.goto(out(LINKS.social.id));
    await expect(page.getByText('This page is on Facebook. You may need to sign in to Facebook to see it.')).toBeVisible();
  });

  test('a mail link shows the address to write to, in this tab, with no countdown, even with direct chosen', async ({ page, context, baseURL }) => {
    await setPrefs(context, baseURL!, { links: 'direct' });
    await page.goto(out(LINKS.mail.id));
    const write = page.getByRole('link', { name: 'Write an email to events@example.org' });
    await expect(write).toHaveAttribute('href', LINKS.mail.url);
    await expect(write).not.toHaveAttribute('target', /.+/);
    await expect(page.locator('[data-out-countdown]')).toHaveCount(0);
  });

  test('a link turned off says so, with its date and the way back, and never its URL', async ({ page }) => {
    await page.goto(out(LINKS.off.id));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('This link was turned off');
    await expect(page.getByText(`This link was turned off on ${LINKS.checked} because the site it led to has changed. We no longer send readers there.`)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to the newsletter' })).toHaveAttribute('href', back(LINKS.off.page));
    expect(await page.content()).not.toContain(LINKS.off.host);
  });

  test('every id with no link is the same 404, and a URL a buggy API sent is never rendered', async ({ page }) => {
    for (const id of [LINKS.unknown.id, LINKS.script.id, LINKS.angles.id, LINKS.rtl.id, LINKS.members.id]) {
      const res = await page.goto(out(id));
      expect(res?.status(), id).toBe(404);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('This link is not available');
      const html = await page.content();
      for (const leak of ['javascript:', 'alert(', 'members-night', '‮']) expect(html, `${id}: ${leak}`).not.toContain(leak);
    }
  });

  test('a member reaches the link in the members copy; the public does not', async ({ page }) => {
    expect((await page.goto(out(LINKS.members.id)))?.status()).toBe(404);
    await page.goto('/');
    await signIn(page, 'member');
    expect((await page.goto(out(LINKS.members.id)))?.status()).toBe(200);
    await expect(host(page)).toHaveText(LINKS.members.host);
    await expect(page.locator('.out-url')).toHaveText(LINKS.members.url);
  });

  test("an officer, served the original, is shown the public copy's link, and a link turned off; the members copy's link is the 404", async ({ page }) => {
    await page.goto('/');
    await signIn(page, 'officer');
    expect((await page.goto(out(LINKS.web.id)))?.status()).toBe(200);
    await expect(host(page)).toHaveText(LINKS.web.host);
    await expect(continueLink(page)).toHaveAttribute('href', LINKS.web.url);
    expect((await page.goto(out(LINKS.off.id)))?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('This link was turned off');
    expect(await page.content()).not.toContain(LINKS.off.host);
    expect((await page.goto(out(LINKS.members.id)))?.status()).toBe(404);
  });
});

test.describe('the countdown', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await setPrefs(context, baseURL!, { links: 'countdown' });
  });

  test('puts the focus on Stop, is announced once, and goes on in this tab after 5 seconds, out of the history', async ({ page, context }) => {
    const seen = await otherSites(context);
    await page.goto('/news');
    await page.goto(out(LINKS.web.id));
    await expect(page.getByRole('button', { name: 'Stop' })).toBeFocused();
    const status = page.locator('[data-out-status]');
    await expect(status).toHaveText(`Going to ${LINKS.web.host} in 5 seconds. Press Stop to stay on this page.`);
    await expect(status).toHaveAttribute('role', 'status');
    await expect(page.locator('.out-count')).toHaveAttribute('aria-hidden', 'true');
    await page.waitForURL(LINKS.web.url, { timeout: 9000 });
    expect(seen).toEqual([{ url: LINKS.web.url, referer: undefined }]);
    // location.replace: Back goes to the page before the leaving page.
    await page.goBack();
    await expect(page).toHaveURL(/\/news$/);
  });

  test('Stop, by the keyboard, stops it for good, says so, and hands the focus to Continue', async ({ page, context }) => {
    const seen = await otherSites(context);
    await page.goto(out(LINKS.web.id));
    await expect(page.getByRole('button', { name: 'Stop' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-out-status]')).toHaveText('Stopped. You are still on our site. Choose Continue when you are ready.');
    await expect(continueLink(page)).toBeFocused();
    await expect(page.locator('[data-out-countdown]')).toBeHidden();
    await page.waitForTimeout(6500);
    expect(page.url()).toContain(out(LINKS.web.id));
    expect(seen).toEqual([]);
  });

  const STOPPED = 'Stopped. You are still on our site. Choose Continue when you are ready.';
  /** Every text the status region is given, from the first: the stop is said once. */
  const statusLog = (page: Page) =>
    page.addInitScript(() => {
      const said: string[] = [];
      (window as unknown as { said: string[] }).said = said;
      new MutationObserver((records) => {
        for (const r of records) if (r.target instanceof Element && r.target.matches('[data-out-status]')) said.push(r.target.textContent ?? '');
      }).observe(document, { subtree: true, childList: true, characterData: true });
    });
  const said = (page: Page) => page.evaluate(() => (window as unknown as { said: string[] }).said);
  const ANNOUNCED = `Going to ${LINKS.web.host} in 5 seconds. Press Stop to stay on this page.`;

  const elsewhere: Array<[string, (page: Page) => Promise<void>, string | undefined]> = [
    ['choosing a radio for next time', (page) => page.getByRole('radio', { name: /wait until I choose Continue/ }).check(), 'radio'],
    ['the keyboard moving on from Stop, to Continue', (page) => page.keyboard.press('Tab'), 'continue'],
    ['the focus on Back', (page) => page.getByRole('link', { name: 'Back to the newsletter' }).focus(), 'back'],
    ['a press anywhere on the page', (page) => page.getByRole('heading', { level: 1 }).click(), undefined],
  ];
  for (const [name, act, keeps] of elsewhere) {
    test(`${name} stops it, as Stop does: said once, nothing moves, and the focus stays where the reader put it`, async ({ page, context }) => {
      const seen = await otherSites(context);
      await statusLog(page);
      await page.goto(out(LINKS.web.id));
      await expect(page.getByRole('button', { name: 'Stop' })).toBeFocused();
      await act(page);
      await expect(page.locator('[data-out-status]')).toHaveText(STOPPED);
      await expect(page.locator('[data-out-countdown]')).toBeHidden();
      if (keeps === 'radio') await expect(page.getByRole('radio', { name: /wait until I choose Continue/ })).toBeFocused();
      if (keeps === 'continue') await expect(continueLink(page)).toBeFocused();
      if (keeps === 'back') await expect(page.getByRole('link', { name: 'Back to the newsletter' })).toBeFocused();
      await page.waitForTimeout(6500);
      expect(page.url()).toContain(out(LINKS.web.id));
      expect(seen).toEqual([]);
      expect(await said(page)).toEqual([ANNOUNCED, STOPPED]);
    });
  }

  // Stop holds the focus from the start, so every key a reader presses lands on it. Reading on, zooming
  // or a slip of the finger must not send anyone away: any key or press stops it, Stop included.
  const onStop: Array<[string, (page: Page) => Promise<void>]> = [
    ['the down arrow, with the focus on Stop', (page) => page.keyboard.press('ArrowDown')],
    ['Page Down, with the focus on Stop', (page) => page.keyboard.press('PageDown')],
    ['Ctrl and + to zoom, with the focus on Stop', (page) => page.keyboard.press('Control+Equal')],
    ['Escape, with the focus on Stop', (page) => page.keyboard.press('Escape')],
    [
      'the mouse wheel',
      async (page) => {
        await page.mouse.move(100, 200);
        await page.mouse.wheel(0, 300);
      },
    ],
    [
      'a press on Stop that slides off before it is let go',
      async (page) => {
        const box = (await page.getByRole('button', { name: 'Stop' }).boundingBox())!;
        await page.mouse.move(box.x + 5, box.y + 5);
        await page.mouse.down();
        await page.mouse.move(5, 5, { steps: 5 });
        await page.mouse.up();
      },
    ],
  ];
  for (const [name, act] of onStop) {
    test(`${name} stops it: said once, nothing moves, and the focus goes to Continue`, async ({ page, context, isMobile, browserName }) => {
      test.skip(
        name === 'the mouse wheel' && isMobile && browserName === 'webkit',
        'mobile WebKit has no mouse wheel; the touch-drag case covers scrolling on the phone',
      );
      const seen = await otherSites(context);
      await statusLog(page);
      await page.goto(out(LINKS.web.id));
      await expect(page.getByRole('button', { name: 'Stop' })).toBeFocused();
      await act(page);
      await expect(page.locator('[data-out-status]')).toHaveText(STOPPED);
      await expect(page.locator('[data-out-countdown]')).toBeHidden();
      await expect(continueLink(page)).toBeFocused();
      await page.waitForTimeout(6500);
      expect(page.url()).toContain(out(LINKS.web.id));
      expect(seen).toEqual([]);
      expect(await said(page)).toEqual([ANNOUNCED, STOPPED]);
    });
  }

  test('a touch scroll that starts on Stop stops it, says so once, and nothing moves', async ({ page, context, browserName }) => {
    // A real touch drag needs the browser's own input (CDP), so Chromium on the phone only.
    test.skip(browserName !== 'chromium' || !test.info().project.use.hasTouch, 'a touch drag through CDP, Chromium phone only');
    const seen = await otherSites(context);
    await statusLog(page);
    await page.goto(out(LINKS.web.id));
    await expect(page.getByRole('button', { name: 'Stop' })).toBeFocused();
    const box = (await page.getByRole('button', { name: 'Stop' }).boundingBox())!;
    const [x, y] = [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)];
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let step = 1; step <= 5; step += 1) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - step * 30 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(page.locator('[data-out-status]')).toHaveText(STOPPED);
    await expect(page.locator('[data-out-countdown]')).toBeHidden();
    await page.waitForTimeout(6500);
    expect(page.url()).toContain(out(LINKS.web.id));
    expect(seen).toEqual([]);
    expect(await said(page)).toEqual([ANNOUNCED, STOPPED]);
  });

  test('Stop, then more on the page, says the stop once', async ({ page }) => {
    await statusLog(page);
    await page.goto(out(LINKS.web.id));
    await page.keyboard.press('Enter');
    await page.getByRole('radio', { name: /Go straight/ }).check();
    await page.keyboard.press('Tab');
    await expect(page.locator('[data-out-status]')).toHaveText(STOPPED);
    expect(await said(page)).toEqual([ANNOUNCED, STOPPED]);
  });

  test('right after the reader saves a choice, the page shows and does not count down', async ({ page, context }) => {
    const seen = await otherSites(context);
    await page.goto(out(LINKS.web.id));
    await page.getByRole('button', { name: 'Stop' }).click();
    await page.getByRole('radio', { name: /continue after 5 seconds/ }).check();
    await page.getByRole('button', { name: 'Save my choice' }).click();
    await expect(page).toHaveURL(new RegExp(`${out(LINKS.web.id)}\\?saved=1$`));
    await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toHaveText('Saved. Next time you follow a link to another site, we will show you this page, then continue after 5 seconds.');
    await expect(page.locator('[data-out-countdown]')).toHaveCount(0);
    await page.waitForTimeout(6000);
    expect(seen).toEqual([]);
  });
});

test.describe('the countdown with JavaScript off', () => {
  test.use({ javaScriptEnabled: false });

  test('is the guard: no countdown shows, and nothing moves', async ({ page, context, baseURL }) => {
    await setPrefs(context, baseURL!, { links: 'countdown' });
    const seen = await otherSites(context);
    await page.goto(out(LINKS.web.id));
    await expect(page.locator('[data-out-countdown]')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Stop' })).toBeHidden();
    await expect(continueLink(page)).toBeVisible();
    await page.waitForTimeout(6500);
    expect(page.url()).toContain(out(LINKS.web.id));
    expect(seen).toEqual([]);
  });
});

// The same choice in the Aa panel, on every page: a reader who chose to go straight there never sees
// the leaving page's form again, so the panel is their way back (orchestrator's decision 6).
test.describe('the choice in the Aa panel', () => {
  const choice = (page: Page) => page.locator('#reader-menu').getByRole('group', { name: 'Leaving the site' });
  const LABELS = ['Show a page first, and wait for me to continue', 'Show a page first, then continue after 5 seconds', 'Go straight to the other site'] as const;

  test.describe('with JavaScript off', () => {
    test.use({ javaScriptEnabled: false });

    // One page rendered on request, one prerendered: both must show the choice from the cookie.
    for (const path of ['/officers', '/about']) {
      test(`a reader who chose to go straight there sees it chosen, and can choose the page again, from ${path}`, async ({ page, context, baseURL }) => {
        await setPrefs(context, baseURL!, { links: 'direct' });
        await page.goto(`${path}#reader-menu`);
        await expect(choice(page).getByRole('button')).toHaveText(LABELS.map((label) => new RegExp(`^${label}`)));
        await expect(choice(page).getByRole('button', { name: `${LABELS[2]} Chosen`, exact: true })).toBeVisible();
        await choice(page).getByRole('button', { name: LABELS[0], exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`${path}#reader-menu$`));
        await expect(choice(page).getByRole('button', { name: `${LABELS[0]} Chosen`, exact: true })).toBeVisible();
        expect((await context.cookies()).map((c) => c.name)).not.toContain(LINKS_COOKIE);
        expect((await page.goto(out(LINKS.web.id)))?.status()).toBe(200);
        await expect(host(page)).toHaveText(LINKS.web.host);

        await page.goto(`${path}#reader-menu`);
        await choice(page).getByRole('button', { name: LABELS[1], exact: true }).click();
        await expect(choice(page).getByRole('button', { name: `${LABELS[1]} Chosen`, exact: true })).toBeVisible();
        expect((await context.cookies()).find((c) => c.name === LINKS_COOKIE)).toMatchObject({ value: 'countdown', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' });
        await choice(page).getByRole('button', { name: LABELS[2], exact: true }).click();
        expect((await context.cookies()).find((c) => c.name === LINKS_COOKIE)?.value).toBe('direct');
        // A press here keeps the size and theme.
        await expect(page.locator('html')).toHaveAttribute('data-size', '100');
        await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.*/);
      });
    }
  });

  test('each choice is a labelled button of at least 48 px, whole at 175 % on any screen', async ({ page, context, baseURL }) => {
    await setPrefs(context, baseURL!, { size: SIZES[6], links: 'countdown' });
    await page.goto('/about#reader-menu');
    await expect(choice(page)).toBeVisible();
    for (const button of await choice(page).getByRole('button').all()) {
      const box = (await button.boundingBox())!;
      expect(box.height, await button.textContent() ?? '').toBeGreaterThanOrEqual(48);
      expect(await button.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  for (const links of ['guard', 'direct'] as const) {
    test(`axe on the open Aa panel at 175 % text, ${links} chosen`, async ({ page, context, baseURL }) => {
      await setPrefs(context, baseURL!, { size: SIZES[6], links });
      await page.goto('/about#reader-menu');
      await expect(choice(page)).toBeVisible();
      expect(await axe(page)).toEqual([]);
    });
  }
});

test.describe('accessibility', () => {
  const views: Array<[string, string, string | undefined]> = [
    ['the guard', LINKS.web.id, undefined],
    ['the countdown', LINKS.web.id, 'countdown'],
    ['a mail link with direct chosen', LINKS.mail.id, 'direct'],
    ['a login-walled link', LINKS.social.id, undefined],
    ['a link turned off', LINKS.off.id, 'direct'],
    ['no such link', LINKS.unknown.id, undefined],
  ];
  for (const [name, id, links] of views) {
    for (const theme of [undefined, 'contrast-yellow', 'contrast-white'] as const) {
      test(`axe on ${name}, at 175 % text${theme ? `, ${theme}` : ''}`, async ({ page, context, baseURL }) => {
        await otherSites(context);
        await setPrefs(context, baseURL!, { size: SIZES[6], ...(theme ? { theme } : {}), ...(links ? { links } : {}) });
        await page.goto(out(id));
        await expect(page.locator('html')).toHaveAttribute('data-size', String(SIZES[6]));
        expect(await axe(page)).toEqual([]);
      });
    }
  }

  test('axe in the high-contrast system setting', async ({ page }) => {
    await page.emulateMedia({ contrast: 'more' });
    await page.goto(out(LINKS.web.id));
    expect(await axe(page)).toEqual([]);
  });

  test('a 320 px phone at 175 % text never scrolls sideways, even for a long URL, and Continue and Back stay whole', async ({ page, context, baseURL }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await setPrefs(context, baseURL!, { size: SIZES[6] });
    for (const id of [LINKS.web.id, LINKS.long.id, LINKS.mail.id]) {
      await page.goto(out(id));
      expect(await page.evaluate(() => document.documentElement.scrollWidth), id).toBeLessThanOrEqual(320);
      for (const link of [continueLink(page), page.getByRole('link', { name: 'Back to the newsletter' })]) {
        const box = await link.boundingBox();
        expect(box, id).not.toBeNull();
        expect(box!.x, id).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width, id).toBeLessThanOrEqual(320);
        expect(box!.height, id).toBeGreaterThanOrEqual(44);
      }
    }
  });
});
