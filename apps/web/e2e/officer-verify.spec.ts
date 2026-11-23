// OFFICER-VERIFY, the activation pages at every width: an officer whose membership check waits sees the
// sign-up form with the notice, then the waiting line with it; the approvers' queue shows the first-name
// check, the local group and the invited sign-up that cannot be approved by hand. At 320, 412 and 1280 px
// and at 200 % text: nothing scrolls sideways, every button is whole and at least 48 px tall, and axe
// finds nothing. With OV_SHOTS set, each state is saved there as a screenshot. Every name is made up.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { signIn } from './signin';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'wcag2aaa', 'best-practice'];
const NOTICE = 'Your officer tools open once your membership is confirmed. Until then you see what the public sees.';
const FAKE_NUMBER = '000012345';

async function axe(page: Page): Promise<string[]> {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

/** No sideways scroll; every button in the page's main part whole on screen and at least 48 px tall. */
async function held(page: Page, width: number): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  for (const button of await page.getByRole('main').getByRole('button').all()) {
    const box = (await button.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.height).toBeGreaterThanOrEqual(48);
  }
}

/** The whole page, or at 200 % text the screen in view (a whole page there passes WebKit's 32767 px limit). */
async function shot(page: Page, name: string, project: string, whole = true): Promise<void> {
  const dir = process.env['OV_SHOTS'];
  if (dir) await page.screenshot({ path: `${dir}/after-${project}-${name}.png`, fullPage: whole });
}

/** The browser's own text at 200 %: the root's size doubled, as a reader's setting does it (logo.spec.ts). */
async function doubled(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.documentElement.dataset['size'] = '100';
    document.documentElement.style.fontSize = '200%';
  });
}

const VIEWS = [
  ['320', { width: 320, height: 700 }, false],
  ['412', { width: 412, height: 900 }, false],
  ['1280', { width: 1280, height: 900 }, false],
  ['640-200pct', { width: 640, height: 450 }, true],
] as const;

test.describe('OFFICER-VERIFY: the activation pages', () => {
  for (const [name, view, big] of VIEWS) {
    test(`an officer whose check waits, at ${name}: the form with the notice, then the waiting line with it`, async ({ page }, info) => {
      await page.setViewportSize(view);
      await page.goto('/');
      await signIn(page, 'officer-unverified');
      await page.goto('/account');
      if (big) await doubled(page);
      await expect(page.getByRole('note').filter({ hasText: NOTICE })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Send my sign-up' })).toBeVisible();
      await held(page, view.width);
      expect(await axe(page)).toEqual([]);
      await shot(page, `${name}-account-form`, info.project.name);

      await page.getByLabel('Last name').fill('Fakename');
      await page.getByLabel('Mensa membership number').fill(FAKE_NUMBER);
      await page.getByRole('button', { name: 'Send my sign-up' }).click();
      await expect(page.locator('.lead')).toHaveText('Your sign-up is waiting for an officer to approve it.');
      if (big) await doubled(page);
      await expect(page.getByRole('note').filter({ hasText: NOTICE })).toBeVisible();
      await held(page, view.width);
      expect(await axe(page)).toEqual([]);
      await shot(page, `${name}-account-waiting`, info.project.name);
    });

    test(`the approvers' queue at ${name}: the checks in words, and no Approve on an unconfirmed invited sign-up`, async ({ page }, info) => {
      await page.setViewportSize(view);
      await page.goto('/');
      await signIn(page, 'approver');
      await page.goto('/officer-area/sign-ups');
      if (big) await doubled(page);
      const indy = page.locator('.signup-card').filter({ hasText: 'Indy Unconfirmed' });
      await expect(indy.getByRole('note')).toContainText('Cannot be approved yet');
      await expect(indy.getByRole('button', { name: 'Approve' })).toHaveCount(0);
      await expect(page.locator('.signup-card').filter({ hasText: 'Lou Unlisted' })).toContainText('not a known local group name');
      await held(page, view.width);
      expect(await axe(page)).toEqual([]);
      await indy.scrollIntoViewIfNeeded();
      await shot(page, `${name}-sign-ups`, info.project.name, !big);
    });
  }
});
