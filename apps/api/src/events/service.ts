// ============================================================================
// EventService reads (R3, R4). The calendar is the series' rules expanded into
// dated occurrences, with stored occurrences overriding the rule on their date
// (a cancellation, a move, a one-off event). Times are Central.
//
// What a caller sees depends on the audience from the verified token, never on
// a request field (auth/caller.ts):
//   - a members event read by the public is withheld: its id, its local date,
//     its area and "members", nothing else (R3: "Members event, sign in for
//     details"). Not its status either: the public sees a cancelled members
//     event exactly as a scheduled one, whichever way the cancelled filter is
//     set, under the id its series date would have;
//   - the public venue list holds only the venues public events use;
//   - a member's home is shown to EVERYONE as its area and host office only,
//     under a fixed label, whatever was typed into its name (R3).
//   - REDACT R2a: every series, venue and entry passes through the caller's
//     lens (events/redact.ts) before a message is built from it: marked
//     passages withheld, private venues per the policy (host offices stay),
//     and anything the lens hides dropped (NOT_FOUND for a single read).
// ============================================================================
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, type ConnectRouter, type HandlerContext } from '@connectrpc/connect';
import { type Audience, callerOf } from '../auth/caller.js';
import type { Db } from '../db/pool.js';
import {
  Area,
  EventCategory,
  type EventOccurrence,
  EventOccurrenceSchema,
  type EventSeries,
  EventSeriesSchema,
  EventService,
  EventVisibility,
  OccurrenceStatus,
  type Venue,
  VenueKind,
  VenueSchema,
} from '../gen/nwfl/mensa/v1/event_pb.js';
import type { Date as ProtoDate } from '../gen/nwfl/mensa/v1/common_pb.js';
import type { StructuredLogger } from '../platform/logger.js';
import { type Rule, RecurrenceError, expand, parseRule } from './recurrence.js';
import { calendarLens, entryFor, seriesFor, venueFor, visible } from './redact.js';
import { eventWriteHandlers } from './writes.js';
import { addDays, isoDate, localDateOf, protoDate, toDays, todayIn, zonedToUtc } from './zone.js';

export interface EventDeps {
  db: Db;
  logger: StructuredLogger;
  now: () => Date;
}

export const DEFAULT_RANGE_DAYS = 62;
export const MAX_RANGE_DAYS = 400;
export const MEMBER_HOME_LABEL = "A member's home";

const AREAS: Record<string, Area> = {
  okaloosa: Area.OKALOOSA,
  walton: Area.WALTON,
  bay: Area.BAY,
  escambia_santa_rosa: Area.ESCAMBIA_SANTA_ROSA,
  virtual: Area.VIRTUAL,
  elsewhere: Area.ELSEWHERE,
};
const VENUE_KINDS: Record<string, VenueKind> = {
  business: VenueKind.BUSINESS,
  member_home: VenueKind.MEMBER_HOME,
  virtual: VenueKind.VIRTUAL,
};
const CATEGORIES: Record<string, EventCategory> = {
  lunch: EventCategory.LUNCH,
  dinner: EventCategory.DINNER,
  happy_hour: EventCategory.HAPPY_HOUR,
  excomm: EventCategory.EXCOMM,
  picnic: EventCategory.PICNIC,
  party: EventCategory.PARTY,
  regional: EventCategory.REGIONAL,
  national: EventCategory.NATIONAL,
  virtual: EventCategory.VIRTUAL,
  other: EventCategory.OTHER,
};
const STATUSES: Record<string, OccurrenceStatus> = {
  scheduled: OccurrenceStatus.SCHEDULED,
  tentative: OccurrenceStatus.TENTATIVE,
  cancelled: OccurrenceStatus.CANCELLED,
  moved: OccurrenceStatus.MOVED,
};
const VISIBILITIES: Record<string, EventVisibility> = {
  public: EventVisibility.PUBLIC,
  members: EventVisibility.MEMBERS,
};

export interface VenueRow {
  id: string;
  kind: string;
  name: string;
  business_address: string | null;
  city: string | null;
  area: string;
  host_office_id: string | null;
  url: string | null;
  accessibility_note: string | null;
  active: boolean;
}

export interface SeriesRow {
  id: string;
  slug: string;
  title: string;
  category: string;
  recurrence: string;
  cadence_label: string | null;
  starts_on: string;
  default_start: string | null;
  default_duration_minutes: number | null;
  default_venue_id: string | null;
  area: string;
  host_office_id: string | null;
  description: string | null;
  visibility: string;
  active: boolean;
}

export interface OccurrenceRow {
  id: string;
  owner_office_id: string | null;
  series_id: string | null;
  title: string | null;
  starts_at: Date;
  ends_at: Date | null;
  venue_id: string | null;
  status: string;
  status_note: string | null;
  detail: string | null;
  url: string | null;
  visibility: string;
}

