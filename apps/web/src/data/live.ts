// The live sections (R4, R22), read from nwfl-mensa-api and shaped for the
// pages: the calendar, the roster, the treasurer's summaries, the President's
// report and the announcements. Everything here is what the API gives the
// public, and on top of that only public events and public items are kept: a
// members event or item never reaches a page or a feed, even if the API sent
// more than it should.
//
// /news alone (A14: news() and file()) may be read as a signed-in reader, with
// their token. The API decides what the token may see; the view here follows
// the API's answer, never the session: a members copy, a members item, a
// members passage or a members file only where the API sent it to that reader,
// and never an officers item or file, or a source file, even to an officer.
// Whether the API read the reader as a member is decided from its whole
// answer, never item by item. A refused token is asked again once as the
// public. Nothing is kept between calls: one reader's answer never reaches
// another's page.
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { type ContentItem, ContentKind, FileAudience, FileRole, ItemVisibility, type StoredFile } from '../gen/nwfl/mensa/v1/content_pb.js';
import { Area, type EventOccurrence, EventVisibility, OccurrenceStatus, type Venue, VenueKind } from '../gen/nwfl/mensa/v1/event_pb.js';
import { TermStatus } from '../gen/nwfl/mensa/v1/roster_pb.js';
import { ApiNotFound, type ApiReads, ApiTokenRefused, ApiUnavailable, type FileRead, type Reader, sendable } from '../lib/api/client';
import { type CalendarEvent, type CalendarVenue, type EventStatus, centralParts, eventPath } from '../lib/calendar';
import { type View, documentHtml, hasMembers, hasRedacted, withheldHtml } from '../lib/document';
import { type Issue, type Office, newestFirst } from './site-data';

/** A published item as a page shows it. */
export interface ItemView {
  slug: string;
  title: string;
  summary: string;
  /** Rendered and escaped by documentHtml, for set:html. */
  bodyHtml: string;
  /** The Central date it was published. */
  publishedOn: string | undefined;
  source: 'submitted';
  /** The item's public PDFs, each served at /documents/<id>.pdf (REDACT R3c). */
  files: FileLink[];
}

export interface FileLink {
  href: string;
  label: string;
  /** A members file, in a member's view only (A14). */
  members?: true;
}

/** A newsletter article on /news (A14). */
export interface NewsItemView extends ItemView {
  /** A members item: the page marks it so ("Members only, please don't forward"). */
  membersOnly: boolean;
}

