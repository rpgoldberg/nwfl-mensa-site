// ============================================================================
// MLOGIN S3: the newsletter issue loader.
//
//   node dist/load/cli.js -      the bundle on stdin; DATABASE_URL (or PG*) as for the service
//
// One issue of Pensa Mensa becomes ONE public-visibility DOCUMENT item (P12)
// with two PDFs on its one version:
//   audience public    the public original. The public is only ever given a
//                      redacted copy of it (store.ts, 0012's default policy).
//   audience members   the full issue. The public is told NOT_FOUND, exactly
//                      as for a missing file; members get a copy with the
//                      member_address marks redacted; officers the original.
// One set of marks, on the item, covers both files (0015 pdf_file_items).
//
// Rules, each enforced here (PLAN-r2 section 3):
//   - The bundle arrives on stdin and nowhere else: no path, URL or mount is
//     ever read, so no Secret, ConfigMap, image or repo holds a PDF or the
//     marks (S-4). In production mode (NODE_ENV=production, as the image
//     sets it) stdin must be a pipe or a socket, the attached stdin of a
//     Job: a file redirected into it, a terminal or a device is refused.
//   - Known fields only, as own keys. The title, summary, slug and filenames
//     are built here from the period, volume and number, so no free text,
//     and so no personal data, reaches them (the S4 contract).
//   - Refused before the database: a public file with no marks, a marks
//     hash other than the approved one, a PDF over 10 MiB (or not a PDF),
//     and a mark category outside the personal-data categories. Marks carry
//     only their true category (S-3): nothing members-only is a mark.
//   - Refused in the database, in the same transaction, so nothing lands: a
//     public copy whose inputs (store.ts inputHash: the original's sha256,
//     the passages the public policy redacts, the image action, the engine
//     version) are not the approved ones.
//   - The marks are file marks (0020): each is anchored in the PDFs whose
//     text layer holds its quote (redaction/file-marks.ts), so the lens shows
//     the issue while the PDF engine withholds the passages. A quote in
//     neither PDF is refused (fail closed), named by its place, not its text.
//   - The writer is system:issue-loader, with no groups: pdf_original_put
//     (0015) and redaction_mark_add_file (0020) accept the version's writer,
//     so no officer's claim is ever made or audited. The approval is
//     self_breakglass, its reason naming the operator's approval reference,
//     the marks hash and the public input hash; it goes through the
//     workflow's own ready and approval writes (content/workflow.ts), so the
//     two cannot drift (N-7).
//   - One transaction: all of it lands, or none of it.
//   - Idempotent: the item by its slug, the files by sha256 and audience,
//     the marks as a set. File ids are random, never derived (N10). An issue
//     already loaded differently, or a slug held by anything the loader did
//     not write, is refused: the loader never revises an issue.
//   - It prints ids and counts only, never a quote, and a driver error by
//     its code only.
//   - Anchoring reads the stored originals as officers do
//     (pdf_original_read): while the officers' policy does not show every
//     category, the load fails and nothing is applied.
// ============================================================================
import { createHash, randomUUID } from 'node:crypto';
import { recordAudit } from '../audit/audit.js';
import type { Caller } from '../auth/caller.js';
import { canonicalJson } from '../content/hash.js';
import { type VersionRow, addEditor, applyApproval, readyVersion } from '../content/workflow.js';
import { type Db, type Env, createPool } from '../db/pool.js';
import { type TxClient, inTransaction } from '../db/tx.js';
import { MAX_ORIGINAL_BYTES, inputsFor, storeOriginal } from '../pdf/store.js';
import { FileMarkError, addFileMarks } from '../redaction/file-marks.js';

export class LoadError extends Error {
  override name = 'LoadError';
}

/** The writer, approver and storer of every loaded issue. */
export const LOADER = 'system:issue-loader';
/** The personal-data categories a mark may carry (0014's list without business_venue, which is not personal data). */
export const MARK_CATEGORIES = ['member_name', 'member_address', 'member_phone', 'member_email', 'private_venue', 'officer_contact'] as const;
export type MarkCategory = (typeof MARK_CATEGORIES)[number];
/** Two 10 MiB PDFs in base64 and the marks fit well inside this. */
export const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
export const MAX_MARKS = 1000;
export const FORMAT = 'nwfl-issue/1';

export interface Mark {
  quote: string;
  category: MarkCategory;
}

