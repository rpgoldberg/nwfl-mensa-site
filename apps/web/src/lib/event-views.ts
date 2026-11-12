// EVENTS2 (Ross's concept, 11-10): the one model behind /events' three views. The view and the
// date live in the URL (?view=week&d=2026-11-11), so the page works with no script and Back; the
// views differ only in the dates they cover and how they draw them. Each event's type icon comes
// from its series' category alone: an event the API does not classify is a plain "Event", never a
// guess from its title. All dates are Central (calendar.ts).
import { type CalendarEvent, COMING_UP_DAYS, type EventCategoryName, addDays, eventDescription, googleCalendarUrl, monthRange, parseMonth, placeText, shiftMonth } from './calendar';

export type CalView = 'list' | 'week' | 'month';
export const CAL_VIEWS: readonly CalView[] = ['list', 'week', 'month'];
export const VIEW_LABELS: Record<CalView, string> = { list: 'List', week: 'Week', month: 'Month' };

/** What the URL asks for: a view, and the selected date, which also places the period. */
export interface CalState {
  view: CalView;
  date: string;
}

/** The type icons (Ross's mapping, SPEC-ross.md): four kinds, and the plain one. */
export type EventKind = 'meal' | 'social' | 'gathering' | 'meeting' | 'event';
export const KIND_LABELS: Record<EventKind, string> = {
  meal: 'Lunch or meal',
  social: 'Happy hour or social',
  gathering: 'Meetup or gathering',
  meeting: 'Meeting or other',
  event: 'Event',
};
/** The legend's order. */
export const KINDS: readonly EventKind[] = ['meal', 'social', 'gathering', 'meeting', 'event'];

const KIND_OF: Record<EventCategoryName, EventKind> = {
  lunch: 'meal',
  dinner: 'meal',
  picnic: 'meal',
  happy_hour: 'social',
  party: 'social',
  regional: 'gathering',
  national: 'gathering',
  excomm: 'meeting',
  virtual: 'meeting',
  other: 'meeting',
};

export function eventKind(e: Pick<CalendarEvent, 'category'>): EventKind {
  return e.category === undefined ? 'event' : KIND_OF[e.category];
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MON = MONTHS.map((m) => m.slice(0, 3));
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const parts = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), wd: d.getUTCDay() };
};

/** A calendar date the page can show, 2000 to 2100, or undefined. */
function parseDate(value: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const day = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== value) return undefined;
  return value >= '2000-01-01' && value <= '2100-12-31' ? value : undefined;
}

/** The state the URL asks for, or undefined (the page answers 404). The old ?month=YYYY-MM is that month's grid. */
export function parseCalState(params: URLSearchParams, today: string): CalState | undefined {
  const month = params.get('month');
  if (month !== null) {
    const m = parseMonth(month);
    if (m === undefined) return undefined;
    return { view: 'month', date: m === today.slice(0, 7) ? today : `${m}-01` };
  }
  const view = params.get('view') ?? 'list';
  if (!(CAL_VIEWS as readonly string[]).includes(view)) return undefined;
  const raw = params.get('d');
  const date = raw === null ? today : parseDate(raw);
  return date === undefined ? undefined : { view: view as CalView, date };
}

/** The address of a view at a date; the list from today is plain /events. */
export function calHref(view: CalView, date: string, today: string, hash = ''): string {
  return view === 'list' && date === today ? `/events${hash}` : `/events?view=${view}&d=${date}${hash}`;
}

export interface CalPeriod {
  view: CalView;
  /** The selected date. */
  date: string;
  /** The days the view lists. */
  from: string;
  to: string;
  /** What to read from the API. */
  read: { from: string; to: string };
  /** The stepper's words: "Nov 8 – 14", "November 2026"; `short` where room is tight. */
  label: string;
  short: string;
  /** EV1: shorter still, as the toolbar narrows: in numbers ("11/29–12/5", "Nov ’26"), then on two lines. */
  tiny: string;
  stack: readonly [string, string];
  /** The period in words, for a screen reader and the arrows' names. */
  spoken: string;
  /** The dates the arrows go to. */
  prev: string;
  next: string;
  /** The list from today: what has ended is left out. */
  upcoming: boolean;
  /** Today is in it. */
  thisPeriod: boolean;
}

const monthWords = (month: string) => `${MONTHS[Number(month.slice(5)) - 1]} ${month.slice(0, 4)}`;
const monthShort = (month: string) => `${MON[Number(month.slice(5)) - 1]} ${month.slice(0, 4)}`;
/** A month's tiny words: "Nov ’26", and stacked "Nov" over "2026". */
function monthTiny(month: string): Pick<CalPeriod, 'tiny' | 'stack'> {
  const mon = MON[Number(month.slice(5)) - 1]!;
  return { tiny: `${mon} ’${month.slice(2, 4)}`, stack: [mon, month.slice(0, 4)] };
}

