import { describe, expect, it } from 'vitest';
import { GET as calendar, prerender as calendarPrerendered } from '../../src/pages/calendar.ics';
import { GET as events, prerender as eventsPrerendered } from '../../src/pages/events.ics';
import { GET as event, prerender as eventPrerendered } from '../../src/pages/events/[id].ics';

type Ctx = Parameters<typeof calendar>[0];

// No API_URL in the test environment: the bundled content, as on the canary.
describe('the calendar files, with no API', () => {
  it('/calendar.ics is an empty calendar, on request', async () => {
    expect(calendarPrerendered).toBe(false);
    const res = (await calendar({ url: new URL('https://nwflorida.us/calendar.ics') } as unknown as Ctx)) as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    expect(await res.text()).not.toContain('BEGIN:VEVENT');
  });

  it('/events.ics is the same feed under the new name, on request', async () => {
    expect(eventsPrerendered).toBe(false);
    const res = (await events({ url: new URL('https://nwflorida.us/events.ics') } as unknown as Ctx)) as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe('inline; filename="nwfl-mensa.ics"');
    expect(await res.text()).toMatch(/^BEGIN:VCALENDAR/);
  });

  it('one event is not found, on request', async () => {
    expect(eventPrerendered).toBe(false);
    const res = (await event({ params: { id: '0b9c1f5e-4c1a-4d55-9a3e-2f7d8e6a1b20' }, url: new URL('https://nwflorida.us/x') } as unknown as Ctx)) as Response;
    expect(res.status).toBe(404);
  });
});
