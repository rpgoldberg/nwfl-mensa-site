// ============================================================================
// Loads the lens (render.ts) for one audience: the group's policy cells for
// that audience and the active marks on the items a read is about to return.
// ============================================================================
import type { Db } from '../db/pool.js';
import { TENANT, cellKey } from './policy.js';
import { type Lens, type MarkRow, lensFor, subjectKey } from './render.js';

export interface Subjects {
  items?: readonly string[];
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

export async function loadLens(db: Pick<Db, 'query'>, audience: string, subjects: Subjects): Promise<Lens> {
  const items = [...(subjects.items ?? [])];
  const series = [...(subjects.series ?? [])];
  const occurrences = [...(subjects.occurrences ?? [])];
  const [cells, marks] = await Promise.all([
    db.query<{ category: string; action: string }>(`SELECT category, action FROM redaction_policy WHERE tenant_id = $1 AND audience = $2`, [TENANT, audience]),
    items.length + series.length + occurrences.length === 0
      ? Promise.resolve({ rows: [] as Row[] })
      : db.query<Row>(
          `SELECT content_item_id, series_id, occurrence_id, quote, category FROM redaction_mark
           WHERE tenant_id = $1 AND status = 'active'
             AND (content_item_id = ANY($2::uuid[]) OR series_id = ANY($3::uuid[]) OR occurrence_id = ANY($4::uuid[]))`,
          [TENANT, items, series, occurrences],
        ),
  ]);
  const policy = new Map(cells.rows.map((row) => [cellKey(audience, row.category), row.action]));
  const rows: MarkRow[] = marks.rows.map((row) => ({ subject: keyOf(row), quote: row.quote, category: row.category }));
  return lensFor(audience, policy, rows);
}
