// ============================================================================
// ARCHIVE-SEARCH S2: the issue text in the search index (the two page tables
// of 0032, with 0033's functions). The PDF worker's job, as nwfl_worker.
//
// What is indexed for an audience is the text of the COPY that audience is
// served now, and nothing else (finding F1):
//
//   * the copy is found as a read finds it (pdf/regenerate.ts copyInputs: the
//     audience's own policy, marks and links), so an audience that is served
//     the original, nothing, or a refusal has no text here;
//   * its text is read by the gate, never in this process (pdf/worker.ts
//     workerText), from those very bytes, and the reading is given what the
//     audience withholds: it gives no text for a copy in which it still finds
//     a withheld passage (pdf/gate-text.ts);
//   * the rows are written by search_page_put alone, which takes them only
//     while the publication ledger says this audience is served the copy with
//     this sha256. A change that lands while a copy is being read leaves no
//     row ("stale"): the worker indexes the next copy when it has made it.
//
// This module names no table. It never reads content_version's own search
// columns: they are derived at approval and hold passages a mark withholds.
//
// When it runs (pdf/worker.ts runWorker):
//   * indexFile, after each regeneration run that finished;
//   * indexSweeper, a batch after each drain until it is through: first
//     search_page_sweep() deletes every row whose copy its audience is served
//     no longer, then search_page_lacking(TEXT_VERSION) lists each served copy
//     with no rows at this version, and those are read. So a first deploy, a
//     put that was lost, and a new TEXT_VERSION are all made good at the next
//     start, a few files at a time between the copies' own runs.
//
// A reading that fails (the gate cannot be asked, the child ran out of time or
// memory, the copy is over a cap) writes nothing and deletes nothing: the rows
// there stay as they were, and the next start tries again. Every failure is
// logged by file, audience and code. The text itself is never logged, and no
// error's message is: a message could hold a page's words.
// ============================================================================
import type { Db, Warn } from '../db/pool.js';
import { sha256Hex } from '../pdf/engine-protocol.js';
import type { TextOutcome } from '../pdf/gate-isolated.js';
import { copyInputs } from '../pdf/regenerate.js';
import type { TextRequest } from '../pdf/text-protocol.js';
import { SEARCH_AUDIENCES, type SearchAudience } from './tables.js';
import { type PageText, TEXT_VERSION } from './text.js';

type Query = Pick<Db, 'query'>;

/** Reads the text of a copy's pages, outside this process: the gate sidecar, or the gate's capped child. */
export type Texter = (job: TextRequest) => Promise<TextOutcome>;

export interface IndexOptions {
  text: Texter;
  /** What the copies' links point to (LINK_ORIGIN's, or the site's, when absent): part of what names a copy. */
  origin?: string;
  /** The line-end rule's revision (default TEXT_VERSION); another, for tests. */
  textVersion?: number;
  /** Hears a copy that was not indexed and why, by file, audience and code. */
  warn?: Warn;
  /** Which audiences to index (default both). */
  audiences?: readonly SearchAudience[];
}

/**
 * What became of one audience's index of a file: `indexed` (its pages were put); `not-a-copy` (the audience is served
 * no copy of it now); `no-text` (the reading gave none: `code`); `stale` (what the audience is served changed
 * meanwhile, and the put was refused); `failed` (the database could not be asked, or refused the pages: `code`).
 */
export interface Indexed {
  audience: SearchAudience;
  outcome: 'indexed' | 'not-a-copy' | 'no-text' | 'stale' | 'failed';
  pages?: number;
  code?: string;
}

/** How many copies the sweep reads after one drain. */
export const SWEEP_BATCH = 10;

type Reading = { kind: 'none' } | { kind: 'no-text'; fields: { code: string; cause?: string } } | { kind: 'text'; sha256: Buffer; pages: PageText[] };

/** An error's code, if it has one: never its message. */
const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'failed';
};

/** The stored copy for these inputs, read by `text`: its sha256 and its pages, or why there are none. */
async function read(db: Query, fileId: string, hash: Buffer, quotes: readonly string[], text: Texter): Promise<Reading> {
  const copy = await db.query<{ status: string; bytes: Buffer | null }>(`SELECT status, bytes FROM pdf_copy WHERE file_id = $1 AND input_hash = $2`, [fileId, hash]);
  const row = copy.rows[0];
  if (row === undefined || row.status !== 'ready' || row.bytes === null) return { kind: 'none' };
  const bytes = new Uint8Array(row.bytes);
  const sha256 = sha256Hex(bytes);
  let outcome: TextOutcome;
  try {
    outcome = await text({ copy: bytes, sha256, quotes });
  } catch (error) {
    return { kind: 'no-text', fields: { code: codeOf(error) } };
  }
  if ('code' in outcome) return { kind: 'no-text', fields: { code: outcome.code, ...('cause' in outcome && outcome.cause !== undefined ? { cause: outcome.cause } : {}) } };
  // Text of other bytes than the ones this audience is served is text of nothing.
  if (outcome.sha256 !== sha256) return { kind: 'no-text', fields: { code: 'mismatch' } };
  return { kind: 'text', sha256: Buffer.from(sha256, 'hex'), pages: outcome.pages };
}

