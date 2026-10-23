import { describe, expect, it } from 'vitest';
import { type IcsEvent, calendarFile, escapeText, foldLine } from './ics';

const NOW = new Date('2026-10-23T14:05:09Z');

const lunch: IcsEvent = {
  uid: '0b9c1f5e-4c1a-4d55-9a3e-2f7d8e6a1b20:2026-11-04@nwflorida.us',
  start: { date: '2026-11-04', time: '11:30' },
  end: { date: '2026-11-04', time: '13:00' },
  summary: 'Wednesday Lunchers',
  location: 'Sample Bistro, 100 Example Way, Destin',
  description: 'We sit at the long table at the back.',
  url: 'https://nwflorida.us/calendar/event/0b9c1f5e-4c1a-4d55-9a3e-2f7d8e6a1b20_2026-11-04',
  status: 'CONFIRMED',
};

/** RFC 5545 3.1: a folded line is joined again by removing each CRLF and the one space after it. */
const unfold = (text: string) => text.replace(/\r\n /g, '');
const linesOf = (text: string) => unfold(text).split('\r\n').slice(0, -1);

describe('calendarFile (RFC 5545)', () => {
  it('ends every line with CRLF, the last one too, and has no bare LF or CR', () => {
    const text = calendarFile([lunch], { now: NOW, name: 'Northwest Florida Mensa' });
    expect(text.endsWith('\r\n')).toBe(true);
    expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  });

  it('is one VCALENDAR, version 2.0, with a product id, holding the America/Chicago VTIMEZONE and each event', () => {
    const lines = linesOf(calendarFile([lunch, { ...lunch, uid: 'second@nwflorida.us' }], { now: NOW, name: 'Northwest Florida Mensa' }));
    expect(lines[0]).toBe('BEGIN:VCALENDAR');
    expect(lines.at(-1)).toBe('END:VCALENDAR');
    expect(lines).toContain('VERSION:2.0');
    expect(lines.find((l) => l.startsWith('PRODID:'))).toBe('PRODID:-//Northwest Florida Mensa//nwflorida.us//EN');
    expect(lines).toContain('CALSCALE:GREGORIAN');
    expect(lines).toContain('METHOD:PUBLISH');
    expect(lines).toContain('X-WR-CALNAME:Northwest Florida Mensa');
    expect(lines).toContain('X-WR-TIMEZONE:America/Chicago');
    expect(lines.filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(2);
    expect(lines.filter((l) => l === 'END:VEVENT')).toHaveLength(2);
    // Every BEGIN has its END, properly nested.
    const stack: string[] = [];
    for (const line of lines) {
      if (line.startsWith('BEGIN:')) stack.push(line.slice(6));
      if (line.startsWith('END:')) expect(stack.pop(), line).toBe(line.slice(4));
    }
    expect(stack).toEqual([]);
  });

  it('defines America/Chicago once, with the US rules: CDT from the second Sunday of March, CST from the first Sunday of November', () => {
    const text = unfold(calendarFile([lunch], { now: NOW, name: 'x' }));
    const tz = text.slice(text.indexOf('BEGIN:VTIMEZONE'), text.indexOf('END:VTIMEZONE'));
    expect(text.match(/BEGIN:VTIMEZONE/g)).toHaveLength(1);
    expect(tz).toContain('TZID:America/Chicago\r\n');
    const daylight = tz.slice(tz.indexOf('BEGIN:DAYLIGHT'), tz.indexOf('END:DAYLIGHT'));
    expect(daylight).toContain('TZOFFSETFROM:-0600\r\n');
    expect(daylight).toContain('TZOFFSETTO:-0500\r\n');
    expect(daylight).toContain('TZNAME:CDT\r\n');
    expect(daylight).toContain('DTSTART:20070311T020000\r\n');
    expect(daylight).toContain('RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU\r\n');
    const standard = tz.slice(tz.indexOf('BEGIN:STANDARD'), tz.indexOf('END:STANDARD'));
    expect(standard).toContain('TZOFFSETFROM:-0500\r\n');
    expect(standard).toContain('TZOFFSETTO:-0600\r\n');
    expect(standard).toContain('TZNAME:CST\r\n');
    expect(standard).toContain('DTSTART:20071104T020000\r\n');
    expect(standard).toContain('RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU\r\n');
  });

  it('gives each event its UID, a UTC DTSTAMP, Central start and end with the TZID, and the rest', () => {
    const lines = linesOf(calendarFile([lunch], { now: NOW, name: 'x' }));
    const event = lines.slice(lines.indexOf('BEGIN:VEVENT'), lines.indexOf('END:VEVENT'));
    expect(event).toEqual([
      'BEGIN:VEVENT',
      'UID:0b9c1f5e-4c1a-4d55-9a3e-2f7d8e6a1b20:2026-11-04@nwflorida.us',
      'DTSTAMP:20261023T140509Z',
      'DTSTART;TZID=America/Chicago:20261104T113000',
      'DTEND;TZID=America/Chicago:20261104T130000',
      'SUMMARY:Wednesday Lunchers',
      'LOCATION:Sample Bistro\\, 100 Example Way\\, Destin',
      'DESCRIPTION:We sit at the long table at the back.',
      'URL:https://nwflorida.us/calendar/event/0b9c1f5e-4c1a-4d55-9a3e-2f7d8e6a1b20_2026-11-04',
      'STATUS:CONFIRMED',
    ]);
  });

  it('writes an event with no time yet as an all-day date, ending the next day', () => {
    const lines = linesOf(calendarFile([{ uid: 'a@nwflorida.us', start: { date: '2026-12-31' }, summary: 'Picnic', status: 'TENTATIVE' }], { now: NOW, name: 'x' }));
    expect(lines).toContain('DTSTART;VALUE=DATE:20261231');
    expect(lines).toContain('DTEND;VALUE=DATE:20270101');
    expect(lines).toContain('STATUS:TENTATIVE');
    expect(lines.some((l) => /^(LOCATION|DESCRIPTION|URL)[:;]/.test(l))).toBe(false);
  });

  it('leaves DTEND out when only the start is known, rather than invent an end', () => {
    const lines = linesOf(calendarFile([{ ...lunch, end: undefined }], { now: NOW, name: 'x' }));
    expect(lines).toContain('DTSTART;TZID=America/Chicago:20261104T113000');
    expect(lines.some((l) => l.startsWith('DTEND'))).toBe(false);
  });

  it('marks a cancelled event CANCELLED, and says so in its summary for calendars that show it anyway', () => {
    const lines = linesOf(calendarFile([{ ...lunch, status: 'CANCELLED' }], { now: NOW, name: 'x' }));
    expect(lines).toContain('STATUS:CANCELLED');
    expect(lines).toContain('SUMMARY:Cancelled: Wednesday Lunchers');
  });

  it('is a valid empty calendar with no events', () => {
    const lines = linesOf(calendarFile([], { now: NOW, name: 'x' }));
    expect(lines[0]).toBe('BEGIN:VCALENDAR');
    expect(lines).not.toContain('BEGIN:VEVENT');
    expect(lines.at(-1)).toBe('END:VCALENDAR');
  });

  it('never writes a URL that is not https, nor one that could break a line', () => {
    for (const url of ['javascript:alert(1)', 'http://example.org/', 'https://example.org/\r\nX-EVIL:1', 'not a url']) {
      const text = calendarFile([{ ...lunch, url }], { now: NOW, name: 'x' });
      expect(unfold(text), url).not.toMatch(/^URL[:;]/m);
      expect(text).not.toContain('X-EVIL');
    }
  });

  it('keeps a typed line break or field separator inside its text value', () => {
    const lines = linesOf(calendarFile([{ ...lunch, summary: 'Lunch\r\nSTATUS:CANCELLED', description: 'a;b,c\\d\ne' }], { now: NOW, name: 'x' }));
    expect(lines).toContain('SUMMARY:Lunch\\nSTATUS:CANCELLED');
    expect(lines).toContain('DESCRIPTION:a\\;b\\,c\\\\d\\ne');
    expect(lines.filter((l) => l.startsWith('STATUS:'))).toEqual(['STATUS:CONFIRMED']);
  });
});

describe('escapeText (RFC 5545 3.3.11)', () => {
  it('escapes backslash, semicolon, comma and line breaks, and leaves a colon alone', () => {
    expect(escapeText('a\\b;c,d:e')).toBe('a\\\\b\\;c\\,d:e');
    expect(escapeText('one\r\ntwo\nthree\rfour')).toBe('one\\ntwo\\nthree\\nfour');
  });

  it('drops other control characters, keeping tabs', () => {
    expect(escapeText('a\u0000b\u0007c\u007fd\te')).toBe('abcd\te');
  });
});

describe('foldLine (RFC 5545 3.1)', () => {
  const octets = (s: string) => Buffer.byteLength(s, 'utf8');

  it('leaves a line of 75 octets alone', () => {
    const line = `SUMMARY:${'x'.repeat(67)}`;
    expect(octets(line)).toBe(75);
    expect(foldLine(line)).toBe(line);
  });

  it('folds longer lines at 75 octets, each continuation starting with one space, and unfolds to the same text', () => {
    const line = `DESCRIPTION:${'abcdefghij'.repeat(30)}`;
    const folded = foldLine(line);
    const parts = folded.split('\r\n');
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(octets(part)).toBeLessThanOrEqual(75);
    for (const part of parts.slice(1)) expect(part.startsWith(' ')).toBe(true);
    expect(octets(parts[0]!)).toBe(75);
    expect(unfold(folded)).toBe(line);
  });

  it('never splits a character that takes several octets', () => {
    const line = `SUMMARY:${'Café ’ 🎉 '.repeat(20)}`;
    const folded = foldLine(line);
    for (const part of folded.split('\r\n')) {
      expect(octets(part)).toBeLessThanOrEqual(75);
      expect(part).not.toContain('�');
      // Each part is whole UTF-8 on its own: re-encoding changes nothing.
      expect(Buffer.from(part, 'utf8').toString('utf8')).toBe(part);
      expect(part).not.toMatch(/[\uD800-\uDBFF]$/);
    }
    expect(unfold(folded)).toBe(line);
  });

  it('folds every long line in a whole file', () => {
    const text = calendarFile([{ ...lunch, description: 'é'.repeat(200), summary: 'S'.repeat(300) }], { now: NOW, name: 'x' });
    for (const line of text.split('\r\n')) expect(octets(line)).toBeLessThanOrEqual(75);
    expect(linesOf(text)).toContain(`SUMMARY:${'S'.repeat(300)}`);
  });
});
