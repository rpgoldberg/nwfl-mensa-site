import { describe, expect, it } from 'vitest';
import { type CalendarEvent, type EventCategoryName, eventPath } from './calendar';
import {
  FEED_VERSION,
  KIND_LABELS,
  calHref,
  calPeriod,
  cardPlace,
  dayIndicator,
  dayLabel,
  dayTile,
  eventKind,
  feedLinks,
  googleEventUrl,
  parseCalState,
  ribbonDays,
  shortDay,
  tileLabel,
  weekDays,
} from './event-views';

const SERIES = '0b9c1f5e-4c1a-4d55-9a3e-2f7d8e6a1b20';
const TODAY = '2026-11-10'; // a Tuesday

const event = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: `${SERIES}:2026-11-11`,
  path: eventPath(`${SERIES}:2026-11-11`),
  title: 'Wednesday Lunchers',
  date: '2026-11-11',
  start: '11:30',
  end: { date: '2026-11-11', time: '13:00' },
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

describe('eventKind: the icon an event gets, from its series category only', () => {
  const cases: [EventCategoryName | undefined, string][] = [
    ['lunch', 'meal'],
    ['dinner', 'meal'],
    ['picnic', 'meal'],
    ['happy_hour', 'social'],
    ['party', 'social'],
    ['regional', 'gathering'],
    ['national', 'gathering'],
    ['excomm', 'meeting'],
    ['virtual', 'meeting'],
    ['other', 'meeting'],
    [undefined, 'event'],
  ];
  for (const [category, kind] of cases) it(`${category ?? 'no category'} is ${kind}`, () => expect(eventKind({ category })).toBe(kind));

  it('never guesses from the title: a one-off "Panama City lunch" with no category is a plain event', () => {
    expect(eventKind(event({ title: 'Panama City lunch', category: undefined }))).toBe('event');
  });

  it('names every kind in words, the plain one "Event"', () => {
    expect(KIND_LABELS).toEqual({ meal: 'Lunch or meal', social: 'Happy hour or social', gathering: 'Meetup or gathering', meeting: 'Meeting or other', event: 'Event' });
  });
});

describe('parseCalState: the view and the date, from the URL', () => {
  const q = (s: string) => new URLSearchParams(s);
  it('is the list from today with nothing asked', () => expect(parseCalState(q(''), TODAY)).toEqual({ view: 'list', date: TODAY }));
  it('reads each view and a date', () => {
    expect(parseCalState(q('view=week&d=2026-11-13'), TODAY)).toEqual({ view: 'week', date: '2026-11-13' });
    expect(parseCalState(q('view=month&d=2027-02-28'), TODAY)).toEqual({ view: 'month', date: '2027-02-28' });
    expect(parseCalState(q('view=list&d=2026-12-02'), TODAY)).toEqual({ view: 'list', date: '2026-12-02' });
    expect(parseCalState(q('view=month'), TODAY)).toEqual({ view: 'month', date: TODAY });
  });
  it('keeps the old ?month=YYYY-MM links: that month, from today in this month, else its first day', () => {
    expect(parseCalState(q('month=2026-12'), TODAY)).toEqual({ view: 'month', date: '2026-12-01' });
    expect(parseCalState(q('month=2026-11'), TODAY)).toEqual({ view: 'month', date: TODAY });
  });
  it('refuses what it cannot read: an unknown view, a date that is not one, a month out of range', () => {
    for (const bad of ['view=year', 'view=', 'd=2026-02-30', 'd=2026-13-01', 'd=tomorrow', 'd=1999-12-31', 'd=2101-01-01', 'month=2026-13', 'month=x']) expect(parseCalState(q(bad), TODAY), bad).toBeUndefined();
  });
});

describe('calHref: the address of a view and date', () => {
  it('is plain /events for the list from today', () => expect(calHref('list', TODAY, TODAY)).toBe('/events'));
  it('names the view and the date otherwise', () => {
    expect(calHref('list', '2026-11-13', TODAY)).toBe('/events?view=list&d=2026-11-13');
    expect(calHref('week', TODAY, TODAY)).toBe('/events?view=week&d=2026-11-10');
    expect(calHref('month', '2026-12-01', TODAY)).toBe('/events?view=month&d=2026-12-01');
  });
  it('adds a day anchor when asked', () => expect(calHref('week', '2026-11-13', TODAY, '#day-2026-11-13')).toBe('/events?view=week&d=2026-11-13#day-2026-11-13'));
});

