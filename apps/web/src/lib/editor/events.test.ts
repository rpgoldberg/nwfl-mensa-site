// EDITOR E6: the officers' event screens' rules (S10, S11): who may use them and which events are theirs,
// the list grouped by date, the form read and checked field by field, Central time to an instant and back
// (around both clock changes), the save request (a series date keeps its series' title and its length),
// the API's URL reasons put back on their fields, and the Q4 seam.
import { type MessageInitShape, clone, create } from '@bufbuild/protobuf';
import { type Timestamp, timestampDate, timestampFromDate } from '@bufbuild/protobuf/wkt';
import { describe, expect, it } from 'vitest';
import { DateSchema } from '../../gen/nwfl/mensa/v1/common_pb.js';
import { Area, type EventOccurrence, EventOccurrenceSchema, EventVisibility, OccurrenceStatus, VenueKind, VenueSchema } from '../../gen/nwfl/mensa/v1/event_pb.js';
import {
  DETAIL_MAX,
  EVENTS_PATH,
  NOTE_MAX,
  TITLE_MAX,
  URL_MAX,
  centralInstant,
  editPathOf,
  eventOffices,
  fieldReasons,
  isWithheld,
  mayChange,
  mayUseEvents,
  ourEvents,
  ownerOf,
  parseEventForm,
  problemSummary,
  refusalErrors,
  saveRequestFor,
  timeText,
  typedValues,
  urlReview,
  valuesOf,
  venueChoices,
} from './events';

const PRESIDENT = { id: '11111111-1111-4111-8111-111111111111', slug: 'president', title: 'President' };
const SOCIAL = { id: '22222222-2222-4222-8222-222222222222', slug: 'social', title: 'Social Chair' };
const TREASURER = { id: '33333333-3333-4333-8333-333333333333', slug: 'treasurer', title: 'Treasurer' };
const ROSTER = [PRESIDENT, SOCIAL, TREASURER];
const LUNCH = '0b9c1f5e-4c1a-4d55-9a3e-2f7d8e6a1b20';
const HAPPY = '1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5';
const HOSTS = new Map([
  [LUNCH, PRESIDENT.id],
  [HAPPY, SOCIAL.id],
]);
const ONE_OFF = '3e4f5a6b-7c8d-4e9f-a0b1-c2d3e4f5a6b7';
const VENUE = { id: 'a0000000-0000-4000-8000-000000000001', kind: VenueKind.BUSINESS, name: 'Sample Bistro', active: true };
const OTHER_VENUE = { id: 'a0000000-0000-4000-8000-000000000002', kind: VenueKind.BUSINESS, name: 'Example Taproom', active: true };

const at = (iso: string) => timestampFromDate(new Date(iso));
const occurrence = (o: MessageInitShape<typeof EventOccurrenceSchema> & { id: string }) => create(EventOccurrenceSchema, { status: OccurrenceStatus.SCHEDULED, visibility: EventVisibility.PUBLIC, ...o });
/** A copy of `base` with `changes`, less the fields in `drop`. */
const variant = (base: EventOccurrence, changes: Partial<EventOccurrence>, drop: ReadonlyArray<'endsAt' | 'startsAt'> = []) => {
  const copy = Object.assign(clone(EventOccurrenceSchema, base), changes);
  for (const field of drop) delete copy[field];
  return copy;
};

/** A Wednesday lunch on 18 November 2026: 11:30 to 13:00 Central (CST, UTC-6). */
const lunch = occurrence({
  id: `${LUNCH}:2026-11-18`,
  seriesId: LUNCH,
  title: 'Wednesday Lunchers',
  startsAt: at('2026-11-18T17:30:00Z'),
  endsAt: at('2026-11-18T19:00:00Z'),
  venueId: VENUE.id,
  venue: VENUE,
  localDate: { year: 2026, month: 11, day: 18 },
});
const games = occurrence({
  id: ONE_OFF,
  title: 'Board games afternoon',
  startsAt: at('2026-11-15T20:00:00Z'),
  localDate: { year: 2026, month: 11, day: 15 },
  ownerOfficeId: SOCIAL.id,
  detail: 'Bring a game. https://example.org/games',
  url: 'https://example.org/rsvp',
  statusNote: 'Room booked',
  visibility: EventVisibility.MEMBERS,
});

