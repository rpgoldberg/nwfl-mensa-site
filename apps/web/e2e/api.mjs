// @ts-check
// A stand-in for nwfl-mensa-api for the e2e suite only: the same services, by
// the descriptors generated from the API's own protos, over the gRPC wire
// protocol only (h2c, application/grpc; Connect and gRPC-Web are off, as on
// the API). It answers as the API answers the public: made-up people, events
// dated from today, members events withheld. Two canaries the site must never
// show sit among them: a members event sent in full (as a buggy API might)
// and an event with no status. A call that carries a token, or a cookie, is
// refused, so a page that sent one would fail; the one exception (A14) is a
// signed-in reader's token on ReadFile and on /news's two ListPublishedItems
// reads (documents, page 50; articles, page 10), which /news and its PDFs
// forward. That token is verified against the test identity provider
// (e2e/idp.mjs, IDP_ISSUER and IDP_JWKS_URL) and answered as the API answers
// it: the officers' view for the officers group, the members' view for an
// account with member standing (MEMBER_SUBJECTS, as member_account would say),
// the public's for any other (pending), and UNAUTHENTICATED for a bad token or
// the "refused" account; the "articles-down" member's articles read fails as an
// API that could not answer it. Without a token the public's answer is a buggy API's:
// it lists members files, a members article in full, an officers article.
// LINKS L4: GetLinkTarget answers for the links of e2e/stand-in.ts LINKS as the API does
// (apps/api/src/content/link-target.ts): a link resolves for an audience whose copy holds it (both
// copies, or the members copy alone), never for an officer, who is served the original (Q8); a link
// turned off says so to an audience whose copy held it, and to an officer. Also three a buggy API might
// send (a javascript: URL, an angle-bracketed one and an RTL-override host), which the site must refuse
// to render. A link turned off comes with its URL here, which the real API never sends, so the page is
// seen not to show it.
// SOLO-APPROVE: ApprovalRuleService takes the officer's token as the API does (officers and the Admin
// read the rule, the Admin alone sets it), keeping one setting per subject (below).
// W-SIGNUP: MembershipService takes the person's own token as the API does: their own account and
// sign-up (the number and last name both required, the invited group making the route "invite"), and
// for the membership approvers and the Admin the queue and its decisions, never their own. Sign-ups
// and decisions are kept per sign-in (the token's jti), so tests in parallel cannot disturb each other.
// REOPEN: the Admin and the Membership Officer's seat list the rejections and reopen one, never their
// own; a reopening is kept for everyone, as in the API, so the rejected person's own sign-in sees its
// account gone and gets the form again. Each browser project reopens its own person (REJECTED).
// PROFILE-ID: the queue and the rejections carry what each sign-up typed (names and number), and a
// duplicate claim what its earlier claim typed (none once closed). The member "Jordan Example" has a
// profile (MEMBER_PROFILE), changed per sign-in by UpdateMyProfile, which takes the two names only.
//
// EDITOR E2: the publishing workflow (ContentService CreateItem to PreviewWorkingItem) is a model with
// state (e2e/workflow.mjs) that takes the verified token's groups as the API does; see WORKFLOW below.
// EDITOR E6: the calendar is a model with state too (e2e/events-model.mjs), for the officers' event
// screens: SaveOccurrence with the officer's verified token, and every read has a save at once. The
// calendar reads take an officer's or the Admin's token too (the event screens read as the officer, so a
// members event comes whole); any other token there is still refused, as is a cookie. See EVENTS below.
//
// SILENT_API_PORT is a second listener that accepts connections and never
// answers: the API that hangs, for the timeout test. NO_ISSUES_API_PORT is a
// third, the same API with no issue of the newsletter published yet.
import { clone, create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { LONG_ID, LONG_PAGES, ORIGINAL_ID, ORIGINAL_PDF, PICTURE_ID, PICTURE_PDF, PUBLIC_ISSUE_PDF, REPEAT_ID, REPEAT_PDF, SPREAD_ID, SPREAD_PDF, longPdf, membersIssuePdf } from './synthetic-pdf.mjs';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { randomUUID } from 'node:crypto';
import http2 from 'node:http2';
import net from 'node:net';
import { ApprovalRule, ApprovalRuleService, ApprovalScope } from '../src/gen/nwfl/mensa/v1/approval_pb.js';
import { ContentItemSchema, ContentKind, ContentService, FileAudience, FileRole, ItemState, ItemVisibility, LinkTargetKind, LinkTargetStatus } from '../src/gen/nwfl/mensa/v1/content_pb.js';
import { AccountRoute, MemberStatus, MembershipService, Verification } from '../src/gen/nwfl/mensa/v1/membership_pb.js';
import { Area, EventCategory, EventOccurrenceSchema, EventService, EventVisibility, OccurrenceStatus, VenueKind } from '../src/gen/nwfl/mensa/v1/event_pb.js';
import { OfficeKind, TermStatus } from '../src/gen/nwfl/mensa/v1/roster_pb.js';
import { createEventModel } from './events-model.mjs';
import { createWorkflow } from './workflow.mjs';

const port = Number(process.env['API_PORT'] ?? 9091);
const silentPort = Number(process.env['SILENT_API_PORT'] ?? 9092);
const noIssuesPort = Number(process.env['NO_ISSUES_API_PORT'] ?? 9093);

// As in e2e/stand-in.ts.
const CANARY = { membersInFull: 'MEMBERS-ONLY CANARY PICNIC', noStatus: 'UNPUBLISHED CANARY' };

// A14: the test identity provider's subjects (e2e/idp.mjs), as in e2e/stand-in.ts (ACCOUNTS).
const SUBJECT = { member: '00000000-0000-4000-8000-0000000000b2', mixed: '00000000-0000-4000-8000-0000000000b3', refused: '00000000-0000-4000-8000-0000000000e5', lapsed: '00000000-0000-4000-8000-0000000000f6', articlesDown: '00000000-0000-4000-8000-0000000000a7', stale: '00000000-0000-4000-8000-0000000000b8', enrolee: '00000000-0000-4000-8000-0000000000c1', lapsedOutsider: '00000000-0000-4000-8000-0000000000c4' };
/** Who has member standing (member_account, in the real API): not the pending account, and the officers by their group. */
// D4: "stale" and "lapsed-outsider" have member standing here but no enrolee group in their claim, so the site never
// sends their token. AC6 (b): "enrolee" is in nwfl-users alone, with member standing; "enrolee-pending" has none.
const MEMBER_SUBJECTS = new Set([SUBJECT.member, SUBJECT.mixed, SUBJECT.refused, SUBJECT.lapsed, SUBJECT.articlesDown, SUBJECT.stale, SUBJECT.enrolee, SUBJECT.lapsedOutsider]);
const idpIssuer = process.env['IDP_ISSUER'];
const jwks = process.env['IDP_JWKS_URL'] ? createRemoteJWKSet(new URL(process.env['IDP_JWKS_URL'])) : undefined;

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
  early: '9eafb0c1-d2e3-44f5-86a7-c8d9e0f1a2b3',
};

