// N2: the content JSON the newsletter generator reads (R12, P20), contract v1.
// Its key names and types follow the generator's loader; every value here is
// made up. MEMBERS resolves members passages in full; PUBLIC replaces each one
// with a fixed string that carries no length hint. Contact data never appears:
// no event contact name or phone, no personal email.
import { describe, expect, it } from 'vitest';
import { normalizeTree, filterForPublic, type Tree } from '../content/tree.js';
import { parseMarkup } from '../content/markup.js';
import type { Entry, VenueRow } from '../events/service.js';
import { MEMBERS_EVENT_TITLE, PUBLIC_PLACEHOLDER, buildContentJson, exportEvent, type ExportInput, monthsBetween, treeText } from './content-json.js';

const tree = (markup: string): Tree => normalizeTree(parseMarkup(markup).tree);

const input = (audience: 'members' | 'public'): ExportInput => {
  const report = tree('# From the President\n\nWelcome back. The picnic is at :members[pavilion 3, gate code 4417].\n\n- Bring a chair\n- Bring [sunscreen](https://example.org/sun)\n\nWrite to [the board](mailto:president@nwflorida.us) or [me](mailto:pat.example@example.com).');
  const memo = tree('Members-only planning notes.');
  return {
    audience,
    edition: { slug: '2027-02', title: 'February and March 2027', volume: 31, issueNumber: 1, calendarMonths: [{ year: 2027, month: 2 }, { year: 2027, month: 3 }] },
    items: [
      { kind: 'president_report', title: "President's Report", summary: null, visibility: 'public', tree: audience === 'public' ? filterForPublic(report) : report },
      { kind: 'announcement', title: 'Planning notes', summary: 'For members', visibility: 'members', tree: audience === 'public' ? { blocks: [{ type: 'redacted' }] } : memo },
      { kind: 'minutes', title: 'ExComm minutes, January 2027', summary: null, visibility: 'public', tree: tree('Called to order at 10:02.') },
    ],
    offices: [
      { slug: 'president', title: 'President', holders: ['Pat Example'], roleAlias: 'president@nwflorida.us' },
      { slug: 'vice-president', title: 'Vice President', holders: ['Sam Sample'], roleAlias: '' },
      { slug: 'membership', title: 'Membership Officer', holders: [], roleAlias: '' },
      { slug: 'publications', title: 'Publications Officer', holders: ['Jordan Fictional', 'Alex Placeholder'], roleAlias: 'pubs@nwflorida.us' },
      { slug: 'historian', title: 'Historian', holders: ['Casey Madeup'], roleAlias: '' },
    ],
    events: [
      { date: '2027-02-03', time: '11:30 AM', title: 'Wednesday Lunch', location: 'Example Grill, 100 Example Parkway, Panama City', url: '', status: 'scheduled', statusNote: '', visibility: 'public', area: 'Bay' },
      { date: '2027-02-03', time: '6:00 PM', title: 'Board games', location: "A member's home, Okaloosa (contact vp@nwflorida.us)", url: 'https://example.org/games', status: 'scheduled', statusNote: '', visibility: 'members', area: 'Okaloosa' },
      { date: '2027-02-10', time: '11:30 AM', title: 'Wednesday Lunch', location: 'Example Grill, 100 Example Parkway, Panama City', url: '', status: 'cancelled', statusNote: 'Snow day', visibility: 'public', area: 'Bay' },
      { date: '2027-02-12', time: null, title: 'Happy Hour', location: '', url: '', status: 'tentative', statusNote: '', visibility: 'public', area: 'Okaloosa' },
    ],
  };
};

