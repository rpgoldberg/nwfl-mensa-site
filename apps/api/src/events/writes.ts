// ============================================================================
// EventService writes (R3, P19): live on save, outside the approval queue, and
// audited. Who may write:
//   venues        any officer (a venue is shared; a member's home still shows
//                 only its area and host office, and keeps no address)
//   series        the host office (the Admin for any); changing the host needs
//                 the new office too
//   occurrences   a series date: the series' host office; a one-off: its owning
//                 office; the Admin for any. A date of a series is changed by
//                 writing a stored occurrence over it (a cancellation, a move).
// A new venue or series starts active.
// ============================================================================
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from '@connectrpc/connect';
import { recordAudit } from '../audit/audit.js';
import { type Caller, callerOf } from '../auth/caller.js';
import { requireOffice, requireOfficer, requireUser } from '../auth/roles.js';
import { dbError } from '../db/errors.js';
import type { Db } from '../db/pool.js';
import { type TxClient, inTransaction } from '../db/tx.js';
import {
  Area,
  EventCategory,
  type EventService,
  EventVisibility,
  OccurrenceStatus,
  VenueKind,
} from '../gen/nwfl/mensa/v1/event_pb.js';
import { RecurrenceError, expand, parseRule } from './recurrence.js';
import {
  OCCURRENCE_COLUMNS,
  type OccurrenceRow,
  SERIES_COLUMNS,
  type SeriesRow,
  type VenueRow,
  generatedEntry,
  occurrenceMessage,
  seriesMessage,
  storedEntry,
  venueMessage,
} from './service.js';
import { isoDate } from './zone.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const OCCURRENCE_ID = new RegExp(`^(${UUID})(?::(\\d{4}-\\d{2}-\\d{2}))?$`);
const ID = new RegExp(`^${UUID}$`);

const names = <E extends number>(entries: Array<[E, string]>): Map<E, string> => new Map(entries);
const AREA_NAMES = names<Area>([
  [Area.OKALOOSA, 'okaloosa'],
  [Area.WALTON, 'walton'],
  [Area.BAY, 'bay'],
  [Area.ESCAMBIA_SANTA_ROSA, 'escambia_santa_rosa'],
  [Area.VIRTUAL, 'virtual'],
  [Area.ELSEWHERE, 'elsewhere'],
]);
const KIND_NAMES = names<VenueKind>([
  [VenueKind.BUSINESS, 'business'],
  [VenueKind.MEMBER_HOME, 'member_home'],
  [VenueKind.VIRTUAL, 'virtual'],
]);
const CATEGORY_NAMES = names<EventCategory>([
  [EventCategory.LUNCH, 'lunch'],
  [EventCategory.DINNER, 'dinner'],
  [EventCategory.HAPPY_HOUR, 'happy_hour'],
  [EventCategory.EXCOMM, 'excomm'],
  [EventCategory.PICNIC, 'picnic'],
  [EventCategory.PARTY, 'party'],
  [EventCategory.REGIONAL, 'regional'],
  [EventCategory.NATIONAL, 'national'],
  [EventCategory.VIRTUAL, 'virtual'],
  [EventCategory.OTHER, 'other'],
]);
const VISIBILITY_NAMES = names<EventVisibility>([
  [EventVisibility.PUBLIC, 'public'],
  [EventVisibility.MEMBERS, 'members'],
]);
const STATUS_NAMES = names<OccurrenceStatus>([
  [OccurrenceStatus.SCHEDULED, 'scheduled'],
  [OccurrenceStatus.TENTATIVE, 'tentative'],
  [OccurrenceStatus.CANCELLED, 'cancelled'],
  [OccurrenceStatus.MOVED, 'moved'],
]);

const invalid = (message: string): ConnectError => new ConnectError(message, Code.InvalidArgument);
const denied = (): ConnectError => new ConnectError('not permitted', Code.PermissionDenied);
const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim());

function required<E extends number>(map: Map<E, string>, value: E, field: string): string {
  const name = map.get(value);
  if (name === undefined) throw invalid(`${field} is required`);
  return name;
}

