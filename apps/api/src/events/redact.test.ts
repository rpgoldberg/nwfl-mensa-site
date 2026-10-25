// REDACT R2a: the calendar through the lens, as pure functions. A host office
// is the group's public contact and is never withheld; officer_contact reaches
// the calendar through marks only. Every value here is made up.
import { describe, expect, it } from 'vitest';
import { cellKey } from '../redaction/policy.js';
import { WITHHELD, lensFor, subjectKey } from '../redaction/render.js';
import { calendarLens, entryFor, seriesFor, venueFor } from './redact.js';
import type { Entry, SeriesRow, VenueRow } from './service.js';

const HOST = '00000000-0000-4000-8000-0000000000aa';
const SERIES_ID = '00000000-0000-4000-8000-000000000001';
const OCCURRENCE_ID = '00000000-0000-4000-8000-000000000002';

const venue = (kind: string): VenueRow => ({
  id: '00000000-0000-4000-8000-000000000003',
  kind,
  name: 'Example Grill',
  business_address: '100 Example Parkway',
  city: 'Panama City',
  area: 'bay',
  host_office_id: HOST,
  url: 'https://example.org/grill',
  accessibility_note: 'Ramp at the side',
  active: true,
});
const series: SeriesRow = {
  id: SERIES_ID,
  slug: 'coffee',
  title: 'Coffee with Pat Example',
  category: 'other',
  recurrence: 'FREQ=MONTHLY;BYDAY=1SU',
  cadence_label: null,
  starts_on: '2026-01-04',
  default_start: null,
  default_duration_minutes: null,
  default_venue_id: null,
  area: 'bay',
  host_office_id: HOST,
  description: null,
  visibility: 'public',
  active: true,
};
const entry = (overrides: Partial<Entry>): Entry => ({
  id: OCCURRENCE_ID,
  ownerOfficeId: HOST,
  localDate: '2026-11-06',
  series: undefined,
  title: 'Games night',
  startsAt: null,
  endsAt: null,
  venue: undefined,
  status: 'scheduled',
  statusNote: '',
  detail: 'Call Pat Example',
  url: '',
  visibility: 'public',
  ...overrides,
});

const policy = (venueAction: string, contact = 'hide') =>
  new Map([
    [cellKey('public', 'business_venue'), venueAction],
    [cellKey('public', 'private_venue'), venueAction],
    [cellKey('public', 'officer_contact'), contact],
    [cellKey('public', 'member_name'), 'redact'],
  ]);

describe('the calendar through the lens', () => {
  it('keeps the host office on a venue, a series and an entry, even when officer_contact is hidden', () => {
    const lens = lensFor('public', policy('redact', 'hide'), []);
    expect(venueFor(venue('member_home'), lens)).toMatchObject({ name: WITHHELD, business_address: null, url: null, host_office_id: HOST });
    expect(seriesFor(series, lens)?.host_office_id).toBe(HOST);
    expect(entryFor(entry({ series }), lens)?.ownerOfficeId).toBe(HOST);
  });

  it('shows a venue as stored, or drops it, by its category', () => {
    expect(venueFor(venue('business'), lensFor('public', policy('show'), []))).toEqual(venue('business'));
    expect(venueFor(venue('virtual'), lensFor('public', policy('hide'), []))).toBeUndefined();
  });

  it('drops an entry whose venue is hidden, and one a mark hides', () => {
    expect(entryFor(entry({ venue: venue('business') }), lensFor('public', policy('hide'), []))).toBeUndefined();
    const hidden = lensFor('public', policy('show'), [{ subject: subjectKey('event_occurrence', OCCURRENCE_ID), quote: null, category: 'member_name' }]);
    expect(entryFor(entry({}), hidden)).toBeUndefined();
  });

  it('drops a series a mark hides, and withholds marked passages in its text and an entry’s, an officer_contact passage included', () => {
    const marks = [
      { subject: subjectKey('event_series', SERIES_ID), quote: 'Pat Example', category: 'officer_contact' },
      { subject: subjectKey('event_occurrence', OCCURRENCE_ID), quote: 'Pat Example', category: 'member_name' },
    ];
    const redacting = lensFor('public', policy('show', 'redact'), marks);
    expect(seriesFor({ ...series, cadence_label: 'Pat Example days', description: 'Ask Pat Example' }, redacting)).toMatchObject({
      title: `Coffee with ${WITHHELD}`,
      cadence_label: `${WITHHELD} days`,
      description: `Ask ${WITHHELD}`,
    });
    expect(entryFor(entry({}), redacting)?.detail).toBe(`Call ${WITHHELD}`);
    expect(seriesFor(series, lensFor('public', policy('show', 'hide'), marks))).toBeUndefined();
  });

  it('never gives the slug of a series with a withheld passage anywhere in it, even one the slug spells without accents', () => {
    const memorial = { ...series, slug: 'memorial-walk-jose-nunez', title: 'Memorial walk', description: 'For José Núñez' };
    const marks = [{ subject: subjectKey('event_series', SERIES_ID), quote: 'José Núñez', category: 'member_name' }];
    expect(seriesFor(memorial, lensFor('public', policy('show'), marks))).toMatchObject({ slug: SERIES_ID, title: 'Memorial walk', description: `For ${WITHHELD}` });
    const members = lensFor('members', new Map([[cellKey('members', 'member_name'), 'show']]), marks);
    expect(seriesFor(memorial, members)?.slug).toBe('memorial-walk-jose-nunez');
    expect(seriesFor(memorial, lensFor('public', policy('show'), []))?.slug).toBe('memorial-walk-jose-nunez');
  });

  it('loads the lens for the entries’ series and stored occurrences only', async () => {
    const calls: unknown[][] = [];
    const db = { query: (_text: string, values: unknown[] = []) => (calls.push(values), Promise.resolve({ rows: [] })) };
    await calendarLens(db as never, 'public', [entry({ series }), entry({ id: `${SERIES_ID}:2026-11-01`, series })]);
    expect(calls.at(-1)).toEqual(['nwflorida', [], [SERIES_ID], [OCCURRENCE_ID]]);
  });
});
