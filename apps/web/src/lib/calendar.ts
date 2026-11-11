// The calendar's view (R4): Central dates and times in words, the month grid
// and the agenda, the event pages' paths, and an event as an iCalendar entry.
// All ten counties are US Central; so is every date and time here.
import { formatDate } from '../data/format';
import type { ContentSource } from './content';
import type { IcsEvent, IcsStatus } from './ics';

export const ZONE = 'America/Chicago';

export type EventStatus = 'scheduled' | 'tentative' | 'cancelled' | 'moved';

/** A series' category (event.proto EventCategory), as the API gave it; none for a one-off or an unspecified one. */
export type EventCategoryName = 'lunch' | 'dinner' | 'happy_hour' | 'excomm' | 'picnic' | 'party' | 'regional' | 'national' | 'virtual' | 'other';

export interface CalendarVenue {
  kind: 'business' | 'home' | 'virtual';
  name: string;
  /** Businesses only; never a member's home (R3). */
  address: string;
  city: string;
  /** https only. */
  url: string | undefined;
  accessibilityNote: string;
  /** The office whose role address is the contact. */
  hostOfficeId: string;
}

/** One public event, as the pages show it. */
export interface CalendarEvent {
  /** The API's id: a stored event's own, or the series id and date. */
  id: string;
  path: string;
  title: string;
  /** The Central date, YYYY-MM-DD. */
  date: string;
  /** The Central start time, HH:MM; none while it is to be decided. */
  start: string | undefined;
  end: { date: string; time: string } | undefined;
  status: EventStatus;
  statusNote: string;
  detail: string;
  /** https only. */
  url: string | undefined;
  venue: CalendarVenue | undefined;
  /** The area, in words. */
  area: string;
  seriesId: string;
  ownerOfficeId: string;
  source: ContentSource;
  /** EVENTS2: its series' category, for the type icon; undefined when the API gives none (never guessed). */
  category?: EventCategoryName | undefined;
}

const PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** An instant as the Central date and wall-clock time. */
export function centralParts(at: Date): { date: string; time: string } {
  const part = Object.fromEntries(PARTS.formatToParts(at).map((p) => [p.type, p.value]));
  return { date: `${part['year']}-${part['month']}-${part['day']}`, time: `${part['hour']}:${part['minute']}` };
}

export function todayCentral(now: Date): string {
  return centralParts(now).date;
}

/**
 * The status a chip shows. A scheduled or tentative occurrence that has ended
 * (or started, with no end; or whose day is over, with no time) reads "past";
 * moved and cancelled keep their own words. The API and the .ics are untouched.
 */
export function chipStatus(e: Pick<CalendarEvent, 'date' | 'start' | 'end' | 'status'>, now: Date): EventStatus | 'past' {
  if (e.status !== 'scheduled' && e.status !== 'tentative') return e.status;
  return hasEnded(e, now) ? 'past' : e.status;
}

/**
 * Whether an occurrence is over, by the Central clock: its end has passed, or its start where it has
 * no end, or its whole day where it has no time. At its end minute it is still on.
 */
export function hasEnded(e: Pick<CalendarEvent, 'date' | 'start' | 'end'>, now: Date): boolean {
  const at = e.end ?? { date: e.date, time: e.start ?? '23:59' };
  const here = centralParts(now);
  return `${at.date} ${at.time}` < `${here.date} ${here.time}`;
}

/** "Coming up" (W-LOOK2): what has not ended, in the order given; one that ended earlier today leaves it, whatever its status. */
export function comingUp<T extends Pick<CalendarEvent, 'date' | 'start' | 'end'>>(events: readonly T[], now: Date): T[] {
  return events.filter((e) => !hasEnded(e, now));
}

/** The Google Calendar page that subscribes to a webcal:// feed (a plain link, no sign-in of ours). */
export function googleCalendarUrl(webcalFeed: string): string {
  return `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcalFeed)}`;
}

export function addDays(date: string, days: number): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
}

/** "11:30 am", "12:00 noon", "5:05 pm". */
export function formatTime(time: string): string {
  const [hours, minutes] = time.split(':').map(Number) as [number, number];
  const mm = String(minutes).padStart(2, '0');
  if (hours === 12 && minutes === 0) return '12:00 noon';
  return `${hours % 12 === 0 ? 12 : hours % 12}:${mm} ${hours < 12 ? 'am' : 'pm'}`;
}

