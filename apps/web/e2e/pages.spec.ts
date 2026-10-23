// The public pages (W2): About, Join and Governance from content/site/, and
// the newsletter and minutes from the fixture adapter's made-up data.
import { expect, test } from '@playwright/test';

test.describe('About', () => {
  test('tells the history, and has the sections the old links land on', async ({ page }) => {
    await page.goto('/about');
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { level: 2, name: 'Our history' })).toBeVisible();
    await expect(main).toContainText('1987');
    await expect(main).toContainText('Apalachicola River');
    for (const id of ['gifted-youth', 'scholarships']) await expect(page.locator(`#${id}`), id).toHaveCount(1);
  });

  test('keeps the old home page’s outbound links (R1)', async ({ page }) => {
    await page.goto('/about');
    const links = page.getByRole('main').getByRole('link');
    for (const href of ['https://www.us.mensa.org/', 'https://region10.us.mensa.org/', 'https://www.mensa.org/', 'https://www.facebook.com/groups/167192940095851/']) {
      await expect(links.and(page.locator(`[href="${href}"]`)), href).toHaveCount(1);
    }
  });
});

test('Join points to American Mensa, the events and the officers', async ({ page }) => {
  await page.goto('/join');
  const main = page.getByRole('main');
  await expect(main.locator('a[href="https://www.us.mensa.org/join/"]')).toHaveCount(1);
  await expect(main.locator('a[href="/events"]')).toHaveCount(1);
  await expect(main.locator('a[href="/officers"]')).toHaveCount(1);
  await expect(main).toContainText('top 2 percent');
});

test('Governance covers the charter, the bylaws and elections, and links out to American Mensa and Mensa International', async ({ page }) => {
  await page.goto('/governance');
  const main = page.getByRole('main');
  for (const name of ['Our charter', 'Our bylaws', 'Elections']) await expect(main.getByRole('heading', { level: 2, name }), name).toBeVisible();
  await expect(main.locator('a[href="https://www.us.mensa.org/lead/policydocuments/bylaws/"]')).toHaveCount(1);
  await expect(main.locator('a[href="https://www.mensa.org/about-us/"]')).toHaveCount(1);
  await expect(main.locator('.prose a[href="/minutes"]')).toHaveCount(1);
});

// The design draft's About subnav (W-LOOK), on each page it names, the current one marked.
test('About, Officers, Governance, Minutes and Finances share the About subnav', async ({ page }) => {
  for (const path of ['/about', '/officers', '/governance', '/minutes', '/finances']) {
    await page.goto(path);
    const subnav = page.getByRole('navigation', { name: 'About the group' });
    await expect(subnav.getByRole('link'), path).toHaveText(['Who we are', 'Officers', 'Governance', 'Minutes', 'Finances']);
    await expect(subnav.locator('[aria-current="page"]'), path).toHaveAttribute('href', path);
  }
  await page.goto('/join');
  await expect(page.getByRole('navigation', { name: 'About the group' })).toHaveCount(0);
});

// Officers, Finances, Home and the calendar read the API now: live.spec.ts.
test.describe('pages still filled from the bundled sample data', () => {
  for (const path of ['/news', '/minutes']) {
    test(`${path} says its entries are samples`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole('note').filter({ hasText: 'Sample entries' })).toBeVisible();
    });
  }

  test('News, the newsletter, shows the current issue, then past issues by year, missing ones honestly', async ({ page }) => {
    await page.goto('/news');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('News');
    await expect(page.getByRole('heading', { level: 2, name: 'October and November 2026' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Past issues' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 3, name: '2026' })).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: 'June and July 2025' })).toContainText('No copy known');
    await expect(page.locator('[data-source="pipeline"]').first()).toBeVisible();
  });

  test('Minutes lists meetings newest first, each at its date anchor, with attendance by office', async ({ page }) => {
    await page.goto('/minutes');
    const meetings = page.locator('article.meeting');
    await expect(meetings).toHaveCount(3);
    await expect(meetings.first()).toHaveAttribute('id', '2026-09-19');
    await expect(meetings.first().getByRole('heading', { level: 2 })).toHaveText('Saturday, 19 September 2026');
    await expect(meetings.first()).toContainText('President, Vice President, Secretary, Newsletter Editor, and 3 other members');
    await expect(page.locator('[id="2026-09"]')).toHaveCount(1);
    await page.goto('/minutes#2026-06-20');
    await expect(page.locator('article.meeting#\\32 026-06-20')).toBeInViewport();
  });
});