/**
 * Indexes the text of the copy each audience is served of one file. A copy two audiences share is read once. Never
 * rejects: what happened is in the result, and every copy not indexed for a reason other than a change is heard by `warn`.
 */
export async function indexFile(db: Query, fileId: string, options: IndexOptions): Promise<Indexed[]> {
  const textVersion = options.textVersion ?? TEXT_VERSION;
  const readings = new Map<string, Reading>();
  const results: Indexed[] = [];
  for (const audience of options.audiences ?? SEARCH_AUDIENCES) {
    const skipped = (outcome: 'no-text' | 'failed', fields: { code: string; cause?: string }): Indexed => {
      options.warn?.({ file_id: fileId, audience, ...fields }, 'a PDF copy was not indexed');
      return { audience, outcome, code: fields.code };
    };
    try {
      const inputs = await copyInputs(db, fileId, audience, options.origin);
      if (inputs === null) {
        results.push({ audience, outcome: 'not-a-copy' });
        continue;
      }
      const key = inputs.hash.toString('hex');
      const reading = readings.get(key) ?? (await read(db, fileId, inputs.hash, inputs.quotes, options.text));
      readings.set(key, reading);
      if (reading.kind === 'none') results.push({ audience, outcome: 'not-a-copy' });
      else if (reading.kind === 'no-text') results.push(skipped('no-text', reading.fields));
      else {
        try {
          await db.query(`SELECT search_page_put($1, $2, $3, $4, $5::text[], $6::text[])`, [fileId, audience, reading.sha256, textVersion, reading.pages.map((page) => page.text), reading.pages.map((page) => page.extra)]);
          results.push({ audience, outcome: 'indexed', pages: reading.pages.length });
        } catch (error) {
          // 55000: the ledger no longer says this audience is served this copy. Not a fault: the next copy is indexed when it is made.
          if ((error as { code?: string }).code === '55000') results.push({ audience, outcome: 'stale' });
          else results.push(skipped('failed', { code: codeOf(error) }));
        }
      }
    } catch (error) {
      results.push(skipped('failed', { code: codeOf(error) }));
    }
  }
  return results;
}

/** What one step of the sweep did: rows deleted, copies indexed, and how many are still to read. */
export interface SweepStep {
  deleted: number;
  indexed: number;
  left: number;
}

/**
 * The index's sweep, a step at a time (pdf/regenerate.ts startRegenerator's `after`). The first step deletes the rows
 * of copies served no longer (search_page_sweep) and lists every served copy with no rows at this text version
 * (search_page_lacking); that step and each one after it reads at most `batch` of them. Once none is left a step does
 * nothing: the next start sweeps again. A step that cannot list rejects, and the next one lists again.
 */
export function indexSweeper(db: Query, options: IndexOptions & { batch?: number }): () => Promise<SweepStep> {
  const textVersion = options.textVersion ?? TEXT_VERSION;
  const batch = options.batch ?? SWEEP_BATCH;
  let pending: Array<{ fileId: string; audience: SearchAudience }> | null = null;
  return async () => {
    let deleted = 0;
    if (pending === null) {
      const swept = await db.query<{ n: number }>(`SELECT search_page_sweep() AS n`);
      const lacking = await db.query<{ file_id: string; audience: string }>(`SELECT file_id, audience FROM search_page_lacking($1)`, [textVersion]);
      deleted = swept.rows[0]?.n ?? 0;
      pending = lacking.rows.flatMap((row) => {
        const audience = SEARCH_AUDIENCES.find((known) => known === row.audience);
        return audience === undefined ? [] : [{ fileId: row.file_id, audience }];
      });
    }
    let indexed = 0;
    for (const { fileId, audience } of pending.splice(0, batch)) {
      const [result] = await indexFile(db, fileId, { ...options, audiences: [audience] });
      if (result?.outcome === 'indexed') indexed++;
    }
    return { deleted, indexed, left: pending.length };
  };
}
