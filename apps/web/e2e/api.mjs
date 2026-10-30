// @ts-check
// A stand-in for nwfl-mensa-api for the e2e suite only: the same services, by
// the descriptors generated from the API's own protos, over the gRPC wire
// protocol only (h2c, application/grpc; Connect and gRPC-Web are off, as on
// the API). It answers as the API answers the public: made-up people, events
// dated from today, members events withheld. Two canaries the site must never
// show sit among them: a members event sent in full (as a buggy API might)
// and an event with no status. A call that carries a token, or a cookie, is
// refused, so a page that sent one would fail.
//
// SILENT_API_PORT is a second listener that accepts connections and never
// answers: the API that hangs, for the timeout test. NO_ISSUES_API_PORT is a
// third, the same API with no issue of the newsletter published yet.
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import http2 from 'node:http2';
import net from 'node:net';
import { ContentItemSchema, ContentKind, ContentService, FileAudience, FileRole, ItemState, ItemVisibility } from '../src/gen/nwfl/mensa/v1/content_pb.js';
import { Area, EventOccurrenceSchema, EventService, EventVisibility, OccurrenceStatus, VenueKind } from '../src/gen/nwfl/mensa/v1/event_pb.js';
import { OfficeKind, TermStatus } from '../src/gen/nwfl/mensa/v1/roster_pb.js';

const port = Number(process.env['API_PORT'] ?? 9091);
const silentPort = Number(process.env['SILENT_API_PORT'] ?? 9092);
const noIssuesPort = Number(process.env['NO_ISSUES_API_PORT'] ?? 9093);

// As in e2e/stand-in.ts.
const CANARY = { membersInFull: 'MEMBERS-ONLY CANARY PICNIC', noStatus: 'UNPUBLISHED CANARY' };

const OFFICE = {
  president: '11111111-1111-4111-8111-111111111111',
  social: '22222222-2222-4222-8222-222222222222',
};
const SERIES = {
  lunch: '0b9c1f5e-4c1a-4d55-9a3e-2f7d8e6a1b20',
  happyHour: '1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5',
  members: '2d3e4f5a-6b7c-4d8e-9fa0-b1c2d3e4f5a6',
};
const ONE_OFF = {
  games: '3e4f5a6b-7c8d-4e9f-a0b1-c2d3e4f5a6b7',
  books: '4f5a6b7c-8d9e-4fa0-b1c2-d3e4f5a6b7c8',
  picnic: '5a6b7c8d-9eaf-40b1-82d3-e4f5a6b7c8d9',
  panamaCity: '6b7c8d9e-afb0-41c2-93e4-f5a6b7c8d9e0',
  membersInFull: '7c8d9eaf-b0c1-42d3-a4f5-a6b7c8d9e0f1',
  noStatus: '8d9eafb0-c1d2-43e4-b5a6-b7c8d9e0f1a2',
};

const VENUES = {
  bistro: { id: 'a0000000-0000-4000-8000-000000000001', kind: VenueKind.BUSINESS, name: 'Sample Bistro', businessAddress: '100 Example Way', city: 'Destin', area: Area.OKALOOSA, url: 'https://example.org/bistro', accessibilityNote: 'Step-free entrance at the side door.', active: true },
  taproom: { id: 'a0000000-0000-4000-8000-000000000002', kind: VenueKind.BUSINESS, name: 'Example Taproom', businessAddress: '200 Sample Street', city: 'Fort Walton Beach', area: Area.OKALOOSA, active: true },
  diner: { id: 'a0000000-0000-4000-8000-000000000003', kind: VenueKind.BUSINESS, name: 'Placeholder Diner', businessAddress: '300 Test Avenue', city: 'Panama City', area: Area.BAY, active: true },
  home: { id: 'a0000000-0000-4000-8000-000000000004', kind: VenueKind.MEMBER_HOME, name: "A member's home", area: Area.OKALOOSA, hostOfficeId: OFFICE.president, active: true },
  video: { id: 'a0000000-0000-4000-8000-000000000005', kind: VenueKind.VIRTUAL, name: 'Video call', area: Area.VIRTUAL, url: 'https://example.org/meet', active: true },
};

const ZONE = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** @param {Date} at */
function central(at) {
  const p = Object.fromEntries(ZONE.formatToParts(at).map((x) => [x.type, x.value]));
  return { date: `${p['year']}-${p['month']}-${p['day']}`, time: `${p['hour']}:${p['minute']}` };
}

