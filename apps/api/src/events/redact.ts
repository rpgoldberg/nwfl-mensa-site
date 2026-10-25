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
//   - An event's contact is its host or owning office, reached through the
//     office's verified role alias: the group's public contact, never an
//     officer's personal details, so no policy withholds it. officer_contact
//     covers an officer's personal phone, email or home address only; no
//     structured calendar field holds one (0001: a role alias is never a
//     personal address), so it applies here through marks alone.
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

export function venueFor(row: VenueRow, lens: Lens): VenueRow | undefined {
  const action = lens.action(venueCategory(row.kind));
  if (action === 'hide') return undefined;
  if (action === 'show') return row;
  // The host office stays: it is the group's contact for the venue.
  return { ...row, name: WITHHELD, business_address: null, city: null, url: null, accessibility_note: null };
}

export function seriesFor(row: SeriesRow, lens: Lens): SeriesRow | undefined {
  const subjects = [subjectKey('event_series', row.id)];
  if (lens.hidden(subjects)) return undefined;
  const text = (value: string | null): string | null => (value === null ? null : lens.text(value, subjects));
  const title = lens.text(row.title, subjects);
  // A slug is written from the title: where any of either is withheld, the series' id stands in.
  const slug = title !== row.title || lens.text(row.slug, subjects) !== row.slug ? row.id : row.slug;
  return { ...row, slug, title, description: text(row.description), cadence_label: text(row.cadence_label) };
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Calendar order on what the audience sees (S3): date, start, the shown title, then id. A members
 * event the public reads withheld is ordered by its date alone, never by its title or time.
 */
export function inCalendarOrder(entries: readonly Entry[], audience?: string): Entry[] {
  const withheld = (entry: Entry): boolean => audience === 'public' && entry.visibility === 'members';
  const start = (entry: Entry): number => (withheld(entry) ? 0 : (entry.startsAt?.getTime() ?? 0));
  const title = (entry: Entry): string => (withheld(entry) ? '' : entry.title);
  return [...entries].sort((a, b) => compare(a.localDate, b.localDate) || start(a) - start(b) || compare(title(a), title(b)) || compare(a.id, b.id));
}

/** Series by the slug the audience sees, then id. */
export const bySlug = (series: readonly SeriesRow[]): SeriesRow[] => [...series].sort((a, b) => compare(a.slug, b.slug) || compare(a.id, b.id));

export function entryFor(entry: Entry, lens: Lens): Entry | undefined {
  const subjects = entrySubjects(entry);
  if (lens.hidden(subjects)) return undefined;
  const venue = entry.venue === undefined ? undefined : venueFor(entry.venue, lens);
  if (entry.venue !== undefined && venue === undefined) return undefined;
  return {
    ...entry,
    // A series hidden by its marks has hidden this entry already: its subjects include the series.
    series: entry.series === undefined ? undefined : seriesFor(entry.series, lens),
    venue,
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
