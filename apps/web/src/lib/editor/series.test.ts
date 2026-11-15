// SERIES-UI: the recurring-event form's rules. Each plain choice maps to one exact rule and one plain
// label; an existing rule maps back to the choices (or is kept as it is when they cannot show it); the next
// dates come from the same rules the API uses; dates changed one by one that a new pattern drops are
// named, never lost; and only a host office's officers (or the Admin) see a series to change.
import { create } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import { Area, EventCategory, type EventOccurrence, EventOccurrenceSchema, type EventSeries, EventSeriesSchema, EventVisibility, OccurrenceStatus } from '../../gen/nwfl/mensa/v1/event_pb.js';
import { Duplicate, NotAllowed } from '../api/editor';
import { expand, parseRule } from './recurrence';
import {
  NEW_SERIES_PATH,
  type SeriesValues,
  blankSeriesValues,
  cadenceLabel,
  droppedOverrides,
  nextDates,
  ourSeries,
  saveWithSeriesSlug,
  parseSeriesForm,
  seriesIdFromParam,
  seriesPathOf,
  seriesProblemSummary,
  seriesRequest,
  seriesSlug,
  valuesFromSeries,
} from './series';

const OFFICE = 'c0000000-0000-4000-8000-000000000001';
const OTHER = 'c0000000-0000-4000-8000-000000000002';
const SERIES = 'b0000000-0000-4000-8000-000000000001';
const VENUE = 'a0000000-0000-4000-8000-000000000001';
const TODAY = '2027-01-04'; // a Monday

