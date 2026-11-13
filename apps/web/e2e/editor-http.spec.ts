// EDITOR E3: the writer screens over plain HTTP, no browser: the public is sent to sign in from each
// one; a cross-site post is refused; the edit form takes a full 48 KiB text posted as multipart and
// refuses a body over its cap; and a save posted after the session ended gives the text back, from
// the post alone, reading nothing.
import { expect, test } from '@playwright/test';
import { SITE_URL } from './servers';
import { WORKFLOW } from './stand-in';

const ROUTES = ['/officer-area/news', '/officer-area/news/new', `/officer-area/news/${WORKFLOW.published.id}`, `/officer-area/news/${WORKFLOW.published.id}/preview`];

test('sends the public to sign in from every writer screen, and back after', async ({ request }) => {
  for (const path of ROUTES) {
    const res = await request.get(`${SITE_URL}${path}`, { maxRedirects: 0 });
    expect(res.status(), path).toBe(303);
    expect(res.headers()['location'], path).toBe(`/sign-in?return=${encodeURIComponent(path)}`);
  }
});

test('refuses a cross-site post to every writer screen', async ({ request }) => {
  for (const path of ROUTES.slice(1)) {
    const res = await request.post(`${SITE_URL}${path}`, { form: { title: 'x' }, headers: { Origin: 'https://evil.example' }, maxRedirects: 0 });
    expect(res.status(), path).toBe(403);
  }
});

test('gives the text of a save posted with no session back, read from the post alone, never cached', async ({ request }) => {
  const markup = `Line one <b>not markup</b>.\n${'é'.repeat(20_000)}`;
  const res = await request.post(`${SITE_URL}/officer-area/news/${WORKFLOW.published.id}`, {
    multipart: { title: 'My report', summary: 'One line', visibility: 'members', markup },
    headers: { Origin: SITE_URL },
    maxRedirects: 0,
  });
  expect(res.status()).toBe(200);
  expect(res.headers()['cache-control']).toContain('no-store');
  const html = await res.text();
  expect(html).toContain('Your sign-in timed out. Your text is still here.');
  expect(html).toContain('value="My report"');
  expect(html).toContain('&lt;b&gt;not markup&lt;/b&gt;');
  expect(html).not.toContain('<b>not markup</b>');
  // Nothing of the item itself: only what was posted.
  expect(html).not.toContain(WORKFLOW.published.title);
});

test('refuses a save with no session to an id that is not one, or a body that is not a form', async ({ request }) => {
  const bad = await request.post(`${SITE_URL}/officer-area/news/not-an-id`, { multipart: { title: 'x', markup: 'y' }, headers: { Origin: SITE_URL }, maxRedirects: 0 });
  expect(bad.status()).toBe(404);
  const json = await request.post(`${SITE_URL}/officer-area/news/${WORKFLOW.published.id}`, { data: { title: 'x' }, headers: { Origin: SITE_URL }, maxRedirects: 0 });
  expect(json.status()).toBe(415);
});

test('refuses an edit form over its cap before reading it', async ({ request }) => {
  const res = await request.post(`${SITE_URL}/officer-area/news/${WORKFLOW.published.id}`, {
    multipart: { title: 'x', summary: '', visibility: 'public', markup: 'a'.repeat(60 * 1024) },
    headers: { Origin: SITE_URL },
    maxRedirects: 0,
  });
  expect(res.status()).toBe(413);
});

// Round 2: the auto-save endpoint answers a script, never a page: no session is a plain 401; a
// cross-site post is refused before it; a GET finds nothing; none of it is cached.
test('answers an auto-save with no session 401, refuses a cross-site one, and a GET 405, never cached', async ({ request }) => {
  const path = `/officer-area/news/${WORKFLOW.published.id}/autosave`;
  const none = await request.post(`${SITE_URL}${path}`, { multipart: { title: 'x', markup: 'y', base: '1.000000000' }, headers: { Origin: SITE_URL }, maxRedirects: 0 });
  expect(none.status()).toBe(401);
  expect(none.headers()['cache-control']).toBe('private, no-store');
  expect(none.headers()['content-type']).toContain('application/json');
  expect(await none.json()).toEqual({ problem: 'sign-in' });
  const cross = await request.post(`${SITE_URL}${path}`, { multipart: { title: 'x' }, headers: { Origin: 'https://evil.example' }, maxRedirects: 0 });
  expect(cross.status()).toBe(403);
  const get = await request.get(`${SITE_URL}${path}`, { maxRedirects: 0 });
  expect(get.status()).toBe(405);
  expect(get.headers()['allow']).toBe('POST');
  expect(get.headers()['cache-control']).toBe('private, no-store');
  expect((await request.post(`${SITE_URL}/officer-area/news/not-an-id/autosave`, { multipart: { title: 'x' }, headers: { Origin: SITE_URL }, maxRedirects: 0 })).status()).toBe(404);
});
