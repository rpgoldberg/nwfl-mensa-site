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
//
// LINKS L3: a copy's inputs also name the links it may carry (0024): the
// file's links active then (the latest status at or before `asOf`), less any
// whose target holds one of the passages this audience redacts
// (load/links.ts targetHolds, the loader's own check, per audience), each with
// its id, page, rect (to hundredths of a point) and label ("Link to <host>"),
// and the origin they point to (LINK_ORIGIN). inputHash v2 covers both, each
// link with its url, so a link turned off, a mark that now holds a target, or
// a new origin remakes the copy (the worker's boot sweep, regenerate.ts).
// ============================================================================
import { createHash } from 'node:crypto';
import type { Db } from '../db/pool.js';
import { inTransaction } from '../db/tx.js';
import { markActive, policyCells } from '../redaction/lens.js';
import { CATEGORIES, TENANT, cellKey, resolveAction } from '../redaction/policy.js';
import { targetHolds, wideEnough } from '../load/links.js';
import type { ImageAction } from './images.js';
import { DEFAULT_LINK_ORIGIN, type EngineLink, type Rect, linkLabel, linkOrigin, roundRect } from './link-annots.js';
import type { RedactRequest } from './redact.js';

type Query = Pick<Db, 'query'>;

/**
 * The engine libraries and the gate's and the boxes' revisions: a new one changes every key, so every
 * copy is made again (box-exact: REDACT-LOOK's exact-fit boxes; links-1: LINKS L3's link annotations).
 * The ledger reports an older row's engine as changed rather than re-render it (ledger.ts fileVerdict).
 */
export const ENGINE_VERSION = 'pdfium-2.15.1+pdf-lib-2.11.1+pdfjs-6.4.299+gate-r3b+box-exact+links-1';
export { DEFAULT_LINK_ORIGIN, linkOrigin };
/** R11: a PDF original is at most 10 MiB. */
export const MAX_ORIGINAL_BYTES = 10 * 1024 * 1024;

/** What a copy is made from: the engine's request, its links always listed (none for a file with no links). */
export type CopyRequest = RedactRequest & { links: readonly EngineLink[] };
export type Inputs = { kind: 'hidden' } | { kind: 'original' } | { kind: 'copy'; hash: Buffer; request: CopyRequest };

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

/**
 * The text a copy's key is the hash of (v 2): the engine, the original's sha256, redactsAny, the quotes, the image
 * action, the origin (LINK_ORIGIN's when the request has none) and the links sorted by id, each with its url
 * (`urls`, by id: the engine is never given it) and its rect to hundredths.
 */
export function canonicalInputs(sha256: Uint8Array, request: RedactRequest, engine = ENGINE_VERSION, urls: Readonly<Record<string, string>> = {}): string {
  const links = [...(request.links ?? [])]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((link) => {
      const url = urls[link.id];
      if (url === undefined) throw new Error('every link needs its url to be hashed');
      return { id: link.id, page: link.page, rect: [...roundRect(link.rect)], url, label: link.label };
    });
  return JSON.stringify({
    v: 2,
    engine,
    original: Buffer.from(sha256).toString('hex'),
    redactsAny: request.redactsAny,
    quotes: canonicalQuotes(request.quotes),
    image: request.image ?? 'show',
    origin: request.origin ?? linkOrigin(),
    links,
  });
}

export function inputHash(sha256: Uint8Array, request: RedactRequest, engine = ENGINE_VERSION, urls: Readonly<Record<string, string>> = {}): Buffer {
  return createHash('sha256').update(canonicalInputs(sha256, request, engine, urls)).digest();
}

/** The file's links active at `asOf` (now when absent): the latest status at or before it, ties to the later one. */
async function activeLinks(db: Query, fileId: string, asOf?: Date): Promise<Array<{ id: string; page: number; rect: number[]; url: string; host: string }>> {
  const at = asOf === undefined ? '' : ' AND s.at <= $2';
  const { rows } = await db.query<{ id: string; page: number; rect: number[]; url: string; host: string }>(
    `SELECT l.id, l.page, l.rect, l.url, l.host FROM pdf_link l
      WHERE l.file_id = $1${asOf === undefined ? '' : ' AND l.created_at <= $2'}
        AND (SELECT s.status FROM pdf_link_status s WHERE s.link_id = l.id${at} ORDER BY s.at DESC, s.id DESC LIMIT 1) = 'active'
      ORDER BY l.id`,
    [fileId, ...(asOf === undefined ? [] : [asOf])],
  );
  return rows;
}

/**
 * What this audience is given for the file; null when the file has no stored original or is not for
 * this audience. `asOf`: from the policy and marks as they stood then (the ledger's re-render). `origin` and
 * `engine`: what the copy would be made with (LINK_ORIGIN's and this engine's, unless the ledger asks otherwise).
 */
export async function inputsFor(db: Query, fileId: string, audience: string, asOf?: Date, origin = linkOrigin(), engine = ENGINE_VERSION): Promise<Inputs | null> {
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
  // Each link whose target holds none of this audience's passages, as the loader checks them (CONTRACT item 5), and
  // whose rect is a hundredth of a point wide and high once rounded (fix 1, N4: one attached before 0025's CHECK).
  const passing = (await activeLinks(db, fileId, asOf)).filter((link) => wideEnough(link.rect as unknown as Rect) && !targetHolds(link.url, quotes));
  const links: EngineLink[] = passing.map((link) => ({ id: link.id, page: link.page, rect: roundRect(link.rect as unknown as Rect), label: linkLabel(link.host) }));
  const urls = Object.fromEntries(passing.map((link) => [link.id, link.url]));
  const request: CopyRequest = { quotes, redactsAny: true, image: action('image') as ImageAction, origin, links };
  return { kind: 'copy', hash: inputHash(row.sha256, request, engine, urls), request };
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
