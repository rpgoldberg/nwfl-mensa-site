// EDITOR E6: the stand-in API's events model (e2e/events-model.mjs), which the event screens' e2e runs
// use, driven over the gRPC wire by the site's own clients (src/lib/api/officer-events.ts for the reads,
// src/lib/api/editor.ts saveOccurrence for the writes) as the API's EventService answers them
// (apps/api/src/events/service.ts and writes.ts): a save is in every read at once; a series date is
// changed by <series>:<date> and is its own stored event after; who may change what; the strict URL rule
// (A3a) with its reasons; members events withheld from the public; the series' venue on a first change.
import { create } from '@bufbuild/protobuf';
import { timestampDate, timestampFromDate } from '@bufbuild/protobuf/wkt';
import { type ConnectRouter } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventModel } from '../e2e/events-model.mjs';
import { Area, EventCategory, EventOccurrenceSchema, EventService, EventVisibility, OccurrenceStatus, VenueKind } from '../src/gen/nwfl/mensa/v1/event_pb.js';
import { ApiNotFound } from '../src/lib/api/client';
import { EditorRefused, type EditorApi, NotAllowed, grpcEditor } from '../src/lib/api/editor';
import { type OfficerEventsApi, grpcOfficerEvents } from '../src/lib/api/officer-events';

const PRESIDENT = { id: '11111111-1111-4111-8111-111111111111', slug: 'president' };
const TREASURER = { id: 'office-treasurer', slug: 'treasurer' };
const LUNCH = '0b9c1f5e-4c1a-4d55-9a3e-2f7d8e6a1b20';
const MEMBERS = '2d3e4f5a-6b7c-4d8e-9fa0-b1c2d3e4f5a6';
const BISTRO = { id: 'a0000000-0000-4000-8000-000000000001', kind: VenueKind.BUSINESS, name: 'Sample Bistro', area: Area.OKALOOSA, active: true };
const DINER = { id: 'a0000000-0000-4000-8000-000000000003', kind: VenueKind.BUSINESS, name: 'Placeholder Diner', area: Area.BAY, active: true };

/** Central 11:30 on a November day (CST, UTC-6). */
const lunchAt = (date: string) => new Date(`${date}T17:30:00Z`);
const protoDate = (date: string) => ({ year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)), day: Number(date.slice(8, 10)) });
const days = (from: string, to: string) => {
  const out: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
};

/** Wednesdays: a public lunch at the bistro; Sundays: a members event, withheld from the public. */
function base(from: string, to: string, audience: string) {
  return days(from, to).flatMap((date) => {
    const day = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (day === 3) {
      return [
        create(EventOccurrenceSchema, {
          id: `${LUNCH}:${date}`,
          seriesId: LUNCH,
          title: 'Wednesday Lunchers',
          startsAt: timestampFromDate(lunchAt(date)),
          endsAt: timestampFromDate(new Date(lunchAt(date).getTime() + 90 * 60_000)),
          venueId: BISTRO.id,
          venue: BISTRO,
          status: OccurrenceStatus.SCHEDULED,
          visibility: EventVisibility.PUBLIC,
          localDate: protoDate(date),
          area: Area.OKALOOSA,
        }),
      ];
    }
    if (day === 0) {
      return [
        audience === 'public'
          ? create(EventOccurrenceSchema, { id: `${MEMBERS}:${date}`, localDate: protoDate(date), area: Area.BAY, visibility: EventVisibility.MEMBERS, detailsWithheld: true })
          : create(EventOccurrenceSchema, { id: `${MEMBERS}:${date}`, seriesId: MEMBERS, title: 'Members games night', startsAt: timestampFromDate(new Date(`${date}T01:00:00Z`)), status: OccurrenceStatus.SCHEDULED, visibility: EventVisibility.MEMBERS, localDate: protoDate(date), area: Area.BAY }),
      ];
    }
    return [];
  });
}

const SERIES = [
  { id: LUNCH, slug: 'wednesday-lunchers', title: 'Wednesday Lunchers', category: EventCategory.LUNCH, hostOfficeId: PRESIDENT.id, area: Area.OKALOOSA, visibility: EventVisibility.PUBLIC, active: true },
  { id: MEMBERS, slug: 'members-games', title: 'Members games night', category: EventCategory.OTHER, hostOfficeId: PRESIDENT.id, area: Area.BAY, visibility: EventVisibility.MEMBERS, active: true },
];