describe('calPeriod: what each view covers, its label, and the dates either side', () => {
  it('week: Sunday to Saturday round the date; a week either side, on the same weekday', () => {
    const p = calPeriod({ view: 'week', date: '2026-11-11' }, TODAY);
    expect(p).toMatchObject({ from: '2026-11-08', to: '2026-11-14', label: 'Nov 8 – 14', short: 'Nov 8–14', spoken: 'the week of 8 to 14 November 2026', prev: '2026-11-04', next: '2026-11-18', upcoming: false, thisPeriod: true });
    expect(p.read).toEqual({ from: '2026-11-08', to: '2026-11-14' });
  });
  it('week across months and years', () => {
    expect(calPeriod({ view: 'week', date: '2026-12-01' }, TODAY)).toMatchObject({ from: '2026-11-29', to: '2026-12-05', label: 'Nov 29 – Dec 5', short: 'Nov 29–Dec 5', spoken: 'the week of 29 November to 5 December 2026', thisPeriod: false });
    expect(calPeriod({ view: 'week', date: '2026-12-30' }, TODAY)).toMatchObject({ from: '2026-12-27', to: '2027-01-02', label: 'Dec 27 – Jan 2', spoken: 'the week of 27 December 2026 to 2 January 2027' });
  });
  it('month: the whole month; the month either side on the same day, cut to its length, or today in this month', () => {
    const p = calPeriod({ view: 'month', date: '2027-01-31' }, TODAY);
    expect(p).toMatchObject({ from: '2027-01-01', to: '2027-01-31', label: 'January 2027', short: 'Jan 2027', spoken: 'January 2027', prev: '2026-12-31', next: '2027-02-28', thisPeriod: false });
    expect(calPeriod({ view: 'month', date: '2026-12-25' }, TODAY).prev).toBe(TODAY);
    expect(calPeriod({ view: 'month', date: TODAY }, TODAY)).toMatchObject({ thisPeriod: true, upcoming: false });
  });
  it('list: from today for eight weeks, spanning months, for today or any date in those weeks', () => {
    for (const date of [TODAY, '2026-12-20', '2027-01-05']) {
      const p = calPeriod({ view: 'list', date }, TODAY);
      expect(p, date).toMatchObject({ from: TODAY, to: '2027-01-05', label: 'Nov 2026', short: 'Nov 2026', spoken: 'upcoming, from 10 November 2026', upcoming: true, thisPeriod: true });
    }
    const p = calPeriod({ view: 'list', date: TODAY }, TODAY);
    // Back: this month's earlier days. On: the day after the eight weeks, so no day is skipped.
    expect([p.prev, p.next]).toEqual(['2026-11-01', '2027-01-06']);
  });
  // The challenger (FIX-FIRST 2): a past day of this month must stay in the list, so switching to List keeps your place.
  it('list: a past day of this month lists the whole month from its first day on, through the same eight weeks, past events kept', () => {
    for (const date of ['2026-11-01', '2026-11-05', '2026-11-09']) {
      const p = calPeriod({ view: 'list', date }, TODAY);
      expect(p, date).toMatchObject({ from: '2026-11-01', to: '2027-01-05', label: 'Nov 2026', spoken: 'from 1 November 2026', prev: '2026-10-01', next: '2027-01-06', upcoming: false, thisPeriod: true });
    }
    // Back from the upcoming list goes there, and on from last month comes back to it.
    expect(calPeriod({ view: 'list', date: calPeriod({ view: 'list', date: TODAY }, TODAY).prev }, TODAY).from).toBe('2026-11-01');
    expect(calPeriod({ view: 'list', date: '2026-10-01' }, TODAY).next).toBe('2026-11-01');
  });
  it('list: on the first of the month, back from the upcoming list is last month', () => {
    expect(calPeriod({ view: 'list', date: '2026-12-01' }, '2026-12-01').prev).toBe('2026-11-01');
    expect(calPeriod({ view: 'list', date: '2026-11-15' }, '2026-12-01')).toMatchObject({ from: '2026-11-01', to: '2026-11-30', upcoming: false });
  });
  it('list: any other date shows its month; the month either side from its first day, back to the upcoming list', () => {
    const jan = calPeriod({ view: 'list', date: '2027-01-06' }, TODAY);
    expect(jan).toMatchObject({ from: '2027-01-01', to: '2027-01-31', label: 'Jan 2027', spoken: 'January 2027', prev: '2026-12-01', next: '2027-02-01', upcoming: false, thisPeriod: false });
    expect(calPeriod({ view: 'list', date: jan.prev }, TODAY).upcoming).toBe(true);
    const oct = calPeriod({ view: 'list', date: '2026-10-01' }, TODAY);
    expect(oct).toMatchObject({ from: '2026-10-01', to: '2026-10-31', next: '2026-11-01', upcoming: false });
  });
});