/** The same day in another month, cut to its length; today, in this month. */
function sameDayIn(month: string, day: number, today: string): string {
  if (month === today.slice(0, 7)) return today;
  const { to } = monthRange(month);
  return `${month}-${String(Math.min(day, Number(to.slice(8)))).padStart(2, '0')}`;
}

export function calPeriod({ view, date }: CalState, today: string): CalPeriod {
  const month = date.slice(0, 7);
  if (view === 'week') {
    const from = addDays(date, -parts(date).wd);
    const to = addDays(from, 6);
    const [a, b] = [parts(from), parts(to)];
    const label = a.m === b.m ? `${MON[a.m]} ${a.d} – ${b.d}` : `${MON[a.m]} ${a.d} – ${MON[b.m]} ${b.d}`;
    // In numbers, the second month only when the week crosses into it: "11/8–14", "12/27–1/2".
    const last = a.m === b.m ? `${b.d}` : `${b.m + 1}/${b.d}`;
    const stack = [`${a.m + 1}/${a.d}`, `–${last}`] as const;
    const spoken =
      a.y !== b.y ? `the week of ${a.d} ${MONTHS[a.m]} ${a.y} to ${b.d} ${MONTHS[b.m]} ${b.y}` : a.m === b.m ? `the week of ${a.d} to ${b.d} ${MONTHS[b.m]} ${b.y}` : `the week of ${a.d} ${MONTHS[a.m]} to ${b.d} ${MONTHS[b.m]} ${b.y}`;
    return { view, date, from, to, read: { from, to }, label, short: label.replace(' – ', '–'), tiny: stack.join(''), stack, spoken, prev: addDays(date, -7), next: addDays(date, 7), upcoming: false, thisPeriod: today >= from && today <= to };
  }
  if (view === 'month') {
    const { from, to } = monthRange(month);
    const day = parts(date).d;
    return {
      view,
      date,
      from,
      to,
      read: { from, to },
      label: monthWords(month),
      short: monthShort(month),
      ...monthTiny(month),
      spoken: monthWords(month),
      prev: sameDayIn(shiftMonth(month, -1), day, today),
      next: sameDayIn(shiftMonth(month, 1), day, today),
      upcoming: false,
      thisPeriod: month === today.slice(0, 7),
    };
  }
  // The list: what is coming up, eight weeks from today across months, for today or any date in those
  // weeks. A past day of this month (the challenger: switching to List must keep your place) lists the
  // month from its first day through the same eight weeks, past events kept; back from the upcoming list
  // goes there. Any other date, its month. On is the day after the eight weeks, so no day is skipped.
  const end = addDays(today, COMING_UP_DAYS);
  const thisMonth = today.slice(0, 7);
  const first = `${thisMonth}-01`;
  const lastMonth = `${shiftMonth(thisMonth, -1)}-01`;
  if (date >= today && date <= end) {
    const t = parts(today);
    const label = monthShort(thisMonth);
    return { view, date, from: today, to: end, read: { from: today, to: end }, label, short: label, ...monthTiny(thisMonth), spoken: `upcoming, from ${t.d} ${MONTHS[t.m]} ${t.y}`, prev: today === first ? lastMonth : first, next: addDays(end, 1), upcoming: true, thisPeriod: true };
  }
  if (month === thisMonth) {
    const label = monthShort(thisMonth);
    return { view, date, from: first, to: end, read: { from: first, to: end }, label, short: label, ...monthTiny(thisMonth), spoken: `from 1 ${monthWords(thisMonth)}`, prev: lastMonth, next: addDays(end, 1), upcoming: false, thisPeriod: true };
  }
  const { from, to } = monthRange(month);
  const label = monthShort(month);
  return { view, date, from, to, read: { from, to }, label, short: label, ...monthTiny(month), spoken: monthWords(month), prev: `${shiftMonth(month, -1)}-01`, next: `${shiftMonth(month, 1)}-01`, upcoming: false, thisPeriod: false };
}

/** One day as a tile in the list's ribbon or the week's strip. */
export interface DayTile {
  date: string;
  weekday: string;
  day: number;
  month: string;
  /** In time order. */
  events: CalendarEvent[];
  today: boolean;
  selected: boolean;
}

const byTime = (a: CalendarEvent, b: CalendarEvent) => (a.start ?? '').localeCompare(b.start ?? '');

export function dayTile(date: string, events: readonly CalendarEvent[], today: string, selected: string): DayTile {
  const p = parts(date);
  return { date, weekday: DAYS[p.wd]!, day: p.d, month: MON[p.m]!, events: [...events].sort(byTime), today: date === today, selected: date === selected };
}

/** The list's ribbon (Ross): only the dates that have events, each once, in order, across months. */
export function ribbonDays(events: readonly CalendarEvent[], today: string, selected: string): DayTile[] {
  const dates = [...new Set(events.map((e) => e.date))].sort();
  return dates.map((date) => dayTile(date, events.filter((e) => e.date === date), today, selected));
}

