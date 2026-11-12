// QUEUE-C, through the browser: the approvers' queue says the same as before on a much shorter page.
// Each sign-up is a compact card: its name, its email under it, and what it typed, how it came and
// its day as label and value pairs (a real dl) in a grid, two to a row on a phone and up to four on a
// desktop, never cut short; the membership check a whole sentence across the card; the box to tick
// and the buttons on one row where they fit. The rejected sign-ups use the same grid. Measured with
// the stand-in's 7 sign-ups and 4 rejections (e2e/stand-in.ts), at 1280 and 390 px, with reflow at
// 320 px and the largest text, and axe in every theme. Run with the reopen tests, a rejection another
// project reopened is gone, so a ceiling only gets easier. Every person and number here is made up.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { SIZES } from '../server/prefs.mjs';
import { THEMES, setPrefs } from './prefs';
import { signIn } from './signin';
import { EARLIER_CLAIM, REJECTED, SIGNUP_QUEUE, VET_CONFIRMS } from './stand-in';

const QUEUE = '/officer-area/sign-ups';
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'wcag2aaa', 'best-practice'];
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
/**
 * The page's full height with these fixtures before QUEUE-C (Chromium, light theme, one label over
 * each value): 8364 px at 1280 and 9576 px at 390. The goal is at least 40 % and 30 % shorter.
 */
const CEILING = { desktop: Math.floor(8364 * 0.6), phone: Math.floor(9576 * 0.7) };
const PENDING_LABELS = ['First name', 'Last name', 'Membership number', 'How they came', 'Signed up', 'Membership check'];
const REJECTED_LABELS = ['First name', 'Last name', 'Membership number', 'Rejected on', 'Membership check'];

interface Pair { tag: string; children: string[]; dt: string; dd: string; top: number; bottom: number; left: number; right: number; clipped: boolean; cut: boolean }

async function openQueue(page: Page): Promise<void> {
  await page.goto('/');
  await signIn(page, 'approver');
  await page.goto(QUEUE);
  await page.evaluate(() => document.fonts.ready);
}

/** Each child of a grid: what it holds and where it sits; a value is cut if it overflows its box or is set to an ellipsis. */
function pairsOf(dl: Locator): Promise<{ width: number; left: number; right: number; pairs: Pair[] }> {
  return dl.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const pairs = [...el.children].map((div) => {
      const r = div.getBoundingClientRect();
      const dd = div.querySelector<HTMLElement>(':scope > dd');
      const style = dd ? getComputedStyle(dd) : undefined;
      return {
        tag: div.tagName,
        children: [...div.children].map((c) => c.tagName),
        dt: div.querySelector(':scope > dt')?.textContent ?? '',
        dd: dd?.textContent ?? '',
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        left: Math.round(r.left),
        right: Math.round(r.right),
        clipped: dd ? dd.scrollWidth > dd.clientWidth + 1 : true,
        cut: style ? style.textOverflow === 'ellipsis' || style.whiteSpace === 'nowrap' || Number(style.webkitLineClamp) > 0 : true,
      };
    });
    return { width: Math.round(box.width), left: Math.round(box.left), right: Math.round(box.right), pairs };
  });
}

/** How many pairs share the grid's first row. */
const firstRow = (pairs: Pair[]) => pairs.filter((p) => p.top === pairs[0]!.top).length;

/** The pairs in the order they are seen (row by row, left to right) are the order they are read. */
function readsInOrder(pairs: Pair[]): void {
  const seen = [...pairs].sort((a, b) => a.top - b.top || a.left - b.left).map((p) => p.dt);
  expect(seen).toEqual(pairs.map((p) => p.dt));
}

/** Every pair is a div of one dt and one dd, none cut short, and the check spans the grid. */
function wellFormed(grid: Awaited<ReturnType<typeof pairsOf>>, labels: string[]): void {
  expect(grid.pairs.map((p) => p.dt)).toEqual(labels);
  for (const p of grid.pairs) {
    expect(p.tag, p.dt).toBe('DIV');
    expect(p.children, p.dt).toEqual(['DT', 'DD']);
    expect(p.dd.trim(), p.dt).not.toBe('');
    expect(p.clipped, `${p.dt} overflows`).toBe(false);
    expect(p.cut, `${p.dt} is cut short`).toBe(false);
    expect(p.left, p.dt).toBeGreaterThanOrEqual(grid.left);
    expect(p.right, p.dt).toBeLessThanOrEqual(grid.right);
  }
  const check = grid.pairs.at(-1)!;
  expect(check.dt).toBe('Membership check');
  expect(check.right - check.left).toBeGreaterThanOrEqual(grid.width - 1);
  readsInOrder(grid.pairs);
}

const signupCard = (page: Page, name: string) => page.locator('.signup-card').filter({ has: page.getByRole('heading', { level: 2, name, exact: true }) });

