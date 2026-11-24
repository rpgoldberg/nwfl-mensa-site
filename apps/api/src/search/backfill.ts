// ============================================================================
// ARCHIVE-SEARCH S1: the boot backfill of the news-item rows.
//
// recordSubjects (ledger.ts) writes an item's rows with every change. This
// covers what no change has touched since 0032: at boot, each live version of a
// published item whose row is missing or is not the ledger's current output is
// rendered again and put, and a row the ledger no longer stands behind is
// rewritten or deleted. One version a transaction, under the ledger's lock, as
// every other render is, and only when the render IS what the ledger holds:
// search_item_put refuses anything else, and a version whose render has drifted
// from its ledger row is left for the change that records it.
//
// Then it re-records (recordItems) each published item with a passage mark
// whose live version the app has not re-recorded, for an audience, since the
// last write to a policy cell (0032's version_rerecorded against
// policy_change_epoch); only such an item's PDF waits on that. A write made
// outside the API (as 0022 made its change) re-records nothing, and until a
// re-record the page writer refuses the item's PDF if it has a passage mark:
// this brings such items back, or keeps them out, as the policy now says. In
// batches of items, one transaction each, by item id; a second run finds none.
//
// It re-records too, the same way, each published item whose live version's
// current ledger row names another TEXT_ENGINE (ledger.ts) than this one: a
// deploy that changes the lens (quoteMatches, normalizeTree and the rest of
// what renderVersion runs) bumps TEXT_ENGINE, and the search read (service.ts)
// then counts none of those rows as current until this re-records them
// (ARCHIVE-SEARCH S3, P1d). A row that names no engine is left alone (NULL is
// not unequal).
//
// After each batch it asks the database to queue again (0034 search_page_requeue) each
// of those items' files an audience is served a copy of and may open now, but whose
// copy has no index rows: a worker run that finished before this re-record had its
// put refused (55000), and nothing else would run it again (S1 recheck 5, N2).
//
// One process at a time: a session advisory lock. A second replica booting
// meanwhile does nothing.
//
// Its log line holds counts only, never a title or a word of text.
// ============================================================================
import type pg from 'pg';
import { inTransaction } from '../db/tx.js';
import { TEXT_ENGINE, recordItems, renderVersion } from '../ledger/ledger.js';
import { TENANT } from '../redaction/policy.js';
import { putItem } from './items.js';
import { SEARCH_AUDIENCES, SEARCH_TABLES, type SearchAudience } from './tables.js';

/** The advisory lock's name (its key is hashtext of it). */
export const BACKFILL_LOCK = 'nwfl:search_item_backfill';

export interface BackfillResult {
  /** False when another process held the lock. */
  ran: boolean;
  /** Rows written, rewritten or deleted. */
  written: number;
  /** Versions whose render is not what the ledger holds: nothing written. */
  skipped: number;
  /** Items re-recorded because a policy cell was written since their live version was, or another lens recorded it. */
  rerecorded: number;
  /** Files of those items queued for the worker again, because a copy their audience may open has no index rows. */
  requeued: number;
}

/** Items re-recorded in one transaction. */
export const RERECORD_BATCH = 25;
const NO_ITEM = '00000000-0000-0000-0000-000000000000';

/**
 * Published items after `$1` (by id, at most `$2`), with an active passage mark (search_file_servable reads the stamp
 * for no other), whose live version the app has not re-recorded for one of the audiences `$3` since the last write to
 * a policy cell.
 */
export const UNCONFIRMED_ITEMS_SQL = `SELECT i.id FROM content_item i
   WHERE i.state = 'published' AND i.live_version_id IS NOT NULL AND i.id > $1
     AND EXISTS (SELECT 1 FROM redaction_mark m
                  WHERE m.tenant_id = '${TENANT}' AND m.status = 'active' AND m.content_item_id = i.id AND m.field <> 'file')
     AND EXISTS (SELECT 1 FROM unnest($3::text[]) AS a (audience)
                  WHERE NOT EXISTS (SELECT 1 FROM version_rerecorded c
                                     WHERE c.version_id = i.live_version_id AND c.audience = a.audience
                                       AND c.seq > coalesce((SELECT e.seq FROM policy_change_epoch e), 0)))
   ORDER BY i.id LIMIT $2`;

/**
 * Published items after `$1` (by id, at most `$2`) whose live version has a current ledger row, for any audience,
 * recorded under another lens than `$3` (this TEXT_ENGINE).
 */
