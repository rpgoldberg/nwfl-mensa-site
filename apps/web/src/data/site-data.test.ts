import { describe, expect, it } from 'vitest';
import { fixtureData } from './fixtures';
import { balanced, currentIssue, issuesByYear, rosterView } from './site-data';

describe('the fixture adapter (made-up data until the API lands)', () => {
  it('says it is sample data, so the pages can say so too', () => {
    expect(fixtureData.isSample).toBe(true);
  });

  it('marks where each item comes from: people for the roster, minutes and finances, the pipeline for issues', async () => {
    for (const office of await fixtureData.offices()) expect(office.source).toBe('submitted');
    for (const meeting of await fixtureData.meetings()) expect(meeting.source).toBe('submitted');
    for (const period of await fixtureData.finances()) expect(period.source).toBe('submitted');
    for (const issue of await fixtureData.issues()) expect(issue.source).toBe('pipeline');
  });

  it('uses role addresses only, never a personal one', async () => {
    for (const office of await fixtureData.offices()) expect(office.alias).toMatch(/^[a-z-]+@nwflorida\.us$/);
  });

  it('gives meetings newest first, each with a date, attendance by office and a count of others', async () => {
    const meetings = await fixtureData.meetings();
    expect(meetings.length).toBeGreaterThanOrEqual(3);
    expect(meetings.map((m) => m.date)).toEqual([...meetings.map((m) => m.date)].sort().reverse());
    for (const m of meetings) {
      expect(m.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(m.attendance.offices.length).toBeGreaterThan(0);
      expect(Number.isInteger(m.attendance.others)).toBe(true);
    }
  });

  it('has treasurer summaries whose totals add up', async () => {
    for (const period of await fixtureData.finances()) expect(balanced(period), period.label).toBe(true);
  });
});

describe('rosterView (R2)', () => {
  it('shows a vacant seat as vacant, and an address only once mail to it has been seen to arrive', () => {
    const view = rosterView([
      { slug: 'president', title: 'President', holder: 'Alex Sample', alias: 'president@nwflorida.us', aliasVerified: true, source: 'submitted' },
      { slug: 'treasurer', title: 'Treasurer', holder: 'Jordan Example', alias: 'treasurer@nwflorida.us', aliasVerified: false, source: 'submitted' },
      { slug: 'membership', title: 'Membership Officer', alias: 'membership@nwflorida.us', aliasVerified: true, source: 'submitted' },
    ]);
    expect(view).toEqual([
      { slug: 'president', title: 'President', holder: 'Alex Sample', email: 'president@nwflorida.us', vacant: false, source: 'submitted' },
      { slug: 'treasurer', title: 'Treasurer', holder: 'Jordan Example', email: undefined, vacant: false, source: 'submitted' },
      { slug: 'membership', title: 'Membership Officer', holder: undefined, email: 'membership@nwflorida.us', vacant: true, source: 'submitted' },
    ]);
  });
});

describe('issues', () => {
  const issues = [
    { period: '2026-08', label: 'August and September 2026', volume: 30, number: 4, source: 'pipeline' as const },
    { period: '2026-10', label: 'October and November 2026', volume: 30, number: 5, source: 'pipeline' as const },
    { period: '2025-12', label: 'December 2025 and January 2026', volume: 29, number: 6, source: 'pipeline' as const },
    { period: '2025-06', label: 'June and July 2025', missing: true, source: 'pipeline' as const },
  ];

  it('takes the newest issue we have as the current one', () => {
    expect(currentIssue(issues)?.period).toBe('2026-10');
    expect(currentIssue([])).toBeUndefined();
  });

  it('groups the rest by year, newest first, missing issues included', () => {
    expect(issuesByYear(issues).map(([year, list]) => [year, list.map((i) => i.period)])).toEqual([
      ['2026', ['2026-08']],
      ['2025', ['2025-12', '2025-06']],
    ]);
  });
});

describe('balanced', () => {
  it('checks opening + deposits - debits = closing', () => {
    expect(balanced({ label: 'x', opening: 1000, deposits: 500, debits: 200, closing: 1300, acceptedOn: '2026-01-01', source: 'submitted' })).toBe(true);
    expect(balanced({ label: 'x', opening: 1000, deposits: 500, debits: 200, closing: 1301, acceptedOn: '2026-01-01', source: 'submitted' })).toBe(false);
  });
});

describe('attendanceText (R6: offices, and a count of everyone else)', () => {
  it('lists the offices present, then counts the other members', async () => {
    const { attendanceText } = await import('./site-data');
    expect(attendanceText({ offices: ['President', 'Secretary'], others: 3 })).toBe('President, Secretary, and 3 other members');
    expect(attendanceText({ offices: ['President'], others: 1 })).toBe('President, and 1 other member');
    expect(attendanceText({ offices: ['President', 'Treasurer'], others: 0 })).toBe('President, Treasurer');
  });
});

describe('siteData', () => {
  it('is the fixture adapter until the API lands', async () => {
    const { siteData } = await import('./index');
    expect(siteData).toBe(fixtureData);
  });
});
