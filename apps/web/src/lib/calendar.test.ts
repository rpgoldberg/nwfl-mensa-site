import { describe, expect, it } from 'vitest';
import {
  type CalendarEvent,
  addDays,
  agendaDays,
  calendarRange,
  COMING_UP_DAYS,
  centralParts,
  chipStatus,
  eventIdFromParam,
  eventPath,
  formatTime,
  monthGrid,
  monthLabel,
  parseMonth,
  shiftMonth,
  toIcsEvent,
  todayCentral,
  whenText,
} from './calendar';

const SERIES = '0b9c1f5e-4c1a-4d55-9a3e-2f7d8e6a1b20';
const STORED = '7d3e2a10-5b6c-4f7d-8e9f-0a1b2c3d4e5f';

const event = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: `${SERIES}:2026-11-04`,
  path: eventPath(`${SERIES}:2026-11-04`),
  title: 'Wednesday Lunchers',
  date: '2026-11-04',
  start: '11:30',
  end: { date: '2026-11-04', time: '13:00' },
  status: 'scheduled',
  statusNote: '',
  detail: '',
  url: undefined,
  venue: { kind: 'business', name: 'Sample Bistro', address: '100 Example Way', city: 'Destin', url: undefined, accessibilityNote: '', hostOfficeId: '' },
  area: 'Okaloosa County',
  seriesId: SERIES,
  ownerOfficeId: '',
  source: 'submitted',
  ...over,
});

describe('Central time', () => {
  it('reads an instant as the Central date and wall-clock time, across both offsets', () => {
    expect(centralParts(new Date('2026-11-04T17:30:00Z'))).toEqual({ date: '2026-11-04', time: '11:30' }); // CST, UTC-6
    expect(centralParts(new Date('2026-07-04T16:30:00Z'))).toEqual({ date: '2026-07-04', time: '11:30' }); // CDT, UTC-5
    expect(centralParts(new Date('2026-11-05T04:30:00Z'))).toEqual({ date: '2026-11-04', time: '22:30' });
    expect(centralParts(new Date('2026-11-05T06:00:00Z'))).toEqual({ date: '2026-11-05', time: '00:00' });
  });

  it('gives today as the Central date, not the UTC one', () => {
    expect(todayCentral(new Date('2026-10-24T03:00:00Z'))).toBe('2026-10-23');
    expect(todayCentral(new Date('2026-10-24T06:00:00Z'))).toBe('2026-10-24');
  });

  it('adds days across months and years', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-25', 7)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('writes a time as people say it', () => {
    expect(formatTime('11:30')).toBe('11:30 am');
    expect(formatTime('00:15')).toBe('12:15 am');
    expect(formatTime('12:00')).toBe('12:00 noon');
    expect(formatTime('17:05')).toBe('5:05 pm');
  });

  it('says when an event is, in words', () => {
    expect(whenText(event())).toBe('Wednesday, 4 November 2026, 11:30 am to 1:00 pm');
    expect(whenText(event({ end: undefined }))).toBe('Wednesday, 4 November 2026, from 11:30 am');
    expect(whenText(event({ start: undefined, end: undefined }))).toBe('Wednesday, 4 November 2026, time to be decided');
    expect(whenText(event({ end: { date: '2026-11-05', time: '01:00' } }))).toBe('Wednesday, 4 November 2026, 11:30 am to Thursday, 5 November 2026, 1:00 am');
  });
});

