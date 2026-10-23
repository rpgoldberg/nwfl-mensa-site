// The live sections (R4, R22), read from nwfl-mensa-api and shaped for the
// pages: the calendar, the roster, the treasurer's summaries, the President's
// report and the announcements. Everything here is what the API gives the
// public, and on top of that only public events and public items are kept: a
// members event or item never reaches a page or a feed, even if the API sent
// more than it should.
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { type ContentItem, ContentKind, ItemVisibility } from '../gen/nwfl/mensa/v1/content_pb.js';
import { Area, type EventOccurrence, EventVisibility, OccurrenceStatus, type Venue, VenueKind } from '../gen/nwfl/mensa/v1/event_pb.js';
import { TermStatus } from '../gen/nwfl/mensa/v1/roster_pb.js';
import { ApiNotFound, type ApiReads } from '../lib/api/client';
import { type CalendarEvent, type CalendarVenue, type EventStatus, centralParts, eventPath } from '../lib/calendar';
import { documentHtml } from '../lib/document';
import type { Office } from './site-data';

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
}

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

function itemView(item: ContentItem): ItemView {
  const live = item.live!;
  return {
    slug: item.slug,
    title: live.title,
    summary: live.summary,
    bodyHtml: documentHtml(live.body),
    publishedOn: live.approvedAt === undefined ? undefined : centralParts(timestampDate(live.approvedAt)).date,
    source: 'submitted',
  };
}

const publicItems = (items: readonly ContentItem[]) => items.filter((i) => i.live?.visibility === ItemVisibility.PUBLIC).map(itemView);

export function liveData(reads: ApiReads): LiveData {
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
  };
}
