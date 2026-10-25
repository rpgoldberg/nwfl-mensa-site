// ============================================================================
// Loads the lens (render.ts) for one audience: the group's policy cells for
// that audience and the active marks on the items a read is about to return.
//
// Each passage mark is anchored here: the loader reads the stored text of
// each content version the read may show (title, summary, on-behalf-of name,
// markup, the whole body tree and file names) and of each event subject, and
// records where the mark's text is found. Only that yes or no leaves this
// file; the stored text itself is never handed to a message builder. A mark
// found nowhere in what is shown makes the lens drop it (fail closed).
// ============================================================================
import { normalizeTree } from '../content/tree.js';
import type { Db } from '../db/pool.js';
import { TENANT, cellKey } from './policy.js';
import { type Lens, type MarkRow, lensFor, quoteMatches, subjectKey, treeText } from './render.js';

export interface Subjects {
  items?: readonly string[];
  /** The content versions the read may show, to anchor the items' marks in. */
  versions?: readonly string[];
  series?: readonly string[];
  occurrences?: readonly string[];
}

interface Row {
  content_item_id: string | null;
  series_id: string | null;
  occurrence_id: string | null;
  quote: string | null;
  category: string;
}

function keyOf(row: Row): string {
  if (row.content_item_id !== null) return subjectKey('content_item', row.content_item_id);
  if (row.series_id !== null) return subjectKey('event_series', row.series_id);
  return subjectKey('event_occurrence', row.occurrence_id as string);
}

type Query = Pick<Db, 'query'>;

/** Each version's item and every text it carries. */
async function versionTexts(db: Query, versions: readonly string[], uniform: boolean): Promise<Array<{ id: string; item: string; texts: string[] }>> {
  if (versions.length === 0 && !uniform) return [];
  const [rows, files] = await Promise.all([
    db.query<{ id: string; item_id: string; title: string; summary: string | null; on_behalf_of: string | null; body_src: string; body_ast: unknown }>(
      `SELECT id, item_id, title, summary, on_behalf_of, body_src, body_ast FROM content_version WHERE id = ANY($1::uuid[])`,
      [versions],
    ),
    db.query<{ version_id: string; filename: string }>(`SELECT version_id, filename FROM stored_file WHERE version_id = ANY($1::uuid[])`, [versions]),
  ]);
  return rows.rows.map((row) => ({
    id: row.id,
    item: row.item_id,
    texts: [
      row.title,
      row.summary ?? '',
      row.on_behalf_of ?? '',
      row.body_src,
      treeText(normalizeTree(row.body_ast)),
      ...files.rows.filter((file) => file.version_id === row.id).map((file) => file.filename),
    ],
  }));
}

/** Each event subject's texts: a series' own, an occurrence's own and its series'. */
async function eventTexts(db: Query, series: readonly string[], occurrences: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const [seriesRows, occurrenceRows] = await Promise.all([
    series.length === 0
      ? Promise.resolve({ rows: [] })
      : db.query<{ id: string; title: string; description: string | null; cadence_label: string | null }>(
          `SELECT id, title, description, cadence_label FROM event_series WHERE id = ANY($1::uuid[])`,
          [series],
        ),
    occurrences.length === 0
      ? Promise.resolve({ rows: [] })
      : db.query<{ id: string; texts: Array<string | null> }>(
          `SELECT o.id, ARRAY[o.title, o.detail, o.status_note, o.url, s.title, s.description, s.cadence_label] AS texts
           FROM event_occurrence o LEFT JOIN event_series s ON s.id = o.series_id WHERE o.id = ANY($1::uuid[])`,
          [occurrences],
        ),
  ]);
  seriesRows.rows.forEach((row) => out.set(subjectKey('event_series', row.id), [row.title, row.description ?? '', row.cadence_label ?? '']));
  occurrenceRows.rows.forEach((row) => out.set(subjectKey('event_occurrence', row.id), row.texts.map((text) => text ?? '')));
  return out;
}

/**
 * `uniform`: run the same queries whether or not there is anything to find, so a read that answers
 * "not found" for an item it withholds takes the same steps as one for an item that does not exist.
 */
export async function loadLens(db: Query, audience: string, subjects: Subjects, options: { uniform?: boolean } = {}): Promise<Lens> {
  const uniform = options.uniform === true;
  const items = [...(subjects.items ?? [])];
  const series = [...(subjects.series ?? [])];
  const occurrences = [...(subjects.occurrences ?? [])];
  const [cells, marks] = await Promise.all([
    db.query<{ category: string; action: string }>(`SELECT category, action FROM redaction_policy WHERE tenant_id = $1 AND audience = $2`, [TENANT, audience]),
    items.length + series.length + occurrences.length === 0 && !uniform
      ? Promise.resolve({ rows: [] as Row[] })
      : db.query<Row>(
          `SELECT content_item_id, series_id, occurrence_id, quote, category FROM redaction_mark
           WHERE tenant_id = $1 AND status = 'active'
             AND (content_item_id = ANY($2::uuid[]) OR series_id = ANY($3::uuid[]) OR occurrence_id = ANY($4::uuid[]))`,
          [TENANT, items, series, occurrences],
        ),
  ]);
  const policy = new Map(cells.rows.map((row) => [cellKey(audience, row.category), row.action]));
  const passages = marks.rows.filter((row) => row.quote !== null);
  const [versions, events] = await Promise.all([
    uniform || passages.some((row) => row.content_item_id !== null) ? versionTexts(db, [...(subjects.versions ?? [])], uniform) : Promise.resolve([]),
    passages.some((row) => row.content_item_id === null)
      ? eventTexts(
          db,
          [...new Set(passages.flatMap((row) => (row.series_id !== null ? [row.series_id] : [])))],
          [...new Set(passages.flatMap((row) => (row.occurrence_id !== null ? [row.occurrence_id] : [])))],
        )
      : Promise.resolve(new Map<string, string[]>()),
  ]);
  const rows: MarkRow[] = marks.rows.map((row) => {
    const subject = keyOf(row);
    const mark: MarkRow = { subject, quote: row.quote, category: row.category };
    if (row.quote === null) return mark;
    const quote = row.quote;
    const anchoredIn =
      row.content_item_id !== null
        ? versions.filter((version) => version.item === row.content_item_id && quoteMatches(quote, version.texts)).map((version) => version.id)
        : quoteMatches(quote, events.get(subject) ?? [])
          ? [subject]
          : [];
    return { ...mark, anchoredIn: new Set(anchoredIn) };
  });
  return lensFor(audience, policy, rows);
}
