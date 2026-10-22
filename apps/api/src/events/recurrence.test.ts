// The RRULE subset the group's calendar needs (R3): weekly on given days, and
// monthly on the nth weekday or a month day, with INTERVAL, COUNT and UNTIL,
// anchored on the series' first date. Anything else is refused, never guessed.
import { describe, expect, it } from 'vitest';
import { RecurrenceError, expand, parseRule } from './recurrence.js';

const dates = (rule: string, startsOn: string, from: string, to: string): string[] => expand(parseRule(rule), startsOn, from, to);

describe('parseRule', () => {
  it.each([
    'FREQ=DAILY',
    'FREQ=YEARLY',
    'FREQ=MONTHLY;BYSETPOS=2;BYDAY=FR',
    'FREQ=WEEKLY;WKST=SU;BYDAY=WE',
    'FREQ=WEEKLY;BYDAY=2WE',
    'FREQ=WEEKLY;BYMONTHDAY=3',
    'FREQ=MONTHLY;BYDAY=0FR',
    'FREQ=MONTHLY;BYDAY=6FR',
    'FREQ=MONTHLY;BYDAY=XX',
    'FREQ=MONTHLY;BYMONTHDAY=32',
    'FREQ=MONTHLY;BYMONTHDAY=0',
    'FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13',
    'FREQ=MONTHLY;INTERVAL=0',
    'FREQ=MONTHLY;INTERVAL=x',
    'FREQ=MONTHLY;COUNT=0',
    'FREQ=MONTHLY;COUNT=3;UNTIL=20270101',
    'FREQ=MONTHLY;UNTIL=2027-01-01',
    'FREQ=MONTHLY;FREQ=WEEKLY',
    'BYDAY=FR',
    'FREQ=MONTHLY;BYDAY=',
    'freq=monthly',
    '',
  ])('refuses %j', (rule) => {
    expect(() => parseRule(rule)).toThrow(RecurrenceError);
  });

  it('reads the parts it supports', () => {
    expect(parseRule('FREQ=MONTHLY;INTERVAL=2;BYDAY=2FR,-1MO;UNTIL=20271231')).toEqual({
      freq: 'MONTHLY',
      interval: 2,
      byDay: [
        { ordinal: 2, weekday: 5 },
        { ordinal: -1, weekday: 1 },
      ],
      byMonthDay: [],
      until: '2027-12-31',
      count: null,
    });
    expect(parseRule('FREQ=WEEKLY;BYDAY=WE;UNTIL=20270101T050000Z').until).toBe('2027-01-01');
  });
});

describe('expand', () => {
  it('weekly lunch: every Wednesday', () => {
    expect(dates('FREQ=WEEKLY;BYDAY=WE', '2026-01-07', '2026-10-01', '2026-10-31')).toEqual([
      '2026-10-07',
      '2026-10-14',
      '2026-10-21',
      '2026-10-28',
    ]);
  });

  it('happy hour: the second Friday of each month', () => {
    expect(dates('FREQ=MONTHLY;BYDAY=2FR', '2026-01-01', '2026-10-01', '2027-01-31')).toEqual([
      '2026-10-09',
      '2026-11-13',
      '2026-12-11',
      '2027-01-08',
    ]);
  });

  it('Panama City lunch and Pensacola dinner: the first Saturday and the third Friday', () => {
    expect(dates('FREQ=MONTHLY;BYDAY=1SA', '2026-01-01', '2026-11-01', '2026-12-31')).toEqual(['2026-11-07', '2026-12-05']);
    expect(dates('FREQ=MONTHLY;BYDAY=3FR', '2026-01-01', '2026-11-01', '2026-12-31')).toEqual(['2026-11-20', '2026-12-18']);
  });

  it('ExComm: every other month, counted from the first meeting', () => {
    expect(dates('FREQ=MONTHLY;INTERVAL=2;BYDAY=4SA', '2026-09-26', '2026-09-01', '2027-03-31')).toEqual([
      '2026-09-26',
      '2026-11-28',
      '2027-01-23',
      '2027-03-27',
    ]);
  });

  it('last weekday of the month, month days counted from either end, and every matching weekday', () => {
    expect(dates('FREQ=MONTHLY;BYDAY=-1MO', '2026-01-01', '2026-02-01', '2026-03-31')).toEqual(['2026-02-23', '2026-03-30']);
    expect(dates('FREQ=MONTHLY;BYMONTHDAY=1,-1', '2026-01-01', '2026-02-01', '2026-02-28')).toEqual(['2026-02-01', '2026-02-28']);
    expect(dates('FREQ=MONTHLY;BYDAY=TU', '2026-01-01', '2026-03-01', '2026-03-31')).toEqual(['2026-03-03', '2026-03-10', '2026-03-17', '2026-03-24', '2026-03-31']);
    expect(dates('FREQ=MONTHLY;BYDAY=5FR', '2026-01-01', '2026-01-01', '2026-03-31')).toEqual(['2026-01-30']);
  });

  it('defaults to the anchor weekday or month day, and skips months without that day', () => {
    expect(dates('FREQ=WEEKLY', '2026-10-07', '2026-10-01', '2026-10-20')).toEqual(['2026-10-07', '2026-10-14']);
    expect(dates('FREQ=MONTHLY', '2026-01-31', '2026-01-01', '2026-04-30')).toEqual(['2026-01-31', '2026-03-31']);
  });

  it('weekly with an interval and several days, never before the anchor', () => {
    expect(dates('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH', '2026-10-08', '2026-10-01', '2026-10-31')).toEqual([
      '2026-10-08',
      '2026-10-19',
      '2026-10-22',
    ]);
  });

  it('stops at UNTIL, inclusive, and after COUNT occurrences counted from the anchor', () => {
    expect(dates('FREQ=WEEKLY;BYDAY=WE;UNTIL=20261014', '2026-10-01', '2026-10-01', '2026-12-31')).toEqual(['2026-10-07', '2026-10-14']);
    expect(dates('FREQ=MONTHLY;BYDAY=2FR;COUNT=3', '2026-08-01', '2026-10-01', '2027-12-31')).toEqual(['2026-10-09']);
  });

  it('returns nothing for a range before the anchor or an empty range', () => {
    expect(dates('FREQ=WEEKLY;BYDAY=WE', '2027-01-01', '2026-10-01', '2026-10-31')).toEqual([]);
    expect(dates('FREQ=WEEKLY;BYDAY=WE', '2026-01-01', '2026-10-31', '2026-10-01')).toEqual([]);
  });
});