/** The week's strip: all seven days from Sunday, empty ones included. */
export function weekDays(sunday: string, events: readonly CalendarEvent[], today: string, selected: string): DayTile[] {
  return Array.from({ length: 7 }, (_, i) => addDays(sunday, i)).map((date) => dayTile(date, events.filter((e) => e.date === date), today, selected));
}

/** What a day's tile or grid cell shows: two icons at most, then "+N". */
export interface DayIndicator {
  icons: { kind: EventKind; cancelled: boolean }[];
  more: number;
}

export const MAX_ICONS = 2;

export function dayIndicator(events: readonly CalendarEvent[]): DayIndicator {
  const sorted = [...events].sort(byTime);
  return { icons: sorted.slice(0, MAX_ICONS).map((e) => ({ kind: eventKind(e), cancelled: e.status === 'cancelled' })), more: Math.max(0, sorted.length - MAX_ICONS) };
}

const LONG_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

type LabelledDay = { date: string; today: boolean; events: readonly CalendarEvent[] };

/** A day in words, for its link: "Wednesday, 11 November, today, 2 events, 1 cancelled: Lunch or meal, Event". */
export function dayLabel(day: LabelledDay): string {
  const p = parts(day.date);
  return describeDay(`${LONG_DAYS[p.wd]}, ${p.d} ${MONTHS[p.m]}`, day);
}

/** A day tile in words, starting with the "Wed 11" it shows (WCAG 2.5.3): "Wed 11 November, 1 event: Lunch or meal". */
export function tileLabel(day: LabelledDay): string {
  const p = parts(day.date);
  return describeDay(`${DAYS[p.wd]} ${p.d} ${MONTHS[p.m]}`, day);
}

function describeDay(date: string, day: LabelledDay): string {
  const count = day.events.length;
  const cancelled = day.events.filter((e) => e.status === 'cancelled').length;
  const words = [date];
  if (day.today) words.push('today');
  words.push(count === 0 ? 'no events' : `${count} event${count === 1 ? '' : 's'}`);
  if (cancelled > 0) words.push(count === 1 ? 'cancelled' : `${cancelled} cancelled`);
  const kinds = [...new Set([...day.events].sort(byTime).map((e) => KIND_LABELS[eventKind(e)]))];
  return kinds.length > 0 ? `${words.join(', ')}: ${kinds.join(', ')}` : words.join(', ');
}

/** "Wed, Nov 11", as the concept's headings. */
export function shortDay(date: string): string {
  const p = parts(date);
  return `${DAYS[p.wd]}, ${MON[p.m]} ${p.d}`;
}

const compact = (date: string) => date.replaceAll('-', '');
const stamp = (date: string, time: string) => `${compact(date)}T${time.replace(':', '')}00`;

/**
 * One event, added to Google Calendar (action=TEMPLATE): works on an Android phone, where a calendar
 * cannot be subscribed to. Central wall-clock times with ctz; an event with no end ends as it starts
 * (no length is made up); one with no time is the whole day.
 */
export function googleEventUrl(event: CalendarEvent, origin: string): string {
  const dates =
    event.start === undefined ? `${compact(event.date)}/${compact(addDays(event.date, 1))}` : `${stamp(event.date, event.start)}/${event.end ? stamp(event.end.date, event.end.time) : stamp(event.date, event.start)}`;
  const q = new URLSearchParams({ action: 'TEMPLATE', text: event.title, dates, ctz: 'America/Chicago', details: eventDescription(event, origin), location: placeText(event) });
  return `https://calendar.google.com/calendar/render?${q}`;
}

/**
 * The published subscribe address carries ?v=N (fc CALFEED): bump it when the feed's format changes,
 * so a calendar app that kept a stale or empty first fetch subscribes afresh. The server ignores it.
 */
export const FEED_VERSION = 2;

export interface FeedLinks {
  /** https://…/calendar.ics?v=N: "Calendar address (for calendar apps)". */
  address: string;
  webcal: string;
  /** Google Calendar on a computer: subscribe by the webcal address. */
  google: string;
  /** Google Calendar's own From-URL page, for an Android phone in Desktop-site mode. */
  addByUrl: string;
}

/** @param webcal the feed as origin.ts's feedWebcal gives it, for the Host asked for */
export function feedLinks(webcal: string): FeedLinks {
  const versioned = `${webcal}?v=${FEED_VERSION}`;
  return { address: versioned.replace(/^webcal:/, 'https:'), webcal: versioned, google: googleCalendarUrl(versioned), addByUrl: 'https://calendar.google.com/calendar/r/settings/addbyurl' };
}

/** Where, on a card (the concept): the place, then the town on its own line; a member's home by its area only (R3). */
export function cardPlace(e: Pick<CalendarEvent, 'venue' | 'area'>): { place: string; town: string } {
  const venue = e.venue;
  if (venue === undefined) return { place: 'Place to be decided', town: e.area };
  if (venue.kind === 'virtual') return { place: `Online: ${venue.name}`, town: '' };
  return { place: venue.name, town: venue.kind === 'business' && venue.city ? venue.city : e.area };
}
