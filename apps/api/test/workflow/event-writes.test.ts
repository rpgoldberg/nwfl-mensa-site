// A4b: events are live on save, outside the approval queue (R3, P19). The
// owning office creates, edits and cancels them; every write is audited, and
// the calendar shows it on the next read.
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { type Client, Code } from '@connectrpc/connect';
import { DateSchema } from '../../src/gen/nwfl/mensa/v1/common_pb.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Area,
  EventCategory,
  EventOccurrenceSchema,
  EventSeriesSchema,
  EventService,
  EventVisibility,
  OccurrenceStatus,
  VenueKind,
  VenueSchema,
} from '../../src/gen/nwfl/mensa/v1/event_pb.js';
import { type Api, as, insertId, startApi } from '../helpers/api.js';
import { live } from '../helpers/pg.js';

const PUB = as('pub-token');
const ADMIN = as('admin-token');
const TREASURER = as('treasurer-token');
const OFFICER = as('officer-token');
const MEMBER = as('member-token');
/** The value of an optional message field that the test knows is set. */
function must<T>(value: T | undefined): T {
  expect(value).toBeDefined();
  return value as T;
}

const NOVEMBER = { from: { year: 2026, month: 11, day: 1 }, to: { year: 2026, month: 11, day: 30 } };

describe.skipIf(!live)('event writes', () => {
  let api: Api;
  let events: Client<typeof EventService>;
  const offices: Record<string, string> = {};

  beforeAll(async () => {
    api = await startApi('nwfl_eventwrites');
    events = api.client(EventService);
    for (const slug of ['publications', 'treasurer']) {
      offices[slug] = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ($1, $1, 'appointed') RETURNING id`, [slug]);
    }
  });

  afterAll(async () => {
    await api?.close();
  });

  const audits = async (subjectKind: string): Promise<string[]> =>
    (await api.pool.query<{ action: string }>(`SELECT action FROM audit_event WHERE subject_kind = $1 ORDER BY id`, [subjectKind])).rows.map((r) => r.action);

  describe('venues', () => {
    it('lets any officer add or edit a venue, audited', async () => {
      const venue = (await events.saveVenue({ venue: create(VenueSchema, { kind: VenueKind.BUSINESS, name: 'Example Grill', businessAddress: '1 Example Way', area: Area.BAY }) }, OFFICER)).venue;
      expect(venue).toMatchObject({ name: 'Example Grill', area: Area.BAY, active: true });
      const edited = (await events.saveVenue({ venue: { ...must(venue), name: 'Example Grill and Bar' } }, PUB)).venue;
      expect(edited).toMatchObject({ id: venue?.id, name: 'Example Grill and Bar' });
      expect(await audits('venue')).toEqual(['create', 'save']);
    });

    it("refuses a member, an anonymous caller, a member's home without a host office, and an unknown venue", async () => {
      const venue = create(VenueSchema, { kind: VenueKind.BUSINESS, name: 'X', area: Area.BAY });
      await expect(events.saveVenue({ venue }, MEMBER)).rejects.toMatchObject({ code: Code.PermissionDenied });
      await expect(events.saveVenue({ venue })).rejects.toMatchObject({ code: Code.Unauthenticated });
      await expect(events.saveVenue({ venue: { ...must(venue), kind: VenueKind.MEMBER_HOME } }, OFFICER)).rejects.toMatchObject({ code: Code.InvalidArgument });
      await expect(events.saveVenue({ venue: { ...must(venue), id: '6a1f0c8e-0000-4000-8000-000000000000' } }, OFFICER)).rejects.toMatchObject({ code: Code.NotFound });
      await expect(events.saveVenue({}, OFFICER)).rejects.toMatchObject({ code: Code.InvalidArgument });
      await expect(events.saveVenue({ venue: { ...must(venue), kind: VenueKind.UNSPECIFIED } }, OFFICER)).rejects.toMatchObject({ code: Code.InvalidArgument });
    });
  });

  describe('series', () => {
    const lunch = () =>
      create(EventSeriesSchema, {
        slug: 'wednesday-lunch',
        title: 'Wednesday Lunch',
        category: EventCategory.LUNCH,
        recurrence: 'FREQ=WEEKLY;BYDAY=WE',
        cadenceLabel: 'Every Wednesday',
        defaultStart: { hours: 11, minutes: 30 },
        defaultDurationMinutes: 90,
        area: Area.OKALOOSA,
        hostOfficeId: offices['publications'] as string,
        visibility: EventVisibility.PUBLIC,
        startsOn: { year: 2026, month: 1, day: 7 },
      });

    it('creates a series as its host office, live at once on the calendar', async () => {
      const series = (await events.saveSeries({ series: lunch() }, PUB)).series;
      expect(series).toMatchObject({ slug: 'wednesday-lunch', active: true, hostOfficeId: offices['publications'] });
      const november = await events.listOccurrences(NOVEMBER);
      expect(november.occurrences.filter((o) => o.seriesId === series?.id)).toHaveLength(4);
      const edited = (await events.saveSeries({ series: { ...must(series), title: 'Wednesday Lunch Bunch' } }, PUB)).series;
      expect(edited?.title).toBe('Wednesday Lunch Bunch');
      expect(await audits('event_series')).toEqual(['create', 'save']);
    });

    it('refuses another office, a rule the calendar cannot expand, a missing start, and a member', async () => {
      await expect(events.saveSeries({ series: { ...lunch(), slug: 'other' } }, TREASURER)).rejects.toMatchObject({ code: Code.PermissionDenied });
      await expect(events.saveSeries({ series: { ...lunch(), slug: 'daily', recurrence: 'FREQ=DAILY' } }, PUB)).rejects.toMatchObject({ code: Code.InvalidArgument });
      const noStart = { ...lunch(), slug: 'no-start' };
      delete (noStart as { startsOn?: unknown }).startsOn;
      await expect(events.saveSeries({ series: noStart }, PUB)).rejects.toMatchObject({ code: Code.InvalidArgument });
      await expect(events.saveSeries({ series: { ...lunch(), slug: 'member' } }, MEMBER)).rejects.toMatchObject({ code: Code.PermissionDenied });
      await expect(events.saveSeries({ series: { ...lunch(), slug: 'Bad Slug' } }, PUB)).rejects.toMatchObject({ code: Code.InvalidArgument });
      const mine = (await events.listSeries({})).series.find((s) => s.slug === 'wednesday-lunch');
      await expect(events.saveSeries({ series: { ...must(mine), hostOfficeId: offices['treasurer'] as string } }, PUB)).rejects.toMatchObject({ code: Code.PermissionDenied });
      await expect(events.saveSeries({ series: { ...must(mine), title: 'Taken over' } }, TREASURER)).rejects.toMatchObject({ code: Code.PermissionDenied });
      // Nor by moving it to an office the caller does hold.
      await expect(events.saveSeries({ series: { ...must(mine), hostOfficeId: offices['treasurer'] as string } }, TREASURER)).rejects.toMatchObject({
        code: Code.PermissionDenied,
      });
    });

    it('refuses a first date the calendar does not have', async () => {
      await expect(events.saveSeries({ series: { ...lunch(), slug: 'feb-30', startsOn: create(DateSchema, { year: 2026, month: 2, day: 30 }) } }, PUB)).rejects.toMatchObject({
        code: Code.InvalidArgument,
      });
    });

    it('lets the Admin edit any series', async () => {
      const mine = (await events.listSeries({})).series.find((s) => s.slug === 'wednesday-lunch');
      expect((await events.saveSeries({ series: { ...must(mine), cadenceLabel: 'Wednesdays' } }, ADMIN)).series?.cadenceLabel).toBe('Wednesdays');
    });
  });

  describe('occurrences', () => {
    it('cancels one date of a series by its host office, and the calendar shows it at once', async () => {
      const series = (await events.listSeries({})).series.find((s) => s.slug === 'wednesday-lunch');
      const id = `${series?.id as string}:2026-11-25`;
      const generated = (await events.getOccurrence({ id })).occurrence;
      await expect(events.saveOccurrence({ occurrence: { ...must(generated), status: OccurrenceStatus.CANCELLED, statusNote: 'Thanksgiving week' } }, TREASURER)).rejects.toMatchObject({
        code: Code.PermissionDenied,
      });
      const cancelled = (await events.saveOccurrence({ occurrence: { ...must(generated), status: OccurrenceStatus.CANCELLED, statusNote: 'Thanksgiving week' } }, PUB)).occurrence;
      expect(cancelled).toMatchObject({ status: OccurrenceStatus.CANCELLED, statusNote: 'Thanksgiving week', seriesId: series?.id });
      const shown = (await events.listOccurrences({ ...NOVEMBER, includeCancelled: true })).occurrences.find((o) => o.id === cancelled?.id);
      expect(shown?.status).toBe(OccurrenceStatus.CANCELLED);
      expect((await events.listOccurrences(NOVEMBER)).occurrences.some((o) => o.id === cancelled?.id)).toBe(false);
      expect((await events.getOccurrence({ id })).occurrence?.id).toBe(cancelled?.id);
      // Reinstated by editing the stored row.
      const back = (await events.saveOccurrence({ occurrence: { ...must(cancelled), status: OccurrenceStatus.SCHEDULED, statusNote: '' } }, PUB)).occurrence;
      expect(back?.status).toBe(OccurrenceStatus.SCHEDULED);
    });

    it('edits the stored row when a cancelled date is saved again by its generated id, and resolves its venue', async () => {
      const series = (await events.listSeries({})).series.find((s) => s.slug === 'wednesday-lunch');
      const venue = (await events.listVenues({}, PUB)).venues[0];
      const id = `${series?.id as string}:2026-11-18`;
      const generated = must((await events.getOccurrence({ id })).occurrence);
      const first = (await events.saveOccurrence({ occurrence: { ...generated, status: OccurrenceStatus.TENTATIVE } }, PUB)).occurrence;
      const second = (await events.saveOccurrence({ occurrence: { ...generated, id, venueId: venue?.id as string, status: OccurrenceStatus.SCHEDULED } }, PUB)).occurrence;
      expect(second?.id).toBe(first?.id);
      expect(second?.venue?.name).toBe(venue?.name);
    });

    it('creates a one-off event owned by an office, editable only by it or the Admin', async () => {
      const picnic = create(EventOccurrenceSchema, {
        title: 'Fall Picnic',
        startsAt: timestampFromDate(new Date('2026-11-14T17:00:00Z')),
        endsAt: timestampFromDate(new Date('2026-11-14T21:00:00Z')),
        visibility: EventVisibility.PUBLIC,
        detail: 'Bring a chair',
        ownerOfficeId: offices['treasurer'] as string,
      });
      await expect(events.saveOccurrence({ occurrence: picnic }, PUB)).rejects.toMatchObject({ code: Code.PermissionDenied });
      const saved = (await events.saveOccurrence({ occurrence: picnic }, TREASURER)).occurrence;
      expect(saved).toMatchObject({ title: 'Fall Picnic', ownerOfficeId: offices['treasurer'], status: OccurrenceStatus.SCHEDULED });
      await expect(events.saveOccurrence({ occurrence: { ...must(saved), detail: 'Hijacked' } }, PUB)).rejects.toMatchObject({ code: Code.PermissionDenied });
      const moved = (await events.saveOccurrence({ occurrence: { ...must(saved), status: OccurrenceStatus.MOVED, statusNote: 'Moved to the 21st' } }, ADMIN)).occurrence;
      expect(moved?.status).toBe(OccurrenceStatus.MOVED);
      expect((await events.listOccurrences(NOVEMBER)).occurrences.find((o) => o.id === saved?.id)?.statusNote).toBe('Moved to the 21st');
    });

    it('refuses a one-off without a title, start, visibility or owner, a bad id, and a date its series does not have', async () => {
      const base = create(EventOccurrenceSchema, {
        title: 'X',
        startsAt: timestampFromDate(new Date('2026-11-14T17:00:00Z')),
        visibility: EventVisibility.PUBLIC,
        ownerOfficeId: offices['treasurer'] as string,
      });
      await expect(events.saveOccurrence({ occurrence: { ...base, title: '' } }, TREASURER)).rejects.toMatchObject({ code: Code.InvalidArgument });
      const noStart = { ...base };
      delete (noStart as { startsAt?: unknown }).startsAt;
      await expect(events.saveOccurrence({ occurrence: noStart }, TREASURER)).rejects.toMatchObject({ code: Code.InvalidArgument });
      await expect(events.saveOccurrence({ occurrence: { ...base, visibility: EventVisibility.UNSPECIFIED } }, TREASURER)).rejects.toMatchObject({ code: Code.InvalidArgument });
      await expect(events.saveOccurrence({ occurrence: { ...base, ownerOfficeId: '' } }, TREASURER)).rejects.toMatchObject({ code: Code.PermissionDenied });
      await expect(events.saveOccurrence({ occurrence: { ...base, id: 'nonsense' } }, TREASURER)).rejects.toMatchObject({ code: Code.InvalidArgument });
      await expect(events.saveOccurrence({ occurrence: { ...base, id: '6a1f0c8e-0000-4000-8000-000000000000' } }, TREASURER)).rejects.toMatchObject({ code: Code.NotFound });
      const series = (await events.listSeries({})).series.find((s) => s.slug === 'wednesday-lunch');
      await expect(events.saveOccurrence({ occurrence: { ...base, id: `${series?.id as string}:2026-11-26` } }, PUB)).rejects.toMatchObject({ code: Code.NotFound });
      await expect(events.saveOccurrence({}, TREASURER)).rejects.toMatchObject({ code: Code.InvalidArgument });
    });

    it('audits every occurrence write', async () => {
      expect(await audits('event_occurrence')).toEqual(['create', 'save', 'create', 'save', 'create', 'save']);
    });
  });

  // API-FIX3 (blocker): only the current owner office, or the Admin, changes an
  // occurrence; a series or owner id in the request never moves it.
  describe('ownership of an occurrence', () => {
    const row = async (id: string) =>
      (
        await api.pool.query<{ title: string; status: string; series_id: string | null; owner_office_id: string | null }>(
          `SELECT title, status, series_id, owner_office_id FROM event_occurrence WHERE id = $1`,
          [id],
        )
      ).rows[0];
    let treasurerSeries: string;
    let picnic: string;

    beforeAll(async () => {
      treasurerSeries = await insertId(
        api.pool,
        `INSERT INTO event_series (slug, title, category, recurrence, starts_on, area, visibility, host_office_id)
         VALUES ('treasurer-dinner', 'Treasurer dinner', 'dinner', 'FREQ=MONTHLY;BYDAY=1FR', '2026-01-02', 'bay', 'public', $1) RETURNING id`,
        [offices['treasurer']],
      );
      picnic = must(
        (
          await events.saveOccurrence(
            {
              occurrence: create(EventOccurrenceSchema, {
                title: 'Publications picnic',
                startsAt: timestampFromDate(new Date('2026-12-12T17:00:00Z')),
                visibility: EventVisibility.PUBLIC,
                ownerOfficeId: offices['publications'] as string,
              }),
            },
            PUB,
          )
        ).occurrence,
      ).id;
    });

    it('refuses another office, whether it names its own series or its own office in the request', async () => {
      const hijack = (extra: Record<string, unknown>) =>
        events.saveOccurrence({ occurrence: create(EventOccurrenceSchema, { id: picnic, title: 'Hijacked', status: OccurrenceStatus.CANCELLED, visibility: EventVisibility.PUBLIC, ...extra }) }, TREASURER);
      await expect(hijack({})).rejects.toMatchObject({ code: Code.PermissionDenied });
      await expect(hijack({ seriesId: treasurerSeries })).rejects.toMatchObject({ code: Code.PermissionDenied });
      await expect(hijack({ ownerOfficeId: offices['treasurer'] })).rejects.toMatchObject({ code: Code.PermissionDenied });
      expect(await row(picnic)).toEqual({ title: 'Publications picnic', status: 'scheduled', series_id: null, owner_office_id: offices['publications'] });
    });

    it('keeps an occurrence in its series and with its owner, even for the owner', async () => {
      const save = (extra: Record<string, unknown>) =>
        events.saveOccurrence({ occurrence: create(EventOccurrenceSchema, { id: picnic, title: 'Moved', visibility: EventVisibility.PUBLIC, ...extra }) }, PUB);
      await expect(save({ seriesId: treasurerSeries })).rejects.toMatchObject({ code: Code.InvalidArgument, rawMessage: 'an occurrence keeps its series and its owning office' });
      await expect(save({ ownerOfficeId: offices['treasurer'] })).rejects.toMatchObject({ code: Code.InvalidArgument });
      // Sending back what it read keeps working.
      expect(must((await save({ ownerOfficeId: offices['publications'] })).occurrence).title).toBe('Moved');
      expect(await row(picnic)).toMatchObject({ series_id: null, owner_office_id: offices['publications'] });
    });

    it('leaves a seeded event with no owning office to the Admin alone, and the Admin keeps it unowned', async () => {
      const seeded = await insertId(api.pool, `INSERT INTO event_occurrence (title, starts_at, visibility) VALUES ('Seeded social', '2026-12-19T23:00:00Z', 'public') RETURNING id`);
      const claim = (options: { headers: Record<string, string> }, extra: Record<string, unknown> = {}) =>
        events.saveOccurrence({ occurrence: create(EventOccurrenceSchema, { id: seeded, title: 'Claimed', visibility: EventVisibility.PUBLIC, ...extra }) }, options);
      await expect(claim(TREASURER, { ownerOfficeId: offices['treasurer'] })).rejects.toMatchObject({ code: Code.PermissionDenied });
      await expect(claim(PUB, { seriesId: treasurerSeries })).rejects.toMatchObject({ code: Code.PermissionDenied });
      await expect(claim(ADMIN, { ownerOfficeId: offices['treasurer'] })).rejects.toMatchObject({ code: Code.InvalidArgument });
      await claim(ADMIN);
      expect(await row(seeded)).toEqual({ title: 'Claimed', status: 'scheduled', series_id: null, owner_office_id: null });
    });

    it('refuses another office on a stored date of a series, by its id or by its date', async () => {
      const lunch = (await events.listSeries({})).series.find((s) => s.slug === 'wednesday-lunch');
      const stored = (await api.pool.query<{ id: string }>(`SELECT id FROM event_occurrence WHERE series_id = $1 LIMIT 1`, [lunch?.id])).rows[0]?.id as string;
      const save = (id: string, extra: Record<string, unknown> = {}) =>
        events.saveOccurrence({ occurrence: create(EventOccurrenceSchema, { id, status: OccurrenceStatus.CANCELLED, visibility: EventVisibility.PUBLIC, ...extra }) }, TREASURER);
      await expect(save(stored, { ownerOfficeId: offices['treasurer'] })).rejects.toMatchObject({ code: Code.PermissionDenied });
      await expect(save(stored, { seriesId: treasurerSeries })).rejects.toMatchObject({ code: Code.PermissionDenied });
      await expect(save(`${lunch?.id as string}:2026-12-02`, { seriesId: treasurerSeries })).rejects.toMatchObject({ code: Code.PermissionDenied });
      await expect(
        events.saveOccurrence({ occurrence: create(EventOccurrenceSchema, { id: `${lunch?.id as string}:2026-12-02`, seriesId: treasurerSeries, visibility: EventVisibility.PUBLIC }) }, PUB),
      ).rejects.toMatchObject({ code: Code.InvalidArgument });
    });
  });
});