/** @param {string} date @param {number} days */
function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The instant of a Central wall-clock time. @param {string} date @param {string} time */
function at(date, time) {
  for (const offset of [5, 6]) {
    const [h, m] = time.split(':').map(Number);
    const candidate = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), Number(h) + offset, Number(m)));
    const c = central(candidate);
    if (c.date === date && c.time === time) return candidate;
  }
  throw new Error(`no such Central time ${date} ${time}`);
}

/** @param {string} date */
const protoDate = (date) => ({ year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)), day: Number(date.slice(8, 10)) });
/** @param {string} date */
const weekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();

/**
 * @param {{ id: string, seriesId?: string, title?: string, date: string, start?: string, end?: string, venue?: Record<string, unknown>, status?: OccurrenceStatus, statusNote?: string, detail?: string, url?: string, visibility?: EventVisibility, area: Area, owner?: string }} e
 */
function occurrence(e) {
  return create(EventOccurrenceSchema, {
    id: e.id,
    seriesId: e.seriesId ?? '',
    title: e.title ?? '',
    ...(e.start ? { startsAt: timestampFromDate(at(e.date, e.start)) } : {}),
    ...(e.start && e.end ? { endsAt: timestampFromDate(at(e.date, e.end)) } : {}),
    ...(e.venue ? { venueId: String(e.venue['id']), venue: e.venue } : {}),
    status: e.status ?? OccurrenceStatus.SCHEDULED,
    statusNote: e.statusNote ?? '',
    detail: e.detail ?? '',
    url: e.url ?? '',
    visibility: e.visibility ?? EventVisibility.PUBLIC,
    localDate: protoDate(e.date),
    area: e.area,
    ownerOfficeId: e.owner ?? '',
  });
}

/** Every event from `from` to `to`, as the API gives them to the public. @param {string} from @param {string} to */
function calendar(from, to) {
  const today = central(new Date()).date;
  /** @type {import('../src/gen/nwfl/mensa/v1/event_pb.js').EventOccurrence[]} */
  const out = [];
  // Nothing before 2020: a month with no events at all, for the empty state.
  for (let date = from < '2020-01-01' ? '2020-01-01' : from; date <= to; date = addDays(date, 1)) {
    const day = weekday(date);
    if (day === 3) {
      // The third Wednesday from today is cancelled.
      const cancelled = date === addDays(today, ((3 - weekday(today) + 7) % 7) + 14);
      out.push(
        occurrence({
          id: `${SERIES.lunch}:${date}`,
          seriesId: SERIES.lunch,
          title: 'Wednesday Lunchers',
          date,
          start: '11:30',
          end: '13:00',
          venue: VENUES.bistro,
          area: Area.OKALOOSA,
          ...(cancelled ? { status: OccurrenceStatus.CANCELLED, statusNote: 'The restaurant is closed for a private party.' } : { detail: 'Bring a friend, a book; and an appetite.' }),
        }),
      );
    }
    // The second Friday: Happy Hour, tentative.
    if (day === 5 && Number(date.slice(8)) > 7 && Number(date.slice(8)) <= 14) {
      out.push(occurrence({ id: `${SERIES.happyHour}:${date}`, seriesId: SERIES.happyHour, title: 'Happy Hour', date, start: '17:00', venue: VENUES.taproom, area: Area.OKALOOSA, status: OccurrenceStatus.TENTATIVE, statusNote: 'The place may change.' }));
    }
    // Every Sunday: a members event, withheld.
    if (day === 0) out.push(create(EventOccurrenceSchema, { id: `${SERIES.members}:${date}`, localDate: protoDate(date), area: Area.BAY, visibility: EventVisibility.MEMBERS, detailsWithheld: true }));
  }
  const oneOffs = [
    occurrence({ id: ONE_OFF.games, title: 'Board games afternoon', date: addDays(today, 3), start: '14:00', end: '17:00', venue: VENUES.home, area: Area.OKALOOSA, owner: OFFICE.social }),
    occurrence({ id: ONE_OFF.books, title: 'Online book chat', date: addDays(today, 10), start: '19:00', end: '20:00', venue: VENUES.video, area: Area.VIRTUAL, owner: OFFICE.social }),
    occurrence({ id: ONE_OFF.picnic, title: 'Summer picnic planning', date: addDays(today, 20), area: Area.WALTON, status: OccurrenceStatus.TENTATIVE, owner: OFFICE.social }),
    occurrence({ id: ONE_OFF.panamaCity, title: 'Panama City lunch', date: addDays(today, 12), start: '11:30', venue: VENUES.diner, area: Area.BAY, status: OccurrenceStatus.MOVED, statusNote: 'Moved from Saturday to Sunday.', owner: OFFICE.social }),
    // The two canaries.
    occurrence({ id: ONE_OFF.membersInFull, title: CANARY.membersInFull, date: addDays(today, 1), start: '12:00', venue: VENUES.bistro, area: Area.OKALOOSA, visibility: EventVisibility.MEMBERS, owner: OFFICE.social }),
    occurrence({ id: ONE_OFF.noStatus, title: CANARY.noStatus, date: addDays(today, 2), start: '12:00', venue: VENUES.bistro, area: Area.OKALOOSA, status: OccurrenceStatus.UNSPECIFIED, owner: OFFICE.social }),
  ];
  for (const o of oneOffs) {
    const date = `${o.localDate?.year}-${String(o.localDate?.month).padStart(2, '0')}-${String(o.localDate?.day).padStart(2, '0')}`;
    if (date >= from && date <= to) out.push(o);
  }
  return out.sort((a, b) => Number(a.localDate?.year) * 10000 + Number(a.localDate?.month) * 100 + Number(a.localDate?.day) - (Number(b.localDate?.year) * 10000 + Number(b.localDate?.month) * 100 + Number(b.localDate?.day)));
}