const GOLDEN_MEMBERS = {
  contract_version: '1',
  audience: 'members',
  config: { organization: 'Northwest Florida Mensa', volume: '31', issue: '1', month_year: 'February and March 2027', calendar_months: [{ month: 2, year: 2027 }, { month: 3, year: 2027 }] },
  officers: {
    President: 'Pat Example',
    'Vice President': 'Sam Sample',
    Treasurer: 'Vacant',
    'Membership Officer': 'Vacant',
    'Member at Large': 'Vacant',
    'Past President': 'Vacant',
    Editor: 'Vacant',
    'Publications Officer': 'Jordan Fictional and Alex Placeholder',
    Webmaster: 'Vacant',
  },
  roster: [
    { office: 'President', holder: 'Pat Example', role_alias: 'president@nwflorida.us' },
    { office: 'Vice President', holder: 'Sam Sample', role_alias: '' },
    { office: 'Membership Officer', holder: 'Vacant', role_alias: '' },
    { office: 'Publications Officer', holder: 'Jordan Fictional and Alex Placeholder', role_alias: 'pubs@nwflorida.us' },
    { office: 'Historian', holder: 'Casey Madeup', role_alias: '' },
  ],
  articles: [
    {
      title: "President's Report",
      content:
        'From the President\n\nWelcome back. The picnic is at pavilion 3, gate code 4417.\n\n• Bring a chair\n• Bring sunscreen (https://example.org/sun)\n\nWrite to the board (president@nwflorida.us) or me.',
    },
    { title: 'Planning notes', content: 'Members-only planning notes.' },
  ],
  minutes: 'ExComm minutes, January 2027\n\nCalled to order at 10:02.',
  events: {
    '2027-02-03': [
      { time: '11:30 AM', title: 'Wednesday Lunch', location: 'Example Grill, 100 Example Parkway, Panama City' },
      { time: '6:00 PM', title: 'Board games', location: "A member's home, Okaloosa (contact vp@nwflorida.us)", url: 'https://example.org/games' },
    ],
    '2027-02-10': [{ time: '11:30 AM', title: 'Wednesday Lunch (cancelled: Snow day)', location: 'Example Grill, 100 Example Parkway, Panama City' }],
    '2027-02-12': [{ title: 'Happy Hour (tentative)' }],
  },
};

describe('buildContentJson: MEMBERS', () => {
  it('produces the golden made-up export', () => {
    expect(buildContentJson(input('members'))).toEqual(GOLDEN_MEMBERS);
  });

  it('keeps the generator’s nine officer keys, in order, whatever offices exist', () => {
    expect(Object.keys(buildContentJson(input('members')).officers)).toEqual([
      'President',
      'Vice President',
      'Treasurer',
      'Membership Officer',
      'Member at Large',
      'Past President',
      'Editor',
      'Publications Officer',
      'Webmaster',
    ]);
  });
});

describe('buildContentJson: PUBLIC', () => {
  const exported = buildContentJson(input('public'));
  const text = JSON.stringify(exported);

  it('replaces each members passage with the fixed string, and nothing of it remains', () => {
    expect(text).not.toContain('4417');
    expect(text).not.toContain('pavilion');
    expect(exported.articles[0]?.content).toContain(`The picnic is at ${PUBLIC_PLACEHOLDER}.`);
  });

  it('gives a members item only its title, summary and the fixed string', () => {
    expect(exported.articles[1]).toEqual({ title: 'Planning notes', content: `For members\n\n${PUBLIC_PLACEHOLDER}` });
    expect(text).not.toContain('planning notes.');
    const bare = input('public');
    bare.items = [{ kind: 'announcement', title: 'Quiet', summary: null, visibility: 'members', tree: { blocks: [] } }];
    expect(buildContentJson(bare).articles).toEqual([{ title: 'Quiet', content: PUBLIC_PLACEHOLDER }]);
  });

  it('shows a members event only as its date and area', () => {
    expect(exported.events['2027-02-03']?.[1]).toEqual({ title: MEMBERS_EVENT_TITLE, location: 'Okaloosa' });
    expect(text).not.toContain('Board games');
    expect(text).not.toContain('example.org/games');
  });

  it('says it is the public export', () => {
    expect(exported.audience).toBe('public');
  });
});