describe('who may use the event screens', () => {
  it('admits an officer and the Admin, and no one else', () => {
    expect(mayUseEvents(['nwfl-members', 'nwfl-officers'])).toBe(true);
    expect(mayUseEvents(['nwfl-admin'])).toBe(true);
    expect(mayUseEvents(['nwfl-members', 'nwfl-webmaster'])).toBe(false);
    expect(mayUseEvents(['nwfl-members'])).toBe(false);
    expect(mayUseEvents([])).toBe(false);
  });

  it("gives an officer their held offices, in roster order, and the Admin every office", () => {
    const president = eventOffices(['nwfl-officers', 'nwfl-office-treasurer', 'nwfl-office-president'], ROSTER);
    expect(president.admin).toBe(false);
    expect(president.offices.map((o) => o.slug)).toEqual(['president', 'treasurer']);
    const admin = eventOffices(['nwfl-admin', 'nwfl-office-social'], ROSTER);
    expect(admin.admin).toBe(true);
    expect(admin.offices.map((o) => o.slug)).toEqual(['president', 'social', 'treasurer']);
    expect(admin.offices.map((o) => o.held)).toEqual([false, true, false]);
    expect(eventOffices(['nwfl-officers'], ROSTER).offices).toEqual([]);
  });

  it("finds an event's office: a series date by its series' host, a one-off by its own office", () => {
    expect(ownerOf(lunch, HOSTS)).toBe(PRESIDENT.id);
    expect(ownerOf(games, HOSTS)).toBe(SOCIAL.id);
    expect(ownerOf(occurrence({ id: 'x', seriesId: 'unknown-series' }), HOSTS)).toBe('');
  });

  it('lets an office change its own events, the Admin any, and no one an event with no office but the Admin', () => {
    const president = eventOffices(['nwfl-officers', 'nwfl-office-president'], ROSTER);
    const treasurer = eventOffices(['nwfl-officers', 'nwfl-office-treasurer'], ROSTER);
    const admin = eventOffices(['nwfl-admin'], ROSTER);
    expect(mayChange(lunch, HOSTS, president)).toBe(true);
    expect(mayChange(lunch, HOSTS, treasurer)).toBe(false);
    expect(mayChange(games, HOSTS, president)).toBe(false);
    expect(mayChange(games, HOSTS, admin)).toBe(true);
    const orphan = occurrence({ id: 'x' });
    expect(mayChange(orphan, HOSTS, president)).toBe(false);
    expect(mayChange(orphan, HOSTS, admin)).toBe(true);
  });

  it("refuses to open an event the caller's sign-in reads with anything held back (a save would wipe it)", () => {
    expect(isWithheld(lunch)).toBe(false);
    expect(isWithheld(occurrence({ id: 'x', detailsWithheld: true }))).toBe(true);
    for (const field of ['title', 'statusNote', 'detail', 'url'] as const) expect(isWithheld(occurrence({ id: 'x', [field]: 'before [withheld] after' })), field).toBe(true);
  });
});

