// ============================================================================
// REDACT R3b: PDF originals and their redacted copies, stored in Postgres
// (0015_pdf_store.sql), and what each audience is given.
//
// An audience's inputs for a PDF file come from its policy cells and the
// active marks on the items the file belongs to (its version's item, or the
// items its edition prints):
//
//   hidden     a mark hides the item from this audience (its category is
//              "hide", or a whole-item mark's is anything but "show");
//   original   every one of the audience's cells is "show";
//   copy       otherwise: the engine is given the marked passages this
//              audience redacts. The copy is keyed by a hash of the
//              original's sha256, those passages, the image action and the engine version, so
//              audiences given the same inputs share one copy.
//
// A read serves only the copy whose key is the inputs' hash now. There is no
// such copy until the background job (regenerate.ts) has made it: the read
// says "not ready", and never falls back to a stale copy or the original.
// ============================================================================
import { createHash } from 'node:crypto';
import type { Db } from '../db/pool.js';
import { inTransaction } from '../db/tx.js';
import { markActive, policyCells } from '../redaction/lens.js';
import { CATEGORIES, TENANT, cellKey, resolveAction } from '../redaction/policy.js';
import type { ImageAction } from './images.js';
import type { RedactRequest } from './redact.js';

type Query = Pick<Db, 'query'>;

/** The engine libraries and the gate's revision: a new one changes every key, so every copy is made again. */
export const ENGINE_VERSION = 'pdfium-2.15.1+pdf-lib-2.11.1+pdfjs-6.4.299+gate-r3b';
/** R11: a PDF original is at most 10 MiB. */
export const MAX_ORIGINAL_BYTES = 10 * 1024 * 1024;

export type Inputs = { kind: 'hidden' } | { kind: 'original' } | { kind: 'copy'; hash: Buffer; request: RedactRequest };

export type ReadResult =
  | { kind: 'pdf'; pdf: Uint8Array; original: boolean }
  | { kind: 'not_ready' }
  /** The engine or the gate refused this audience's copy; the reason is for officers. */
  | { kind: 'refused'; reason: string }
  | { kind: 'hidden' }
  | { kind: 'not_found' };

const RANK: Readonly<Record<string, number>> = { public: 0, members: 1, officers: 2 };

/** The key of a copy: the same for the same original, passages (in any order) and engine. */
const canonicalQuotes = (quotes: readonly string[]): string[] => [...new Set(quotes.map((quote) => quote.trim()).filter((quote) => quote !== ''))].sort();

export function inputHash(sha256: Uint8Array, request: RedactRequest, engine = ENGINE_VERSION): Buffer {
  const canonical = JSON.stringify({ v: 1, engine, original: Buffer.from(sha256).toString('hex'), redactsAny: request.redactsAny, quotes: canonicalQuotes(request.quotes), image: request.image ?? 'show' });
  return createHash('sha256').update(canonical).digest();
}

/**
 * What this audience is given for the file; null when the file has no stored original or is not for
 * this audience. `asOf`: from the policy and marks as they stood then (the ledger's re-render).
 */
export async function inputsFor(db: Query, fileId: string, audience: string, asOf?: Date): Promise<Inputs | null> {
  const asked = RANK[audience];
  if (asked === undefined) return null;
  const [file, cells, marks] = await Promise.all([
    db.query<{ audience: string; sha256: Buffer }>(
      `SELECT f.audience, f.sha256 FROM stored_file f WHERE f.id = $1 AND EXISTS (SELECT 1 FROM pdf_original o WHERE o.file_id = f.id)`,
      [fileId],
    ),
    policyCells(db, audience, asOf),
    db.query<{ quote: string | null; category: string }>(
      `SELECT quote, category FROM redaction_mark WHERE tenant_id = $1 AND ${markActive(asOf, 3)} AND content_item_id IN (SELECT pdf_file_items($2))`,
      [TENANT, fileId, ...(asOf === undefined ? [] : [asOf])],
    ),
  ]);
  const row = file.rows[0];
  if (row === undefined || (RANK[row.audience] as number) > asked) return null;
  const policy = new Map(cells.map((cell) => [cellKey(audience, cell.category), cell.action]));
  const action = (category: string) => resolveAction(policy, audience, category);
  if (marks.rows.some((mark) => action(mark.category) === 'hide' || (mark.quote === null && action(mark.category) !== 'show'))) return { kind: 'hidden' };
  if (CATEGORIES.every((category) => action(category) === 'show')) return { kind: 'original' };
  const quotes = canonicalQuotes(marks.rows.flatMap((mark) => (mark.quote !== null && action(mark.category) === 'redact' ? [mark.quote] : [])));
  const request: RedactRequest = { quotes, redactsAny: true, image: action('image') as ImageAction };
  return { kind: 'copy', hash: inputHash(row.sha256, request), request };
}

/** Stores a PDF file's original. The database checks who may, and that the bytes are the file's. */
export async function storeOriginal(
  db: Query,
  input: { fileId: string; bytes: Uint8Array; sub: string; groups: readonly string[]; trace?: string },
): Promise<void> {
  if (input.bytes.length > MAX_ORIGINAL_BYTES) throw new Error('the PDF is larger than 10 MiB');
  await db.query(`SELECT pdf_original_put($1, $2, $3, $4, $5)`, [input.fileId, Buffer.from(input.bytes), input.sub, [...input.groups], input.trace ?? null]);
}

/** This audience's PDF for the file, read in one snapshot. */
export function readPdf(db: Db, fileId: string, audience: string): Promise<ReadResult> {
  return inTransaction(db, async (tx): Promise<ReadResult> => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const inputs = await inputsFor(tx, fileId, audience);
    if (inputs === null) return { kind: 'not_found' };
    if (inputs.kind === 'hidden') return inputs;
    if (inputs.kind === 'original') {
      const original = await tx.query<{ bytes: Buffer }>(`SELECT pdf_original_read($1, $2) AS bytes`, [fileId, audience]);
      return { kind: 'pdf', pdf: new Uint8Array((original.rows[0] as { bytes: Buffer }).bytes), original: true };
    }
    const copy = await tx.query<{ status: string; bytes: Buffer | null; reason: string | null }>(
      `SELECT status, bytes, reason FROM pdf_copy WHERE file_id = $1 AND input_hash = $2`,
      [fileId, inputs.hash],
    );
    const row = copy.rows[0];
    if (row === undefined) return { kind: 'not_ready' };
    if (row.status === 'ready') return { kind: 'pdf', pdf: new Uint8Array(row.bytes as Buffer), original: false };
    return { kind: 'refused', reason: row.reason as string };
  });
}
