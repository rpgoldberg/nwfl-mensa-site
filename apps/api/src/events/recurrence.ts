// ============================================================================
// The RRULE subset the group's calendar needs (RFC 5545, section 3.3.10):
//
//   FREQ=WEEKLY   [INTERVAL] [BYDAY=MO,TH]                  weekly lunch
//   FREQ=MONTHLY  [INTERVAL] [BYDAY=2FR | -1MO | TU] or [BYMONTHDAY=1,-1]
//   plus at most one of COUNT and UNTIL (a date, or a UTC date-time whose
//   date part is used).
//
// Periods are counted from the series' first date (its DTSTART), weeks
// starting on Monday. Every other part (BYSETPOS, BYMONTH, WKST, DAILY,
// YEARLY, ...) is refused with RecurrenceError rather than approximated: a
// calendar that silently shows the wrong Friday is worse than one that says
// the rule is not supported. Written here instead of pulled in as a
// dependency: the subset is small, and its tests pin every case the five
// known series use.
// ============================================================================
import { fromDays, toDays } from './zone.js';

export class RecurrenceError extends Error {
  override name = 'RecurrenceError';
}

export interface DayRule {
  /** 1..5 or -1..-5 within the month; null means every such weekday. */
  ordinal: number | null;
  /** 0 = Sunday ... 6 = Saturday. */
  weekday: number;
}

export interface Rule {
  freq: 'WEEKLY' | 'MONTHLY';
  interval: number;
  byDay: DayRule[];
  byMonthDay: number[];
  until: string | null;
  count: number | null;
}

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const SUPPORTED = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'COUNT', 'UNTIL']);
// Weeks and months are bounded so a bad rule cannot spin.
const MAX_PERIODS = 2_600;

function fail(message: string): never {
  throw new RecurrenceError(message);
}

function integer(text: string, min: number, max: number, part: string): number {
  if (!/^-?\d+$/.test(text)) fail(`${part} must be a whole number`);
  const value = Number(text);
  if (value < min || value > max) fail(`${part} out of range`);
  return value;
}

export function parseRule(text: string): Rule {
  const parts = new Map<string, string>();
  for (const piece of text.split(';')) {
    const match = /^([A-Z]+)=(.+)$/.exec(piece);
    if (!match) fail(`malformed part '${piece}'`);
    const [, name, value] = match as unknown as [string, string, string];
    if (!SUPPORTED.has(name)) fail(`unsupported part ${name}`);
    if (parts.has(name)) fail(`${name} given twice`);
    parts.set(name, value);
  }
  const freq = parts.get('FREQ');
  if (freq !== 'WEEKLY' && freq !== 'MONTHLY') fail(`unsupported FREQ ${freq ?? '(none)'}`);

  const byDay = (parts.get('BYDAY')?.split(',') ?? []).map((token): DayRule => {
    const match = /^(-?\d)?([A-Z]{2})$/.exec(token);
    const weekday = WEEKDAYS.indexOf(match?.[2] ?? '');
    if (!match || weekday === -1) fail(`malformed BYDAY '${token}'`);
    if (match[1] === undefined) return { ordinal: null, weekday };
    if (freq === 'WEEKLY') fail('BYDAY ordinals need FREQ=MONTHLY');
    const ordinal = integer(match[1], -5, 5, 'BYDAY ordinal');
    if (ordinal === 0) fail('BYDAY ordinal cannot be 0');
    return { ordinal, weekday };
  });
  const byMonthDay = (parts.get('BYMONTHDAY')?.split(',') ?? []).map((token) => {
    const day = integer(token, -31, 31, 'BYMONTHDAY');
    if (day === 0) fail('BYMONTHDAY cannot be 0');
    return day;
  });
  if (byMonthDay.length > 0 && freq === 'WEEKLY') fail('BYMONTHDAY needs FREQ=MONTHLY');
  if (byMonthDay.length > 0 && byDay.length > 0) fail('BYDAY with BYMONTHDAY is not supported');

  const untilText = parts.get('UNTIL');
  const until = untilText === undefined ? null : /^(\d{4})(\d{2})(\d{2})(T\d{6}Z)?$/.exec(untilText);
  if (until === null && untilText !== undefined) fail('UNTIL must be YYYYMMDD or YYYYMMDDTHHMMSSZ');
  const countText = parts.get('COUNT');
  if (countText !== undefined && untilText !== undefined) fail('COUNT and UNTIL cannot both be set');

  return {
    freq,
    interval: integer(parts.get('INTERVAL') ?? '1', 1, 52, 'INTERVAL'),
    byDay,
    byMonthDay,
    until: until ? `${until[1]}-${until[2]}-${until[3]}` : null,
    count: countText === undefined ? null : integer(countText, 1, 10_000, 'COUNT'),
  };
}

const weekdayOf = (days: number): number => (((days + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday
const mondayOf = (days: number): number => days - ((weekdayOf(days) + 6) % 7);

function monthDays(year: number, month: number): { first: number; length: number } {
  const first = Date.UTC(year, month, 1) / 86_400_000;
  return { first, length: Date.UTC(year, month + 1, 1) / 86_400_000 - first };
}

function datesInMonth(rule: Rule, year: number, month: number, anchorDay: number): number[] {
  const { first, length } = monthDays(year, month);
  const out: number[] = [];
  if (rule.byMonthDay.length > 0) {
    for (const day of rule.byMonthDay) {
      const index = day > 0 ? day - 1 : length + day;
      if (index >= 0 && index < length) out.push(first + index);
    }
  } else if (rule.byDay.length > 0) {
    for (const { ordinal, weekday } of rule.byDay) {
      const matching: number[] = [];
      for (let d = first; d < first + length; d += 1) if (weekdayOf(d) === weekday) matching.push(d);
      if (ordinal === null) out.push(...matching);
      else {
        const pick = ordinal > 0 ? matching[ordinal - 1] : matching[matching.length + ordinal];
        if (pick !== undefined) out.push(pick);
      }
    }
  } else if (anchorDay <= length) {
    out.push(first + anchorDay - 1);
  }
  return out;
}

/** The dates of a rule anchored on `startsOn`, within [from, to], ascending. */
export function expand(rule: Rule, startsOn: string, from: string, to: string): string[] {
  const anchor = toDays(startsOn);
  const lo = Math.max(toDays(from), anchor);
  const hi = Math.min(toDays(to), rule.until === null ? Infinity : toDays(rule.until));
  if (hi < lo) return [];
  const out: string[] = [];
  let produced = 0;
  const anchorDate = new Date(anchor * 86_400_000);
  for (let period = 0; period < MAX_PERIODS; period += rule.interval) {
    let candidates: number[];
    if (rule.freq === 'WEEKLY') {
      const monday = mondayOf(anchor) + period * 7;
      if (monday > hi) break;
      const days = rule.byDay.length > 0 ? rule.byDay.map((d) => d.weekday) : [weekdayOf(anchor)];
      candidates = days.map((weekday) => monday + ((weekday + 6) % 7));
    } else {
      const month = anchorDate.getUTCMonth() + period;
      const year = anchorDate.getUTCFullYear() + Math.floor(month / 12);
      if (monthDays(year, month % 12).first > hi) break;
      candidates = datesInMonth(rule, year, month % 12, anchorDate.getUTCDate());
    }
    for (const day of [...new Set(candidates)].sort((a, b) => a - b)) {
      if (day < anchor) continue;
      produced += 1;
      if (rule.count !== null && produced > rule.count) return out;
      if (day >= lo && day <= hi) out.push(fromDays(day));
    }
  }
  return out;
}
