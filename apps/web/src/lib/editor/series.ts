// SERIES-UI: the officers' recurring events. "Recurring events" on Our events (the series of this person's
// offices, every office's for the Admin), and the form to start, change or stop one, in plain choices:
//
//   Every week / every 2 weeks / every N weeks, on the days ticked   FREQ=WEEKLY[;INTERVAL=n];BYDAY=MO,TH
//   Once a month, on the first..fourth or last <weekday>            FREQ=MONTHLY;BYDAY=2FR | -1MO
//   Once a month, on day 1..31 (months without it are skipped)      FREQ=MONTHLY;BYMONTHDAY=15
//   Once a month, on the last day                                   FREQ=MONTHLY;BYMONTHDAY=-1
//   Ends never / after N dates / on a date                          [;COUNT=n | ;UNTIL=YYYYMMDD]
//
// The officer never sees the rule: the calendar's words for it (cadence_label) are made from the same
// choice. A rule the choices cannot show (an ExComm every other month) is kept as it is unless the officer
// chooses a new pattern. The next dates are shown from the same rules the API uses (./recurrence.ts, kept
// equal by its parity test). A date changed one by one (a stored override) stays on the calendar when the
// pattern changes; one the new pattern no longer has is named to the officer before the save, never lost.
// The API checks every step again (events/writes.ts saveSeries): this only decides what the pages offer.
import type { MessageInitShape } from '@bufbuild/protobuf';
import { formatDate } from '../../data/format';
import { Area, EventCategory, type EventOccurrence, type EventSeries, type EventSeriesSchema, EventVisibility, OccurrenceStatus } from '../../gen/nwfl/mensa/v1/event_pb.js';
import { DETAIL_MAX, EVENTS_PATH, type EventOffices, TITLE_MAX, VISIBILITY_CHOICES, type EventVisibilityName, editPathOf, isoDate, readTime } from './events';
import { RecurrenceError, expand, parseRule } from './recurrence';
import { Duplicate } from '../api/editor';
import { slugFromTitle } from './slug';

export const SERIES_PATH = `${EVENTS_PATH}/series`;
export const NEW_SERIES_PATH = `${SERIES_PATH}/new`;
export const seriesPathOf = (id: string): string => `${SERIES_PATH}/${id}`;
/** How many dates the form shows before a save. */
export const PREVIEW_DATES = 5;
/** How far ahead a change looks for dates changed one by one (the API reads at most 400 days at once). */
export const OVERRIDE_DAYS = 366;

const SERIES_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The series id in a page's path, or "new"; undefined for anything else (never sent). */
export function seriesIdFromParam(param: string): string | undefined {
  return param === 'new' || SERIES_ID.test(param) ? param : undefined;
}

