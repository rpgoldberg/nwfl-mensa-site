// ============================================================================
// The publishing workflow (R11, R25, P15, P18, D-P1): ContentService's writes
// and officer reads. Each RPC is one transaction: lock the item, check who may
// do this and whether the state allows it, write, audit, answer.
//
//   create      a holder of the office, "Posting as" it; the Admin for any
//               office (audited as for_office)
//   save draft  the item's office (or the Admin, audited as for_office); a
//               ready version goes back to draft, unless it is print-as-is; a
//               published or withdrawn item gets a new version as its revision
//   mark ready  the item's office; no markup problems; targets default to
//               website and newsletter on, email off (P15), and an officers
//               item never targets the newsletter or email; records the hash
//   send back   a reviewer (any officer, the Admin, the Webmaster), with a note,
//               from ready or from approved-not-yet-published (cleared)
//   approve     a reviewer who did not edit the version (four eyes), or the
//               Admin by break-glass with a written reason; while the Admin
//               has set the content rule to one approver (SOLO-APPROVE, 0023),
//               a publisher (the Admin, the Webmaster) who edited it too,
//               recorded as self_single; every approval records the rule it
//               was made under; bound to the hash the reviewer saw; derives
//               public_ast and both search indexes; makes the version CLEARED,
//               "approved, ready to publish": nothing goes live (EDITOR A1);
//               refused while a reviewer's answer on any link is no, or a link
//               that needs a sign-in to check (Facebook and the like) has no
//               reviewer's yes, on the version as it stands (EDITOR A3b,
//               link-gate.ts and item-links.ts)
//   publish     the Webmaster, or the Admin as backup: a cleared version goes
//               live, bound to the hash the publisher saw; never by the
//               approver of their own exception (break-glass, one approver),
//               nor a one-approver approval once the rule is back to two-person;
//               a taken-down item only when the publisher says to put it back;
//               repoints the live version BEFORE superseding the old one
//   withdraw    the item's office or a publisher; 410 to the public at once; an
//               approval waiting to be published is voided
//   restore     the item's office; a new draft that stays withdrawn until
//               published
// An edit of a cleared version voids its approval too. Approve and send back
// record the office the reviewer acts for: one they hold (acting_as_office_id).
// The officer reads (the queue, an item, its history, its preview) are for an
// officer, the Admin or the Webmaster (EDITOR E1). The preview is the working
// version as the public and members will get it: approval's derivation, then
// the published read's body decision and lens, for each audience.
// The database enforces the transitions as well (0007); these checks give the
// caller a precise answer first.
// ============================================================================
import { create } from '@bufbuild/protobuf';
import { type Timestamp, TimestampSchema, timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from '@connectrpc/connect';
import { recordAudit } from '../audit/audit.js';
import { type Audience, type Caller, callerOf } from '../auth/caller.js';
import { type Roles, requireEditorReader, requireOffice, requirePublisher, requireReviewer, requireUser, rolesOf } from '../auth/roles.js';
import { dbError } from '../db/errors.js';
import { refuseLongText } from '../grpc/text-limit.js';
import type { Db } from '../db/pool.js';
import { type TxClient, inTransaction } from '../db/tx.js';
import {
  ContentItemSchema,
  type ContentItem,
  type ContentService,
  ContentVersionSchema,
  type Document,
  HistoryEntrySchema,
  type PreviewWorkingItemResponse,
  PreviewWorkingItemResponseSchema,
  StoredFileSchema,
  type Targets as ProtoTargets,
} from '../gen/nwfl/mensa/v1/content_pb.js';
import { FILE_AUDIENCES, FILE_ROLES, ITEM_VISIBILITIES, KINDS, KIND_NAMES, STATES, VERSION_STATUSES, namesOf } from './enums.js';
import { contentHash } from './hash.js';
import { NESTED_TOO_DEEPLY, parseMarkup } from './markup.js';
import { deriveForApproval, normalizeTree, referencedFiles, toProtoDocument } from './tree.js';
import { bylineFor, itemHidden, slugFor } from './redact.js';
import { loadLens } from '../redaction/lens.js';
import { recordItems } from '../ledger/ledger.js';
import { type Rule, readRule } from '../approval/service.js';
import { type Lens, subjectKey } from '../redaction/render.js';
import { actorLabel } from './actor-label.js';
import { linkGate } from './item-links.js';
import type { StructuredLogger } from '../platform/logger.js';
// A cycle (service.ts mounts these handlers), safe: bodyFor is read at call time, never at load.
import { bodyFor } from './service.js';

export interface WorkflowDeps {
  db: Db;
  logger: StructuredLogger;
  /** Today, for the link gate's upcoming events. */
  now: () => Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VISIBILITY_NAMES = namesOf(ITEM_VISIBILITIES);
const STATE_NAMES = namesOf(STATES);

/** EDITOR E3: SaveDraft's refusal of a base someone else has changed since; the site tells it apart by these words. */
export const STALE_BASE = 'This draft was changed by someone else since you opened it';
/** A Timestamp as microseconds since the epoch, exactly (Postgres keeps microseconds). */
function microsOf(at: Timestamp): string {
  return (at.seconds * 1000000n + BigInt(Math.trunc(at.nanos / 1000))).toString();
}
/** Microseconds since the epoch, as a Timestamp. */
export function timestampOfMicros(us: string): Timestamp {
  const total = BigInt(us);
  const seconds = total / 1000000n;
  const rest = total % 1000000n;
  return rest < 0n ? create(TimestampSchema, { seconds: seconds - 1n, nanos: Number(rest + 1000000n) * 1000 }) : create(TimestampSchema, { seconds, nanos: Number(rest) * 1000 });
}
const VERSION_STATUS_NAMES = namesOf(VERSION_STATUSES);
/** A working version's statuses: what ListWorkingItems lists by default. */
const WORKING_STATUSES = ['draft', 'ready', 'cleared'];
export const MAX_NOTE = 2_000;

export interface ItemRow {
  id: string;
  slug: string;
  kind: string;
  office_id: string;
  office_slug: string;
  state: string;
  live_version_id: string | null;
  working_version_id: string | null;
  withdrawn_at: Date | null;
}

export interface VersionRow {
  /** When it was last saved (EDITOR E3); to the millisecond here, to the microsecond on the officer reads. */
  updated_at: Date;
  id: string;
  item_id: string;
  n: number;
  status: string;
  title: string;
  summary: string | null;
  visibility: string;
  body_src: string;
  body_ast: unknown;
  content_hash: Buffer | null;
  target_website: boolean;
  target_newsletter: boolean;
  target_email: boolean;
  edition_id: string | null;
  print_as_is: boolean;
  on_behalf_of: string | null;
  ready_at: Date | null;
  approved_at: Date | null;
  approved_by_sub: string | null;
  approval_kind: ApprovalKind | null;
  published_at: Date | null;
}

/** normal: a second officer; self_breakglass: the Admin's logged own approval; self_single: an editor's own, under one approver. */
export type ApprovalKind = 'normal' | 'self_breakglass' | 'self_single';
const AUDIT_ACTION: Record<ApprovalKind, string> = { normal: 'approve', self_breakglass: 'approve_self', self_single: 'approve_single' };
/** An approval by its approver's own exception: someone else publishes it. */
const isSelf = (kind: ApprovalKind | null): boolean => kind === 'self_breakglass' || kind === 'self_single';

interface Targets {
  website: boolean;
  newsletter: boolean;
  email: boolean;
}

const invalid = (message: string): ConnectError => new ConnectError(message, Code.InvalidArgument);
const precondition = (message: string): ConnectError => new ConnectError(message, Code.FailedPrecondition);
export const notFound = (): ConnectError => new ConnectError('item not found', Code.NotFound);

export function requireId(value: string, field: string): string {
  if (!UUID.test(value)) throw invalid(`${field} is not an id`);
  return value;
}

/** `lock: false` for a read that must not wait on (or hold up) a writer: the preview. */
export async function loadItem(client: TxClient, itemId: string, lock = true): Promise<ItemRow> {
  const { rows } = await client.query<ItemRow>(
    `SELECT i.id, i.slug, i.kind, i.office_id, o.slug AS office_slug, i.state, i.live_version_id, i.working_version_id, i.withdrawn_at
     FROM content_item i JOIN office o ON o.id = i.office_id WHERE i.id = $1${lock ? ' FOR UPDATE OF i' : ''}`,
    [requireId(itemId, 'item_id')],
  );
  const row = rows[0];
  if (row === undefined) throw notFound();
  return row;
}

/**
 * loadItem for a caller about to act on the item. A caller who cannot see
 * working items at all (not an officer, Admin or Webmaster) is told "not
 * found" whether the item exists or not, so the answer gives nothing away.
 */
async function loadItemAs(client: TxClient, caller: Caller, itemId: string): Promise<ItemRow> {
  const roles = requireUser(caller);
  const id = requireId(itemId, 'item_id');
  if (!roles.officer && !roles.admin && !roles.webmaster && roles.offices.length === 0) throw notFound();
  return loadItem(client, id);
}

// Marker syntax: a members span, or a ::: fence line. A title or summary is always public.
const MARKER = /:members\[|^\s*:::/m;

function publicLine(value: string): string {
  if (MARKER.test(value)) throw invalid('a title or summary is always public: put members-only words in the body');
  return value;
}

export async function loadVersion(client: TxClient, versionId: string, lock = true): Promise<VersionRow> {
  const { rows } = await client.query<VersionRow>(`SELECT * FROM content_version WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [versionId]);
  return rows[0] as VersionRow;
}

const FROZEN_EDITION = new Set(['proof', 'published']);

async function openEdition(client: TxClient, editionId: string): Promise<void> {
  const { rows } = await client.query<{ status: string }>(`SELECT status FROM edition WHERE id = $1`, [requireId(editionId, 'edition_id')]);
  const status = rows[0]?.status;
  if (status === undefined || FROZEN_EDITION.has(status)) throw precondition('that edition is not open');
}

/** Plain flags: a proto message also carries its type name, which must not reach the hash. */
const plainTargets = (targets: ProtoTargets): Targets => ({ website: targets.website, newsletter: targets.newsletter, email: targets.email });

function checkTargets(visibility: string, targets: Targets): void {
  if (visibility === 'officers' && (targets.newsletter || targets.email)) throw invalid('an officers-only item cannot go to the newsletter or email');
}

async function hashOf(client: TxClient, version: VersionRow, targets: Targets, editionId: string | null): Promise<Buffer> {
  const { rows } = await client.query<{ sha256: Buffer }>(`SELECT sha256 FROM stored_file WHERE version_id = $1`, [version.id]);
  return contentHash({
    title: version.title,
    summary: version.summary,
    visibility: version.visibility,
    body: normalizeTree(version.body_ast),
    targets,
    editionId,
    printAsIs: version.print_as_is,
    fileHashes: rows.map((row) => row.sha256),
  });
}

export async function addEditor(client: TxClient, versionId: string, subject: string): Promise<void> {
  await client.query(`INSERT INTO content_version_editor (version_id, subject) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [versionId, subject]);
}

/**
 * Mark ready's writes, once its checks have passed: the hash over what the approver will judge, the
 * targets and edition recorded, and the item to ready. Shared by MarkReady and the issue loader
 * (load/load.ts), so the two cannot drift.
 */
export async function readyVersion(
  client: TxClient,
  item: Pick<ItemRow, 'id' | 'state'>,
  version: VersionRow,
  options: { targets: Targets; editionId: string | null; printAsIs: boolean },
): Promise<VersionRow> {
  const { targets, editionId, printAsIs } = options;
  const hash = await hashOf(client, { ...version, print_as_is: printAsIs }, targets, editionId);
  const ready = (
    await client.query<VersionRow>(
      `UPDATE content_version SET print_as_is = $2, target_website = $3, target_newsletter = $4, target_email = $5, edition_id = $6,
         status = 'ready', content_hash = $7, ready_at = now() WHERE id = $1 RETURNING *`,
      [version.id, printAsIs, targets.website, targets.newsletter, targets.email, editionId, hash],
    )
  ).rows[0] as VersionRow;
  if (item.state === 'draft') await client.query(`UPDATE content_item SET state = 'ready', updated_at = now() WHERE id = $1`, [item.id]);
  return ready;
}

/**
 * Approval's writes, once the reviewer's checks have passed: derive public_ast and both search
 * indexes, make a file referenced only inside members passages a members file, and make the version
 * CLEARED ("approved, ready to publish"), audited with the office the reviewer acts for. Nothing goes
 * live. Shared by Approve and the issue loader (load/load.ts), so the two cannot drift (MLOGIN N-7).
 */
export async function approveVersion(
  client: TxClient,
  caller: Caller,
  version: VersionRow,
  approval: { kind: ApprovalKind; reason: string | null; rule: Rule; actingOfficeId: string | null },
): Promise<VersionRow> {
  const derived = deriveForApproval({ title: version.title, summary: version.summary, visibility: version.visibility, body: version.body_ast });
  // A file referenced only inside members passages becomes a members file (section 4 rule 4).
  const { membersOnly } = referencedFiles(normalizeTree(version.body_ast));
  if (membersOnly.length > 0) {
    await client.query(
      `UPDATE stored_file SET audience = 'members' WHERE version_id = $1 AND id = ANY($2) AND audience = 'public' AND role <> 'public_copy'`,
      [version.id, membersOnly],
    );
  }
  const cleared = (
    await client.query<VersionRow>(
      `UPDATE content_version SET status = 'cleared', approved_at = now(), approved_by_sub = $2, approval_kind = $3, approval_reason = $4,
         public_ast = $5, search_public = to_tsvector('english', $6), search_members = to_tsvector('english', $7), approval_rule = $8
       WHERE id = $1 RETURNING *`,
      [version.id, caller.subject, approval.kind, approval.reason, JSON.stringify(derived.publicAst), derived.publicText, derived.membersText, approval.rule],
    )
  ).rows[0] as VersionRow;
  await recordAudit(client, caller, {
    action: AUDIT_ACTION[approval.kind],
    subjectKind: 'content_version',
    subjectId: version.id,
    itemId: version.item_id,
    versionId: version.id,
    contentHash: version.content_hash,
    fromState: 'ready',
    toState: 'cleared',
    note: approval.reason,
    actingOfficeId: approval.actingOfficeId,
    payload: { approval_rule: approval.rule },
  });
  return cleared;
}

/**
 * Publication's writes, once the publisher's checks have passed: the version approved (live) with who
 * published it and when, the live version repointed BEFORE the old one is superseded, the item
 * published (a takedown ended), audited, and the ledger recorded. Shared by Publish and the issue
 * loader, which calls approveVersion then this in its one transaction (0029's exemption).
 */
export async function publishVersion(
  client: TxClient,
  caller: Caller,
  item: Pick<ItemRow, 'id' | 'live_version_id' | 'state'>,
  version: VersionRow,
  publication: { backup: boolean },
): Promise<void> {
  await client.query(`UPDATE content_version SET status = 'approved', published_at = now(), published_by_sub = $2 WHERE id = $1`, [version.id, caller.subject]);
  // Repoint live first: the old live version cannot be superseded while it is live.
  await client.query(
    `UPDATE content_item SET live_version_id = $2, working_version_id = NULL, state = 'published', withdrawn_at = NULL, updated_at = now() WHERE id = $1`,
    [item.id, version.id],
  );
  if (item.live_version_id !== null) await client.query(`UPDATE content_version SET status = 'superseded' WHERE id = $1`, [item.live_version_id]);
  await recordAudit(client, caller, {
    action: 'publish',
    subjectKind: 'content_version',
    subjectId: version.id,
    itemId: item.id,
    versionId: version.id,
    contentHash: version.content_hash,
    fromState: 'cleared',
    toState: 'approved',
    payload: { backup: publication.backup, ...(item.state === 'withdrawn' ? { republished_withdrawn: true } : {}) },
  });
  await recordItems(client, [item.id]);
}

/** A cleared version back to draft, its approval dropped (0029: a draft carries none). */
async function unclear(client: TxClient, versionId: string): Promise<void> {
  await client.query(
    `UPDATE content_version SET status = 'draft', approved_at = NULL, approved_by_sub = NULL, approval_kind = NULL, approval_reason = NULL, public_ast = NULL,
       search_public = NULL, search_members = NULL, approval_rule = NULL
     WHERE id = $1`,
    [versionId],
  );
}

/** An approval waiting to be published no longer counts: an edit, or a withdraw of the item. Audited with its cause. */
async function voidApproval(client: TxClient, caller: Caller, version: VersionRow, cause: 'edit' | 'withdraw', actingOfficeId: string | null): Promise<void> {
  await unclear(client, version.id);
  await recordAudit(client, caller, {
    action: 'approval_voided',
    subjectKind: 'content_version',
    subjectId: version.id,
    itemId: version.item_id,
    versionId: version.id,
    contentHash: version.content_hash,
    fromState: 'cleared',
    toState: 'draft',
    actingOfficeId,
    payload: { cause },
  });
}

/**
 * The office a reviewer acts for (EDITOR A1, S2): the one they name, which must be one they hold
 * (PERMISSION_DENIED otherwise, the Admin included: acting for an office is not approving as it), or,
 * when they name none, their one office if they hold exactly one. Else none.
 */
export async function actingOffice(client: TxClient, roles: Roles, requested: string): Promise<string | null> {
  if (requested !== '') {
    const id = requireId(requested, 'acting_as_office_id');
    const slug = (await client.query<{ slug: string }>(`SELECT slug FROM office WHERE id = $1`, [id])).rows[0]?.slug;
    if (slug === undefined || !roles.offices.includes(slug)) throw new ConnectError('you do not hold that office', Code.PermissionDenied);
    return id;
  }
  if (roles.offices.length !== 1) return null;
  return (await client.query<{ id: string }>(`SELECT id FROM office WHERE slug = $1`, [roles.offices[0]])).rows[0]?.id ?? null;
}

/** A version for a frozen edition would land in no issue. */
async function frozenEdition(client: TxClient, version: Pick<VersionRow, 'target_newsletter' | 'edition_id'>): Promise<string | undefined> {
  if (!version.target_newsletter || version.edition_id === null) return undefined;
  const edition = (await client.query<{ title: string; status: string }>(`SELECT title, status FROM edition WHERE id = $1`, [version.edition_id])).rows[0] as { title: string; status: string };
  return FROZEN_EDITION.has(edition.status) ? edition.title : undefined;
}

/** A new draft version copying the authored content of `from`. */
async function newVersion(client: TxClient, item: ItemRow, from: VersionRow, caller: Caller): Promise<VersionRow> {
  const { rows } = await client.query<VersionRow>(
    `INSERT INTO content_version (item_id, n, title, summary, visibility, body_src, body_ast, on_behalf_of, created_by_sub, acting_office_id,
       target_newsletter, target_email)
     VALUES ($1, (SELECT max(n) + 1 FROM content_version WHERE item_id = $1), $2, $3, $4, $5, $6, $7, $8, $9, $10, false)
     RETURNING *`,
    [item.id, from.title, from.summary, from.visibility, from.body_src, JSON.stringify(from.body_ast), from.on_behalf_of, caller.subject, item.office_id, from.visibility !== 'officers'],
  );
  const version = rows[0] as VersionRow;
  await addEditor(client, version.id, caller.subject as string);
  await client.query(`UPDATE content_item SET working_version_id = $2, updated_at = now() WHERE id = $1`, [item.id, version.id]);
  return version;
}

/**
 * Whether the lens withholds anything of this version from its audience: a mark on the item that
 * changes what it sees, or an on-behalf-of name it does not show. Then the markup and the hash are
 * not given (versionMessage), and the caller may not save the item (SaveDraft), as a form filled
 * from the withheld read would wipe the body.
 */
function withholds(lens: Lens, row: Pick<VersionRow, 'item_id' | 'on_behalf_of'>): boolean {
  return lens.affected([subjectKey('content_item', row.item_id)]) || (row.on_behalf_of !== null && lens.action('member_name') !== 'show');
}

/** What a reviewer who cannot see the whole version is asked to leave to an officer who can. */
export type WholeViewAct = 'approve it' | 'publish it' | 'check its links';

/**
 * A3B-HARDEN: approving, publishing and vouching for links need the whole version. A reviewer from whom
 * the lens withholds anything of it (withholds) may only send it back: FAILED_PRECONDITION, as SaveDraft
 * refuses such an editor, in words that say only that parts are withheld. NOT_FOUND when the lens hides
 * the item whole, as the reads answer. Called before any hash is compared, so the refusal tells nothing
 * about a hash.
 */
export async function requireWholeView(client: TxClient, caller: Caller, version: VersionRow, act: WholeViewAct): Promise<void> {
  const lens = await loadLens(client, caller.audience, { items: [version.item_id], versions: [version.id] });
  if (itemHidden({ id: version.item_id, on_behalf_of: version.on_behalf_of }, version.id, lens)) throw notFound();
  if (withholds(lens, version)) throw precondition(`part of this item is withheld from you; an officer who can see all of it must ${act}`);
}

/**
 * The latest send-back note on a version since it was last marked ready (EDITOR E1). Only a draft can
 * carry one: a send-back returns the version to draft, and marking it ready again clears it.
 */
async function sendBackNote(client: TxClient, row: VersionRow): Promise<string> {
  if (row.status !== 'draft') return '';
  const { rows } = await client.query<{ action: string; note: string }>(
    `SELECT action, coalesce(note, '') AS note FROM audit_event
     WHERE subject_kind = 'content_version' AND subject_id = $1 AND action IN ('ready', 'send_back')
     ORDER BY id DESC LIMIT 1`,
    [row.id],
  );
  return rows[0]?.action === 'send_back' ? rows[0].note : '';
}

/** Who reads an item (an officer read), with what they may do to it: their roles and the rule, read once and only when needed. */
interface Viewer {
  subject: string;
  roles: Roles;
  rule: () => Promise<Rule>;
  office: { slug: string; title: string };
}

/** Who approved a version, in words (actor-label.ts), from its latest approval's audit row; '' if none was audited. */
async function approvedAs(client: TxClient, row: VersionRow, office: Viewer['office']): Promise<string> {
  if (row.approved_by_sub === null) return '';
  const { rows } = await client.query<{ actor_kind: string; actor_groups: string[]; acting_slug: string | null; acting_title: string | null }>(
    `SELECT a.actor_kind, a.actor_groups, o.slug AS acting_slug, o.title AS acting_title FROM audit_event a LEFT JOIN office o ON o.id = a.acting_office_id
     WHERE a.subject_kind = 'content_version' AND a.subject_id = $1 AND a.action IN ('approve', 'approve_self', 'approve_single') ORDER BY a.id DESC LIMIT 1`,
    [row.id],
  );
  const audit = rows[0];
  if (audit === undefined) return '';
  return actorLabel({ kind: audit.actor_kind, groups: audit.actor_groups, actingOffice: audit.acting_slug === null ? null : { slug: audit.acting_slug, title: audit.acting_title as string } }, office);
}

/**
 * EDITOR A1: whether the viewer may approve it as it stands (break-glass aside), and publish it. Neither
 * when anything of it is withheld from them (A3B-HARDEN, requireWholeView).
 */
async function mayActOn(row: VersionRow, edited: boolean, viewer: Viewer, withheld: boolean): Promise<{ approve: boolean; publish: boolean }> {
  if (withheld) return { approve: false, publish: false };
  const { roles } = viewer;
  const reviewer = roles.officer || roles.admin || roles.webmaster;
  const publisher = roles.admin || roles.webmaster;
  const approve = row.status === 'ready' && reviewer && (!edited || (publisher && (await viewer.rule()) === 'one_approver'));
  const publish =
    row.status === 'cleared' &&
    publisher &&
    !(isSelf(row.approval_kind) && row.approved_by_sub === viewer.subject) &&
    (row.approval_kind !== 'self_single' || (await viewer.rule()) === 'one_approver');
  return { approve, publish };
}

/**
 * A version as the lens's audience may see it: its text through the lens, its markup and hash only
 * where nothing was withheld (body_markup_withheld says so, so an edit form is never filled from the
 * empty markup), whether the viewer edited it, and what they may do to it.
 */
async function versionMessage(client: TxClient, row: VersionRow, lens: Lens, viewer: Viewer) {
  const subjects = [subjectKey('content_item', row.item_id)];
  const withheld = withholds(lens, row);
  const edited = (await client.query(`SELECT 1 FROM content_version_editor WHERE version_id = $1 AND subject = $2`, [row.id, viewer.subject])).rows.length > 0;
  const may = await mayActOn(row, edited, viewer, withheld);
  const { rows: files } = await client.query<{ id: string; filename: string; mime_type: string; size_bytes: string; sha256: Buffer; audience: string; role: string; public_copy_of: string | null }>(
    `SELECT id, filename, mime_type, size_bytes::text AS size_bytes, sha256, audience, role, public_copy_of FROM stored_file WHERE version_id = $1 ORDER BY filename, id`,
    [row.id],
  );
  return create(ContentVersionSchema, {
    id: row.id,
    itemId: row.item_id,
    number: row.n,
    status: VERSION_STATUSES[row.status],
    title: lens.text(row.title, subjects),
    summary: lens.text(row.summary ?? '', subjects),
    visibility: ITEM_VISIBILITIES[row.visibility],
    body: toProtoDocument(lens.tree(normalizeTree(row.body_ast), subjects)),
    // The markup can split a marked name with its own syntax (Jo**hn**), so it is left out
    // whenever anything is withheld from this audience.
    bodyMarkup: withheld ? '' : row.body_src,
    bodyMarkupWithheld: withheld,
    ...(row.content_hash !== null && !withheld ? { contentHash: row.content_hash } : {}),
    sendBackNote: lens.text(await sendBackNote(client, row), subjects),
    callerEdited: edited,
    callerMayApprove: may.approve,
    callerMayPublish: may.publish,
    approvedAsLabel: await approvedAs(client, row, viewer.office),
    approvalKindSelf: isSelf(row.approval_kind),
    targets: { website: row.target_website, newsletter: row.target_newsletter, email: row.target_email },
    editionId: row.edition_id ?? '',
    printAsIs: row.print_as_is,
    onBehalfOf: bylineFor(row.on_behalf_of, subjects, lens),
    ...(row.ready_at !== null ? { readyAt: timestampFromDate(row.ready_at) } : {}),
    ...(row.approved_at !== null ? { approvedAt: timestampFromDate(row.approved_at) } : {}),
    ...(row.published_at !== null ? { publishedAt: timestampFromDate(row.published_at) } : {}),
    files: files.map((file) =>
      create(StoredFileSchema, {
        id: file.id,
        filename: lens.text(file.filename, subjects),
        mimeType: file.mime_type,
        sizeBytes: BigInt(file.size_bytes),
        sha256: file.sha256,
        audience: FILE_AUDIENCES[file.audience],
        role: FILE_ROLES[file.role],
        publicCopyOf: file.public_copy_of ?? '',
      }),
    ),
  });
}

/**
 * An item as officers see it: the live version and the working one, members passages kept, through
 * the lens for the caller's audience. A version the lens drops (a passage mark it no longer carries)
 * is left out; undefined when the lens hides the item, or both versions.
 */
async function officerItem(client: TxClient, itemId: string, caller: Caller): Promise<ContentItem | undefined> {
  const { rows } = await client.query<ItemRow & { office_title: string }>(
    `SELECT i.id, i.slug, i.kind, i.office_id, o.slug AS office_slug, o.title AS office_title, i.state, i.live_version_id, i.working_version_id, i.withdrawn_at
     FROM content_item i JOIN office o ON o.id = i.office_id WHERE i.id = $1`,
    [itemId],
  );
  const item = rows[0] as ItemRow & { office_title: string };
  const ids = [item.live_version_id, item.working_version_id].filter((id) => id !== null);
  const lens = await loadLens(client, caller.audience, { items: [item.id], versions: ids });
  const shown = async (id: string | null): Promise<VersionRow | undefined> => {
    if (id === null) return undefined;
    const version = await loadVersion(client, id);
    return itemHidden({ id: item.id, on_behalf_of: version.on_behalf_of }, version.id, lens) ? undefined : version;
  };
  const liveRow = await shown(item.live_version_id);
  const workingRow = await shown(item.working_version_id);
  if (liveRow === undefined && workingRow === undefined && ids.length > 0) return undefined;
  let rule: Rule | undefined;
  const viewer: Viewer = {
    subject: caller.subject as string, // officer reads and writes are for a signed-in person
    roles: rolesOf(caller),
    rule: async () => (rule ??= await readRule(client, 'content')),
    office: { slug: item.office_slug, title: item.office_title },
  };
  // EDITOR E3: the latest audited step is the last change; a read (an export) is none.
  // An automatic save that adds no audit row still moves the working version's updated_at; to the microsecond,
  // as updated_at is read (a Date would round it).
  const changed = (
    await client.query<{ us: string | null }>(
      `SELECT (extract(epoch FROM GREATEST(
                 (SELECT max(at) FROM audit_event WHERE item_id = $1 AND action NOT LIKE '%\\_read' ESCAPE '\\'),
                 (SELECT updated_at FROM content_version WHERE id = $2))) * 1000000)::bigint::text AS us`,
      [item.id, workingRow?.id ?? null],
    )
  ).rows[0]?.us;
  // EDITOR E3: each version's updated_at to the microsecond, the base a form sends back.
  const stamps = new Map(
    (
      await client.query<{ id: string; us: string }>(`SELECT id, (extract(epoch FROM updated_at) * 1000000)::bigint::text AS us FROM content_version WHERE id = ANY($1::uuid[])`, [
        [liveRow?.id, workingRow?.id].filter((id) => id !== undefined),
      ])
    ).rows.map((row) => [row.id, timestampOfMicros(row.us)]),
  );
  const stamped = async (row: VersionRow | undefined) => {
    if (row === undefined) return undefined;
    const message = await versionMessage(client, row, lens, viewer);
    message.updatedAt = stamps.get(row.id);
    return message;
  };
  const live = await stamped(liveRow);
  const working = await stamped(workingRow);
  return create(ContentItemSchema, {
    id: item.id,
    slug: slugFor(item, lens),
    kind: KINDS[item.kind],
    officeId: item.office_id,
    state: STATES[item.state],
    ...(live !== undefined ? { live } : {}),
    ...(working !== undefined ? { working } : {}),
    ...(item.withdrawn_at !== null ? { withdrawnAt: timestampFromDate(item.withdrawn_at) } : {}),
    ...(changed ? { lastChangedAt: timestampOfMicros(changed) } : {}),
  });
}

const RANK: Record<Audience, number> = { public: 0, members: 1, officers: 2 };

/**
 * PreviewWorkingItem (EDITOR E1): a version as each audience will get it once approved, by the same
 * steps approval and the published reads take: deriveForApproval's public tree, then bodyFor and the
 * audience's lens. A body is unset when that audience will not see the item at all (an officers item,
 * or one its lens hides). Each audience is capped at the caller's audience by rank (public, members,
 * officers): a caller who reads below the members (the Admin without the officers group, not a member)
 * gets the members body through the public's lens. The cap is by rank, not by cell: where the policy
 * withholds more from officers than from members, an officer's members body shows what members will
 * see, which their own read withholds. NOT_FOUND when the caller's own lens hides the item, as
 * GetWorkingItem. A withdrawn item with no working version previews its last live version, which a
 * restore would bring back as the new draft.
 */
async function previewOf(client: TxClient, own: Audience, itemId: string, version: VersionRow): Promise<PreviewWorkingItemResponse> {
  const subjects = [subjectKey('content_item', itemId)];
  const lenses = new Map<Audience, Lens>();
  const lensFor = async (audience: Audience): Promise<Lens> => {
    const capped = RANK[own] < RANK[audience] ? own : audience;
    const known = lenses.get(capped);
    if (known !== undefined) return known;
    const lens = await loadLens(client, capped, { items: [itemId], versions: [version.id] });
    lenses.set(capped, lens);
    return lens;
  };
  const shown = (lens: Lens): boolean => !itemHidden({ id: itemId, on_behalf_of: version.on_behalf_of }, version.id, lens);
  if (!shown(await lensFor(own))) throw notFound();
  const derived = deriveForApproval({ title: version.title, summary: version.summary, visibility: version.visibility, body: version.body_ast });
  const body = async (audience: Audience, stored: unknown): Promise<Document | undefined> => {
    const lens = await lensFor(audience);
    if (version.visibility === 'officers' || !shown(lens)) return undefined;
    return toProtoDocument(lens.tree(bodyFor(audience, version.visibility, stored), subjects));
  };
  const publicLens = await lensFor('public');
  const publicBody = await body('public', derived.publicAst);
  const membersBody = await body('members', version.body_ast);
  return create(PreviewWorkingItemResponseSchema, {
    title: publicLens.text(version.title, subjects),
    summary: publicLens.text(version.summary ?? '', subjects),
    ...(publicBody !== undefined ? { publicBody } : {}),
    ...(membersBody !== undefined ? { membersBody } : {}),
    problems: parseMarkup(version.body_src).problems,
  });
}

export function workflowHandlers(deps: WorkflowDeps): Partial<ServiceImpl<typeof ContentService>> {
  const callerIn = (ctx: HandlerContext): Caller => callerOf(ctx.values);
  const tx = async <T>(fn: (client: TxClient) => Promise<T>): Promise<T> => {
    try {
      return await inTransaction(deps.db, fn);
    } catch (error) {
      throw dbError(error);
    }
  };

  return {
    createItem: async (request, ctx) => {
      const caller = callerIn(ctx);
      requireUser(caller);
      refuseLongText({ slug: request.slug, title: request.title });
      const kind = KIND_NAMES.get(request.kind);
      if (kind === undefined) throw invalid('kind is required');
      const title = publicLine(request.title.trim());
      if (title === '') throw invalid('title is required');
      return tx(async (client) => {
        const { rows } = await client.query<{ slug: string }>(`SELECT slug FROM office WHERE id = $1`, [requireId(request.officeId, 'office_id')]);
        const office = rows[0];
        if (office === undefined) throw invalid('unknown office');
        const { onBehalfOf } = requireOffice(caller, office.slug);
        const item = (await client.query<{ id: string }>(`INSERT INTO content_item (slug, kind, office_id) VALUES ($1, $2, $3) RETURNING id`, [request.slug, kind, request.officeId]))
          .rows[0] as { id: string };
        const version = (
          await client.query<{ id: string }>(
            `INSERT INTO content_version (item_id, n, title, on_behalf_of, created_by_sub, acting_office_id) VALUES ($1, 1, $2, $3, $4, $5) RETURNING id`,
            [item.id, title, request.onBehalfOf.trim() === '' ? null : request.onBehalfOf.trim(), caller.subject, request.officeId],
          )
        ).rows[0] as { id: string };
        await addEditor(client, version.id, caller.subject as string);
        await client.query(`UPDATE content_item SET working_version_id = $2 WHERE id = $1`, [item.id, version.id]);
        await recordAudit(client, caller, {
          action: 'create',
          subjectKind: 'content_item',
          subjectId: item.id,
          itemId: item.id,
          versionId: version.id,
          toState: 'draft',
          actingOfficeId: request.officeId,
          payload: onBehalfOf ? { for_office: true } : {},
        });
        return { item: await officerItem(client, item.id, caller) };
      });
    },

    saveDraft: async (request, ctx) => {
      const caller = callerIn(ctx);
      requireUser(caller);
      // Before anything is parsed or stored (MARKUP-DOS round 2).
      refuseLongText({ title: request.title, summary: request.summary, body_markup: request.bodyMarkup });
      return tx(async (client) => {
        const item = await loadItemAs(client, caller, request.itemId);
        const { onBehalfOf } = requireOffice(caller, item.office_slug);
        // The data-loss guard (EDITOR E1): a caller who reads this item with anything withheld got no
        // markup, so their save would overwrite the body with what they could not see.
        const base = await loadVersion(client, (item.working_version_id ?? item.live_version_id) as string);
        const lens = await loadLens(client, caller.audience, { items: [item.id], versions: [base.id] });
        if (withholds(lens, base)) throw precondition('part of this item is withheld from you; an officer who can see all of it must edit it');
        // An automatic save saves a draft only: never a ready or approved version, never a new version.
        if (request.auto && (item.working_version_id === null || base.status !== 'draft')) throw precondition('an automatic save only saves a draft');
        // EDITOR E3: a save from a base someone else has changed since writes nothing (the item is locked). One
        // that carries exactly what is saved overwrites nobody (the page's own save, sent as it was left, landed
        // first): no conflict, and still nothing written; the item comes back with its current base.
        if (request.baseUpdatedAt !== undefined) {
          const { rows } = await client.query<{ same: boolean }>(`SELECT updated_at = timestamptz 'epoch' + $2::bigint * interval '1 microsecond' AS same FROM content_version WHERE id = $1`, [
            base.id,
            microsOf(request.baseUpdatedAt),
          ]);
          if (rows[0]?.same !== true) {
            const summary = request.summary.trim();
            const carriesSaved =
              base.title === request.title.trim() &&
              (base.summary ?? '') === summary &&
              base.visibility === (VISIBILITY_NAMES.get(request.visibility) ?? base.visibility) &&
              base.body_src === request.bodyMarkup;
            if (!carriesSaved) throw precondition(STALE_BASE);
            return { item: await officerItem(client, item.id, caller), problems: parseMarkup(request.bodyMarkup).problems };
          }
        }
        let version = item.working_version_id !== null ? base : await newVersion(client, item, base, caller);
        const from = version.status;
        if (version.status === 'ready' || version.status === 'cleared') {
          if (version.print_as_is) throw precondition('a print-as-is version can be approved or sent back, never edited');
          // An edit after approval: the approval no longer counts (EDITOR A1), recorded as the save is, for the item's office.
          if (version.status === 'cleared') await voidApproval(client, caller, version, 'edit', item.office_id);
          else await client.query(`UPDATE content_version SET status = 'draft' WHERE id = $1`, [version.id]);
          if (item.state === 'ready') await client.query(`UPDATE content_item SET state = 'draft' WHERE id = $1`, [item.id]);
        }
        const title = publicLine(request.title.trim());
        if (title === '') throw invalid('title is required');
        publicLine(request.summary);
        const visibility = VISIBILITY_NAMES.get(request.visibility) ?? version.visibility;
        const { tree, problems } = parseMarkup(request.bodyMarkup);
        // Nested deeper than the stored tree keeps: preview and publication would drop part of it (and far
        // deeper, storing it overflows the stack). Refused, not saved with a problem, so what saves shows.
        if (problems.some((problem) => problem.message === NESTED_TOO_DEEPLY)) throw invalid(NESTED_TOO_DEEPLY);
        version = (
          await client.query<VersionRow>(
            `UPDATE content_version SET title = $2, summary = $3, visibility = $4, body_src = $5, body_ast = $6,
               target_newsletter = (target_newsletter AND $4 <> 'officers'), target_email = (target_email AND $4 <> 'officers'), updated_at = now()
             WHERE id = $1 RETURNING *`,
            [version.id, title, request.summary.trim() === '' ? null : request.summary.trim(), visibility, request.bodyMarkup, JSON.stringify(tree)],
          )
        ).rows[0] as VersionRow;
        await addEditor(client, version.id, caller.subject as string);
        // Consecutive automatic saves by one person on one version within 10 minutes are one 'autosave' row: the
        // audit is append-only, so the later ones add none; the version's updated_at keeps the last change.
        const latest = request.auto
          ? (await client.query<{ action: string; actor_sub: string | null; version_id: string | null; recent: boolean }>(
              `SELECT action, actor_sub, version_id, at > now() - interval '10 minutes' AS recent FROM audit_event WHERE item_id = $1 ORDER BY id DESC LIMIT 1`,
              [item.id],
            )).rows[0]
          : undefined;
        const repeat = latest !== undefined && latest.action === 'autosave' && latest.actor_sub === caller.subject && latest.version_id === version.id && latest.recent;
        if (!repeat) await recordAudit(client, caller, {
          action: request.auto ? 'autosave' : 'save',
          subjectKind: 'content_version',
          subjectId: version.id,
          itemId: item.id,
          versionId: version.id,
          fromState: from,
          toState: 'draft',
          actingOfficeId: item.office_id,
          // AUDIT-FOROFFICE: the Admin saving for an office they do not hold, as CreateItem records it.
          payload: onBehalfOf ? { for_office: true } : {},
        });
        return { item: await officerItem(client, item.id, caller), problems };
      });
    },

    markReady: async (request, ctx) => {
      const caller = callerIn(ctx);
      return tx(async (client) => {
        const item = await loadItemAs(client, caller, request.itemId);
        requireOffice(caller, item.office_slug);
        if (item.working_version_id === null) throw precondition('there is no draft to mark ready');
        const version = await loadVersion(client, item.working_version_id);
        if (version.status !== 'draft') throw precondition('only a draft can be marked ready');
        const problems = parseMarkup(version.body_src).problems;
        if (problems.length > 0) throw precondition(`the markup has ${problems.length} problem(s); fix them first`);
        const targets: Targets = request.targets !== undefined ? plainTargets(request.targets) : { website: true, newsletter: version.visibility !== 'officers', email: false };
        checkTargets(version.visibility, targets);
        const editionId = request.editionId === '' ? null : request.editionId;
        if (editionId !== null) await openEdition(client, editionId);
        const ready = await readyVersion(client, item, version, { targets, editionId, printAsIs: request.printAsIs });
        await recordAudit(client, caller, {
          action: 'ready',
          subjectKind: 'content_version',
          subjectId: version.id,
          itemId: item.id,
          versionId: version.id,
          contentHash: ready.content_hash,
          fromState: 'draft',
          toState: 'ready',
          actingOfficeId: item.office_id,
        });
        return { item: await officerItem(client, item.id, caller) };
      });
    },

    sendBack: async (request, ctx) => {
      const caller = callerIn(ctx);
      const roles = requireReviewer(caller);
      const note = request.note.trim();
      if (note === '' || note.length > MAX_NOTE) throw invalid('a note for the author is required');
      return tx(async (client) => {
        const actingOfficeId = await actingOffice(client, roles, request.actingAsOfficeId);
        const item = await loadItem(client, request.itemId);
        const version = item.working_version_id === null ? undefined : await loadVersion(client, item.working_version_id);
        if (version?.status !== 'ready' && version?.status !== 'cleared') throw precondition('only a version waiting for approval, or approved and not yet published, can be sent back');
        if (version.status === 'cleared') await unclear(client, version.id);
        else await client.query(`UPDATE content_version SET status = 'draft' WHERE id = $1`, [version.id]);
        if (item.state === 'ready') await client.query(`UPDATE content_item SET state = 'draft', updated_at = now() WHERE id = $1`, [item.id]);
        await recordAudit(client, caller, {
          action: 'send_back',
          subjectKind: 'content_version',
          subjectId: version.id,
          itemId: item.id,
          versionId: version.id,
          fromState: version.status,
          toState: 'draft',
          note,
          actingOfficeId,
        });
        return { item: await officerItem(client, item.id, caller) };
      });
    },

    approve: async (request, ctx) => {
      const caller = callerIn(ctx);
      const roles = requireReviewer(caller);
      return tx(async (client) => {
        const actingOfficeId = await actingOffice(client, roles, request.actingAsOfficeId);
        const item = await loadItem(client, request.itemId);
        let version = item.working_version_id === null ? undefined : await loadVersion(client, item.working_version_id);
        if (version?.status !== 'ready') throw precondition('only a ready version can be approved');
        await requireWholeView(client, caller, version, 'approve it');
        if (version.content_hash === null || !Buffer.from(request.contentHash).equals(version.content_hash)) {
          throw new ConnectError('the version changed since it was opened; reload it', Code.Aborted);
        }
        // The rule under a share lock, after the item's lock and before the ledger head (0023's lock order).
        const rule = await readRule(client, 'content');
        const editors = (await client.query<{ subject: string }>(`SELECT subject FROM content_version_editor WHERE version_id = $1`, [version.id])).rows.map((row) => row.subject);
        let kind: ApprovalKind = 'normal';
        let reason: string | null = null;
        if (editors.includes(caller.subject as string)) {
          if (request.breakGlass) {
            if (!roles.admin) throw new ConnectError('only the Admin may approve their own edit', Code.PermissionDenied);
            reason = request.breakGlassReason.trim();
            if (reason === '' || reason.length > MAX_NOTE) throw invalid('a break-glass approval needs a written reason');
            kind = 'self_breakglass';
          } else if (rule === 'one_approver' && (roles.admin || roles.webmaster)) {
            // Only a publisher approves their own edit under one approver (S3); someone else publishes it.
            kind = 'self_single';
          } else {
            throw new ConnectError('you edited this version; a second officer must approve it', Code.PermissionDenied);
          }
        }

        // The approver may change the targets or the edition first; each change is logged.
        const before: Targets = { website: version.target_website, newsletter: version.target_newsletter, email: version.target_email };
        const targets = request.targets !== undefined ? plainTargets(request.targets) : before;
        const beforeEdition = version.edition_id;
        checkTargets(version.visibility, targets);
        let editionId = beforeEdition;
        if (request.editionId !== '' && request.editionId !== beforeEdition) {
          await openEdition(client, request.editionId);
          editionId = request.editionId;
        }
        // A version for a frozen edition would land in no issue: the approver picks an open one.
        const frozen = await frozenEdition(client, { target_newsletter: targets.newsletter, edition_id: editionId });
        if (frozen !== undefined) throw precondition(`${frozen} is already frozen for print: pick an open edition, then approve`);
        const targetsChanged = targets.website !== before.website || targets.newsletter !== before.newsletter || targets.email !== before.email;
        const editionChanged = editionId !== beforeEdition;
        if (targetsChanged || editionChanged) {
          const hash = await hashOf(client, version, targets, editionId);
          version = (
            await client.query<VersionRow>(
              `UPDATE content_version SET target_website = $2, target_newsletter = $3, target_email = $4, edition_id = $5, content_hash = $6 WHERE id = $1 RETURNING *`,
              [version.id, targets.website, targets.newsletter, targets.email, editionId, hash],
            )
          ).rows[0] ?? version;
          const common = { subjectKind: 'content_version', subjectId: version.id, itemId: item.id, versionId: version.id };
          if (targetsChanged) await recordAudit(client, caller, { ...common, action: 'targets_changed', payload: { from: before, to: targets } });
          if (editionChanged) await recordAudit(client, caller, { ...common, action: 'edition_changed', payload: { from: beforeEdition, to: editionId } });
        }

        // The link gate (EDITOR A3b), break-glass included, for the edition it is approved for: no link a
        // reviewer answered no on this version as it stands, and a yes on each link that needs a sign-in.
        // The refusal names only links the caller sees whole through their lens.
        const office = (await client.query<{ title: string }>(`SELECT title FROM office WHERE id = $1`, [item.office_id])).rows[0] as { title: string };
        const refusal = await linkGate(
          client,
          deps,
          {
            id: version.id,
            itemId: item.id,
            onBehalfOf: version.on_behalf_of,
            body: normalizeTree(version.body_ast),
            officeId: item.office_id,
            office: { slug: item.office_slug, title: office.title },
            editionId,
          },
          caller.audience,
        );
        if (refusal !== undefined) throw precondition(refusal);

        await approveVersion(client, caller, version, { kind, reason, rule, actingOfficeId });
        return { item: await officerItem(client, item.id, caller) };
      });
    },

    publish: async (request, ctx) => {
      const caller = callerIn(ctx);
      const roles = requirePublisher(caller);
      return tx(async (client) => {
        const item = await loadItem(client, request.itemId);
        const version = item.working_version_id === null ? undefined : await loadVersion(client, item.working_version_id);
        if (version?.status !== 'cleared') throw precondition('only an approved version can be published');
        await requireWholeView(client, caller, version, 'publish it');
        // A cleared version always has its hash (0029).
        if (!Buffer.from(request.contentHash).equals(version.content_hash as Buffer)) {
          throw new ConnectError('the version changed since it was opened; reload it', Code.Aborted);
        }
        if (item.state === 'withdrawn' && !request.republishWithdrawn) {
          throw precondition('this item was taken down: publishing puts it back on the website, so confirm that first');
        }
        const frozen = await frozenEdition(client, version);
        if (frozen !== undefined) throw precondition(`${frozen} is already frozen for print: send it back to pick an open edition`);
        if (isSelf(version.approval_kind) && version.approved_by_sub === caller.subject) {
          throw new ConnectError('you approved your own change; someone else must publish it', Code.PermissionDenied);
        }
        // The rule under a share lock, after the item's lock and before the ledger head (0023's lock order), as Approve reads it (N5).
        if (version.approval_kind === 'self_single' && (await readRule(client, 'content')) !== 'one_approver') {
          throw precondition('the approval rule changed; send it back');
        }
        await publishVersion(client, caller, item, version, { backup: !roles.webmaster });
        return { item: await officerItem(client, item.id, caller) };
      });
    },

    withdraw: async (request, ctx) => {
      const caller = callerIn(ctx);
      const roles = requireUser(caller);
      return tx(async (client) => {
        const item = await loadItemAs(client, caller, request.itemId);
        if (!roles.admin && !roles.webmaster && !roles.offices.includes(item.office_slug)) throw new ConnectError('not permitted', Code.PermissionDenied);
        if (item.state !== 'published') throw precondition('only a published item can be withdrawn');
        await client.query(`UPDATE content_item SET state = 'withdrawn', withdrawn_at = now(), updated_at = now() WHERE id = $1`, [item.id]);
        // A takedown beats the pin: the item stays out of every frozen edition it is pinned in, even once republished.
        await client.query(`UPDATE edition_item SET taken_down_at = now() WHERE item_id = $1 AND taken_down_at IS NULL`, [item.id]);
        await recordAudit(client, caller, { action: 'withdraw', subjectKind: 'content_item', subjectId: item.id, itemId: item.id, fromState: 'published', toState: 'withdrawn' });
        // A change approved and waiting to be published is voided, so no Publish quietly undoes the takedown (S1).
        const waiting = item.working_version_id === null ? undefined : await loadVersion(client, item.working_version_id);
        if (waiting?.status === 'cleared') await voidApproval(client, caller, waiting, 'withdraw', roles.offices.includes(item.office_slug) ? item.office_id : null);
        await recordItems(client, [item.id]);
        return { item: await officerItem(client, item.id, caller) };
      });
    },

    restore: async (request, ctx) => {
      const caller = callerIn(ctx);
      return tx(async (client) => {
        const item = await loadItemAs(client, caller, request.itemId);
        requireOffice(caller, item.office_slug);
        if (item.state !== 'withdrawn') throw precondition('only a withdrawn item can be restored');
        if (item.working_version_id !== null) throw precondition('a restored draft already exists');
        const version = await newVersion(client, item, await loadVersion(client, item.live_version_id as string), caller);
        await recordAudit(client, caller, {
          action: 'restore',
          subjectKind: 'content_version',
          subjectId: version.id,
          itemId: item.id,
          versionId: version.id,
          fromState: 'withdrawn',
          toState: 'draft',
          actingOfficeId: item.office_id,
        });
        return { item: await officerItem(client, item.id, caller) };
      });
    },

    listWorkingItems: async (request, ctx) => {
      const caller = callerIn(ctx);
      requireEditorReader(caller);
      // The working version's status (EDITOR A1); else the older item-state filter, which names draft and ready only; else all three.
      const named = (names: (string | undefined)[]): string[] => names.filter((name) => name !== undefined && WORKING_STATUSES.includes(name)) as string[];
      const statuses =
        request.versionStatuses.length > 0
          ? named(request.versionStatuses.map((status) => VERSION_STATUS_NAMES.get(status)))
          : request.states.length > 0
            ? named(request.states.map((state) => STATE_NAMES.get(state)))
            : WORKING_STATUSES;
      // EDITOR E3: PUBLISHED and WITHDRAWN in the item-state filter name the item's state, whatever its working version.
      const itemStates =
        request.versionStatuses.length > 0 ? [] : request.states.map((state) => STATE_NAMES.get(state)).filter((s) => s === 'published' || s === 'withdrawn');
      if (request.officeId !== '') requireId(request.officeId, 'office_id');
      if (request.editionId !== '') requireId(request.editionId, 'edition_id');
      return tx(async (client) => {
        // A working version listed for its status is filtered by its edition; an item listed for its
        // state by its live version's. Newest change first: the latest audited step that is no read.
        const { rows } = await client.query<{ id: string }>(
          `SELECT i.id FROM content_item i
             LEFT JOIN content_version w ON w.id = i.working_version_id
             LEFT JOIN content_version l ON l.id = i.live_version_id
             LEFT JOIN LATERAL (SELECT max(a.at) AS at FROM audit_event a WHERE a.item_id = i.id AND a.action NOT LIKE '%\\_read' ESCAPE '\\') c ON true
           WHERE (w.status = ANY($1) OR i.state = ANY($4))
             AND ($2::uuid IS NULL OR i.office_id = $2)
             AND ($3::uuid IS NULL OR (CASE WHEN w.status = ANY($1) THEN w.edition_id ELSE l.edition_id END) = $3)
           ORDER BY COALESCE(GREATEST(c.at, w.updated_at), i.updated_at) DESC, i.id`,
          [statuses, request.officeId === '' ? null : request.officeId, request.editionId === '' ? null : request.editionId, itemStates],
        );
        const items: ContentItem[] = [];
        for (const row of rows) {
          const item = await officerItem(client, row.id, caller);
          if (item !== undefined) items.push(item);
        }
        return { items };
      });
    },

    getWorkingItem: async (request, ctx) => {
      const caller = callerIn(ctx);
      requireEditorReader(caller);
      return tx(async (client) => {
        const item = await loadItem(client, request.itemId);
        const view = await officerItem(client, item.id, caller);
        if (view === undefined) throw notFound();
        return { item: view };
      });
    },

    listItemHistory: async (request, ctx) => {
      const caller = callerIn(ctx);
      requireEditorReader(caller);
      return tx(async (client) => {
        const item = await loadItem(client, request.itemId);
        const lens = await loadLens(client, caller.audience, { items: [item.id] });
        const office = (await client.query<{ slug: string; title: string }>(`SELECT slug, title FROM office WHERE id = $1`, [item.office_id])).rows[0] as { slug: string; title: string };
        const { rows } = await client.query<{
          at: Date;
          action: string;
          actor_kind: string;
          actor_sub: string | null;
          actor_groups: string[];
          acting_office_id: string | null;
          acting_slug: string | null;
          acting_title: string | null;
          n: number | null;
          content_hash: Buffer | null;
          from_state: string | null;
          to_state: string | null;
          note: string | null;
        }>(
          `SELECT a.at, a.action, a.actor_kind, a.actor_sub, a.actor_groups, a.acting_office_id, o.slug AS acting_slug, o.title AS acting_title,
             v.n, a.content_hash, a.from_state, a.to_state, a.note
           FROM audit_event a LEFT JOIN content_version v ON v.id = a.version_id LEFT JOIN office o ON o.id = a.acting_office_id
           WHERE a.item_id = $1 ORDER BY a.id`,
          [item.id],
        );
        return {
          entries: rows.map((row) =>
            create(HistoryEntrySchema, {
              at: timestampFromDate(row.at),
              action: row.action,
              actorSubject: row.actor_sub ?? '',
              actorLabel: actorLabel(
                { kind: row.actor_kind, groups: row.actor_groups, actingOffice: row.acting_slug === null ? null : { slug: row.acting_slug, title: row.acting_title as string } },
                office,
              ),
              actingOfficeId: row.acting_office_id ?? '',
              versionNumber: row.n ?? 0,
              // A hash covers what was withheld: given only where nothing is.
              ...(row.content_hash !== null && !lens.affected([subjectKey('content_item', item.id)]) ? { contentHash: row.content_hash } : {}),
              fromState: row.from_state ?? '',
              toState: row.to_state ?? '',
              note: lens.text(row.note ?? '', [subjectKey('content_item', item.id)]),
            }),
          ),
        };
      });
    },

    previewWorkingItem: async (request, ctx) => {
      const caller = callerIn(ctx);
      requireEditorReader(caller);
      return tx(async (client) => {
        // No row locks: a read must not hold up a writer.
        const item = await loadItem(client, request.itemId, false);
        const version = await loadVersion(client, (item.working_version_id ?? item.live_version_id) as string, false);
        return previewOf(client, caller.audience, item.id, version);
      });
    },
  };
}

