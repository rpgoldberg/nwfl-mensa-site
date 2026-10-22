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
//               Admin by break-glass with a written reason; bound to the hash
//               the approver saw; derives public_ast and both search indexes;
//               repoints the live version BEFORE superseding the old one
//   withdraw    the item's office or an approver; 410 to the public at once
//   restore     the item's office; a new draft that stays withdrawn until
//               approved
// The database enforces the transitions as well (0007); these checks give the
// caller a precise answer first.
// ============================================================================
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from '@connectrpc/connect';
import { recordAudit } from '../audit/audit.js';
import { type Caller, callerOf } from '../auth/caller.js';
import { requireContentApprover, requireOffice, requireOfficer, requireUser, rolesOf } from '../auth/roles.js';
import { dbError } from '../db/errors.js';
import type { Db } from '../db/pool.js';
import { type TxClient, inTransaction } from '../db/tx.js';
import {
  ContentItemSchema,
  type ContentItem,
  type ContentService,
  ContentVersionSchema,
  HistoryEntrySchema,
  StoredFileSchema,
  type Targets as ProtoTargets,
} from '../gen/nwfl/mensa/v1/content_pb.js';
import { FILE_AUDIENCES, FILE_ROLES, ITEM_VISIBILITIES, KINDS, KIND_NAMES, STATES, VERSION_STATUSES, namesOf } from './enums.js';
import { contentHash } from './hash.js';
import { parseMarkup } from './markup.js';
import { deriveForApproval, normalizeTree, referencedFiles, toProtoDocument } from './tree.js';

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

