// ============================================================================
// Calendar dates and America/Chicago wall-clock times. All ten counties are
// Central, so the calendar is kept in local dates ("2026-10-09") and an event's
// instant is its local date and time in Chicago, whatever the DST rule is that
// day. Dates are ISO strings throughout; arithmetic runs on UTC midnights,
// which no time zone can shift.
// ============================================================================

export const ZONE = 'America/Chicago';
const DAY_MS = 86_400_000;

const parts = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function wallClock(instant: number): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  const get = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.formatToParts(instant).find((p) => p.type === type)?.value);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), mi: get('minute'), s: get('second') };
}

/** Milliseconds Chicago's wall clock is ahead of UTC at an instant (negative). */
function offsetAt(instant: number): number {
  const w = wallClock(instant);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(instant / 1000) * 1000;
}

/** The instant a Chicago wall-clock time names. A time skipped by spring-forward lands an hour later. */
export function zonedToUtc(date: string, hours: number, minutes: number): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const naive = Date.UTC(y, m - 1, d, hours, minutes);
  const first = naive - offsetAt(naive);
  const second = naive - offsetAt(first);
  const lands = wallClock(second);
  // In the spring-forward gap the second pass falls back across the change;
  // the first pass is then the time an hour later, the usual rule.
  return new Date(lands.h === hours && lands.mi === minutes ? second : first);
}

export function localDateOf(instant: Date): string {
  const w = wallClock(instant.getTime());
  return `${String(w.y).padStart(4, '0')}-${String(w.m).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`;
}

export function todayIn(now: Date = new Date()): string {
  return localDateOf(now);
}

export const toDays = (date: string): number => Date.parse(`${date}T00:00:00Z`) / DAY_MS;
export const fromDays = (days: number): string => new Date(days * DAY_MS).toISOString().slice(0, 10);

export function addDays(date: string, days: number): string {
  return fromDays(toDays(date) + days);
}

/** A proto Date as an ISO date. Throws on a date the calendar does not have. */
export function isoDate(date: { year: number; month: number; day: number }): string {
  const iso = `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
  const check = new Date(`${iso}T00:00:00Z`);
  if (date.year < 1 || Number.isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== iso) {
    throw new RangeError(`${iso} is not a calendar date`);
  }
  return iso;
}

/** An ISO date string as a proto Date. */
export function protoDate(iso: string): { year: number; month: number; day: number } {
  const [year, month, day] = iso.split('-').map(Number) as [number, number, number];
  return { year, month, day };
}
