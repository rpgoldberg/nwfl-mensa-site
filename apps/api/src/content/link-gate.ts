// ============================================================================
// The link gate's RPCs (EDITOR A3b, SPEC-v3 3.3): GetItemLinks and
// ConfirmLinks. The list, its hash and what an answer counts for are in
// item-links.ts; Approve's gate is in workflow.ts.
//
//   GetItemLinks  a reviewer (an officer, the Admin, the Webmaster), or a holder
//                 of the item's office: the working version's list (the live
//                 one's when nothing is being worked on, as the preview reads)
//                 through the caller's lens, its hash, the version's ready time,
//                 and each link's latest answer as it stands.
//   ConfirmLinks  a reviewer who did not edit the version, on a READY version
//                 only (its text is frozen then), with the hash of the list they
//                 read: a list changed since is refused. Each answer for a URL
//                 in the list is stored at once, with the office the reviewer
//                 acts for and the version's ready time; one for a URL not in
//                 it comes back in not_in_piece and is not stored. Audited once
//                 per call (links_confirmed), with counts only: no URL goes into
//                 the audit log.
// ============================================================================
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from '@connectrpc/connect';
import { recordAudit } from '../audit/audit.js';
import { type Caller, callerOf } from '../auth/caller.js';
import { requireReviewer, requireUser } from '../auth/roles.js';
import { dbError } from '../db/errors.js';
import type { Db } from '../db/pool.js';
import { type TxClient, inTransaction } from '../db/tx.js';
import { type ContentService, ItemLinkSchema, MachineVerdict } from '../gen/nwfl/mensa/v1/content_pb.js';
import { MAX_URL_LENGTH } from '../links/urls.js';
import type { StructuredLogger } from '../platform/logger.js';
import { type PieceLink, actualLinks, currentAnswers, linksAsSeen, linksSha256, loginWalled, rfc3339Micros } from './item-links.js';
import { normalizeTree } from './tree.js';
import { type ItemRow, MAX_NOTE, type VersionRow, actingOffice, loadItem, loadVersion, notFound, requireId, requireWholeView, timestampOfMicros } from './workflow.js';

export interface LinkGateDeps {
  db: Db;
  logger: StructuredLogger;
  now: () => Date;
}

/** At most this many answers in one call: a piece has far fewer links. */
export const MAX_ANSWERS = 500;

const precondition = (message: string): ConnectError => new ConnectError(message, Code.FailedPrecondition);
const invalid = (message: string): ConnectError => new ConnectError(message, Code.InvalidArgument);

interface Lists {
  /** The list as the caller sees it: what the hash covers and the reply shows. */
  seen: PieceLink[];
  /** The URLs of the list as it is, which the gate reads. */
  actual: Set<string>;
  /** The hash of the list as the caller sees it, bound to the version's ready time. */
  sha256: Buffer;
  /** The version's ready time, in microseconds since the epoch; null for a draft. */
  readyAtMicros: string | null;
}