describe('buildContentJson: the optional parts', () => {
  it('leaves out what is not there, and spells every event status', () => {
    const exported = buildContentJson({
      audience: 'public',
      edition: { slug: '2027-xx', title: 'XTRA', volume: null, issueNumber: null, calendarMonths: [] },
      items: [],
      offices: [],
      events: [
        { date: '2027-04-01', time: '7:00 PM', title: 'Quiz', location: '', url: '', status: 'scheduled', statusNote: 'Second floor', visibility: 'public', area: '' },
        { date: '2027-04-02', time: null, title: 'Picnic', location: '', url: '', status: 'moved', statusNote: 'To the 9th', visibility: 'public', area: '' },
        { date: '2027-04-03', time: null, title: 'Lunch', location: '', url: '', status: 'cancelled', statusNote: '', visibility: 'public', area: '' },
        { date: '2027-04-04', time: null, title: 'Party', location: '', url: '', status: 'scheduled', statusNote: '', visibility: 'members', area: '' },
      ],
    });
    expect(exported.config).toMatchObject({ volume: '', issue: '', calendar_months: [] });
    expect(exported.minutes).toBeUndefined();
    expect(exported.articles).toEqual([]);
    expect(Object.values(exported.officers).every((holder) => holder === 'Vacant')).toBe(true);
    expect(exported.events).toEqual({
      '2027-04-01': [{ time: '7:00 PM', title: 'Quiz (Second floor)' }],
      '2027-04-02': [{ title: 'Picnic (moved: To the 9th)' }],
      '2027-04-03': [{ title: 'Lunch (cancelled)' }],
      '2027-04-04': [{ title: MEMBERS_EVENT_TITLE }],
    });
  });
});

describe('treeText', () => {
  it('gives no length hint: a long and a short passage become the same string', () => {
    const short = treeText(filterForPublic(tree('A :members[x].')), 'public');
    const long = treeText(filterForPublic(tree(`A :members[${'secret '.repeat(50)}].`)), 'public');
    expect(short).toBe(long);
  });

  it('fails closed: a members node handed to the public renderer is still the fixed string', () => {
    expect(treeText(tree('::: members\nHidden.\n:::\n\nOpen.'), 'public')).toBe(`${PUBLIC_PLACEHOLDER}\n\nOpen.`);
    expect(treeText(tree('See :members[the map].'), 'public')).toBe(`See ${PUBLIC_PLACEHOLDER}.`);
  });

  it('fails closed on a members link too: handed an unfiltered tree, the public render carries neither its text nor its target', () => {
    const t = normalizeTree({
      blocks: [{ type: 'paragraph', children: [{ type: 'text', text: 'Join us: ' }, { type: 'link', href: 'https://example.org/zoom?pwd=s3cret', children: [{ type: 'members', children: [{ type: 'text', text: 'Zoom room' }] }] }] }],
    });
    expect(treeText(t, 'public')).toBe(`Join us: ${PUBLIC_PLACEHOLDER}`);
    expect(treeText(t, 'members')).toBe('Join us: Zoom room (https://example.org/zoom?pwd=s3cret)');
  });

  it('renders a members block in full for members', () => {
    expect(treeText(tree('::: members\nFirst.\n\nSecond.\n:::\n\nOpen.'), 'members')).toBe('First.\n\nSecond.\n\nOpen.');
  });

  it('renders headings, numbered lists, quotes and images as plain text', () => {
    const t = tree('## Sub\n\n1. One\n2. Two\n\n> Quoted\n\n![A flyer](file:7a0d3d4e-1f1b-4c55-9a51-0b8f1c6a2e01)');
    expect(treeText(t, 'members')).toBe('Sub\n\n1. One\n2. Two\n\nQuoted');
  });

  it('keeps a members span visible in the members render, and a placeholder never leaks there either', () => {
    expect(treeText(tree('See :members[the map].'), 'members')).toBe('See the map.');
    expect(treeText({ blocks: [{ type: 'redacted' }] }, 'members')).toBe(PUBLIC_PLACEHOLDER);
  });
});

