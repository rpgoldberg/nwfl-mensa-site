import { type MessageInitShape, create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { describe, expect, it } from 'vitest';
import { ContentItemSchema, ContentKind, type ContentItem, ItemVisibility } from '../gen/nwfl/mensa/v1/content_pb.js';
import {
  Area,
  EventOccurrenceSchema,
  type EventOccurrence,
  EventSeriesSchema,
  EventVisibility,
  OccurrenceStatus,
  VenueKind,
} from '../gen/nwfl/mensa/v1/event_pb.js';
import { OfficeSchema, TermStatus } from '../gen/nwfl/mensa/v1/roster_pb.js';
import { ApiNotFound, type ApiReads, ApiUnavailable } from '../lib/api/client';
import { MEMBERS_PASSAGE } from '../lib/document';
import { isPublicEvent, liveData } from './live';

const SERIES = '0b9c1f5e-4c1a-4d55-9a3e-2f7d8e6a1b20';
const ONE_OFF = '7d3e2a10-5b6c-4f7d-8e9f-0a1b2c3d4e5f';
const PRESIDENT = '11111111-1111-4111-8111-111111111111';
const SOCIAL = '22222222-2222-4222-8222-222222222222';

type OccurrenceInit = Exclude<MessageInitShape<typeof EventOccurrenceSchema>, EventOccurrence>;

const occurrence = (over: OccurrenceInit = {}): EventOccurrence =>
  create(EventOccurrenceSchema, {
    id: `${SERIES}:2026-11-04`,
    seriesId: SERIES,
    title: 'Wednesday Lunchers',
    startsAt: timestampFromDate(new Date('2026-11-04T17:30:00Z')),
    endsAt: timestampFromDate(new Date('2026-11-04T19:00:00Z')),
    venueId: 'v1',
    venue: { id: 'v1', kind: VenueKind.BUSINESS, name: 'Sample Bistro', businessAddress: '100 Example Way', city: 'Destin', area: Area.OKALOOSA, url: 'https://example.org/bistro', active: true },
    status: OccurrenceStatus.SCHEDULED,
    visibility: EventVisibility.PUBLIC,
    localDate: { year: 2026, month: 11, day: 4 },
    area: Area.OKALOOSA,
    ...over,
  });

/** What the API sends the public for a members event: the date, the area, and nothing else. */
const withheld = (date: string) =>
  create(EventOccurrenceSchema, {
    id: `${SERIES}:${date}`,
    localDate: { year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)), day: Number(date.slice(8, 10)) },
    area: Area.BAY,
    visibility: EventVisibility.MEMBERS,
    detailsWithheld: true,
  });

const item = (slug: string, over: { visibility?: ItemVisibility; kind?: ContentKind; approvedAt?: Date } = {}): ContentItem =>
  create(ContentItemSchema, {
    id: slug,
    slug,
    kind: over.kind ?? ContentKind.TREASURER_SUMMARY,
    live: {
      title: `Title of ${slug}`,
      summary: `Summary of ${slug}`,
      visibility: over.visibility ?? ItemVisibility.PUBLIC,
      approvedAt: timestampFromDate(over.approvedAt ?? new Date('2026-09-20T03:00:00Z')),
      body: { blocks: [{ kind: { case: 'paragraph', value: { inlines: [{ kind: { case: 'text', value: { text: `Body of ${slug} & more` } } }] } } }, { kind: { case: 'redacted', value: {} } }] },
    },
  });

function reads(over: Partial<ApiReads> = {}): ApiReads {
  return {
    listOccurrences: () => Promise.resolve([]),
    getOccurrence: () => Promise.reject(new ApiNotFound('GetOccurrence')),
    listSeries: () => Promise.resolve([]),
    getRoster: () => Promise.resolve([]),
    listPublishedItems: () => Promise.resolve([]),
    ...over,
  };
}