/** EDITOR E6: the members series' title, which only an officer's read gives. */
const MEMBERS_SERIES_TITLE = 'Members games night';

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

/**
 * Every event from `from` to `to`, as the API gives them to the public; for an officer (E6), the
 * members event whole. @param {string} from @param {string} to @param {'public' | 'members' | 'officers'} [audience]
 */
function calendar(from, to, audience = 'public') {
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
    // Every Sunday: a members event, withheld from the public.
    if (day === 0) {
      out.push(
        audience === 'public'
          ? create(EventOccurrenceSchema, { id: `${SERIES.members}:${date}`, localDate: protoDate(date), area: Area.BAY, visibility: EventVisibility.MEMBERS, detailsWithheld: true })
          : occurrence({ id: `${SERIES.members}:${date}`, seriesId: SERIES.members, title: MEMBERS_SERIES_TITLE, date, start: '19:00', end: '21:00', venue: VENUES.diner, area: Area.BAY, visibility: EventVisibility.MEMBERS }),
      );
    }
  }
  const oneOffs = [
    occurrence({ id: ONE_OFF.games, title: 'Board games afternoon', date: addDays(today, 3), start: '14:00', end: '17:00', venue: VENUES.home, area: Area.OKALOOSA, owner: OFFICE.social }),
    occurrence({ id: ONE_OFF.books, title: 'Online book chat', date: addDays(today, 10), start: '19:00', end: '20:00', venue: VENUES.video, area: Area.VIRTUAL, owner: OFFICE.social }),
    occurrence({ id: ONE_OFF.picnic, title: 'Summer picnic planning', date: addDays(today, 20), area: Area.WALTON, status: OccurrenceStatus.TENTATIVE, owner: OFFICE.social }),
    // W-LOOK2: today, and over in its first minutes: it leaves Coming up, and the month view calls it Past.
    occurrence({ id: ONE_OFF.early, title: 'Early coffee', date: today, start: '00:00', end: '00:01', venue: VENUES.diner, area: Area.BAY, owner: OFFICE.social }),
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

/** @param {string} id @param {FileAudience} audience @param {string} [filename] @param {FileRole} [role] */
const storedFile = (id, audience, filename = `${id}.pdf`, role = FileRole.PRIMARY) => ({ id, filename, mimeType: 'application/pdf', sizeBytes: SIZE, sha256: SHA256, audience, role });
/**
 * A14: a members SOURCE file, listed before each members copy as a buggy API might (a source file is
 * officers-only, and a .docx): a PDF, so only its role tells it apart. As in e2e/stand-in.ts (SOURCE_PDFS).
 * @param {string} membersPdf
 */
const sourceOf = (membersPdf) => `f3${membersPdf.slice(2)}`;

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
      files: [...(d.membersPdf ? [storedFile(sourceOf(d.membersPdf), FileAudience.MEMBERS, 'pensa-mensa-source.pdf', FileRole.SOURCE), storedFile(d.membersPdf, FileAudience.MEMBERS)] : []), storedFile(d.publicPdf, FileAudience.PUBLIC)],
    },
  }),
).sort((a, b) => Number(b.live?.approvedAt?.seconds) - Number(a.live?.approvedAt?.seconds));

/** A one-page PDF with no text: what ReadFile streams for a public file. */
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n',
  'latin1',
);
const PUBLIC_PDFS = new Set(NEWSLETTER.filter((d) => (d.visibility ?? ItemVisibility.PUBLIC) === ItemVisibility.PUBLIC).map((d) => d.publicPdf));
/** The members copy, told apart from the public one by a comment line: what a member's ReadFile streams. */
const MEMBERS_PDF = Buffer.concat([Buffer.from('%PDF-1.4\n% members copy\n', 'latin1'), PDF.subarray(9)]);
// PDFVIEW: the newest issue's copies are made-up PDFs with pages, text and the copies' links
// (e2e/synthetic-pdf.mjs), for the reader at /read/<id>; every other file stays the blank page.
const NEWEST = /** @type {(typeof NEWSLETTER)[number]} */ (NEWSLETTER[0]);
const NEWEST_MEMBERS_PDF = membersIssuePdf('% members copy');
// PDFVIEW fix 1: an original with outside links of every kind, served to an officer only (B1), and a
// file of 5000 pages, served to anyone (S1). Neither is listed anywhere; only /read/<id> opens them.
const LONG_PDF = longPdf(LONG_PAGES);

// A14: the newsletter's articles, as in e2e/stand-in.ts (ARTICLES). A public article with a members
// passage and a members PDF, a members article and an officers article.
const ARTICLES = {
  open: { id: 'e0a00000-0000-4000-8000-000000000001', title: 'A new home for the Wednesday lunch', summary: 'The lunch moves across town in March.', plain: 'The new place has a quiet back room.', passage: 'MEMBERS PASSAGE CANARY: the side gate code is 4321.', publicPdf: 'e0f00000-0000-4000-8000-000000000001', membersPdf: 'e1f00000-0000-4000-8000-000000000001', sourcePdf: 'e3f00000-0000-4000-8000-000000000001' },
  members: { id: 'e0a00000-0000-4000-8000-000000000002', title: 'Members picnic sign-up', summary: 'Bring a dish to share.', body: 'MEMBERS ARTICLE CANARY: the picnic is at the north shelter.' },
  officers: { id: 'e0a00000-0000-4000-8000-000000000003', title: 'OFFICERS ARTICLE CANARY', summary: 'Board notes.', body: 'OFFICERS BODY CANARY', pdf: 'e2f00000-0000-4000-8000-000000000003' },
  withheld: { id: 'e0a00000-0000-4000-8000-000000000004', title: 'Members trip notes, withheld whole', summary: 'Notes from the trip.' },
};
/** What a member may read beyond the public: each public issue's members copy and the article's members PDF. */
const MEMBERS_PDFS = new Set([...NEWSLETTER.filter((d) => d.membersPdf && (d.visibility ?? ItemVisibility.PUBLIC) === ItemVisibility.PUBLIC).map((d) => d.membersPdf), ARTICLES.open.membersPdf]);

/** @param {string} text */
const passage = (text) => ({ kind: { case: /** @type {const} */ ('members'), value: { blocks: [para(text)] } } });
const REDACTED = { kind: { case: /** @type {const} */ ('redacted'), value: {} } };

/**
 * @param {{ id: string, title: string, summary: string }} a @param {ItemVisibility} visibility @param {unknown[]} blocks
 * @param {{ id: string, audience: FileAudience, name: string, role?: FileRole }[]} files @param {number} daysAgo
 */