const filled = (over: Partial<SeriesValues> = {}): SeriesValues => ({
  ...blankSeriesValues(),
  title: 'Games night',
  kind: 'other',
  repeat: 'weekly',
  days: ['TU'],
  startsOn: '2027-01-05',
  time: '19:00',
  length: '120',
  venue: VENUE,
  area: 'okaloosa',
  visibility: 'public',
  description: 'Board games and talk.',
  ends: 'never',
  ...over,
});
const fieldOf = (v: SeriesValues) => (name: string): string | undefined => {
  if (name.startsWith('day-')) return v.days.includes(name.slice(4)) ? 'yes' : undefined;
  const value = (v as unknown as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : undefined;
};
const context = { mode: 'new' as const, offices: [{ id: OFFICE }], venues: [{ id: VENUE }], today: TODAY };
const parse = (over: Partial<SeriesValues> = {}, ctx: Parameters<typeof parseSeriesForm>[1] = context) => parseSeriesForm(fieldOf(filled(over)), ctx);
const ok = (over: Partial<SeriesValues> = {}, ctx?: Parameters<typeof parseSeriesForm>[1]) => {
  const result = parse(over, ctx);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
};
const errorsOf = (over: Partial<SeriesValues> = {}, ctx?: Parameters<typeof parseSeriesForm>[1]) => {
  const result = parse(over, ctx);
  if (result.ok) throw new Error('parsed');
  return result.errors;
};

describe('every choice maps to one exact rule and one plain label', () => {
  it.each([
    [{ repeat: 'weekly', days: ['TU'] }, 'FREQ=WEEKLY;BYDAY=TU', 'Every Tuesday'],
    [{ repeat: 'weekly', days: ['TH', 'MO'] }, 'FREQ=WEEKLY;BYDAY=MO,TH', 'Every Monday and Thursday'],
    [{ repeat: 'weekly', days: ['FR', 'MO', 'WE'] }, 'FREQ=WEEKLY;BYDAY=MO,WE,FR', 'Every Monday, Wednesday and Friday'],
    [{ repeat: 'fortnightly', days: ['TU'] }, 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU', 'Every other Tuesday'],
    [{ repeat: 'fortnightly', days: ['SA', 'SU'] }, 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SA,SU', 'Every other Saturday and Sunday'],
    [{ repeat: 'every-n', everyN: '3', days: ['WE'] }, 'FREQ=WEEKLY;INTERVAL=3;BYDAY=WE', 'Every 3 weeks on Wednesday'],
    [{ repeat: 'every-n', everyN: '1', days: ['WE'] }, 'FREQ=WEEKLY;BYDAY=WE', 'Every Wednesday'],
    [{ repeat: 'every-n', everyN: ' 2 ', days: ['WE'] }, 'FREQ=WEEKLY;INTERVAL=2;BYDAY=WE', 'Every other Wednesday'],
    [{ repeat: 'every-n', everyN: '52', days: ['WE'] }, 'FREQ=WEEKLY;INTERVAL=52;BYDAY=WE', 'Every 52 weeks on Wednesday'],
    [{ repeat: 'monthly', monthly: 'weekday', ordinal: '1', weekday: 'FR' }, 'FREQ=MONTHLY;BYDAY=1FR', 'First Friday of the month'],
    [{ repeat: 'monthly', monthly: 'weekday', ordinal: '2', weekday: 'FR' }, 'FREQ=MONTHLY;BYDAY=2FR', 'Second Friday of the month'],
    [{ repeat: 'monthly', monthly: 'weekday', ordinal: '3', weekday: 'SA' }, 'FREQ=MONTHLY;BYDAY=3SA', 'Third Saturday of the month'],
    [{ repeat: 'monthly', monthly: 'weekday', ordinal: '4', weekday: 'MO' }, 'FREQ=MONTHLY;BYDAY=4MO', 'Fourth Monday of the month'],
    [{ repeat: 'monthly', monthly: 'weekday', ordinal: '-1', weekday: 'MO' }, 'FREQ=MONTHLY;BYDAY=-1MO', 'Last Monday of the month'],
    [{ repeat: 'monthly', monthly: 'day', monthDay: '1' }, 'FREQ=MONTHLY;BYMONTHDAY=1', 'The 1st of each month'],
    [{ repeat: 'monthly', monthly: 'day', monthDay: '2' }, 'FREQ=MONTHLY;BYMONTHDAY=2', 'The 2nd of each month'],
    [{ repeat: 'monthly', monthly: 'day', monthDay: '3' }, 'FREQ=MONTHLY;BYMONTHDAY=3', 'The 3rd of each month'],
    [{ repeat: 'monthly', monthly: 'day', monthDay: '11' }, 'FREQ=MONTHLY;BYMONTHDAY=11', 'The 11th of each month'],
    [{ repeat: 'monthly', monthly: 'day', monthDay: '22' }, 'FREQ=MONTHLY;BYMONTHDAY=22', 'The 22nd of each month'],
    [{ repeat: 'monthly', monthly: 'day', monthDay: '28' }, 'FREQ=MONTHLY;BYMONTHDAY=28', 'The 28th of each month'],
    [{ repeat: 'monthly', monthly: 'day', monthDay: '29' }, 'FREQ=MONTHLY;BYMONTHDAY=29', 'The 29th of each month that has one'],
    [{ repeat: 'monthly', monthly: 'day', monthDay: '31' }, 'FREQ=MONTHLY;BYMONTHDAY=31', 'The 31st of each month that has one'],
    [{ repeat: 'monthly', monthly: 'last-day' }, 'FREQ=MONTHLY;BYMONTHDAY=-1', 'Last day of the month'],
  ] as const)('%j', (over, rule, label) => {
    const value = ok(over as Partial<SeriesValues>);
    expect(value.rule).toBe(rule);
    expect(value.cadenceLabel).toBe(label);
    expect(cadenceLabel(value.pattern)).toBe(label);
    expect(() => parseRule(value.rule)).not.toThrow();
  });

  it('adds the ending: after a number of dates, or on a date', () => {
    expect(ok({ ends: 'count', count: '10' }).rule).toBe('FREQ=WEEKLY;BYDAY=TU;COUNT=10');
    expect(ok({ ends: 'until', until: '2027-06-30' }).rule).toBe('FREQ=WEEKLY;BYDAY=TU;UNTIL=20270630');
    expect(ok({ ends: 'never', count: '10', until: '2027-06-30' }).rule).toBe('FREQ=WEEKLY;BYDAY=TU');
  });

  it('"Last" and "Fourth" differ in a month with five of that weekday', () => {
    const fourth = ok({ repeat: 'monthly', monthly: 'weekday', ordinal: '4', weekday: 'MO', startsOn: '2027-03-01' });
    const last = ok({ repeat: 'monthly', monthly: 'weekday', ordinal: '-1', weekday: 'MO', startsOn: '2027-03-01' });
    // March 2027 has five Mondays: the 1st, 8th, 15th, 22nd and 29th.
    expect(nextDates(fourth.rule, fourth.startsOn, TODAY, 1)).toEqual(['2027-03-22']);
    expect(nextDates(last.rule, last.startsOn, TODAY, 1)).toEqual(['2027-03-29']);
  });

  it('day 29, 30 and 31 skip the months without one; "the last day" meets every month', () => {
    const day31 = ok({ repeat: 'monthly', monthly: 'day', monthDay: '31', startsOn: '2027-01-04' });
    expect(nextDates(day31.rule, day31.startsOn, TODAY, 3)).toEqual(['2027-01-31', '2027-03-31', '2027-05-31']);
    const day29 = ok({ repeat: 'monthly', monthly: 'day', monthDay: '29', startsOn: '2027-12-01' });
    expect(nextDates(day29.rule, day29.startsOn, TODAY, 4)).toEqual(['2027-12-29', '2028-01-29', '2028-02-29', '2028-03-29']);
    const day30 = ok({ repeat: 'monthly', monthly: 'day', monthDay: '30', startsOn: '2027-01-04' });
    expect(nextDates(day30.rule, day30.startsOn, TODAY, 2)).toEqual(['2027-01-30', '2027-03-30']);
    const last = ok({ repeat: 'monthly', monthly: 'last-day', startsOn: '2027-01-04' });
    expect(nextDates(last.rule, last.startsOn, TODAY, 3)).toEqual(['2027-01-31', '2027-02-28', '2027-03-31']);
  });
});

describe('parseSeriesForm', () => {
  it('reads the rest of the series', () => {
    const value = ok({ office: OTHER, title: '  Games night  ', length: ' 90 ', description: 'One\r\ntwo ' });
    expect(value).toMatchObject({ title: 'Games night', officeId: OFFICE, category: 'other', startsOn: '2027-01-05', time: '19:00', minutes: 90, venueId: VENUE, area: 'okaloosa', visibility: 'public', description: 'One\ntwo' });
    expect(ok({ length: '', venue: '', time: '6:30 pm' })).toMatchObject({ minutes: null, venueId: '', time: '18:30' });
  });

  it('asks whose event it is of someone with more than one office, and refuses one not theirs', () => {
    const two = { ...context, offices: [{ id: OFFICE }, { id: OTHER }] };
    expect(ok({ office: OTHER }, two).officeId).toBe(OTHER);
    expect(errorsOf({ office: '' }, two).office).toBe('Choose whose event it is.');
    expect(errorsOf({ office: 'c0000000-0000-4000-8000-00000000dead' }, two).office).toBe('Choose whose event it is.');
    expect(errorsOf({}, { ...context, offices: [] }).office).toBe('Choose whose event it is.');
    // A change keeps its office: none is read from the form.
    expect(ok({ office: OTHER }, { ...context, mode: 'change' }).officeId).toBe('');
  });

  it('says what is wrong with each field, in words', () => {
    expect(errorsOf({ title: ' ' }).title).toBe('Give the event a title.');
    expect(errorsOf({ title: 'x'.repeat(121) }).title).toMatch(/at most 120/);
    expect(errorsOf({ kind: 'brunch' }).kind).toBe('Choose what kind of event it is.');
    expect(errorsOf({ repeat: '' }).repeat).toBe('Choose how often it repeats.');
    expect(errorsOf({ repeat: 'keep' }).repeat).toBe('Choose how often it repeats.');
    expect(errorsOf({ days: [] }).days).toBe('Choose at least one day of the week.');
    expect(errorsOf({ repeat: 'every-n', everyN: '' }).everyN).toBe('Give the number of weeks, from 1 to 52.');
    expect(errorsOf({ repeat: 'every-n', everyN: '53' }).everyN).toBe('Give the number of weeks, from 1 to 52.');
    expect(errorsOf({ repeat: 'every-n', everyN: '2.5' }).everyN).toBe('Give the number of weeks, from 1 to 52.');
    expect(errorsOf({ repeat: 'monthly', monthly: '' }).monthly).toBe('Choose which day of the month.');
    expect(errorsOf({ repeat: 'monthly', monthly: 'weekday', ordinal: '5', weekday: 'MO' }).ordinal).toBe('Choose first, second, third, fourth or last.');
    expect(errorsOf({ repeat: 'monthly', monthly: 'weekday', ordinal: '1', weekday: 'XX' }).weekday).toBe('Choose the day of the week.');
    expect(errorsOf({ repeat: 'monthly', monthly: 'day', monthDay: '32' }).monthDay).toBe('Give a day from 1 to 31.');
    expect(errorsOf({ repeat: 'monthly', monthly: 'day', monthDay: '0' }).monthDay).toBe('Give a day from 1 to 31.');
    expect(errorsOf({ startsOn: '' }).startsOn).toBe('Give the first date.');
    expect(errorsOf({ startsOn: '2027-02-30' }).startsOn).toMatch(/^That is not a date/);
    expect(errorsOf({ startsOn: '2027-01-03' }).startsOn).toBe('That date has passed. Choose today or a later date.');
    expect(errorsOf({ time: '' }).time).toBe('Give the start time.');
    expect(errorsOf({ time: '25:00' }).time).toMatch(/^That is not a time/);
    expect(errorsOf({ length: '0' }).length).toBe('Give the length in minutes, from 1 to 1440, or leave it empty.');
    expect(errorsOf({ length: 'two hours' }).length).toBe('Give the length in minutes, from 1 to 1440, or leave it empty.');
    expect(errorsOf({ venue: 'a0000000-0000-4000-8000-00000000beef' }).venue).toBe('Choose a place from the list.');
    expect(errorsOf({ area: 'mars' }).area).toBe('Choose the area.');
    expect(errorsOf({ visibility: '' }).visibility).toBe('Choose who can see it.');
    expect(errorsOf({ description: 'x'.repeat(2001) }).description).toMatch(/at most 2000/);
    expect(errorsOf({ ends: '' }).ends).toBe('Choose when it ends.');
    expect(errorsOf({ ends: 'count', count: '0' }).count).toBe('Give the number of dates, from 1 to 1000.');
    expect(errorsOf({ ends: 'count', count: '1001' }).count).toBe('Give the number of dates, from 1 to 1000.');
    expect(errorsOf({ ends: 'until', until: '' }).until).toBe('Give the last date.');
    expect(errorsOf({ ends: 'until', until: '2027-13-01' }).until).toMatch(/^That is not a date/);
    expect(errorsOf({ ends: 'until', until: '2027-01-04' }).until).toBe('The last date is before the first date.');
  });

  it('refuses a pattern with no date at all', () => {
    expect(errorsOf({ repeat: 'monthly', monthly: 'day', monthDay: '31', startsOn: '2027-02-01', ends: 'until', until: '2027-02-28' }).repeat).toBe(
      'No date falls on this pattern before it ends. Choose another pattern or a later last date.',
    );
  });

  it('lets a change keep an earlier first date, and keep a pattern the choices cannot show', () => {
    const change = { ...context, mode: 'change' as const, keep: { rule: 'FREQ=MONTHLY;INTERVAL=2;BYDAY=4SA', label: 'Every other month' } };
    const kept = ok({ repeat: 'keep', startsOn: '2026-09-26', ends: 'count', count: '12' }, change);
    expect(kept.rule).toBe('FREQ=MONTHLY;INTERVAL=2;BYDAY=4SA;COUNT=12');
    expect(kept.cadenceLabel).toBe('Every other month');
    expect(ok({ repeat: 'keep', startsOn: '2026-09-26' }, { ...change, keep: { rule: 'FREQ=MONTHLY;BYMONTHDAY=1,-1', label: '' } }).cadenceLabel).toBe('Repeats');
  });
});

type SeriesOver = Partial<Pick<EventSeries, 'id' | 'title' | 'recurrence' | 'cadenceLabel' | 'hostOfficeId' | 'defaultDurationMinutes' | 'category' | 'area'>> & { defaultStart?: undefined; startsOn?: undefined };
const series = (over: SeriesOver = {}): EventSeries =>
  create(EventSeriesSchema, {
    id: SERIES,
    slug: 'games-night',
    title: 'Games night',
    category: EventCategory.OTHER,
    recurrence: 'FREQ=WEEKLY;BYDAY=TU',
    cadenceLabel: 'Every Tuesday',
    defaultStart: { hours: 19, minutes: 5 },
    defaultDurationMinutes: 120,
    defaultVenueId: VENUE,
    area: Area.BAY,
    hostOfficeId: OFFICE,
    description: 'Board games.',
    visibility: EventVisibility.MEMBERS,
    active: true,
    startsOn: { year: 2026, month: 3, day: 3 },
    ...over,
  });

describe('valuesFromSeries', () => {
  it('fills the form from a series', () => {
    expect(valuesFromSeries(series())).toEqual({
      values: {
        ...blankSeriesValues(),
        title: 'Games night',
        kind: 'other',
        repeat: 'weekly',
        days: ['TU'],
        startsOn: '2026-03-03',
        time: '19:05',
        length: '120',
        venue: VENUE,
        area: 'bay',
        visibility: 'members',
        description: 'Board games.',
        ends: 'never',
      },
      keep: undefined,
    });
    expect(valuesFromSeries(series({ defaultStart: undefined, defaultDurationMinutes: 0, category: EventCategory.UNSPECIFIED, area: Area.UNSPECIFIED, startsOn: undefined })).values).toMatchObject({
      time: '',
      length: '',
      kind: '',
      area: '',
      startsOn: '',
    });
  });

  it.each([
    ['FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH', { repeat: 'fortnightly', days: ['MO', 'TH'] }],
    ['FREQ=WEEKLY;INTERVAL=4;BYDAY=WE;COUNT=6', { repeat: 'every-n', everyN: '4', days: ['WE'], ends: 'count', count: '6' }],
    ['FREQ=WEEKLY;UNTIL=20270101T050000Z', { repeat: 'weekly', days: ['TU'], ends: 'until', until: '2027-01-01' }],
    ['FREQ=MONTHLY;BYDAY=-1MO', { repeat: 'monthly', monthly: 'weekday', ordinal: '-1', weekday: 'MO' }],
    ['FREQ=MONTHLY;BYDAY=2FR', { repeat: 'monthly', monthly: 'weekday', ordinal: '2', weekday: 'FR' }],
    ['FREQ=MONTHLY;BYMONTHDAY=15', { repeat: 'monthly', monthly: 'day', monthDay: '15' }],
    ['FREQ=MONTHLY;BYMONTHDAY=-1', { repeat: 'monthly', monthly: 'last-day' }],
    ['FREQ=MONTHLY', { repeat: 'monthly', monthly: 'day', monthDay: '3' }],
  ])('maps %s back to its choices', (rule, choices) => {
    const { values, keep } = valuesFromSeries(series({ recurrence: rule }));
    expect(keep).toBeUndefined();
    expect(values).toMatchObject(choices);
    // And the choices give the same dates back.
    const again = ok(values, { ...context, mode: 'change' });
    expect(expand(parseRule(again.rule), '2026-03-03', '2026-03-03', '2029-12-31')).toEqual(expand(parseRule(rule), '2026-03-03', '2026-03-03', '2029-12-31'));
  });

  it.each(['FREQ=MONTHLY;INTERVAL=2;BYDAY=4SA', 'FREQ=MONTHLY;BYDAY=5FR', 'FREQ=MONTHLY;BYDAY=TU', 'FREQ=MONTHLY;BYDAY=2FR,-1MO', 'FREQ=MONTHLY;BYMONTHDAY=1,-1;UNTIL=20271231'])(
    'keeps %s as it is: the choices cannot show it',
    (rule) => {
      const { values, keep } = valuesFromSeries(series({ recurrence: rule, cadenceLabel: 'Now and then' }));
      expect(values.repeat).toBe('keep');
      expect(keep).toEqual({ rule: rule.replace(/;(COUNT|UNTIL)=[^;]*/, ''), label: 'Now and then' });
    },
  );

  it('asks for the pattern again when the rule cannot be read at all', () => {
    const { values, keep } = valuesFromSeries(series({ recurrence: 'FREQ=DAILY' }));
    expect(values.repeat).toBe('');
    expect(keep).toBeUndefined();
  });
});

describe('seriesRequest', () => {
  it('is the series SaveSeries is sent, with the office, the slug and every choice', () => {
    const value = ok({ visibility: 'members', area: 'escambia_santa_rosa', kind: 'happy_hour' });
    expect(seriesRequest(value, { slug: 'games-night', hostOfficeId: OFFICE })).toEqual({
      id: '',
      slug: 'games-night',
      title: 'Games night',
      category: EventCategory.HAPPY_HOUR,
      recurrence: 'FREQ=WEEKLY;BYDAY=TU',
      cadenceLabel: 'Every Tuesday',
      startsOn: { year: 2027, month: 1, day: 5 },
      defaultStart: { hours: 19, minutes: 0 },
      defaultDurationMinutes: 120,
      defaultVenueId: VENUE,
      area: Area.ESCAMBIA_SANTA_ROSA,
      hostOfficeId: OFFICE,
      description: 'Board games and talk.',
      visibility: EventVisibility.MEMBERS,
    });
    expect(seriesRequest(ok({ length: '' }), { id: SERIES, slug: 'x', hostOfficeId: OTHER })).toMatchObject({ id: SERIES, defaultDurationMinutes: 0, hostOfficeId: OTHER, visibility: EventVisibility.PUBLIC });
  });

  it('makes a slug the API takes from the title, and the next one to try', () => {
    expect(seriesSlug('Games Night!', 1)).toBe('games-night');
    expect(seriesSlug('Games Night!', 2)).toBe('games-night-2');
    expect(seriesSlug('x'.repeat(200), 1)).toMatch(/^[a-z0-9][a-z0-9-]{0,60}$/);
    expect(seriesSlug('x'.repeat(200), 12)).toMatch(/^x+-12$/);
    expect(seriesSlug('x'.repeat(200), 12).length).toBeLessThanOrEqual(61);
    expect(seriesSlug('???', 1)).toBe('event');
  });
});

type OccurrenceOver = Pick<EventOccurrence, 'id'> & Partial<Pick<EventOccurrence, 'seriesId' | 'status' | 'statusNote'>> & { date: string; localDate?: undefined };
const occurrence = (over: OccurrenceOver): EventOccurrence => {
  const { date, localDate, ...rest } = over;
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return create(EventOccurrenceSchema, { seriesId: SERIES, title: 'Games night', status: OccurrenceStatus.SCHEDULED, ...('localDate' in over ? { localDate } : { localDate: { year: y, month: m, day: d } }), ...rest });
};

describe('droppedOverrides', () => {
  const stored = [
    occurrence({ id: 'd0000000-0000-4000-8000-000000000001', date: '2027-01-12', status: OccurrenceStatus.CANCELLED }),
    occurrence({ id: 'd0000000-0000-4000-8000-000000000002', date: '2027-01-19', statusNote: 'Moved to the back room' }),
    // Not on the old pattern either (moved off it one by one): not this change's doing.
    occurrence({ id: 'd0000000-0000-4000-8000-000000000003', date: '2027-01-21', status: OccurrenceStatus.MOVED }),
    // A plain series date, never changed, and another series' change, and a one-off.
    occurrence({ id: `${SERIES}:2027-01-26`, date: '2027-01-26' }),
    occurrence({ id: 'd0000000-0000-4000-8000-000000000004', seriesId: 'b0000000-0000-4000-8000-000000000009', date: '2027-01-12' }),
    occurrence({ id: 'd0000000-0000-4000-8000-000000000005', seriesId: '', date: '2027-01-12' }),
    occurrence({ id: 'd0000000-0000-4000-8000-000000000006', localDate: undefined, date: '2027-01-12' }),
  ];
  const old = { rule: 'FREQ=WEEKLY;BYDAY=TU', startsOn: '2026-03-03' };

  it('names each date changed one by one that the new pattern no longer has', () => {
    expect(droppedOverrides(stored, SERIES, old, { rule: 'FREQ=WEEKLY;BYDAY=WE', startsOn: '2026-03-03' })).toEqual([
      { date: '2027-01-12', heading: 'Tuesday, 12 January 2027', status: 'Cancelled', editPath: '/officer-area/events/d0000000-0000-4000-8000-000000000001' },
      { date: '2027-01-19', heading: 'Tuesday, 19 January 2027', status: 'Scheduled: Moved to the back room', editPath: '/officer-area/events/d0000000-0000-4000-8000-000000000002' },
    ]);
    expect(droppedOverrides(stored, SERIES, old, { rule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU', startsOn: '2027-01-05' }).map((d) => d.date)).toEqual(['2027-01-12']);
  });

  it('names none when the pattern keeps them, and none for a rule it cannot read', () => {
    expect(droppedOverrides(stored, SERIES, old, old)).toEqual([]);
    expect(droppedOverrides(stored, SERIES, old, { rule: 'FREQ=WEEKLY;BYDAY=TU;COUNT=500', startsOn: '2026-03-03' })).toEqual([]);
    expect(droppedOverrides(stored, SERIES, { rule: 'FREQ=DAILY', startsOn: '2026-03-03' }, { rule: 'FREQ=WEEKLY;BYDAY=WE', startsOn: '2026-03-03' })).toHaveLength(3);
    expect(droppedOverrides(stored, SERIES, old, { rule: 'FREQ=DAILY', startsOn: '2026-03-03' })).toEqual([]);
  });
});

describe('nextDates', () => {
  it('lists the next dates from today, or from the first date when it is later', () => {
    expect(nextDates('FREQ=WEEKLY;BYDAY=TU', '2026-03-03', TODAY, 5)).toEqual(['2027-01-05', '2027-01-12', '2027-01-19', '2027-01-26', '2027-02-02']);
    expect(nextDates('FREQ=WEEKLY;INTERVAL=52;BYDAY=TU', '2027-03-02', TODAY, 5)).toEqual(['2027-03-02', '2028-02-29', '2029-02-27', '2030-02-26', '2031-02-25']);
    expect(nextDates('FREQ=WEEKLY;BYDAY=TU;COUNT=2', '2027-01-05', TODAY, 5)).toEqual(['2027-01-05', '2027-01-12']);
    expect(nextDates('FREQ=DAILY', '2027-01-05', TODAY, 5)).toEqual([]);
  });
});

describe('ourSeries', () => {
  const who = { admin: false, offices: [{ id: OFFICE, slug: 'president', title: 'President', held: true }] };
  const occurrences = [
    occurrence({ id: `${SERIES}:2027-01-05`, date: '2027-01-05', status: OccurrenceStatus.CANCELLED }),
    occurrence({ id: 'd0000000-0000-4000-8000-000000000001', date: '2027-01-12' }),
    occurrence({ id: `${SERIES}:2027-01-19`, date: '2027-01-19' }),
  ];

  it('lists the series of this person’s offices, with the plain pattern and the next date not cancelled', () => {
    const list = ourSeries([series(), series({ id: 'b0000000-0000-4000-8000-000000000002', title: 'Book club', hostOfficeId: OTHER })], occurrences, who);
    expect(list).toEqual([{ id: SERIES, title: 'Games night', cadence: 'Every Tuesday', next: 'Tuesday, 12 January 2027', office: 'President', changePath: '/officer-area/events/series/b0000000-0000-4000-8000-000000000001' }]);
  });

  it('lists every office’s for the Admin, in title order, and says when no date is coming', () => {
    const list = ourSeries([series({ title: 'Zoo walk', cadenceLabel: '' }), series({ id: 'b0000000-0000-4000-8000-000000000002', title: 'Book club', hostOfficeId: OTHER })], occurrences, { admin: true, offices: who.offices });
    expect(list.map((s) => [s.title, s.cadence, s.next, s.office])).toEqual([
      ['Book club', 'Every Tuesday', 'None in the next 90 days', 'Another office'],
      ['Zoo walk', 'Every Tuesday', 'Tuesday, 12 January 2027', 'President'],
    ]);
    expect(ourSeries([series({ recurrence: 'FREQ=DAILY', cadenceLabel: '' })], [], who)[0]?.cadence).toBe('Repeats');
  });
});

describe('paths and the problem list', () => {
  it('reads a series id from the path, and "new"', () => {
    expect(seriesIdFromParam(SERIES)).toBe(SERIES);
    expect(seriesIdFromParam('new')).toBe('new');
    expect(seriesIdFromParam(`${SERIES}:2027-01-05`)).toBeUndefined();
    expect(seriesIdFromParam('../x')).toBeUndefined();
    expect(seriesPathOf(SERIES)).toBe(`/officer-area/events/series/${SERIES}`);
    expect(NEW_SERIES_PATH).toBe('/officer-area/events/series/new');
  });

  it('lists each problem in the form’s order, linking to its field', () => {
    expect(seriesProblemSummary({ until: ['Give the last date.'], title: ['Give the event a title.'], days: ['Choose at least one day of the week.'], overrides: ['Tick the box.'] })).toEqual([
      { href: '#title', text: 'Title: Give the event a title.' },
      { href: '#day-MO', text: 'Days of the week: Choose at least one day of the week.' },
      { href: '#until', text: 'Last date: Give the last date.' },
      { href: '#overridesSeen', text: 'Dates changed one by one: Tick the box.' },
    ]);
  });
});

describe('saveWithSeriesSlug', () => {
  it('tries the title’s slug, then -2, -3 while the API says it is taken', async () => {
    const tried: string[] = [];
    const saved = await saveWithSeriesSlug('Games night', async (slug) => {
      tried.push(slug);
      if (tried.length < 3) throw new Duplicate('SaveSeries');
      return slug;
    });
    expect(saved).toBe('games-night-3');
    expect(tried).toEqual(['games-night', 'games-night-2', 'games-night-3']);
  });

  it('gives up after the last try, and passes any other refusal on at once', async () => {
    let calls = 0;
    await expect(saveWithSeriesSlug('Games night', async () => { calls += 1; throw new Duplicate('SaveSeries'); }, 4)).rejects.toBeInstanceOf(Duplicate);
    expect(calls).toBe(4);
    calls = 0;
    await expect(saveWithSeriesSlug('Games night', async () => { calls += 1; throw new NotAllowed('SaveSeries'); })).rejects.toBeInstanceOf(NotAllowed);
    expect(calls).toBe(1);
  });
});
