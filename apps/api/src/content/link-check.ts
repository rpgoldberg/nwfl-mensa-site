// ============================================================================
// LinkCheckService (L-ITEM, SPEC-v3 3.4; links SPEC section 6): the link
// checker's own service. The caller gate admits the linkcheck client only
// (auth/caller.ts); each handler checks it again.
//
//   ListLinksAwaitingVerdict  addresses only, sorted, each once, at most
//                             MAX_AWAITING and MAX_AWAITING_BYTES of them (the
//                             first always): those of the link list (item-links.ts,
//                             as it is, no lens) of every piece whose working
//                             version is ready or cleared, its office's event
//                             addresses included, that are waiting in it: no
//                             reviewer's answer on the version as it stands, and
//                             no verdict in the last RECHECK_HOURS. Each list
//                             handed out is audited (links_read, audience
//                             officers), with counts and item ids, no address.
//   RecordLinkVerdicts        a verdict per address, for every piece it is
//                             waiting in, as machine rows of content_link_check.
//                             All or nothing on its input: OK on a link that
//                             needs a sign-in or that the checker never fetches
//                             (the no-fetch list), an unspecified verdict or a
//                             reason that is not one of the checker's codes
//                             (REASON_CODES) refuses the call. An address not waiting
//                             (changed, answered, unknown) is returned, not kept.
//                             Audited once (link_verdicts), counts only.
//
// The checker writes source 'machine' only: it never answers for a reviewer,
// and it never adds or changes an address. L5's ListPublishedLinks and
// ReportLinkCheck join this service later.
// ============================================================================
import { createHash } from 'node:crypto';
import { Code, ConnectError, type ConnectRouter, type HandlerContext } from '@connectrpc/connect';
import { recordAudit } from '../audit/audit.js';
import { type Caller, callerOf } from '../auth/caller.js';
import { dbError } from '../db/errors.js';
import type { Db } from '../db/pool.js';
import { type TxClient, inTransaction } from '../db/tx.js';
import { MachineVerdict } from '../gen/nwfl/mensa/v1/content_pb.js';
import { LinkCheckService } from '../gen/nwfl/mensa/v1/link_check_pb.js';
import { MAX_URL_LENGTH } from '../links/urls.js';
import type { StructuredLogger } from '../platform/logger.js';
import { actualLinks, currentAnswers, loginWalled, neverFetched } from './item-links.js';
import { normalizeTree } from './tree.js';

export interface LinkCheckDeps {
  db: Db;
  logger: StructuredLogger;
  now: () => Date;
}

/** At most this many addresses handed out, or verdicts taken, in one call. */
export const MAX_AWAITING = 500;
/**
 * At most this many bytes of addresses handed out in one call (the first address always): what the
 * checker sends back must fit a message this service reads (READ_MAX_BYTES, grpc/server.ts), and it
 * writes requests of at most 200,000 bytes (apps/linkcheck items.ts MAX_RECORD_BYTES).
 */
export const MAX_AWAITING_BYTES = 180_000;
/** An address with a verdict this recent is not handed out again. */
export const RECHECK_HOURS = 24;
/** At most this many reason codes on one verdict. */
export const MAX_REASONS = 8;
/**
 * The checker's reason codes: the names of apps/linkcheck check.ts REASONS, in its order (a test holds the
 * two lists equal). A reason is one of these, never words of the caller's choosing: officers read them.
 */
export const REASON_CODES: readonly string[] = [
  'no-https', 'private-address', 'malformed', 'scheme', 'port', 'credentials', 'ip-literal', 'local-name', 'host-name', 'too-long', 'control',
  'nxdomain', 'no-address', 'dead', 'not-found-page', 'parked', 'no-mail', 'blocked', 'rate-limited', 'server-error', 'http-error', 'timeout', 'tls',
  'unreachable', 'protocol', 'dns-failure', 'unrelated-redirect', 'redirect-to-http', 'bad-redirect', 'too-many-redirects', 're-registered',
  'login-walled', 'no-fetch', 'upgraded', 'trimmed',
];
const REASONS: ReadonlySet<string> = new Set(REASON_CODES);

const STORED: Partial<Record<MachineVerdict, 'ok' | 'confirm' | 'drop'>> = {
  [MachineVerdict.OK]: 'ok',
  [MachineVerdict.CONFIRM]: 'confirm',
  [MachineVerdict.DROP]: 'drop',
};

const invalid = (message: string): ConnectError => new ConnectError(message, Code.InvalidArgument);

/** Only the link checker; the caller gate already says so, and this says it again. */
function requireLinkCheck(caller: Caller): Caller {
  if (caller.kind !== 'linkcheck') throw new ConnectError('this client may not call this service', Code.PermissionDenied);
  return caller;
}

/** The SHA-256, in hex, of a list of addresses: the audit row's subject, so no address goes into the log. */
const listId = (urls: readonly string[]): string => createHash('sha256').update(JSON.stringify(urls)).digest('hex');