export interface Issue {
  /** The first month of the issue, YYYY-MM. */
  period: string;
  volume: number;
  number: number;
}

export interface Bundle {
  issue: Issue;
  /** The slug of the office the issue is posted as. */
  office: string;
  approval: { reference: string; marksSha256: string; publicInputHash: string; membersSha256: string };
  pdfs: { public: Uint8Array; members: Uint8Array };
  marks: Mark[];
}

export type StdinKind = 'pipe' | 'socket' | 'file' | 'device' | 'other';

export interface Stdin {
  kind: StdinKind;
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
}

export interface LoadResult {
  status: 'loaded' | 'unchanged';
  itemId: string;
  publicFileId: string;
  membersFileId: string;
  marks: number;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The S4 contract: built from the period, volume and number alone, so it can carry no personal data. */
export function issueContract(issue: Issue): { slug: string; title: string; summary: string } {
  const [year, month] = issue.period.split('-').map(Number) as [number, number];
  return {
    slug: `pensa-mensa-${issue.period}`,
    title: `Pensa Mensa, ${MONTHS[month - 1] as string}-${MONTHS[month] as string} ${year}`,
    summary: `Volume ${issue.volume}, Number ${issue.number}`,
  };
}

/** The marks' hash, as Ross approves it at H7: SHA-256 of the canonical JSON of the marks, sorted by category, then quote. */
export function marksSha256(marks: readonly Mark[]): string {
  const sorted = marks
    .map((mark) => ({ category: mark.category, quote: mark.quote }))
    .sort((a, b) => (a.category === b.category ? (a.quote < b.quote ? -1 : a.quote > b.quote ? 1 : 0) : a.category < b.category ? -1 : 1));
  return createHash('sha256').update(canonicalJson({ v: 1, marks: sorted })).digest('hex');
}

const HEX64 = /^[0-9a-f]{64}$/;
// One character class, no groups: linear on a 14 MB string, where a grouped pattern overflows the regex stack.
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

type Json = Record<string, unknown>;

function object(value: unknown, where: string): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new LoadError(`${where} must be a JSON object`);
  return value as Json;
}

/** Own keys only, each one known: __proto__, constructor and the like are unknown fields like any other. */
function known(json: Json, where: string, keys: readonly string[]): void {
  for (const key of Object.keys(json)) if (!keys.includes(key)) throw new LoadError(`${where}: unknown field ${key}`);
}

const own = (json: Json, key: string): unknown => (Object.hasOwn(json, key) ? json[key] : undefined);

function wholeNumber(value: unknown, where: string, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) throw new LoadError(`${where} must be a whole number from 1 to ${max}`);
  return value;
}

function matching(value: unknown, pattern: RegExp, where: string, what: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new LoadError(`${where} must be ${what}`);
  return value;
}

function pdf(value: unknown, where: string): Uint8Array {
  if (typeof value !== 'string' || value === '' || value.length % 4 !== 0 || !BASE64.test(value)) throw new LoadError(`${where} must be a PDF in base64`);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > MAX_ORIGINAL_BYTES) throw new LoadError(`${where} is larger than 10 MiB`);
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new LoadError(`${where} is not a PDF`);
  return new Uint8Array(bytes);
}

function marksOf(value: unknown): Mark[] {
  if (!Array.isArray(value)) throw new LoadError('marks must be a list');
  if (value.length === 0) throw new LoadError('the bundle has no marks: a public file is never loaded without them');
  if (value.length > MAX_MARKS) throw new LoadError(`a bundle holds at most ${MAX_MARKS} marks`);
  const seen = new Set<string>();
  return value.map((entry, n): Mark => {
    const where = `marks[${n}]`;
    const mark = object(entry, where);
    known(mark, where, ['quote', 'category']);
    const quote = own(mark, 'quote');
    // 0014: trimmed, 3 to 500 characters. The quote is never repeated in a refusal.
    if (typeof quote !== 'string' || quote !== quote.trim() || [...quote].length < 3 || [...quote].length > 500) {
      throw new LoadError(`${where}.quote must be 3 to 500 characters, with no space at either end`);
    }
    const category = own(mark, 'category');
    if (typeof category !== 'string' || !(MARK_CATEGORIES as readonly string[]).includes(category)) {
      throw new LoadError(`${where}.category must be one of ${MARK_CATEGORIES.join(', ')}`);
    }
    if (seen.has(quote)) throw new LoadError(`${where}: the same quote is marked twice`);
    seen.add(quote);
    return { quote, category: category as MarkCategory };
  });
}

