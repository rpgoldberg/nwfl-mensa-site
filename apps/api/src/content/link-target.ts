// ============================================================================
// LINKS L4: ContentService.GetLinkTarget, where a link in a PDF copy leads,
// for the site's leaving page /out/<id>. The audience comes from the verified
// caller (auth/caller.ts), as for ReadFile (files.ts).
//
// A copy's annotation carries only https://<origin>/out/<id>, never the URL
// (SPEC D2), so this read is the one way from an id to a URL. It resolves an
// id only when, read in one snapshot:
//   * the id is a link (pdf_link, 0024) whose latest status is active;
//   * its file is servable to this audience (files.ts servableFile: the live
//     version of a published item the audience may see, or a published
//     edition's issue PDF), and not hidden from it by a mark;
//   * the link is in pdf_copy_link for the copy this audience is served now
//     (files.ts servedInputs, from store.ts inputsFor: the copy keyed by the
//     inputs' hash now, ready), so
//     a link dropped from that copy, or held only by an older one, is not;
//   * its URL holds none of this audience's withheld quotes as the marks
//     stand now (targetHolds, load/links.ts: the loader's own check, every
//     decoded form), so a mark added since the copy was made holds it at once.
// A link turned off (pdf_link_disable) never resolves. It is DISABLED, with
// its date, file and page and never its URL, host or kind, only to a reader
// who may have the file now and could hold the link: an officer, or an
// audience whose copy carried it (the publication ledger, 0016, names each
// copy the audience was served, by its input hash; pdf_copy_link what that
// copy held). So a link only the members copy held is NOT_FOUND to the public.
// Everything else, an officer's read of an active link included (an officer
// is served the original, with its own links: Q8; the site asks again as the
// public), is NOT_FOUND "link not found", exactly as an unknown id. Nothing
// about a link is logged.
// ============================================================================
import type { MessageInitShape } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, type HandlerContext } from '@connectrpc/connect';
import { type Audience, callerOf } from '../auth/caller.js';
import type { Db } from '../db/pool.js';
import { inTransaction } from '../db/tx.js';
import { type GetLinkTargetResponseSchema, LinkTargetKind, LinkTargetStatus } from '../gen/nwfl/mensa/v1/content_pb.js';
import { LINK_ID, targetHolds } from '../load/links.js';
import { TENANT } from '../redaction/policy.js';
import { servableFile, servedInputs } from './files.js';

type Query = Pick<Db, 'query'>;
type Response = MessageInitShape<typeof GetLinkTargetResponseSchema>;

export type LinkTarget =
  | { kind: 'active'; url: string; host: string; mail: boolean; confirm: boolean; fileId: string; page: number; at: Date }
  | { kind: 'disabled'; fileId: string; page: number; at: Date }
  | { kind: 'not_found' };

const NOT_FOUND: LinkTarget = { kind: 'not_found' };

/** Where the link leads for this audience now, read in one snapshot. */
export async function linkTarget(db: Query, linkId: string, audience: Audience): Promise<LinkTarget> {
  if (!LINK_ID.test(linkId)) return NOT_FOUND;
  const { rows } = await db.query<{ file_id: string; page: number; url: string; host: string; kind: string; confirm: boolean; status: string; at: Date }>(
    `SELECT l.file_id, l.page, l.url, l.host, l.kind, l.confirm, s.status, s.at
       FROM pdf_link l
       JOIN LATERAL (SELECT status, at FROM pdf_link_status WHERE link_id = l.id ORDER BY at DESC, id DESC LIMIT 1) s ON true
      WHERE l.id = $1`,
    [linkId],
  );
  const link = rows[0];
  if (link === undefined) return NOT_FOUND;
  if ((await servableFile(db, link.file_id, audience)) === null) return NOT_FOUND;
  const inputs = await servedInputs(db, link.file_id, audience);
  if (inputs.kind === 'none') return NOT_FOUND;
  if (link.status !== 'active') {
    const carried = audience === 'officers' || (await everCarried(db, link.file_id, linkId, audience));
    return carried ? { kind: 'disabled', fileId: link.file_id, page: link.page, at: link.at } : NOT_FOUND;
  }
  if (inputs.kind !== 'copy') return NOT_FOUND;
  const held = await db.query(
    `SELECT 1 FROM pdf_copy_link cl JOIN pdf_copy c ON c.file_id = cl.file_id AND c.input_hash = cl.input_hash
      WHERE cl.file_id = $1 AND cl.input_hash = $2 AND cl.link_id = $3 AND c.status = 'ready'`,
    [link.file_id, inputs.hash, linkId],
  );
  if (held.rows.length === 0 || targetHolds(link.url, inputs.quotes)) return NOT_FOUND;
  return { kind: 'active', url: link.url, host: link.host, mail: link.kind === 'mail', confirm: link.confirm, fileId: link.file_id, page: link.page, at: link.at };
}

/** Whether a copy this audience was ever served (the ledger's 'copy' rows, by input hash) held the link. */
async function everCarried(db: Query, fileId: string, linkId: string, audience: Audience): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM publication_ledger g
       JOIN pdf_copy_link cl ON cl.file_id = g.subject_id AND cl.input_hash = decode(g.inputs ->> 'input_hash', 'hex')
      WHERE g.tenant_id = $1 AND g.subject_kind = 'stored_file' AND g.subject_id = $2 AND g.audience = $3
        AND g.inputs ->> 'served' = 'copy' AND cl.link_id = $4
      LIMIT 1`,
    [TENANT, fileId, audience, linkId],
  );
  return rows.length > 0;
}

export interface LinkDeps {
  db: Db;
}

const notFound = (): ConnectError => new ConnectError('link not found', Code.NotFound);

export function linkHandlers(deps: LinkDeps): { getLinkTarget: (request: { linkId: string }, ctx: HandlerContext) => Promise<Response> } {
  return {
    async getLinkTarget(request, ctx): Promise<Response> {
      const audience = callerOf(ctx.values).audience;
      const target = await inTransaction(deps.db, async (tx) => {
        await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
        return linkTarget(tx, request.linkId, audience);
      });
      if (target.kind === 'not_found') throw notFound();
      if (target.kind === 'disabled') return { status: LinkTargetStatus.DISABLED, fileId: target.fileId, page: target.page, statusAt: timestampFromDate(target.at) };
      return {
        status: LinkTargetStatus.ACTIVE,
        url: target.url,
        host: target.host,
        kind: target.mail ? LinkTargetKind.MAIL : LinkTargetKind.WEB,
        confirm: target.confirm,
        fileId: target.fileId,
        page: target.page,
        statusAt: timestampFromDate(target.at),
      };
    },
  };
}
