// EDITOR E6: the officers' event screens' rules (spec S10, S11; SPEC-v3 3.2 and Q4). Who may use them
// (an officer or the Admin) and which events are theirs (a series date is its series' host office's, a
// one-off its own office's; the Admin's are every office's); "Our events", the next 90 days grouped by
// date with each one's status in words; the form for one date, read and checked field by field, with
// the start time in Central (explicit, and refused in words for the hour the clocks skip in spring);
// the save request; the API's URL reasons put back on their fields (A3a); and the Q4 seam (urlReview).
// The API checks every step again (events/writes.ts): this only decides what the pages offer.
import type { MessageInitShape } from '@bufbuild/protobuf';
import { timestampDate, timestampFromDate } from '@bufbuild/protobuf/wkt';
import { formatDate } from '../../data/format';
import { AREAS } from '../../data/live';
import { type EventOccurrence, type EventOccurrenceSchema, EventVisibility, OccurrenceStatus, type Venue } from '../../gen/nwfl/mensa/v1/event_pb.js';
import { type EventStatus, centralParts, formatTime } from '../calendar';

export const EVENTS_PATH = '/officer-area/events';
export const NEW_EVENT_PATH = `${EVENTS_PATH}/new`;
/** S10 lists this many days from today. */
export const EVENT_DAYS = 90;
/** event_occurrence.title: 1 to 120 characters. */
export const TITLE_MAX = 120;
/** "Note shown on the calendar": one line. */
export const NOTE_MAX = 300;
export const DETAIL_MAX = 2000;
/** The URL rule's own limit (links/rule.ts). */
export const URL_MAX = 2048;
/** readForm's cap for the event form: every field at its most, percent-encoded, fits; under Astro's 64 KiB. */
export const EVENT_FORM_LIMIT = 48 * 1024;

/** What the API's lens puts where it holds a passage back (redaction/render.ts WITHHELD). */
const WITHHELD = '[withheld]';
const OFFICE_GROUP = 'nwfl-office-';
const SERIES_DATE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):\d{4}-\d{2}-\d{2}$/;

/** An office on the roster. */
export interface RosterOffice {
  id: string;
  slug: string;
  title: string;
}

export interface EventOffices {
  admin: boolean;
  /** The offices whose events this person changes, in roster order: those they hold, or every one for the Admin. */
  offices: Array<RosterOffice & { held: boolean }>;
}

/** Who may open the event screens: an officer, or the Admin (the API lets the Admin change any event). */
export function mayUseEvents(groups: readonly string[]): boolean {
  return groups.includes('nwfl-officers') || groups.includes('nwfl-admin');
}

export function eventOffices(groups: readonly string[], roster: readonly RosterOffice[]): EventOffices {
  const admin = groups.includes('nwfl-admin');
  const held = new Set(groups.filter((g) => g.startsWith(OFFICE_GROUP)).map((g) => g.slice(OFFICE_GROUP.length)));
  return { admin, offices: roster.filter((o) => admin || held.has(o.slug)).map((o) => ({ ...o, held: held.has(o.slug) })) };
}

/** The office an event belongs to: its series' host (by `hosts`, series id to office id), else its own; '' for none. */
export function ownerOf(o: Pick<EventOccurrence, 'id' | 'seriesId' | 'ownerOfficeId'>, hosts: ReadonlyMap<string, string>): string {
  // A date read withheld names its series in its id alone.
  const series = o.seriesId || SERIES_DATE.exec(o.id)?.[1] || '';
  if (series !== '') return hosts.get(series) ?? '';
  return o.ownerOfficeId;
}

/** Whether this person may change the event: the Admin any; an officer their offices' (none with no office). */
export function mayChange(o: Pick<EventOccurrence, 'id' | 'seriesId' | 'ownerOfficeId'>, hosts: ReadonlyMap<string, string>, who: EventOffices): boolean {
  if (who.admin) return true;
  const owner = ownerOf(o, hosts);
  return owner !== '' && who.offices.some((office) => office.id === owner);
}

/** The caller's sign-in reads part of it held back: the form must not open, or a save would write the gaps over the text. */
export function isWithheld(o: Pick<EventOccurrence, 'detailsWithheld' | 'title' | 'statusNote' | 'detail' | 'url'>): boolean {
  return o.detailsWithheld || [o.title, o.statusNote, o.detail, o.url].some((text) => text.includes(WITHHELD));
}

/** The page for one date: a series date as <series>_<date>, as the public event pages write it. */
export function editPathOf(id: string): string {
  return `${EVENTS_PATH}/${id.replace(':', '_')}`;
}