const article = (a, visibility, blocks, files, daysAgo) =>
  create(ContentItemSchema, {
    id: a.id,
    slug: a.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    kind: ContentKind.ARTICLE,
    officeId: OFFICE.president,
    state: ItemState.PUBLISHED,
    live: { title: a.title, summary: a.summary, visibility, body: { blocks: /** @type {any} */ (blocks) }, approvedAt: timestampFromDate(new Date(Date.now() - daysAgo * 86_400_000)), files: files.map((f) => storedFile(f.id, f.audience, f.name, f.role)) },
  });

/** The articles by audience: what the API sends each. @param {'anonymous' | 'public' | 'members' | 'officers'} audience */
function articles(audience) {
  const memberTree = audience === 'members' || audience === 'officers' || audience === 'anonymous';
  // What the API sends a member besides: a redacted node where its members lens withholds a privacy mark.
  const lens = audience === 'members' || audience === 'officers' ? [REDACTED] : [];
  const open = article(
    ARTICLES.open,
    ItemVisibility.PUBLIC,
    [para(ARTICLES.open.plain), memberTree ? passage(ARTICLES.open.passage) : REDACTED, ...lens],
    // Named as the issue loader names a file: its slug, and -members for the members copy.
    // A members source file first, as a buggy API might list it: never linked, whoever reads.
    [
      ...(audience === 'public' ? [] : [{ id: ARTICLES.open.sourcePdf, audience: FileAudience.MEMBERS, name: 'new-home-for-lunch-source.pdf', role: FileRole.SOURCE }]),
      { id: ARTICLES.open.publicPdf, audience: FileAudience.PUBLIC, name: 'new-home-for-lunch.pdf' },
      ...(audience === 'public' ? [] : [{ id: ARTICLES.open.membersPdf, audience: FileAudience.MEMBERS, name: 'new-home-for-lunch-members.pdf' }]),
    ],
    6,
  );
  const members = article(ARTICLES.members, ItemVisibility.MEMBERS, memberTree ? [para(ARTICLES.members.body), ...lens] : [REDACTED], [], 7);
  const officers = article(ARTICLES.officers, ItemVisibility.OFFICERS, [para(ARTICLES.officers.body)], [{ id: ARTICLES.officers.pdf, audience: FileAudience.OFFICERS, name: 'board-notes.pdf' }], 8);
  // A members article the members lens withholds whole, and the public gets as a placeholder: one redacted node, whoever reads.
  const withheld = article(ARTICLES.withheld, ItemVisibility.MEMBERS, [REDACTED], [], 9);
  // The real API never sends an officers item to anyone else; the anonymous answer is a buggy API's.
  return audience === 'officers' || audience === 'anonymous' ? [open, members, officers, withheld] : [open, members, withheld];
}

/** The issues for a token the API reads as the public's: the public files only, as the real API lists them. */
const PUBLIC_DOCUMENTS = DOCUMENTS.map((d) => {
  const copy = clone(ContentItemSchema, d);
  if (copy.live) copy.live.files = copy.live.files.filter((f) => f.audience === FileAudience.PUBLIC);
  return copy;
});

/**
 * PDFVIEW fix 2: for the "mixed" member only, the newest issue and the oldest are listed as a public copy alone
 * (their members files left out), the other two keep theirs: a members view with a public copy among them.
 */
const MIXED_PUBLIC_ONLY = new Set([NEWSLETTER[0]?.id, NEWSLETTER[3]?.id]);
const MIXED_DOCUMENTS = DOCUMENTS.map((d) => (MIXED_PUBLIC_ONLY.has(d.id) ? PUBLIC_DOCUMENTS.find((p) => p.id === d.id) ?? d : d));
/** The subject of each verified call, for the one answer that depends on who the member is. @type {WeakMap<object, string>} */
const SUBJECT_OF = new WeakMap();

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

// LINKS L4, as in e2e/stand-in.ts (LINKS): every link is on the newest issue's public PDF.
const LINK_FILE = 'f0000000-0000-4000-8000-000000000010';
const LINK_AT = timestampFromDate(new Date('2026-11-04T15:00:00Z'));
const LONG_PATH = `/archive/${'pensa-mensa-'.repeat(160)}end`;
/** @type {Record<string, { url: string, host: string, kind: number, confirm?: boolean, page?: number, members?: true, disabled?: true }>} */
const LINKS = {
  outwebaaaaaaaaaaaaaaaaaaaa: { url: 'https://club.example/picnic?day=sat', host: 'club.example', kind: LinkTargetKind.WEB, page: 2 },
  outsocialaaaaaaaaaaaaaaaaa: { url: 'https://www.facebook.com/groups/nwfl-sample', host: 'www.facebook.com', kind: LinkTargetKind.WEB, confirm: true },
  outmailaaaaaaaaaaaaaaaaaaa: { url: 'mailto:events@example.org', host: 'example.org', kind: LinkTargetKind.MAIL },
  outoffaaaaaaaaaaaaaaaaaaaa: { url: 'https://parked.example/', host: 'parked.example', kind: LinkTargetKind.WEB, page: 3, disabled: true },
  outmembersaaaaaaaaaaaaaaaa: { url: 'https://club.example/members-night', host: 'club.example', kind: LinkTargetKind.WEB, members: true },
  outlongaaaaaaaaaaaaaaaaaaa: { url: `https://club.example${LONG_PATH}`, host: 'club.example', kind: LinkTargetKind.WEB },
  outscriptaaaaaaaaaaaaaaaaa: { url: 'javascript:alert(document.cookie)', host: 'club.example', kind: LinkTargetKind.WEB },
  outanglesaaaaaaaaaaaaaaaaa: { url: 'https://club.example/"><script>alert(1)</script>', host: 'club.example', kind: LinkTargetKind.WEB },
  outrtlaaaaaaaaaaaaaaaaaaaa: { url: 'https://xn--clb-ex-9ua.example/', host: 'clu\u202eb.example', kind: LinkTargetKind.WEB },
};

/** @param {import('@connectrpc/connect').HandlerContext} ctx */
function anonymousOnly(ctx) {
  if (ctx.requestHeader.has('authorization') || ctx.requestHeader.has('cookie')) throw new ConnectError('the site must call as the public', Code.PermissionDenied);
}

/**
 * The caller's audience, for the two reads that may carry a reader's token (A14). Never a cookie.
 * `articles`: the articles read, which fails for the "articles-down" account.
 * @param {import('@connectrpc/connect').HandlerContext} ctx @param {{ articles?: boolean }} [options]
 * @returns {Promise<'anonymous' | 'public' | 'members' | 'officers'>}
 */
