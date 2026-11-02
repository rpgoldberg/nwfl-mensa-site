import { type MessageInitShape, create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { describe, expect, it } from 'vitest';
import { BlockSchema, ContentItemSchema, ContentKind, type ContentItem, FileAudience, FileRole, ItemVisibility } from '../gen/nwfl/mensa/v1/content_pb.js';
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
import { ApiNotFound, type ApiReads, ApiTokenRefused, ApiUnavailable, type Reader } from '../lib/api/client';
import { MEMBERS_PASSAGE, NOT_SHOWN, NO_MEMBER_ACCESS } from '../lib/document';
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
    readFile: () => Promise.resolve({ kind: 'not_found' }),
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
      path: `/events/${SERIES}_2026-11-04`,
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
      { slug: 'q3', title: 'Title of q3', summary: 'Summary of q3', bodyHtml: `<p>Body of q3 &amp; more</p><p class="members-note">${MEMBERS_PASSAGE}</p>`, publishedOn: '2026-09-19', source: 'submitted', files: [] },
      { slug: 'q2', title: 'Title of q2', summary: 'Summary of q2', bodyHtml: `<p>Body of q2 &amp; more</p><p class="members-note">${MEMBERS_PASSAGE}</p>`, publishedOn: '2026-06-20', source: 'submitted', files: [] },
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
    expect(summary).toEqual({ slug: 'bare', title: 'Bare', summary: '', bodyHtml: '', publishedOn: undefined, source: 'submitted', files: [] });
  });

  // REDACT R2b: an item with anything withheld from the public comes with its id in the slug field (R2a).
  it('keys an item by whatever the API put in the slug field, its id when the slug is withheld, and never by nothing', async () => {
    const ID = '9c51279e-6426-43e6-a52c-3fa78711e10b';
    const withheld = create(ContentItemSchema, { id: ID, slug: ID, live: { title: 'Report by [withheld]', visibility: ItemVisibility.PUBLIC } });
    const unmarked = create(ContentItemSchema, { id: 'b0e5a1d2-0000-4000-8000-000000000001', slug: 'april-to-june', live: { title: 'April to June', visibility: ItemVisibility.PUBLIC } });
    const noSlug = create(ContentItemSchema, { id: 'b0e5a1d2-0000-4000-8000-000000000002', slug: '', live: { title: 'No slug', visibility: ItemVisibility.PUBLIC } });
    const summaries = await liveData(reads({ listPublishedItems: () => Promise.resolve([withheld, unmarked, noSlug]) })).treasurerSummaries();
    expect(summaries.map((s) => s.slug)).toEqual([ID, 'april-to-june', 'b0e5a1d2-0000-4000-8000-000000000002']);
  });
});

// REDACT R3c: an item's PDFs, linked where the item renders, and served through the site.
describe('liveData files', () => {
  const FILE = '3e4f5a6b-7c8d-4e9f-a0b1-c2d3e4f5a6b7';

  it("links an item's public PDFs, by id, and nothing else it carries", async () => {
    const withFiles = create(ContentItemSchema, {
      slug: 'q3',
      live: {
        title: 'Q3',
        visibility: ItemVisibility.PUBLIC,
        files: [
          { id: FILE, filename: 'Q3 summary.pdf', mimeType: 'application/pdf', audience: FileAudience.PUBLIC, role: FileRole.PRIMARY },
          { id: 'b0e5a1d2-0000-4000-8000-000000000001', filename: 'members.pdf', mimeType: 'application/pdf', audience: FileAudience.MEMBERS, role: FileRole.PRIMARY },
          { id: 'b0e5a1d2-0000-4000-8000-000000000002', filename: 'photo.jpg', mimeType: 'image/jpeg', audience: FileAudience.PUBLIC, role: FileRole.PRIMARY },
          { id: 'b0e5a1d2-0000-4000-8000-000000000003', filename: 'source.pdf', mimeType: 'application/pdf', audience: FileAudience.PUBLIC, role: FileRole.SOURCE },
          { id: 'not-an-id', filename: 'odd.pdf', mimeType: 'application/pdf', audience: FileAudience.PUBLIC, role: FileRole.PRIMARY },
        ],
      },
    });
    const [summary] = await liveData(reads({ listPublishedItems: () => Promise.resolve([withFiles]) })).treasurerSummaries();
    expect(summary?.files).toEqual([{ href: `/documents/${FILE}.pdf`, label: 'Q3 summary.pdf' }]);
  });

  it('reads a file by id, and never asks the API for something that is not an id', async () => {
    const asked: string[] = [];
    const live = liveData(
      reads({
        readFile: (id) => {
          asked.push(id);
          return Promise.resolve({ kind: 'not_ready' });
        },
      }),
    );
    expect(await live.file(FILE)).toEqual({ kind: 'not_ready' });
    expect(await live.file('../etc/passwd')).toEqual({ kind: 'not_found' });
    expect(await live.file(FILE.toUpperCase())).toEqual({ kind: 'not_found' });
    expect(asked).toEqual([FILE]);
  });
});