/** Callers by the bearer each sends here. */
const PEOPLE: Record<string, { sub: string; groups: string[]; audience: 'public' | 'members' | 'officers' }> = {
  officer: { sub: 's-officer', groups: ['nwfl-members', 'nwfl-officers', 'nwfl-office-president'], audience: 'officers' },
  treasurer: { sub: 's-treasurer', groups: ['nwfl-members', 'nwfl-officers', 'nwfl-office-treasurer'], audience: 'officers' },
  admin: { sub: 's-admin', groups: ['nwfl-officers', 'nwfl-admin'], audience: 'officers' },
  'officer-only': { sub: 's-seatless', groups: ['nwfl-officers'], audience: 'officers' },
};
const as = (who: string) => ({ bearer: who });

let model: ReturnType<typeof createEventModel>;
let reads: OfficerEventsApi;
let writes: EditorApi;
let close: () => Promise<void>;

beforeEach(async () => {
  model = createEventModel({ offices: [PRESIDENT, TREASURER], base, series: SERIES, venues: [BISTRO, DINER] });
  const routes = (router: ConnectRouter) =>
    router.service(
      EventService,
      model.handlers(async (ctx) => {
        const who = /^Bearer (.+)$/.exec(ctx.requestHeader.get('authorization') ?? '')?.[1];
        if (who === undefined) return undefined;
        const person = PEOPLE[who];
        if (person === undefined) throw new Error('unknown test caller');
        return person;
      }),
    );
  const adapter = connectNodeAdapter({ routes, grpc: true, grpcWeb: false, connect: false });
  const sessions = new Set<http2.ServerHttp2Session>();
  const server = http2.createServer((req, res) => void adapter(req, res));
  server.on('session', (s) => sessions.add(s));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  close = () =>
    new Promise((resolve) => {
      server.close(() => resolve());
      for (const s of sessions) s.destroy();
    });
  const config = { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, timeoutMs: 2000 };
  reads = grpcOfficerEvents(config, () => {});
  writes = grpcEditor(config, () => {});
});

afterEach(async () => {
  await close();
});

/** The public's view, as the API gives it to no caller. */
const anonymous = { list: (from: string, to: string) => Promise.resolve(model.list(from, to, 'public')) };

const WED = '2026-11-18';
const SUN = '2026-11-22';

