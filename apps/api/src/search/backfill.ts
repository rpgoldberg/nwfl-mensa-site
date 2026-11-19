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
// One process at a time: a session advisory lock. A second replica booting
// meanwhile does nothing.
//
// Its log line holds counts only, never a title or a word of text.
// ============================================================================
import type pg from 'pg';
import { inTransaction } from '../db/tx.js';
import { renderVersion } from '../ledger/ledger.js';
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
}

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

export async function backfillItems(pool: pg.Pool): Promise<BackfillResult> {
  const holder = await pool.connect();
  try {
    const lock = await holder.query<{ held: boolean }>(`SELECT pg_try_advisory_lock(hashtext($1)) AS held`, [BACKFILL_LOCK]);
    if (lock.rows[0]?.held !== true) return { ran: false, written: 0, skipped: 0 };
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
      return { ran: true, written, skipped };
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
