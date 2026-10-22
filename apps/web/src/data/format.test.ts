import { describe, expect, it } from 'vitest';
import { formatDate, formatMoney, monthOf } from './format';

describe('formatDate (dates written out, as the design draft asks)', () => {
  it('writes the weekday, day, month and year', () => {
    expect(formatDate('2026-11-21')).toBe('Saturday, 21 November 2026');
    expect(formatDate('2026-01-01')).toBe('Thursday, 1 January 2026');
  });

  it('can leave out the year', () => {
    expect(formatDate('2026-11-21', { year: false })).toBe('Saturday, 21 November');
  });

  it('refuses a date that is not YYYY-MM-DD', () => {
    expect(() => formatDate('21/11/2026')).toThrow(/YYYY-MM-DD/);
    expect(() => formatDate('2026-13-01')).toThrow(/YYYY-MM-DD/);
  });
});

describe('formatMoney', () => {
  it('writes cents as dollars with two places, and a minus for a debit', () => {
    expect(formatMoney(123456)).toBe('$1,234.56');
    expect(formatMoney(5)).toBe('$0.05');
    expect(formatMoney(-2500)).toBe('−$25.00');
  });
});

describe('monthOf', () => {
  it('is the YYYY-MM of a date, the anchor old minutes links use when they had no day', () => {
    expect(monthOf('2024-01-20')).toBe('2024-01');
  });
});