const STATUS_NAMES: Partial<Record<OccurrenceStatus, EventStatus>> = {
  [OccurrenceStatus.SCHEDULED]: 'scheduled',
  [OccurrenceStatus.TENTATIVE]: 'tentative',
  [OccurrenceStatus.CANCELLED]: 'cancelled',
  [OccurrenceStatus.MOVED]: 'moved',
};
const STATUS_VALUES: Record<EventStatus, OccurrenceStatus> = {
  scheduled: OccurrenceStatus.SCHEDULED,
  tentative: OccurrenceStatus.TENTATIVE,
  cancelled: OccurrenceStatus.CANCELLED,
  moved: OccurrenceStatus.MOVED,
};

const pad = (n: number) => String(n).padStart(2, '0');
const dateOf = (o: Pick<EventOccurrence, 'localDate'>): string | undefined => (o.localDate === undefined ? undefined : `${o.localDate.year}-${pad(o.localDate.month)}-${pad(o.localDate.day)}`);

/** When, on its day, in Central: "11:30 am to 1:00 pm", "From 2:00 pm", "Time not set". */
export function timeText(o: Pick<EventOccurrence, 'startsAt' | 'endsAt'>): string {
  if (o.startsAt === undefined) return 'Time not set';
  const start = centralParts(timestampDate(o.startsAt));
  if (o.endsAt === undefined) return `From ${formatTime(start.time)}`;
  const end = centralParts(timestampDate(o.endsAt));
  return `${formatTime(start.time)} to ${end.date === start.date ? '' : `${formatDate(end.date)}, `}${formatTime(end.time)}`;
}

/** One line of S10. */
export interface OurEvent {
  id: string;
  editPath: string;
  title: string;
  time: string;
  /** Unset when the caller's sign-in reads the event withheld. */
  status: EventStatus | undefined;
  statusNote: string;
  office: string;
  place: string;
  members: boolean;
  /** Read withheld: listed, with nothing to change. */
  withheld: boolean;
}

export interface OurDay {
  date: string;
  heading: string;
  events: OurEvent[];
}

/** S10: the events of this person's offices (every office's for the Admin), by date, each day in start order. */
export function ourEvents(occurrences: readonly EventOccurrence[], hosts: ReadonlyMap<string, string>, who: EventOffices): OurDay[] {
  const names = new Map(who.offices.map((o) => [o.id, o.title]));
  const lines = occurrences.flatMap((o) => {
    const date = dateOf(o);
    const withheld = isWithheld(o);
    const status = STATUS_NAMES[o.status];
    // Nothing the site can show or fill a form from: no date, or no status it can read.
    if (date === undefined || (!withheld && status === undefined) || !mayChange(o, hosts, who)) return [];
    const owner = ownerOf(o, hosts);
    const members = o.visibility === EventVisibility.MEMBERS;
    const line: OurEvent = {
      id: o.id,
      editPath: editPathOf(o.id),
      title: withheld ? (members ? 'Members event' : 'Event') : o.title,
      time: withheld ? '' : timeText(o),
      status: withheld ? undefined : status,
      statusNote: withheld ? '' : o.statusNote,
      office: names.get(owner) ?? (owner === '' ? 'No office' : 'Another office'),
      place: withheld ? '' : (o.venue?.name ?? 'Place to be decided'),
      members,
      withheld,
    };
    return [{ date, start: o.startsAt === undefined ? 0 : timestampDate(o.startsAt).getTime(), line }];
  });
  const days = new Map<string, OurDay>();
  for (const { date, line } of lines.sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start)) {
    const day = days.get(date) ?? { date, heading: formatDate(date), events: [] };
    day.events.push(line);
    days.set(date, day);
  }
  return [...days.values()];
}

/** The form's fields as typed (or as read): handed back on a problem. */
export interface EventValues {
  title: string;
  date: string;
  time: string;
  status: string;
  statusNote: string;
  venue: string;
  detail: string;
  url: string;
  visibility: string;
  office: string;
}

export type EventVisibilityName = 'public' | 'members';

/** A checked form, ready to save. */
export interface EventInput {
  /** A one-off's; empty for a series date (it keeps its series' title). */
  title: string;
  date: string;
  startsAt: Date;
  status: EventStatus;
  statusNote: string;
  /** Empty: the place is decided later. */
  venueId: string;
  detail: string;
  url: string;
  visibility: EventVisibilityName;
  /** A new event's office; empty otherwise (an event keeps its office). */
  officeId: string;
}