export const DAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type DayCode = (typeof DAY_CODES)[number];
export const DAY_NAMES: Record<DayCode, string> = { MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday', SU: 'Sunday' };
/** recurrence.ts numbers the days from Sunday. */
const SUNDAY_FIRST: readonly DayCode[] = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

export const REPEAT_CHOICES = [
  { value: 'weekly', label: 'Every week' },
  { value: 'fortnightly', label: 'Every 2 weeks' },
  { value: 'every-n', label: 'Every few weeks' },
  { value: 'monthly', label: 'Once a month' },
] as const;
export const MONTHLY_CHOICES = [
  { value: 'weekday', label: 'On a day of the week, such as the second Friday' },
  { value: 'day', label: 'On a date, such as the 15th' },
  { value: 'last-day', label: 'On the last day of the month' },
] as const;
export const ORDINAL_CHOICES = [
  { value: '1', label: 'First' },
  { value: '2', label: 'Second' },
  { value: '3', label: 'Third' },
  { value: '4', label: 'Fourth' },
  { value: '-1', label: 'Last' },
] as const;
export const ENDS_CHOICES = [
  { value: 'never', label: 'It keeps going' },
  { value: 'count', label: 'After a number of dates' },
  { value: 'until', label: 'On a date' },
] as const;

export type KindName = 'lunch' | 'dinner' | 'happy_hour' | 'excomm' | 'picnic' | 'party' | 'regional' | 'national' | 'virtual' | 'other';
export const KIND_CHOICES: ReadonlyArray<{ value: KindName; label: string; category: EventCategory }> = [
  { value: 'lunch', label: 'Lunch', category: EventCategory.LUNCH },
  { value: 'dinner', label: 'Dinner', category: EventCategory.DINNER },
  { value: 'happy_hour', label: 'Happy hour', category: EventCategory.HAPPY_HOUR },
  { value: 'excomm', label: 'Board meeting (ExComm)', category: EventCategory.EXCOMM },
  { value: 'picnic', label: 'Picnic', category: EventCategory.PICNIC },
  { value: 'party', label: 'Party', category: EventCategory.PARTY },
  { value: 'regional', label: 'Regional gathering', category: EventCategory.REGIONAL },
  { value: 'national', label: 'National gathering', category: EventCategory.NATIONAL },
  { value: 'virtual', label: 'Online', category: EventCategory.VIRTUAL },
  { value: 'other', label: 'Something else', category: EventCategory.OTHER },
];

export type AreaName = 'okaloosa' | 'walton' | 'bay' | 'escambia_santa_rosa' | 'virtual' | 'elsewhere';
export const AREA_CHOICES: ReadonlyArray<{ value: AreaName; label: string; area: Area }> = [
  { value: 'okaloosa', label: 'Okaloosa County', area: Area.OKALOOSA },
  { value: 'walton', label: 'Walton County', area: Area.WALTON },
  { value: 'bay', label: 'Bay County', area: Area.BAY },
  { value: 'escambia_santa_rosa', label: 'Escambia and Santa Rosa Counties', area: Area.ESCAMBIA_SANTA_ROSA },
  { value: 'virtual', label: 'Online', area: Area.VIRTUAL },
  { value: 'elsewhere', label: 'Outside our area', area: Area.ELSEWHERE },
];

/** The form's fields as typed (or as read): handed back on a problem. Each day is its own box, day-MO and on. */
export interface SeriesValues {
  title: string;
  office: string;
  kind: string;
  repeat: string;
  everyN: string;
  days: string[];
  monthly: string;
  ordinal: string;
  weekday: string;
  monthDay: string;
  startsOn: string;
  time: string;
  length: string;
  venue: string;
  area: string;
  visibility: string;
  description: string;
  ends: string;
  count: string;
  until: string;
  overridesSeen: string;
}

export function blankSeriesValues(): SeriesValues {
  return {
    title: '',
    office: '',
    kind: '',
    repeat: '',
    everyN: '',
    days: [],
    monthly: '',
    ordinal: '',
    weekday: '',
    monthDay: '',
    startsOn: '',
    time: '',
    length: '',
    venue: '',
    area: '',
    visibility: 'public',
    description: '',
    ends: 'never',
    count: '',
    until: '',
    overridesSeen: '',
  };
}

export type Pattern =
  | { kind: 'weekly'; interval: number; days: DayCode[] }
  | { kind: 'monthly-weekday'; ordinal: number; weekday: DayCode }
  | { kind: 'monthly-day'; day: number }
  | { kind: 'monthly-last' }
  | { kind: 'keep'; rule: string; label: string };

/** A rule the choices cannot show, kept as it is: the rule less its ending, and the calendar's words for it. */
export interface KeptRule {
  rule: string;
  label: string;
}

/** A checked form, ready to save. */
export interface SeriesInput {
  title: string;
  /** A new series' office; empty for a change (a series keeps its office). */
  officeId: string;
  category: KindName;
  pattern: Pattern;
  rule: string;
  cadenceLabel: string;
  startsOn: string;
  /** HH:MM, Central. */
  time: string;
  minutes: number | null;
  /** Empty: decided later, or it changes from date to date. */
  venueId: string;
  area: AreaName;
  visibility: EventVisibilityName;
  description: string;
}

const list = (names: string[]): string => (names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}`);
const nth = (n: number): string => {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  return `${n}${teen ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
};

/** The calendar's words for a pattern: "Every other Tuesday", "Last Monday of the month". */
export function cadenceLabel(pattern: Pattern): string {
  switch (pattern.kind) {
    case 'weekly': {
      const days = list(pattern.days.map((d) => DAY_NAMES[d]));
      if (pattern.interval === 1) return `Every ${days}`;
      if (pattern.interval === 2) return `Every other ${days}`;
      return `Every ${pattern.interval} weeks on ${days}`;
    }
    case 'monthly-weekday':
      return `${ORDINAL_CHOICES.find((c) => c.value === String(pattern.ordinal))!.label} ${DAY_NAMES[pattern.weekday]} of the month`;
    case 'monthly-day':
      return `The ${nth(pattern.day)} of each month${pattern.day > 28 ? ' that has one' : ''}`;
    case 'monthly-last':
      return 'Last day of the month';
    case 'keep':
      return pattern.label === '' ? 'Repeats' : pattern.label;
  }
}

function patternRule(pattern: Pattern): string {
  switch (pattern.kind) {
    case 'weekly':
      return `FREQ=WEEKLY${pattern.interval === 1 ? '' : `;INTERVAL=${pattern.interval}`};BYDAY=${pattern.days.join(',')}`;
    case 'monthly-weekday':
      return `FREQ=MONTHLY;BYDAY=${pattern.ordinal}${pattern.weekday}`;
    case 'monthly-day':
      return `FREQ=MONTHLY;BYMONTHDAY=${pattern.day}`;
    case 'monthly-last':
      return 'FREQ=MONTHLY;BYMONTHDAY=-1';
    case 'keep':
      return pattern.rule;
  }
}

const whole = (text: string, min: number, max: number): number | undefined => {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return undefined;
  const n = Number(t);
  return n >= min && n <= max ? n : undefined;
};
const length = (text: string) => [...text].length;
const addDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** The next `n` dates of a rule from today (or from its first date, when later); none for a rule that cannot be read. */
export function nextDates(rule: string, startsOn: string, today: string, n: number = PREVIEW_DATES): string[] {
  const from = startsOn > today ? startsOn : today;
  try {
    // Every 52 weeks: five dates take five years.
    return expand(parseRule(rule), startsOn, from, addDays(from, 6 * 366)).slice(0, n);
  } catch (error) {
    if (error instanceof RecurrenceError) return [];
    throw error;
  }
}

export const SERIES_FIELD_ORDER = [
  'title',
  'office',
  'kind',
  'repeat',
  'everyN',
  'days',
  'monthly',
  'ordinal',
  'weekday',
  'monthDay',
  'startsOn',
  'time',
  'length',
  'venue',
  'area',
  'visibility',
  'description',
  'ends',
  'count',
  'until',
  'overrides',
] as const;
export type SeriesField = (typeof SERIES_FIELD_ORDER)[number];
export type SeriesErrors = Partial<Record<SeriesField, string[]>>;

const FIELD_NAMES: Record<SeriesField, string> = {
  title: 'Title',
  office: 'Whose event it is',
  kind: 'Kind of event',
  repeat: 'How often',
  everyN: 'Number of weeks',
  days: 'Days of the week',
  monthly: 'Which day of the month',
  ordinal: 'Which one in the month',
  weekday: 'Day of the week',
  monthDay: 'Date in the month',
  startsOn: 'First date',
  time: 'Start time',
  length: 'Length',
  venue: 'Where',
  area: 'Area',
  visibility: 'Who can see it',
  description: 'Description',
  ends: 'When it ends',
  count: 'Number of dates',
  until: 'Last date',
  overrides: 'Dates changed one by one',
};
/** A choice's link goes to its first button (src/components/SeriesForm.astro), which takes the focus. */
const FIELD_ANCHORS: Partial<Record<SeriesField, string>> = {
  office: 'office-0',
  kind: 'kind-lunch',
  repeat: 'repeat-weekly',
  days: 'day-MO',
  monthly: 'monthly-weekday',
  ordinal: 'ordinal-1',
  weekday: 'weekday-MO',
  venue: 'venue-later',
  area: 'area-okaloosa',
  visibility: 'visibility-public',
  ends: 'ends-never',
  overrides: 'overridesSeen',
};

/** The list at the top of the form: each problem, in the form's order, named by its field and linking to it. */
export function seriesProblemSummary(errors: SeriesErrors): Array<{ href: string; text: string }> {
  return SERIES_FIELD_ORDER.flatMap((field) => (errors[field] ?? []).map((text) => ({ href: `#${FIELD_ANCHORS[field] ?? field}`, text: `${FIELD_NAMES[field]}: ${text}` })));
}

type Field = (name: string) => string | undefined;

/** Every field as typed, an absent one empty: kept on the page when a save cannot be made. */
export function typedSeriesValues(field: Field): SeriesValues {
  const raw = (name: string) => field(name) ?? '';
  return {
    title: raw('title'),
    office: raw('office'),
    kind: raw('kind'),
    repeat: raw('repeat'),
    everyN: raw('everyN'),
    days: DAY_CODES.filter((d) => field(`day-${d}`) !== undefined),
    monthly: raw('monthly'),
    ordinal: raw('ordinal'),
    weekday: raw('weekday'),
    monthDay: raw('monthDay'),
    startsOn: raw('startsOn'),
    time: raw('time'),
    length: raw('length'),
    venue: raw('venue'),
    area: raw('area'),
    visibility: raw('visibility'),
    description: raw('description'),
    ends: raw('ends'),
    count: raw('count'),
    until: raw('until'),
    overridesSeen: raw('overridesSeen'),
  };
}

export interface SeriesFormContext {
  /** new: a new series (its first date today or later); change: an existing one (it keeps its office). */
  mode: 'new' | 'change';
  /** The offices a new series may be for. */
  offices: readonly { id: string }[];
  venues: readonly { id: string }[];
  today: string;
  /** A change's rule the choices cannot show, offered as "keep it as it is". */
  keep?: KeptRule;
}

export type ParsedSeries = { ok: true; value: SeriesInput } | { ok: false; errors: Partial<Record<SeriesField, string>>; values: SeriesValues };

/** The pattern chosen, or the problems with it. */
function readPattern(values: SeriesValues, keep: KeptRule | undefined, errors: Partial<Record<SeriesField, string>>): Pattern | undefined {
  if (values.repeat === 'keep' && keep !== undefined) return { kind: 'keep', rule: keep.rule, label: keep.label };
  if (values.repeat === 'weekly' || values.repeat === 'fortnightly' || values.repeat === 'every-n') {
    const interval = values.repeat === 'weekly' ? 1 : values.repeat === 'fortnightly' ? 2 : whole(values.everyN, 1, 52);
    if (interval === undefined) errors.everyN = 'Give the number of weeks, from 1 to 52.';
    const days = DAY_CODES.filter((d) => values.days.includes(d));
    if (days.length === 0) errors.days = 'Choose at least one day of the week.';
    return interval === undefined || days.length === 0 ? undefined : { kind: 'weekly', interval, days };
  }
  if (values.repeat === 'monthly') {
    if (values.monthly === 'weekday') {
      const ordinal = ORDINAL_CHOICES.find((c) => c.value === values.ordinal);
      const weekday = DAY_CODES.find((d) => d === values.weekday);
      if (ordinal === undefined) errors.ordinal = 'Choose first, second, third, fourth or last.';
      if (weekday === undefined) errors.weekday = 'Choose the day of the week.';
      return ordinal === undefined || weekday === undefined ? undefined : { kind: 'monthly-weekday', ordinal: Number(ordinal.value), weekday };
    }
    if (values.monthly === 'day') {
      const day = whole(values.monthDay, 1, 31);
      if (day === undefined) errors.monthDay = 'Give a day from 1 to 31.';
      return day === undefined ? undefined : { kind: 'monthly-day', day };
    }
    if (values.monthly === 'last-day') return { kind: 'monthly-last' };
    errors.monthly = 'Choose which day of the month.';
    return undefined;
  }
  errors.repeat = 'Choose how often it repeats.';
  return undefined;
}

/** The series form, read and checked; each problem in plain words, keyed by its field. */
export function parseSeriesForm(field: Field, context: SeriesFormContext): ParsedSeries {
  const values = typedSeriesValues(field);
  const errors: Partial<Record<SeriesField, string>> = {};

  const title = values.title.trim();
  if (title === '') errors.title = 'Give the event a title.';
  else if (length(title) > TITLE_MAX) errors.title = `The title is too long: at most ${TITLE_MAX} characters.`;

  let officeId = '';
  if (context.mode === 'new') {
    if (context.offices.length === 1) officeId = context.offices[0]!.id;
    else if (context.offices.some((o) => o.id === values.office)) officeId = values.office;
    else errors.office = 'Choose whose event it is.';
  }

  const kind = KIND_CHOICES.find((c) => c.value === values.kind)?.value;
  if (kind === undefined) errors.kind = 'Choose what kind of event it is.';

  const pattern = readPattern(values, context.keep, errors);

  const startsOn = values.startsOn.trim();
  if (startsOn === '') errors.startsOn = 'Give the first date.';
  else if (!isoDate(startsOn)) errors.startsOn = 'That is not a date. Write it as year-month-day, such as 2027-03-14.';
  else if (context.mode === 'new' && startsOn < context.today) errors.startsOn = 'That date has passed. Choose today or a later date.';

  const time = values.time.trim() === '' ? undefined : readTime(values.time);
  if (values.time.trim() === '') errors.time = 'Give the start time.';
  else if (time === undefined) errors.time = 'That is not a time. Write it as 11:30 am or 6:00 pm.';

  const minutes = values.length.trim() === '' ? null : whole(values.length, 1, 1440);
  if (minutes === undefined) errors.length = 'Give the length in minutes, from 1 to 1440, or leave it empty.';
  if (values.venue !== '' && !context.venues.some((v) => v.id === values.venue)) errors.venue = 'Choose a place from the list.';
  const area = AREA_CHOICES.find((c) => c.value === values.area)?.value;
  if (area === undefined) errors.area = 'Choose the area.';
  const visibility = VISIBILITY_CHOICES.find((c) => c.value === values.visibility)?.value;
  if (visibility === undefined) errors.visibility = 'Choose who can see it.';
  const description = values.description.replace(/\r\n?/g, '\n').trim();
  if (length(description) > DETAIL_MAX) errors.description = `The description is too long: at most ${DETAIL_MAX} characters.`;

  let ending = '';
  if (values.ends === 'count') {
    const count = whole(values.count, 1, 1000);
    if (count === undefined) errors.count = 'Give the number of dates, from 1 to 1000.';
    else ending = `;COUNT=${count}`;
  } else if (values.ends === 'until') {
    const until = values.until.trim();
    if (until === '') errors.until = 'Give the last date.';
    else if (!isoDate(until)) errors.until = 'That is not a date. Write it as year-month-day, such as 2027-03-14.';
    else if (errors.startsOn === undefined && until < startsOn) errors.until = 'The last date is before the first date.';
    else ending = `;UNTIL=${until.replaceAll('-', '')}`;
  } else if (values.ends !== 'never') errors.ends = 'Choose when it ends.';

  const rule = pattern === undefined ? '' : `${patternRule(pattern)}${ending}`;
  if (pattern !== undefined && Object.keys(errors).length === 0 && nextDates(rule, startsOn, startsOn, 1).length === 0) {
    errors.repeat = 'No date falls on this pattern before it ends. Choose another pattern or a later last date.';
  }

  if (Object.keys(errors).length > 0 || pattern === undefined || kind === undefined || time === undefined || minutes === undefined || area === undefined || visibility === undefined) {
    return { ok: false, errors, values };
  }
  return { ok: true, value: { title, officeId, category: kind, pattern, rule, cadenceLabel: cadenceLabel(pattern), startsOn, time, minutes, venueId: values.venue, area, visibility, description } };
}

const pad = (n: number) => String(n).padStart(2, '0');
const isoOf = (d: { year: number; month: number; day: number } | undefined): string => (d === undefined ? '' : `${d.year}-${pad(d.month)}-${pad(d.day)}`);
const ENDING = /;(COUNT|UNTIL)=[^;]*/;

/** The form filled from a series: its pattern as choices, or kept as it is when the choices cannot show it. */
export function valuesFromSeries(s: EventSeries): { values: SeriesValues; keep: KeptRule | undefined } {
  const startsOn = isoOf(s.startsOn);
  const values: SeriesValues = {
    ...blankSeriesValues(),
    title: s.title,
    kind: KIND_CHOICES.find((c) => c.category === s.category)?.value ?? '',
    startsOn,
    time: s.defaultStart === undefined ? '' : `${pad(s.defaultStart.hours)}:${pad(s.defaultStart.minutes)}`,
    length: s.defaultDurationMinutes > 0 ? String(s.defaultDurationMinutes) : '',
    venue: s.defaultVenueId,
    area: AREA_CHOICES.find((c) => c.area === s.area)?.value ?? '',
    visibility: s.visibility === EventVisibility.MEMBERS ? 'members' : 'public',
    description: s.description,
  };
  let rule;
  try {
    rule = parseRule(s.recurrence);
  } catch {
    return { values: { ...values, repeat: '' }, keep: undefined };
  }
  if (rule.count !== null) Object.assign(values, { ends: 'count', count: String(rule.count) });
  else if (rule.until !== null) Object.assign(values, { ends: 'until', until: rule.until });

  const anchor = startsOn === '' ? undefined : new Date(`${startsOn}T00:00:00Z`);
  const anchorDay = anchor === undefined ? undefined : SUNDAY_FIRST[anchor.getUTCDay()];
  if (rule.freq === 'WEEKLY') {
    const days = rule.byDay.length > 0 ? rule.byDay.map((d) => SUNDAY_FIRST[d.weekday]!) : anchorDay === undefined ? [] : [anchorDay];
    const repeat = rule.interval === 1 ? 'weekly' : rule.interval === 2 ? 'fortnightly' : 'every-n';
    return { values: { ...values, repeat, everyN: repeat === 'every-n' ? String(rule.interval) : '', days: DAY_CODES.filter((d) => days.includes(d)) }, keep: undefined };
  }
  const one = rule.byDay[0];
  if (rule.interval === 1 && rule.byDay.length === 1 && one !== undefined && one.ordinal !== null && (one.ordinal === -1 || one.ordinal <= 4)) {
    return { values: { ...values, repeat: 'monthly', monthly: 'weekday', ordinal: String(one.ordinal), weekday: SUNDAY_FIRST[one.weekday]! }, keep: undefined };
  }
  const day = rule.byMonthDay.length === 1 ? rule.byMonthDay[0]! : rule.byMonthDay.length === 0 && rule.byDay.length === 0 && anchor !== undefined ? anchor.getUTCDate() : 0;
  if (rule.interval === 1 && day === -1) return { values: { ...values, repeat: 'monthly', monthly: 'last-day' }, keep: undefined };
  if (rule.interval === 1 && day > 0) return { values: { ...values, repeat: 'monthly', monthly: 'day', monthDay: String(day) }, keep: undefined };
  return { values: { ...values, repeat: 'keep' }, keep: { rule: s.recurrence.replace(ENDING, ''), label: s.cadenceLabel } };
}

/** The API's check on event_series.slug: ^[a-z0-9][a-z0-9-]{0,60}$. */
const SLUG_MAX = 61;
const trimDashes = (text: string) => text.replace(/^-+|-+$/g, '');

/** The `n`th slug to try for a new series: from its title, then -2, -3, cut so it fits. Officers never see it. */
export function seriesSlug(title: string, n: number): string {
  const fromTitle = slugFromTitle(title);
  const base = fromTitle === 'item' ? 'event' : fromTitle;
  const suffix = n <= 1 ? '' : `-${n}`;
  return `${trimDashes(base.slice(0, SLUG_MAX - suffix.length))}${suffix}`;
}

/** How many slugs a new series is tried with before giving up. */
export const SERIES_SLUG_TRIES = 20;

/** Saves a new series with its title's slug, then the next while the API says it is taken (ALREADY_EXISTS). */
export async function saveWithSeriesSlug<T>(title: string, save: (slug: string) => Promise<T>, tries = SERIES_SLUG_TRIES): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await save(seriesSlug(title, n));
    } catch (error) {
      if (!(error instanceof Duplicate) || n >= tries) throw error;
    }
  }
}