async function audienceOf(ctx, { articles = false } = {}) {
  if (ctx.requestHeader.has('cookie')) throw new ConnectError('the site must never send a cookie', Code.PermissionDenied);
  const header = ctx.requestHeader.get('authorization');
  if (header === null) return 'anonymous';
  const token = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i.exec(header)?.[1];
  if (token === undefined || jwks === undefined) throw new ConnectError('invalid token', Code.Unauthenticated);
  /** @type {import('jose').JWTPayload} */
  let payload;
  try {
    ({ payload } = await jwtVerify(token, jwks, { ...(idpIssuer ? { issuer: idpIssuer } : {}), audience: 'nwfl-site', algorithms: ['RS256'], requiredClaims: ['exp', 'sub', 'iat'], maxTokenAge: 3600 }));
  } catch {
    throw new ConnectError('invalid token', Code.Unauthenticated);
  }
  if (payload.sub === SUBJECT.refused) throw new ConnectError('invalid token', Code.Unauthenticated);
  if (articles && payload.sub === SUBJECT.articlesDown) throw new ConnectError('the articles are down', Code.Unavailable);
  SUBJECT_OF.set(ctx, String(payload.sub));
  const groups = Array.isArray(payload['groups']) ? payload['groups'] : [];
  if (groups.includes('nwfl-officers')) return 'officers';
  return MEMBER_SUBJECTS.has(String(payload.sub)) ? 'members' : 'public';
}

// SOLO-APPROVE: the approval rule, one setting per signed-in subject (e2e/stand-in.ts APPROVAL), so
// tests in parallel cannot disturb each other. "officer" reads publishing content as set to one
// approver on November 3, 2026; everyone else starts at two officers. The member starts at one
// approver on both scopes and is answered, as a buggy API might answer, so a page that ever asks for
// a member would show it. Only the Admin may set it, and only their own; a switch from a revision
// that has moved on is refused, as the API refuses it.
const OFFICER_SUBJECT = '00000000-0000-4000-8000-0000000000a1';
const NOV_3 = new Date('2026-11-03T19:35:00Z');
const SEEDED = 'aaaaaaaa-0000-4000-8000-000000000003';
const SCOPES = [ApprovalScope.CONTENT, ApprovalScope.REDACTION_POLICY];
/** @type {Map<string, Map<number, { rule: number, setAt?: Date, revision: string }>>} */
const APPROVAL_RULES = new Map();

/** @param {string} sub */
function rulesFor(sub) {
  let rules = APPROVAL_RULES.get(sub);
  if (!rules) {
    const one = { rule: ApprovalRule.ONE_APPROVER, setAt: NOV_3, revision: SEEDED };
    const two = { rule: ApprovalRule.TWO_PERSON, revision: '' };
    rules = new Map([
      [ApprovalScope.CONTENT, sub === OFFICER_SUBJECT || sub === SUBJECT.member ? one : two],
      [ApprovalScope.REDACTION_POLICY, sub === SUBJECT.member ? one : two],
    ]);
    APPROVAL_RULES.set(sub, rules);
  }
  return rules;
}

/** @param {number} scope @param {{ rule: number, setAt?: Date, revision: string }} setting */
const approvalSetting = (scope, setting) => ({ scope, rule: setting.rule, ...(setting.setAt ? { setAt: timestampFromDate(setting.setAt) } : {}), revision: setting.revision });

/**
 * The signed-in caller, from the verified token, as the API reads it; never a cookie. No token, a bad
 * one or the "refused" account is UNAUTHENTICATED.
 * @param {import('@connectrpc/connect').HandlerContext} ctx
 * @returns {Promise<{ sub: string, groups: string[] }>}
 */
async function verifiedCaller(ctx) {
  if (ctx.requestHeader.has('cookie')) throw new ConnectError('the site must never send a cookie', Code.PermissionDenied);
  const header = ctx.requestHeader.get('authorization');
  if (header === null) throw new ConnectError('sign in first', Code.Unauthenticated);
  const token = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i.exec(header)?.[1];
  if (token === undefined || jwks === undefined) throw new ConnectError('invalid token', Code.Unauthenticated);
  /** @type {import('jose').JWTPayload} */
  let payload;
  try {
    ({ payload } = await jwtVerify(token, jwks, { ...(idpIssuer ? { issuer: idpIssuer } : {}), audience: 'nwfl-site', algorithms: ['RS256'], requiredClaims: ['exp', 'sub', 'iat'], maxTokenAge: 3600 }));
  } catch {
    throw new ConnectError('invalid token', Code.Unauthenticated);
  }
  if (payload.sub === SUBJECT.refused) throw new ConnectError('invalid token', Code.Unauthenticated);
  const groups = Array.isArray(payload['groups']) ? payload['groups'].map(String) : [];
  return { sub: String(payload.sub), groups };
}

/**
 * The signed-in caller of the officer area's RPCs, from the verified token, as the API reads it; never a cookie.
 * An officer or the Admin; for `read`, the member too (the buggy answer above).
 * @param {import('@connectrpc/connect').HandlerContext} ctx @param {{ read?: boolean }} [options]
 * @returns {Promise<{ sub: string, groups: string[] }>}
 */
async function officerOf(ctx, { read = false } = {}) {
  const { sub, groups } = await verifiedCaller(ctx);
  const leaky = read && sub === SUBJECT.member;
  if (!groups.includes('nwfl-officers') && !groups.includes('nwfl-admin') && !leaky) throw new ConnectError('not permitted', Code.PermissionDenied);
  return { sub, groups };
}

/**
 * EDITOR E6: the caller of the calendar's RPCs, as the API reads one: none for no token (the public);
 * an officer or the Admin by their verified token, with the API's audience (officers for the officers
 * group; else members by standing; else the public). Any other token is refused, as is a cookie: the
 * public pages read the calendar as the public, and only the event screens send a token.
 * @param {import('@connectrpc/connect').HandlerContext} ctx
 * @returns {Promise<{ sub: string, groups: string[], audience: 'public' | 'members' | 'officers' } | undefined>}
 */
async function eventCaller(ctx) {
  if (ctx.requestHeader.has('cookie')) throw new ConnectError('the site must never send a cookie', Code.PermissionDenied);
  if (!ctx.requestHeader.has('authorization')) return undefined;
  const { sub, groups } = await verifiedCaller(ctx);
  if (!groups.includes('nwfl-officers') && !groups.includes('nwfl-admin')) throw new ConnectError('the site must call as the public', Code.PermissionDenied);
  return { sub, groups, audience: groups.includes('nwfl-officers') ? 'officers' : MEMBER_SUBJECTS.has(sub) ? 'members' : 'public' };
}

/**
 * EDITOR E6: the calendar for the run, shared by everyone as the API's is. The President hosts the
 * lunch and the members series, the Social Chair the Happy Hour; each one-off keeps its own office. A
 * test that changes the calendar changes a date or an event of its own (e2e/stand-in.ts EVENT_EDITS),
 * so tests in parallel, and the other specs' dates, are never disturbed.
 */