export function linkGateHandlers(deps: LinkGateDeps): Partial<ServiceImpl<typeof ContentService>> {
  const callerIn = (ctx: HandlerContext): Caller => callerOf(ctx.values);
  const tx = async <T>(fn: (client: TxClient) => Promise<T>): Promise<T> => {
    try {
      return await inTransaction(deps.db, fn);
    } catch (error) {
      throw dbError(error);
    }
  };

  /** The version's list, as the caller sees it (and its hash) and as it is. NOT_FOUND when the caller's lens hides the item. */
  const listsOf = async (client: TxClient, caller: Caller, item: ItemRow, version: VersionRow): Promise<Lists> => {
    const linked = { id: version.id, itemId: item.id, onBehalfOf: version.on_behalf_of, body: normalizeTree(version.body_ast), officeId: item.office_id, editionId: version.edition_id };
    const { links, events } = await actualLinks(client, deps, linked);
    const seen = await linksAsSeen(client, caller.audience, linked, events);
    if (seen === undefined) throw notFound();
    const readyAtMicros =
      (await client.query<{ us: string | null }>(`SELECT (extract(epoch FROM ready_at) * 1000000)::bigint::text AS us FROM content_version WHERE id = $1`, [version.id])).rows[0]?.us ?? null;
    return { seen, actual: new Set(links.map((link) => link.url)), sha256: linksSha256(rfc3339Micros(readyAtMicros), seen), readyAtMicros };
  };

  /** Each link as the reply carries it, with its latest answer as it stands. */
  const shown = async (client: TxClient, item: ItemRow, version: VersionRow, links: readonly PieceLink[]) => {
    const office = (await client.query<{ title: string }>(`SELECT title FROM office WHERE id = $1`, [item.office_id])).rows[0] as { title: string };
    const answers = await currentAnswers(client, version.id, { slug: item.office_slug, title: office.title });
    return links.map((link) => {
      const answer = answers.get(link.url);
      return create(ItemLinkSchema, {
        url: link.url,
        label: link.label,
        where: link.where,
        loginWalled: loginWalled(link.url),
        machineVerdict: MachineVerdict.UNSPECIFIED,
        answeredByLabel: answer?.label ?? '',
        accepted: answer?.answer === 'yes',
      });
    });
  };


  return {
    getItemLinks: async (request, ctx) => {
      const caller = callerIn(ctx);
      const roles = requireUser(caller);
      const id = requireId(request.itemId, 'item_id');
      const reviewer = roles.officer || roles.admin || roles.webmaster;
      // As loadItemAs: a caller who can see no working item is told "not found", so the answer gives nothing away.
      if (!reviewer && roles.offices.length === 0) throw notFound();
      return tx(async (client) => {
        // A holder who reviews nothing reads their own office's items only. Another office's item and a
        // missing one get the same answer, so the answer tells nothing about which ids exist.
        if (!reviewer) {
          const slug = (await client.query<{ slug: string }>(`SELECT o.slug FROM content_item i JOIN office o ON o.id = i.office_id WHERE i.id = $1`, [id])).rows[0]?.slug;
          if (slug === undefined || !roles.offices.includes(slug)) throw new ConnectError('not permitted', Code.PermissionDenied);
        }
        // No row locks: a read must not hold up a writer.
        const item = await loadItem(client, id, false);
        // An item always has a working version or a live one.
        const version = await loadVersion(client, (item.working_version_id ?? item.live_version_id) as string, false);
        const { seen, sha256, readyAtMicros } = await listsOf(client, caller, item, version);
        return {
          linksSha256: sha256,
          links: await shown(client, item, version, seen),
          ...(readyAtMicros !== null ? { readyAt: timestampOfMicros(readyAtMicros) } : {}),
        };
      });
    },

    confirmLinks: async (request, ctx) => {
      const caller = callerIn(ctx);
      const roles = requireReviewer(caller);
      if (request.answers.length === 0) throw invalid('no answers were given');
      if (request.answers.length > MAX_ANSWERS) throw invalid(`at most ${MAX_ANSWERS} answers at a time`);
      // The last answer to a URL in this call is the one kept.
      const answers = new Map<string, { yes: boolean; note: string | null }>();
      for (const answer of request.answers) {
        const note = answer.note.trim();
        if (note.length > MAX_NOTE) throw invalid(`a note is at most ${MAX_NOTE} characters`);
        answers.set(answer.url, { yes: answer.yes, note: note === '' ? null : note });
      }
      return tx(async (client) => {
        const actingOfficeId = await actingOffice(client, roles, request.actingAsOfficeId);
        const item = await loadItem(client, request.itemId);
        const version = item.working_version_id === null ? undefined : await loadVersion(client, item.working_version_id);
        if (version?.status !== 'ready') throw precondition('only a version waiting for approval has its links checked');
        await requireWholeView(client, caller, version, 'check its links');
        const edited = (await client.query(`SELECT 1 FROM content_version_editor WHERE version_id = $1 AND subject = $2`, [version.id, caller.subject])).rows.length > 0;
        if (edited) throw new ConnectError('you edited this version; a second officer must check its links', Code.PermissionDenied);
        const { seen, actual, sha256 } = await listsOf(client, caller, item, version);
        if (!Buffer.from(request.linksSha256).equals(sha256)) throw precondition('the links changed since you opened them; reload them');
        const inPiece = new Set(seen.map((link) => link.url).filter((url) => actual.has(url)));
        const notInPiece: string[] = [];
        const counts = { answers: 0, yes: 0, no: 0, login_walled: 0 };
        for (const [url, answer] of answers) {
          if (url.length > MAX_URL_LENGTH || !inPiece.has(url)) {
            notInPiece.push(url);
            continue;
          }
          await client.query(
            `INSERT INTO content_link_check (item_id, version_id, url, source, answer, note, ready_at_seen, links_sha256, by_sub, by_groups, acting_office_id)
             SELECT $1, id, $3, 'human', $4, $5, ready_at, $6, $7, $8, $9 FROM content_version WHERE id = $2`,
            [item.id, version.id, url, answer.yes ? 'yes' : 'no', answer.note, sha256, caller.subject, [...caller.groups], actingOfficeId],
          );
          counts.answers += 1;
          counts[answer.yes ? 'yes' : 'no'] += 1;
          if (loginWalled(url)) counts.login_walled += 1;
        }
        if (counts.answers > 0) {
          await recordAudit(client, caller, {
            action: 'links_confirmed',
            subjectKind: 'content_version',
            subjectId: version.id,
            itemId: item.id,
            versionId: version.id,
            contentHash: version.content_hash,
            actingOfficeId,
            payload: counts,
          });
        }
        return { links: await shown(client, item, version, seen), notInPiece };
      });
    },
  };
}