/** A bundle, checked whole before anything touches the database. */
export function parseBundle(input: unknown): Bundle {
  const json = object(input, 'the bundle');
  known(json, 'the bundle', ['format', 'issue', 'office', 'approval', 'pdfs', 'marks']);
  if (own(json, 'format') !== FORMAT) throw new LoadError(`the bundle's format must be ${FORMAT}`);

  const issueJson = object(own(json, 'issue'), 'issue');
  known(issueJson, 'issue', ['period', 'volume', 'number']);
  const period = matching(own(issueJson, 'period'), /^[0-9]{4}-(0[1-9]|1[0-2])$/, 'issue.period', 'the first month, YYYY-MM');
  // The S4 title names two months of one year; a December issue runs into the next year.
  if (period.endsWith('-12')) throw new LoadError('issue.period: a December-January issue spans two years, which the S4 title contract cannot name yet');
  const issue: Issue = { period, volume: wholeNumber(own(issueJson, 'volume'), 'issue.volume', 999), number: wholeNumber(own(issueJson, 'number'), 'issue.number', 12) };

  const office = matching(own(json, 'office'), /^[a-z0-9][a-z0-9-]{0,62}$/, 'office', "an office's slug");

  const approvalJson = object(own(json, 'approval'), 'approval');
  known(approvalJson, 'approval', ['reference', 'marksSha256', 'publicInputHash', 'membersSha256']);
  const approval = {
    // A reply tag (PUBCOPY, ML-H7): no free text, so no name.
    reference: matching(own(approvalJson, 'reference'), /^[A-Z][A-Z0-9-]{1,39}$/, 'approval.reference', 'a reply tag: capital letters, digits and hyphens'),
    marksSha256: matching(own(approvalJson, 'marksSha256'), HEX64, 'approval.marksSha256', '64 lower-case hex digits'),
    publicInputHash: matching(own(approvalJson, 'publicInputHash'), HEX64, 'approval.publicInputHash', '64 lower-case hex digits'),
    // The members PDF has no copy hash to approve: its own sha256 binds it.
    membersSha256: matching(own(approvalJson, 'membersSha256'), HEX64, 'approval.membersSha256', '64 lower-case hex digits'),
  };

  const pdfsJson = object(own(json, 'pdfs'), 'pdfs');
  known(pdfsJson, 'pdfs', ['public', 'members']);
  const pdfs = { public: pdf(own(pdfsJson, 'public'), 'pdfs.public'), members: pdf(own(pdfsJson, 'members'), 'pdfs.members') };
  const members = sha256(pdfs.members).toString('hex');
  if (members !== approval.membersSha256) throw new LoadError(`the members PDF is not the approved one: its sha256 is ${members}`);

  const marks = marksOf(own(json, 'marks'));
  const computed = marksSha256(marks);
  if (computed !== approval.marksSha256) throw new LoadError(`the marks are not the approved ones: their sha256 is ${computed}`);
  return { issue, office, approval, pdfs, marks };
}

/** What stdin is, from its fstat. */
export function stdinKind(stat: { isFIFO(): boolean; isSocket(): boolean; isFile(): boolean; isCharacterDevice(): boolean }): StdinKind {
  if (stat.isFIFO()) return 'pipe';
  if (stat.isSocket()) return 'socket';
  if (stat.isFile()) return 'file';
  if (stat.isCharacterDevice()) return 'device';
  return 'other';
}

async function readCapped(chunks: Stdin['chunks']): Promise<Buffer> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of chunks) {
    size += chunk.length;
    if (size > MAX_BUNDLE_BYTES) throw new LoadError('the bundle is larger than 32 MiB');
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts);
}

/** The loader as the audit log's actor: audit.ts records a caller that holds no token as the system. */
const LOADER_CALLER: Caller = Object.freeze({ kind: 'anonymous', subject: LOADER, groups: Object.freeze([]), scopes: Object.freeze([]), audience: 'public' });
const FILE_AUDIENCES = ['public', 'members'] as const;
const sha256 = (bytes: Uint8Array): Buffer => createHash('sha256').update(bytes).digest();

/** The self_breakglass reason: the operator's approval reference and the three hashes approved with it. */
const approvalReason = (approval: Bundle['approval']): string =>
  `Issue loader, approved as ${approval.reference}: marks sha256 ${approval.marksSha256}, public inputHash ${approval.publicInputHash}, members sha256 ${approval.membersSha256}`;