const EVENTS = createEventModel({
  offices: ROSTER.map((o) => ({ id: o.id, slug: o.slug })),
  base: calendar,
  series: [
    { id: SERIES.lunch, slug: 'wednesday-lunchers', title: 'Wednesday Lunchers', category: EventCategory.LUNCH, cadenceLabel: 'Every Wednesday', description: 'Lunch and conversation, every week. Everyone is welcome.', hostOfficeId: OFFICE.president, area: Area.OKALOOSA, visibility: EventVisibility.PUBLIC },
    { id: SERIES.happyHour, slug: 'happy-hour', title: 'Happy Hour', category: EventCategory.HAPPY_HOUR, cadenceLabel: 'Second Friday of each month', description: 'A different place each time.', hostOfficeId: OFFICE.social, area: Area.OKALOOSA, visibility: EventVisibility.PUBLIC },
    { id: SERIES.members, slug: 'members-games-night', title: MEMBERS_SERIES_TITLE, category: EventCategory.OTHER, cadenceLabel: 'Every Sunday', description: 'Games and talk.', hostOfficeId: OFFICE.president, area: Area.BAY, visibility: EventVisibility.MEMBERS },
  ],
  venues: [VENUES.bistro, VENUES.taproom, VENUES.diner, VENUES.home, VENUES.video],
});

// EDITOR E2: the publishing workflow (e2e/workflow.mjs), one for the run, shared by every caller as the
// API's is (a writer and an approver are two people). Who may do what is the model's to decide, from the
// verified token's groups; the content approval rule is each Admin's own (rulesFor above). The seeds
// (e2e/stand-in.ts WORKFLOW) are for reading: a test that changes an item creates its own. Nothing here
// reaches the public reads: an item approved here is not listed on Home or /news.
const WORKFLOW = createWorkflow({
  offices: ROSTER.map((o) => ({ id: o.id, slug: o.slug, title: o.title })),
  ruleFor: (sub) => (/** @type {{ rule: number }} */ (rulesFor(sub).get(ApprovalScope.CONTENT)).rule === ApprovalRule.ONE_APPROVER ? 'one_approver' : 'two_person'),
});
WORKFLOW.seed({ id: 'c0e20000-0000-4000-8000-000000000001', slug: 'seeded-withheld', kind: 'article', officeId: OFFICE.president, state: 'draft', title: 'Seeded: part held back', markup: 'Open words and :members[HELD BACK CANARY]', withheld: true });
WORKFLOW.seed({ id: 'c0e20000-0000-4000-8000-000000000002', slug: 'seeded-waiting', kind: 'announcement', officeId: OFFICE.social, state: 'ready', title: 'Seeded: waiting for approval', summary: 'Bring a chair', markup: 'At the park.\n\n::: members\nThe gate code is 1234.\n:::' });
WORKFLOW.seed({ id: 'c0e20000-0000-4000-8000-000000000003', slug: 'seeded-published', kind: 'president_report', officeId: OFFICE.president, state: 'published', title: 'Seeded: published', markup: 'Thank you all.' });
// EDITOR E3: approved, waiting to be published (A1's VERSION_STATUS_CLEARED).
WORKFLOW.seed({ id: 'c0e20000-0000-4000-8000-000000000004', slug: 'seeded-cleared', kind: 'announcement', officeId: OFFICE.president, state: 'ready', title: 'Seeded: approved, ready to publish', markup: 'See you there.', cleared: true });
// EDITOR E3 fix 1: the President's published item with a change waiting, and one taken down, for "Our news".
WORKFLOW.seed({ id: 'c0e20000-0000-4000-8000-000000000005', slug: 'seeded-changing', kind: 'president_report', officeId: OFFICE.president, state: 'published', title: 'Seeded: published, change waiting', markup: 'Our fall so far.', change: 'ready' });
WORKFLOW.seed({ id: 'c0e20000-0000-4000-8000-000000000006', slug: 'seeded-taken-down', kind: 'announcement', officeId: OFFICE.president, state: 'withdrawn', title: 'Seeded: taken down', markup: 'Gone.' });