describe('the list (S10)', () => {
  const happy = occurrence({ id: `${HAPPY}:2026-11-13`, seriesId: HAPPY, title: 'Happy Hour', startsAt: at('2026-11-13T23:00:00Z'), localDate: { year: 2026, month: 11, day: 13 }, status: OccurrenceStatus.TENTATIVE, statusNote: 'The place may change.' });
  const cancelled = variant(lunch, { id: 'c0000000-0000-4000-8000-000000000009', status: OccurrenceStatus.CANCELLED, statusNote: 'Closed', startsAt: at('2026-11-25T17:30:00Z'), localDate: create(DateSchema, { year: 2026, month: 11, day: 25 }) }, ['endsAt']);
  const withheld = occurrence({ id: `${LUNCH}:2026-12-02`, localDate: { year: 2026, month: 12, day: 2 }, detailsWithheld: true, visibility: EventVisibility.MEMBERS });
  const unknown = occurrence({ id: `${LUNCH}:2026-12-09`, seriesId: LUNCH, title: 'Odd', localDate: { year: 2026, month: 12, day: 9 }, status: OccurrenceStatus.UNSPECIFIED });
  const undated = occurrence({ id: `${LUNCH}:2026-12-16`, seriesId: LUNCH, title: 'No date' });
  const all = [happy, lunch, games, cancelled, withheld, unknown, undated];

  it("lists an officer's own offices' events only, grouped by date in order, with status words and a Change link", () => {
    const days = ourEvents(all, HOSTS, eventOffices(['nwfl-officers', 'nwfl-office-president'], ROSTER));
    expect(days.map((d) => d.date)).toEqual(['2026-11-18', '2026-11-25', '2026-12-02']);
    expect(days[0]!.heading).toBe('Wednesday, 18 November 2026');
    const [first] = days[0]!.events;
    expect(first).toMatchObject({
      id: lunch.id,
      editPath: `${EVENTS_PATH}/${LUNCH}_2026-11-18`,
      title: 'Wednesday Lunchers',
      time: '11:30 am to 1:00 pm',
      status: 'scheduled',
      statusNote: '',
      office: 'President',
      place: 'Sample Bistro',
      members: false,
      withheld: false,
    });
    expect(days[1]!.events[0]).toMatchObject({ status: 'cancelled', statusNote: 'Closed', time: 'From 11:30 am', editPath: `${EVENTS_PATH}/c0000000-0000-4000-8000-000000000009` });
    // A date the officer's sign-in reads withheld: listed, with no title to show and nothing to change.
    expect(days[2]!.events[0]).toMatchObject({ withheld: true, members: true, title: 'Members event' });
  });

  it('gives the Admin every office\'s events, each with its office, a members event marked so', () => {
    const days = ourEvents(all, HOSTS, eventOffices(['nwfl-admin'], ROSTER));
    expect(days.map((d) => d.date)).toEqual(['2026-11-13', '2026-11-15', '2026-11-18', '2026-11-25', '2026-12-02']);
    expect(days[0]!.events[0]).toMatchObject({ office: 'Social Chair', status: 'tentative', statusNote: 'The place may change.', place: 'Place to be decided' });
    expect(days[1]!.events[0]).toMatchObject({ members: true, office: 'Social Chair', time: 'From 2:00 pm' });
    expect(ourEvents([occurrence({ id: 'o', title: 'Orphan', localDate: { year: 2026, month: 11, day: 20 } })], HOSTS, eventOffices(['nwfl-admin'], ROSTER))[0]!.events[0]).toMatchObject({ office: 'No office', time: 'Time not set' });
  });

  it('puts the same day in start order, and an end on another day in words', () => {
    const late = variant(lunch, { id: 'late', startsAt: at('2026-11-18T23:00:00Z'), endsAt: at('2026-11-19T07:00:00Z') });
    const [day] = ourEvents([late, lunch], HOSTS, eventOffices(['nwfl-admin'], ROSTER));
    expect(day!.events.map((e) => e.id)).toEqual([lunch.id, 'late']);
    expect(day!.events[1]!.time).toBe('5:00 pm to Thursday, 19 November 2026, 1:00 am');
  });

  it('says the time from an instant in Central, around both clock changes', () => {
    // 2027-03-14 is the spring change: 10:00 is CDT (UTC-5). 2027-11-07 is the autumn change: 10:00 is CST (UTC-6).
    expect(timeText(occurrence({ id: 'a', startsAt: at('2027-03-14T15:00:00Z') }))).toBe('From 10:00 am');
    expect(timeText(occurrence({ id: 'b', startsAt: at('2027-11-07T16:00:00Z') }))).toBe('From 10:00 am');
  });
});

describe('the edit path', () => {
  it('writes a series date with an underscore, as the public event pages do', () => {
    expect(editPathOf(`${LUNCH}:2026-11-18`)).toBe(`${EVENTS_PATH}/${LUNCH}_2026-11-18`);
    expect(editPathOf(ONE_OFF)).toBe(`${EVENTS_PATH}/${ONE_OFF}`);
  });
});