interface Existing {
  id: string;
  kind: string;
  state: string;
  working_version_id: string | null;
  live_version_id: string | null;
  /** The live version's writer; null with no live version. */
  created_by_sub: string | null;
}

/** A repeated run: the issue as loaded must be the bundle's, file for file (by sha256) and mark for mark, or it is refused. */
async function unchanged(client: TxClient, bundle: Bundle, slug: string, existing: Existing): Promise<LoadResult> {
  if (existing.kind !== 'document' || existing.created_by_sub !== LOADER) throw new LoadError(`${slug} already exists and was not written by the loader: it is never touched`);
  const files = (
    await client.query<{ id: string; audience: string; sha256: Buffer }>(
      `SELECT f.id, f.audience, f.sha256 FROM stored_file f WHERE f.version_id = $1 AND EXISTS (SELECT 1 FROM pdf_original o WHERE o.file_id = f.id)`,
      [existing.live_version_id],
    )
  ).rows;
  const found = (audience: string, bytes: Uint8Array) => files.find((file) => file.audience === audience && file.sha256.equals(sha256(bytes)));
  const publicFile = found('public', bundle.pdfs.public);
  const membersFile = found('members', bundle.pdfs.members);
  const marks = (await client.query<Mark>(`SELECT quote, category FROM redaction_mark WHERE content_item_id = $1 AND status = 'active'`, [existing.id])).rows;
  if (
    existing.state !== 'published' ||
    existing.working_version_id !== null ||
    files.length !== 2 ||
    publicFile === undefined ||
    membersFile === undefined ||
    marksSha256(marks) !== marksSha256(bundle.marks)
  ) {
    throw new LoadError(`${slug} is already loaded, and its files, marks or state differ from the bundle's: the loader never revises an issue`);
  }
  return { status: 'unchanged', itemId: existing.id, publicFileId: publicFile.id, membersFileId: membersFile.id, marks: marks.length };
}

/** A first run: the item, its version, both files and their originals, the marks, the check against the approval, ready, approved. */
async function loadIssue(client: TxClient, bundle: Bundle, contract: ReturnType<typeof issueContract>): Promise<LoadResult> {
  const office = (await client.query<{ id: string }>(`SELECT id FROM office WHERE slug = $1`, [bundle.office])).rows[0];
  if (office === undefined) throw new LoadError(`unknown office '${bundle.office}'`);
  const itemId = (await client.query<{ id: string }>(`INSERT INTO content_item (slug, kind, office_id) VALUES ($1, 'document', $2) RETURNING id`, [contract.slug, office.id])).rows[0]!.id;
  // Public visibility, on the website only: never the newsletter or email, so ExportEdition never picks it up.
  let version = (
    await client.query<VersionRow>(
      `INSERT INTO content_version (item_id, n, title, summary, visibility, created_by_sub, acting_office_id, target_website, target_newsletter, target_email)
       VALUES ($1, 1, $2, $3, 'public', $4, $5, true, false, false) RETURNING *`,
      [itemId, contract.title, contract.summary, LOADER, office.id],
    )
  ).rows[0] as VersionRow;
  await addEditor(client, version.id, LOADER);
  await client.query(`UPDATE content_item SET working_version_id = $2 WHERE id = $1`, [itemId, version.id]);
  const common = { itemId, versionId: version.id };
  await recordAudit(client, LOADER_CALLER, { ...common, action: 'create', subjectKind: 'content_item', subjectId: itemId, toState: 'draft', actingOfficeId: office.id });

  // Both files before approval (an approved version's files are frozen, 0011). Random ids, never derived.
  const ids = { public: randomUUID(), members: randomUUID() };
  for (const audience of FILE_AUDIENCES) {
    const bytes = bundle.pdfs[audience];
    await client.query(
      `INSERT INTO stored_file (id, version_id, object_key, filename, mime_type, size_bytes, sha256, audience) VALUES ($1, $2, $3, $4, 'application/pdf', $5, $6, $7)`,
      [ids[audience], version.id, `pdf_original/${ids[audience]}`, audience === 'public' ? `${contract.slug}.pdf` : `${contract.slug}-members.pdf`, bytes.length, sha256(bytes), audience],
    );
    await recordAudit(client, LOADER_CALLER, { ...common, action: 'file_added', subjectKind: 'stored_file', subjectId: ids[audience], payload: { audience } });
  }
  // As the version's writer, with no groups (0015 pdf_original_put, 0020 redaction_mark_add_file).
  for (const audience of FILE_AUDIENCES) await storeOriginal(client, { fileId: ids[audience], bytes: bundle.pdfs[audience], sub: LOADER, groups: [] });
  await addFileMarks(client, { itemId, marks: bundle.marks, sub: LOADER, groups: [] }).catch((error: unknown) => {
    throw error instanceof FileMarkError ? new LoadError(error.message) : error;
  });

  // What the public will be given, from the policy and the marks as they now stand in this transaction.
  const inputs = await inputsFor(client, ids.public, 'public');
  const computed = inputs?.kind === 'copy' ? inputs.hash.toString('hex') : 'none';
  if (computed !== bundle.approval.publicInputHash) throw new LoadError(`the public copy's inputs are not the approved ones: computed ${computed}`);

  version = await readyVersion(client, { id: itemId, state: 'draft' }, version, { targets: { website: true, newsletter: false, email: false }, editionId: null, printAsIs: false });
  await recordAudit(client, LOADER_CALLER, {
    ...common,
    action: 'ready',
    subjectKind: 'content_version',
    subjectId: version.id,
    contentHash: version.content_hash,
    fromState: 'draft',
    toState: 'ready',
    actingOfficeId: office.id,
  });
  const reason = approvalReason(bundle.approval);
  await applyApproval(client, LOADER_CALLER, { id: itemId, live_version_id: null }, version, { kind: 'self_breakglass', reason });
  return { status: 'loaded', itemId, publicFileId: ids.public, membersFileId: ids.members, marks: bundle.marks.length };
}

