// ============================================================================
// REDACT R-LEDGER: proof of what each audience was given (0016).
//
// A row is written whenever what an audience is given for a subject changes:
//   content_version  the published item a read returns for that version: the
//                    hash is over toBinary(ContentItem) from publishedItem(),
//                    the same function GetPublishedItem calls, so the two
//                    cannot drift;
//   stored_file      the PDF bytes ReadFile serves: the original's sha256, or
//                    the current copy's; nothing while the copy is not ready,
//                    refused or hidden.
// Rows are written in the same transaction as the change (publish, withdraw,
// a mark, an applied policy change), and by the regeneration job (as its own
// role, for the file it holds, through publication_ledger_record_file: 0019)
// in the transaction that finishes the file. The append lock is taken BEFORE rendering, so a writer
// renders only once every earlier append has committed.
//
// ledgerAsOf re-renders a row from the kept history: the immutable version,
// the marks active then and the policy cells then (lens.ts), with the item's
// state from the row's manifest (items change state in place). verifyLedger
// rebuilds every row's canonical text HERE, outside the database, and walks
// the chain, the windows and the head.
//
// Nothing about a reader is recorded.
// ============================================================================
import { createHash } from 'node:crypto';
import { toBinary } from '@bufbuild/protobuf';
import pg from 'pg';
import type { Audience } from '../auth/caller.js';
import { type ItemRow, itemQuery, publishedItem } from '../content/service.js';
import type { Db } from '../db/pool.js';
import { inTransaction } from '../db/tx.js';
import { ContentItemSchema } from '../gen/nwfl/mensa/v1/content_pb.js';
import { type RedactRequest, redactPdf } from '../pdf/redact.js';
import { ENGINE_VERSION, type Inputs, inputsFor } from '../pdf/store.js';
import { loadLens, markActive, policyCells } from '../redaction/lens.js';
import { AUDIENCES, CATEGORIES, TENANT, cellKey, resolveAction } from '../redaction/policy.js';
import { subjectKey } from '../redaction/render.js';

type Query = Pick<Db, 'query'>;

/** The engine's signature (regenerate.ts). */
export type Redact = (original: Uint8Array, request: RedactRequest) => ReturnType<typeof redactPdf>;

export type LedgerKind = 'content_version' | 'stored_file';

/** The text renderer's revision: the lens (R2a, R2b) and its Unicode data. */
export const TEXT_ENGINE = 'lens-r2b+confusables-18.0.0';

/** The previous hash of the first row. */
export const GENESIS = Buffer.alloc(32);

const sha256 = (bytes: Uint8Array): Buffer => createHash('sha256').update(bytes).digest();

/** What one audience is given for one subject, and what it was made from. */
export interface Rendering {
  output: Buffer | null;
  withheld: number;
  inputs: Record<string, unknown>;
}

/** The fields a row's hash covers, as the database prints them (0016's publication_ledger_canonical). */
export interface CanonicalRow {
  seq: string;
  tenant: string;
  kind: string;
  subject: string;
  audience: string;
  output: Buffer | null;
  /** inputs::text */
  inputs: string;
  withheld: number;
  /** current_from in UTC, to the microsecond: YYYY-MM-DDTHH:MI:SS.USZ */
  from: string;
  prev: Buffer;
}

export function canonicalText(row: CanonicalRow): string {
  return [
    'nwfl-ledger-v1',
    row.seq,
    row.tenant,
    row.kind,
    row.subject,
    row.audience,
    row.output === null ? '-' : row.output.toString('hex'),
    row.inputs,
    String(row.withheld),
    row.from,
    row.prev.toString('hex'),
  ].join('\n');
}

const UTC_MICROS = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

/** Runs `fn` in one transaction: on a pool, a new one; on a client, the caller's. */
function inTx<T>(db: Query, fn: (client: Query) => Promise<T>): Promise<T> {
  return db instanceof pg.Pool ? inTransaction(db, fn) : fn(db);
}

const asOfArgs = (asOf: Date | undefined): Date[] => (asOf === undefined ? [] : [asOf]);

/** The policy cells, for the manifest: every category, fail-closed. */
async function policySnapshot(db: Query, audience: string, asOf: Date | undefined): Promise<Record<string, string>> {
  const policy = new Map((await policyCells(db, audience, asOf)).map((cell) => [cellKey(audience, cell.category), cell.action]));
  return Object.fromEntries(CATEGORIES.map((category) => [category, resolveAction(policy, audience, category)]));
}

