// ============================================================================
// The publishing workflow (R11, R25, P15, P18, D-P1): ContentService's writes
// and officer reads. Each RPC is one transaction: lock the item, check who may
// do this and whether the state allows it, write, audit, answer.
//
//   create      a holder of the office, "Posting as" it; the Admin for any
//               office (audited as for_office)
//   save draft  the item's office (or the Admin); a ready version goes back to
//               draft, unless it is print-as-is; a published or withdrawn item
//               gets a new version as its revision
//   mark ready  the item's office; no markup problems; targets default to
//               website and newsletter on, email off (P15), and an officers
//               item never targets the newsletter or email; records the hash
//   send back   an approver (Admin, Webmaster), with a note
//   approve     an approver who did not edit the version (four eyes), or the
//               Admin by break-glass with a written reason; while the Admin
//               has set the content rule to one approver (SOLO-APPROVE, 0023),
//               an approver who edited it too, recorded as self_single; every
//               approval records the rule it was made under; bound to the hash
//               the approver saw; derives public_ast and both search indexes;
//               repoints the live version BEFORE superseding the old one
//   withdraw    the item's office or an approver; 410 to the public at once
//   restore     the item's office; a new draft that stays withdrawn until
//               approved
// The officer reads (the queue, an item, its history, its preview) are for an
// officer, the Admin or the Webmaster (EDITOR E1). The preview is the working
// version as the public and members will get it: approval's derivation, then
// the published read's body decision and lens, for each audience.
// The database enforces the transitions as well (0007); these checks give the
// caller a precise answer first.
// ============================================================================
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from '@connectrpc/connect';
import { recordAudit } from '../audit/audit.js';
import { type Audience, type Caller, callerOf } from '../auth/caller.js';
import { requireContentApprover, requireEditorReader, requireOffice, requireUser, rolesOf } from '../auth/roles.js';
import { dbError } from '../db/errors.js';
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
import { parseMarkup } from './markup.js';
import { deriveForApproval, normalizeTree, referencedFiles, toProtoDocument } from './tree.js';
import { bylineFor, itemHidden, slugFor } from './redact.js';
import { loadLens } from '../redaction/lens.js';
import { recordItems } from '../ledger/ledger.js';
import { type Rule, readRule } from '../approval/service.js';
import { type Lens, subjectKey } from '../redaction/render.js';
import { actorLabel } from './actor-label.js';
// A cycle (service.ts mounts these handlers), safe: bodyFor is read at call time, never at load.
import { bodyFor } from './service.js';

