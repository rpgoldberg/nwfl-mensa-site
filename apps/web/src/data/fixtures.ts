// MADE-UP data for the on-request pages until the API lands. Every person is
// invented, every address is a role alias, and the pages show a notice that
// these are sample entries. Offices and the newsletter's name are real.
import type { FinancePeriod, Issue, Meeting, Office, SiteData } from './site-data';

const offices: Office[] = [
  { slug: 'president', title: 'President', holder: 'Alex Sample', alias: 'president@nwflorida.us', aliasVerified: true, source: 'submitted' },
  { slug: 'vice-president', title: 'Vice President', holder: 'Jordan Example', alias: 'vp@nwflorida.us', aliasVerified: true, source: 'submitted' },
  { slug: 'secretary', title: 'Secretary', holder: 'Casey Placeholder', alias: 'secretary@nwflorida.us', aliasVerified: true, source: 'submitted' },
  { slug: 'treasurer', title: 'Treasurer', holder: 'Riley Testcase', alias: 'treasurer@nwflorida.us', aliasVerified: false, source: 'submitted' },
  { slug: 'membership', title: 'Membership Officer', alias: 'membership@nwflorida.us', aliasVerified: true, source: 'submitted' },
  { slug: 'editor', title: 'Newsletter Editor', holder: 'Morgan Dummy', alias: 'editor@nwflorida.us', aliasVerified: true, source: 'submitted' },
];

const issues: Issue[] = [
  { period: '2026-10', label: 'October and November 2026', volume: 30, number: 5, source: 'pipeline' },
  { period: '2026-08', label: 'August and September 2026', volume: 30, number: 4, source: 'pipeline' },
  { period: '2026-06', label: 'June and July 2026', volume: 30, number: 3, source: 'pipeline' },
  { period: '2025-12', label: 'December 2025 and January 2026', volume: 29, number: 6, source: 'pipeline' },
  { period: '2025-06', label: 'June and July 2025', missing: true, source: 'pipeline' },
];

const meetings: Meeting[] = [
  {
    date: '2026-09-19',
    kind: 'Executive Committee meeting',
    place: 'Destin',
    summary: 'Sample minutes: the committee planned the holiday party and agreed the treasurer’s summary for the summer.',
    attendance: { offices: ['President', 'Vice President', 'Secretary', 'Newsletter Editor'], others: 3 },
    reports: [{ office: 'Treasurer', title: 'Treasurer’s report for July to September 2026' }],
    source: 'submitted',
  },
  {
    date: '2026-06-20',
    kind: 'Executive Committee meeting',
    place: 'Pensacola',
    summary: 'Sample minutes: the committee set the election timetable and welcomed two visitors.',
    attendance: { offices: ['President', 'Secretary', 'Treasurer'], others: 5 },
    reports: [],
    source: 'submitted',
  },
  {
    date: '2026-03-21',
    kind: 'Executive Committee meeting',
    place: 'Panama City',
    summary: 'Sample minutes: the committee reviewed the spring calendar of lunches and meetups.',
    attendance: { offices: ['President', 'Vice President', 'Treasurer'], others: 2 },
    reports: [{ office: 'Vice President', title: 'Vice President’s report' }],
    source: 'submitted',
  },
];

const finances: FinancePeriod[] = [
  { label: 'July to September 2026', opening: 254_310, deposits: 42_000, debits: 18_575, closing: 277_735, acceptedOn: '2026-09-19', source: 'submitted' },
  { label: 'April to June 2026', opening: 249_860, deposits: 21_500, debits: 17_050, closing: 254_310, acceptedOn: '2026-06-20', source: 'submitted' },
];

export const fixtureData: SiteData = {
  isSample: true,
  offices: async () => offices,
  issues: async () => issues,
  meetings: async () => meetings,
  finances: async () => finances,
};
