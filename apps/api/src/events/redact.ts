// ============================================================================
// The calendar as one audience may see it (REDACT R2a): series, venues and
// entries passed through the lens BEFORE any message is built from them, so
// no raw field travels beside its redacted copy.
//
//   - A series or stored occurrence's text has its marked passages withheld,
//     and the entry is dropped when a mark hides it.
//   - A venue is a business venue or, for anything else (a member's home, a
//     virtual room, a kind the API does not know), a private venue. Redacted,
//     it keeps its area and kind; its name becomes "[withheld]" and its address,
//     city, link and note are left out. Hidden, the venue and the entries that
//     use it are dropped.
//   - An event's contact is its host or owning office (officer_contact).
//     Redacted, the office id is left out; hidden, the event is dropped.
// ============================================================================
import type { Db } from '../db/pool.js';
import { loadLens } from '../redaction/lens.js';
import { type Lens, WITHHELD, subjectKey, venueCategory } from '../redaction/render.js';
import type { Entry, SeriesRow, VenueRow } from './service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A generated entry's id is `<series>:<date>`; only a stored occurrence's id is a bare UUID. */
const storedId = (entry: Entry): string | undefined => (UUID.test(entry.id) ? entry.id : undefined);

export function entrySubjects(entry: Entry): string[] {
  const stored = storedId(entry);
  return [...(stored !== undefined ? [subjectKey('event_occurrence', stored)] : []), ...(entry.series !== undefined ? [subjectKey('event_series', entry.series.id)] : [])];
}

/** The office id an audience may see, or undefined when its contact is hidden. */
function contactFor(office: string | null, lens: Lens): string | null | undefined {
  if (office === null || office === '') return office;
  const action = lens.action('officer_contact');
  if (action === 'hide') return undefined;
  return action === 'show' ? office : null;
}

export function venueFor(row: VenueRow, lens: Lens): VenueRow | undefined {
  const action = lens.action(venueCategory(row.kind));
  const host = contactFor(row.host_office_id, lens);
  if (action === 'hide' || host === undefined) return undefined;
  if (action === 'show') return { ...row, host_office_id: host };
  return { ...row, name: WITHHELD, business_address: null, city: null, url: null, accessibility_note: null, host_office_id: host };
}

export function seriesFor(row: SeriesRow, lens: Lens): SeriesRow | undefined {
  const subjects = [subjectKey('event_series', row.id)];
  const host = contactFor(row.host_office_id, lens);
  if (lens.hidden(subjects) || host === undefined) return undefined;
  const text = (value: string | null): string | null => (value === null ? null : lens.text(value, subjects));
  return { ...row, title: lens.text(row.title, subjects), description: text(row.description), cadence_label: text(row.cadence_label), host_office_id: host };
}

export function entryFor(entry: Entry, lens: Lens): Entry | undefined {
  const subjects = entrySubjects(entry);
  if (lens.hidden(subjects)) return undefined;
  const series = entry.series === undefined ? undefined : seriesFor(entry.series, lens);
  const venue = entry.venue === undefined ? undefined : venueFor(entry.venue, lens);
  const owner = contactFor(entry.ownerOfficeId, lens);
  if ((entry.series !== undefined && series === undefined) || (entry.venue !== undefined && venue === undefined) || owner === undefined) return undefined;
  return {
    ...entry,
    series,
    venue,
    ownerOfficeId: owner ?? '',
    title: lens.text(entry.title, subjects),
    statusNote: lens.text(entry.statusNote, subjects),
    detail: lens.text(entry.detail, subjects),
    url: lens.text(entry.url, subjects),
  };
}

/** The lens for a set of entries and series: their marks, for this audience. */
export function calendarLens(db: Pick<Db, 'query'>, audience: string, entries: readonly Entry[], series: readonly SeriesRow[] = []): Promise<Lens> {
  return loadLens(db, audience, {
    series: [...new Set([...entries.flatMap((entry) => (entry.series !== undefined ? [entry.series.id] : [])), ...series.map((row) => row.id)])],
    occurrences: entries.flatMap((entry) => storedId(entry) ?? []),
  });
}

/** Drops what the lens hides and redacts the rest. */
export const visible = <T>(rows: readonly T[], view: (row: T) => T | undefined): T[] => rows.flatMap((row) => view(row) ?? []);