/** The item state a re-render takes from the row it checks: items change state in place. */
export interface ItemAsOf {
  at: Date;
  itemState: string | null;
  withdrawnAt: string | null;
}

/** The published item this audience is given for the version: now, or as of a row's time. */
export async function renderVersion(db: Query, versionId: string, audience: Audience, asOf?: ItemAsOf): Promise<Rendering> {
  const query = itemQuery(audience, 'any');
  const current = asOf === undefined ? `AND i.live_version_id = v.id AND i.state IN ('published', 'withdrawn')` : '';
  const { rows } = await db.query<ItemRow>(`${query.select} WHERE v.id = $1 AND ${query.visible} ${current}`, [versionId]);
  const found = rows[0];
  const row: ItemRow | undefined =
    found === undefined || asOf === undefined
      ? found
      : asOf.itemState === null
        ? undefined
        : { ...found, state: asOf.itemState, withdrawn_at: asOf.withdrawnAt === null ? null : new Date(asOf.withdrawnAt) };
  const base = { v: 1, engine: TEXT_ENGINE, version_id: versionId };
  if (row === undefined) return { output: null, withheld: 0, inputs: { ...base, item_state: null } };
  const at = asOf?.at;
  const [lens, policy, marks] = await Promise.all([
    loadLens(db, audience, { items: [row.id], versions: [row.version_id] }, { uniform: true, ...(at === undefined ? {} : { asOf: at }) }),
    policySnapshot(db, audience, at),
    db.query<{ id: string }>(`SELECT id FROM redaction_mark WHERE tenant_id = $1 AND content_item_id = $2 AND ${markActive(at, 3)} ORDER BY id`, [
      TENANT,
      row.id,
      ...asOfArgs(at),
    ]),
  ]);
  const item = await publishedItem(db, audience, row, lens);
  const byline = row.state !== 'withdrawn' && row.on_behalf_of !== null && lens.action('member_name') !== 'show' ? 1 : 0;
  return {
    output: item === null ? null : sha256(toBinary(ContentItemSchema, item)),
    withheld: lens.withheld([subjectKey('content_item', row.id)]) + byline,
    inputs: {
      ...base,
      item_id: row.id,
      original_sha256: row.content_hash?.toString('hex') ?? null,
      item_state: row.state,
      withdrawn_at: row.withdrawn_at?.toISOString() ?? null,
      marks: marks.rows.map((mark) => mark.id),
      policy,
      image: policy['image'],
    },
  };
}

/** The PDF bytes this audience is given for the file (store.ts readPdf): now, or from the inputs at `asOf`. */
export async function renderFile(db: Query, fileId: string, audience: Audience, asOf?: Date): Promise<Rendering> {
  const [inputs, file, policy, marks] = await Promise.all([
    inputsFor(db, fileId, audience, asOf),
    db.query<{ version_id: string | null; edition_id: string | null; sha256: Buffer }>(`SELECT version_id, edition_id, sha256 FROM stored_file WHERE id = $1`, [fileId]),
    policySnapshot(db, audience, asOf),
    db.query<{ id: string }>(
      `SELECT id FROM redaction_mark WHERE tenant_id = $1 AND content_item_id IN (SELECT pdf_file_items($2)) AND ${markActive(asOf, 3)} ORDER BY id`,
      [TENANT, fileId, ...asOfArgs(asOf)],
    ),
  ]);
  const stored = file.rows[0];
  const base = {
    v: 1,
    engine: ENGINE_VERSION,
    file_id: fileId,
    version_id: stored?.version_id ?? null,
    edition_id: stored?.edition_id ?? null,
    original_sha256: stored?.sha256.toString('hex') ?? null,
    marks: marks.rows.map((mark) => mark.id),
    policy,
    image: policy['image'],
  };
  if (inputs === null || stored === undefined) return { output: null, withheld: 0, inputs: { ...base, served: 'not_found' } };
  if (inputs.kind === 'hidden') return { output: null, withheld: 0, inputs: { ...base, served: 'hidden' } };
  // The store (0015) keeps only bytes whose sha256 is the file's, and an original is never rewritten.
  if (inputs.kind === 'original') return { output: stored.sha256, withheld: 0, inputs: { ...base, served: 'original' } };
  const copy = await db.query<{ status: string; sha: Buffer | null }>(`SELECT status, sha256(bytes) AS sha FROM pdf_copy WHERE file_id = $1 AND input_hash = $2`, [
    fileId,
    inputs.hash,
  ]);
  const made = copy.rows[0];
  const served = made === undefined ? 'not_ready' : made.status === 'ready' ? 'copy' : 'refused';
  return {
    output: served === 'copy' ? (made?.sha as Buffer) : null,
    withheld: inputs.request.quotes.length,
    inputs: { ...base, input_hash: inputs.hash.toString('hex'), served },
  };
}