describe('isPublicEvent', () => {
  it('is true only for a public event the API sent in full, with a status', () => {
    expect(isPublicEvent(occurrence())).toBe(true);
    expect(isPublicEvent(withheld('2026-11-07'))).toBe(false);
    expect(isPublicEvent(occurrence({ visibility: EventVisibility.MEMBERS }))).toBe(false);
    expect(isPublicEvent(occurrence({ visibility: EventVisibility.UNSPECIFIED }))).toBe(false);
    expect(isPublicEvent(occurrence({ detailsWithheld: true }))).toBe(false);
    expect(isPublicEvent(occurrence({ status: OccurrenceStatus.UNSPECIFIED }))).toBe(false);
    expect(isPublicEvent(occurrence({ localDate: undefined }))).toBe(false);
  });
});

describe('liveData.events', () => {
  it('asks for the range, and keeps public events only: never a members event, whether or not the API withheld its details', async () => {
    const asked: string[][] = [];
    const live = liveData(
      reads({
        listOccurrences: (from, to) => {
          asked.push([from, to]);
          return Promise.resolve([
            occurrence(),
            withheld('2026-11-07'),
            occurrence({ id: ONE_OFF, title: 'Members picnic', visibility: EventVisibility.MEMBERS }),
            occurrence({ id: 'x', title: 'No status', status: OccurrenceStatus.UNSPECIFIED }),
          ]);
        },
      }),
    );
    const events = await live.events('2026-11-01', '2026-11-30');
    expect(asked).toEqual([['2026-11-01', '2026-11-30']]);
    expect(events.map((e) => e.title)).toEqual(['Wednesday Lunchers']);
  });

  it('shows the event in Central time, at its venue, in its area, as content an officer submitted', async () => {
    const [event] = await liveData(reads({ listOccurrences: () => Promise.resolve([occurrence({ detail: 'At the back', url: 'https://example.org/menu' })]) })).events('2026-11-01', '2026-11-30');
    expect(event).toEqual({
      id: `${SERIES}:2026-11-04`,
      path: `/calendar/event/${SERIES}_2026-11-04`,
      title: 'Wednesday Lunchers',
      date: '2026-11-04',
      start: '11:30',
      end: { date: '2026-11-04', time: '13:00' },
      status: 'scheduled',
      statusNote: '',
      detail: 'At the back',
      url: 'https://example.org/menu',
      venue: { kind: 'business', name: 'Sample Bistro', address: '100 Example Way', city: 'Destin', url: 'https://example.org/bistro', accessibilityNote: '', hostOfficeId: '' },
      area: 'Okaloosa County',
      seriesId: SERIES,
      ownerOfficeId: '',
      source: 'submitted',
    });
  });

  it('keeps cancelled, tentative and moved events, each with its status', async () => {
    const statuses = [OccurrenceStatus.CANCELLED, OccurrenceStatus.TENTATIVE, OccurrenceStatus.MOVED];
    const events = await liveData(reads({ listOccurrences: () => Promise.resolve(statuses.map((status) => occurrence({ status }))) })).events('2026-11-01', '2026-11-30');
    expect(events.map((e) => e.status)).toEqual(['cancelled', 'tentative', 'moved']);
  });

  it("never shows a member's home's address, whatever the API sent, and only https links", async () => {
    const [home, online, unsure] = await liveData(
      reads({
        listOccurrences: () =>
          Promise.resolve([
            occurrence({ url: 'javascript:alert(1)', venue: { kind: VenueKind.MEMBER_HOME, name: "A member's home", businessAddress: '1 Private Lane', city: 'Niceville', hostOfficeId: PRESIDENT, url: 'http://example.org/x', area: Area.OKALOOSA } }),
            occurrence({ area: Area.VIRTUAL, venue: { kind: VenueKind.VIRTUAL, name: 'Video call', url: 'https://example.org/meet' } }),
            occurrence({ venueId: '', venue: undefined, startsAt: undefined, endsAt: undefined, area: Area.ESCAMBIA_SANTA_ROSA }),
          ]),
      }),
    ).events('2026-11-01', '2026-11-30');
    expect(home!.venue).toEqual({ kind: 'home', name: "A member's home", address: '', city: '', url: undefined, accessibilityNote: '', hostOfficeId: PRESIDENT });
    expect(home!.url).toBeUndefined();
    expect(online!.venue).toMatchObject({ kind: 'virtual', name: 'Video call', url: 'https://example.org/meet' });
    expect(online!.area).toBe('Online');
    expect(unsure).toMatchObject({ venue: undefined, start: undefined, end: undefined, area: 'Escambia and Santa Rosa Counties' });
  });

  it('passes an unavailable API on to the page', async () => {
    await expect(liveData(reads({ listOccurrences: () => Promise.reject(new ApiUnavailable('ListOccurrences')) })).events('2026-11-01', '2026-11-30')).rejects.toBeInstanceOf(ApiUnavailable);
  });
});