/** @param {{ year: number, month: number, day: number } | undefined} d */
const iso = (d) => (d ? `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}` : '');

/** @param {string} text */
const para = (text) => ({ kind: { case: /** @type {const} */ ('paragraph'), value: { inlines: [{ kind: { case: /** @type {const} */ ('text'), value: { text } } }] } } });

/**
 * @param {string} slug @param {ContentKind} kind @param {string} title @param {string} summary @param {unknown[]} blocks @param {number} daysAgo
 */
const item = (slug, kind, title, summary, blocks, daysAgo) =>
  create(ContentItemSchema, {
    id: slug,
    slug,
    kind,
    officeId: OFFICE.president,
    state: ItemState.PUBLISHED,
    // The blocks are message-init literals; create() checks their shape at run time.
    live: { title, summary, visibility: ItemVisibility.PUBLIC, body: { blocks: /** @type {any} */ (blocks) }, approvedAt: timestampFromDate(new Date(Date.now() - daysAgo * 86_400_000)) },
  });

const ITEMS = {
  [ContentKind.PRESIDENT_REPORT]: [
    item('president-october', ContentKind.PRESIDENT_REPORT, 'A busy autumn', 'Lunches, a picnic, and a call for helpers.', [
      para('Thank you to everyone who came to the lunches this month.'),
      { kind: { case: 'redacted', value: {} } },
      { kind: { case: 'paragraph', value: { inlines: [{ kind: { case: 'text', value: { text: 'See ' } } }, { kind: { case: 'link', value: { href: 'https://www.us.mensa.org/', inlines: [{ kind: { case: 'text', value: { text: 'American Mensa' } } }] } } }, { kind: { case: 'text', value: { text: ' for national news.' } } }] } } },
    ], 5),
  ],
  [ContentKind.ANNOUNCEMENT]: [
    item('dues', ContentKind.ANNOUNCEMENT, 'Dues go up in January', 'American Mensa dues change on 1 January.', [para('Renew before the end of December to keep the old rate.')], 3),
    item('helpers', ContentKind.ANNOUNCEMENT, 'Helpers wanted', 'The picnic needs two more helpers.', [para('Write to the President if you can help.')], 8),
  ],
  [ContentKind.TREASURER_SUMMARY]: [
    item('treasurer-q3', ContentKind.TREASURER_SUMMARY, 'July to September', 'The Executive Committee accepted these totals.', [
      { kind: { case: 'list', value: { ordered: false, items: ['Opening balance: $2,543.10', 'Deposits: $420.00', 'Debits: $185.75', 'Closing balance: $2,777.35'].map((t) => ({ blocks: [para(t)] })) } } },
    ], 30),
    item('treasurer-q2', ContentKind.TREASURER_SUMMARY, 'April to June', 'The Executive Committee accepted these totals.', [para('Closing balance: $2,543.10')], 120),
  ],
};