/** /news as one reader may have it (A14). */
export interface News {
  /** The issues, newest first; each with its members copy only in a member's view. */
  issues: Issue[];
  /** The newsletter's published articles, at most ARTICLES_PAGE. */
  items: NewsItemView[];
  /** A reader's token went, and the API answered with it. */
  signedIn: boolean;
  /** The API refused the reader's token: this is the public's view, and the page says to ask for help (signing in again would be refused too). */
  tokenRefused: boolean;
  /**
   * The API could not give a reader the articles (items is empty): the page says so, and still lists the issues.
   * Never for the public, whose /news is then what it was before it showed any article.
   */
  itemsUnavailable: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface EventDetails {
  event: CalendarEvent;
  /** The series' "Every Wednesday", if it is one. */
  cadence: string;
  /** The series' description. */
  about: string;
  /** The role address to ask, once it is known to deliver (R2). */
  contact: string | undefined;
}

export interface LiveData {
  events(from: string, to: string): Promise<CalendarEvent[]>;
  /** undefined: no such public event. */
  event(id: string): Promise<EventDetails | undefined>;
  offices(): Promise<Office[]>;
  treasurerSummaries(): Promise<ItemView[]>;
  presidentReport(): Promise<ItemView | undefined>;
  announcements(): Promise<ItemView[]>;
  /** The newsletter's published issues, newest first, each with its public PDF. */
  issues(): Promise<Issue[]>;
  /** /news: the issues and the articles, as the reader may have them, or as the public with no reader. `signIn`: where Sign in is, for the public box. */
  news(as?: Reader, options?: { signIn?: string | undefined }): Promise<News>;
  /** A PDF as the public, or the reader, may have it; not found for anything that is not a file id. */
  file(id: string, as?: Reader): Promise<FileRead>;
}

export interface LiveOptions {
  /** D1: list members items to the public by title and summary, with the placeholder. Off: they are not listed at all. */
  membersTeasers?: boolean;
}

export const AREAS: Record<Area, string> = {
  [Area.UNSPECIFIED]: 'Northwest Florida',
  [Area.OKALOOSA]: 'Okaloosa County',
  [Area.WALTON]: 'Walton County',
  [Area.BAY]: 'Bay County',
  [Area.ESCAMBIA_SANTA_ROSA]: 'Escambia and Santa Rosa Counties',
  [Area.VIRTUAL]: 'Online',
  [Area.ELSEWHERE]: 'Outside our area',
};

const STATUSES: Partial<Record<OccurrenceStatus, EventStatus>> = {
  [OccurrenceStatus.SCHEDULED]: 'scheduled',
  [OccurrenceStatus.TENTATIVE]: 'tentative',
  [OccurrenceStatus.CANCELLED]: 'cancelled',
  [OccurrenceStatus.MOVED]: 'moved',
};

/** A public event the API sent in full, with a status and a date: the only kind any page or feed shows. */
export function isPublicEvent(o: EventOccurrence): boolean {
  return o.visibility === EventVisibility.PUBLIC && !o.detailsWithheld && STATUSES[o.status] !== undefined && o.localDate !== undefined;
}

function https(url: string): string | undefined {
  try {
    return new URL(url).protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

function venueOf(venue: Venue | undefined): CalendarVenue | undefined {
  if (venue === undefined) return undefined;
  const common = { name: venue.name, url: https(venue.url), accessibilityNote: venue.accessibilityNote, hostOfficeId: venue.hostOfficeId };
  switch (venue.kind) {
    case VenueKind.BUSINESS:
      return { kind: 'business', ...common, address: venue.businessAddress, city: venue.city };
    case VenueKind.VIRTUAL:
      return { kind: 'virtual', ...common, address: '', city: '' };
    case VenueKind.MEMBER_HOME:
      // R3: the area and the host's role address, never a street, city or link.
      return { kind: 'home', name: venue.name, address: '', city: '', url: undefined, accessibilityNote: venue.accessibilityNote, hostOfficeId: venue.hostOfficeId };
    default:
      return undefined;
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

function toEvent(o: EventOccurrence): CalendarEvent {
  const d = o.localDate!;
  const end = o.endsAt === undefined ? undefined : centralParts(timestampDate(o.endsAt));
  return {
    id: o.id,
    path: eventPath(o.id),
    title: o.title,
    date: `${d.year}-${pad(d.month)}-${pad(d.day)}`,
    start: o.startsAt === undefined ? undefined : centralParts(timestampDate(o.startsAt)).time,
    end,
    status: STATUSES[o.status]!,
    statusNote: o.statusNote,
    detail: o.detail,
    url: https(o.url),
    venue: venueOf(o.venue),
    area: AREAS[o.area] ?? AREAS[Area.UNSPECIFIED],
    seriesId: o.seriesId,
    ownerOfficeId: o.ownerOfficeId,
    source: 'submitted',
  };
}

/** `withheld`: a members item the reader may not read, shown by title and summary only (a teaser, D1): the box, never its body or files. */
function itemView(item: ContentItem, render: { view?: View; signIn?: string | undefined; withheld?: boolean } = {}): ItemView {
  const live = item.live!;
  return {
    // Whatever the API put in the slug field: the item's id when anything in it is
    // withheld from the public (REDACT R2a), so a page never shows the original.
    slug: item.slug || item.id,
    title: live.title,
    summary: live.summary,
    bodyHtml: render.withheld ? withheldHtml(render) : documentHtml(live.body, render),
    publishedOn: live.approvedAt === undefined ? undefined : centralParts(timestampDate(live.approvedAt)).date,
    source: 'submitted',
    files: render.withheld ? [] : render.view === 'members' ? [...publicPdfs(live.files), ...membersPdfs(live.files)] : publicPdfs(live.files),
  };
}

/** An item's public PDFs, never a members or officers file, a source file, or a file whose id is not one. */
function publicPdfs(files: readonly StoredFile[]): FileLink[] {
  return files
    .filter((f) => f.mimeType === 'application/pdf' && f.audience === FileAudience.PUBLIC && f.role !== FileRole.SOURCE && UUID.test(f.id))
    .map((f) => ({ href: `/documents/${f.id}.pdf`, label: f.filename }));
}

/** An item's members PDFs, for a member's view only: members and primary, a PDF, with an id; never an officers or source file. */
function membersPdfs(files: readonly StoredFile[]): FileLink[] {
  return files
    .filter((f) => f.mimeType === 'application/pdf' && f.audience === FileAudience.MEMBERS && f.role === FileRole.PRIMARY && UUID.test(f.id))
    .map((f) => ({ href: `/documents/${f.id}.pdf`, label: f.filename, members: true as const }));
}

const publicItems = (items: readonly ContentItem[]) => items.filter((i) => i.live?.visibility === ItemVisibility.PUBLIC).map((i) => itemView(i));

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** The issue loader's title (apps/api README, "Loading a newsletter issue"): two months of one year. */
const ISSUE_TITLE = new RegExp(`^Pensa Mensa, (${MONTHS.join('|')})-(${MONTHS.join('|')}) ([0-9]{4})$`);
/** The API's largest page: some eight years of issues. */
const ISSUES_PAGE = 50;
/** One page of articles on /news; the page token is never used, so it never reaches a URL. */
export const ARTICLES_PAGE = 10;

/**
 * An issue of Pensa Mensa as the issue loader publishes it: a public DOCUMENT whose title names
 * its months, with its public PDF. The title and summary are shown as the API gave them; the
 * slug is never read, since the API may put the item's id there. Anything else is not an issue.
 */
function issueView(item: ContentItem, members = false): Issue | undefined {
  const live = item.live;
  if (item.kind !== ContentKind.DOCUMENT || live?.visibility !== ItemVisibility.PUBLIC) return undefined;
  const [, first, second, year] = ISSUE_TITLE.exec(live.title) ?? [];
  const month = MONTHS.indexOf(first ?? '');
  if (month < 0 || MONTHS[month + 1] !== second) return undefined;
  const pdf = publicPdfs(live.files)[0];
  if (pdf === undefined) return undefined;
  const issue: Issue = { period: `${year}-${pad(month + 1)}`, label: live.title, summary: live.summary, pdf: pdf.href, source: 'pipeline' };
  // The issue loader's members copy: audience members, role primary (apps/api/src/load/load.ts).
  const copy = members ? membersPdfs(live.files)[0] : undefined;
  return copy === undefined ? issue : { ...issue, membersPdf: copy.href };
}

const issueList = (items: readonly ContentItem[], members: boolean) =>
  items
    .map((item) => issueView(item, members))
    .filter((issue) => issue !== undefined)
    .sort(newestFirst);

/**
 * Whether the answer as a whole shows that the API read the reader as a member (or an officer): a members
 * node in any body, or a members file on any item, in either list. The API never sends the public either:
 * its tree is filtered before it leaves, and it is listed public files only (apps/api content/service.ts).
 * Then a redacted node anywhere in the answer is something withheld from members too, not a sign of the
 * public's view.
 */
function answeredAsMember(lists: readonly (readonly ContentItem[])[]): boolean {
  return lists.some((items) => items.some(({ live }) => live !== undefined && (hasMembers(live.body) || live.files.some((f) => f.audience === FileAudience.MEMBERS))));
}

/** How the API answered /news: `reader` a token went; `signedIn` the API answered it; `member` and read it as a member's. */
interface Answer {
  reader: boolean;
  signedIn: boolean;
  member: boolean;
}

/**
 * The articles as one reader may have them. A public item always; a members item when the API answered as
 * for a member, or, when nothing in the answer shows that, when it sent that reader the item's tree (no
 * redacted node in it); as a teaser when D1's switch is on; an officers item never, whoever reads. Each body
 * is rendered for what the API answered: the members view for a member's answer or tree, the signed-in box
 * for a reader the API answered as the public's (a refused token included, so no box sends them to sign in
 * again), and the public box with no reader. A teaser is its title and summary with the box alone: whatever
 * body or files the API sent are not read.
 */
function newsItemViews(items: readonly ContentItem[], answer: Answer, signIn: string | undefined, teasers: boolean): NewsItemView[] {
  return items.flatMap((item) => {
    const live = item.live;
    if (live === undefined) return [];
    const answeredAsPublic = !answer.member && (!answer.signedIn || hasRedacted(live.body));
    const membersOnly = live.visibility === ItemVisibility.MEMBERS;
    const shown = live.visibility === ItemVisibility.PUBLIC || (membersOnly && (!answeredAsPublic || teasers));
    if (!shown) return [];
    const view: View = !answeredAsPublic ? 'members' : answer.reader ? 'signed-in-public' : 'public';
    const withheld = membersOnly && answeredAsPublic;
    return [{ ...itemView(item, { view, signIn: view === 'public' ? signIn : undefined, withheld }), membersOnly }];
  });
}

export function liveData(reads: ApiReads, { membersTeasers = false }: LiveOptions = {}): LiveData {
  /** The articles, or undefined when the API could not give them: the issues, there before A14, never wait on them. */
  const articles = (as: Reader | undefined) =>
    reads.listPublishedItems(ContentKind.ARTICLE, ARTICLES_PAGE, as).catch((error: unknown) => {
      if (error instanceof ApiUnavailable) return undefined;
      throw error;
    });
  /** Both news lists, as the reader, or as the public. */
  const newsLists = (as: Reader | undefined) => Promise.all([reads.listPublishedItems(ContentKind.DOCUMENT, ISSUES_PAGE, as), articles(as)]);

  return {
    events: async (from, to) => (await reads.listOccurrences(from, to)).filter(isPublicEvent).map(toEvent),

    event: async (id) => {
      let found: EventOccurrence | undefined;
      try {
        found = await reads.getOccurrence(id);
      } catch (error) {
        if (error instanceof ApiNotFound) return undefined;
        throw error;
      }
      if (found === undefined || !isPublicEvent(found)) return undefined;
      const event = toEvent(found);
      const [series, roster] = await Promise.all([event.seriesId ? reads.listSeries() : Promise.resolve([]), reads.getRoster()]);
      const own = series.find((s) => s.id === event.seriesId);
      const office = event.venue?.kind === 'home' ? event.venue.hostOfficeId : event.ownerOfficeId || own?.hostOfficeId;
      return { event, cadence: own?.cadenceLabel ?? '', about: own?.description ?? '', contact: roster.find((o) => o.id === office)?.roleAlias || undefined };
    },

    offices: async () =>
      (await reads.getRoster()).map((office) => ({
        slug: office.slug,
        title: office.title,
        holders: office.terms
          .filter((t) => (t.status === TermStatus.ACTIVE || t.status === TermStatus.ACTING) && t.holderDisplayName !== '')
          .map((t) => (t.status === TermStatus.ACTING ? `${t.holderDisplayName} (acting)` : t.holderDisplayName)),
        alias: office.roleAlias,
        // The API sends role_alias only once role_alias_verified_on is set (rosterAsOf
        // in the API, R2): a non-empty alias on the wire is the API's word that it is verified.
        aliasVerified: office.roleAlias !== '',
        source: 'submitted' as const,
      })),

    treasurerSummaries: async () => publicItems(await reads.listPublishedItems(ContentKind.TREASURER_SUMMARY, 12)),
    presidentReport: async () => publicItems(await reads.listPublishedItems(ContentKind.PRESIDENT_REPORT, 5))[0],
    announcements: async () => publicItems(await reads.listPublishedItems(ContentKind.ANNOUNCEMENT, 3)),
    issues: async () => issueList(await reads.listPublishedItems(ContentKind.DOCUMENT, ISSUES_PAGE), false),

    news: async (given, { signIn } = {}) => {
      // A bearer the client would not send is no reader: the call goes as the public's, and is shaped so (S5a-1).
      const as = sendable(given);
      let lists: [ContentItem[], ContentItem[] | undefined];
      let tokenRefused = false;
      try {
        lists = await newsLists(as);
      } catch (error) {
        if (as === undefined || !(error instanceof ApiTokenRefused)) throw error;
        tokenRefused = true;
        lists = await newsLists(undefined);
      }
      const signedIn = as !== undefined && !tokenRefused;
      const [documents, listed] = lists;
      const answer = { reader: as !== undefined, signedIn, member: signedIn && answeredAsMember([documents, listed ?? []]) };
      return {
        issues: issueList(documents, signedIn),
        items: newsItemViews(listed ?? [], answer, signIn, membersTeasers),
        signedIn,
        tokenRefused,
        // With no reader, articles that cannot be read are left out, as before /news showed any (NOTE-1).
        itemsUnavailable: listed === undefined && as !== undefined,
      };
    },

    file: async (id, given) => {
      if (!UUID.test(id)) return { kind: 'not_found' };
      const as = sendable(given);
      if (as === undefined) return reads.readFile(id);
      try {
        return await reads.readFile(id, as);
      } catch (error) {
        if (!(error instanceof ApiTokenRefused)) throw error;
        return reads.readFile(id);
      }
    },
  };
}
