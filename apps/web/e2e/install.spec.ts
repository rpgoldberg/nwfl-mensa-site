import { expect, test } from '@playwright/test';
import { ALL_PAGES } from './pages';

const FACEBOOK_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/450.0.0.0;]';

test('every page links the manifest, the icons and the home-screen how-to', async ({ page, request }) => {
  for (const path of ALL_PAGES) {
    await page.goto(path);
    await expect(page.locator('link[rel="manifest"]'), path).toHaveAttribute('href', '/manifest.webmanifest');
    await expect(page.locator('link[rel="apple-touch-icon"]'), path).toHaveAttribute('href', '/icons/apple-touch-icon.png');
    await expect(page.locator('meta[name="theme-color"]'), path).toHaveAttribute('content', '#00566b');
    await expect(page.getByRole('contentinfo').getByRole('link', { name: 'Put the club on your home screen' }), path).toHaveAttribute('href', '/home-screen');
  }
  const manifest = await request.get('/manifest.webmanifest');
  expect(manifest.headers()['content-type']).toMatch(/^application\/manifest\+json/);
  const icons = (await manifest.json()) as { icons: { src: string }[] };
  for (const icon of icons.icons) expect((await request.get(icon.src)).headers()['content-type'], icon.src).toBe('image/png');
});

test('Home links to the home-screen how-to', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('main').getByRole('link', { name: 'Put the club on your home screen' })).toHaveAttribute('href', '/home-screen');
});

test('Chromium reads the manifest with no errors: the name, standalone display and icons', async ({ page, browserName, baseURL }) => {
  test.skip(browserName !== 'chromium', 'the manifest report is a Chromium protocol call');
  await page.goto('/');
  const cdp = await page.context().newCDPSession(page);
  const report = (await cdp.send('Page.getAppManifest')) as {
    url: string;
    errors: { message: string }[];
    manifest?: { name?: string; display?: string; icons?: unknown[]; shortcuts?: unknown[] };
  };
  expect(report.url).toBe(`${baseURL}/manifest.webmanifest`);
  expect(report.errors.map((e) => e.message)).toEqual([]);
  expect(report.manifest).toMatchObject({ name: 'NW Florida Mensa', display: 'kStandalone' });
  expect(report.manifest?.icons).toHaveLength(3);
  expect(report.manifest?.shortcuts).toHaveLength(3);
});

test.describe('the how-to page', () => {
  test('gives the Android steps in words and pictures', async ({ page }) => {
    await page.goto('/home-screen');
    const android = page.getByRole('region', { name: 'On an Android phone' });
    const steps = android.getByRole('listitem');
    await expect(steps).toHaveCount(3);
    for (const step of await steps.all()) {
      await expect(step.getByRole('img')).toHaveCount(1);
      expect((await step.getByRole('img').getAttribute('aria-label'))?.length ?? 0).toBeGreaterThan(20);
    }
    await expect(page.getByRole('region', { name: 'Opened this from Facebook?' })).toBeVisible();
  });

  test("shows the install button only when the browser offers installation, and it opens the browser's dialog", async ({ page }) => {
    await page.goto('/home-screen');
    const button = page.getByRole('button', { name: 'Install the club app' });
    await expect(button).toBeHidden();
    await page.evaluate(() => {
      const offer = new Event('beforeinstallprompt', { cancelable: true }) as Event & { prompt(): Promise<void>; userChoice: Promise<unknown> };
      offer.prompt = async () => void document.documentElement.setAttribute('data-prompted', 'yes');
      offer.userChoice = Promise.resolve({ outcome: 'accepted' });
      window.dispatchEvent(offer);
    });
    await expect(button).toBeVisible();
    await button.click();
    await expect(page.locator('html')).toHaveAttribute('data-prompted', 'yes');
    await expect(button).toBeHidden();
  });
});

test.describe('inside Facebook', () => {
  test.use({ userAgent: FACEBOOK_UA });

  test('a hint says to open the page in Chrome or Safari, and closes on request', async ({ page }) => {
    await page.goto('/about');
    const hint = page.getByRole('note', { name: 'Open in your browser' });
    await expect(hint).toBeVisible();
    await expect(hint).toContainText('Open in browser');
    await hint.getByRole('button', { name: 'Close this hint' }).click();
    await expect(hint).toBeHidden();
  });
});

test.describe('with JavaScript off', () => {
  test.use({ javaScriptEnabled: false, userAgent: FACEBOOK_UA });

  test('the how-to page still works, with no install button and no hint', async ({ page }) => {
    await page.goto('/home-screen');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Put the club on your home screen');
    await expect(page.getByRole('region', { name: 'On an Android phone' }).getByRole('listitem')).toHaveCount(3);
    await expect(page.getByRole('button', { name: 'Install the club app' })).toBeHidden();
    await expect(page.getByRole('note', { name: 'Open in your browser' })).toBeHidden();
  });
});