// W-SIGNUP: as in e2e/stand-in.ts (ACCOUNTS, SIGNUP_QUEUE). Every member account was last checked on October 20, 2026.
const ENROLEE_PENDING_SUBJECT = '00000000-0000-4000-8000-0000000000c2';
/** W-SIGNUP fix 1: a sign-up an approver rejected; the API removed the account with it, never checked. */
const TURNED_DOWN_SUBJECT = '00000000-0000-4000-8000-0000000000d5';
const APPROVER_SUBJECT = '00000000-0000-4000-8000-0000000000d3';
const CHECKED = { year: 2026, month: 10, day: 20 };
const SIGNUP_QUEUE = [
  { requestId: 'b1000000-0000-4000-8000-000000000001', firstName: 'Jesse', lastName: 'Example', membershipNumber: '000011001', sub: '00000000-0000-4000-8000-0000000001e1', displayName: 'Jesse Example', email: 'jesse@example.org', route: AccountRoute.INVITE, verification: Verification.VERIFIED_LOCAL, verifiedOn: { year: 2026, month: 11, day: 2 }, createdAt: new Date('2026-11-01T15:00:00Z') },
  { requestId: 'b1000000-0000-4000-8000-000000000002', firstName: 'Kendall', lastName: 'Sample', membershipNumber: '000011002', sub: '00000000-0000-4000-8000-0000000001e2', displayName: 'Kendall Sample', email: 'kendall@example.org', route: AccountRoute.SIGNUP, verification: Verification.NOT_FOUND, verifiedOn: { year: 2026, month: 11, day: 2 }, createdAt: new Date('2026-11-01T16:00:00Z') },
  { requestId: 'b1000000-0000-4000-8000-000000000003', firstName: 'Harper', lastName: 'Placeholder', membershipNumber: '000011003', sub: '00000000-0000-4000-8000-0000000001e3', displayName: 'Harper Placeholder', email: 'harper@example.org', route: AccountRoute.SIGNUP, verification: Verification.VERIFIED_OTHER_GROUP, verifiedOn: { year: 2026, month: 11, day: 3 }, createdAt: new Date('2026-11-02T15:00:00Z') },
  { requestId: 'b1000000-0000-4000-8000-000000000004', firstName: 'Blair', lastName: 'Example', membershipNumber: '000011004', sub: APPROVER_SUBJECT, displayName: 'Blair Example', email: 'blair@example.org', route: AccountRoute.SIGNUP, verification: Verification.UNCHECKED, createdAt: new Date('2026-11-03T15:00:00Z') },
  // VET: an email the membership verification service did not confirm, and a number an earlier sign-up (Jordan Firstclaim, approved, no longer queued) claimed first.
  { requestId: 'b1000000-0000-4000-8000-000000000005', firstName: 'Dana', lastName: 'Mismatch', membershipNumber: '000011005', sub: '00000000-0000-4000-8000-0000000001e5', displayName: 'Dana Mismatch', email: 'dana@example.org', route: AccountRoute.SIGNUP, verification: Verification.EMAIL_MISMATCH, verifiedOn: { year: 2026, month: 11, day: 4 }, createdAt: new Date('2026-11-04T15:00:00Z') },
  { requestId: 'b1000000-0000-4000-8000-000000000006', firstName: 'Drew', lastName: 'Secondclaim', membershipNumber: '000011006', sub: '00000000-0000-4000-8000-0000000001e6', displayName: 'Drew Secondclaim', email: 'drew@example.org', route: AccountRoute.SIGNUP, verification: Verification.DUPLICATE_CLAIM, verifiedOn: { year: 2026, month: 11, day: 4 }, createdAt: new Date('2026-11-04T16:00:00Z'), earlierClaim: { displayName: 'Jordan Firstclaim', signedUpAt: new Date('2026-10-28T15:00:00Z'), firstName: 'Jordan', lastName: 'Firstclaim', membershipNumber: '000011006' } },
  // VET fix 1 (N2): a number an earlier sign-up claimed, since rejected: the API sends no name, only that it is closed.
  { requestId: 'b1000000-0000-4000-8000-000000000007', firstName: 'Eli', lastName: 'Thirdclaim', membershipNumber: '000011007', sub: '00000000-0000-4000-8000-0000000001e7', displayName: 'Eli Thirdclaim', email: 'eli@example.org', route: AccountRoute.SIGNUP, verification: Verification.DUPLICATE_CLAIM, verifiedOn: { year: 2026, month: 11, day: 5 }, createdAt: new Date('2026-11-05T15:00:00Z'), earlierClaim: { displayName: '', closed: true, signedUpAt: new Date('2026-10-20T15:00:00Z') } },
];
/** REOPEN: rejected sign-ups, newest first; the first three are reopened by one browser project each (e2e/stand-in.ts REJECTED). */
const REJECTED = [
  { requestId: 'c1000000-0000-4000-8000-000000000001', firstName: 'Ari', lastName: 'Example', membershipNumber: '000022001', sub: '00000000-0000-4000-8000-0000000000e1', displayName: 'Ari Example', email: 'ari@example.org', verification: Verification.NOT_FOUND, verifiedOn: { year: 2026, month: 11, day: 3 }, rejectedAt: new Date('2026-11-04T18:00:00Z') },
  { requestId: 'c1000000-0000-4000-8000-000000000002', firstName: 'Bo', lastName: 'Sample', membershipNumber: '000022002', sub: '00000000-0000-4000-8000-0000000000e2', displayName: 'Bo Sample', email: 'bo@example.org', verification: Verification.UNCHECKED, rejectedAt: new Date('2026-11-04T17:00:00Z') },
  { requestId: 'c1000000-0000-4000-8000-000000000003', firstName: 'Cam', lastName: 'Placeholder', membershipNumber: '000022003', sub: '00000000-0000-4000-8000-0000000000e3', displayName: 'Cam Placeholder', email: 'cam@example.org', verification: Verification.UNCHECKED, rejectedAt: new Date('2026-11-04T16:00:00Z') },
  { requestId: 'c1000000-0000-4000-8000-000000000004', firstName: 'Harley', lastName: 'Sample', membershipNumber: '000022004', sub: '00000000-0000-4000-8000-0000000001e4', displayName: 'Harley Sample', email: 'harley@example.org', verification: Verification.VERIFIED_OTHER_GROUP, verifiedOn: { year: 2026, month: 11, day: 2 }, rejectedAt: new Date('2026-11-03T16:00:00Z') },
];
/** REOPEN: the Membership Officer's seat without the approvers group, whose token the membership calls refuse (e2e/idp.mjs seat-refused). */
const REFUSED_SEAT_SUBJECT = '00000000-0000-4000-8000-0000000000e7';
/** @type {Set<string>} REOPEN: the rejections reopened, by request id, for everyone */
const REOPENED = new Set();
/** @type {Map<string, number>} a sign-in's own sign-up, by the token's jti: its route */
const SIGNUPS = new Map();
/** @type {Map<string, Set<string>>} a sign-in's decisions, by the token's jti */
const DECIDED = new Map();
/** PROFILE-ID: the member's profile as approved (e2e/stand-in.ts MEMBER_PROFILE); the others have none. */
const MEMBER_PROFILE = { firstName: 'Jordan', lastName: 'Example', membershipNumber: '000033001' };
/** @type {Map<string, { firstName: string, lastName: string }>} PROFILE-ID: a sign-in's change of names, by the token's jti */
const RENAMED = new Map();
/** As the API's: 1 to 80 characters, no control character. @param {string} name */
const nameOk = (name) => name !== '' && [...name].length <= 80 && !/\p{Cc}/u.test(name);

/**
 * The signed-in person of a membership RPC, from the verified token, as the API reads it; never a cookie.
 * @param {import('@connectrpc/connect').HandlerContext} ctx
 * @returns {Promise<{ sub: string, groups: string[], session: string }>}
 */
async function personOf(ctx) {
  if (ctx.requestHeader.has('cookie')) throw new ConnectError('the site must never send a cookie', Code.PermissionDenied);
  const header = ctx.requestHeader.get('authorization');
  if (header === null) throw new ConnectError('sign in first', Code.Unauthenticated);
  const token = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i.exec(header)?.[1];
  if (token === undefined || jwks === undefined) throw new ConnectError('invalid token', Code.Unauthenticated);
  /** @type {import('jose').JWTPayload} */
  let payload;
  try {
    ({ payload } = await jwtVerify(token, jwks, { ...(idpIssuer ? { issuer: idpIssuer } : {}), audience: 'nwfl-site', algorithms: ['RS256'], requiredClaims: ['exp', 'sub', 'iat'], maxTokenAge: 3600 }));
  } catch {
    throw new ConnectError('invalid token', Code.Unauthenticated);
  }
  if (payload.sub === SUBJECT.refused || payload.sub === REFUSED_SEAT_SUBJECT) throw new ConnectError('invalid token', Code.Unauthenticated);
  const groups = Array.isArray(payload['groups']) ? payload['groups'].map(String) : [];
  return { sub: String(payload.sub), groups, session: String(payload.jti ?? token) };
}

/**
 * The account the API would hold: the members since October 20, the pending enrolee, the rejected
 * sign-up (removed, never checked), this sign-in's own sign-up. Being an officer or the Admin gives no
 * account, as in the API: nothing opens one for them, and they need none (W-SIGNUP fix 1).
 * @param {{ sub: string, session: string }} person
 */
function accountOf({ sub, session }) {
  const route = SIGNUPS.get(session);
  if (route !== undefined) return { status: MemberStatus.PENDING, route };
  if (MEMBER_SUBJECTS.has(sub)) return { status: MemberStatus.MEMBER, route: AccountRoute.INVITE, verifiedOn: CHECKED };
  if (sub === ENROLEE_PENDING_SUBJECT) return { status: MemberStatus.PENDING, route: AccountRoute.SIGNUP };
  if (sub === TURNED_DOWN_SUBJECT) return { status: MemberStatus.REMOVED, route: AccountRoute.SIGNUP };
  // REOPEN: rejected and removed until reopened; then no account, as for one who never signed up.
  const rejected = REJECTED.find((r) => r.sub === sub);
  if (rejected !== undefined && !REOPENED.has(rejected.requestId)) return { status: MemberStatus.REMOVED, route: AccountRoute.SIGNUP };
  return undefined;
}