// EV1: the range in words at every crossing (month, year) and in the weeks the clocks change, in any
// time zone the server runs in; the spoken name always in full.
describe('calPeriod: the range across months, years and the clock changes', () => {
  it('a week across years, and the next year\'s', () => {
    expect(calPeriod({ view: 'week', date: '2026-12-27' }, TODAY)).toMatchObject({ label: 'Dec 27 – Jan 2', short: 'Dec 27–Jan 2', spoken: 'the week of 27 December 2026 to 2 January 2027' });
    expect(calPeriod({ view: 'week', date: '2027-12-31' }, TODAY)).toMatchObject({ label: 'Dec 26 – Jan 1', short: 'Dec 26–Jan 1', spoken: 'the week of 26 December 2027 to 1 January 2028' });
  });
  it('the longest month name, in full and short', () => {
    expect(calPeriod({ view: 'month', date: '2026-09-30' }, TODAY)).toMatchObject({ label: 'September 2026', short: 'Sep 2026', spoken: 'September 2026' });
  });
  it('is DST-safe: the weeks the clocks change, in any time zone the server runs in', () => {
    const zone = process.env['TZ'];
    try {
      for (const tz of ['America/Chicago', 'Pacific/Auckland', 'UTC']) {
        process.env['TZ'] = tz;
        expect(calPeriod({ view: 'week', date: '2026-03-08' }, TODAY), tz).toMatchObject({ from: '2026-03-08', to: '2026-03-14', label: 'Mar 8 – 14', short: 'Mar 8–14' });
        expect(calPeriod({ view: 'week', date: '2026-11-07' }, TODAY), tz).toMatchObject({ from: '2026-11-01', to: '2026-11-07', label: 'Nov 1 – 7', short: 'Nov 1–7' });
      }
    } finally {
      if (zone === undefined) delete process.env['TZ'];
      else process.env['TZ'] = zone;
    }
  });
});

describe('the day tiles: the list ribbon holds only days with events; the week holds all seven', () => {
  const events = [
    event({ id: 'a', date: '2026-11-11', category: 'lunch' }),
    event({ id: 'b', date: '2026-11-13', start: '17:00', category: 'happy_hour' }),
    event({ id: 'c', date: '2026-11-11', start: '18:00', category: 'party' }),
    event({ id: 'd', date: '2026-12-02', category: 'lunch' }),
  ];
  it('ribbon: each date with an event, once, in order, across months, never an empty day', () => {
    const days = ribbonDays([...events].reverse(), TODAY, '2026-11-13');
    expect(days.map((d) => d.date)).toEqual(['2026-11-11', '2026-11-13', '2026-12-02']);
    expect(days.map((d) => d.events.length)).toEqual([2, 1, 1]);
    expect(days[1]).toMatchObject({ weekday: 'Fri', day: 13, month: 'Nov', today: false, selected: true });
    expect(days[0]!.events.map((e) => e.id)).toEqual(['a', 'c']);
  });
  it('week: all seven, Sunday first, empty days included', () => {
    const days = weekDays('2026-11-08', events, TODAY, TODAY);
    expect(days.map((d) => d.date)).toEqual(['2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14']);
    expect(days.map((d) => d.events.length)).toEqual([0, 0, 0, 2, 0, 1, 0]);
    expect(days[2]).toMatchObject({ weekday: 'Tue', today: true, selected: true });
  });
  it('puts a day\'s untimed event first, whichever order the API gave', () => {
    const untimed = event({ id: 'u', start: undefined, end: undefined });
    const timed = event({ id: 't' });
    for (const order of [[untimed, timed], [timed, untimed]]) expect(ribbonDays(order, TODAY, TODAY)[0]!.events.map((e) => e.id)).toEqual(['u', 't']);
  });
  it('a tile on its own', () => expect(dayTile('2026-11-08', [], TODAY, TODAY)).toMatchObject({ date: '2026-11-08', weekday: 'Sun', day: 8, month: 'Nov', events: [], today: false, selected: false }));
});

describe('dayIndicator: at most two icons, then +N', () => {
  it('one icon per event, in time order', () => {
    expect(dayIndicator([event({ start: '18:00', category: 'party' }), event({ category: 'lunch' })])).toEqual({ icons: [{ kind: 'meal', cancelled: false }, { kind: 'social', cancelled: false }], more: 0 });
  });
  it('two icons and "+N" past two; a cancelled one is marked so; none for an empty day', () => {
    const three = [event({ start: '09:00', status: 'cancelled' }), event({ start: '10:00', category: 'excomm' }), event({ start: '11:00' }), event({ start: undefined })];
    expect(dayIndicator(three)).toEqual({ icons: [{ kind: 'event', cancelled: false }, { kind: 'event', cancelled: true }], more: 2 });
    expect(dayIndicator([])).toEqual({ icons: [], more: 0 });
  });
});