describe('Central time to an instant', () => {
  it('reads a wall-clock time in Central on an ordinary day, summer and winter', () => {
    expect(centralInstant('2026-11-18', '11:30')?.toISOString()).toBe('2026-11-18T17:30:00.000Z');
    expect(centralInstant('2027-07-04', '18:00')?.toISOString()).toBe('2027-07-04T23:00:00.000Z');
  });

  it('takes the spring change (14 March 2027): before, after, and no 2:30 am at all', () => {
    expect(centralInstant('2027-03-14', '01:30')?.toISOString()).toBe('2027-03-14T07:30:00.000Z');
    expect(centralInstant('2027-03-14', '03:00')?.toISOString()).toBe('2027-03-14T08:00:00.000Z');
    expect(centralInstant('2027-03-14', '10:00')?.toISOString()).toBe('2027-03-14T15:00:00.000Z');
    expect(centralInstant('2027-03-14', '02:30')).toBeUndefined();
    expect(centralInstant('2027-03-13', '10:00')?.toISOString()).toBe('2027-03-13T16:00:00.000Z');
  });

  it('takes the autumn change (7 November 2027): 1:30 am happens twice, and the first is meant', () => {
    expect(centralInstant('2027-11-07', '01:30')?.toISOString()).toBe('2027-11-07T06:30:00.000Z');
    expect(centralInstant('2027-11-07', '10:00')?.toISOString()).toBe('2027-11-07T16:00:00.000Z');
    expect(centralInstant('2027-11-06', '10:00')?.toISOString()).toBe('2027-11-06T15:00:00.000Z');
  });
});

