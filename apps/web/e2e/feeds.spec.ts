// The live pages over plain HTTP (W3): the calendar files (RFC 5545), public
// events only in every view and feed, the cache rule by audience, and the
// site whose API never answers.
import http from 'node:http';
import { expect, test } from '@playwright/test';
import { SESSION_COOKIE } from '../server/policy.mjs';
import { DOWN_URL } from './servers';
import { BOARD_GAMES, CANARIES, MEMBERS_SERIES, centralToday, monthAfter, nextSunday } from './stand-in';

const PUBLIC_CACHE = 'public, max-age=60, stale-while-revalidate=60';
const octets = (line: string) => Buffer.byteLength(line, 'utf8');
const unfold = (text: string) => text.replace(/\r\n /g, '');

test('/calendar.ics is the public calendar as RFC 5545: CRLF lines folded at 75 octets, America/Chicago, a UID and DTSTAMP on each event', async ({ request }) => {
  const res = await request.get('/calendar.ics');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('text/calendar; charset=utf-8');
  expect(res.headers()['cache-control']).toBe(PUBLIC_CACHE);
  const text = await res.text();
  expect(text.endsWith('\r\n')).toBe(true);
  expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  for (const line of text.split('\r\n')) expect(octets(line), line).toBeLessThanOrEqual(75);
  const lines = unfold(text).split('\r\n');
  expect(lines[0]).toBe('BEGIN:VCALENDAR');
  expect(lines).toContain('TZID:America/Chicago');
  const events = unfold(text).split('BEGIN:VEVENT').slice(1);
  expect(events.length).toBeGreaterThan(10);
  const uids = events.map((e) => /\r\nUID:([^\r]+)/.exec(e)?.[1]);
  expect(new Set(uids).size).toBe(events.length);
  for (const e of events) {
    expect(e).toMatch(/\r\nDTSTAMP:\d{8}T\d{6}Z\r\n/);
    expect(e).toMatch(/\r\nDTSTART(;TZID=America\/Chicago:\d{8}T\d{6}|;VALUE=DATE:\d{8})\r\n/);
  }
  // The cancelled lunch stays listed, marked so.
  expect(events.some((e) => e.includes('STATUS:CANCELLED') && e.includes('SUMMARY:Cancelled: Wednesday Lunchers'))).toBe(true);
  // Commas and semicolons a person typed are escaped.
  expect(text).toContain('DESCRIPTION:Bring a friend\\, a book\\; and an appetite.');
});

test("one event's .ics holds that event alone; a member's home by its area only", async ({ request }) => {
  const res = await request.get(`/calendar/event/${BOARD_GAMES}.ics`);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('text/calendar; charset=utf-8');
  expect(res.headers()['content-disposition']).toMatch(/^inline; filename="board-games-afternoon-\d{4}-\d{2}-\d{2}\.ics"$/);
  const text = unfold(await res.text());
  expect(text.match(/BEGIN:VEVENT/g)).toHaveLength(1);
  expect(text).toContain(`UID:${BOARD_GAMES}@nwflorida.us`);
  expect(text).toContain("LOCATION:A member's home\\, Okaloosa County\r\n");
});

test('a members event or one with no status never appears, in any view or feed, and its own page and file are not found', async ({ request }) => {
  const month = centralToday().slice(0, 7);
  for (const path of ['/', '/calendar', `/calendar?month=${month}`, `/calendar?month=${monthAfter(month)}`, '/calendar.ics']) {
    const body = await (await request.get(path)).text();
    for (const canary of Object.values(CANARIES)) {
      expect(body, path).not.toContain(canary.title);
      expect(body, path).not.toContain(canary.id);
    }
    expect(body, path).not.toContain(MEMBERS_SERIES);
    expect(body, path).not.toMatch(/members event/i);
  }
  for (const id of [CANARIES.membersInFull.id, CANARIES.noStatus.id, `${MEMBERS_SERIES}_${nextSunday()}`]) {
    for (const path of [`/calendar/event/${id}`, `/calendar/event/${id}.ics`]) {
      const res = await request.get(path);
      expect(res.status(), path).toBe(404);
      expect(res.headers()['cache-control'], path).toBe('no-store');
    }
  }
});

test('cache by audience: public pages briefly and stale-while-revalidate, a session never, an error never', async ({ request }) => {
  const live = ['/', '/calendar', '/officers', '/finances', '/calendar.ics', `/calendar/event/${BOARD_GAMES}`, `/calendar/event/${BOARD_GAMES}.ics`];
  for (const path of live) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(200);
    expect(res.headers()['cache-control'], path).toBe(PUBLIC_CACHE);
    expect(res.headers()['vary'], path).toBe('Cookie');
    const signedIn = await request.get(path, { headers: { cookie: `${SESSION_COOKIE}=x` } });
    expect(signedIn.headers()['cache-control'], path).toBe('private, no-store');
  }
  for (const path of ['/no-such-page', '/calendar?month=2026-13', '/calendar/event/not-an-id']) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(404);
    expect(res.headers()['cache-control'], path).toBe('no-store');
  }
});

/** A plain GET straight to the site whose API never answers. */
function getDown(path: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    http
      .get(`${DOWN_URL}${path}`, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body, ms: Date.now() - started }));
      })
      .on('error', reject);
  });
}

test('when the API does not answer, each live page says so in plain words, with 503 and no-store, and no error detail', async () => {
  for (const path of ['/', '/calendar', '/officers', '/finances', `/calendar/event/${BOARD_GAMES}`]) {
    const res = await getDown(path);
    expect(res.status, path).toBe(503);
    expect(res.headers['cache-control'], path).toBe('no-store');
    expect(res.ms, `${path} waited for the timeout`).toBeGreaterThanOrEqual(900);
    expect(res.body, path).toMatch(/is temporarily unavailable\.<\/b> Please try again in a few minutes\./);
    expect(res.body, path).not.toMatch(/Error|ConnectError|deadline|at \S+:\d+|node:/);
  }
  const feed = await getDown('/calendar.ics');
  expect(feed.status).toBe(503);
  expect(feed.headers['cache-control']).toBe('no-store');
  expect(feed.body).toBe('The calendar is temporarily unavailable. Please try again in a few minutes.\n');
  // The pages that never read the API are untouched.
  for (const path of ['/about', '/join', '/newsletter']) expect((await getDown(path)).status, path).toBe(200);
});