describe('liveData.event', () => {
  const roster = () =>
    Promise.resolve([
      create(OfficeSchema, { id: PRESIDENT, slug: 'president', title: 'President', roleAlias: 'president@nwflorida.us' }),
      create(OfficeSchema, { id: SOCIAL, slug: 'social', title: 'Social Chair', roleAlias: '' }),
    ]);

  it('gives the event with its series (how often, what it is) and who to ask, by role address', async () => {
    const live = liveData(
      reads({
        getOccurrence: (id) => {
          expect(id).toBe(`${SERIES}:2026-11-04`);
          return Promise.resolve(occurrence());
        },
        listSeries: () => Promise.resolve([create(EventSeriesSchema, { id: SERIES, title: 'Wednesday Lunchers', cadenceLabel: 'Every Wednesday', description: 'Lunch, every week.', hostOfficeId: PRESIDENT })]),
        getRoster: roster,
      }),
    );
    expect(await live.event(`${SERIES}:2026-11-04`)).toMatchObject({ event: { title: 'Wednesday Lunchers' }, cadence: 'Every Wednesday', about: 'Lunch, every week.', contact: 'president@nwflorida.us' });
  });

  it("asks a one-off event's own office, and a member's home's host; an alias not yet known to work is not shown", async () => {
    const oneOff = liveData(reads({ getOccurrence: () => Promise.resolve(occurrence({ id: ONE_OFF, seriesId: '', ownerOfficeId: SOCIAL })), getRoster: roster }));
    expect(await oneOff.event(ONE_OFF)).toMatchObject({ cadence: '', about: '', contact: undefined });
    const home = liveData(reads({ getOccurrence: () => Promise.resolve(occurrence({ id: ONE_OFF, seriesId: '', ownerOfficeId: SOCIAL, venue: { kind: VenueKind.MEMBER_HOME, name: "A member's home", hostOfficeId: PRESIDENT } })), getRoster: roster }));
    expect(await home.event(ONE_OFF)).toMatchObject({ contact: 'president@nwflorida.us' });
  });

  it('is not found for a members event, for one the API does not have, and for an id that is not one', async () => {
    expect(await liveData(reads({ getOccurrence: () => Promise.resolve(withheld('2026-11-07')), getRoster: roster })).event(`${SERIES}:2026-11-07`)).toBeUndefined();
    expect(await liveData(reads({ getOccurrence: () => Promise.resolve(occurrence({ visibility: EventVisibility.MEMBERS })), getRoster: roster })).event(ONE_OFF)).toBeUndefined();
    expect(await liveData(reads({ getOccurrence: () => Promise.resolve(undefined) })).event(ONE_OFF)).toBeUndefined();
    expect(await liveData(reads()).event(ONE_OFF)).toBeUndefined();
  });

  it('passes an unavailable API on to the page', async () => {
    await expect(liveData(reads({ getOccurrence: () => Promise.reject(new ApiUnavailable('GetOccurrence')) })).event(ONE_OFF)).rejects.toBeInstanceOf(ApiUnavailable);
  });
});