export type SeriesRequest = MessageInitShape<typeof EventSeriesSchema>;

/** What SaveSeries is sent: the series by its id (empty for a new one), with its slug and host office. */
export function seriesRequest(input: SeriesInput, keep: { id?: string; slug: string; hostOfficeId: string }): SeriesRequest {
  const [y, m, d] = input.startsOn.split('-').map(Number) as [number, number, number];
  const [hours, minutes] = input.time.split(':').map(Number) as [number, number];
  return {
    id: keep.id ?? '',
    slug: keep.slug,
    title: input.title,
    category: KIND_CHOICES.find((c) => c.value === input.category)!.category,
    recurrence: input.rule,
    cadenceLabel: input.cadenceLabel,
    startsOn: { year: y, month: m, day: d },
    defaultStart: { hours, minutes },
    defaultDurationMinutes: input.minutes ?? 0,
    defaultVenueId: input.venueId,
    area: AREA_CHOICES.find((c) => c.value === input.area)!.area,
    hostOfficeId: keep.hostOfficeId,
    description: input.description,
    visibility: input.visibility === 'members' ? EventVisibility.MEMBERS : EventVisibility.PUBLIC,
  };
}

const STATUS_WORDS: Partial<Record<OccurrenceStatus, string>> = {
  [OccurrenceStatus.SCHEDULED]: 'Scheduled',
  [OccurrenceStatus.TENTATIVE]: 'Tentative',
  [OccurrenceStatus.CANCELLED]: 'Cancelled',
  [OccurrenceStatus.MOVED]: 'Moved',
};

