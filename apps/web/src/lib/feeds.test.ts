import { describe, expect, it } from 'vitest';
import type { LiveData } from '../data/live';
import { ApiUnavailable } from './api/client';
import { type CalendarEvent, eventPath } from './calendar';
import { FEED_FUTURE_DAYS, FEED_PAST_DAYS, calendarFeed, eventFeed } from './feeds';

const SERIES = '0b9c1f5e-4c1a-4d55-9a3e-2f7d8e6a1b20';
const NOW = new Date('2026-10-23T14:00:00Z');
const origin = 'https://nwflorida.us';

const event = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: `${SERIES}:2026-11-04`,
  path: eventPath(`${SERIES}:2026-11-04`),
  title: 'Wednesday Lunchers',
  date: '2026-11-04',
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
  ...over,
});

const live = (over: Partial<LiveData> = {}): LiveData => ({
  events: () => Promise.resolve([]),
  event: () => Promise.resolve(undefined),
  offices: () => Promise.resolve([]),
  treasurerSummaries: () => Promise.resolve([]),
  presidentReport: () => Promise.resolve(undefined),
  announcements: () => Promise.resolve([]),
  file: () => Promise.resolve({ kind: 'not_found' }),
  ...over,
});

describe('calendarFeed (/calendar.ics)', () => {
  it('serves a month back and a year ahead of public events as text/calendar', async () => {
    const asked: string[][] = [];
    const res = await calendarFeed(
      live({
        events: (from, to) => {
          asked.push([from, to]);
          return Promise.resolve([event(), event({ id: 'other', title: 'Happy Hour' })]);
        },
      }),
      { now: NOW, origin },
    );
    expect(asked).toEqual([['2026-09-22', '2027-10-23']]);
    expect(FEED_PAST_DAYS + FEED_FUTURE_DAYS).toBeLessThanOrEqual(400);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe('inline; filename="nwfl-mensa.ics"');
    const text = await res.text();
    expect(text.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(text).toContain('SUMMARY:Happy Hour');
    expect(text).toContain('DTSTAMP:20261023T140000Z');
  });

  it('is an empty calendar with no API: the bundled content has no events', async () => {
    const res = await calendarFeed(undefined, { now: NOW, origin });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('BEGIN:VCALENDAR');
    expect(text).not.toContain('BEGIN:VEVENT');
  });

  it('says in plain words that the calendar is unavailable when the API is, with 503 and nothing stored', async () => {
    const res = await calendarFeed(live({ events: () => Promise.reject(new ApiUnavailable('ListOccurrences')) }), { now: NOW, origin });
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await res.text()).toBe('The calendar is temporarily unavailable. Please try again in a few minutes.\n');
  });
});

describe('eventFeed (one event as .ics)', () => {
  it('serves one public event, named for its title and date', async () => {
    const asked: string[] = [];
    const res = await eventFeed(
      live({
        event: (id) => {
          asked.push(id);
          return Promise.resolve({ event: event({ title: 'Wednesday Lunchers: “Café” night!' }), cadence: '', about: '', contact: undefined });
        },
      }),
      `${SERIES}_2026-11-04`,
      { now: NOW, origin },
    );
    expect(asked).toEqual([`${SERIES}:2026-11-04`]);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe('inline; filename="wednesday-lunchers-caf-night-2026-11-04.ics"');
    const text = await res.text();
    expect(text.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(text).toContain(`UID:${SERIES}:2026-11-04@nwflorida.us`);
  });

  it('is not found for a malformed id, with no API, or for an event that is not public', async () => {
    let calls = 0;
    const counting = live({
      event: () => {
        calls += 1;
        return Promise.resolve(undefined);
      },
    });
    for (const [l, param] of [[counting, 'nope'], [undefined, SERIES], [counting, SERIES]] as const) {
      const res = await eventFeed(l, param, { now: NOW, origin });
      expect(res.status, param).toBe(404);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.text()).toBe('We could not find that event.\n');
    }
    expect(calls).toBe(1);
  });

  it('is unavailable, 503, when the API is', async () => {
    const res = await eventFeed(live({ event: () => Promise.reject(new ApiUnavailable('GetOccurrence')) }), SERIES, { now: NOW, origin });
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