/** When an event is, in one line of words. */
export function whenText(event: Pick<CalendarEvent, 'date' | 'start' | 'end'>): string {
  const day = formatDate(event.date);
  if (event.start === undefined) return `${day}, time to be decided`;
  if (event.end === undefined) return `${day}, from ${formatTime(event.start)}`;
  const end = event.end.date === event.date ? formatTime(event.end.time) : `${formatDate(event.end.date)}, ${formatTime(event.end.time)}`;
  return `${day}, ${formatTime(event.start)} to ${end}`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A month the calendar can show, YYYY-MM, or undefined. */
export function parseMonth(value: string | null | undefined): string | undefined {
  const m = /^(\d{4})-(\d{2})$/.exec(value ?? '');
  if (!m) return undefined;
  const [year, month] = [Number(m[1]), Number(m[2])];
  return year >= 2000 && year <= 2100 && month >= 1 && month <= 12 ? value! : undefined;
}

export function shiftMonth(month: string, by: number): string {
  const [year, m] = month.split('-').map(Number) as [number, number];
  const index = year * 12 + (m - 1) + by;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

export function monthLabel(month: string): string {
  const [year, m] = month.split('-').map(Number) as [number, number];
  return `${MONTHS[m - 1]} ${year}`;
}

/** The first and last date of a month. */
export function monthRange(month: string): { from: string; to: string } {
  return { from: `${month}-01`, to: addDays(`${shiftMonth(month, 1)}-01`, -1) };
}

/** How far ahead "Coming up" looks. */
export const COMING_UP_DAYS = 56;

export interface GridDay {
  date: string;
  inMonth: boolean;
  today: boolean;
  events: CalendarEvent[];
}

const byTime = (a: CalendarEvent, b: CalendarEvent) => (a.start ?? '').localeCompare(b.start ?? '');

/** The month in whole weeks, Sunday first (as US wall calendars are), each day with its events. */
export function monthGrid(month: string, events: readonly CalendarEvent[], today: string): GridDay[][] {
  const { from, to } = monthRange(month);
  const first = addDays(from, -new Date(`${from}T00:00:00Z`).getUTCDay());
  const weeks: GridDay[][] = [];
  for (let start = first; start <= to; start = addDays(start, 7)) {
    weeks.push(
      Array.from({ length: 7 }, (_, i) => {
        const date = addDays(start, i);
        return { date, inMonth: date >= from && date <= to, today: date === today, events: date >= from && date <= to ? events.filter((e) => e.date === date).sort(byTime) : [] };
      }),
    );
  }
  return weeks;
}


/** The id of a day's first entry in the list, which the grid's day links to (W-LOOK2). */
export function dayAnchor(date: string): string {
  return `day-${date}`;
}

/** Events by day, in date order, each day in time order. */
export function agendaDays(events: readonly CalendarEvent[]): { date: string; events: CalendarEvent[] }[] {
  const days = new Map<string, CalendarEvent[]>();
  for (const event of [...events].sort((a, b) => a.date.localeCompare(b.date) || byTime(a, b))) days.set(event.date, [...(days.get(event.date) ?? []), event]);
  return [...days].map(([date, list]) => ({ date, events: list }));
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PARAM = new RegExp(`^(${UUID})(?:_(\\d{4}-\\d{2}-\\d{2}))?$`);

/** An event's page: a stored event by its id, a series date as <series>_<date>. */
export function eventPath(id: string): string {
  return `/events/${id.replace(':', '_')}`;
}

/** The API id an event page's path names, or undefined for anything malformed. */
export function eventIdFromParam(param: string | undefined): string | undefined {
  const m = PARAM.exec(param ?? '');
  if (!m) return undefined;
  if (m[2] === undefined) return m[1];
  const day = new Date(`${m[2]}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().startsWith(m[2]) ? `${m[1]}:${m[2]}` : undefined;
}

const ICS_STATUS: Record<EventStatus, IcsStatus> = { scheduled: 'CONFIRMED', moved: 'CONFIRMED', tentative: 'TENTATIVE', cancelled: 'CANCELLED' };

/** Where, in one line: a member's home by its area only (R3). */
export function placeText(event: Pick<CalendarEvent, 'venue' | 'area'>): string {
  const venue = event.venue;
  if (venue === undefined) return event.area;
  if (venue.kind === 'home') return `${venue.name}, ${event.area}`;
  if (venue.kind === 'virtual') return `Online: ${venue.name}`;
  return [venue.name, venue.address, venue.city].filter(Boolean).join(', ');
}

/** An event's notes for a calendar app: its status note, detail, link, and its page here. */
export function eventDescription(event: CalendarEvent, origin: string): string {
  return [event.statusNote, event.detail, event.url && `More: ${event.url}`, `On our calendar: ${origin}${event.path}`].filter(Boolean).join('\n');
}

export function toIcsEvent(event: CalendarEvent, origin: string): IcsEvent {
  const page = `${origin}${event.path}`;
  const description = eventDescription(event, origin);
  return {
    uid: `${event.id}@nwflorida.us`,
    start: { date: event.date, time: event.start },
    end: event.start === undefined ? undefined : event.end,
    summary: event.title,
    location: placeText(event),
    description,
    url: page,
    status: ICS_STATUS[event.status],
  };
}