// The newsletter, as the issue loader publishes it, as in e2e/stand-in.ts (NEWSLETTER): each issue a
// public DOCUMENT with a public PDF and a members PDF. The members file is listed too, as a buggy API
// might list it, and every file carries a hash and a size: the site must show none of them.
const SHA256 = new Uint8Array(32).fill(0xab);
const SIZE = 987_654n;
const NEWSLETTER = [
  { title: 'Pensa Mensa, October-November 2026', summary: 'Volume 30, Number 5', id: 'd0c00000-0000-4000-8000-000000000010', publicPdf: 'f0000000-0000-4000-8000-000000000010', membersPdf: 'f1000000-0000-4000-8000-000000000010', daysAgo: 2 },
  // Approved last, so the API lists it first; the API gave its id in the slug field (something in it is withheld).
  { title: 'Pensa Mensa, August-September 2026', summary: 'Volume 30, Number 4', id: 'd0c00000-0000-4000-8000-000000000008', publicPdf: 'f0000000-0000-4000-8000-000000000008', membersPdf: 'f1000000-0000-4000-8000-000000000008', daysAgo: 1, withheldSlug: true },
  { title: 'Pensa Mensa, June-July 2026', summary: 'Volume 30, Number 3', id: 'd0c00000-0000-4000-8000-000000000006', publicPdf: 'f0000000-0000-4000-8000-000000000006', membersPdf: 'f1000000-0000-4000-8000-000000000006', daysAgo: 60 },
  { title: 'Pensa Mensa, February-March 2025', summary: 'Volume 29, Number 2', id: 'd0c00000-0000-4000-8000-000000000002', publicPdf: 'f0000000-0000-4000-8000-000000000002', membersPdf: 'f1000000-0000-4000-8000-000000000002', daysAgo: 300 },
  // A members item in an issue's shape, sent in full: never listed for the public.
  { title: 'Pensa Mensa, April-May 2026', summary: 'Volume 30, Number 2', id: 'd0c00000-0000-4000-8000-000000000004', publicPdf: 'f0000000-0000-4000-8000-000000000004', membersPdf: 'f1000000-0000-4000-8000-000000000004', daysAgo: 3, visibility: ItemVisibility.MEMBERS },
  // A public document that is not an issue.
  { title: 'Our bylaws', summary: 'As amended in 2024.', id: 'd0c00000-0000-4000-8000-0000000000b1', publicPdf: 'f0000000-0000-4000-8000-0000000000b1', daysAgo: 4 },
];

/** @param {string} id @param {FileAudience} audience */
const storedFile = (id, audience) => ({ id, filename: `${id}.pdf`, mimeType: 'application/pdf', sizeBytes: SIZE, sha256: SHA256, audience, role: FileRole.PRIMARY });

const DOCUMENTS = NEWSLETTER.map((d) =>
  create(ContentItemSchema, {
    id: d.id,
    slug: d.withheldSlug ? d.id : d.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    kind: ContentKind.DOCUMENT,
    officeId: OFFICE.president,
    state: ItemState.PUBLISHED,
    live: {
      title: d.title,
      summary: d.summary,
      visibility: d.visibility ?? ItemVisibility.PUBLIC,
      approvedAt: timestampFromDate(new Date(Date.now() - d.daysAgo * 86_400_000)),
      files: [...(d.membersPdf ? [storedFile(d.membersPdf, FileAudience.MEMBERS)] : []), storedFile(d.publicPdf, FileAudience.PUBLIC)],
    },
  }),
).sort((a, b) => Number(b.live?.approvedAt?.seconds) - Number(a.live?.approvedAt?.seconds));

/** A one-page PDF with no text: what ReadFile streams for a public file. */
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n',
  'latin1',
);
const PUBLIC_PDFS = new Set(NEWSLETTER.filter((d) => (d.visibility ?? ItemVisibility.PUBLIC) === ItemVisibility.PUBLIC).map((d) => d.publicPdf));

/** @param {string} title @param {string} slug @param {number} order @param {{ name: string, status: TermStatus }[]} holders @param {string} alias */
const office = (slug, title, order, holders, alias) => ({
  id: slug === 'president' ? OFFICE.president : slug === 'social' ? OFFICE.social : `office-${slug}`,
  slug,
  title,
  kind: OfficeKind.ELECTED,
  sortOrder: order,
  roleAlias: alias,
  active: true,
  terms: holders.map((h, i) => ({ id: `${slug}-${i}`, holderDisplayName: h.name, status: h.status })),
});