export interface WorkflowDeps {
  db: Db;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VISIBILITY_NAMES = namesOf(ITEM_VISIBILITIES);
const STATE_NAMES = namesOf(STATES);
const MAX_NOTE = 2_000;

interface ItemRow {
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
}

/** normal: a second officer; self_breakglass: the Admin's logged own approval; self_single: an editor's own, under one approver. */
export type ApprovalKind = 'normal' | 'self_breakglass' | 'self_single';
const AUDIT_ACTION: Record<ApprovalKind, string> = { normal: 'approve', self_breakglass: 'approve_self', self_single: 'approve_single' };

interface Targets {
  website: boolean;
  newsletter: boolean;
  email: boolean;
}

const invalid = (message: string): ConnectError => new ConnectError(message, Code.InvalidArgument);
const precondition = (message: string): ConnectError => new ConnectError(message, Code.FailedPrecondition);
const notFound = (): ConnectError => new ConnectError('item not found', Code.NotFound);

function requireId(value: string, field: string): string {
  if (!UUID.test(value)) throw invalid(`${field} is not an id`);
  return value;
}

/** `lock: false` for a read that must not wait on (or hold up) a writer: the preview. */
async function loadItem(client: TxClient, itemId: string, lock = true): Promise<ItemRow> {
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

async function loadVersion(client: TxClient, versionId: string, lock = true): Promise<VersionRow> {
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
 * Approval's writes, once the approver's checks have passed: derive public_ast and both search
 * indexes, make a file referenced only inside members passages a members file, approve, repoint the
 * live version BEFORE superseding the old one, audit, and record the ledger. Shared by Approve and the
 * issue loader (load/load.ts), so the two cannot drift (MLOGIN N-7).
 */
export async function applyApproval(
  client: TxClient,
  caller: Caller,
  item: Pick<ItemRow, 'id' | 'live_version_id'>,
  version: VersionRow,
  approval: { kind: ApprovalKind; reason: string | null; rule: Rule },
): Promise<void> {
  const derived = deriveForApproval({ title: version.title, summary: version.summary, visibility: version.visibility, body: version.body_ast });
  // A file referenced only inside members passages becomes a members file (section 4 rule 4).
  const { membersOnly } = referencedFiles(normalizeTree(version.body_ast));
  if (membersOnly.length > 0) {
    await client.query(
      `UPDATE stored_file SET audience = 'members' WHERE version_id = $1 AND id = ANY($2) AND audience = 'public' AND role <> 'public_copy'`,
      [version.id, membersOnly],
    );
  }
  await client.query(
    `UPDATE content_version SET status = 'approved', approved_at = now(), approved_by_sub = $2, approval_kind = $3, approval_reason = $4,
       public_ast = $5, search_public = to_tsvector('english', $6), search_members = to_tsvector('english', $7), approval_rule = $8
     WHERE id = $1`,
    [version.id, caller.subject, approval.kind, approval.reason, JSON.stringify(derived.publicAst), derived.publicText, derived.membersText, approval.rule],
  );
  // Repoint live first: the old live version cannot be superseded while it is live.
  await client.query(
    `UPDATE content_item SET live_version_id = $2, working_version_id = NULL, state = 'published', withdrawn_at = NULL, updated_at = now() WHERE id = $1`,
    [item.id, version.id],
  );
  if (item.live_version_id !== null) await client.query(`UPDATE content_version SET status = 'superseded' WHERE id = $1`, [item.live_version_id]);
  await recordAudit(client, caller, {
    action: AUDIT_ACTION[approval.kind],
    subjectKind: 'content_version',
    subjectId: version.id,
    itemId: item.id,
    versionId: version.id,
    contentHash: version.content_hash,
    fromState: 'ready',
    toState: 'approved',
    note: approval.reason,
    payload: { approval_rule: approval.rule },
  });
  await recordItems(client, [item.id]);
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

/**
 * A version as the lens's audience may see it: its text through the lens, its markup and hash only
 * where nothing was withheld (body_markup_withheld says so, so an edit form is never filled from the
 * empty markup), and whether `subject` edited it.
 */
async function versionMessage(client: TxClient, row: VersionRow, lens: Lens, subject: string) {
  const subjects = [subjectKey('content_item', row.item_id)];
  const withheld = withholds(lens, row);
  const edited = await client.query(`SELECT 1 FROM content_version_editor WHERE version_id = $1 AND subject = $2`, [row.id, subject]);
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
    callerEdited: edited.rows.length > 0,
    targets: { website: row.target_website, newsletter: row.target_newsletter, email: row.target_email },
    editionId: row.edition_id ?? '',
    printAsIs: row.print_as_is,
    onBehalfOf: bylineFor(row.on_behalf_of, subjects, lens),
    ...(row.ready_at !== null ? { readyAt: timestampFromDate(row.ready_at) } : {}),
    ...(row.approved_at !== null ? { approvedAt: timestampFromDate(row.approved_at) } : {}),
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
  const { rows } = await client.query<ItemRow>(
    `SELECT i.id, i.slug, i.kind, i.office_id, '' AS office_slug, i.state, i.live_version_id, i.working_version_id, i.withdrawn_at
     FROM content_item i WHERE i.id = $1`,
    [itemId],
  );
  const item = rows[0] as ItemRow;
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
  const subject = caller.subject as string; // officer reads and writes are for a signed-in person
  const live = liveRow === undefined ? undefined : await versionMessage(client, liveRow, lens, subject);
  const working = workingRow === undefined ? undefined : await versionMessage(client, workingRow, lens, subject);
  return create(ContentItemSchema, {
    id: item.id,
    slug: slugFor(item, lens),
    kind: KINDS[item.kind],
    officeId: item.office_id,
    state: STATES[item.state],
    ...(live !== undefined ? { live } : {}),
    ...(working !== undefined ? { working } : {}),
    ...(item.withdrawn_at !== null ? { withdrawnAt: timestampFromDate(item.withdrawn_at) } : {}),
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
      return tx(async (client) => {
        const item = await loadItemAs(client, caller, request.itemId);
        requireOffice(caller, item.office_slug);
        // The data-loss guard (EDITOR E1): a caller who reads this item with anything withheld got no
        // markup, so their save would overwrite the body with what they could not see.
        const base = await loadVersion(client, (item.working_version_id ?? item.live_version_id) as string);
        const lens = await loadLens(client, caller.audience, { items: [item.id], versions: [base.id] });
        if (withholds(lens, base)) throw precondition('part of this item is withheld from you; an officer who can see all of it must edit it');
        let version = item.working_version_id !== null ? base : await newVersion(client, item, base, caller);
        const from = version.status;
        if (version.status === 'ready') {
          if (version.print_as_is) throw precondition('a print-as-is version can be approved or sent back, never edited');
          await client.query(`UPDATE content_version SET status = 'draft' WHERE id = $1`, [version.id]);
          if (item.state === 'ready') await client.query(`UPDATE content_item SET state = 'draft' WHERE id = $1`, [item.id]);
        }
        const title = publicLine(request.title.trim());
        if (title === '') throw invalid('title is required');
        publicLine(request.summary);
        const visibility = VISIBILITY_NAMES.get(request.visibility) ?? version.visibility;
        const { tree, problems } = parseMarkup(request.bodyMarkup);
        version = (
          await client.query<VersionRow>(
            `UPDATE content_version SET title = $2, summary = $3, visibility = $4, body_src = $5, body_ast = $6,
               target_newsletter = (target_newsletter AND $4 <> 'officers'), target_email = (target_email AND $4 <> 'officers'), updated_at = now()
             WHERE id = $1 RETURNING *`,
            [version.id, title, request.summary.trim() === '' ? null : request.summary.trim(), visibility, request.bodyMarkup, JSON.stringify(tree)],
          )
        ).rows[0] as VersionRow;
        await addEditor(client, version.id, caller.subject as string);
        await recordAudit(client, caller, {
          action: 'save',
          subjectKind: 'content_version',
          subjectId: version.id,
          itemId: item.id,
          versionId: version.id,
          fromState: from,
          toState: 'draft',
          actingOfficeId: item.office_id,
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
      requireContentApprover(caller);
      const note = request.note.trim();
      if (note === '' || note.length > MAX_NOTE) throw invalid('a note for the author is required');
      return tx(async (client) => {
        const item = await loadItem(client, request.itemId);
        const version = item.working_version_id === null ? undefined : await loadVersion(client, item.working_version_id);
        if (version?.status !== 'ready') throw precondition('only a ready version can be sent back');
        await client.query(`UPDATE content_version SET status = 'draft' WHERE id = $1`, [version.id]);
        if (item.state === 'ready') await client.query(`UPDATE content_item SET state = 'draft', updated_at = now() WHERE id = $1`, [item.id]);
        await recordAudit(client, caller, {
          action: 'send_back',
          subjectKind: 'content_version',
          subjectId: version.id,
          itemId: item.id,
          versionId: version.id,
          fromState: 'ready',
          toState: 'draft',
          note,
        });
        return { item: await officerItem(client, item.id, caller) };
      });
    },

    approve: async (request, ctx) => {
      const caller = callerIn(ctx);
      requireContentApprover(caller);
      return tx(async (client) => {
        const item = await loadItem(client, request.itemId);
        let version = item.working_version_id === null ? undefined : await loadVersion(client, item.working_version_id);
        if (version?.status !== 'ready') throw precondition('only a ready version can be approved');
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
            if (!rolesOf(caller).admin) throw new ConnectError('only the Admin may approve their own edit', Code.PermissionDenied);
            reason = request.breakGlassReason.trim();
            if (reason === '' || reason.length > MAX_NOTE) throw invalid('a break-glass approval needs a written reason');
            kind = 'self_breakglass';
          } else if (rule === 'one_approver') {
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
        if (targets.newsletter && editionId !== null) {
          const edition = (await client.query<{ title: string; status: string }>(`SELECT title, status FROM edition WHERE id = $1`, [editionId])).rows[0];
          if (edition !== undefined && FROZEN_EDITION.has(edition.status)) {
            throw precondition(`${edition.title} is already frozen for print: pick an open edition, then approve`);
          }
        }
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

        await applyApproval(client, caller, item, version, { kind, reason, rule });
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
      const statuses = request.states.length === 0 ? ['draft', 'ready'] : request.states.map((state) => STATE_NAMES.get(state)).filter((s) => s === 'draft' || s === 'ready');
      if (request.officeId !== '') requireId(request.officeId, 'office_id');
      if (request.editionId !== '') requireId(request.editionId, 'edition_id');
      return tx(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `SELECT i.id FROM content_item i JOIN content_version w ON w.id = i.working_version_id
           WHERE w.status = ANY($1) AND ($2::uuid IS NULL OR i.office_id = $2) AND ($3::uuid IS NULL OR w.edition_id = $3)
           ORDER BY w.updated_at DESC, i.id`,
          [statuses, request.officeId === '' ? null : request.officeId, request.editionId === '' ? null : request.editionId],
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