describe('months', () => {
  it('reads YYYY-MM, and nothing else', () => {
    expect(parseMonth('2026-11')).toBe('2026-11');
    for (const bad of ['2026-13', '2026-00', '2026-1', '26-11', '2026-11-01', '', 'x', '1899-12', '2201-01']) expect(parseMonth(bad), bad).toBeUndefined();
    expect(parseMonth(null)).toBeUndefined();
  });

  it('steps a month back and forward, across the year', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-06', 1)).toBe('2026-07');
  });

  it('names a month in words', () => {
    expect(monthLabel('2026-11')).toBe('November 2026');
  });

  it('lays a month out in whole weeks from Sunday, with the days outside the month marked, and each day its events', () => {
    const weeks = monthGrid('2026-11', [event(), event({ id: 'b', date: '2026-11-04', start: '17:00' }), event({ id: 'c', date: '2026-11-30' }), event({ id: 'd', date: '2026-12-01' })], '2026-11-10');
    expect(weeks).toHaveLength(5);
    for (const week of weeks) expect(week).toHaveLength(7);
    // 1 November 2026 is a Sunday; 30 November a Monday.
    expect(weeks[0]![0]).toMatchObject({ date: '2026-11-01', inMonth: true, today: false });
    expect(weeks[0]![3]!.events.map((e) => e.id)).toEqual([`${SERIES}:2026-11-04`, 'b']);
    expect(weeks[1]![2]).toMatchObject({ date: '2026-11-10', today: true });
    expect(weeks[4]![1]!.events.map((e) => e.id)).toEqual(['c']);
    expect(weeks[4]![2]).toMatchObject({ date: '2026-12-01', inMonth: false, events: [] });
    expect(weeks[4]![6]).toMatchObject({ date: '2026-12-05', inMonth: false });
  });

  it('starts a month that does not begin on a Sunday with the end of the month before', () => {
    const weeks = monthGrid('2026-10', [], '2026-10-23');
    expect(weeks[0]![0]).toMatchObject({ date: '2026-09-27', inMonth: false });
    expect(weeks[0]![4]).toMatchObject({ date: '2026-10-01', inMonth: true });
    expect(weeks.at(-1)!.at(-1)).toMatchObject({ date: '2026-10-31', inMonth: true });
  });
});

describe('calendarRange', () => {
  it('shows this month in the grid and what is coming up in the list, read in one call', () => {
    expect(COMING_UP_DAYS).toBe(56);
    expect(calendarRange(null, '2026-10-23')).toEqual({
      month: '2026-10',
      current: true,
      list: { from: '2026-10-23', to: '2026-12-18' },
      read: { from: '2026-10-01', to: '2026-12-18' },
    });
  });

  it('shows a chosen month whole, in the grid and the list', () => {
    expect(calendarRange('2027-02', '2026-10-23')).toEqual({
      month: '2027-02',
      current: false,
      list: { from: '2027-02-01', to: '2027-02-28' },
      read: { from: '2027-02-01', to: '2027-02-28' },
    });
  });

  it('refuses a month it cannot read', () => {
    expect(calendarRange('2026-13', '2026-10-23')).toBeUndefined();
    expect(calendarRange('', '2026-10-23')).toBeUndefined();
  });
});

describe('agendaDays', () => {
  it('groups events by day in date order, keeping each day in time order', () => {
    const days = agendaDays([event({ id: 'late', date: '2026-11-04', start: '17:00' }), event({ id: 'other', date: '2026-11-07' }), event({ id: 'early', date: '2026-11-04', start: '09:00' }), event({ id: 'untimed', date: '2026-11-04', start: undefined })]);
    expect(days.map((d) => d.date)).toEqual(['2026-11-04', '2026-11-07']);
    expect(days[0]!.events.map((e) => e.id)).toEqual(['untimed', 'early', 'late']);
  });
});

describe('event paths', () => {
  it('turns an API id into a page path and back: a stored event by its id, a series date by series and date', () => {
    expect(eventPath(STORED)).toBe(`/events/${STORED}`);
    expect(eventPath(`${SERIES}:2026-11-04`)).toBe(`/events/${SERIES}_2026-11-04`);
    expect(eventIdFromParam(STORED)).toBe(STORED);
    expect(eventIdFromParam(`${SERIES}_2026-11-04`)).toBe(`${SERIES}:2026-11-04`);
  });

  it('refuses anything else before it reaches the API', () => {
    for (const bad of [undefined, '', 'x', `${SERIES}_2026-13-01`, `${SERIES}_2026-02-30`, `${SERIES}:2026-11-04`, `${SERIES.toUpperCase()}`, `${SERIES}_2026-11-04_x`, `../${SERIES}`, `${SERIES}.ics`]) {
      expect(eventIdFromParam(bad), String(bad)).toBeUndefined();
    }
  });
});

