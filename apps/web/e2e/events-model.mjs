// @ts-check
// EDITOR E6: the calendar of the stand-in API (e2e/api.mjs) as a model with state, kept in memory for the
// run, for the officers' event screens: SaveOccurrence answered as the API's (apps/api/src/events/
// writes.ts) answers it, and every read (ListOccurrences, GetOccurrence) has a save at once, so /events
// and /calendar.ics show it. A series date is changed by <series>:<date>, and is its own stored event,
// with an id of its own, after; who may change what (the series' host office, a one-off's own office,
// the Admin any; a one-off with no office the Admin's alone); the strict URL rule (EDITOR A3a, links/
// rule.ts) with the API's reasons, "url: ..." and "detail line N: ...", joined by "; "; a members event
// withheld from the public as the API withholds it; the series' venue on a series date's first change
// with none sent, unless the request says the venue is decided later. A database refusal has the API's fixed words (db/errors.ts).
//
// The calendar the model starts from is the caller's (`base`, by audience): nothing changes in it until
// a save, and while no save falls in a range, a read of it is exactly `base`'s answer.
import { clone, create } from '@bufbuild/protobuf';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError } from '@connectrpc/connect';
import { randomUUID } from 'node:crypto';
import { Area, EventOccurrenceSchema, EventVisibility, OccurrenceStatus } from '../src/gen/nwfl/mensa/v1/event_pb.js';

/** @typedef {import('../src/gen/nwfl/mensa/v1/event_pb.js').EventOccurrence} EventOccurrence */
/** @typedef {'public' | 'members' | 'officers'} Audience */
/** @typedef {{ sub: string, groups: string[], audience: Audience }} Caller */
/** @typedef {{ id: string, hostOfficeId: string, title: string, visibility: EventVisibility, area?: Area } & Record<string, unknown>} Series */
/** @typedef {{ id: string, area: Area } & Record<string, unknown>} VenueInit */

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const OCCURRENCE_ID = new RegExp(`^(${UUID})(?::(\\d{4}-\\d{2}-\\d{2}))?$`);
const ID = new RegExp(`^${UUID}$`);
const STATUSES = new Set([OccurrenceStatus.SCHEDULED, OccurrenceStatus.TENTATIVE, OccurrenceStatus.CANCELLED, OccurrenceStatus.MOVED]);
const VISIBILITIES = new Set([EventVisibility.PUBLIC, EventVisibility.MEMBERS]);

const invalid = (/** @type {string} */ message) => new ConnectError(message, Code.InvalidArgument);
const denied = () => new ConnectError('not permitted', Code.PermissionDenied);
/** db/errors.ts: a check constraint (a one-off's title, an end before the start, a title too long). */
const notAllowedValue = () => invalid('a value is not allowed');

const ZONE = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' });
/** @param {Date} at */
const centralDate = (at) => {
  const p = Object.fromEntries(ZONE.formatToParts(at).map((x) => [x.type, x.value]));
  return `${p['year']}-${p['month']}-${p['day']}`;
};
/** @param {string} date @param {number} days */
const addDays = (date, days) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
/** @param {string} date */
const protoDate = (date) => ({ year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)), day: Number(date.slice(8, 10)) });
/** @param {{ year: number, month: number, day: number } | undefined} d */
const iso = (d) => (d === undefined ? '' : `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`);
/** @param {EventOccurrence} o */
const dateOf = (o) => iso(o.localDate);
/** @param {EventOccurrence} o */
const startOf = (o) => (o.startsAt === undefined ? 0 : timestampDate(o.startsAt).getTime());

// ---------------------------------------------------------------------------------------------
// The strict URL rule (apps/api/src/links/rule.ts and linkcheck's parseKept), with the API's words.
// ---------------------------------------------------------------------------------------------