describe('the form (S11)', () => {
  const venues = [VENUE, OTHER_VENUE];
  const offices = [PRESIDENT, SOCIAL];
  const form = (values: Record<string, string>) => (name: string) => values[name];
  const good = { status: 'scheduled', statusNote: '', time: '11:30', venue: VENUE.id, detail: '', url: '', visibility: 'public' };

  it("fills the form from an event, its time in Central, an undecided venue empty", () => {
    expect(valuesOf(lunch)).toEqual({ title: 'Wednesday Lunchers', date: '2026-11-18', time: '11:30', status: 'scheduled', statusNote: '', venue: VENUE.id, detail: '', url: '', visibility: 'public', office: '' });
    expect(valuesOf(games)).toMatchObject({ date: '2026-11-15', time: '14:00', venue: '', visibility: 'members', url: 'https://example.org/rsvp', statusNote: 'Room booked', office: SOCIAL.id });
    expect(valuesOf(occurrence({ id: 'x', status: OccurrenceStatus.UNSPECIFIED }))).toMatchObject({ date: '', time: '', status: '' });
  });

  it("reads a series date's change: its date stays the series', and its title is not asked for", () => {
    const parsed = parseEventForm(form({ ...good, status: 'cancelled', statusNote: '  Closed for a party  ', date: '2030-01-01', title: 'Sneaky' }), { mode: 'series', date: '2026-11-18', venues, offices, today: '2026-11-12' });
    expect(parsed).toEqual({
      ok: true,
      value: { title: '', date: '2026-11-18', startsAt: new Date('2026-11-18T17:30:00Z'), status: 'cancelled', statusNote: 'Closed for a party', venueId: VENUE.id, detail: '', url: '', visibility: 'public', officeId: '' },
    });
  });

  it("reads a new one-off: its title, date, whose it is, a venue to be decided, and 12-hour times too", () => {
    const parsed = parseEventForm(form({ ...good, title: ' Picnic ', date: '2027-03-14', time: '10:00 am', venue: '', office: SOCIAL.id, visibility: 'members', detail: 'Line one\r\nLine two', url: ' https://example.org/p ' }), { mode: 'new', venues, offices, today: '2026-11-12' });
    expect(parsed).toEqual({
      ok: true,
      value: { title: 'Picnic', date: '2027-03-14', startsAt: new Date('2027-03-14T15:00:00Z'), status: 'scheduled', statusNote: '', venueId: '', detail: 'Line one\nLine two', url: 'https://example.org/p', visibility: 'members', officeId: SOCIAL.id },
    });
    for (const [typed, iso] of [
      ['12:00 noon', '2027-03-14T17:00:00Z'],
      ['noon', '2027-03-14T17:00:00Z'],
      ['12:15 AM', '2027-03-14T06:15:00Z'],
      ['6 pm', '2027-03-14T23:00:00Z'],
      ['6:05p.m.', '2027-03-14T23:05:00Z'],
      ['9:5', undefined],
    ] as const) {
      const r = parseEventForm(form({ ...good, title: 'T', date: '2027-03-14', time: typed, office: SOCIAL.id }), { mode: 'new', venues, offices, today: '2026-11-12' });
      expect(r.ok ? r.value.startsAt.toISOString() : undefined, typed).toBe(iso === undefined ? undefined : new Date(iso).toISOString());
    }
  });

  it("does not ask whose a new event is when there is one office to choose", () => {
    const parsed = parseEventForm(form({ ...good, title: 'T', date: '2026-12-01' }), { mode: 'new', venues, offices: [PRESIDENT], today: '2026-11-12' });
    expect(parsed.ok && parsed.value.officeId).toBe(PRESIDENT.id);
  });

  it("lets a one-off's date change", () => {
    const parsed = parseEventForm(form({ ...good, title: 'T', date: '2026-12-01' }), { mode: 'one-off', venues, offices, today: '2026-11-12' });
    expect(parsed.ok && parsed.value.date).toBe('2026-12-01');
    expect(parsed.ok && parsed.value.officeId).toBe('');
  });

  it('reads every field as typed, an absent one empty', () => {
    expect(typedValues(form({ title: 'T', detail: 'a\r\nb', office: 'o' }))).toEqual({ title: 'T', date: '', time: '', status: '', statusNote: '', venue: '', detail: 'a\r\nb', url: '', visibility: '', office: 'o' });
  });

  it('names each problem in plain words, keyed by its field, and keeps what was typed', () => {
    const typed = { title: '', date: '2026-02-30', time: '25:00', status: 'postponed', statusNote: 'n'.repeat(NOTE_MAX + 1), venue: 'nowhere', detail: 'd'.repeat(DETAIL_MAX + 1), url: 'u'.repeat(URL_MAX + 1), visibility: 'everyone', office: 'nobody' };
    const parsed = parseEventForm(form(typed), { mode: 'new', venues, offices, today: '2026-11-12' });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toEqual({
      title: 'Give the event a title.',
      date: 'That is not a date. Write it as year-month-day, such as 2027-03-14.',
      time: 'That is not a time. Write it as 11:30 am or 6:00 pm.',
      status: 'Choose a status.',
      statusNote: `The note is too long: at most ${NOTE_MAX} characters.`,
      venue: 'Choose a place from the list.',
      detail: `The details are too long: at most ${DETAIL_MAX} characters.`,
      url: `The web address is too long: at most ${URL_MAX} characters.`,
      visibility: 'Choose who can see it.',
      office: 'Choose whose event it is.',
    });
    expect(parsed.values).toEqual(typed);
  });

  it('asks for a date and a time, refuses a date gone by, and a title too long', () => {
    const empty = parseEventForm(form({ ...good, title: 't'.repeat(TITLE_MAX + 1), date: '', time: '' }), { mode: 'new', venues, offices: [PRESIDENT], today: '2026-11-12' });
    expect(!empty.ok && empty.errors).toEqual({ title: `The title is too long: at most ${TITLE_MAX} characters.`, date: 'Give the date.', time: 'Give the start time.' });
    const past = parseEventForm(form({ ...good, title: 'T', date: '2026-11-11' }), { mode: 'new', venues, offices: [PRESIDENT], today: '2026-11-12' });
    expect(!past.ok && past.errors).toEqual({ date: 'That date has passed. Choose today or a later date.' });
    const missing = parseEventForm(() => undefined, { mode: 'series', date: '2026-11-18', venues, offices, today: '2026-11-12' });
    expect(!missing.ok && missing.errors).toEqual({ time: 'Give the start time.', status: 'Choose a status.', visibility: 'Choose who can see it.' });
  });

  it('refuses a time the clocks skip in spring, in words that say why', () => {
    const parsed = parseEventForm(form({ ...good, title: 'T', date: '2027-03-14', time: '02:30' }), { mode: 'new', venues, offices: [PRESIDENT], today: '2026-11-12' });
    expect(!parsed.ok && parsed.errors).toEqual({
      time: 'There is no 2:30 am on Sunday, 14 March 2027 in Central time: the clocks go forward an hour that night. Choose 3:00 am or later.',
    });
  });

  it('counts a note, details and an address as people see them (by character, not UTF-16 unit)', () => {
    const parsed = parseEventForm(form({ ...good, statusNote: '😀'.repeat(NOTE_MAX) }), { mode: 'series', date: '2026-11-18', venues, offices, today: '2026-11-12' });
    expect(parsed.ok).toBe(true);
  });
});