/** Each address waiting for a verdict, with the items it waits in. */
export async function awaitingVerdicts(client: TxClient, deps: { logger: StructuredLogger; now: () => Date }): Promise<Map<string, string[]>> {
  const { rows } = await client.query<{ item_id: string; office_id: string; office_slug: string; office_title: string; version_id: string; on_behalf_of: string | null; body_ast: unknown; edition_id: string | null }>(
    `SELECT i.id AS item_id, i.office_id, o.slug AS office_slug, o.title AS office_title, v.id AS version_id, v.on_behalf_of, v.body_ast, v.edition_id
     FROM content_item i JOIN content_version v ON v.id = i.working_version_id JOIN office o ON o.id = i.office_id
     WHERE v.status IN ('ready', 'cleared') ORDER BY i.id`,
  );
  const awaiting = new Map<string, string[]>();
  for (const row of rows) {
    const { links } = await actualLinks(client, deps, { id: row.version_id, itemId: row.item_id, onBehalfOf: row.on_behalf_of, body: normalizeTree(row.body_ast), officeId: row.office_id, editionId: row.edition_id });
    if (links.length === 0) continue;
    const answered = await currentAnswers(client, row.version_id, { slug: row.office_slug, title: row.office_title });
    const recent = new Set(
      (
        await client.query<{ url: string }>(`SELECT DISTINCT url FROM content_link_check WHERE item_id = $1 AND source = 'machine' AND at > now() - make_interval(hours => $2)`, [
          row.item_id,
          RECHECK_HOURS,
        ])
      ).rows.map((r) => r.url),
    );
    for (const url of new Set(links.map((link) => link.url))) {
      if (answered.has(url) || recent.has(url)) continue;
      const items = awaiting.get(url);
      if (items === undefined) awaiting.set(url, [row.item_id]);
      else items.push(row.item_id);
    }
  }
  return awaiting;
}

export function linkCheckRoutes(deps: LinkCheckDeps): (router: ConnectRouter) => void {
  const tx = async <T>(fn: (client: TxClient) => Promise<T>): Promise<T> => {
    try {
      return await inTransaction(deps.db, fn);
    } catch (error) {
      throw dbError(error);
    }
  };
  const callerIn = (ctx: HandlerContext): Caller => requireLinkCheck(callerOf(ctx.values));

  return (router) => {
    router.service(LinkCheckService, {
      listLinksAwaitingVerdict: async (_request, ctx) => {
        const caller = callerIn(ctx);
        return tx(async (client) => {
          const awaiting = await awaitingVerdicts(client, deps);
          const all = [...awaiting.keys()].sort((a, b) => (a < b ? -1 : 1));
          const urls: string[] = [];
          let size = 0;
          for (const url of all) {
            size += Buffer.byteLength(url);
            if (urls.length === MAX_AWAITING || (urls.length > 0 && size > MAX_AWAITING_BYTES)) break;
            urls.push(url);
          }
          const more = all.length > urls.length;
          if (urls.length > 0) {
            const itemIds = [...new Set(urls.flatMap((url) => awaiting.get(url) as string[]))].sort();
            await recordAudit(client, caller, {
              action: 'links_read',
              subjectKind: 'link_list',
              subjectId: listId(urls),
              payload: { audience: 'officers', urls: urls.length, items: itemIds.length, item_ids: itemIds, more },
            });
          }
          return { urls, more };
        });
      },

      recordLinkVerdicts: async (request, ctx) => {
        const caller = callerIn(ctx);
        if (request.verdicts.length === 0) throw invalid('no verdicts were given');
        if (request.verdicts.length > MAX_AWAITING) throw invalid(`at most ${MAX_AWAITING} verdicts at a time`);
        // The last verdict for an address in this call is the one kept.
        const verdicts = new Map<string, { verdict: 'ok' | 'confirm' | 'drop'; reasons: string[] }>();
        for (const given of request.verdicts) {
          const verdict = STORED[given.verdict];
          if (verdict === undefined) throw invalid('each verdict is OK, CONFIRM or DROP');
          if (given.reasons.length > MAX_REASONS) throw invalid(`at most ${MAX_REASONS} reasons on a verdict`);
          if (given.reasons.some((reason) => !REASONS.has(reason))) throw invalid("a reason is one of the link checker's reason codes");
          if (verdict === 'ok' && loginWalled(given.url)) throw invalid('the link checker cannot accept a link that needs a sign-in to check');
          if (verdict === 'ok' && neverFetched(given.url)) throw invalid('the link checker cannot accept a link it never fetches');
          verdicts.set(given.url, { verdict, reasons: [...given.reasons] });
        }
        return tx(async (client) => {
          const awaiting = await awaitingVerdicts(client, deps);
          const notAwaiting: string[] = [];
          const counts = { ok: 0, confirm: 0, drop: 0, recorded: 0, not_awaiting: 0 };
          const recorded: string[] = [];
          for (const [url, { verdict, reasons }] of verdicts) {
            const items = url.length > MAX_URL_LENGTH ? undefined : awaiting.get(url);
            if (items === undefined) {
              notAwaiting.push(url);
              continue;
            }
            for (const itemId of items) {
              await client.query(`INSERT INTO content_link_check (item_id, url, source, answer, reasons, by_sub) VALUES ($1, $2, 'machine', $3, $4, $5)`, [
                itemId,
                url,
                verdict,
                JSON.stringify(reasons),
                caller.subject,
              ]);
            }
            counts[verdict] += 1;
            counts.recorded += items.length;
            recorded.push(url);
          }
          counts.not_awaiting = notAwaiting.length;
          if (counts.recorded > 0) {
            await recordAudit(client, caller, { action: 'link_verdicts', subjectKind: 'link_list', subjectId: listId(recorded.sort()), payload: counts });
          }
          return { recorded: counts.recorded, notAwaiting };
        });
      },
    });
  };
}