/** A date of a series changed one by one, which a new pattern no longer has. */
export interface DroppedOverride {
  date: string;
  heading: string;
  /** Its status in words, with its note. */
  status: string;
  editPath: string;
}

const onRule = (rule: { rule: string; startsOn: string }, date: string): boolean | undefined => {
  try {
    return expand(parseRule(rule.rule), rule.startsOn, date, date).length > 0;
  } catch (error) {
    if (error instanceof RecurrenceError) return undefined;
    throw error;
  }
};

/**
 * The dates of this series changed one by one (stored, with an id of their own) that were on the old
 * pattern and are not on the new one. They stay on the calendar as they are (the API keeps every stored
 * date, ListOccurrences shows it), so the officer is told which, before saving. One whose old pattern
 * cannot be read is named too; none is named for a new rule that cannot be read (the save is refused).
 */
export function droppedOverrides(occurrences: readonly EventOccurrence[], seriesId: string, before: { rule: string; startsOn: string }, after: { rule: string; startsOn: string }): DroppedOverride[] {
  return occurrences.flatMap((o) => {
    if (o.seriesId !== seriesId || o.id.includes(':') || o.localDate === undefined) return [];
    const date = isoOf(o.localDate);
    if (onRule(before, date) === false || onRule(after, date) !== false) return [];
    const words = STATUS_WORDS[o.status] ?? 'Changed';
    return [{ date, heading: formatDate(date), status: o.statusNote === '' ? words : `${words}: ${o.statusNote}`, editPath: editPathOf(o.id) }];
  });
}