const RENDER: Record<LedgerKind, (db: Query, subject: string, audience: Audience) => Promise<Rendering>> = {
  content_version: (db, subject, audience) => renderVersion(db, subject, audience),
  stored_file: (db, subject, audience) => renderFile(db, subject, audience),
};

/** Renders and records every audience of these subjects; returns how many rows were appended. Holds the lock. */
async function recordSubjects(db: Query, subjects: Array<[LedgerKind, string]>): Promise<number> {
  let written = 0;
  for (const [kind, subject] of subjects) {
    for (const audience of AUDIENCES) {
      const rendering = await RENDER[kind](db, subject, audience);
      const { rows } = await db.query<{ seq: string | null }>(`SELECT publication_ledger_record($1, $2, $3, $4, $5, $6) AS seq`, [
        kind,
        subject,
        audience,
        rendering.output,
        rendering.inputs,
        rendering.withheld,
      ]);
      if (rows[0]?.seq !== null && rows[0]?.seq !== undefined) written++;
    }
  }
  return written;
}

/** The subjects already in the ledger with a current row, of one kind, narrowed by an SQL test on subject_id. */
const OPEN = (kind: LedgerKind, narrow: string): string =>
  `SELECT l.subject_id AS id FROM publication_ledger l WHERE l.tenant_id = '${TENANT}' AND l.subject_kind = '${kind}' AND l.current_to IS NULL AND ${narrow}`;

async function ids(db: Query, sql: string, values: unknown[] = []): Promise<string[]> {
  return (await db.query<{ id: string }>(`SELECT DISTINCT id FROM (${sql}) s ORDER BY id`, values)).rows.map((row) => row.id);
}

const both = (versions: string[], files: string[]): Array<[LedgerKind, string]> => [
  ...versions.map((id): [LedgerKind, string] => ['content_version', id]),
  ...files.map((id): [LedgerKind, string] => ['stored_file', id]),
];

/** Records what changed for these content items: their versions (live or still current in the ledger) and their PDF files. */
export function recordItems(db: Query, items: readonly string[]): Promise<number> {
  return inTx(db, async (client) => {
    await client.query('SELECT publication_ledger_lock()');
    const versions = await ids(
      client,
      `SELECT live_version_id AS id FROM content_item WHERE id = ANY($1::uuid[]) AND live_version_id IS NOT NULL
       UNION ${OPEN('content_version', 'l.subject_id IN (SELECT v.id FROM content_version v WHERE v.item_id = ANY($1::uuid[]))')}`,
      [items],
    );
    const files = await ids(
      client,
      `SELECT o.file_id AS id FROM pdf_original o WHERE o.file_id IN (
         SELECT f.id FROM stored_file f JOIN content_version v ON v.id = f.version_id WHERE v.item_id = ANY($1::uuid[])
         UNION SELECT f.id FROM stored_file f JOIN edition_item ei ON ei.edition_id = f.edition_id WHERE ei.item_id = ANY($1::uuid[]))`,
      [items],
    );
    return recordSubjects(client, both(versions, files));
  });
}

/**
 * The regeneration job's append (0019): every audience of the one file it holds, through
 * publication_ledger_record_file under its claim, then `finish` in the same transaction (which
 * drops the claim, so it comes last). Throws 42501 when the claim is no longer live.
 */
export function recordClaimedFile<T>(db: Query, fileId: string, claim: string, finish: (client: Query) => Promise<T>): Promise<T> {
  return inTx(db, async (client) => {
    await client.query('SELECT publication_ledger_lock()');
    for (const audience of AUDIENCES) {
      const rendering = await renderFile(client, fileId, audience);
      await client.query(`SELECT publication_ledger_record_file($1, $2, $3, $4, $5, $6)`, [
        fileId,
        claim,
        audience,
        rendering.output,
        rendering.inputs,
        rendering.withheld,
      ]);
    }
    return finish(client);
  });
}