describe('toIcsEvent', () => {
  const origin = 'https://nwflorida.us';

  it('carries the times, place, status and a link back to the event page', () => {
    expect(toIcsEvent(event({ detail: 'At the long table.', url: 'https://example.org/menu' }), origin)).toEqual({
      uid: `${SERIES}:2026-11-04@nwflorida.us`,
      start: { date: '2026-11-04', time: '11:30' },
      end: { date: '2026-11-04', time: '13:00' },
      summary: 'Wednesday Lunchers',
      location: 'Sample Bistro, 100 Example Way, Destin',
      description: `At the long table.\nMore: https://example.org/menu\nOn our calendar: ${origin}/events/${SERIES}_2026-11-04`,
      url: `${origin}/events/${SERIES}_2026-11-04`,
      status: 'CONFIRMED',
    });
  });

  it('maps each status, with its note', () => {
    expect(toIcsEvent(event({ status: 'tentative' }), origin).status).toBe('TENTATIVE');
    expect(toIcsEvent(event({ status: 'cancelled', statusNote: 'Happy Thanksgiving' }), origin)).toMatchObject({ status: 'CANCELLED', description: expect.stringMatching(/^Happy Thanksgiving\n/) });
    expect(toIcsEvent(event({ status: 'moved', statusNote: 'Moved to the 14th' }), origin)).toMatchObject({ status: 'CONFIRMED', description: expect.stringMatching(/^Moved to the 14th\n/) });
  });

  it("names a member's home by its area only, and an online meeting as online", () => {
    expect(toIcsEvent(event({ venue: { kind: 'home', name: "A member's home", address: '', city: '', url: undefined, accessibilityNote: '', hostOfficeId: 'o1' } }), origin).location).toBe("A member's home, Okaloosa County");
    expect(toIcsEvent(event({ area: 'Online', venue: { kind: 'virtual', name: 'Video call', address: '', city: '', url: 'https://example.org/meet', accessibilityNote: '', hostOfficeId: '' } }), origin).location).toBe('Online: Video call');
    expect(toIcsEvent(event({ venue: undefined }), origin).location).toBe('Okaloosa County');
  });

  it('leaves out an end it does not know, and a time not yet set', () => {
    expect(toIcsEvent(event({ start: undefined, end: undefined }), origin)).toMatchObject({ start: { date: '2026-11-04', time: undefined }, end: undefined });
  });
});

describe('chipStatus', () => {
  // 2026-11-04 is CST (UTC-6): 18:00Z is 12:00 Central.
  const noon = new Date('2026-11-04T18:00:00Z');
  const ends = (date: string, time: string) => event({ date, end: { date, time } });

  it('calls a scheduled occurrence whose end has passed "past"', () => {
    expect(chipStatus(ends('2026-11-04', '11:59'), noon)).toBe('past');
    expect(chipStatus(ends('2026-10-03', '13:00'), noon)).toBe('past');
  });

  it('keeps it scheduled while it runs, at its end minute, and when it is ahead', () => {
    expect(chipStatus(ends('2026-11-04', '12:00'), noon)).toBe('scheduled');
    expect(chipStatus(ends('2026-11-04', '13:00'), noon)).toBe('scheduled');
    expect(chipStatus(ends('2026-11-05', '09:00'), noon)).toBe('scheduled');
  });

  it('uses the start when there is no end, and the whole day when there is no time', () => {
    expect(chipStatus(event({ end: undefined, start: '11:30' }), noon)).toBe('past');
    expect(chipStatus(event({ end: undefined, start: '12:30' }), noon)).toBe('scheduled');
    expect(chipStatus(event({ end: undefined, start: undefined }), noon)).toBe('scheduled');
    expect(chipStatus(event({ end: undefined, start: undefined, date: '2026-11-03' }), noon)).toBe('past');
  });

  it('judges the Central clock, not UTC', () => {
    // 2026-11-05T01:00Z is still 19:00 on 11-04 in Central.
    expect(chipStatus(ends('2026-11-04', '20:00'), new Date('2026-11-05T01:00:00Z'))).toBe('scheduled');
  });

  it('treats tentative like scheduled, and leaves moved and cancelled as they are', () => {
    expect(chipStatus({ ...ends('2026-10-03', '13:00'), status: 'tentative' }, noon)).toBe('past');
    expect(chipStatus({ ...ends('2026-10-03', '13:00'), status: 'moved' }, noon)).toBe('moved');
    expect(chipStatus({ ...ends('2026-10-03', '13:00'), status: 'cancelled' }, noon)).toBe('cancelled');
  });
});