describe('the save request', () => {
  const input = { title: '', date: '2026-11-18', startsAt: new Date('2026-11-18T18:00:00Z'), status: 'cancelled' as const, statusNote: 'Closed', venueId: VENUE.id, detail: 'Sorry', url: 'https://example.org/x', visibility: 'public' as const, officeId: '' };

  it("changes a series date by its id, keeping its series' title and its length, never moving its series or office", () => {
    const request = saveRequestFor(input, lunch, 'Wednesday Lunchers').occurrence;
    expect(request).toMatchObject({ id: lunch.id, title: '', seriesId: '', ownerOfficeId: '', venueId: VENUE.id, status: OccurrenceStatus.CANCELLED, statusNote: 'Closed', detail: 'Sorry', url: 'https://example.org/x', visibility: EventVisibility.PUBLIC });
    expect(timestampDate(request.startsAt as Timestamp).toISOString()).toBe('2026-11-18T18:00:00.000Z');
    // 90 minutes long before, 90 minutes long after.
    expect(timestampDate(request.endsAt as Timestamp).toISOString()).toBe('2026-11-18T19:30:00.000Z');
  });

  it("keeps a series date's own title where it has one", () => {
    expect(saveRequestFor(input, { ...lunch, title: 'Lunchers: holiday special' }, 'Wednesday Lunchers').occurrence.title).toBe('Lunchers: holiday special');
  });

  it("writes a one-off's title, and a new one's office; no end where none was known", () => {
    const changed = saveRequestFor({ ...input, title: 'Board games', visibility: 'members', status: 'moved' }, games, undefined).occurrence;
    expect(changed).toMatchObject({ id: ONE_OFF, title: 'Board games', ownerOfficeId: '', visibility: EventVisibility.MEMBERS, status: OccurrenceStatus.MOVED });
    expect(changed.endsAt).toBeUndefined();
    const created = saveRequestFor({ ...input, title: 'Picnic', officeId: SOCIAL.id, status: 'tentative' }, undefined, undefined).occurrence;
    expect(created).toMatchObject({ id: '', title: 'Picnic', ownerOfficeId: SOCIAL.id, status: OccurrenceStatus.TENTATIVE });
    expect(saveRequestFor({ ...input, status: 'scheduled' }, undefined, undefined).occurrence.status).toBe(OccurrenceStatus.SCHEDULED);
  });

  it('says the venue is decided later, in the same save, exactly when no place is chosen', () => {
    expect(saveRequestFor({ ...input, venueId: '' }, lunch, 'Wednesday Lunchers').venueDecidedLater).toBe(true);
    expect(saveRequestFor({ ...input, venueId: '' }, undefined, undefined).venueDecidedLater).toBe(true);
    expect(saveRequestFor(input, lunch, 'Wednesday Lunchers').venueDecidedLater).toBe(false);
    expect(saveRequestFor({ ...input, venueId: '' }, lunch, 'Wednesday Lunchers').occurrence.venueId).toBe('');
  });
});

describe("the API's URL reasons, on their fields", () => {
  it('puts the address reason on the web address, each detail line on the details, anything else at the top', () => {
    expect(fieldReasons('url: the address "http://example.org/" must start with https://, not http://; detail line 2: the address "https://a.org:8080/" names a port (a colon and a number after the site name), which is not allowed')).toEqual({
      url: ['The address "http://example.org/" must start with https://, not http://.'],
      detail: ['Line 2: the address "https://a.org:8080/" names a port (a colon and a number after the site name), which is not allowed.'],
      other: [],
    });
    expect(fieldReasons('starts_at is required')).toEqual({ url: [], detail: [], other: ['starts_at is required.'] });
    expect(fieldReasons('detail line 1: the address "x" is cut…')).toEqual({ url: [], detail: ['Line 1: the address "x" is cut…'], other: [] });
    expect(fieldReasons('')).toEqual({ url: [], detail: [], other: [] });
  });

  it('does not split an address that holds a semicolon of its own', () => {
    expect(fieldReasons('url: the address "https://a.org/x; y" must be written plainly').url).toEqual(['The address "https://a.org/x; y" must be written plainly.']);
  });
});

