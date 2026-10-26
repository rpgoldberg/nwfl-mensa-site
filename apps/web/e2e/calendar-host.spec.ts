// The calendar buttons and the feed's links name the host the reader asked for,
// when it is one of ours, as cloudflared sends it: the original Host, plus
// X-Forwarded-Proto, and no X-Forwarded-Host. Any other Host gets the
// configured site. These talk to the server directly to choose the Host.
import http from 'node:http';
import { expect, test } from '@playwright/test';
import { BACKEND_URL } from './servers';

function asked(path: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BACKEND_URL}${path}`, { headers: { 'X-Forwarded-Proto': 'https', ...headers } });
    req.on('response', (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.end();
  });
}

const hrefs = (html: string): string[] => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);
const feeds = (html: string) => hrefs(html).filter((h) => h.includes('calendar.ics'));
const webcal = (host: string) => `webcal://${host}/calendar.ics`;
const google = (host: string) => `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcal(host))}`;

test.describe('Events calendar buttons', () => {
  for (const host of ['canary.nwflorida.us', 'canary.nwflmensa.us', 'nwflorida.us', 'www.nwflorida.us', 'nwflmensa.us', 'www.nwflmensa.us']) {
    test(`point at ${host} when that is the Host asked for`, async () => {
      expect(feeds(await asked('/events', { Host: host }))).toEqual(expect.arrayContaining([webcal(host), google(host)]));
    });
  }

  test('an X-Forwarded-Host as well changes nothing', async () => {
    const html = await asked('/events', { Host: 'canary.nwflorida.us', 'X-Forwarded-Host': 'evil.example' });
    expect(feeds(html)).toEqual(expect.arrayContaining([webcal('canary.nwflorida.us'), google('canary.nwflorida.us')]));
    expect(html).not.toContain('evil.example');
  });

  for (const spoof of [{ Host: 'evil.example' }, { Host: 'evil.example', 'X-Forwarded-Host': 'canary.nwflorida.us' }, { Host: 'nwflorida.us.evil.example' }]) {
    test(`fall back to the configured site for ${JSON.stringify(spoof)}`, async () => {
      const html = await asked('/events', spoof);
      expect(feeds(html)).toEqual(expect.arrayContaining([webcal('nwflorida.us'), google('nwflorida.us')]));
      expect(html).not.toMatch(/evil\.example|localhost|127\.0\.0\.1/);
    });
  }
});

test.describe('the feed', () => {
  test('links each event back to the Host asked for, if ours', async () => {
    const body = (await asked('/calendar.ics', { Host: 'canary.nwflorida.us' })).replace(/\r\n /g, '');
    expect(body).toMatch(/https:\/\/canary\.nwflorida\.us\/events\//);
    expect(body).not.toMatch(/localhost|127\.0\.0\.1/);
  });

  test('links each event back to canary.nwflmensa.us when that is the Host', async () => {
    const body = (await asked('/calendar.ics', { Host: 'canary.nwflmensa.us' })).replace(/\r\n /g, '');
    expect(body).toMatch(/https:\/\/canary\.nwflmensa\.us\/events\//);
    expect(body).not.toMatch(/localhost|127\.0\.0\.1/);
  });

  test('links to the configured site for any other Host', async () => {
    const body = (await asked('/calendar.ics', { Host: 'evil.example' })).replace(/\r\n /g, '');
    expect(body).toMatch(/https:\/\/nwflorida\.us\/events\//);
    expect(body).not.toMatch(/evil\.example|localhost|127\.0\.0\.1/);
  });
});