export const OTHER_ENGINE_ITEMS_SQL = `SELECT i.id FROM content_item i
   WHERE i.state = 'published' AND i.live_version_id IS NOT NULL AND i.id > $1
     AND EXISTS (SELECT 1 FROM publication_ledger l
                  WHERE l.tenant_id = '${TENANT}' AND l.subject_kind = 'content_version' AND l.subject_id = i.live_version_id
                    AND l.current_to IS NULL AND l.inputs ->> 'engine' <> $3)
   ORDER BY i.id LIMIT $2`;

const CURRENT = (audience: SearchAudience): string =>
  `l.tenant_id = '${TENANT}' AND l.subject_kind = 'content_version' AND l.audience = '${audience}' AND l.current_to IS NULL`;

/**
 * The versions whose row for this audience is not what the ledger says: a live version of a published item
 * given something, with no row of that sha; and a row with no current ledger output of its sha.
 */
export function staleItemsSql(audience: SearchAudience): string {
  const table = SEARCH_TABLES[audience].item;
  return `SELECT l.subject_id AS id
            FROM publication_ledger l JOIN content_item i ON i.live_version_id = l.subject_id AND i.state = 'published'
           WHERE ${CURRENT(audience)} AND l.output_sha256 IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM ${table} s WHERE s.version_id = l.subject_id AND s.rendered_sha256 = l.output_sha256)
          UNION
          SELECT s.version_id AS id
            FROM ${table} s
           WHERE NOT EXISTS (SELECT 1 FROM publication_ledger l
                              WHERE ${CURRENT(audience)} AND l.subject_id = s.version_id AND l.output_sha256 = s.rendered_sha256)
           ORDER BY id`;
}

const same = (a: Buffer | null, b: Buffer | null): boolean => (a === null || b === null ? a === b : a.equals(b));

export async function backfillItems(pool: pg.Pool, options: { batch?: number } = {}): Promise<BackfillResult> {
  const holder = await pool.connect();
  try {
    const lock = await holder.query<{ held: boolean }>(`SELECT pg_try_advisory_lock(hashtext($1)) AS held`, [BACKFILL_LOCK]);
    if (lock.rows[0]?.held !== true) return { ran: false, written: 0, skipped: 0, rerecorded: 0, requeued: 0 };
    try {
      let written = 0;
      let skipped = 0;
      for (const audience of SEARCH_AUDIENCES) {
        const stale = await holder.query<{ id: string }>(staleItemsSql(audience));
        for (const { id } of stale.rows) {
          const put = await inTransaction(pool, async (client) => {
            await client.query('SELECT publication_ledger_lock()');
            const rendering = await renderVersion(client, id, audience);
            const current = await client.query<{ output: Buffer | null }>(
              `SELECT l.output_sha256 AS output FROM publication_ledger l WHERE ${CURRENT(audience)} AND l.subject_id = $1`,
              [id],
            );
            if (!same(rendering.output, current.rows[0]?.output ?? null)) return false;
            await putItem(client, id, audience, rendering);
            return true;
          });
          if (put) written++;
          else skipped++;
        }
      }
      let rerecorded = 0;
      let requeued = 0;
      for (const [sql, third] of [
        [OTHER_ENGINE_ITEMS_SQL, TEXT_ENGINE],
        [UNCONFIRMED_ITEMS_SQL, SEARCH_AUDIENCES],
      ] as const) {
        for (let after = NO_ITEM; ; ) {
          const batch = (await holder.query<{ id: string }>(sql, [after, options.batch ?? RERECORD_BATCH, third])).rows.map((row) => row.id);
          if (batch.length === 0) break;
          await recordItems(pool, batch);
          rerecorded += batch.length;
          // After the re-record committed: a put that read the old stamp was refused and left no rows; one after it is put.
          requeued += (await holder.query<{ n: number }>(`SELECT search_page_requeue($1::uuid[]) AS n`, [batch])).rows[0]?.n ?? 0;
          after = batch.at(-1) as string;
        }
      }
      return { ran: true, written, skipped, rerecorded, requeued };
    } finally {
      await holder.query(`SELECT pg_advisory_unlock(hashtext($1))`, [BACKFILL_LOCK]);
    }
  } finally {
    holder.release();
  }
}

interface BootLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

/** The boot's call: never throws, and logs the driver's error code only (its message can echo the DSN). */
export async function runBackfill(pool: pg.Pool, logger: BootLogger): Promise<void> {
  try {
    logger.info({ ...(await backfillItems(pool)) }, 'search backfill');
  } catch (error) {
    logger.warn({ code: (error as { code?: string }).code ?? 'unknown' }, 'search backfill failed');
  }
}