/** One line of "Recurring events". */
export interface OurSeries {
  id: string;
  title: string;
  cadence: string;
  /** The next date not cancelled, in words. */
  next: string;
  office: string;
  changePath: string;
}

/** The series this person may change (their offices'; every one for the Admin), in title order. */
export function ourSeries(series: readonly EventSeries[], occurrences: readonly EventOccurrence[], who: EventOffices): OurSeries[] {
  const names = new Map(who.offices.map((o) => [o.id, o.title]));
  return series
    .filter((s) => who.admin || names.has(s.hostOfficeId))
    .map((s) => {
      const next = occurrences.find((o) => (o.seriesId === s.id || o.id.startsWith(`${s.id}:`)) && o.status !== OccurrenceStatus.CANCELLED && o.localDate !== undefined);
      let cadence = s.cadenceLabel;
      if (cadence === '') {
        const { values } = valuesFromSeries(s);
        const parsed = values.repeat === '' || values.repeat === 'keep' ? undefined : readPattern(values, undefined, {});
        cadence = parsed === undefined ? 'Repeats' : cadenceLabel(parsed);
      }
      return {
        id: s.id,
        title: s.title,
        cadence,
        next: next === undefined ? 'None in the next 90 days' : formatDate(isoOf(next.localDate)),
        office: names.get(s.hostOfficeId) ?? 'Another office',
        changePath: seriesPathOf(s.id),
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}
