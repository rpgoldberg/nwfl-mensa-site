// SERIES-UI: the web's copy of the API's RRULE subset (apps/api/src/events/recurrence.ts), for the series
// form's preview with no script. No drift: every rule and date below is run through both, and the two must
// agree date for date, refusal for refusal. A change to either file that the other lacks fails here.
import { describe, expect, it } from 'vitest';
import * as api from '../../../../api/src/events/recurrence';
import * as web from './recurrence';

type Outcome = { dates: string[] } | { refused: true };
const run = (engine: typeof api | typeof web, rule: string, startsOn: string, from: string, to: string): Outcome => {
  try {
    return { dates: engine.expand(engine.parseRule(rule), startsOn, from, to) };
  } catch (error) {
    if (error instanceof engine.RecurrenceError) return { refused: true };
    throw error;
  }
};

const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const ENDS = ['', ';COUNT=1', ';COUNT=7', ';UNTIL=20270315', ';UNTIL=20280229T060000Z'];
const RULES = [
  // Every choice the form offers.
  ...[1, 2, 3, 52].flatMap((n) => ['MO', 'TU,TH', 'MO,WE,FR', 'SA,SU', WEEKDAYS.join(',')].map((days) => `FREQ=WEEKLY;INTERVAL=${n};BYDAY=${days}`)),
  ...[1, 2, 3, 4, -1].flatMap((n) => WEEKDAYS.map((d) => `FREQ=MONTHLY;BYDAY=${n}${d}`)),
  ...[1, 15, 28, 29, 30, 31, -1].map((d) => `FREQ=MONTHLY;BYMONTHDAY=${d}`),
  // The API's own cases, and the rest of the subset.
  'FREQ=WEEKLY',
  'FREQ=MONTHLY',
  'FREQ=MONTHLY;INTERVAL=2;BYDAY=4SA',
  'FREQ=MONTHLY;BYDAY=5FR',
  'FREQ=MONTHLY;BYDAY=TU',
  'FREQ=MONTHLY;BYMONTHDAY=1,-1',
  'FREQ=MONTHLY;INTERVAL=2;BYDAY=2FR,-1MO',
  // Refusals.
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
  'FREQ=MONTHLY;INTERVAL=53',
  'FREQ=MONTHLY;INTERVAL=x',
  'FREQ=MONTHLY;COUNT=0',
  'FREQ=MONTHLY;COUNT=3;UNTIL=20270101',
  'FREQ=MONTHLY;UNTIL=2027-01-01',
  'FREQ=MONTHLY;FREQ=WEEKLY',
  'BYDAY=FR',
  'FREQ=MONTHLY;BYDAY=',
  'freq=monthly',
  '',
];
// Ordinary days, month ends, a leap day, the clock changes, and a year end.
const STARTS = ['2026-01-07', '2026-01-31', '2026-03-08', '2026-11-01', '2026-12-31', '2027-02-28', '2028-02-29', '2028-05-31'];

describe('the web copy of the recurrence rules', () => {
  it('agrees with the API on every rule, ending and first date', () => {
    let compared = 0;
    for (const base of RULES)
      for (const end of base.startsWith('FREQ=') ? ENDS : [''])
        for (const startsOn of STARTS) {
          const rule = `${base}${end}`;
          expect(run(web, rule, startsOn, '2026-01-01', '2029-12-31'), `${rule} from ${startsOn}`).toEqual(run(api, rule, startsOn, '2026-01-01', '2029-12-31'));
          compared += 1;
        }
    expect(compared).toBeGreaterThan(3000);
  });

  it('agrees on ranges that start late, end early, or are empty', () => {
    for (const [from, to] of [
      ['2027-02-01', '2027-03-31'],
      ['2028-02-29', '2028-02-29'],
      ['2027-01-01', '2026-01-01'],
    ] as const) {
      for (const rule of ['FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH', 'FREQ=MONTHLY;BYDAY=-1MO;COUNT=5', 'FREQ=MONTHLY;BYMONTHDAY=29']) {
        expect(run(web, rule, '2026-01-31', from, to)).toEqual(run(api, rule, '2026-01-31', from, to));
      }
    }
  });

  it('reads a rule into the same parts', () => {
    expect(web.parseRule('FREQ=MONTHLY;INTERVAL=2;BYDAY=2FR,-1MO;UNTIL=20271231')).toEqual(api.parseRule('FREQ=MONTHLY;INTERVAL=2;BYDAY=2FR,-1MO;UNTIL=20271231'));
  });
});