const ROSTER = [
  office('president', 'President', 1, [{ name: 'Alex Sample', status: TermStatus.ACTIVE }], 'president@nwflorida.us'),
  office('vice-president', 'Vice President', 2, [{ name: 'Jordan Example', status: TermStatus.ACTIVE }], 'vp@nwflorida.us'),
  office('secretary', 'Secretary', 3, [{ name: 'Casey Placeholder', status: TermStatus.ACTIVE }], 'secretary@nwflorida.us'),
  // Not yet seen to deliver: the site shows no address.
  office('treasurer', 'Treasurer', 4, [{ name: 'Riley Testcase', status: TermStatus.ACTIVE }], ''),
  office('member-at-large', 'Member at Large', 5, [{ name: 'Taylor Sample', status: TermStatus.ACTIVE }, { name: 'Quinn Example', status: TermStatus.ACTIVE }], 'mal@nwflorida.us'),
  office('membership', 'Membership Officer', 6, [{ name: '', status: TermStatus.VACANT }], 'membership@nwflorida.us'),
  office('social', 'Social Chair', 7, [{ name: 'Avery Placeholder', status: TermStatus.ACTING }], ''),
  office('editor', 'Newsletter Editor', 8, [{ name: 'Morgan Dummy', status: TermStatus.ACTIVE }], 'editor@nwflorida.us'),
];

/** @param {import('@connectrpc/connect').HandlerContext} ctx */
function anonymousOnly(ctx) {
  if (ctx.requestHeader.has('authorization') || ctx.requestHeader.has('cookie')) throw new ConnectError('the site must call as the public', Code.PermissionDenied);
}

/** The API's routes; with `issues: false`, nothing of the newsletter is published yet. @param {{ issues: boolean }} options */
const routes = ({ issues }) => (/** @type {import('@connectrpc/connect').ConnectRouter} */ router) => {
  router.service(EventService, {
    listOccurrences: (req, ctx) => {
      anonymousOnly(ctx);
      const today = central(new Date()).date;
      const from = req.from ? iso(req.from) : today;
      return { occurrences: calendar(from, req.to ? iso(req.to) : addDays(from, 62)) };
    },
    getOccurrence: (req, ctx) => {
      anonymousOnly(ctx);
      const today = central(new Date()).date;
      const found = calendar(addDays(today, -60), addDays(today, 400)).find((o) => o.id === req.id);
      if (!found) throw new ConnectError('occurrence not found', Code.NotFound);
      return { occurrence: found };
    },
    listSeries: (_req, ctx) => {
      anonymousOnly(ctx);
      return {
        series: [
          { id: SERIES.lunch, slug: 'wednesday-lunchers', title: 'Wednesday Lunchers', cadenceLabel: 'Every Wednesday', description: 'Lunch and conversation, every week. Everyone is welcome.', hostOfficeId: OFFICE.president, visibility: EventVisibility.PUBLIC, active: true },
          { id: SERIES.happyHour, slug: 'happy-hour', title: 'Happy Hour', cadenceLabel: 'Second Friday of each month', description: 'A different place each time.', hostOfficeId: OFFICE.social, visibility: EventVisibility.PUBLIC, active: true },
        ],
      };
    },
    listVenues: (_req, ctx) => {
      anonymousOnly(ctx);
      return { venues: [VENUES.bistro, VENUES.taproom, VENUES.diner, VENUES.home, VENUES.video] };
    },
  });
  router.service(ContentService, {
    getRoster: (_req, ctx) => {
      anonymousOnly(ctx);
      return { offices: ROSTER };
    },
    listPublishedItems: (req, ctx) => {
      anonymousOnly(ctx);
      const items = req.kind === ContentKind.DOCUMENT ? (issues ? DOCUMENTS : []) : (ITEMS[/** @type {keyof typeof ITEMS} */ (req.kind)] ?? []);
      return { items: items.slice(0, req.pageSize || 20) };
    },
    // A public file's bytes; anything else is not found, as the API answers the public for a members file.
    readFile: async function* (req, ctx) {
      anonymousOnly(ctx);
      if (!issues || !PUBLIC_PDFS.has(req.fileId)) throw new ConnectError('file not found', Code.NotFound);
      yield { part: { case: /** @type {const} */ ('head'), value: { filename: 'pensa-mensa.pdf', mimeType: 'application/pdf', sizeBytes: BigInt(PDF.length) } } };
      yield { part: { case: /** @type {const} */ ('chunk'), value: new Uint8Array(PDF) } };
    },
  });
};

/** @param {{ issues: boolean }} options */
const adapter = (options) => connectNodeAdapter({ grpc: true, grpcWeb: false, connect: false, routes: routes(options) });

http2.createServer(adapter({ issues: true })).listen(port, '127.0.0.1', () => console.log(JSON.stringify({ msg: 'stand-in API listening', port })));
http2.createServer(adapter({ issues: false })).listen(noIssuesPort, '127.0.0.1', () => console.log(JSON.stringify({ msg: 'stand-in API with no issue listening', port: noIssuesPort })));
net.createServer(() => {}).listen(silentPort, '127.0.0.1', () => console.log(JSON.stringify({ msg: 'silent API listening', port: silentPort })));