/** Records everything a policy change can reach: every live version, every PDF, and every subject still current. */
export function recordAll(db: Query): Promise<number> {
  return inTx(db, async (client) => {
    await client.query('SELECT publication_ledger_lock()');
    const versions = await ids(client, `SELECT live_version_id AS id FROM content_item WHERE live_version_id IS NOT NULL UNION ${OPEN('content_version', 'true')}`);
    const files = await ids(client, `SELECT file_id AS id FROM pdf_original UNION ${OPEN('stored_file', 'true')}`);
    return recordSubjects(client, both(versions, files));
  });
}

export interface LedgerRowData {
  seq: string;
  subject_kind: LedgerKind;
  subject_id: string;
  audience: Audience;
  output_sha256: Buffer | null;
  inputs: Record<string, unknown>;
  passages_withheld: number;
  current_from: Date;
  current_to: Date | null;
  prev_hash: Buffer;
  row_hash: Buffer;
}

export interface AsOf {
  row: LedgerRowData | null;
  rerender: Buffer | null;
  matches: boolean;
  detail: string;
}

const same = (a: Buffer | null, b: Buffer | null): boolean => (a === null ? b === null : b !== null && a.equals(b));

/** Who asks for a copy to be made again (0016's publication_ledger_original audits it), and with which engine. */
export interface AsOfOptions {
  caller?: { sub: string; groups: readonly string[]; trace?: string | null };
  redact?: Redact;
  /** The running engine's version; a row made by another cannot be made again byte for byte. */
  engine?: string;
}

const MISMATCH = 'the re-render does not match the row';

/** Makes a copy no longer kept again: the original, the inputs as of `at`, the same engine. */
async function remake(db: Query, row: LedgerRowData, audience: Audience, at: Date, options: AsOfOptions): Promise<{ detail: string; rerender: Buffer | null }> {
  if (row.inputs['engine'] !== (options.engine ?? ENGINE_VERSION)) return { detail: 'engine changed, inputs verified only', rerender: null };
  if (options.caller === undefined) return { detail: 'the copy is no longer kept: an officer makes it again', rerender: null };
  const inputs = (await inputsFor(db, row.subject_id, audience, at)) as Extract<Inputs, { kind: 'copy' }>;
  // 0017: once the worker role exists, the app role reaches no original. Asked first, so a transaction is not aborted.
  const allowed = await db.query<{ ok: boolean }>(`SELECT has_function_privilege('publication_ledger_original(bigint, text, text[], text)', 'EXECUTE') AS ok`);
  if (allowed.rows[0]?.ok !== true) return { detail: 'the copy is no longer kept and only the worker reads originals: inputs verified only', rerender: null };
  const original = await db.query<{ bytes: Buffer }>(`SELECT publication_ledger_original($1, $2, $3, $4) AS bytes`, [
    row.seq,
    options.caller.sub,
    [...options.caller.groups],
    options.caller.trace ?? null,
  ]);
  const result = await (options.redact ?? redactPdf)(new Uint8Array((original.rows[0] as { bytes: Buffer }).bytes), inputs.request);
  if (result.kind !== 'redacted') return { detail: 'the engine refused to make the copy again', rerender: null };
  const rerender = sha256(result.pdf);
  return { detail: same(rerender, row.output_sha256) ? '' : MISMATCH, rerender };
}

/** Whether a re-render of a file row agrees with it; a copy no longer kept is made again. */
async function fileVerdict(db: Query, row: LedgerRowData, again: Rendering, audience: Audience, at: Date, options: AsOfOptions): Promise<{ detail: string; rerender: Buffer | null }> {
  const was = row.inputs['served'];
  const now = again.inputs['served'];
  const verdict = (ok: boolean): { detail: string; rerender: Buffer | null } => ({ detail: ok ? '' : MISMATCH, rerender: again.output });
  if (was === 'copy' || was === 'not_ready' || was === 'refused') {
    if (again.inputs['input_hash'] !== row.inputs['input_hash']) return { detail: 'the inputs rebuilt from the history do not match the row', rerender: again.output };
    if (was !== 'copy') return verdict(true);
    if (now === 'not_ready') return remake(db, row, audience, at, options);
    return verdict(same(again.output, row.output_sha256));
  }
  return verdict(now === was && same(again.output, row.output_sha256));
}