test.describe('QUEUE-C: a compact approvers\' queue', () => {
  test('each sign-up is a card of its name, its email under it, and its details as label and value pairs', async ({ page }) => {
    await openQueue(page);
    for (const s of SIGNUP_QUEUE) {
      const card = signupCard(page, s.name);
      await expect(card.locator('h2 + p')).toHaveText(s.email);
      const grid = card.locator('dl.facts--grid').first();
      await expect(grid.locator(':scope > div > dt')).toHaveText(PENDING_LABELS);
      await expect(grid.locator(':scope > div').filter({ has: page.getByText('Membership check', { exact: true }) }).locator('dd')).toHaveText(s.check);
      await expect(grid.locator(':scope > div').filter({ has: page.getByText('How they came', { exact: true }) }).locator('dd')).toHaveText(s.route);
      await expect(card.locator('dt', { hasText: 'Email' })).toHaveCount(0);
    }
    // The earlier claim's typed details use the same grid.
    const earlier = EARLIER_CLAIM['Drew Secondclaim'];
    const claim = signupCard(page, 'Drew Secondclaim').locator('.earlier-claim dl.facts--grid');
    await expect(claim.locator(':scope > div > dt')).toHaveText(['First name', 'Last name', 'Membership number']);
    await expect(claim.locator(':scope > div > dd')).toHaveText([earlier.first, earlier.last, earlier.number]);
    // The rejected sign-ups too, every field they show kept: by the one no test reopens (the other
    // projects' runs reopen their own, for everyone, e2e/reopen.spec.ts), and the same labels on each.
    const r = REJECTED.kept;
    const card = page.locator('.rejected-card').filter({ has: page.getByRole('heading', { level: 3, name: r.name, exact: true }) });
    await expect(card.locator('h3 + p')).toHaveText(r.email);
    await expect(card.locator('dl.facts--grid > div > dd')).toHaveText([r.first, r.last, r.number, r.rejected, r.check]);
    for (const each of await page.locator('.rejected-card').all()) {
      await expect(each.locator('h3 + p')).toHaveText(/@example\.org$/);
      await expect(each.locator('dl.facts--grid > div > dt')).toHaveText(REJECTED_LABELS);
    }
  });

  for (const [width, view, perRow, ceiling] of [
    ['1280', DESKTOP, [3, 4], CEILING.desktop],
    ['390', PHONE, [2, 2], CEILING.phone],
  ] as const) {
    test(`at ${width} px: ${perRow[0] === perRow[1] ? perRow[0] : `${perRow[0]} to ${perRow[1]}`} pairs to a row, none cut short, read in the order seen, and the page at most ${ceiling} px tall`, async ({ page }) => {
      await page.setViewportSize(view);
      await openQueue(page);
      for (const s of SIGNUP_QUEUE) {
        const grid = await pairsOf(signupCard(page, s.name).locator('dl.facts--grid').first());
        wellFormed(grid, PENDING_LABELS);
        const row = firstRow(grid.pairs);
        expect(row, s.name).toBeGreaterThanOrEqual(perRow[0]);
        expect(row, s.name).toBeLessThanOrEqual(perRow[1]);
      }
      for (const card of await page.locator('.rejected-card').all()) {
        const grid = await pairsOf(card.locator('dl.facts--grid'));
        wellFormed(grid, REJECTED_LABELS);
        expect(firstRow(grid.pairs)).toBeGreaterThanOrEqual(perRow[0]);
      }
      const height = await page.evaluate(() => document.documentElement.scrollHeight);
      test.info().annotations.push({ type: 'height', description: `${width}: ${height}` });
      expect(height).toBeLessThanOrEqual(ceiling);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    });
  }

  test('at 1280 px the box to tick sits on one row with Approve and Reject, read before them', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openQueue(page);
    for (const [name, label] of Object.entries(VET_CONFIRMS)) {
      const card = signupCard(page, name);
      const box = (await card.getByRole('checkbox', { name: label, exact: true }).boundingBox())!;
      for (const button of ['Approve', 'Reject']) {
        const b = (await card.getByRole('button', { name: button }).boundingBox())!;
        expect(box.y + box.height / 2, `${name} ${button}`).toBeGreaterThan(b.y);
        expect(box.y + box.height / 2, `${name} ${button}`).toBeLessThan(b.y + b.height);
        expect(box.x, `${name} ${button}`).toBeLessThan(b.x);
        expect(b.height).toBeGreaterThanOrEqual(48);
      }
    }
  });

  for (const [what, view, size] of [
    ['a 320 px phone at the largest text', { width: 320, height: 700 }, SIZES.at(-1)!],
    ['200 % text (640 px)', { width: 640, height: 450 }, 100],
  ] as const) {
    test(`reflows on ${what}: no sideways scroll, no value cut short, buttons whole and 48 px`, async ({ page, context, baseURL }) => {
      await page.setViewportSize(view);
      await setPrefs(context, baseURL!, { size });
      await openQueue(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      for (const dl of await page.locator('dl.facts--grid').all()) {
        const grid = await pairsOf(dl);
        for (const p of grid.pairs) {
          expect(p.clipped, `${p.dt} overflows`).toBe(false);
          expect(p.right, p.dt).toBeLessThanOrEqual(view.width);
        }
        readsInOrder(grid.pairs);
      }
      for (const button of await page.getByRole('main').getByRole('button').all()) {
        const b = (await button.boundingBox())!;
        expect(b.x + b.width).toBeLessThanOrEqual(view.width);
        expect(b.height).toBeGreaterThanOrEqual(48);
      }
    });
  }

  for (const theme of THEMES) {
    test(`axe finds nothing in the ${theme} theme`, async ({ page, context, baseURL }) => {
      await setPrefs(context, baseURL!, { theme });
      await openQueue(page);
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
    });
  }
});