/** The approvers and the Admin, as requireMembershipApprover. @param {import('@connectrpc/connect').HandlerContext} ctx */
async function approverOf(ctx) {
  const person = await personOf(ctx);
  if (!person.groups.includes('nwfl-membership-approvers') && !person.groups.includes('nwfl-admin')) throw new ConnectError('not permitted', Code.PermissionDenied);
  return person;
}

/** REOPEN: the Admin and the Membership Officer's seat, as requireSignupReopener. @param {import('@connectrpc/connect').HandlerContext} ctx */
async function reopenerOf(ctx) {
  const person = await personOf(ctx);
  if (!person.groups.includes('nwfl-admin') && !person.groups.includes('nwfl-office-membership')) throw new ConnectError('not permitted', Code.PermissionDenied);
  return person;
}

/** A pending sign-up this sign-in may decide, marked decided. @param {{ sub: string, session: string }} person @param {string} id @param {boolean} approve */
function decide(person, id, approve, confirmedWarning = false) {
  const request = SIGNUP_QUEUE.find((r) => r.requestId === id);
  if (request === undefined) throw new ConnectError('sign-up not found', Code.NotFound);
  if (request.sub === person.sub) throw new ConnectError('no one decides their own sign-up', Code.PermissionDenied);
  const decided = DECIDED.get(person.session) ?? new Set();
  if (decided.has(id)) throw new ConnectError('this sign-up is already decided', Code.FailedPrecondition);
  if (approve && request.verification === Verification.VERIFIED_OTHER_GROUP) throw new ConnectError('an other-group member is not approved', Code.FailedPrecondition);
  // VET fix 1: as the API, an email mismatch or a duplicate claim only with the approver's confirmation.
  if (approve && !confirmedWarning && (request.verification === Verification.EMAIL_MISMATCH || request.verification === Verification.DUPLICATE_CLAIM)) {
    throw new ConnectError('confirm the warning, then approve with confirmed_warning', Code.FailedPrecondition);
  }
  decided.add(id);
  DECIDED.set(person.session, decided);
}