describe('liveData.offices (R2)', () => {
  it('lists every holder of a seat that has several, such as two Members at Large, and marks an acting holder', async () => {
    const offices = await liveData(
      reads({
        getRoster: () =>
          Promise.resolve([
            create(OfficeSchema, { slug: 'president', title: 'President', roleAlias: 'president@nwflorida.us', terms: [{ holderDisplayName: 'Alex Sample', status: TermStatus.ACTIVE }] }),
            create(OfficeSchema, {
              slug: 'member-at-large',
              title: 'Member at Large',
              roleAlias: 'mal@nwflorida.us',
              terms: [
                { holderDisplayName: 'Casey Placeholder', status: TermStatus.ACTIVE },
                { holderDisplayName: 'Jordan Example', status: TermStatus.ACTIVE },
              ],
            }),
            create(OfficeSchema, { slug: 'treasurer', title: 'Treasurer', roleAlias: '', terms: [{ holderDisplayName: 'Riley Testcase', status: TermStatus.ACTING }] }),
            create(OfficeSchema, { slug: 'membership', title: 'Membership Officer', roleAlias: 'membership@nwflorida.us', terms: [{ holderDisplayName: '', status: TermStatus.VACANT }] }),
            create(OfficeSchema, { slug: 'editor', title: 'Newsletter Editor', roleAlias: 'editor@nwflorida.us' }),
          ]),
      }),
    ).offices();
    expect(offices).toEqual([
      { slug: 'president', title: 'President', holders: ['Alex Sample'], alias: 'president@nwflorida.us', aliasVerified: true, source: 'submitted' },
      { slug: 'member-at-large', title: 'Member at Large', holders: ['Casey Placeholder', 'Jordan Example'], alias: 'mal@nwflorida.us', aliasVerified: true, source: 'submitted' },
      { slug: 'treasurer', title: 'Treasurer', holders: ['Riley Testcase (acting)'], alias: '', aliasVerified: false, source: 'submitted' },
      { slug: 'membership', title: 'Membership Officer', holders: [], alias: 'membership@nwflorida.us', aliasVerified: true, source: 'submitted' },
      { slug: 'editor', title: 'Newsletter Editor', holders: [], alias: 'editor@nwflorida.us', aliasVerified: true, source: 'submitted' },
    ]);
  });
});

describe('liveData items', () => {
  it("gives the treasurer's published summaries, public ones only, with their bodies rendered and the day each was published", async () => {
    const asked: [ContentKind, number][] = [];
    const summaries = await liveData(
      reads({
        listPublishedItems: (kind, size) => {
          asked.push([kind, size]);
          return Promise.resolve([item('q3'), item('members-only', { visibility: ItemVisibility.MEMBERS }), item('q2', { approvedAt: new Date('2026-06-21T04:30:00Z') })]);
        },
      }),
    ).treasurerSummaries();
    expect(asked).toEqual([[ContentKind.TREASURER_SUMMARY, 12]]);
    expect(summaries).toEqual([
      { slug: 'q3', title: 'Title of q3', summary: 'Summary of q3', bodyHtml: `<p>Body of q3 &amp; more</p><p class="members-note">${MEMBERS_PASSAGE}</p>`, publishedOn: '2026-09-19', source: 'submitted' },
      { slug: 'q2', title: 'Title of q2', summary: 'Summary of q2', bodyHtml: `<p>Body of q2 &amp; more</p><p class="members-note">${MEMBERS_PASSAGE}</p>`, publishedOn: '2026-06-20', source: 'submitted' },
    ]);
  });

  it("gives the President's latest public report and the latest public announcements", async () => {
    const live = liveData(
      reads({
        listPublishedItems: (kind) =>
          Promise.resolve(
            kind === ContentKind.PRESIDENT_REPORT
              ? [item('members-report', { visibility: ItemVisibility.MEMBERS }), item('october', { kind }), item('september', { kind })]
              : [item('dues', { kind }), item('picnic', { kind })],
          ),
      }),
    );
    expect((await live.presidentReport())?.slug).toBe('october');
    expect((await live.announcements()).map((a) => a.slug)).toEqual(['dues', 'picnic']);
    expect(await liveData(reads()).presidentReport()).toBeUndefined();
  });

  it('leaves the date out when an item has none, and gives an empty body as nothing', async () => {
    const bare = create(ContentItemSchema, { slug: 'bare', live: { title: 'Bare', visibility: ItemVisibility.PUBLIC } });
    const [summary] = await liveData(reads({ listPublishedItems: () => Promise.resolve([bare, create(ContentItemSchema, { slug: 'no-version' })]) })).treasurerSummaries();
    expect(summary).toEqual({ slug: 'bare', title: 'Bare', summary: '', bodyHtml: '', publishedOn: undefined, source: 'submitted' });
  });
});