export const STATUS_CHOICES: ReadonlyArray<{ value: EventStatus; label: string; hint: string }> = [
  { value: 'scheduled', label: 'Scheduled', hint: 'It is going ahead.' },
  { value: 'tentative', label: 'Tentative', hint: 'It may change. Say why in the note.' },
  { value: 'cancelled', label: 'Cancelled', hint: 'It is not happening. It stays on the calendar, marked Cancelled.' },
  { value: 'moved', label: 'Moved', hint: 'It is on another day or at another place. Say where or when in the note.' },
];

export const VISIBILITY_CHOICES: ReadonlyArray<{ value: EventVisibilityName; label: string; hint: string }> = [
  { value: 'public', label: 'Everyone', hint: 'It is on the public calendar and in the calendar feed.' },
  { value: 'members', label: 'Members only', hint: 'It is left off the public calendar and the calendar feed.' },
];

/** The fields in the order the form shows them: the problem list at the top follows it. */
export const FIELD_ORDER = ['title', 'office', 'date', 'time', 'status', 'statusNote', 'venue', 'detail', 'url', 'visibility'] as const;

/** A place to choose, as a radio button: its name, and its town and area beneath. */
export interface VenueChoice {
  id: string;
  label: string;
  hint: string;
}

/** The places to choose from, in name order; the event's own one kept where it is no longer listed (a save must not lose it). */
export function venueChoices(venues: readonly Venue[], current?: Venue): VenueChoice[] {
  const all = current !== undefined && current.id !== '' && !venues.some((v) => v.id === current.id) ? [...venues, current] : venues;
  return all
    .map((v) => ({ id: v.id, label: v.name, hint: [v.city, AREAS[v.area]].filter((part) => part !== undefined && part !== '').join(', ') }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

/** The form filled from an event: its date and start time in Central. */
export function valuesOf(o: EventOccurrence): EventValues {
  return {
    title: o.title,
    date: dateOf(o) ?? '',
    time: o.startsAt === undefined ? '' : centralParts(timestampDate(o.startsAt)).time,
    status: STATUS_NAMES[o.status] ?? '',
    statusNote: o.statusNote,
    venue: o.venueId,
    detail: o.detail,
    url: o.url,
    visibility: o.visibility === EventVisibility.MEMBERS ? 'members' : 'public',
    office: o.ownerOfficeId,
  };
}

/** The instant of a Central wall-clock time; undefined for a time the clocks skip in spring. One that happens twice (autumn) is the first. */
export function centralInstant(date: string, time: string): Date | undefined {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi] = time.split(':').map(Number) as [number, number];
  // Daylight time (UTC-5) first, then standard (UTC-6): the earlier of two is daylight time.
  for (const offset of [5, 6]) {
    const candidate = new Date(Date.UTC(y, mo - 1, d, h + offset, mi));
    const here = centralParts(candidate);
    if (here.date === date && here.time === time) return candidate;
  }
  return undefined;
}

/** A real calendar date written YYYY-MM-DD. */
function isoDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return day.toISOString().startsWith(value);
}

/** A time as HH:MM: 18:00 as a browser's time field sends it, or as typed: 6 pm, 6:05 p.m., 12:00 noon. */
function readTime(value: string): string | undefined {
  const text = value.trim().toLowerCase();
  if (text === 'noon' || text === '12:00 noon' || text === '12 noon') return '12:00';
  const plain = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text);
  if (plain) return `${pad(Number(plain[1]))}:${plain[2]}`;
  const twelve = /^(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*([ap])\.?\s*m\.?$/.exec(text);
  if (!twelve) return undefined;
  const hours = (Number(twelve[1]) % 12) + (twelve[3] === 'p' ? 12 : 0);
  return `${pad(hours)}:${twelve[2] ?? '00'}`;
}

/** Characters as people count them (code points), not UTF-16 units. */
const length = (text: string) => [...text].length;

type Field = (name: string) => string | undefined;
export type ParsedEvent = { ok: true; value: EventInput } | { ok: false; errors: Partial<Record<(typeof FIELD_ORDER)[number], string>>; values: EventValues };

export interface FormContext {
  /** new: a new one-off; one-off: a one-off's change (its date may move); series: a series date's change (its date and title are its series'). */
  mode: 'new' | 'one-off' | 'series';
  /** A series date's own date. */
  date?: string;
  venues: readonly { id: string }[];
  /** The offices a new event may be for. */
  offices: readonly { id: string }[];
  /** Today in Central: a one-off's date may not be earlier. */
  today: string;
}

/** Every field as typed, an absent one empty: kept on the page when a save cannot be made. */
export function typedValues(field: Field): EventValues {
  const raw = (name: string) => field(name) ?? '';
  return {
    title: raw('title'),
    date: raw('date'),
    time: raw('time'),
    status: raw('status'),
    statusNote: raw('statusNote'),
    venue: raw('venue'),
    detail: raw('detail'),
    url: raw('url'),
    visibility: raw('visibility'),
    office: raw('office'),
  };
}

/** The event form, read and checked; each problem in plain words, keyed by its field. */
export function parseEventForm(field: Field, context: FormContext): ParsedEvent {
  const values: EventValues = { ...typedValues(field), ...(context.mode === 'series' ? { date: context.date ?? '' } : {}) };
  const errors: Partial<Record<(typeof FIELD_ORDER)[number], string>> = {};
  const oneOff = context.mode !== 'series';

  const title = values.title.trim();
  if (oneOff && title === '') errors.title = 'Give the event a title.';
  else if (oneOff && length(title) > TITLE_MAX) errors.title = `The title is too long: at most ${TITLE_MAX} characters.`;

  let officeId = '';
  if (context.mode === 'new') {
    if (context.offices.length === 1) officeId = context.offices[0]!.id;
    else if (context.offices.some((o) => o.id === values.office)) officeId = values.office;
    else errors.office = 'Choose whose event it is.';
  }

  const date = values.date.trim();
  if (date === '') errors.date = 'Give the date.';
  else if (!isoDate(date)) errors.date = 'That is not a date. Write it as year-month-day, such as 2027-03-14.';
  else if (oneOff && date < context.today) errors.date = 'That date has passed. Choose today or a later date.';

  const time = values.time.trim() === '' ? undefined : readTime(values.time);
  if (values.time.trim() === '') errors.time = 'Give the start time.';
  else if (time === undefined) errors.time = 'That is not a time. Write it as 11:30 am or 6:00 pm.';
  const startsAt = time !== undefined && errors.date === undefined ? centralInstant(date, time) : undefined;
  if (time !== undefined && errors.date === undefined && startsAt === undefined) {
    errors.time = `There is no ${formatTime(time)} on ${formatDate(date)} in Central time: the clocks go forward an hour that night. Choose 3:00 am or later.`;
  }

  const status = STATUS_CHOICES.find((c) => c.value === values.status)?.value;
  if (status === undefined) errors.status = 'Choose a status.';
  const statusNote = values.statusNote.trim();
  if (length(statusNote) > NOTE_MAX) errors.statusNote = `The note is too long: at most ${NOTE_MAX} characters.`;
  if (values.venue !== '' && !context.venues.some((v) => v.id === values.venue)) errors.venue = 'Choose a place from the list.';
  const detail = values.detail.replace(/\r\n?/g, '\n').trim();
  if (length(detail) > DETAIL_MAX) errors.detail = `The details are too long: at most ${DETAIL_MAX} characters.`;
  const url = values.url.trim();
  if (length(url) > URL_MAX) errors.url = `The web address is too long: at most ${URL_MAX} characters.`;
  const visibility = VISIBILITY_CHOICES.find((c) => c.value === values.visibility)?.value;
  if (visibility === undefined) errors.visibility = 'Choose who can see it.';

  if (Object.keys(errors).length > 0 || startsAt === undefined || status === undefined || visibility === undefined) return { ok: false, errors, values };
  return { ok: true, value: { title: oneOff ? title : '', date, startsAt, status, statusNote, venueId: values.venue, detail, url, visibility, officeId } };
}

export type SaveRequest = MessageInitShape<typeof EventOccurrenceSchema>;

/**
 * What SaveOccurrence is sent: the event by its id (a series date as <series>:<date> until its first
 * change, then its own), never its series or office (the API keeps both; only a new one-off names
 * its office). A series date keeps its series' title, and an event keeps its length where it had one.
 */
export function saveRequestFor(input: EventInput, existing: EventOccurrence | undefined, seriesTitle: string | undefined): SaveRequest {
  const series = existing !== undefined && existing.seriesId !== '';
  const length = existing?.startsAt !== undefined && existing.endsAt !== undefined ? timestampDate(existing.endsAt).getTime() - timestampDate(existing.startsAt).getTime() : undefined;
  return {
    id: existing?.id ?? '',
    seriesId: '',
    ownerOfficeId: existing === undefined ? input.officeId : '',
    title: series ? (existing.title === seriesTitle ? '' : existing.title) : input.title,
    startsAt: timestampFromDate(input.startsAt),
    ...(length === undefined ? {} : { endsAt: timestampFromDate(new Date(input.startsAt.getTime() + length)) }),
    venueId: input.venueId,
    status: STATUS_VALUES[input.status],
    statusNote: input.statusNote,
    detail: input.detail,
    url: input.url,
    visibility: input.visibility === 'members' ? EventVisibility.MEMBERS : EventVisibility.PUBLIC,
  };
}

/**
 * The API gives a series date its series' venue on its first change when none is sent
 * (events/writes.ts); "decided later" then needs a second save, of the stored date, with no venue.
 */
export function venueFollowUp(request: SaveRequest, saved: Pick<EventOccurrence, 'id' | 'venueId'>): SaveRequest | undefined {
  return request.venueId === '' && saved.venueId !== '' ? { ...request, id: saved.id, venueId: '' } : undefined;
}

const sentence = (text: string) => (/[.…]$/.test(text) ? text : `${text}.`);

/**
 * The API's refusal (EDITOR A3a, events/writes.ts checkUrls: "url: ...; detail line N: ...") put back on
 * the fields it is about, in sentences; anything else stays for the top of the page.
 */
export function fieldReasons(reason: string): { url: string[]; detail: string[]; other: string[] } {
  const out = { url: [] as string[], detail: [] as string[], other: [] as string[] };
  for (const part of reason.split(/; (?=url: |detail line \d+: )/)) {
    const url = /^url: ([\s\S]+)$/.exec(part);
    const detail = /^detail line (\d+): ([\s\S]+)$/.exec(part);
    if (url) out.url.push(sentence(`${url[1]!.charAt(0).toUpperCase()}${url[1]!.slice(1)}`));
    else if (detail) out.detail.push(sentence(`Line ${detail[1]}: ${detail[2]}`));
    else if (part.trim() !== '') out.other.push(sentence(part.trim()));
  }
  return out;
}

export type FieldName = (typeof FIELD_ORDER)[number];
/** Each field's problems, in words. */
export type FieldErrors = Partial<Record<FieldName, string[]>>;

/** The API's refusal of a save: the address reasons on their fields, anything else for the top. */
export function refusalErrors(reason: string): { errors: FieldErrors; other: string[] } {
  const { url, detail, other } = fieldReasons(reason);
  return { errors: { ...(url.length > 0 ? { url } : {}), ...(detail.length > 0 ? { detail } : {}) }, other };
}

const FIELD_NAMES: Record<FieldName, string> = {
  title: 'Title',
  office: 'Whose event it is',
  date: 'Date',
  time: 'Start time',
  status: 'Status',
  statusNote: 'Note shown on the calendar',
  venue: 'Where',
  detail: 'Details',
  url: 'Web address',
  visibility: 'Who can see it',
};
/** A choice's link goes to its first button (src/components/EventForm.astro), which takes the focus. */
const FIELD_ANCHORS: Partial<Record<FieldName, string>> = { office: 'office-0', status: 'status-scheduled', venue: 'venue-later', visibility: 'visibility-public' };

/** The list at the top of the form: each problem, in the form's order, named by its field and linking to it. */
export function problemSummary(errors: FieldErrors): Array<{ href: string; text: string }> {
  return FIELD_ORDER.flatMap((field) => (errors[field] ?? []).map((text) => ({ href: `#${FIELD_ANCHORS[field] ?? field}`, text: `${FIELD_NAMES[field]}: ${text}` })));
}

/** A URL printed in text, as the API finds one (links/rule.ts URL_IN_TEXT), less the sentence's punctuation after it. */
const URL_IN_TEXT = /(?:https?:\/\/|www\.)[^\s<>"'`]+/giu;
const urlsOf = (x: { url: string; detail: string }): string[] => [
  ...(x.url === '' ? [] : [x.url]),
  ...[...x.detail.matchAll(URL_IN_TEXT)].map((m) => m[0].replace(/[.,;:!?)\]]+$/u, '')),
];

/**
 * Q4 (Ross, 11-12): a new or changed event URL is to show "details to follow" publicly until a reviewer
 * answers yes. THE SEAM for A3b, which is not built: this names the addresses a save makes new (in the
 * web address and in the details), and `held` is the ones the public cannot see yet. Today nothing is
 * held: an event is live on save, links and all (P19). A3b fills `held` (from its review state) and
 * hides them in the API's public reads; the page already says so when `held` is not empty.
 */
export function urlReview(before: { url: string; detail: string } | undefined, after: { url: string; detail: string }): { changed: string[]; held: string[] } {
  const known = new Set(before === undefined ? [] : urlsOf(before));
  return { changed: [...new Set(urlsOf(after).filter((u) => !known.has(u)))], held: [] };
}
