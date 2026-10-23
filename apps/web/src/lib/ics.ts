// The calendar as an iCalendar file (RFC 5545), for /calendar.ics (the
// whole-calendar subscription, R4) and one event's .ics. Times are written as
// Central wall-clock times with TZID=America/Chicago, and the file carries
// that zone's definition, so a calendar app shows 11:30 as 11:30 wherever the
// reader's phone thinks it is. Lines end in CRLF and are folded at 75 octets.

export type IcsStatus = 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED';

/** A Central date (YYYY-MM-DD), and its wall-clock time (HH:MM) when known. */
export interface IcsTime {
  date: string;
  time?: string | undefined;
}

export interface IcsEvent {
  /** Stable and unique, so an app updates an event instead of adding it twice. */
  uid: string;
  start: IcsTime;
  end?: IcsTime | undefined;
  summary: string;
  location?: string | undefined;
  description?: string | undefined;
  /** https only; anything else is left out. */
  url?: string | undefined;
  status: IcsStatus;
}

export const TZID = 'America/Chicago';
const CRLF = '\r\n';
const MAX_OCTETS = 75;

// The US rules since 2007, the only ones a listed event can fall under.
const VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  `TZID:${TZID}`,
  `X-LIC-LOCATION:${TZID}`,
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:-0600',
  'TZOFFSETTO:-0500',
  'TZNAME:CDT',
  'DTSTART:20070311T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:-0500',
  'TZOFFSETTO:-0600',
  'TZNAME:CST',
  'DTSTART:20071104T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
];

/** A TEXT value (3.3.11): backslash, semicolon, comma and line breaks escaped; other control characters dropped. */
export function escapeText(text: string): string {
  return text
    .replace(/\r\n|\r|\n/g, '\n')
    // Control characters other than tab and the line feed kept above.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/[\\;,]/g, (c) => `\\${c}`)
    .replace(/\n/g, '\\n');
}

/** One content line, folded (3.1): at most 75 octets a line, never inside a character. */
export function foldLine(line: string): string {
  const parts: string[] = [];
  let current = '';
  let octets = 0;
  for (const char of line) {
    const size = Buffer.byteLength(char, 'utf8');
    if (octets + size > MAX_OCTETS) {
      parts.push(current);
      // A continuation line starts with one space, which counts.
      current = ' ';
      octets = 1;
    }
    current += char;
    octets += size;
  }
  parts.push(current);
  return parts.join(CRLF);
}

const compactDate = (date: string) => date.replaceAll('-', '');

function nextDay(date: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}

function dateTime(name: 'DTSTART' | 'DTEND', at: IcsTime): string {
  if (at.time === undefined) return `${name};VALUE=DATE:${compactDate(at.date)}`;
  return `${name};TZID=${TZID}:${compactDate(at.date)}T${at.time.replace(':', '')}00`;
}

function utcStamp(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

/** An https URL, as a URI value; undefined for anything else. */
function httpsUrl(url: string | undefined): string | undefined {
  if (url === undefined || /[\s"<>\\^`{|}]/.test(url)) return undefined;
  try {
    return new URL(url).protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

function eventLines(event: IcsEvent, stamp: string): string[] {
  const lines = ['BEGIN:VEVENT', `UID:${escapeText(event.uid)}`, `DTSTAMP:${stamp}`, dateTime('DTSTART', event.start)];
  if (event.start.time === undefined) lines.push(`DTEND;VALUE=DATE:${compactDate(nextDay(event.start.date))}`);
  else if (event.end !== undefined) lines.push(dateTime('DTEND', event.end));
  lines.push(`SUMMARY:${escapeText(event.status === 'CANCELLED' ? `Cancelled: ${event.summary}` : event.summary)}`);
  if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
  if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
  const url = httpsUrl(event.url);
  if (url !== undefined) lines.push(`URL:${url}`);
  lines.push(`STATUS:${event.status}`, 'END:VEVENT');
  return lines;
}

/** The whole file: one VCALENDAR with the zone and each event. */
export function calendarFile(events: readonly IcsEvent[], { now, name }: { now: Date; name: string }): string {
  const stamp = utcStamp(now);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Northwest Florida Mensa//nwflorida.us//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(name)}`,
    `X-WR-TIMEZONE:${TZID}`,
    ...VTIMEZONE,
    ...events.flatMap((event) => eventLines(event, stamp)),
    'END:VCALENDAR',
  ];
  return lines.map(foldLine).join(CRLF) + CRLF;
}