// The newsletter on /news: the issue loader's items (apps/api README, "Loading a newsletter issue"):
// one public DOCUMENT per issue, titled "Pensa Mensa, <Month>-<Month> <Year>", volume and number in
// the summary, holding a public PDF and a members PDF. Made-up ids and hashes only.
describe('liveData.issues (the newsletter)', () => {
  const ID = { oct: 'd0c00000-0000-4000-8000-000000000010', aug: 'd0c00000-0000-4000-8000-000000000008', jun: 'd0c00000-0000-4000-8000-000000000006' };
  const PUBLIC_PDF = { oct: 'f0000000-0000-4000-8000-000000000010', aug: 'f0000000-0000-4000-8000-000000000008', jun: 'f0000000-0000-4000-8000-000000000006' };
  const MEMBERS_PDF = { oct: 'f1000000-0000-4000-8000-000000000010', aug: 'f1000000-0000-4000-8000-000000000008', jun: 'f1000000-0000-4000-8000-000000000006' };
  const SHA = new Uint8Array(32).fill(0xab);
  const SIZE = 987_654n;

  const issue = (
    title: string,
    over: { id?: string; slug?: string; summary?: string; kind?: ContentKind; visibility?: ItemVisibility; files?: { id: string; audience: FileAudience; mimeType?: string; role?: FileRole }[]; approvedAt?: Date } = {},
  ): ContentItem =>
    create(ContentItemSchema, {
      id: over.id ?? ID.oct,
      slug: over.slug ?? 'pensa-mensa-2026-10',
      kind: over.kind ?? ContentKind.DOCUMENT,
      live: {
        title,
        summary: over.summary ?? 'Volume 30, Number 5',
        visibility: over.visibility ?? ItemVisibility.PUBLIC,
        approvedAt: timestampFromDate(over.approvedAt ?? new Date('2026-10-02T15:00:00Z')),
        files: (over.files ?? [{ id: PUBLIC_PDF.oct, audience: FileAudience.PUBLIC }, { id: MEMBERS_PDF.oct, audience: FileAudience.MEMBERS }]).map((f) => ({
          id: f.id,
          filename: `${f.id}.pdf`,
          mimeType: f.mimeType ?? 'application/pdf',
          sizeBytes: SIZE,
          sha256: SHA,
          audience: f.audience,
          role: f.role ?? FileRole.PRIMARY,
        })),
      },
    });

  const files = (key: keyof typeof ID) => [
    { id: MEMBERS_PDF[key], audience: FileAudience.MEMBERS },
    { id: PUBLIC_PDF[key], audience: FileAudience.PUBLIC },
  ];

  it('asks for every published document, and lists the issues newest first by the months their titles name, each with its public PDF', async () => {
    const asked: [ContentKind, number][] = [];
    const issues = await liveData(
      reads({
        listPublishedItems: (kind, size) => {
          asked.push([kind, size]);
          // In the order the API gives: the last approved first, which is not the newest issue.
          return Promise.resolve([
            issue('Pensa Mensa, June-July 2026', { id: ID.jun, slug: 'pensa-mensa-2026-06', summary: 'Volume 30, Number 3', files: files('jun'), approvedAt: new Date('2026-10-20T15:00:00Z') }),
            issue('Pensa Mensa, October-November 2026', { files: files('oct') }),
            issue('Pensa Mensa, August-September 2026', { id: ID.aug, slug: 'pensa-mensa-2026-08', summary: 'Volume 30, Number 4', files: files('aug'), approvedAt: new Date('2026-08-02T15:00:00Z') }),
          ]);
        },
      }),
    ).issues();
    expect(asked).toEqual([[ContentKind.DOCUMENT, 50]]);
    expect(issues).toEqual([
      { period: '2026-10', label: 'Pensa Mensa, October-November 2026', summary: 'Volume 30, Number 5', pdf: `/documents/${PUBLIC_PDF.oct}.pdf`, source: 'pipeline' },
      { period: '2026-08', label: 'Pensa Mensa, August-September 2026', summary: 'Volume 30, Number 4', pdf: `/documents/${PUBLIC_PDF.aug}.pdf`, source: 'pipeline' },
      { period: '2026-06', label: 'Pensa Mensa, June-July 2026', summary: 'Volume 30, Number 3', pdf: `/documents/${PUBLIC_PDF.jun}.pdf`, source: 'pipeline' },
    ]);
  });

  it('never lists or links a members or officers file, nor the hash or size of any file', async () => {
    const issues = await liveData(
      reads({
        listPublishedItems: () =>
          Promise.resolve([
            issue('Pensa Mensa, October-November 2026', {
              files: [
                { id: MEMBERS_PDF.oct, audience: FileAudience.MEMBERS },
                { id: MEMBERS_PDF.aug, audience: FileAudience.OFFICERS },
                { id: PUBLIC_PDF.oct, audience: FileAudience.PUBLIC },
              ],
            }),
            // An issue the API sent with its members file and no public one, as a buggy API might: not listed at all.
            issue('Pensa Mensa, August-September 2026', { id: ID.aug, files: [{ id: MEMBERS_PDF.jun, audience: FileAudience.MEMBERS }] }),
          ]),
      }),
    ).issues();
    expect(issues.map((i) => i.pdf)).toEqual([`/documents/${PUBLIC_PDF.oct}.pdf`]);
    const text = JSON.stringify(issues);
    for (const id of Object.values(MEMBERS_PDF)) expect(text).not.toContain(id);
    expect(text).not.toMatch(/abab|987654|987,654/i);
    expect(Object.keys(issues[0]!).sort()).toEqual(['label', 'pdf', 'period', 'source', 'summary']);
  });

  it("links only a public PDF that is the issue's own: never a source file, another type, or a file whose id is not one", async () => {
    const only = (f: { id: string; audience: FileAudience; mimeType?: string; role?: FileRole }) => issue('Pensa Mensa, October-November 2026', { files: [f] });
    const issues = await liveData(
      reads({
        listPublishedItems: () =>
          Promise.resolve([
            only({ id: PUBLIC_PDF.oct, audience: FileAudience.PUBLIC, role: FileRole.SOURCE }),
            only({ id: PUBLIC_PDF.aug, audience: FileAudience.PUBLIC, mimeType: 'image/jpeg' }),
            only({ id: 'not-an-id', audience: FileAudience.PUBLIC }),
            only({ id: PUBLIC_PDF.jun, audience: FileAudience.UNSPECIFIED }),
          ]),
      }),
    ).issues();
    expect(issues).toEqual([]);
  });

  it('lists the newsletter only: not another document, a members or officers item, another kind, or a title outside the contract', async () => {
    const issues = await liveData(
      reads({
        listPublishedItems: () =>
          Promise.resolve([
            issue('Our bylaws'),
            issue('Pensa Mensa, October-November 2026', { visibility: ItemVisibility.MEMBERS }),
            issue('Pensa Mensa, October-November 2026', { visibility: ItemVisibility.OFFICERS }),
            issue('Pensa Mensa, October-November 2026', { kind: ContentKind.ANNOUNCEMENT }),
            issue('Pensa Mensa, October-December 2026'),
            issue('Pensa Mensa, November-October 2026'),
            issue('Pensa Mensa, December-January 2026'),
            issue('Pensa Mensa, October-November 26'),
            issue('Pensa Mensa, October-November 2026, extra'),
            issue('pensa mensa, october-november 2026'),
            issue('Pensa Mensa, [withheld]-November 2026'),
            create(ContentItemSchema, { id: ID.jun, slug: 'pensa-mensa-2026-06', kind: ContentKind.DOCUMENT }),
          ]),
      }),
    ).issues();
    expect(issues).toEqual([]);
  });

  it('keeps the title and summary as the API gave them, withheld text included', async () => {
    const [one] = await liveData(reads({ listPublishedItems: () => Promise.resolve([issue('Pensa Mensa, January-February 2027', { summary: 'Volume 31, Number [withheld]' })]) })).issues();
    expect(one).toMatchObject({ period: '2027-01', label: 'Pensa Mensa, January-February 2027', summary: 'Volume 31, Number [withheld]' });
  });

  // The API puts the item's id in the slug field when anything in the item is withheld (REDACT R2a);
  // a file-marked quote in a title does not (it is not counted), so the slug carries no meaning here.
  it("shows an issue the same whether the API gave its slug or its id in the slug field", async () => {
    const read = (slug: string) => liveData(reads({ listPublishedItems: () => Promise.resolve([issue('Pensa Mensa, October-November 2026', { slug })]) })).issues();
    const bySlug = await read('pensa-mensa-2026-10');
    const byId = await read(ID.oct);
    expect(byId).toEqual(bySlug);
    expect(byId).toHaveLength(1);
    expect(JSON.stringify(byId)).not.toContain(ID.oct);
    // A slug that says something else is not believed either: the title decides.
    expect(await read('pensa-mensa-1999-01')).toEqual(bySlug);
  });

  it('passes an unavailable API on to the page', async () => {
    await expect(liveData(reads({ listPublishedItems: () => Promise.reject(new ApiUnavailable('ListPublishedItems')) })).issues()).rejects.toBeInstanceOf(ApiUnavailable);
  });
});