describe('dayLabel: a day tile or grid day in words', () => {
  it('says the date, today, the count, what is cancelled and the kinds', () => {
    expect(dayLabel({ date: TODAY, today: true, events: [] })).toBe('Tuesday, 10 November, today, no events');
    expect(dayLabel({ date: '2026-11-11', today: false, events: [event({ category: 'lunch' })] })).toBe('Wednesday, 11 November, 1 event: Lunch or meal');
    expect(dayLabel({ date: '2026-11-11', today: false, events: [event({ category: 'lunch', status: 'cancelled' }), event({ start: '17:00' })] })).toBe('Wednesday, 11 November, 2 events, 1 cancelled: Lunch or meal, Event');
    expect(dayLabel({ date: '2026-11-11', today: false, events: [event({ status: 'cancelled' })] })).toBe('Wednesday, 11 November, 1 event, cancelled: Event');
  });
});

describe('shortDay', () => {
  it('is "Wed, Nov 11"', () => expect(shortDay('2026-11-11')).toBe('Wed, Nov 11'));
});

describe('googleEventUrl: one event, added to Google Calendar', () => {
  const origin = 'https://nwflorida.us';
  it('carries the title, Central times, the place and a link back', () => {
    const url = new URL(googleEventUrl(event({ detail: 'Bring a friend.' }), origin));
    expect(`${url.origin}${url.pathname}`).toBe('https://calendar.google.com/calendar/render');
    expect(url.searchParams.get('action')).toBe('TEMPLATE');
    expect(url.searchParams.get('text')).toBe('Wednesday Lunchers');
    expect(url.searchParams.get('dates')).toBe('20261111T113000/20261111T130000');
    expect(url.searchParams.get('ctz')).toBe('America/Chicago');
    expect(url.searchParams.get('location')).toBe('Sample Bistro, 100 Example Way, Destin');
    expect(url.searchParams.get('details')).toBe(`Bring a friend.\nOn our calendar: ${origin}/events/${SERIES}_2026-11-11`);
  });
  it('with no end, ends as it starts (no length made up); with no time, the whole day; across midnight, the next day', () => {
    expect(new URL(googleEventUrl(event({ end: undefined }), origin)).searchParams.get('dates')).toBe('20261111T113000/20261111T113000');
    expect(new URL(googleEventUrl(event({ start: undefined, end: undefined }), origin)).searchParams.get('dates')).toBe('20261111/20261112');
    expect(new URL(googleEventUrl(event({ start: '20:00', end: { date: '2026-11-12', time: '01:00' } }), origin)).searchParams.get('dates')).toBe('20261111T200000/20261112T010000');
  });
});

describe('feedLinks: the subscription, with the feed version', () => {
  it('gives the plain address, the webcal link and Google, each with ?v=', () => {
    expect(FEED_VERSION).toBeGreaterThanOrEqual(2);
    const links = feedLinks('webcal://canary.nwflorida.us/calendar.ics');
    expect(links.address).toBe(`https://canary.nwflorida.us/calendar.ics?v=${FEED_VERSION}`);
    expect(links.webcal).toBe(`webcal://canary.nwflorida.us/calendar.ics?v=${FEED_VERSION}`);
    expect(links.google).toBe(`https://calendar.google.com/calendar/render?cid=${encodeURIComponent(links.webcal)}`);
    expect(links.addByUrl).toBe('https://calendar.google.com/calendar/r/settings/addbyurl');
  });
});

describe('cardPlace: where, on a card, as the concept: the place, then the town', () => {
  it('a business by its name and town; a home by its area only; online; to be decided', () => {
    expect(cardPlace(event())).toEqual({ place: 'Sample Bistro', town: 'Destin' });
    expect(cardPlace(event({ venue: { kind: 'business', name: 'Sample Bistro', address: '', city: '', url: undefined, accessibilityNote: '', hostOfficeId: '' } }))).toEqual({ place: 'Sample Bistro', town: 'Okaloosa County' });
    expect(cardPlace(event({ venue: { kind: 'home', name: "A member's home", address: '', city: '', url: undefined, accessibilityNote: '', hostOfficeId: '' } }))).toEqual({ place: "A member's home", town: 'Okaloosa County' });
    expect(cardPlace(event({ area: 'Online', venue: { kind: 'virtual', name: 'Video call', address: '', city: '', url: undefined, accessibilityNote: '', hostOfficeId: '' } }))).toEqual({ place: 'Online: Video call', town: '' });
    expect(cardPlace(event({ venue: undefined, area: 'Walton County' }))).toEqual({ place: 'Place to be decided', town: 'Walton County' });
  });
});

describe('tileLabel: a day tile in words, starting with what it shows (WCAG 2.5.3)', () => {
  it('is "Wed 11 November", then what dayLabel says', () => {
    expect(tileLabel({ date: '2026-11-11', today: false, events: [event({ category: 'lunch' })] })).toBe('Wed 11 November, 1 event: Lunch or meal');
    expect(tileLabel({ date: TODAY, today: true, events: [] })).toBe('Tue 10 November, today, no events');
  });
});