/** One calendar entry before it is shaped for an audience. */
export interface Entry {
  id: string;
  ownerOfficeId: string;
  localDate: string;
  series: SeriesRow | undefined;
  title: string;
  startsAt: Date | null;
  endsAt: Date | null;
  venue: VenueRow | undefined;
  status: string;
  statusNote: string;
  detail: string;
  url: string;
  visibility: string;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const OCCURRENCE_ID = new RegExp(`^(${UUID})(?::(\\d{4}-\\d{2}-\\d{2}))?$`);

export const SERIES_COLUMNS = `id, slug, title, category, recurrence, cadence_label, starts_on::text AS starts_on,
  to_char(default_start, 'HH24:MI') AS default_start, default_duration_minutes, default_venue_id, area,
  host_office_id, description, visibility, active`;
export const OCCURRENCE_COLUMNS = 'id, series_id, title, starts_at, ends_at, venue_id, status, status_note, detail, url, visibility, owner_office_id';

function invalid(message: string): ConnectError {
  return new ConnectError(message, Code.InvalidArgument);
}

function requestDate(date: ProtoDate | undefined, fallback: string, field: string): string {
  if (date === undefined) return fallback;
  try {
    return isoDate(date);
  } catch {
    throw invalid(`${field} is not a calendar date`);
  }
}

export function venueMessage(row: VenueRow): Venue {
  if (row.kind === 'member_home') {
    // R3: the area and the host's role alias, never more, for any audience.
    return create(VenueSchema, {
      id: row.id,
      kind: VenueKind.MEMBER_HOME,
      name: MEMBER_HOME_LABEL,
      area: AREAS[row.area],
      hostOfficeId: row.host_office_id ?? '',
      active: row.active,
    });
  }
  return create(VenueSchema, {
    id: row.id,
    kind: VENUE_KINDS[row.kind],
    name: row.name,
    businessAddress: row.business_address ?? '',
    city: row.city ?? '',
    area: AREAS[row.area],
    hostOfficeId: row.host_office_id ?? '',
    url: row.url ?? '',
    accessibilityNote: row.accessibility_note ?? '',
    active: row.active,
  });
}

export function seriesMessage(row: SeriesRow): EventSeries {
  const [hours, minutes] = (row.default_start ?? '').split(':').map(Number);
  return create(EventSeriesSchema, {
    id: row.id,
    slug: row.slug,
    title: row.title,
    category: CATEGORIES[row.category],
    recurrence: row.recurrence,
    cadenceLabel: row.cadence_label ?? '',
    ...(row.default_start !== null ? { defaultStart: { hours, minutes } } : {}),
    defaultDurationMinutes: row.default_duration_minutes ?? 0,
    defaultVenueId: row.default_venue_id ?? '',
    area: AREAS[row.area],
    hostOfficeId: row.host_office_id ?? '',
    description: row.description ?? '',
    visibility: VISIBILITIES[row.visibility],
    active: row.active,
    startsOn: protoDate(row.starts_on),
  });
}

function areaOf(entry: Entry): Area {
  const area = entry.venue?.area ?? entry.series?.area;
  return area === undefined ? Area.UNSPECIFIED : (AREAS[area] ?? Area.UNSPECIFIED);
}

export function occurrenceMessage(entry: Entry, audience: Audience): EventOccurrence {
  if (entry.visibility === 'members' && audience === 'public') {
    return create(EventOccurrenceSchema, {
      // A stored row's own id would tell an override (a cancellation, a move) from a plain date.
      id: entry.series !== undefined ? `${entry.series.id}:${entry.localDate}` : entry.id,
      localDate: protoDate(entry.localDate),
      area: areaOf(entry),
      visibility: EventVisibility.MEMBERS,
      detailsWithheld: true,
    });
  }
  return create(EventOccurrenceSchema, {
    id: entry.id,
    seriesId: entry.series?.id ?? '',
    title: entry.title,
    ...(entry.startsAt !== null ? { startsAt: timestampFromDate(entry.startsAt) } : {}),
    ...(entry.endsAt !== null ? { endsAt: timestampFromDate(entry.endsAt) } : {}),
    venueId: entry.venue?.id ?? '',
    ...(entry.venue !== undefined ? { venue: venueMessage(entry.venue) } : {}),
    status: STATUSES[entry.status],
    statusNote: entry.statusNote,
    detail: entry.detail,
    url: entry.url,
    visibility: VISIBILITIES[entry.visibility],
    detailsWithheld: false,
    localDate: protoDate(entry.localDate),
    area: areaOf(entry),
    ownerOfficeId: entry.ownerOfficeId,
  });
}

export function storedEntry(row: OccurrenceRow, series: SeriesRow | undefined, venues: Map<string, VenueRow>): Entry {
  return {
    id: row.id,
    ownerOfficeId: row.owner_office_id ?? '',
    localDate: localDateOf(row.starts_at),
    series,
    title: row.title ?? series?.title ?? '',
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    venue: row.venue_id === null ? undefined : venues.get(row.venue_id),
    status: row.status,
    statusNote: row.status_note ?? '',
    detail: row.detail ?? '',
    url: row.url ?? '',
    visibility: row.visibility,
  };
}

export function generatedEntry(series: SeriesRow, date: string, venues: Map<string, VenueRow>): Entry {
  let startsAt: Date | null = null;
  let endsAt: Date | null = null;
  if (series.default_start !== null) {
    const [hours, minutes] = series.default_start.split(':').map(Number) as [number, number];
    startsAt = zonedToUtc(date, hours, minutes);
    if (series.default_duration_minutes !== null) endsAt = new Date(startsAt.getTime() + series.default_duration_minutes * 60_000);
  }
  return {
    id: `${series.id}:${date}`,
    ownerOfficeId: '',
    localDate: date,
    series,
    title: series.title,
    startsAt,
    endsAt,
    venue: series.default_venue_id === null ? undefined : venues.get(series.default_venue_id),
    status: 'scheduled',
    statusNote: '',
    detail: '',
    url: '',
    visibility: series.visibility,
  };
}

/** The calendar's data access: venues, series, stored occurrences and the expansion. */
export function calendarSource(db: Db, logger: StructuredLogger) {
  const loadVenues = async (): Promise<Map<string, VenueRow>> => {
    const { rows } = await db.query<VenueRow>(
      'SELECT id, kind, name, business_address, city, area, host_office_id, url, accessibility_note, active FROM venue',
    );
    return new Map(rows.map((row) => [row.id, row]));
  };

  const loadSeries = async (includeInactive: boolean): Promise<SeriesRow[]> =>
    (await db.query<SeriesRow>(`SELECT ${SERIES_COLUMNS} FROM event_series WHERE $1 OR active ORDER BY slug`, [includeInactive])).rows;

  /** Stored occurrences whose Central date falls in [from, to]. */
  const loadStored = async (from: string, to: string, seriesId?: string): Promise<OccurrenceRow[]> => {
    const { rows } = await db.query<OccurrenceRow>(
      `SELECT ${OCCURRENCE_COLUMNS} FROM event_occurrence
       WHERE starts_at >= $1 AND starts_at < $2 AND ($3::uuid IS NULL OR series_id = $3)`,
      [new Date(`${addDays(from, -1)}T00:00:00Z`), new Date(`${addDays(to, 2)}T00:00:00Z`), seriesId ?? null],
    );
    return rows.filter((row) => {
      const date = localDateOf(row.starts_at);
      return date >= from && date <= to;
    });
  };

  const ruleOf = (series: SeriesRow): Rule | undefined => {
    try {
      return parseRule(series.recurrence);
    } catch (error) {
      if (!(error instanceof RecurrenceError)) throw error;
      logger.warn({ series_id: series.id }, 'series rule not expanded');
      return undefined;
    }
  };

  /** Every entry from `from` to `to`, stored rows overriding the rule on their date, in date order. */
  const calendar = async (from: string, to: string): Promise<Entry[]> => {
    const [venues, series, stored] = await Promise.all([loadVenues(), loadSeries(false), loadStored(from, to)]);
    const allSeries = new Map(series.map((row) => [row.id, row]));
    const missing = stored.flatMap((row) => (row.series_id !== null && !allSeries.has(row.series_id) ? [row.series_id] : []));
    if (missing.length > 0) {
      const { rows } = await db.query<SeriesRow>(`SELECT ${SERIES_COLUMNS} FROM event_series WHERE id = ANY($1)`, [missing]);
      rows.forEach((row) => allSeries.set(row.id, row));
    }
    const entries = stored.map((row) => storedEntry(row, row.series_id === null ? undefined : allSeries.get(row.series_id), venues));
    const overridden = new Set(entries.flatMap((entry) => (entry.series ? [`${entry.series.id}:${entry.localDate}`] : [])));
    for (const row of series) {
      const rule = ruleOf(row);
      if (rule === undefined) continue;
      for (const date of expand(rule, row.starts_on, from, to)) {
        if (!overridden.has(`${row.id}:${date}`)) entries.push(generatedEntry(row, date, venues));
      }
    }
    return entries.sort(
      (a, b) =>
        a.localDate.localeCompare(b.localDate) ||
        (a.startsAt?.getTime() ?? 0) - (b.startsAt?.getTime() ?? 0) ||
        a.title.localeCompare(b.title),
    );
  };

  return { loadVenues, loadSeries, loadStored, ruleOf, calendar };
}

export function eventRoutes(deps: EventDeps): (router: ConnectRouter) => void {
  const { db, logger } = deps;
  const { loadVenues, loadSeries, loadStored, ruleOf, calendar } = calendarSource(db, logger);

  const audienceOf = (ctx: HandlerContext): Audience => callerOf(ctx.values).audience;

  return (router) => {
    router.service(EventService, {
      // Officer writes (A4b), live on save.
      ...eventWriteHandlers({ db }),
      listOccurrences: async (request, ctx) => {
        const audience = audienceOf(ctx);
        const from = requestDate(request.from, todayIn(deps.now()), 'from');
        const to = requestDate(request.to, addDays(from, DEFAULT_RANGE_DAYS), 'to');
        if (to < from) throw invalid('to is before from');
        if (toDays(to) - toDays(from) > MAX_RANGE_DAYS) throw invalid(`the range is longer than ${MAX_RANGE_DAYS} days`);
        const areas = new Set(request.areas);
        const entries = (await calendar(from, to))
          .filter((entry) => request.includeCancelled || entry.status !== 'cancelled' || (audience === 'public' && entry.visibility === 'members'))
          .filter((entry) => areas.size === 0 || areas.has(areaOf(entry)));
        const lens = await calendarLens(db, audience, entries);
        return { occurrences: visible(entries, (entry) => entryFor(entry, lens)).map((entry) => occurrenceMessage(entry, audience)) };
      },

      getOccurrence: async (request, ctx) => {
        const audience = audienceOf(ctx);
        const match = OCCURRENCE_ID.exec(request.id);
        if (!match) throw invalid('malformed occurrence id');
        const [, id, date] = match as unknown as [string, string, string | undefined];
        const notFound = new ConnectError('occurrence not found', Code.NotFound);
        /** The entry as this audience may see it; NOT_FOUND when the lens hides it. */
        const shown = async (entry: Entry): Promise<Entry> => {
          const view = entryFor(entry, await calendarLens(db, audience, [entry]));
          if (view === undefined) throw notFound;
          return view;
        };
        const venues = await loadVenues();
        if (date === undefined) {
          const { rows } = await db.query<OccurrenceRow>(`SELECT ${OCCURRENCE_COLUMNS} FROM event_occurrence WHERE id = $1`, [id]);
          const row = rows[0];
          if (row === undefined) throw notFound;
          const series = row.series_id === null ? undefined : (await db.query<SeriesRow>(`SELECT ${SERIES_COLUMNS} FROM event_series WHERE id = $1`, [row.series_id])).rows[0];
          return { occurrence: occurrenceMessage(await shown(storedEntry(row, series, venues)), audience) };
        }
        try {
          isoDate({ year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)), day: Number(date.slice(8, 10)) });
        } catch {
          throw invalid('malformed occurrence date');
        }
        const series = (await db.query<SeriesRow>(`SELECT ${SERIES_COLUMNS} FROM event_series WHERE id = $1 AND active`, [id])).rows[0];
        const rule = series === undefined ? undefined : ruleOf(series);
        if (series === undefined || rule === undefined || expand(rule, series.starts_on, date, date).length === 0) throw notFound;
        const [stored] = await loadStored(date, date, series.id);
        const entry = stored !== undefined ? storedEntry(stored, series, venues) : generatedEntry(series, date, venues);
        return { occurrence: occurrenceMessage(await shown(entry), audience) };
      },

      listSeries: async (request, ctx) => {
        const audience = audienceOf(ctx);
        const rows = (await loadSeries(request.includeInactive)).filter((row) => audience !== 'public' || row.visibility === 'public');
        const lens = await calendarLens(db, audience, [], rows);
        return { series: visible(rows, (row) => seriesFor(row, lens)).map(seriesMessage) };
      },

      listVenues: async (request, ctx) => {
        const audience = audienceOf(ctx);
        let used: Set<string> | undefined;
        if (audience === 'public') {
          const { rows } = await db.query<{ id: string }>(
            `SELECT default_venue_id AS id FROM event_series WHERE visibility = 'public' AND default_venue_id IS NOT NULL
             UNION SELECT venue_id FROM event_occurrence WHERE visibility = 'public' AND venue_id IS NOT NULL`,
          );
          used = new Set(rows.map((row) => row.id));
        }
        const rows = [...(await loadVenues()).values()].filter((row) => (request.includeInactive || row.active) && (used === undefined || used.has(row.id)));
        const lens = await calendarLens(db, audience, []);
        // Sorted by the name this audience sees, so a withheld name's place in the list gives nothing away.
        return { venues: visible(rows, (row) => venueFor(row, lens)).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)).map(venueMessage) };
      },
    });
  };
}
