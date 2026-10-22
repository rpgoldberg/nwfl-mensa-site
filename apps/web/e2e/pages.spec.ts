// The public pages (W2): About, Join and Governance from content/site/, and
// the on-request pages from the fixture adapter's made-up data.
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

test('Join points to American Mensa, the calendar and the officers', async ({ page }) => {
  await page.goto('/join');
  const main = page.getByRole('main');
  await expect(main.locator('a[href="https://www.us.mensa.org/join/"]')).toHaveCount(1);
  await expect(main.locator('a[href="/calendar"]')).toHaveCount(1);
  await expect(main.locator('a[href="/officers"]')).toHaveCount(1);
  await expect(main).toContainText('top 2 percent');
});

test('Governance covers the charter, the bylaws and elections, and links out to American Mensa and Mensa International', async ({ page }) => {
  await page.goto('/governance');
  const main = page.getByRole('main');
  for (const name of ['Our charter', 'Our bylaws', 'Elections']) await expect(main.getByRole('heading', { level: 2, name }), name).toBeVisible();
  await expect(main.locator('a[href="https://www.us.mensa.org/lead/policydocuments/bylaws/"]')).toHaveCount(1);
  await expect(main.locator('a[href="https://www.mensa.org/about-us/"]')).toHaveCount(1);
  await expect(main.locator('a[href="/minutes"]')).toHaveCount(1);
});

test.describe('pages filled from the API (sample data for now)', () => {
  for (const path of ['/officers', '/newsletter', '/minutes', '/finances']) {
    test(`${path} says its entries are samples`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole('note').filter({ hasText: 'Sample entries' })).toBeVisible();
    });
  }

  test('Officers lists each office by role, shows a vacant seat, and only addresses known to work', async ({ page }) => {
    await page.goto('/officers');
    const roster = page.getByRole('list', { name: 'Officers' });
    await expect(roster.getByRole('listitem')).toHaveCount(6);
    const president = roster.getByRole('listitem').filter({ hasText: 'President' }).first();
    await expect(president.getByRole('link', { name: 'president@nwflorida.us' })).toHaveAttribute('href', 'mailto:president@nwflorida.us');
    await expect(roster.getByRole('listitem').filter({ hasText: 'Membership Officer' })).toContainText('Vacant');
    // The treasurer alias has not been seen to deliver yet: no address shown.
    await expect(roster.getByRole('listitem').filter({ hasText: 'Treasurer' })).not.toContainText('@');
    await expect(page.locator('[data-source="submitted"]')).toHaveCount(6);
  });

  test('Newsletter shows the current issue, then past issues by year, missing ones honestly', async ({ page }) => {
    await page.goto('/newsletter');
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

  test('Finances shows each period’s totals, which add up', async ({ page }) => {
    await page.goto('/finances');
    const table = page.getByRole('table', { name: 'July to September 2026' });
    await expect(table).toBeVisible();
    for (const [row, value] of [
      ['Opening balance', '$2,543.10'],
      ['Deposits', '$420.00'],
      ['Debits', '−$185.75'],
      ['Closing balance', '$2,777.35'],
    ] as const) {
      await expect(table.getByRole('row', { name: new RegExp(`^${row}`) }), row).toContainText(value);
    }
    await expect(page.getByRole('main')).toContainText('Accepted by the Executive Committee on Saturday, 19 September 2026');
  });
});