/** The API's routes; with `issues: false`, nothing of the newsletter is published yet. @param {{ issues: boolean }} options */
const routes = ({ issues }) => (/** @type {import('@connectrpc/connect').ConnectRouter} */ router) => {
  // EDITOR E6: the calendar, with every save in it (EVENTS above).
  router.service(EventService, EVENTS.handlers(eventCaller));
  router.service(ContentService, {
    // EDITOR E2: the publishing workflow, as the verified caller.
    ...WORKFLOW.handlers(verifiedCaller),
    getRoster: (_req, ctx) => {
      anonymousOnly(ctx);
      return { offices: ROSTER };
    },
    listPublishedItems: async (req, ctx) => {
      // Only /news's two reads (live.ts: DOCUMENT, page 50; ARTICLE, page 10) may carry a reader's token:
      // Home, /finances or the President's report sending one is refused, as every other RPC refuses it.
      const news = (req.kind === ContentKind.DOCUMENT && req.pageSize === 50) || (req.kind === ContentKind.ARTICLE && req.pageSize === 10);
      if (!news) anonymousOnly(ctx);
      const audience = await audienceOf(ctx, { articles: req.kind === ContentKind.ARTICLE });
      const documents = audience === 'public' ? PUBLIC_DOCUMENTS : SUBJECT_OF.get(ctx) === SUBJECT.mixed ? MIXED_DOCUMENTS : DOCUMENTS;
      const items =
        req.kind === ContentKind.DOCUMENT ? (issues ? documents : [])
        : req.kind === ContentKind.ARTICLE ? (issues ? articles(audience) : [])
        : (ITEMS[/** @type {keyof typeof ITEMS} */ (req.kind)] ?? []);
      return { items: items.slice(0, req.pageSize || 20) };
    },
    // A public file's bytes, and a members copy for a member; anything else is not found, as the API answers a withheld file.
    readFile: async function* (req, ctx) {
      const audience = await audienceOf(ctx);
      const extra =
        issues && req.fileId === LONG_ID ? LONG_PDF
        : issues && req.fileId === PICTURE_ID ? PICTURE_PDF
        : issues && req.fileId === REPEAT_ID ? REPEAT_PDF
        : issues && req.fileId === SPREAD_ID ? SPREAD_PDF
        : issues && audience === 'officers' && req.fileId === ORIGINAL_ID ? ORIGINAL_PDF
        : undefined;
      if (extra) {
        yield { part: { case: /** @type {const} */ ('head'), value: { filename: 'pensa-mensa.pdf', mimeType: 'application/pdf', sizeBytes: BigInt(extra.length) } } };
        yield { part: { case: /** @type {const} */ ('chunk'), value: new Uint8Array(extra) } };
        return;
      }
      const members = (audience === 'members' || audience === 'officers') && MEMBERS_PDFS.has(req.fileId);
      if (!issues || (!PUBLIC_PDFS.has(req.fileId) && req.fileId !== ARTICLES.open.publicPdf && !members)) throw new ConnectError('file not found', Code.NotFound);
      const bytes = members ? (req.fileId === NEWEST.membersPdf ? NEWEST_MEMBERS_PDF : MEMBERS_PDF) : req.fileId === NEWEST.publicPdf ? PUBLIC_ISSUE_PDF : PDF;
      // The same title-based name for both copies, as the API builds it.
      yield { part: { case: /** @type {const} */ ('head'), value: { filename: 'pensa-mensa.pdf', mimeType: 'application/pdf', sizeBytes: BigInt(bytes.length) } } };
      yield { part: { case: /** @type {const} */ ('chunk'), value: new Uint8Array(bytes) } };
    },
    getLinkTarget: async (req, ctx) => {
      const audience = await audienceOf(ctx);
      const link = Object.hasOwn(LINKS, req.linkId) ? LINKS[req.linkId] : undefined;
      // The copy this audience is served holds the link: the members copy alone holds a members link.
      const held = audience === 'members' || (audience !== 'officers' && !link?.members);
      if (!issues || link === undefined || (!held && !(link.disabled && audience === 'officers'))) throw new ConnectError('link not found', Code.NotFound);
      const place = { fileId: LINK_FILE, page: link.page ?? 1, statusAt: LINK_AT };
      if (link.disabled) return { status: LinkTargetStatus.DISABLED, url: link.url, host: link.host, ...place };
      return { status: LinkTargetStatus.ACTIVE, url: link.url, host: link.host, kind: link.kind, confirm: link.confirm ?? false, ...place };
    },
  });
  router.service(ApprovalRuleService, {
    getApprovalRules: async (_req, ctx) => {
      const rules = rulesFor((await officerOf(ctx, { read: true })).sub);
      return { settings: SCOPES.map((scope) => approvalSetting(scope, /** @type {{ rule: number, revision: string }} */ (rules.get(scope)))) };
    },
    setApprovalRule: async (req, ctx) => {
      const { sub, groups } = await officerOf(ctx);
      if (!groups.includes('nwfl-admin')) throw new ConnectError('not permitted', Code.PermissionDenied);
      const reason = req.reason.trim();
      if (!SCOPES.includes(req.scope) || ![ApprovalRule.TWO_PERSON, ApprovalRule.ONE_APPROVER].includes(req.rule) || !/[\p{Alphabetic}0-9]/u.test(reason) || reason.length > 2000) {
        throw new ConnectError('a value is not allowed', Code.InvalidArgument);
      }
      const rules = rulesFor(sub);
      const now = /** @type {{ rule: number, revision: string }} */ (rules.get(req.scope));
      const changed = now.rule !== req.rule;
      if (changed && req.expectedRevision !== undefined && req.expectedRevision !== now.revision) {
        throw new ConnectError('the approval rule was switched since it was read', Code.FailedPrecondition);
      }
      if (changed) rules.set(req.scope, { rule: req.rule, setAt: new Date(), revision: randomUUID() });
      return { setting: approvalSetting(req.scope, /** @type {{ rule: number, revision: string }} */ (rules.get(req.scope))), changed };
    },
    listApprovalRuleChanges: async (_req, ctx) => {
      await officerOf(ctx);
      return { changes: [] };
    },
  });
  router.service(MembershipService, {
    getMyAccount: async (_req, ctx) => {
      const person = await personOf(ctx);
      const account = accountOf(person);
      if (account === undefined) return {};
      return person.sub === SUBJECT.member ? { account, profile: { ...MEMBER_PROFILE, ...RENAMED.get(person.session) } } : { account };
    },
    updateMyProfile: async (req, ctx) => {
      const person = await personOf(ctx);
      if ((req.$unknown?.length ?? 0) > 0) throw new ConnectError('only the first and last name can be changed', Code.InvalidArgument);
      const firstName = req.firstName.trim();
      const lastName = req.lastName.trim();
      if (!nameOk(firstName) || !nameOk(lastName)) throw new ConnectError('a name is not allowed', Code.InvalidArgument);
      if (person.sub !== SUBJECT.member) throw new ConnectError('only an approved member has a profile to change', Code.FailedPrecondition);
      RENAMED.set(person.session, { firstName, lastName });
      return {};
    },
    submitSignup: async (req, ctx) => {
      const person = await personOf(ctx);
      if (accountOf(person) !== undefined) throw new ConnectError('a sign-up is already on file for this account', Code.AlreadyExists);
      const number = req.membershipNumber.trim();
      const lastName = req.lastName.trim();
      if (number === '') throw new ConnectError('a membership number is needed', Code.InvalidArgument);
      if (!/^[0-9]{1,12}$/.test(number)) throw new ConnectError('a membership number is 1 to 12 digits', Code.InvalidArgument);
      if (lastName === '' || [...lastName].length > 80) throw new ConnectError('a last name is needed', Code.InvalidArgument);
      SIGNUPS.set(person.session, person.groups.includes('nwfl-invited') ? AccountRoute.INVITE : AccountRoute.SIGNUP);
      return { requestId: randomUUID() };
    },
    listSignupRequests: async (_req, ctx) => {
      const { session } = await approverOf(ctx);
      const decided = DECIDED.get(session) ?? new Set();
      return {
        // The subject stays here: the API never sends it.
        requests: SIGNUP_QUEUE.filter((r) => !decided.has(r.requestId)).map((r) => ({
          requestId: r.requestId,
          displayName: r.displayName,
          email: r.email,
          route: r.route,
          verification: r.verification,
          ...(r.verifiedOn ? { verifiedOn: r.verifiedOn } : {}),
          createdAt: timestampFromDate(r.createdAt),
          firstName: r.firstName,
          lastName: r.lastName,
          membershipNumber: r.membershipNumber,
          ...(r.earlierClaim
            ? {
                earlierClaim: {
                  displayName: r.earlierClaim.displayName,
                  signedUpAt: timestampFromDate(r.earlierClaim.signedUpAt),
                  closed: r.earlierClaim.closed === true,
                  firstName: r.earlierClaim.firstName ?? '',
                  lastName: r.earlierClaim.lastName ?? '',
                  membershipNumber: r.earlierClaim.membershipNumber ?? '',
                },
              }
            : {}),
        })),
      };
    },
    approveSignup: async (req, ctx) => {
      decide(await approverOf(ctx), req.requestId, true, req.confirmedWarning);
      return { account: { status: MemberStatus.MEMBER, route: AccountRoute.SIGNUP } };
    },
    rejectSignup: async (req, ctx) => {
      decide(await approverOf(ctx), req.requestId, false);
      return {};
    },
    listRejectedSignups: async (_req, ctx) => {
      const { sub } = await reopenerOf(ctx);
      return {
        // The subject stays here: the API never sends it.
        requests: REJECTED.filter((r) => !REOPENED.has(r.requestId) && r.sub !== sub).map((r) => ({
          requestId: r.requestId,
          displayName: r.displayName,
          email: r.email,
          verification: r.verification,
          ...(r.verifiedOn ? { verifiedOn: r.verifiedOn } : {}),
          rejectedAt: timestampFromDate(r.rejectedAt),
          firstName: r.firstName,
          lastName: r.lastName,
          membershipNumber: r.membershipNumber,
        })),
      };
    },
    reopenSignup: async (req, ctx) => {
      const person = await reopenerOf(ctx);
      const rejected = REJECTED.find((r) => r.requestId === req.requestId);
      if (rejected === undefined) throw new ConnectError('sign-up not found', Code.NotFound);
      if (rejected.sub === person.sub) throw new ConnectError('no one reopens their own sign-up', Code.PermissionDenied);
      if (REOPENED.has(rejected.requestId)) throw new ConnectError('only a rejected sign-up is reopened, and only once', Code.FailedPrecondition);
      REOPENED.add(rejected.requestId);
      return {};
    },
  });
};

/** @param {{ issues: boolean }} options */
const adapter = (options) => connectNodeAdapter({ grpc: true, grpcWeb: false, connect: false, routes: routes(options) });

http2.createServer(adapter({ issues: true })).listen(port, '127.0.0.1', () => console.log(JSON.stringify({ msg: 'stand-in API listening', port })));
http2.createServer(adapter({ issues: false })).listen(noIssuesPort, '127.0.0.1', () => console.log(JSON.stringify({ msg: 'stand-in API with no issue listening', port: noIssuesPort })));
net.createServer(() => {}).listen(silentPort, '127.0.0.1', () => console.log(JSON.stringify({ msg: 'silent API listening', port: silentPort })));