interface VersionRow {
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

async function loadItem(client: TxClient, itemId: string): Promise<ItemRow> {
  const { rows } = await client.query<ItemRow>(
    `SELECT i.id, i.slug, i.kind, i.office_id, o.slug AS office_slug, i.state, i.live_version_id, i.working_version_id, i.withdrawn_at
     FROM content_item i JOIN office o ON o.id = i.office_id WHERE i.id = $1 FOR UPDATE OF i`,
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

async function loadVersion(client: TxClient, versionId: string): Promise<VersionRow> {
  const { rows } = await client.query<VersionRow>(`SELECT * FROM content_version WHERE id = $1 FOR UPDATE`, [versionId]);
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

async function addEditor(client: TxClient, versionId: string, subject: string): Promise<void> {
  await client.query(`INSERT INTO content_version_editor (version_id, subject) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [versionId, subject]);
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

async function versionMessage(client: TxClient, row: VersionRow) {
  const { rows: files } = await client.query<{ id: string; filename: string; mime_type: string; size_bytes: string; sha256: Buffer; audience: string; role: string; public_copy_of: string | null }>(
    `SELECT id, filename, mime_type, size_bytes::text AS size_bytes, sha256, audience, role, public_copy_of FROM stored_file WHERE version_id = $1 ORDER BY filename, id`,
    [row.id],
  );
  return create(ContentVersionSchema, {
    id: row.id,
    itemId: row.item_id,
    number: row.n,
    status: VERSION_STATUSES[row.status],
    title: row.title,
    summary: row.summary ?? '',
    visibility: ITEM_VISIBILITIES[row.visibility],
    body: toProtoDocument(normalizeTree(row.body_ast)),
    bodyMarkup: row.body_src,
    ...(row.content_hash !== null ? { contentHash: row.content_hash } : {}),
    targets: { website: row.target_website, newsletter: row.target_newsletter, email: row.target_email },
    editionId: row.edition_id ?? '',
    printAsIs: row.print_as_is,
    onBehalfOf: row.on_behalf_of ?? '',
    ...(row.ready_at !== null ? { readyAt: timestampFromDate(row.ready_at) } : {}),
    ...(row.approved_at !== null ? { approvedAt: timestampFromDate(row.approved_at) } : {}),
    files: files.map((file) =>
      create(StoredFileSchema, {
        id: file.id,
        filename: file.filename,
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

/** An item as officers see it: the live version and the working one, members passages kept. */
async function officerItem(client: TxClient, itemId: string): Promise<ContentItem> {
  const { rows } = await client.query<ItemRow>(
    `SELECT i.id, i.slug, i.kind, i.office_id, '' AS office_slug, i.state, i.live_version_id, i.working_version_id, i.withdrawn_at
     FROM content_item i WHERE i.id = $1`,
    [itemId],
  );
  const item = rows[0] as ItemRow;
  const live = item.live_version_id === null ? undefined : await versionMessage(client, await loadVersion(client, item.live_version_id));
  const working = item.working_version_id === null ? undefined : await versionMessage(client, await loadVersion(client, item.working_version_id));
  return create(ContentItemSchema, {
    id: item.id,
    slug: item.slug,
    kind: KINDS[item.kind],
    officeId: item.office_id,
    state: STATES[item.state],
    ...(live !== undefined ? { live } : {}),
    ...(working !== undefined ? { working } : {}),
    ...(item.withdrawn_at !== null ? { withdrawnAt: timestampFromDate(item.withdrawn_at) } : {}),
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
        return { item: await officerItem(client, item.id) };
      });
    },

    saveDraft: async (request, ctx) => {
      const caller = callerIn(ctx);
      return tx(async (client) => {
        const item = await loadItemAs(client, caller, request.itemId);
        requireOffice(caller, item.office_slug);
        let version =
          item.working_version_id !== null
            ? await loadVersion(client, item.working_version_id)
            : await newVersion(client, item, await loadVersion(client, item.live_version_id as string), caller);
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
        return { item: await officerItem(client, item.id), problems };
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
        const withFlag = { ...version, print_as_is: request.printAsIs };
        const hash = await hashOf(client, withFlag, targets, editionId);
        await client.query(
          `UPDATE content_version SET print_as_is = $2, target_website = $3, target_newsletter = $4, target_email = $5, edition_id = $6,
             status = 'ready', content_hash = $7, ready_at = now() WHERE id = $1`,
          [version.id, request.printAsIs, targets.website, targets.newsletter, targets.email, editionId, hash],
        );
        if (item.state === 'draft') await client.query(`UPDATE content_item SET state = 'ready', updated_at = now() WHERE id = $1`, [item.id]);
        await recordAudit(client, caller, {
          action: 'ready',
          subjectKind: 'content_version',
          subjectId: version.id,
          itemId: item.id,
          versionId: version.id,
          contentHash: hash,
          fromState: 'draft',
          toState: 'ready',
          actingOfficeId: item.office_id,
        });
        return { item: await officerItem(client, item.id) };
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
        return { item: await officerItem(client, item.id) };
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
        const editors = (await client.query<{ subject: string }>(`SELECT subject FROM content_version_editor WHERE version_id = $1`, [version.id])).rows.map((row) => row.subject);
        let kind: 'normal' | 'self_breakglass' = 'normal';
        let reason: string | null = null;
        if (editors.includes(caller.subject as string)) {
          if (!request.breakGlass) throw new ConnectError('you edited this version; the other approver must approve it', Code.PermissionDenied);
          if (!rolesOf(caller).admin) throw new ConnectError('only the Admin may approve their own edit', Code.PermissionDenied);
          reason = request.breakGlassReason.trim();
          if (reason === '' || reason.length > MAX_NOTE) throw invalid('a break-glass approval needs a written reason');
          kind = 'self_breakglass';
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
             public_ast = $5, search_public = to_tsvector('english', $6), search_members = to_tsvector('english', $7)
           WHERE id = $1`,
          [version.id, caller.subject, kind, reason, JSON.stringify(derived.publicAst), derived.publicText, derived.membersText],
        );
        // Repoint live first: the old live version cannot be superseded while it is live.
        await client.query(
          `UPDATE content_item SET live_version_id = $2, working_version_id = NULL, state = 'published', withdrawn_at = NULL, updated_at = now() WHERE id = $1`,
          [item.id, version.id],
        );
        if (item.live_version_id !== null) await client.query(`UPDATE content_version SET status = 'superseded' WHERE id = $1`, [item.live_version_id]);
        await recordAudit(client, caller, {
          action: kind === 'normal' ? 'approve' : 'approve_self',
          subjectKind: 'content_version',
          subjectId: version.id,
          itemId: item.id,
          versionId: version.id,
          contentHash: version.content_hash,
          fromState: 'ready',
          toState: 'approved',
          note: reason,
        });
        return { item: await officerItem(client, item.id) };
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
        return { item: await officerItem(client, item.id) };
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
        return { item: await officerItem(client, item.id) };
      });
    },

    listWorkingItems: async (request, ctx) => {
      requireOfficer(callerIn(ctx));
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
        for (const row of rows) items.push(await officerItem(client, row.id));
        return { items };
      });
    },

    getWorkingItem: async (request, ctx) => {
      requireOfficer(callerIn(ctx));
      return tx(async (client) => {
        const item = await loadItem(client, request.itemId);
        return { item: await officerItem(client, item.id) };
      });
    },

    listItemHistory: async (request, ctx) => {
      requireOfficer(callerIn(ctx));
      return tx(async (client) => {
        const item = await loadItem(client, request.itemId);
        const { rows } = await client.query<{
          at: Date;
          action: string;
          actor_sub: string | null;
          acting_office_id: string | null;
          n: number | null;
          content_hash: Buffer | null;
          from_state: string | null;
          to_state: string | null;
          note: string | null;
        }>(
          `SELECT a.at, a.action, a.actor_sub, a.acting_office_id, v.n, a.content_hash, a.from_state, a.to_state, a.note
           FROM audit_event a LEFT JOIN content_version v ON v.id = a.version_id
           WHERE a.item_id = $1 ORDER BY a.id`,
          [item.id],
        );
        return {
          entries: rows.map((row) =>
            create(HistoryEntrySchema, {
              at: timestampFromDate(row.at),
              action: row.action,
              actorSubject: row.actor_sub ?? '',
              actingOfficeId: row.acting_office_id ?? '',
              versionNumber: row.n ?? 0,
              ...(row.content_hash !== null ? { contentHash: row.content_hash } : {}),
              fromState: row.from_state ?? '',
              toState: row.to_state ?? '',
              note: row.note ?? '',
            }),
          ),
        };
      });
    },
  };
}

