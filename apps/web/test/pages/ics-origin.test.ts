import { describe, expect, it, vi } from 'vitest';
import { type CalendarEvent, eventPath } from '../../src/lib/calendar';

const SERIES = '0b9c1f5e-4c1a-4d55-9a3e-2f7d8e6a1b20';
const day = new Date().toISOString().slice(0, 10);
const e: CalendarEvent = {
  id: `${SERIES}:${day}`,
  path: eventPath(`${SERIES}:${day}`),
  title: 'Lunch',
  date: day,
  start: '11:30',
  end: undefined,
  status: 'scheduled',
  statusNote: '',
  detail: '',
  url: undefined,
  venue: undefined,
  area: 'Okaloosa County',
  seriesId: SERIES,
  ownerOfficeId: '',
  source: 'submitted',
};

vi.mock('../../src/data', () => ({
  liveData: () => ({ events: () => Promise.resolve([e]), event: () => Promise.resolve({ event: e }) }),
}));

const { GET: calendar } = await import('../../src/pages/calendar.ics');
const { GET: events } = await import('../../src/pages/events.ics');
const { GET: one } = await import('../../src/pages/events/[id].ics');
type Ctx = Parameters<typeof calendar>[0];

const SITE = new URL('https://nwflorida.us');
const ctx = (host: string, extra: object = {}) =>
  ({ request: new Request('http://localhost:8080/x', { headers: { host } }), site: SITE, params: { id: e.path.split('/').pop() }, ...extra }) as unknown as Ctx;
const text = async (r: Response | Promise<Response>) => (await r).text();

describe.each([
  ['/calendar.ics', calendar],
  ['/events.ics', events],
  ['/events/[id].ics', one],
])('%s links each event back to a trusted origin', (_name, get) => {
  it('uses a trusted Host', async () => {
    const body = (await text(get(ctx('canary.nwflorida.us')) as Promise<Response>)).replace(/\r\n /g, '');
    expect(body).toContain(`https://canary.nwflorida.us${e.path}`);
    expect(body).not.toContain('localhost');
  });

  it('uses the canary host of the new domain', async () => {
    const body = (await text(get(ctx('canary.nwflmensa.us')) as Promise<Response>)).replace(/\r\n /g, '');
    expect(body).toContain(`https://canary.nwflmensa.us${e.path}`);
    expect(body).not.toContain('localhost');
  });

  it('falls back to the configured site for any other Host', async () => {
    const body = (await text(get(ctx('evil.example')) as Promise<Response>)).replace(/\r\n /g, '');
    expect(body).toContain(`https://nwflorida.us${e.path}`);
    expect(body).not.toMatch(/evil\.example|localhost/);
  });
});
