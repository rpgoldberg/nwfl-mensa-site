// LINKS L4: the leaving page's direct choice in a real browser: a 303 to the approved URL, followed
// with no referrer. A browser route cannot answer a request a redirect made, so here the browser
// resolves every .example name to "not found" itself (Chromium's host resolver rules): the request
// to the other site is made, and seen, but no name is looked up and nothing leaves this machine.
// Chromium only: WebKit has no such switch (the http project checks the 303 for every engine).
import { expect, test, type Page, type Request } from '@playwright/test';
import { LINKS_COOKIE } from '../server/prefs.mjs';
import { setPrefs } from './prefs';
import { LINKS } from './stand-in';

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium host resolver rules only');
test.use({ launchOptions: { args: ['--host-resolver-rules=MAP *.example ~NOTFOUND'] } });

const out = (id: string) => `/out/${id}`;

/** The request the browser makes for the approved URL, once it is made. */
const requestFor = (page: Page, url: string): Promise<Request> => page.waitForEvent('request', (request) => request.url() === url);

test('goes straight to the approved URL, with no referrer, from a page of the site', async ({ page, context, baseURL }) => {
  await setPrefs(context, baseURL!, { links: 'direct' });
  await page.goto('/news');
  const asked = requestFor(page, LINKS.web.url);
  // As a reader's click does: the request for the leaving page carries this page as its referrer.
  await page.evaluate((path) => void (window.location.href = path), out(LINKS.web.id));
  const request = await asked;
  expect(request.redirectedFrom()?.url()).toBe(`${baseURL}${out(LINKS.web.id)}`);
  expect(await request.redirectedFrom()?.headerValue('referer')).toBe(`${baseURL}/news`);
  expect(await request.headerValue('referer')).toBeNull();
});

test('choosing it from the page saves it and stays; the next link goes straight there', async ({ page, context }) => {
  await page.goto(out(LINKS.web.id));
  await page.getByRole('radio', { name: 'Go straight to the other site' }).check();
  await page.getByRole('button', { name: 'Save my choice' }).click();
  await expect(page.getByText('Saved. Next time you follow a link to another site, we will take you straight there.')).toBeVisible();
  expect((await context.cookies()).find((c) => c.name === LINKS_COOKIE)).toMatchObject({ value: 'direct', secure: true, httpOnly: true, path: '/', sameSite: 'Lax' });
  const asked = requestFor(page, LINKS.web.url);
  await page.goto(out(LINKS.web.id)).catch(() => undefined);
  expect((await asked).redirectedFrom()?.url()).toMatch(new RegExp(`${out(LINKS.web.id)}$`));
});
