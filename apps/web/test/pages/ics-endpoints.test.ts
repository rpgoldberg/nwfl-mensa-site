import { describe, expect, it } from 'vitest';
import { GET as calendar, prerender as calendarPrerendered } from '../../src/pages/calendar.ics';
import { GET as events, prerender as eventsPrerendered } from '../../src/pages/events.ics';
import { GET as event, prerender as eventPrerendered } from '../../src/pages/events/[id].ics';

type Ctx = Parameters<typeof calendar>[0];

// No API_URL in the test environment: the bundled content, as on the canary.
const ctx = (path: string, extra: object = {}) => ({ request: new Request(`http://localhost:8080${path}`, { headers: { host: 'nwflorida.us' } }), site: new URL('https://nwflorida.us'), ...extra }) as unknown as Ctx;

describe('the calendar files, with no API', () => {
  it('/calendar.ics is an empty calendar, on request', async () => {
    expect(calendarPrerendered).toBe(false);
    const res = (await calendar(ctx('/calendar.ics'))) as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    expect(await res.text()).not.toContain('BEGIN:VEVENT');
  });

  it('/events.ics is the same feed under the new name, on request', async () => {
    expect(eventsPrerendered).toBe(false);
    const res = (await events(ctx('/events.ics'))) as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe('inline; filename="nwfl-mensa.ics"');
    expect(await res.text()).toMatch(/^BEGIN:VCALENDAR/);
  });

  it('one event is not found, on request', async () => {
    expect(eventPrerendered).toBe(false);
    const res = (await event(ctx('/x', { params: { id: '0b9c1f5e-4c1a-4d55-9a3e-2f7d8e6a1b20' } }))) as Response;
    expect(res.status).toBe(404);
  });
});