/** Loads the issue in one transaction, or finds it already loaded exactly so. A LoadError leaves nothing behind. */
export function applyBundle(db: Db, bundle: Bundle): Promise<LoadResult> {
  const contract = issueContract(bundle.issue);
  return inTransaction(db, async (client) => {
    const existing = (
      await client.query<Existing>(
        `SELECT i.id, i.kind, i.state, i.working_version_id, i.live_version_id, v.created_by_sub
         FROM content_item i LEFT JOIN content_version v ON v.id = i.live_version_id WHERE i.slug = $1 FOR UPDATE OF i`,
        [contract.slug],
      )
    ).rows[0];
    return existing === undefined ? loadIssue(client, bundle, contract) : unchanged(client, bundle, contract.slug, existing);
  });
}

/** The command: exit 0 loaded or unchanged, 2 refused before the database, 1 refused or failed in it (nothing applied). */
export async function runLoad(argv: string[], env: Env, stdin: Stdin, say: (line: string) => void): Promise<number> {
  if (argv.length !== 1 || argv[0] !== '-') {
    say('usage: node dist/load/cli.js -   (the bundle is read from stdin only: never a path, URL or mounted file)');
    return 2;
  }
  let bundle: Bundle;
  try {
    if (env['NODE_ENV'] === 'production' && stdin.kind !== 'pipe' && stdin.kind !== 'socket') {
      throw new LoadError('in production the bundle must arrive on a pipe (the attached stdin of the Job), not a file, terminal or device');
    }
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readCapped(stdin.chunks)));
    } catch (error) {
      if (error instanceof LoadError) throw error;
      throw new LoadError('the bundle is not valid JSON');
    }
    bundle = parseBundle(json);
  } catch (error) {
    say(`load: ${(error as Error).message}`);
    return 2;
  }
  let pool: ReturnType<typeof createPool> | undefined;
  try {
    // Inside the try: refused connection settings (PGSSLMODE) end the run like any failure, never as a crash.
    pool = createPool(env);
    const result = await applyBundle(pool, bundle);
    say(`${result.status}: item ${result.itemId}, public file ${result.publicFileId}, members file ${result.membersFileId}, ${result.marks} marks`);
    return 0;
  } catch (error) {
    if (error instanceof LoadError) {
      say(`load refused, nothing applied: ${error.message}`);
      return 1;
    }
    // The driver's code only: its message can echo a value it refused.
    const code = (error as { code?: unknown }).code;
    say(`load failed, nothing applied: ${typeof code === 'string' ? code : 'error'}`);
    return 1;
  } finally {
    await pool?.end();
  }
}
