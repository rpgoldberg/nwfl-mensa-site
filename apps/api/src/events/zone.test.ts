// Wall-clock times in America/Chicago (all ten counties are Central), across
// both daylight-saving changes.
import { describe, expect, it } from 'vitest';
import { addDays, isoDate, localDateOf, todayIn, zonedToUtc } from './zone.js';

describe('zonedToUtc', () => {
  it.each([
    ['2026-01-14', 11, 30, '2026-01-14T17:30:00.000Z'],
    ['2026-07-15', 11, 30, '2026-07-15T16:30:00.000Z'],
    ['2026-03-08', 11, 30, '2026-03-08T16:30:00.000Z'],
    ['2026-11-01', 11, 30, '2026-11-01T17:30:00.000Z'],
    ['2026-12-31', 23, 0, '2027-01-01T05:00:00.000Z'],
    ['2026-03-08', 2, 30, '2026-03-08T08:30:00.000Z'],
  ])('%s %i:%i Central is %s', (date, hours, minutes, expected) => {
    expect(zonedToUtc(date, hours, minutes).toISOString()).toBe(expected);
  });
});

describe('localDateOf and todayIn', () => {
  it('gives the Central date of an instant', () => {
    expect(localDateOf(new Date('2026-10-23T03:00:00Z'))).toBe('2026-10-22');
    expect(localDateOf(new Date('2026-10-23T06:00:00Z'))).toBe('2026-10-23');
    expect(todayIn(new Date('2026-10-23T03:00:00Z'))).toBe('2026-10-22');
  });
});

describe('date arithmetic', () => {
  it('adds days across months and years, and formats proto dates', () => {
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(isoDate({ year: 2026, month: 2, day: 28 })).toBe('2026-02-28');
  });

  it('refuses a date that does not exist', () => {
    expect(() => isoDate({ year: 2026, month: 2, day: 30 })).toThrow(/not a calendar date/);
    expect(() => isoDate({ year: 2026, month: 13, day: 1 })).toThrow(/not a calendar date/);
    expect(() => isoDate({ year: 0, month: 1, day: 1 })).toThrow(/not a calendar date/);
  });
});