// A14 (S5a, S5b): /news as a signed-in reader. The API decides the audience from the token; the site
// shows what the API sent for it, never more: members items and files only when the API answered as
// for a member, never an officers item or file, never a source file, and no state between readers.
describe('liveData.news', () => {
  const member: Reader = { bearer: 'member.token' };
  const UUIDS = {
    issue: 'd0c00000-0000-4000-8000-000000000010',
    issuePublic: 'f0000000-0000-4000-8000-000000000010',
    issueMembers: 'f1000000-0000-4000-8000-000000000010',
    issueOfficers: 'f2000000-0000-4000-8000-000000000010',
    issueSource: 'f3000000-0000-4000-8000-000000000010',
    issueMembersCopy: 'f4000000-0000-4000-8000-000000000010',
    issueMembersJpeg: 'f5000000-0000-4000-8000-000000000010',
    articlePublic: 'e0000000-0000-4000-8000-000000000001',
    articleMembers: 'e1000000-0000-4000-8000-000000000001',
    articleOfficers: 'e2000000-0000-4000-8000-000000000001',
    articleSource: 'e4000000-0000-4000-8000-000000000001',
    articleMembersCopy: 'e5000000-0000-4000-8000-000000000001',
    articleMembersJpeg: 'e6000000-0000-4000-8000-000000000001',
  };
  type FileInit = { id: string; audience: FileAudience; role?: FileRole; mimeType?: string };
  const stored = (f: FileInit) => ({ id: f.id, filename: `${f.id.slice(0, 2)}.pdf`, mimeType: f.mimeType ?? 'application/pdf', audience: f.audience, role: f.role ?? FileRole.PRIMARY, sizeBytes: 5n });
  const issueItem = (files: FileInit[]) =>
    create(ContentItemSchema, { id: UUIDS.issue, slug: 'pensa-mensa-2026-10', kind: ContentKind.DOCUMENT, live: { title: 'Pensa Mensa, October-November 2026', summary: 'Volume 30, Number 5', visibility: ItemVisibility.PUBLIC, files: files.map(stored) } });
  const passage = (text: string) => ({ kind: { case: 'members' as const, value: { blocks: [{ kind: { case: 'paragraph' as const, value: { inlines: [{ kind: { case: 'text' as const, value: { text } } }] } } }] } } });
  const redacted = { kind: { case: 'redacted' as const, value: {} } };
  const article = (slug: string, visibility: ItemVisibility, blocks: unknown[], files: FileInit[] = []) =>
    create(ContentItemSchema, {
      id: slug,
      slug,
      kind: ContentKind.ARTICLE,
      live: { title: `Title of ${slug}`, summary: `Summary of ${slug}`, visibility, approvedAt: timestampFromDate(new Date('2026-10-20T15:00:00Z')), body: { blocks: blocks as never }, files: files.map(stored) },
    });

  /**
   * What the API sends a member: their tree, members files, members items. Each members file that is not
   * the members copy (a source file, a public copy, another type, an id that is not one) comes before the
   * copy, so the first members file is never the copy by luck; the article lists them all.
   */
  const memberAnswer = () => ({
    [ContentKind.DOCUMENT]: [
      issueItem([
        { id: UUIDS.issueSource, audience: FileAudience.MEMBERS, role: FileRole.SOURCE },
        { id: UUIDS.issueMembersCopy, audience: FileAudience.MEMBERS, role: FileRole.PUBLIC_COPY },
        { id: UUIDS.issueMembersJpeg, audience: FileAudience.MEMBERS, mimeType: 'image/jpeg' },
        { id: 'not-an-id', audience: FileAudience.MEMBERS },
        { id: UUIDS.issueOfficers, audience: FileAudience.OFFICERS },
        { id: UUIDS.issueMembers, audience: FileAudience.MEMBERS },
        { id: UUIDS.issuePublic, audience: FileAudience.PUBLIC },
      ]),
    ],
    [ContentKind.ARTICLE]: [
      article('open-letter', ItemVisibility.PUBLIC, [para('Hello & welcome'), passage('The gate code is <1234>')], [
        { id: UUIDS.articleSource, audience: FileAudience.MEMBERS, role: FileRole.SOURCE },
        { id: UUIDS.articleMembersCopy, audience: FileAudience.MEMBERS, role: FileRole.PUBLIC_COPY },
        { id: UUIDS.articleMembersJpeg, audience: FileAudience.MEMBERS, mimeType: 'image/jpeg' },
        { id: 'not-an-id-either', audience: FileAudience.MEMBERS },
        { id: UUIDS.articlePublic, audience: FileAudience.PUBLIC },
        { id: UUIDS.articleMembers, audience: FileAudience.MEMBERS },
        { id: UUIDS.articleOfficers, audience: FileAudience.OFFICERS },
      ]),
      article('members-picnic', ItemVisibility.MEMBERS, [para('Bring a chair')]),
      article('board-notes', ItemVisibility.OFFICERS, [para('OFFICERS ONLY TEXT')], [{ id: UUIDS.articleOfficers, audience: FileAudience.OFFICERS }]),
    ],
  });

  /** What the API sends the public, or a token it answers as the public's: public trees, public files, members items with a placeholder. */
  const publicAnswer = () => ({
    [ContentKind.DOCUMENT]: [issueItem([{ id: UUIDS.issuePublic, audience: FileAudience.PUBLIC }])],
    [ContentKind.ARTICLE]: [
      article('open-letter', ItemVisibility.PUBLIC, [para('Hello & welcome'), redacted], [{ id: UUIDS.articlePublic, audience: FileAudience.PUBLIC }]),
      article('members-picnic', ItemVisibility.MEMBERS, [redacted]),
    ],
  });
  const para = (text: string) => ({ kind: { case: 'paragraph' as const, value: { inlines: [{ kind: { case: 'text' as const, value: { text } } }] } } });

  /** A fake API that answers by whether a token came, and remembers who asked for what. */
  function api(answer: (as: Reader | undefined) => Partial<Record<ContentKind, ContentItem[]>> | Error) {
    const asked: [ContentKind, number, string | undefined][] = [];
    const r = reads({
      listPublishedItems: (kind, size, as) => {
        asked.push([kind, size, as?.bearer]);
        const out = answer(as);
        return out instanceof Error ? Promise.reject(out) : Promise.resolve(out[kind] ?? []);
      },
    });
    return { reads: r, asked };
  }

  const ANONYMOUS = {
    issues: [{ period: '2026-10', label: 'Pensa Mensa, October-November 2026', summary: 'Volume 30, Number 5', pdf: `/documents/${UUIDS.issuePublic}.pdf`, source: 'pipeline' }],
    items: [
      {
        slug: 'open-letter',
        title: 'Title of open-letter',
        summary: 'Summary of open-letter',
        bodyHtml: `<p>Hello &amp; welcome</p><p class="members-note">${MEMBERS_PASSAGE}</p>`,
        publishedOn: '2026-10-20',
        source: 'submitted',
        files: [{ href: `/documents/${UUIDS.articlePublic}.pdf`, label: 'e0.pdf' }],
        membersOnly: false,
      },
    ],
    signedIn: false,
    tokenRefused: false,
    itemsUnavailable: false,
  };

  it('as the public: the issues exactly as issues() gives them, public articles only (page size 10), and no reader sent', async () => {
    const { reads: r, asked } = api(() => publicAnswer());
    const live = liveData(r);
    expect(await live.news()).toEqual(ANONYMOUS);
    expect((await live.news()).issues).toEqual(await live.issues());
    expect(asked.filter(([kind]) => kind === ContentKind.ARTICLE)).toEqual([[ContentKind.ARTICLE, 10, undefined], [ContentKind.ARTICLE, 10, undefined]]);
    expect(asked.every(([, , bearer]) => bearer === undefined)).toBe(true);
  });

  it('as the public, ignores members files, members items and officers items even when the API sends them', async () => {
    const { reads: r } = api(() => memberAnswer());
    const news = await liveData(r).news();
    const text = JSON.stringify(news);
    expect(news.signedIn).toBe(false);
    expect(news.items.map((i) => i.slug)).toEqual(['open-letter']);
    expect(news.issues[0]).not.toHaveProperty('membersPdf');
    for (const id of [UUIDS.issueMembers, UUIDS.issueOfficers, UUIDS.issueSource, UUIDS.articleMembers, UUIDS.articleOfficers, UUIDS.articleSource, UUIDS.articleMembersCopy, UUIDS.articleMembersJpeg]) expect(text).not.toContain(id);
    expect(text).not.toMatch(/1234|gate code|OFFICERS ONLY|members-picnic|board-notes/);
  });

  it("as a member: the members copy of an issue (members, primary, a PDF, an id) and nothing else, members items, members passages and members files", async () => {
    const { reads: r, asked } = api((as) => (as ? memberAnswer() : publicAnswer()));
    const news = await liveData(r).news(member);
    expect(asked).toEqual([
      [ContentKind.DOCUMENT, 50, 'member.token'],
      [ContentKind.ARTICLE, 10, 'member.token'],
    ]);
    expect(news.signedIn).toBe(true);
    expect(news.tokenRefused).toBe(false);
    expect(news.issues).toEqual([{ ...ANONYMOUS.issues[0], membersPdf: `/documents/${UUIDS.issueMembers}.pdf` }]);
    const [open, picnic, ...rest] = news.items;
    expect(rest).toEqual([]);
    expect(open).toMatchObject({ slug: 'open-letter', membersOnly: false });
    expect(open!.bodyHtml).toContain('<aside class="members-passage" aria-label="Members only">');
    expect(open!.bodyHtml).toContain('The gate code is &lt;1234&gt;');
    expect(open!.files).toEqual([
      { href: `/documents/${UUIDS.articlePublic}.pdf`, label: 'e0.pdf' },
      { href: `/documents/${UUIDS.articleMembers}.pdf`, label: 'e1.pdf', members: true },
    ]);
    expect(picnic).toMatchObject({ slug: 'members-picnic', membersOnly: true, bodyHtml: '<p>Bring a chair</p>', files: [] });
    const text = JSON.stringify(news);
    for (const id of [UUIDS.issueOfficers, UUIDS.issueSource, UUIDS.issueMembersCopy, UUIDS.issueMembersJpeg, UUIDS.articleOfficers, UUIDS.articleSource, UUIDS.articleMembersCopy, UUIDS.articleMembersJpeg]) expect(text).not.toContain(id);
    expect(text).not.toMatch(/OFFICERS ONLY|board-notes|not-an-id/);
  });

  it("as an officer: the same as a member's view, never an officers item, an officers file or a source file (D5)", async () => {
    const officerAnswer = memberAnswer();
    const { reads: r } = api(() => officerAnswer);
    const news = await liveData(r).news({ bearer: 'officer.token' });
    expect(news.items.map((i) => i.slug)).toEqual(['open-letter', 'members-picnic']);
    expect(news.issues[0]!.membersPdf).toBe(`/documents/${UUIDS.issueMembers}.pdf`);
    expect(news.items[0]!.files.map((f) => f.href)).toEqual([`/documents/${UUIDS.articlePublic}.pdf`, `/documents/${UUIDS.articleMembers}.pdf`]);
    expect(JSON.stringify(news)).not.toMatch(new RegExp(`${UUIDS.issueOfficers}|${UUIDS.issueSource}|${UUIDS.articleOfficers}|${UUIDS.articleSource}|OFFICERS ONLY`));
  });

  it("keys on the API's answer, not the session: a token the API answers as the public's reads as signed in without member access", async () => {
    const { reads: r } = api(() => publicAnswer());
    const news = await liveData(r).news({ bearer: 'pending.token' });
    expect(news.signedIn).toBe(true);
    expect(news.issues).toEqual(ANONYMOUS.issues);
    expect(news.items.map((i) => i.slug)).toEqual(['open-letter']);
    expect(news.items[0]!.bodyHtml).toBe(`<p>Hello &amp; welcome</p><p class="members-note">${NO_MEMBER_ACCESS} <a href="/help">Ask for help</a></p>`);
    expect(news.items[0]!.files).toEqual(ANONYMOUS.items[0]!.files);
  });

  it('reads a bearer that is not one b64token as no reader at all: the public view, even when the API sends more than it should (S5a-1)', async () => {
    const { reads: r, asked } = api(() => memberAnswer());
    const news = await liveData(r).news({ bearer: 'not a b64token' });
    expect(news).toEqual(await liveData(api(() => memberAnswer()).reads).news());
    expect(news.signedIn).toBe(false);
    expect(asked.map(([, , bearer]) => bearer)).toEqual([undefined, undefined]);
    const text = JSON.stringify(news);
    for (const id of [UUIDS.issueMembers, UUIDS.articleMembers]) expect(text).not.toContain(id);
    expect(text).not.toMatch(/1234|members-picnic/);
  });

  it('asks again as the public, once, when the API refuses the token, and says so: never a 503, and no box that sends the reader to sign in again (NOTE-2)', async () => {
    const { reads: r, asked } = api((as) => (as ? new ApiTokenRefused('ListPublishedItems') : publicAnswer()));
    const news = await liveData(r).news(member, { signIn: '/sign-in?return=%2Fnews&again=1' });
    const box = `<p class="members-note">${NO_MEMBER_ACCESS} <a href="/help">Ask for help</a></p>`;
    expect(news).toEqual({ ...ANONYMOUS, items: [{ ...ANONYMOUS.items[0]!, bodyHtml: `<p>Hello &amp; welcome</p>${box}` }], tokenRefused: true });
    expect(asked.filter(([, , bearer]) => bearer === undefined).map(([kind]) => kind).sort()).toEqual([ContentKind.DOCUMENT, ContentKind.ARTICLE].sort());
    expect(asked.filter(([, , bearer]) => bearer !== undefined).length).toBeLessThanOrEqual(2);
  });

  it('still gives the issues when only the articles cannot be read, and says so to a reader: the issues never wait on the articles (N4)', async () => {
    /** The fake API with its articles read down, whoever asks. */
    const articlesDown = (inner: ApiReads): ApiReads => ({
      ...inner,
      listPublishedItems: (kind, size, as) => (kind === ContentKind.ARTICLE ? Promise.reject(new ApiUnavailable('ListPublishedItems')) : inner.listPublishedItems(kind, size, as)),
    });
    // With no reader, /news is exactly what it was before A14 read any article: the issues, no line, no 503 (NOTE-1).
    expect(await liveData(articlesDown(api(() => publicAnswer()).reads)).news()).toEqual({ ...ANONYMOUS, items: [], itemsUnavailable: false });
    expect(await liveData(articlesDown(api(() => publicAnswer()).reads)).news({ bearer: 'not a b64token' })).toEqual({ ...ANONYMOUS, items: [], itemsUnavailable: false });
    const asMember = await liveData(articlesDown(api((as) => (as ? memberAnswer() : publicAnswer())).reads)).news(member);
    expect(asMember).toMatchObject({ items: [], itemsUnavailable: true, signedIn: true, tokenRefused: false });
    expect(asMember.issues[0]!.membersPdf).toBe(`/documents/${UUIDS.issueMembers}.pdf`);
    // A refused token is still asked again as the public, with the articles still down.
    const refused = await liveData(articlesDown(api((as) => (as ? new ApiTokenRefused('ListPublishedItems') : publicAnswer())).reads)).news(member);
    expect(refused).toEqual({ ...ANONYMOUS, items: [], itemsUnavailable: true, tokenRefused: true });
    // The issues down is the page's own failure, as before A14.
    const docsDown = reads({ listPublishedItems: (kind) => (kind === ContentKind.DOCUMENT ? Promise.reject(new ApiUnavailable('ListPublishedItems')) : Promise.resolve(publicAnswer()[ContentKind.ARTICLE])) });
    await expect(liveData(docsDown).news()).rejects.toBeInstanceOf(ApiUnavailable);
    // Anything but an unavailable API is not swallowed.
    const bug = reads({ listPublishedItems: (kind) => (kind === ContentKind.ARTICLE ? Promise.reject(new TypeError('bug')) : Promise.resolve(publicAnswer()[ContentKind.DOCUMENT])) });
    await expect(liveData(bug).news()).rejects.toBeInstanceOf(TypeError);
  });

  // A14 round 2 (SHOULD-1): the API may send a member a redacted node too (a privacy mark the members lens
  // withholds whole, apps/api/src/redaction/render.ts). Whether it read the caller as a member is decided
  // from the whole answer: a members node, or a members file in either list, which the public is never sent.
  describe('answered as a member, from the whole answer', () => {
    const withheldWhole = () => article('trip-notes', ItemVisibility.MEMBERS, [redacted]);
    const openWithRedacted = (files: FileInit[] = []) => article('open-letter', ItemVisibility.PUBLIC, [para('Hello & welcome'), redacted], files);
    const NOTE = `<p class="members-note">${NOT_SHOWN}</p>`;

    it("shows a member everything the API sent beside a redacted node: the passage, the members item, and a note that says nothing of their access", async () => {
      const answer = memberAnswer();
      const [open, picnic, board] = answer[ContentKind.ARTICLE];
      open!.live!.body!.blocks.push(create(BlockSchema, redacted as never));
      picnic!.live!.body!.blocks.push(create(BlockSchema, redacted as never));
      const { reads: r } = api(() => ({ ...answer, [ContentKind.ARTICLE]: [open!, picnic!, board!, withheldWhole()] }));
      const news = await liveData(r).news(member, { signIn: '/sign-in?return=%2Fnews&again=1' });
      expect(news.signedIn).toBe(true);
      expect(news.items.map((i) => [i.slug, i.membersOnly])).toEqual([['open-letter', false], ['members-picnic', true], ['trip-notes', true]]);
      expect(news.items[0]!.bodyHtml).toContain('The gate code is &lt;1234&gt;');
      expect(news.items[0]!.bodyHtml.endsWith(NOTE)).toBe(true);
      expect(news.items[1]!.bodyHtml).toBe(`<p>Bring a chair</p>${NOTE}`);
      expect(news.items[2]).toMatchObject({ bodyHtml: NOTE, files: [] });
      const text = JSON.stringify(news);
      expect(text).not.toContain('member access');
      expect(text).not.toContain('sign-in');
      expect(text).not.toContain(MEMBERS_PASSAGE);
    });

    const proofs: [string, () => Partial<Record<ContentKind, ContentItem[]>>][] = [
      ['a members passage in another article', () => ({ [ContentKind.ARTICLE]: [openWithRedacted(), withheldWhole(), article('other', ItemVisibility.PUBLIC, [passage('PASSAGE')])] })],
      ['a members inline in another article', () => ({ [ContentKind.ARTICLE]: [openWithRedacted(), withheldWhole(), article('other', ItemVisibility.PUBLIC, [{ kind: { case: 'paragraph', value: { inlines: [{ kind: { case: 'members', value: { inlines: [{ kind: { case: 'text', value: { text: 'INLINE' } } }] } } }] } } }])] })],
      ['a members file on an issue alone', () => ({ [ContentKind.DOCUMENT]: [issueItem([{ id: UUIDS.issuePublic, audience: FileAudience.PUBLIC }, { id: UUIDS.issueMembers, audience: FileAudience.MEMBERS }])], [ContentKind.ARTICLE]: [openWithRedacted(), withheldWhole()] })],
      ['a members file on an article alone', () => ({ [ContentKind.ARTICLE]: [openWithRedacted([{ id: UUIDS.articlePublic, audience: FileAudience.PUBLIC }, { id: UUIDS.articleMembers, audience: FileAudience.MEMBERS }]), withheldWhole()] })],
      ['a members passage in an issue', () => ({ [ContentKind.DOCUMENT]: [create(ContentItemSchema, { id: 'doc', kind: ContentKind.DOCUMENT, live: { title: 'Not an issue', visibility: ItemVisibility.PUBLIC, body: { blocks: [passage('IN A DOCUMENT')] as never } } })], [ContentKind.ARTICLE]: [openWithRedacted(), withheldWhole()] })],
    ];
    for (const [name, answer] of proofs) {
      it(`reads ${name} as the API's word that this is a member: every redacted node gets the neutral note, and the members item is shown`, async () => {
        const news = await liveData(api(answer).reads).news(member);
        const [open, trip] = news.items;
        expect(open).toMatchObject({ slug: 'open-letter', bodyHtml: `<p>Hello &amp; welcome</p>${NOTE}` });
        expect(trip).toMatchObject({ slug: 'trip-notes', membersOnly: true, bodyHtml: NOTE });
        expect(JSON.stringify(news)).not.toContain('member access');
      });
    }

    it("falls back to the redacted rule when nothing in the answer proves member standing: a public or an officers file proves nothing", async () => {
      const files: FileInit[] = [{ id: UUIDS.articlePublic, audience: FileAudience.PUBLIC }, { id: UUIDS.articleOfficers, audience: FileAudience.OFFICERS }];
      const { reads: r } = api(() => ({ [ContentKind.DOCUMENT]: [issueItem([{ id: UUIDS.issuePublic, audience: FileAudience.PUBLIC }, { id: UUIDS.issueOfficers, audience: FileAudience.OFFICERS }])], [ContentKind.ARTICLE]: [openWithRedacted(files), withheldWhole(), article('plain', ItemVisibility.PUBLIC, [para('No passage')])] }));
      const news = await liveData(r).news(member);
      expect(news.items.map((i) => i.slug)).toEqual(['open-letter', 'plain']);
      expect(news.items[0]!.bodyHtml).toBe(`<p>Hello &amp; welcome</p><p class="members-note">${NO_MEMBER_ACCESS} <a href="/help">Ask for help</a></p>`);
      expect(news.items[1]!.bodyHtml).toBe('<p>No passage</p>');
    });

    it("never takes proof from the public's answer: no reader, or a refused token asked again as the public, stays the public's view", async () => {
      const buggy = () => ({ ...memberAnswer(), [ContentKind.ARTICLE]: [...memberAnswer()[ContentKind.ARTICLE], withheldWhole()] });
      const anonymous = await liveData(api(buggy).reads).news();
      const refused = await liveData(api((as) => (as ? new ApiTokenRefused('ListPublishedItems') : buggy())).reads).news(member);
      for (const news of [anonymous, refused]) {
        const text = JSON.stringify(news);
        expect(news.items.map((i) => i.slug)).toEqual(['open-letter']);
        expect(news.issues[0]).not.toHaveProperty('membersPdf');
        expect(text).not.toMatch(/1234|gate code|trip-notes|members-picnic/);
        expect(text).not.toContain(NOT_SHOWN);
      }
    });
  });

  it('passes an unavailable API on, with or without a reader, and a refusal of the public read too', async () => {
    await expect(liveData(api(() => new ApiUnavailable('ListPublishedItems')).reads).news(member)).rejects.toBeInstanceOf(ApiUnavailable);
    await expect(liveData(api(() => new ApiUnavailable('ListPublishedItems')).reads).news()).rejects.toBeInstanceOf(ApiUnavailable);
    await expect(liveData(api(() => new ApiTokenRefused('ListPublishedItems')).reads).news()).rejects.toBeInstanceOf(ApiTokenRefused);
  });

  it("carries nothing from one reader to the next: a member's read, then the public's, alone or at once, gives the public view", async () => {
    const { reads: r } = api((as) => (as ? memberAnswer() : publicAnswer()));
    const live = liveData(r);
    const fresh = await liveData(api(() => publicAnswer()).reads).news();
    await live.news(member);
    expect(await live.news()).toEqual(fresh);
    const together = await Promise.all([live.news(member), live.news(), live.news(member), live.news()]);
    expect(together[1]).toEqual(fresh);
    expect(together[3]).toEqual(fresh);
    expect(together[0]!.issues[0]!.membersPdf).toBeDefined();
  });

  it("leaves every other section the public's, before and after a member's /news and PDF: no token ever reaches them", async () => {
    const asked: [ContentKind, string | undefined][] = [];
    const files: (string | undefined)[] = [];
    const live = liveData(
      reads({
        listPublishedItems: (kind, _size, as) => (asked.push([kind, as?.bearer]), Promise.resolve([])),
        readFile: (_id, as) => (files.push(as?.bearer), Promise.resolve({ kind: 'not_found' as const })),
      }),
    );
    const others = async () => {
      await live.announcements();
      await live.treasurerSummaries();
      await live.presidentReport();
      await live.issues();
    };
    const PUBLIC_READS = [ContentKind.ANNOUNCEMENT, ContentKind.TREASURER_SUMMARY, ContentKind.PRESIDENT_REPORT, ContentKind.DOCUMENT].map((kind) => [kind, undefined]);
    await others();
    await live.news(member);
    await live.file(UUIDS.issueMembers, member);
    await others();
    await live.news();
    await live.file(UUIDS.issueMembers);
    expect(asked).toEqual([...PUBLIC_READS, [ContentKind.DOCUMENT, 'member.token'], [ContentKind.ARTICLE, 'member.token'], ...PUBLIC_READS, [ContentKind.DOCUMENT, undefined], [ContentKind.ARTICLE, undefined]]);
    expect(files).toEqual(['member.token', undefined]);
  });

  it('skips an article the API sent with no live version, whoever reads', async () => {
    const bare = create(ContentItemSchema, { id: 'bare', slug: 'bare', kind: ContentKind.ARTICLE });
    const { reads: r } = api(() => ({ [ContentKind.ARTICLE]: [bare, ...publicAnswer()[ContentKind.ARTICLE]] }));
    expect((await liveData(r).news()).items.map((i) => i.slug)).toEqual(['open-letter']);
    expect((await liveData(r).news(member)).items.map((i) => i.slug)).toEqual(['open-letter']);
  });

  it('puts the sign-in link in the public box only when asked, and never for a signed-in reader', async () => {
    const live = liveData(api((as) => (as ? publicAnswer() : publicAnswer())).reads);
    const signIn = '/sign-in?return=%2Fnews';
    expect((await live.news(undefined, { signIn })).items[0]!.bodyHtml).toContain(`<a href="${signIn}">sign in</a>`);
    expect((await live.news({ bearer: 'pending.token' }, { signIn })).items[0]!.bodyHtml).not.toContain('sign-in');
  });

  it('shows members items to the public by title and summary only when the teaser switch is on (D1), never a body or a file the API sent; hidden by default', async () => {
    const teaserPublicPdf = 'e3000000-0000-4000-8000-000000000001';
    // A buggy API sends the public the members item in full, a members passage, a members file and a public one.
    const full = article('members-picnic', ItemVisibility.MEMBERS, [para('MEMBERS BODY CANARY'), passage('The gate code is <1234>')], [
      { id: UUIDS.articleMembers, audience: FileAudience.MEMBERS },
      { id: teaserPublicPdf, audience: FileAudience.PUBLIC },
    ]);
    const [open] = publicAnswer()[ContentKind.ARTICLE];
    const { reads: r } = api((as) => (as ? publicAnswer() : { [ContentKind.ARTICLE]: [open!, full] }));
    expect((await liveData(r).news()).items.map((i) => i.slug)).toEqual(['open-letter']);
    const teased = await liveData(r, { membersTeasers: true }).news();
    expect(teased.items.map((i) => [i.slug, i.membersOnly])).toEqual([['open-letter', false], ['members-picnic', true]]);
    expect(teased.items[1]).toEqual({
      slug: 'members-picnic',
      title: 'Title of members-picnic',
      summary: 'Summary of members-picnic',
      bodyHtml: `<p class="members-note">${MEMBERS_PASSAGE}</p>`,
      publishedOn: '2026-10-20',
      source: 'submitted',
      files: [],
      membersOnly: true,
    });
    expect(JSON.stringify(teased)).not.toMatch(new RegExp(`MEMBERS BODY|1234|gate code|${UUIDS.articleMembers}|${teaserPublicPdf}`));
    const signIn = '/sign-in?return=%2Fnews';
    expect((await liveData(r, { membersTeasers: true }).news(undefined, { signIn })).items[1]!.bodyHtml).toBe(`<p class="members-note">Members-only passage, <a href="${signIn}">sign in</a> to read.</p>`);
    // A signed-in reader the API answered as the public's gets the same switch, with the box that says so.
    expect((await liveData(r).news({ bearer: 'pending.token' })).items.map((i) => i.slug)).toEqual(['open-letter']);
    const pending = await liveData(r, { membersTeasers: true }).news({ bearer: 'pending.token' }, { signIn });
    expect(pending.items[1]).toMatchObject({ slug: 'members-picnic', membersOnly: true, files: [], bodyHtml: `<p class="members-note">${NO_MEMBER_ACCESS} <a href="/help">Ask for help</a></p>` });
  });
});

