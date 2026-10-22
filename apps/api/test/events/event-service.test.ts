// EventService reads (R3, R4): series expanded by their rule into dated
// occurrences in Central time, stored occurrences overriding the rule on their
// date, members events withheld from the public, and a member's home shown
// only as its area and host office.
import { create } from '@bufbuild/protobuf';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { type Client, Code } from '@connectrpc/connect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DateSchema } from '../../src/gen/nwfl/mensa/v1/common_pb.js';
import {
  Area,
  type EventOccurrence,
  EventService,
  EventVisibility,
  OccurrenceStatus,
  VenueKind,
} from '../../src/gen/nwfl/mensa/v1/event_pb.js';
import { type Api, MEMBER, insertId, startApi } from '../helpers/api.js';
import { live } from '../helpers/pg.js';

const d = (iso: string): ReturnType<typeof create<typeof DateSchema>> => {
  const [year, month, day] = iso.split('-').map(Number) as [number, number, number];
  return create(DateSchema, { year, month, day });
};
const iso = (date: { year: number; month: number; day: number } | undefined): string =>
  date === undefined ? '' : `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
const at = (o: EventOccurrence): string => (o.startsAt ? timestampDate(o.startsAt).toISOString() : '');

describe.skipIf(!live)('EventService reads', () => {
  let api: Api;
  let events: Client<typeof EventService>;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    api = await startApi('nwfl_events');
    events = api.client(EventService);
    const { pool } = api;
    ids['vp'] = await insertId(pool, `INSERT INTO office (slug, title, kind, role_alias, role_alias_verified_on) VALUES ('vice-president', 'Vice President', 'elected', 'vp@nwflorida.us', '2026-10-01') RETURNING id`);
    ids['cafe'] = await insertId(pool, `INSERT INTO venue (kind, name, business_address, city, area, url) VALUES ('business', 'Example Cafe', '1 Example Way', 'Fort Walton Beach', 'okaloosa', 'https://example.org/cafe') RETURNING id`);
    ids['home'] = await insertId(pool, `INSERT INTO venue (kind, name, area, host_office_id, accessibility_note) VALUES ('member_home', 'The Example family home', 'okaloosa', $1, 'three steps up') RETURNING id`, [ids['vp']]);
    ids['lunch'] = await insertId(pool,
      `INSERT INTO event_series (slug, title, category, recurrence, starts_on, default_start, default_duration_minutes, default_venue_id, area, visibility)
       VALUES ('wednesday-lunch', 'Wednesday Lunch', 'lunch', 'FREQ=WEEKLY;BYDAY=WE', '2026-01-07', '11:30', 90, $1, 'okaloosa', 'public') RETURNING id`, [ids['cafe']]);
    ids['party'] = await insertId(pool,
      `INSERT INTO event_series (slug, title, category, recurrence, starts_on, default_start, default_venue_id, area, visibility, description)
       VALUES ('house-party', 'Members house party', 'party', 'FREQ=MONTHLY;BYDAY=3SA', '2026-01-01', '18:00', $1, 'okaloosa', 'members', 'Bring a dish') RETURNING id`, [ids['home']]);
    ids['pc'] = await insertId(pool,
      `INSERT INTO event_series (slug, title, category, recurrence, starts_on, default_start, area, visibility)
       VALUES ('panama-city-lunch', 'Panama City Lunch', 'lunch', 'FREQ=MONTHLY;BYDAY=1SA', '2026-01-01', '11:30', 'bay', 'public') RETURNING id`);
    ids['broken'] = await insertId(pool,
      `INSERT INTO event_series (slug, title, category, recurrence, starts_on, area, visibility)
       VALUES ('broken-rule', 'Broken', 'other', 'FREQ=DAILY', '2026-01-01', 'walton', 'public') RETURNING id`);
    ids['retired'] = await insertId(pool,
      `INSERT INTO event_series (slug, title, category, recurrence, starts_on, area, visibility, active)
       VALUES ('retired', 'Retired series', 'other', 'FREQ=WEEKLY;BYDAY=MO', '2026-01-01', 'walton', 'public', false) RETURNING id`);
    await pool.query(`INSERT INTO event_occurrence (series_id, starts_at, visibility) VALUES ($1, '2026-12-07T18:00:00Z', 'public')`, [ids['retired']]);
    ids['cancelled'] = await insertId(pool,
      `INSERT INTO event_occurrence (series_id, starts_at, status, status_note, visibility) VALUES ($1, '2026-10-28T16:30:00Z', 'cancelled', 'Happy Halloween', 'public') RETURNING id`, [ids['lunch']]);
    ids['picnic'] = await insertId(pool,
      `INSERT INTO event_occurrence (title, starts_at, ends_at, venue_id, visibility, detail, url) VALUES ('Fall Picnic', '2026-11-14T17:00:00Z', '2026-11-14T21:00:00Z', $1, 'public', 'Bring a chair', 'https://example.org/picnic') RETURNING id`, [ids['cafe']]);
  });

  afterAll(async () => {
    await api?.close();
  });

  const list = (from: string, to: string, extra: Record<string, unknown> = {}, options = {}) =>
    events.listOccurrences({ from: d(from), to: d(to), ...extra }, options).then((r) => r.occurrences);

  it('expands a weekly series into Central-time occurrences, across the end of daylight saving', async () => {
    const lunches = (await list('2026-10-26', '2026-11-08')).filter((o) => o.seriesId === ids['lunch']);
    expect(lunches.map(at)).toEqual(['2026-11-04T17:30:00.000Z']);
    const october = (await list('2026-10-12', '2026-10-25')).filter((o) => o.seriesId === ids['lunch']);
    expect(october.map((o) => [iso(o.localDate), at(o), o.title, o.area, o.status])).toEqual([
      ['2026-10-14', '2026-10-14T16:30:00.000Z', 'Wednesday Lunch', Area.OKALOOSA, OccurrenceStatus.SCHEDULED],
      ['2026-10-21', '2026-10-21T16:30:00.000Z', 'Wednesday Lunch', Area.OKALOOSA, OccurrenceStatus.SCHEDULED],
    ]);
    expect(october[0]?.endsAt && timestampDate(october[0].endsAt).toISOString()).toBe('2026-10-14T18:00:00.000Z');
    expect(october[0]?.id).toBe(`${ids['lunch']}:2026-10-14`);
    expect(october[0]?.venue?.name).toBe('Example Cafe');
  });

  it('lets a stored occurrence override the rule on its date; cancelled ones show only when asked', async () => {
    const hidden = (await list('2026-10-28', '2026-10-28')).filter((o) => o.seriesId === ids['lunch']);
    expect(hidden).toEqual([]);
    const shown = (await list('2026-10-28', '2026-10-28', { includeCancelled: true })).filter((o) => o.seriesId === ids['lunch']);
    expect(shown.map((o) => [o.id, o.status, o.statusNote, o.title])).toEqual([[ids['cancelled'], OccurrenceStatus.CANCELLED, 'Happy Halloween', 'Wednesday Lunch']]);
  });

  it('lists one-off events with their own title, venue and area, in date order', async () => {
    const all = await list('2026-11-01', '2026-11-30');
    const picnic = all.find((o) => o.id === ids['picnic']);
    expect(picnic).toMatchObject({ title: 'Fall Picnic', detail: 'Bring a chair', url: 'https://example.org/picnic', area: Area.OKALOOSA, seriesId: '' });
    const order = all.map((o) => iso(o.localDate) + (o.startsAt ? at(o) : ''));
    expect(order).toEqual([...order].sort());
  });

  it('defaults to today in Central time through the next 62 days', async () => {
    const all = await events.listOccurrences({}).then((r) => r.occurrences);
    const dates = all.map((o) => iso(o.localDate));
    // The next Wednesday lunch, on the 28th, is cancelled, so the first event is on the 4th.
    expect(dates[0]).toBe('2026-11-04');
    expect(dates.every((date) => date >= '2026-10-22' && date <= '2026-12-23')).toBe(true);
    expect(dates).toContain('2026-12-23');
    expect(dates).not.toContain('2026-10-21');
  });

  it('withholds every detail of a members event from the public: only its date and area', async () => {
    const publicView = (await list('2026-11-01', '2026-11-30')).filter((o) => o.visibility === EventVisibility.MEMBERS);
    expect(publicView).toHaveLength(1);
    const [withheld] = publicView;
    expect(withheld).toMatchObject({ detailsWithheld: true, title: '', seriesId: '', venueId: '', detail: '', statusNote: '', url: '', area: Area.OKALOOSA });
    expect(iso(withheld?.localDate)).toBe('2026-11-21');
    expect(withheld?.startsAt).toBeUndefined();
    expect(withheld?.venue).toBeUndefined();
    const memberView = (await list('2026-11-01', '2026-11-30', {}, MEMBER)).filter((o) => o.visibility === EventVisibility.MEMBERS);
    expect(memberView[0]).toMatchObject({ detailsWithheld: false, title: 'Members house party', seriesId: ids['party'] });
  });

  it("shows a member's home only as its area and host office, to everyone", async () => {
    const [party] = (await list('2026-11-01', '2026-11-30', {}, MEMBER)).filter((o) => o.seriesId === ids['party']);
    expect(party?.venue).toMatchObject({ kind: VenueKind.MEMBER_HOME, name: "A member's home", businessAddress: '', city: '', url: '', accessibilityNote: '', hostOfficeId: ids['vp'], area: Area.OKALOOSA });
    const venues = (await events.listVenues({}, MEMBER)).venues;
    expect(JSON.stringify(venues)).not.toMatch(/Example family|three steps/);
    expect(venues.find((v) => v.id === ids['cafe'])).toMatchObject({ name: 'Example Cafe', businessAddress: '1 Example Way', city: 'Fort Walton Beach' });
  });

  it("keeps a stored occurrence of a retired series, titled from that series, but stops expanding its rule", async () => {
    const december = (await list('2026-12-01', '2026-12-31')).filter((o) => o.seriesId === ids['retired']);
    expect(december.map((o) => [o.title, iso(o.localDate), o.area])).toEqual([['Retired series', '2026-12-07', Area.WALTON]]);
  });

  it('filters by area', async () => {
    const bay = await list('2026-11-01', '2026-11-30', { areas: [Area.BAY] });
    expect(bay.map((o) => [o.title, iso(o.localDate)])).toEqual([['Panama City Lunch', '2026-11-07']]);
  });

  it('skips a series whose rule it cannot expand, logs it, and still lists the rest', async () => {
    const all = await list('2026-11-01', '2026-11-07');
    expect(all.some((o) => o.seriesId === ids['broken'])).toBe(false);
    expect(all.length).toBeGreaterThan(0);
    expect(api.logs).toContainEqual(expect.objectContaining({ level: 'warn', msg: 'series rule not expanded', series_id: ids['broken'] }));
  });

  it.each([
    ['an end before the start', { from: d('2026-11-02'), to: d('2026-11-01') }],
    ['a range over 400 days', { from: d('2026-01-01'), to: d('2027-03-01') }],
    ['a date the calendar does not have', { from: d('2026-02-30') }],
  ])('refuses %s', async (_label, request) => {
    await expect(events.listOccurrences(request)).rejects.toMatchObject({ code: Code.InvalidArgument });
  });

  describe('GetOccurrence', () => {
    it('finds a stored occurrence and a generated one', async () => {
      expect((await events.getOccurrence({ id: ids['picnic'] })).occurrence?.title).toBe('Fall Picnic');
      const generated = (await events.getOccurrence({ id: `${ids['lunch']}:2026-11-11` })).occurrence;
      expect([generated?.title, at(generated as EventOccurrence)]).toEqual(['Wednesday Lunch', '2026-11-11T17:30:00.000Z']);
    });

    it('returns the stored row for a date it overrides', async () => {
      expect((await events.getOccurrence({ id: `${ids['lunch']}:2026-10-28` })).occurrence?.id).toBe(ids['cancelled']);
    });

    it('withholds a members event from the public here too', async () => {
      const id = `${ids['party']}:2026-11-21`;
      expect((await events.getOccurrence({ id })).occurrence).toMatchObject({ detailsWithheld: true, title: '' });
      expect((await events.getOccurrence({ id }, MEMBER)).occurrence).toMatchObject({ detailsWithheld: false, title: 'Members house party' });
    });

    it.each([
      ['a date the rule does not produce', () => `${ids['lunch']}:2026-11-12`, Code.NotFound],
      ['a date of an inactive or unknown series', () => '6a1f0c8e-0000-4000-8000-000000000000:2026-11-11', Code.NotFound],
      ['an unknown stored id', () => '6a1f0c8e-0000-4000-8000-000000000000', Code.NotFound],
      ['a broken rule', () => `${ids['broken']}:2026-11-11`, Code.NotFound],
      ['a malformed id', () => 'not-an-id', Code.InvalidArgument],
      ['a malformed date', () => `${ids['lunch']}:2026-02-30`, Code.InvalidArgument],
    ])('answers %s', async (_label, id, code) => {
      await expect(events.getOccurrence({ id: id() })).rejects.toMatchObject({ code });
    });
  });

  describe('ListSeries', () => {
    it('shows the public only public series, members everything active', async () => {
      const publicSeries = (await events.listSeries({})).series.map((s) => s.slug);
      expect(publicSeries).toEqual(['broken-rule', 'panama-city-lunch', 'wednesday-lunch']);
      const memberSeries = (await events.listSeries({}, MEMBER)).series;
      expect(memberSeries.map((s) => s.slug)).toEqual(['broken-rule', 'house-party', 'panama-city-lunch', 'wednesday-lunch']);
      const lunch = memberSeries.find((s) => s.slug === 'wednesday-lunch');
      expect(lunch).toMatchObject({ recurrence: 'FREQ=WEEKLY;BYDAY=WE', defaultDurationMinutes: 90, defaultVenueId: ids['cafe'], area: Area.OKALOOSA, active: true });
      expect([iso(lunch?.startsOn), lunch?.defaultStart?.hours, lunch?.defaultStart?.minutes]).toEqual(['2026-01-07', 11, 30]);
    });

    it('includes inactive series on request', async () => {
      expect((await events.listSeries({ includeInactive: true })).series.map((s) => s.slug)).toContain('retired');
      expect((await events.listVenues({ includeInactive: true })).venues.length).toBe(2);
    });
  });
});
