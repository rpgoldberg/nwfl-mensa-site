// Old nwflorida.us URLs (R16), against the built server. Slugs that name a
// person are checked in the unit tests with made-up slugs, never here.
import http from 'node:http';
import { expect, test, type APIResponse } from '@playwright/test';
import { securityHeaders } from '../server/policy.mjs';
import { BACKEND_URL, IDP_ORIGIN } from './servers';

const SECURITY_HEADERS = securityHeaders({ formAction: [IDP_ORIGIN] });

const U = '/uploads/3/4/4/5/34456428';
const go = (res: APIResponse) => [res.status(), res.headers()['location']];

function expectPolicy(res: APIResponse): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(res.headers()[name.toLowerCase()], name).toBe(value);
}

test('an old page in each of its three forms goes to its new page', async ({ request }) => {
  for (const path of ['/join-mensa.html', '/join-mensa', '/mobile/join-mensa.html']) {
    const res = await request.get(path, { maxRedirects: 0 });
    expect(go(res), path).toEqual([301, '/join']);
    expectPolicy(res);
  }
  expect(go(await request.get('/officers-and-appointees.html', { maxRedirects: 0 }))).toEqual([301, '/officers']);
  expect(go(await request.get('/history.html', { maxRedirects: 0 }))).toEqual([301, '/about']);
  expect(go(await request.get('/policy-documents.html', { maxRedirects: 0 }))).toEqual([301, '/governance']);
  expect(go(await request.get('/pensa-mensa-current.html', { maxRedirects: 0 }))).toEqual([301, '/newsletter']);
});

test('a minutes page goes to its meeting on the minutes page', async ({ request }) => {
  expect(go(await request.get('/excom-meeting-minutes-11-nov-2022.html', { maxRedirects: 0 }))).toEqual([301, '/minutes#2022-11-11']);
  expect(go(await request.get('/excomm-jan-2026.html', { maxRedirects: 0 }))).toEqual([301, '/minutes#2026-01-24']);
  expect(go(await request.get('/excom-meeting-minutes.html', { maxRedirects: 0 }))).toEqual([301, '/minutes']);
});

test('the misspelled old slugs land too', async ({ request }) => {
  expect(go(await request.get('/2022-annual-finacial-report.html', { maxRedirects: 0 }))).toEqual([301, '/finances']);
  expect(go(await request.get('/ecomm-minutes-november-2024.html', { maxRedirects: 0 }))).toEqual([301, '/minutes#2024-11-16']);
  // Photo albums return in phase 2: a temporary redirect until then.
  expect(go(await request.get('/odd-peilcan-freeport.html', { maxRedirects: 0 }))).toEqual([302, '/']);
});

test('/login.php goes to the new sign-in', async ({ request }) => {
  expect(go(await request.get('/login.php', { maxRedirects: 0 }))).toEqual([302, '/sign-in']);
});

test('PHP, the Weebly machinery, the stats, the spam folder and the retired files answer 410 with the gone page', async ({ request }) => {
  for (const path of [
    '/w_api/APIHandler.php',
    '/log404.php',
    '/css/404.php',
    '/ajax/api/JsonRPC/CustomerAccounts/',
    '/stats/awstats.html',
    '/images/spider/aposta-casino.jpg',
    '/2015-mind-games.html',
    `${U}/membership_report_apr_2024.pdf`,
    `${U}/nwflorida_mensa_officers_october_as_of_1_feb_2023.pdf`,
    `${U}/published/any-photo.jpg`,
    '/uploads/3/1/5/8/3158475/old.pdf',
  ]) {
    const res = await request.get(path, { maxRedirects: 0 });
    expect(res.status(), path).toBe(410);
    expect(await res.text(), path).toContain('This page is no longer here');
    expectPolicy(res);
  }
  const post = await request.post('/w_api/APIHandler.php', { data: 'x', maxRedirects: 0 });
  expect(post.status()).toBe(410);
});

test('a kept old file goes to where its content now lives', async ({ request }) => {
  expect(go(await request.get(`${U}/march_2023_minutes.pdf`, { maxRedirects: 0 }))).toEqual([302, '/minutes#2023-03-12']);
  expect(go(await request.get(`${U}/bylaws_of_nwfl_mensa_2013_final.pdf`, { maxRedirects: 0 }))).toEqual([302, '/governance']);
});

test('a new page that shares an old slug is the new page, not a loop', async ({ request }) => {
  for (const path of ['/calendar', '/finances']) expect((await request.get(path, { maxRedirects: 0 })).status(), path).toBe(200);
});

test('robots.txt keeps this host out of search engines, and indexes the canonical host', async ({ request }) => {
  expect(await (await request.get('/robots.txt')).text()).toBe('User-agent: *\nDisallow: /\n');
  const canonical = await new Promise<string>((resolve, reject) => {
    http
      .get(`${BACKEND_URL}/robots.txt`, { headers: { host: 'nwflorida.us', 'x-forwarded-proto': 'https' } }, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve(body));
      })
      .on('error', reject);
  });
  expect(canonical).toContain('Sitemap: https://nwflorida.us/sitemap.xml');
  expect(canonical).toContain('Disallow: /sign-in');
});

test('sitemap.xml lists the public pages on the canonical host', async ({ request }) => {
  const res = await request.get('/sitemap.xml');
  expect(res.headers()['content-type']).toMatch(/^application\/xml/);
  const urls = [...(await res.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  expect(urls).toContain('https://nwflorida.us/calendar');
  expect(urls).not.toContain('https://nwflorida.us/sign-in');
});