describe('the stand-in events model', () => {
  it('reads as the API does: a members event whole for an officer, withheld for the public', async () => {
    const officer = await reads.occurrences(as('officer'), '2026-11-16', '2026-11-22');
    expect(officer.map((o) => [o.id, o.title])).toEqual([
      [`${LUNCH}:${WED}`, 'Wednesday Lunchers'],
      [`${MEMBERS}:${SUN}`, 'Members games night'],
    ]);
    const pub = await anonymous.list('2026-11-16', '2026-11-22');
    expect(pub[1]).toMatchObject({ id: `${MEMBERS}:${SUN}`, detailsWithheld: true, title: '' });
    expect((await reads.series(as('officer'))).map((s) => s.hostOfficeId)).toEqual([PRESIDENT.id, PRESIDENT.id]);
    expect((await reads.venues(as('officer'))).map((v) => v.name)).toEqual(['Sample Bistro', 'Placeholder Diner']);
    expect((await reads.occurrence(as('officer'), `${MEMBERS}:${SUN}`)).title).toBe('Members games night');
    await expect(reads.occurrence(as('officer'), `${LUNCH}:2026-11-19`)).rejects.toBeInstanceOf(ApiNotFound);
  });

  it('cancels a series date by <series>:<date>: every read has it at once, as its own stored event', async () => {
    const before = await reads.occurrence(as('officer'), `${LUNCH}:${WED}`);
    const saved = await writes.saveOccurrence(as('officer'), { id: before.id, status: OccurrenceStatus.CANCELLED, statusNote: 'Closed for a party', startsAt: before.startsAt, endsAt: before.endsAt, venueId: BISTRO.id, visibility: EventVisibility.PUBLIC });
    expect(saved.id).not.toBe(before.id);
    expect(saved).toMatchObject({ seriesId: LUNCH, title: 'Wednesday Lunchers', status: OccurrenceStatus.CANCELLED, statusNote: 'Closed for a party', ownerOfficeId: '', venueId: BISTRO.id });
    const pub = await anonymous.list(WED, WED);
    expect(pub.map((o) => [o.id, o.status])).toEqual([[saved.id, OccurrenceStatus.CANCELLED]]);
    // Found by either id; changed again by its own, which it keeps.
    expect((await reads.occurrence(as('officer'), `${LUNCH}:${WED}`)).id).toBe(saved.id);
    const again = await writes.saveOccurrence(as('officer'), { id: saved.id, status: OccurrenceStatus.SCHEDULED, startsAt: saved.startsAt, venueId: BISTRO.id, visibility: EventVisibility.PUBLIC });
    expect(again.id).toBe(saved.id);
    expect((await anonymous.list(WED, WED)).map((o) => o.status)).toEqual([OccurrenceStatus.SCHEDULED]);
    // A changed time stays on its day.
    const later = await writes.saveOccurrence(as('officer'), { id: saved.id, startsAt: timestampFromDate(new Date(`${WED}T19:00:00Z`)), visibility: EventVisibility.PUBLIC });
    expect(timestampDate(later.startsAt!).toISOString()).toBe(`${WED}T19:00:00.000Z`);
    expect(later.endsAt).toBeUndefined();
  });

  it('adds a one-off for an office, in the reads at once; a members one-off withheld from the public', async () => {
    const start = timestampFromDate(new Date('2027-03-14T15:00:00Z'));
    const saved = await writes.saveOccurrence(as('officer'), { id: '', title: 'Spring picnic', startsAt: start, ownerOfficeId: PRESIDENT.id, venueId: DINER.id, visibility: EventVisibility.MEMBERS, detail: 'Bring a chair.' });
    expect(saved).toMatchObject({ title: 'Spring picnic', ownerOfficeId: PRESIDENT.id, seriesId: '', status: OccurrenceStatus.SCHEDULED, localDate: protoDate('2027-03-14'), area: Area.BAY, venue: { name: 'Placeholder Diner' } });
    // 14 March 2027 is a Sunday: the members series' date is there too.
    expect((await reads.occurrences(as('officer'), '2027-03-14', '2027-03-14')).map((o) => o.title)).toEqual(['Members games night', 'Spring picnic']);
    expect((await anonymous.list('2027-03-14', '2027-03-14'))[1]).toMatchObject({ id: saved.id, detailsWithheld: true, title: '', detail: '' });
    expect(model.get(saved.id, 'public')).toMatchObject({ detailsWithheld: true });
    expect(model.get('nothing', 'public')).toBeUndefined();
  });

  it('lets an office change its own events, the Admin any, and refuses anyone else, changing nothing', async () => {
    const date = { id: `${LUNCH}:${WED}`, status: OccurrenceStatus.CANCELLED, visibility: EventVisibility.PUBLIC };
    await expect(writes.saveOccurrence(as('treasurer'), date)).rejects.toBeInstanceOf(NotAllowed);
    await expect(writes.saveOccurrence(as('officer-only'), date)).rejects.toBeInstanceOf(NotAllowed);
    await expect(writes.saveOccurrence(as('treasurer'), { id: '', title: 'x', startsAt: timestampFromDate(lunchAt(WED)), ownerOfficeId: PRESIDENT.id, visibility: EventVisibility.PUBLIC })).rejects.toBeInstanceOf(NotAllowed);
    // A one-off with no office is the Admin's alone.
    await expect(writes.saveOccurrence(as('officer'), { id: '', title: 'x', startsAt: timestampFromDate(lunchAt(WED)), visibility: EventVisibility.PUBLIC })).rejects.toBeInstanceOf(NotAllowed);
    expect((await anonymous.list(WED, WED)).map((o) => o.status)).toEqual([OccurrenceStatus.SCHEDULED]);
    const own = await writes.saveOccurrence(as('treasurer'), { id: '', title: 'Budget night', startsAt: timestampFromDate(lunchAt(WED)), ownerOfficeId: TREASURER.id, visibility: EventVisibility.PUBLIC });
    await expect(writes.saveOccurrence(as('officer'), { id: own.id, visibility: EventVisibility.PUBLIC })).rejects.toBeInstanceOf(NotAllowed);
    const byAdmin = await writes.saveOccurrence(as('admin'), { id: own.id, title: 'Budget night (changed by the Admin)', startsAt: own.startsAt, visibility: EventVisibility.PUBLIC });
    expect(byAdmin).toMatchObject({ id: own.id, ownerOfficeId: TREASURER.id, title: 'Budget night (changed by the Admin)' });
    expect((await writes.saveOccurrence(as('admin'), date)).status).toBe(OccurrenceStatus.CANCELLED);
  });

  it('refuses what the API refuses, with its words', async () => {
    const refusal = async (occurrence: Parameters<EditorApi['saveOccurrence']>[1]) => {
      const error = await writes.saveOccurrence(as('officer'), occurrence).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(EditorRefused);
      return (error as EditorRefused).reason;
    };
    const start = timestampFromDate(lunchAt(WED));
    expect(await refusal({ id: `${LUNCH}:${WED}`, url: 'http://example.org/', detail: 'Fine https://example.org/a\nSee https://user:pw@example.org/ or https://example.org:8080/x.', visibility: EventVisibility.PUBLIC })).toBe(
      'url: the address "http://example.org/" must start with https://, not http://; ' +
        'detail line 2: the address "https://user:pw@example.org/" has a user name or password in it (the part before an @), which is not allowed; ' +
        'detail line 2: the address "https://example.org:8080/x" names a port (a colon and a number after the site name), which is not allowed',
    );
    expect(await refusal({ id: `${LUNCH}:${WED}`, url: 'ftp://example.org', visibility: EventVisibility.PUBLIC })).toBe('url: the address "ftp://example.org" is not a web address starting with https:// or an email address starting with mailto:');
    expect(await refusal({ id: `${LUNCH}:${WED}`, url: 'mailto:a@example.org', visibility: EventVisibility.PUBLIC })).toBe('url: the address "mailto:a@example.org" is an email address, but this needs a web address starting with https://');
    expect(await refusal({ id: `${LUNCH}:${WED}`, url: 'https://127.0.0.1/', visibility: EventVisibility.PUBLIC })).toBe('url: the address "https://127.0.0.1/" uses a number (an IP address) instead of a site name');
    expect(await refusal({ id: `${LUNCH}:${WED}`, url: 'https://intranet/', visibility: EventVisibility.PUBLIC })).toBe('url: the address "https://intranet/" has no dot in its site name (a local name such as localhost)');
    expect(await refusal({ id: `${LUNCH}:${WED}`, url: 'HTTPS://example.org/', visibility: EventVisibility.PUBLIC })).toBe('url: the address "HTTPS://example.org/" must be written plainly: https:// or mailto: in lower case, and no spaces');
    expect(await refusal({ id: `${LUNCH}:${WED}`, url: `https://example.org/${'a'.repeat(2048)}`, visibility: EventVisibility.PUBLIC })).toMatch(/is longer than 2048 characters$/);
    expect(await refusal({ id: `${LUNCH}:${WED}`, detail: 'Go to www.example.org today', visibility: EventVisibility.PUBLIC })).toBe('detail line 1: the address "www.example.org" must be written in full, starting with https://');
    expect(await refusal({ id: 'not-an-id', visibility: EventVisibility.PUBLIC })).toBe('malformed occurrence id');
    expect(await refusal({ id: '', ownerOfficeId: PRESIDENT.id, startsAt: start, visibility: EventVisibility.PUBLIC })).toBe('a value is not allowed');
    expect(await refusal({ id: '', title: 'x', ownerOfficeId: PRESIDENT.id, visibility: EventVisibility.PUBLIC })).toBe('starts_at is required');
    expect(await refusal({ id: '', title: 'x', ownerOfficeId: PRESIDENT.id, startsAt: start })).toBe('visibility is required');
    expect(await refusal({ id: '', title: 'x', ownerOfficeId: PRESIDENT.id, startsAt: start, venueId: 'nowhere', visibility: EventVisibility.PUBLIC })).toBe('venue_id is not an id');
    expect(await refusal({ id: '', title: 'x', ownerOfficeId: PRESIDENT.id, startsAt: start, endsAt: start, visibility: EventVisibility.PUBLIC })).toBe('a value is not allowed');
    expect(await refusal({ id: `${LUNCH}:${WED}`, ownerOfficeId: TREASURER.id, visibility: EventVisibility.PUBLIC })).toBe('an occurrence keeps its series and its owning office');
    await expect(writes.saveOccurrence(as('officer'), { id: `${LUNCH}:2026-11-19`, visibility: EventVisibility.PUBLIC })).rejects.toBeInstanceOf(ApiNotFound);
    await expect(writes.saveOccurrence(as('officer'), { id: 'c0000000-0000-4000-8000-0000000000ff', visibility: EventVisibility.PUBLIC })).rejects.toBeInstanceOf(ApiNotFound);
    expect((await anonymous.list(WED, WED)).map((o) => [o.status, o.url])).toEqual([[OccurrenceStatus.SCHEDULED, '']]);
  });

  it("gives a series date its series' venue on a first change with none, and a stored one none", async () => {
    const first = await writes.saveOccurrence(as('officer'), { id: `${LUNCH}:${WED}`, venueId: '', visibility: EventVisibility.PUBLIC });
    expect(first.venueId).toBe(BISTRO.id);
    const second = await writes.saveOccurrence(as('officer'), { id: first.id, venueId: '', visibility: EventVisibility.PUBLIC });
    // The area is the series' then (events/service.ts areaOf).
    expect(second).toMatchObject({ id: first.id, venueId: '', area: Area.OKALOOSA });
    expect(second.venue).toBeUndefined();
  });
});