const MAX_URL_LENGTH = 2048;
const CONTROLS = /[\p{Cc}\p{Cf}]/gu;
const REASONS = {
  http: 'must start with https://, not http://',
  www: 'must be written in full, starting with https://',
  'not-plain': 'must be written plainly: https:// or mailto: in lower case, and no spaces',
  'not-web': 'is an email address, but this needs a web address starting with https://',
  scheme: 'is not a web address starting with https:// or an email address starting with mailto:',
  credentials: 'has a user name or password in it (the part before an @), which is not allowed',
  port: 'names a port (a colon and a number after the site name), which is not allowed',
  'ip-literal': 'uses a number (an IP address) instead of a site name',
  'local-name': 'has no dot in its site name (a local name such as localhost)',
  'host-name': 'has a site name with characters that are not allowed (only letters, digits, dots and inner hyphens)',
  'too-long': `is longer than ${MAX_URL_LENGTH} characters`,
  control: 'has hidden characters in it, so type it again by hand',
  malformed: 'cannot be read as an address, so check it for typing mistakes',
};

/** Why a web address may not be saved, or null. @param {string} input @returns {keyof typeof REASONS | null} */
function urlProblem(input) {
  if (new RegExp(CONTROLS.source, 'u').test(input)) return 'control';
  if (input.length > MAX_URL_LENGTH) return 'too-long';
  if (/^www\./i.test(input)) return 'www';
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(input)?.[1]?.toLowerCase();
  if (scheme === 'mailto') return 'not-web';
  if (scheme !== 'https' && scheme !== 'http') return 'scheme';
  /** @type {URL} */
  let url;
  try {
    url = new URL(input);
  } catch {
    return 'malformed';
  }
  if (url.username !== '' || url.password !== '') return 'credentials';
  if (url.port !== '') return 'port';
  if (/^\d+(\.\d+){3}$/.test(url.hostname) || url.hostname.startsWith('[')) return 'ip-literal';
  if (!url.hostname.includes('.')) return 'local-name';
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(url.hostname)) return 'host-name';
  if (scheme === 'http') return 'http';
  if (!/^https:\/\/\S+$/.test(input)) return 'not-plain';
  return null;
}

/** @param {string} url */
const shown = (url) => {
  const visible = url.replace(CONTROLS, '?');
  return visible.length > 60 ? `${visible.slice(0, 60)}...` : visible;
};
/** @param {string} url @param {keyof typeof REASONS} problem */
const message = (url, problem) => `the address "${shown(url)}" ${REASONS[problem]}`;