describe('Q4: new or changed event URLs (the seam A3b plugs into)', () => {
  it('names the addresses that are new or changed, in the web address and in the details', () => {
    const before = { url: 'https://example.org/rsvp', detail: 'See https://example.org/games.' };
    expect(urlReview(before, before)).toEqual({ changed: [], held: [] });
    expect(urlReview(before, { url: 'https://example.org/rsvp2', detail: 'See https://example.org/games and www.example.net/x, then http://old.example.org' })).toEqual({
      changed: ['https://example.org/rsvp2', 'www.example.net/x', 'http://old.example.org'],
      held: [],
    });
    expect(urlReview(undefined, { url: '', detail: '' })).toEqual({ changed: [], held: [] });
    expect(urlReview(undefined, { url: 'https://example.org/new', detail: '' }).changed).toEqual(['https://example.org/new']);
  });
});

describe('the venue choices', () => {
  const venue = (v: Parameters<typeof create<typeof VenueSchema>>[1]) => create(VenueSchema, { active: true, ...v });
  const taproom = venue({ id: 'v2', kind: VenueKind.BUSINESS, name: 'Example Taproom', city: 'Fort Walton Beach', area: Area.OKALOOSA });
  const home = venue({ id: 'v4', kind: VenueKind.MEMBER_HOME, name: "A member's home", area: Area.WALTON });
  const video = venue({ id: 'v5', kind: VenueKind.VIRTUAL, name: 'Video call', area: Area.VIRTUAL });

  it('lists each venue by name, with its town and area, in name order', () => {
    expect(venueChoices([video, taproom, home])).toEqual([
      { id: 'v4', label: "A member's home", hint: 'Walton County' },
      { id: 'v2', label: 'Example Taproom', hint: 'Fort Walton Beach, Okaloosa County' },
      { id: 'v5', label: 'Video call', hint: 'Online' },
    ]);
  });

  it("keeps the event's own venue where it is no longer on the list, so a save does not lose it", () => {
    const closed = venue({ id: 'v9', kind: VenueKind.BUSINESS, name: 'Old Cafe', area: Area.BAY, active: false });
    expect(venueChoices([taproom], closed).map((c) => c.id)).toEqual(['v2', 'v9']);
    expect(venueChoices([taproom], taproom).map((c) => c.id)).toEqual(['v2']);
    expect(venueChoices([taproom], venue({ id: '' })).map((c) => c.id)).toEqual(['v2']);
  });
});

describe('the problem list at the top', () => {
  it('lists each problem in the order of the form, named by its field, each a link to its field (a choice to its first button)', () => {
    expect(
      problemSummary({
        visibility: ['Choose who can see it.'],
        url: ['The address "http://x.org/" must start with https://, not http://.'],
        title: ['Give the event a title.'],
        status: ['Choose a status.'],
        detail: ['Line 1: one.', 'Line 2: two.'],
        office: ['Choose whose event it is.'],
        venue: ['Choose a place from the list.'],
      }),
    ).toEqual([
      { href: '#title', text: 'Title: Give the event a title.' },
      { href: '#office-0', text: 'Whose event it is: Choose whose event it is.' },
      { href: '#status-scheduled', text: 'Status: Choose a status.' },
      { href: '#venue-later', text: 'Where: Choose a place from the list.' },
      { href: '#detail', text: 'Details: Line 1: one.' },
      { href: '#detail', text: 'Details: Line 2: two.' },
      { href: '#url', text: 'Web address: The address "http://x.org/" must start with https://, not http://.' },
      { href: '#visibility-public', text: 'Who can see it: Choose who can see it.' },
    ]);
    expect(problemSummary({ date: ['Give the date.'], time: ['Give the start time.'], statusNote: ['Too long.'] }).map((p) => p.href)).toEqual(['#date', '#time', '#statusNote']);
    expect(problemSummary({})).toEqual([]);
  });

  it("turns the API's refusal into problems on the web address and the details, and the rest for the top", () => {
    expect(refusalErrors('url: the address "http://x.org/" must start with https://, not http://; detail line 3: the address "https://a:1/" names a port')).toEqual({
      errors: { url: ['The address "http://x.org/" must start with https://, not http://.'], detail: ['Line 3: the address "https://a:1/" names a port.'] },
      other: [],
    });
    expect(refusalErrors('a value is not allowed')).toEqual({ errors: {}, other: ['a value is not allowed.'] });
  });
});