function idOrNull(value: string, field: string): string | null {
  if (value === '') return null;
  if (!ID.test(value)) throw invalid(`${field} is not an id`);
  return value;
}

async function officeSlug(client: TxClient, officeId: string): Promise<string> {
  const { rows } = await client.query<{ slug: string }>(`SELECT slug FROM office WHERE id = $1`, [officeId]);
  const slug = rows[0]?.slug;
  if (slug === undefined) throw invalid('unknown office');
  return slug;
}

/** The holder of `officeId`, or the Admin. An event with no owning office is the Admin's alone. */
async function requireOwner(client: TxClient, caller: Caller, officeId: string | null): Promise<void> {
  if (officeId === null) {
    if (!requireUser(caller).admin) throw denied();
    return;
  }
  requireOffice(caller, await officeSlug(client, officeId));
}

export function eventWriteHandlers(deps: { db: Db }): Partial<ServiceImpl<typeof EventService>> {
  const callerIn = (ctx: HandlerContext): Caller => callerOf(ctx.values);
  const tx = async <T>(fn: (client: TxClient) => Promise<T>): Promise<T> => {
    try {
      return await inTransaction(deps.db, fn);
    } catch (error) {
      throw dbError(error);
    }
  };

  const venuesById = async (client: TxClient, id: string | null): Promise<Map<string, VenueRow>> => {
    if (id === null) return new Map();
    const { rows } = await client.query<VenueRow>(
      'SELECT id, kind, name, business_address, city, area, host_office_id, url, accessibility_note, active FROM venue WHERE id = $1',
      [id],
    );
    return new Map(rows.map((row) => [row.id, row]));
  };

  return {
    saveVenue: async (request, ctx) => {
      const caller = callerIn(ctx);
      requireOfficer(caller);
      const venue = request.venue;
      if (venue === undefined) throw invalid('venue is required');
      const values = [
        required(KIND_NAMES, venue.kind, 'kind'),
        venue.name.trim(),
        orNull(venue.businessAddress),
        orNull(venue.city),
        required(AREA_NAMES, venue.area, 'area'),
        idOrNull(venue.hostOfficeId, 'host_office_id'),
        orNull(venue.url),
        orNull(venue.accessibilityNote),
      ];
      return tx(async (client) => {
        const id = idOrNull(venue.id, 'id');
        const { rows } =
          id === null
            ? await client.query<VenueRow>(
                `INSERT INTO venue (kind, name, business_address, city, area, host_office_id, url, accessibility_note, active) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
                [...values, request.active ?? true],
              )
            : await client.query<VenueRow>(
                // Without the request's own active field, the venue keeps what it has.
                `UPDATE venue SET kind = $1, name = $2, business_address = $3, city = $4, area = $5, host_office_id = $6, url = $7, accessibility_note = $8,
                   active = coalesce($9, active), updated_at = now() WHERE id = $10 RETURNING *`,
                [...values, request.active ?? null, id],
              );
        const row = rows[0];
        if (row === undefined) throw new ConnectError('venue not found', Code.NotFound);
        await recordAudit(client, caller, { action: id === null ? 'create' : 'save', subjectKind: 'venue', subjectId: row.id });
        return { venue: venueMessage(row) };
      });
    },

    saveSeries: async (request, ctx) => {
      const caller = callerIn(ctx);
      requireUser(caller);
      const series = request.series;
      if (series === undefined) throw invalid('series is required');
      try {
        parseRule(series.recurrence);
      } catch (error) {
        if (error instanceof RecurrenceError) throw invalid(`recurrence: ${error.message}`);
        throw error;
      }
      if (series.startsOn === undefined) throw invalid('starts_on is required');
      let startsOn: string;
      try {
        startsOn = isoDate(series.startsOn);
      } catch {
        throw invalid('starts_on is not a calendar date');
      }
      const hostOfficeId = idOrNull(series.hostOfficeId, 'host_office_id');
      if (hostOfficeId === null) throw invalid('host_office_id is required');
      const start = series.defaultStart;
      const values = [
        series.slug,
        series.title.trim(),
        required(CATEGORY_NAMES, series.category, 'category'),
        series.recurrence,
        orNull(series.cadenceLabel),
        startsOn,
        start === undefined ? null : `${String(start.hours).padStart(2, '0')}:${String(start.minutes).padStart(2, '0')}`,
        series.defaultDurationMinutes === 0 ? null : series.defaultDurationMinutes,
        idOrNull(series.defaultVenueId, 'default_venue_id'),
        required(AREA_NAMES, series.area, 'area'),
        hostOfficeId,
        orNull(series.description),
        required(VISIBILITY_NAMES, series.visibility, 'visibility'),
      ];
      return tx(async (client) => {
        const id = idOrNull(series.id, 'id');
        if (id !== null) {
          const { rows } = await client.query<{ host_office_id: string | null }>(`SELECT host_office_id FROM event_series WHERE id = $1 FOR UPDATE`, [id]);
          const existing = rows[0];
          if (existing === undefined) throw new ConnectError('series not found', Code.NotFound);
          await requireOwner(client, caller, existing.host_office_id);
        }
        await requireOwner(client, caller, hostOfficeId);
        const { rows } =
          id === null
            ? await client.query<SeriesRow>(
                `INSERT INTO event_series (slug, title, category, recurrence, cadence_label, starts_on, default_start, default_duration_minutes, default_venue_id,
                   area, host_office_id, description, visibility, active) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING ${SERIES_COLUMNS}`,
                [...values, request.active ?? true],
              )
            : await client.query<SeriesRow>(
                // Without the request's own active field, the series keeps what it has.
                `UPDATE event_series SET slug = $1, title = $2, category = $3, recurrence = $4, cadence_label = $5, starts_on = $6, default_start = $7,
                   default_duration_minutes = $8, default_venue_id = $9, area = $10, host_office_id = $11, description = $12, visibility = $13,
                   active = coalesce($14, active), updated_at = now() WHERE id = $15 RETURNING ${SERIES_COLUMNS}`,
                [...values, request.active ?? null, id],
              );
        const row = rows[0] as SeriesRow;
        await recordAudit(client, caller, { action: id === null ? 'create' : 'save', subjectKind: 'event_series', subjectId: row.id, actingOfficeId: hostOfficeId });
        return { series: seriesMessage(row) };
      });
    },

    saveOccurrence: async (request, ctx) => {
      const caller = callerIn(ctx);
      requireUser(caller);
      const occurrence = request.occurrence;
      if (occurrence === undefined) throw invalid('occurrence is required');
      const match = occurrence.id === '' ? null : OCCURRENCE_ID.exec(occurrence.id);
      if (occurrence.id !== '' && match === null) throw invalid('malformed occurrence id');
      return tx(async (client) => {
        let existing: OccurrenceRow | undefined;
        let series: SeriesRow | undefined;
        let generatedStart: Date | null = null;
        const [, matchedId, date] = (match ?? []) as unknown as [string, string | undefined, string | undefined];
        if (matchedId !== undefined && date === undefined) {
          existing = (await client.query<OccurrenceRow>(`SELECT ${OCCURRENCE_COLUMNS} FROM event_occurrence WHERE id = $1 FOR UPDATE`, [matchedId])).rows[0];
          if (existing === undefined) throw new ConnectError('occurrence not found', Code.NotFound);
        }
        // A stored row keeps its series (none, for a one-off), and a date of a series is in that
        // series: a series named in the request never moves an occurrence.
        const seriesId = existing !== undefined ? existing.series_id : date !== undefined ? (matchedId as string) : idOrNull(occurrence.seriesId, 'series_id');
        if (seriesId !== null) {
          series = (await client.query<SeriesRow>(`SELECT ${SERIES_COLUMNS} FROM event_series WHERE id = $1`, [seriesId])).rows[0];
          if (series === undefined) throw new ConnectError('series not found', Code.NotFound);
        }
        if (date !== undefined && series !== undefined) {
          // A date of the series: it must be one the rule produces; a stored row there is edited instead.
          let produced: boolean;
          try {
            produced = expand(parseRule(series.recurrence), series.starts_on, date, date).length > 0;
          } catch {
            produced = false;
          }
          if (!series.active || !produced) throw new ConnectError('that series has no occurrence on that date', Code.NotFound);
          generatedStart = generatedEntry(series, date, new Map()).startsAt;
          existing = (
            await client.query<OccurrenceRow>(
              `SELECT ${OCCURRENCE_COLUMNS} FROM event_occurrence WHERE series_id = $1 AND starts_at >= $2::date - 1 AND starts_at < $2::date + 2 FOR UPDATE`,
              [series.id, date],
            )
          ).rows.find((row) => storedEntry(row, series, new Map()).localDate === date);
        }
        // The owner is the series' host office, or a stored one-off's own office (none: the Admin's
        // alone), never an id in the request; only a new one-off takes its owner from the request.
        const ownerOfficeId =
          series !== undefined ? series.host_office_id : existing !== undefined ? existing.owner_office_id : idOrNull(occurrence.ownerOfficeId, 'owner_office_id');
        await requireOwner(client, caller, ownerOfficeId);
        if (existing !== undefined || date !== undefined) {
          const keptSeries = occurrence.seriesId === '' || occurrence.seriesId === (seriesId ?? '');
          const keptOwner = occurrence.ownerOfficeId === '' || occurrence.ownerOfficeId === (ownerOfficeId ?? '');
          if (!keptSeries || !keptOwner) throw invalid('an occurrence keeps its series and its owning office');
        }

        const startsAt = occurrence.startsAt !== undefined ? timestampDate(occurrence.startsAt) : (existing?.starts_at ?? generatedStart);
        if (startsAt === null) throw invalid('starts_at is required');
        const visibility = VISIBILITY_NAMES.get(occurrence.visibility) ?? series?.visibility ?? existing?.visibility;
        if (visibility === undefined) throw invalid('visibility is required');
        const values = [
          series?.id ?? null,
          series !== undefined ? orNull(occurrence.title) : occurrence.title.trim() === '' ? null : occurrence.title.trim(),
          startsAt,
          occurrence.endsAt !== undefined ? timestampDate(occurrence.endsAt) : null,
          idOrNull(occurrence.venueId, 'venue_id') ?? (existing === undefined && date !== undefined ? (series?.default_venue_id ?? null) : null),
          STATUS_NAMES.get(occurrence.status) ?? 'scheduled',
          orNull(occurrence.statusNote),
          orNull(occurrence.detail),
          orNull(occurrence.url),
          visibility,
          series === undefined ? ownerOfficeId : null,
        ];
        const { rows } =
          existing === undefined
            ? await client.query<OccurrenceRow>(
                `INSERT INTO event_occurrence (series_id, title, starts_at, ends_at, venue_id, status, status_note, detail, url, visibility, owner_office_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING ${OCCURRENCE_COLUMNS}`,
                values,
              )
            : await client.query<OccurrenceRow>(
                `UPDATE event_occurrence SET series_id = $1, title = $2, starts_at = $3, ends_at = $4, venue_id = $5, status = $6, status_note = $7, detail = $8,
                   url = $9, visibility = $10, owner_office_id = $11, updated_at = now() WHERE id = $12 RETURNING ${OCCURRENCE_COLUMNS}`,
                [...values, existing.id],
              );
        const row = rows[0] as OccurrenceRow;
        await recordAudit(client, caller, {
          action: existing === undefined ? 'create' : 'save',
          subjectKind: 'event_occurrence',
          subjectId: row.id,
          actingOfficeId: ownerOfficeId,
          payload: { status: row.status },
        });
        return { occurrence: occurrenceMessage(storedEntry(row, series, await venuesById(client, row.venue_id)), 'officers') };
      });
    },
  };
}