describe('monthsBetween', () => {
  it('lists the grid months, across a year end', () => {
    expect(monthsBetween('2027-11-15', '2028-02-01')).toEqual([
      { year: 2027, month: 11 },
      { year: 2027, month: 12 },
      { year: 2028, month: 1 },
      { year: 2028, month: 2 },
    ]);
    expect(monthsBetween('2027-04-01', '2027-04-30')).toEqual([{ year: 2027, month: 4 }]);
  });
});

describe('exportEvent', () => {
  const venue = (over: Partial<VenueRow>): VenueRow => ({
    id: 'v',
    kind: 'business',
    name: 'Example Grill',
    business_address: null,
    city: null,
    area: 'bay',
    host_office_id: null,
    url: null,
    accessibility_note: null,
    active: true,
    ...over,
  });
  const entry = (over: Partial<Entry>): Entry => ({
    id: 'e',
    ownerOfficeId: 'o',
    localDate: '2027-02-06',
    series: undefined,
    title: 'Lunch',
    startsAt: new Date('2027-02-06T17:30:00Z'),
    endsAt: null,
    venue: undefined,
    status: 'scheduled',
    statusNote: '',
    detail: 'Ask Pat Example at 850-555-0100',
    url: '',
    visibility: 'public',
    ...over,
  });
  const aliases = new Map([['vp-office', 'vp@nwflorida.us'], ['quiet-office', '']]);

  it('names a business by name, address and city, as far as they are known, with its link', () => {
    expect(exportEvent(entry({ venue: venue({ business_address: '100 Example Parkway', city: 'Panama City', url: 'https://example.org/grill' }) }), aliases)).toEqual({
      date: '2027-02-06',
      time: '11:30 AM',
      title: 'Lunch',
      location: 'Example Grill, 100 Example Parkway, Panama City',
      url: 'https://example.org/grill',
      status: 'scheduled',
      statusNote: '',
      visibility: 'public',
      area: 'Bay',
    });
    expect(exportEvent(entry({ venue: venue({}) }), aliases)).toMatchObject({ location: 'Example Grill', url: '' });
  });

  it('prefers the occurrence’s own link to the venue’s', () => {
    expect(exportEvent(entry({ url: 'https://example.org/rsvp', venue: venue({ url: 'https://example.org/grill' }) }), aliases).url).toBe('https://example.org/rsvp');
  });

  it('gives a member’s home only as its area and the host office’s role alias, never its name or link', () => {
    const home = (host: string | null) => exportEvent(entry({ venue: venue({ kind: 'member_home', name: 'The Example house', area: 'okaloosa', host_office_id: host, url: 'https://example.org/home' }) }), aliases);
    expect(home('vp-office')).toMatchObject({ location: "A member's home, Okaloosa (contact vp@nwflorida.us)", url: '' });
    expect(home('quiet-office')).toMatchObject({ location: "A member's home, Okaloosa" });
    expect(home('unknown-office')).toMatchObject({ location: "A member's home, Okaloosa" });
    expect(home(null)).toMatchObject({ location: "A member's home, Okaloosa" });
  });

  it('falls back to the series area, then to none; an untimed entry has no time; detail never leaves', () => {
    const series = { area: 'escambia_santa_rosa' } as Entry['series'];
    expect(exportEvent(entry({ series, startsAt: null }), aliases)).toMatchObject({ location: '', area: 'Escambia and Santa Rosa', time: null });
    expect(exportEvent(entry({}), aliases)).toMatchObject({ location: '', area: '' });
    expect(JSON.stringify(exportEvent(entry({}), aliases))).not.toContain('555');
  });
});