describe('liveData.file as a signed-in reader', () => {
  const FILE = 'f1000000-0000-4000-8000-000000000010';
  it("reads the file with the reader's token, and as the public once more when the API refuses it", async () => {
    const asked: (string | undefined)[] = [];
    const live = liveData(
      reads({
        readFile: (_id, as) => {
          asked.push(as?.bearer);
          return as?.bearer === 'refused' ? Promise.reject(new ApiTokenRefused('ReadFile')) : Promise.resolve({ kind: 'not_found' });
        },
      }),
    );
    expect(await live.file(FILE, { bearer: 'member.token' })).toEqual({ kind: 'not_found' });
    expect(await live.file(FILE, { bearer: 'refused' })).toEqual({ kind: 'not_found' });
    expect(await live.file('../x', { bearer: 'member.token' })).toEqual({ kind: 'not_found' });
    expect(asked).toEqual(['member.token', 'refused', undefined]);
    await expect(liveData(reads({ readFile: () => Promise.reject(new ApiTokenRefused('ReadFile')) })).file(FILE)).rejects.toBeInstanceOf(ApiTokenRefused);
  });

  it('reads the file as the public for a bearer that is not one b64token (S5a-1)', async () => {
    const asked: (string | undefined)[] = [];
    const live = liveData(reads({ readFile: (_id, as) => (asked.push(as?.bearer), Promise.resolve({ kind: 'not_found' as const })) }));
    expect(await live.file(FILE, { bearer: 'two words' })).toEqual({ kind: 'not_found' });
    expect(asked).toEqual([undefined]);
  });

  it('passes an unavailable API on with a reader too, without asking again', async () => {
    let asked = 0;
    const live = liveData(reads({ readFile: () => (asked++, Promise.reject(new ApiUnavailable('ReadFile'))) }));
    await expect(live.file(FILE, { bearer: 'member.token' })).rejects.toBeInstanceOf(ApiUnavailable);
    expect(asked).toBe(1);
  });
});