/** The bare URLs in a line, less the sentence's punctuation after each. @param {string} line */
const urlsIn = (line) => [...line.matchAll(/(?:https?:\/\/|www\.)[^\s<>"'`]+/giu)].map((m) => m[0].replace(/[.,;:!?)\]]+$/u, ''));

/** events/writes.ts checkUrls. @param {string | null} url @param {string} detail */
function checkUrls(url, detail) {
  /** @type {string[]} */
  const problems = [];
  const problem = url === null ? null : urlProblem(url);
  if (url !== null && problem !== null) problems.push(`url: ${message(url, problem)}`);
  detail.split(/\r\n?|\n/).forEach((line, index) => {
    for (const found of urlsIn(line)) {
      const p = urlProblem(found);
      if (p !== null) problems.push(`detail line ${index + 1}: ${message(found, p)}`);
    }
  });
  if (problems.length > 0) throw invalid(problems.join('; '));
}

/**
 * @param {{
 *   offices: readonly { id: string, slug: string }[],
 *   base: (from: string, to: string, audience: Audience) => EventOccurrence[],
 *   series: readonly Series[],
 *   venues: readonly VenueInit[],
 *   now?: () => Date,
 * }} options
 */
export function createEventModel({ offices, base, series, venues, now = () => new Date() }) {
  /** Each saved event, by what it was first changed as: <series>:<date>, a one-off's id, or its own new id. @type {Map<string, EventOccurrence>} */
  const rows = new Map();
  const seriesById = new Map(series.map((s) => [s.id, s]));
  const venueById = new Map(venues.map((v) => [v.id, v]));
  const today = () => centralDate(now());

  /** A saved event as an audience reads it: a members event the public reads is withheld (events/service.ts). @param {EventOccurrence} o @param {Audience} audience */
  const shape = (o, audience) =>
    audience === 'public' && o.visibility === EventVisibility.MEMBERS
      ? create(EventOccurrenceSchema, { id: o.seriesId !== '' ? `${o.seriesId}:${dateOf(o)}` : o.id, localDate: o.localDate, area: o.area, visibility: EventVisibility.MEMBERS, detailsWithheld: true })
      : clone(EventOccurrenceSchema, o);

  /** @param {string} id */
  const stored = (id) => {
    const keyed = rows.get(id);
    if (keyed !== undefined) return { key: id, row: keyed };
    for (const [key, row] of rows) if (row.id === id) return { key, row };
    return undefined;
  };

  /** Every event from `from` to `to`, saves included. @param {string} from @param {string} to @param {Audience} audience */
  const list = (from, to, audience) => {
    const saved = [...rows.values()].filter((o) => dateOf(o) >= from && dateOf(o) <= to).map((o) => shape(o, audience));
    const kept = base(from, to, audience).filter((o) => !rows.has(o.id));
    if (saved.length === 0) return kept;
    return [...kept, ...saved].sort((a, b) => dateOf(a).localeCompare(dateOf(b)) || startOf(a) - startOf(b));
  };

  /** One event, by its own id or <series>:<date>; undefined for none. @param {string} id @param {Audience} audience */
  const get = (id, audience) => {
    const hit = stored(id);
    if (hit !== undefined) return shape(hit.row, audience);
    const date = OCCURRENCE_ID.exec(id)?.[2];
    const t = today();
    return (date !== undefined ? base(date, date, audience) : base(addDays(t, -60), addDays(t, 400), audience)).find((o) => o.id === id);
  };

  /** The holder of `officeId`, or the Admin; an event with no office the Admin's alone. @param {Caller} caller @param {string | null} officeId */
  const requireOwner = (caller, officeId) => {
    const admin = caller.groups.includes('nwfl-admin');
    if (officeId === null) {
      if (!admin) throw denied();
      return;
    }
    const slug = offices.find((o) => o.id === officeId)?.slug;
    if (slug === undefined) throw invalid('unknown office');
    if (!admin && !caller.groups.includes(`nwfl-office-${slug}`)) throw denied();
  };

  /** SaveOccurrence, as events/writes.ts answers it. @param {Caller} caller @param {EventOccurrence} occurrence @param {boolean} decidedLater */
  const save = (caller, occurrence, decidedLater) => {
    const id = occurrence.id;
    const match = id === '' ? null : OCCURRENCE_ID.exec(id);
    if (id !== '' && match === null) throw invalid('malformed occurrence id');
    const hit = id === '' ? undefined : stored(id);
    /** What is there now: a saved event, or the calendar's own (a series date not changed yet, or a one-off). */
    const prior = hit?.row ?? (id === '' ? undefined : get(id, 'officers'));
    if (id !== '' && prior === undefined) throw new ConnectError(match?.[2] !== undefined ? 'that series has no occurrence on that date' : 'occurrence not found', Code.NotFound);
    const seriesId = prior !== undefined && prior.seriesId !== '' ? prior.seriesId : null;
    const own = seriesId !== null ? seriesById.get(seriesId) : undefined;
    /** A series date never changed before: the API gives it its series' venue when none is sent. */
    const generated = hit === undefined && seriesId !== null;
    const ownerOfficeId = own !== undefined ? own.hostOfficeId : prior !== undefined ? prior.ownerOfficeId || null : occurrence.ownerOfficeId === '' ? null : occurrence.ownerOfficeId;
    requireOwner(caller, ownerOfficeId);
    if (id !== '') {
      const keptSeries = occurrence.seriesId === '' || occurrence.seriesId === (seriesId ?? '');
      const keptOwner = occurrence.ownerOfficeId === '' || occurrence.ownerOfficeId === (ownerOfficeId ?? '');
      if (!keptSeries || !keptOwner) throw invalid('an occurrence keeps its series and its owning office');
    }
    if (decidedLater && occurrence.venueId !== '') throw invalid('venue_id must be empty when the venue is decided later');
    const startsAt = occurrence.startsAt ?? prior?.startsAt;
    if (startsAt === undefined) throw invalid('starts_at is required');
    const visibility = VISIBILITIES.has(occurrence.visibility) ? occurrence.visibility : (own?.visibility ?? prior?.visibility);
    if (visibility === undefined) throw invalid('visibility is required');
    const url = occurrence.url.trim();
    checkUrls(url === '' ? null : url, occurrence.detail);
    if (occurrence.venueId !== '' && !ID.test(occurrence.venueId)) throw invalid('venue_id is not an id');
    const venueId = occurrence.venueId !== '' ? occurrence.venueId : generated && !decidedLater ? (prior?.venueId ?? '') : '';
    const venue = venueId === '' ? undefined : venueById.get(venueId);
    if (venueId !== '' && venue === undefined) throw new ConnectError('refers to something missing or still in use', Code.FailedPrecondition);
    const title = occurrence.title.trim();
    if ((seriesId === null && title === '') || [...title].length > 120) throw notAllowedValue();
    const endsAt = occurrence.endsAt;
    if (endsAt !== undefined && timestampDate(endsAt).getTime() <= timestampDate(startsAt).getTime()) throw notAllowedValue();

    const row = create(EventOccurrenceSchema, {
      id: hit !== undefined ? hit.row.id : seriesId !== null || id === '' ? randomUUID() : id,
      seriesId: seriesId ?? '',
      title: title !== '' ? title : (own?.title ?? ''),
      startsAt,
      ...(endsAt !== undefined ? { endsAt } : {}),
      venueId,
      ...(venue !== undefined ? { venue: /** @type {any} */ (venue) } : {}),
      status: STATUSES.has(occurrence.status) ? occurrence.status : OccurrenceStatus.SCHEDULED,
      statusNote: occurrence.statusNote.trim(),
      detail: occurrence.detail.trim(),
      url,
      visibility,
      localDate: protoDate(centralDate(timestampDate(startsAt))),
      area: venue?.area ?? own?.area ?? Area.UNSPECIFIED,
      ownerOfficeId: seriesId !== null ? '' : (ownerOfficeId ?? ''),
    });
    rows.set(hit?.key ?? (id === '' ? row.id : id), row);
    return clone(EventOccurrenceSchema, row);
  };

  return {
    list,
    get,
    /**
     * EventService as the stand-in answers it. `callerOf` gives the verified caller, undefined for none
     * (the public), and refuses what the API would (a cookie, a bad token).
     * @param {(ctx: import('@connectrpc/connect').HandlerContext) => Promise<Caller | undefined>} callerOf
     * @returns {Partial<import('@connectrpc/connect').ServiceImpl<typeof import('../src/gen/nwfl/mensa/v1/event_pb.js').EventService>>}
     */
    handlers: (callerOf) => ({
      listOccurrences: async (req, ctx) => {
        const audience = (await callerOf(ctx))?.audience ?? 'public';
        const from = req.from ? iso(req.from) : today();
        return { occurrences: list(from, req.to ? iso(req.to) : addDays(from, 62), audience) };
      },
      getOccurrence: async (req, ctx) => {
        const found = get(req.id, (await callerOf(ctx))?.audience ?? 'public');
        if (found === undefined) throw new ConnectError('occurrence not found', Code.NotFound);
        return { occurrence: found };
      },
      listSeries: async (_req, ctx) => {
        const audience = (await callerOf(ctx))?.audience ?? 'public';
        return { series: series.filter((s) => audience !== 'public' || s.visibility === EventVisibility.PUBLIC).map((s) => ({ ...s, active: true })) };
      },
      listVenues: async (_req, ctx) => {
        await callerOf(ctx);
        return { venues: venues.map((v) => ({ ...v })) };
      },
      saveOccurrence: async (req, ctx) => {
        const caller = await callerOf(ctx);
        if (caller === undefined) throw new ConnectError('sign in first', Code.Unauthenticated);
        if (req.occurrence === undefined) throw invalid('occurrence is required');
        return { occurrence: save(caller, req.occurrence, req.venueDecidedLater) };
      },
    }),
  };
}