/** The row current at `at` for this subject and audience, rendered again from the history as of `at`. */
export async function ledgerAsOf(db: Query, kind: LedgerKind, subject: string, audience: Audience, at: Date, options: AsOfOptions = {}): Promise<AsOf> {
  const { rows } = await db.query<LedgerRowData>(
    `SELECT seq::text AS seq, subject_kind, subject_id, audience, output_sha256, inputs, passages_withheld, current_from, current_to, prev_hash, row_hash
     FROM publication_ledger
     WHERE tenant_id = $1 AND subject_kind = $2 AND subject_id = $3 AND audience = $4 AND current_from <= $5 AND (current_to IS NULL OR current_to > $5)`,
    [TENANT, kind, subject, audience, at],
  );
  const row = rows[0];
  if (row === undefined) return { row: null, rerender: null, matches: false, detail: 'no row was current then' };
  let again: Rendering;
  let verdict: { detail: string; rerender: Buffer | null };
  if (kind === 'content_version') {
    again = await renderVersion(db, subject, audience, {
      at,
      itemState: (row.inputs['item_state'] as string | null) ?? null,
      withdrawnAt: (row.inputs['withdrawn_at'] as string | null | undefined) ?? null,
    });
    verdict = { detail: same(again.output, row.output_sha256) ? '' : MISMATCH, rerender: again.output };
  } else {
    again = await renderFile(db, subject, audience, at);
    verdict = await fileVerdict(db, row, again, audience, at, options);
  }
  let detail = verdict.detail;
  if (detail === '' && again.withheld !== row.passages_withheld) detail = 'the re-render withholds a different number of passages';
  return { row, rerender: verdict.rerender, matches: detail === '', detail };
}

export interface Verification {
  intact: boolean;
  rows: number;
  /** The first row that breaks the chain; null when intact. */
  firstBreak: number | null;
  problem: string;
  head: Buffer;
}

interface ChainRow {
  seq: string;
  tenant_id: string;
  subject_kind: string;
  subject_id: string;
  audience: string;
  output_sha256: Buffer | null;
  inputs: string;
  passages_withheld: number;
  from_text: string;
  to_text: string | null;
  prev_hash: Buffer;
  row_hash: Buffer;
}

/** Walks the whole chain: each seq in turn, each link, each row's hash, each window, and the head. */
export async function verifyLedger(db: Query): Promise<Verification> {
  const [chain, heads] = await Promise.all([
    db.query<ChainRow>(
      `SELECT seq::text AS seq, tenant_id, subject_kind, subject_id::text AS subject_id, audience, output_sha256, inputs::text AS inputs,
         passages_withheld, to_char(current_from AT TIME ZONE 'UTC', ${UTC_MICROS}) AS from_text,
         to_char(current_to AT TIME ZONE 'UTC', ${UTC_MICROS}) AS to_text, prev_hash, row_hash
       FROM publication_ledger ORDER BY publication_ledger.seq`,
    ),
    db.query<{ seq: string; row_hash: Buffer }>(`SELECT seq::text AS seq, row_hash FROM publication_ledger_head`),
  ]);
  const head = heads.rows[0] as { seq: string; row_hash: Buffer };
  const broken = (seq: number, problem: string): Verification => ({ intact: false, rows: chain.rows.length, firstBreak: seq, problem, head: head.row_hash });
  let prev: Buffer = GENESIS;
  const last = new Map<string, ChainRow>();
  for (const [index, row] of chain.rows.entries()) {
    const seq = Number(row.seq);
    if (seq !== index + 1) return broken(index + 1, 'a row is missing from the chain');
    if (!row.prev_hash.equals(prev)) return broken(seq, "the previous row's hash does not match this row's link");
    const text = canonicalText({
      seq: row.seq,
      tenant: row.tenant_id,
      kind: row.subject_kind,
      subject: row.subject_id,
      audience: row.audience,
      output: row.output_sha256,
      inputs: row.inputs,
      withheld: row.passages_withheld,
      from: row.from_text,
      prev: row.prev_hash,
    });
    if (!sha256(Buffer.from(text, 'utf8')).equals(row.row_hash)) return broken(seq, "the row's hash does not match its contents");
    const key = `${row.subject_kind}:${row.subject_id}:${row.audience}`;
    const before = last.get(key);
    if (before !== undefined && before.to_text !== row.from_text) return broken(Number(before.seq), 'the window does not close where the next row for its subject opens');
    last.set(key, row);
    prev = row.row_hash;
  }
  for (const row of last.values()) if (row.to_text !== null) return broken(Number(row.seq), 'the window is closed but no later row replaces it');
  if (Number(head.seq) !== chain.rows.length || !head.row_hash.equals(prev)) return broken(Number(head.seq), 'the head does not match the last row');
  return { intact: true, rows: chain.rows.length, firstBreak: null, problem: '', head: head.row_hash };
}
