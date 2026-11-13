// EDITOR E7a: what the real-stack specs share: signing in at the test provider through the site's header,
// a fresh browser context per person, the long synthetic report, and the public's reads, each fetched
// whole with no session.
import { randomBytes } from 'node:crypto';
import { type Browser, type BrowserContext, type Page, expect, request } from '@playwright/test';
import { EDITOR_REAL } from './servers';

const AT_PROVIDER = new RegExp(`^${EDITOR_REAL.idpUrl.replaceAll('.', '\\.')}/`);
export const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const LIST = '/officer-area/news';
export const EDIT = new RegExp(`/officer-area/news/(${UUID})(\\?.*)?$`);

/** Signed in, from the site's own header, as one of the provider's made-up people (e2e/idp.mjs LOGINS). */
export async function signIn(page: Page, login: string): Promise<void> {
  await page.goto('/');
  await page.getByRole('banner').getByRole('link', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(AT_PROVIDER);
  await page.locator('input[name="login"]').fill(login);
  await page.locator('input[name="password"]').fill('any');
  await page.getByRole('button', { name: 'Sign-in' }).click();
  await expect(page.getByRole('banner').locator('[data-account="signed-in"]')).toBeAttached();
}

/** A person of their own: a fresh context, signed in (or the public, with no login). */
export async function person(browser: Browser, login?: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: EDITOR_REAL.siteUrl, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  if (login) await signIn(page, login);
  return { context, page };
}

export const textBox = (page: Page) => page.getByRole('textbox', { name: 'The text', exact: true });
export const saveTop = (page: Page) => page.getByRole('button', { name: 'Save draft' }).first();
export const problemsRegion = (page: Page) => page.getByRole('region', { name: 'Fix these before you send it for approval' });

/** An item's row in "Our news": the table's row where it is wide enough, else its card. */
export async function rowOf(page: Page, title: string) {
  const table = page.getByRole('table', { name: 'Our news' });
  if (await table.isVisible()) return table.getByRole('row').filter({ has: page.getByRole('rowheader', { name: title, exact: true }) });
  return page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}

/** A new item by kind and title, from "Our news"; on its edit page after. Returns its id. */
export async function createItem(page: Page, title: string, kind = 'News article'): Promise<string> {
  await page.goto(LIST);
  await page.getByRole('link', { name: 'Write something new' }).click();
  await page.getByRole('radio', { name: kind, exact: true }).check();
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill(title);
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page).toHaveURL(EDIT);
  return EDIT.exec(page.url())?.[1] as string;
}

/** Random, so it is in no seed and no page of the site. */
export const marker = (name: string) => `${name}${randomBytes(6).toString('hex')}`;

const WORDS = ['the', 'ledger', 'balance', 'quarter', 'receipts', 'dues', 'picnic', 'fund', 'rental', 'hall', 'postage', 'printing', 'reserve', 'interest', 'grant', 'raffle'];

/**
 * A long synthetic Treasurer's report: `lines` paragraphs (each a line, a blank line between), made-up
 * words only, with the public marker on line 1, the members span on line 3, and an http:// link on line
 * `httpLine` (odd). Returns the text and the line each thing is on.
 */
export function longReport(m: { pub: string; span: string }, targetBytes: number, httpLine = 7): { markup: string; httpLine: number } {
  const lines: string[] = [`Quarter report ${m.pub}: receipts and payments, in made-up numbers.`, '', `Members note :members[the reserve key is with ${m.span}] for the quarter.`, ''];
  let n = 0;
  const posted = () => Buffer.byteLength(lines.join('\n')) + lines.length - 1;
  while (posted() < targetBytes) {
    if (lines.length + 1 === httpLine) lines.push('The old ledger page is [here](http://club.example/old-ledger) for now.');
    else {
      const sentence = Array.from({ length: 24 }, (_, i) => WORDS[(n * 7 + i * 3) % WORDS.length]).join(' ');
      lines.push(`Line item ${n}: ${sentence}, $${(n * 13.37).toFixed(2)}.`);
    }
    lines.push('');
    n += 1;
  }
  // Trim back under the target, keeping the http line.
  while (posted() > targetBytes && lines.length > httpLine + 2) lines.splice(-2, 2);
  return { markup: lines.join('\n'), httpLine };
}

/** As posted from a text box: each line break CRLF. */
export const postedBytes = (text: string) => Buffer.byteLength(text) + (text.match(/\n/g)?.length ?? 0);

/** Every public read the site has where an item or event could show, fetched with no session. */
export const PUBLIC_PAGES = ['/', '/news', '/finances', '/minutes', '/officers', '/events', '/calendar.ics', '/events.ics', '/sitemap.xml', '/search?q='];

/** The public's view of each page: status and body, fetched with no session (a fresh request context). */
export async function publicBodies(extra: string[] = [], query = ''): Promise<Map<string, { status: number; body: string }>> {
  const ctx = await request.newContext({ baseURL: EDITOR_REAL.siteUrl, ignoreHTTPSErrors: true });
  try {
    const out = new Map<string, { status: number; body: string }>();
    for (const path of [...PUBLIC_PAGES.map((p) => (p === '/search?q=' ? `${p}${encodeURIComponent(query)}` : p)), ...extra]) {
      const res = await ctx.get(path);
      out.set(path, { status: res.status(), body: await res.text() });
    }
    return out;
  } finally {
    await ctx.dispose();
  }
}
