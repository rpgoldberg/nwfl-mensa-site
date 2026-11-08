// ============================================================================
// MembershipVerifierService (R33): the verifier client only (auth/caller.ts
// admits nothing else here, and no other service admits it).
//
//   ListPendingVerifications  the undecided, unchecked sign-ups that typed a
//                             number: id, number, last name and the email
//                             stored on the sign-up (VET), oldest first, ten
//                             at most. The verifier's only read that returns
//                             a number; each row read is audited, no payload.
//   ReportVerification        the outcome and today's date. What the sign-up
//                             typed is kept (PROFILE-ID, 0028); the sign-up
//                             leaves this list, which reads unchecked rows.
//                             A local match does not approve the sign-up: an
//                             officer still does (R24). VET: a duplicate claim
//                             may name the earlier sign-up, which must exist
//                             and be another; no other outcome may name one.
//                             SIGNOUT (C): the same report again (outcome
//                             and earlier sign-up) after it landed is a no-op
//                             answered OK, decided since or not; another
//                             outcome stays FAILED_PRECONDITION, and a sign-up
//                             that is gone NOT_FOUND (the table on the RPC).
//   ListReleasedClaims        VET: the released claims after a cursor, oldest
//                             first, a hundred at most: sign-up ids, kinds and
//                             times only (0027 records them append-only, in
//                             commit order, so the cursor never goes back).
// ============================================================================
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, type ConnectRouter, type HandlerContext } from '@connectrpc/connect';
import { recordAudit } from '../audit/audit.js';
import { callerOf } from '../auth/caller.js';
import { dbError } from '../db/errors.js';
import type { Db } from '../db/pool.js';
import { type TxClient, inTransaction } from '../db/tx.js';
import { todayIn } from '../events/zone.js';
import { ClaimReleaseKind, MembershipVerifierService, VerificationOutcome } from '../gen/nwfl/mensa/v1/membership_verifier_pb.js';

export interface VerifierDeps {
  db: Db;
  now: () => Date;
}

export const MAX_PENDING_PAGE = 10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OUTCOMES: Partial<Record<VerificationOutcome, string>> = {
  [VerificationOutcome.VERIFIED_LOCAL]: 'verified_local',
  [VerificationOutcome.VERIFIED_OTHER_GROUP]: 'verified_other_group',
  [VerificationOutcome.NOT_FOUND]: 'not_found',
  [VerificationOutcome.ERROR]: 'error',
  [VerificationOutcome.EMAIL_MISMATCH]: 'email_mismatch',
  [VerificationOutcome.DUPLICATE_CLAIM]: 'duplicate_claim',
};
export const MAX_RELEASED_PAGE = 100;
/** A cursor: a release's seq, as digits (empty for the start). */
const CURSOR = /^(?:0|[1-9][0-9]{0,17})$/;
const RELEASE_KINDS: Record<string, ClaimReleaseKind> = {
  rejected: ClaimReleaseKind.REJECTED,
  reopened: ClaimReleaseKind.REOPENED,
  account_deleted: ClaimReleaseKind.ACCOUNT_DELETED,
  deleted: ClaimReleaseKind.DELETED,
};
// What a sign-up the verifier may act on looks like.
const WAITING = `verification = 'unchecked' AND decision = 'pending' AND membership_number IS NOT NULL`;

export function verifierRoutes(deps: VerifierDeps): (router: ConnectRouter) => void {
  const { db } = deps;
  const tx = async <T>(fn: (client: TxClient) => Promise<T>): Promise<T> => {
    try {
      return await inTransaction(db, fn);
    } catch (error) {
      throw dbError(error);
    }
  };

  return (router) => {
    router.service(MembershipVerifierService, {
      listPendingVerifications: async (request, ctx: HandlerContext) => {
        if (request.pageSize < 0) throw new ConnectError('page_size must not be negative', Code.InvalidArgument);
        const size = request.pageSize === 0 ? MAX_PENDING_PAGE : Math.min(request.pageSize, MAX_PENDING_PAGE);
        const caller = callerOf(ctx.values);
        return tx(async (client) => {
          const { rows } = await client.query<{ id: string; membership_number: string; last_name: string; email: string }>(
            `SELECT id, membership_number, last_name, email FROM signup_request WHERE ${WAITING} ORDER BY created_at, id LIMIT $1`,
            [size],
          );
          for (const row of rows) await recordAudit(client, caller, { action: 'verification_listed', subjectKind: 'signup_request', subjectId: row.id });
          return { pending: rows.map((row) => ({ requestId: row.id, membershipNumber: row.membership_number, lastName: row.last_name, email: row.email })) };
        });
      },

      reportVerification: async (request, ctx: HandlerContext) => {
        const outcome = OUTCOMES[request.outcome];
        if (outcome === undefined) throw new ConnectError('outcome is required', Code.InvalidArgument);
        if (!UUID.test(request.requestId)) throw new ConnectError('request_id is not an id', Code.InvalidArgument);
        const conflicting = request.conflictingRequestId === '' ? null : request.conflictingRequestId;
        if (conflicting !== null) {
          if (request.outcome !== VerificationOutcome.DUPLICATE_CLAIM) throw new ConnectError('conflicting_request_id goes with DUPLICATE_CLAIM only', Code.InvalidArgument);
          if (!UUID.test(conflicting) || conflicting === request.requestId) throw new ConnectError('conflicting_request_id is not another sign-up', Code.InvalidArgument);
        }
        const caller = callerOf(ctx.values);
        return tx(async (client) => {
          if (conflicting !== null) {
            const { rows: earlier } = await client.query(`SELECT 1 FROM signup_request WHERE id = $1`, [conflicting]);
            if (earlier.length === 0) throw new ConnectError('conflicting_request_id names no sign-up', Code.InvalidArgument);
          }
          const { rows } = await client.query(
            `UPDATE signup_request SET verification = $2, verified_on = $3, conflicting_request_id = $4
             WHERE id = $1 AND ${WAITING} RETURNING id`,
            [request.requestId, outcome, todayIn(deps.now()), conflicting],
          );
          if (rows.length === 0) {
            // SIGNOUT (C): a retry of the report that landed (the same outcome and earlier sign-up) is
            // a no-op, decided since or not; anything else is refused as before.
            const { rows: known } = await client.query<{ landed: boolean }>(
              `SELECT verification = $2 AND conflicting_request_id IS NOT DISTINCT FROM $3::uuid AS landed FROM signup_request WHERE id = $1`,
              [request.requestId, outcome, conflicting],
            );
            const found = known[0];
            if (found === undefined) throw new ConnectError('sign-up not found', Code.NotFound);
            if (found.landed) return {};
            throw new ConnectError('this sign-up is not waiting for a check', Code.FailedPrecondition);
          }
          await recordAudit(client, caller, {
            action: 'verification_report',
            subjectKind: 'signup_request',
            subjectId: request.requestId,
            fromState: 'unchecked',
            toState: outcome,
          });
          return {};
        });
      },

      listReleasedClaims: async (request) => {
        if (request.pageSize < 0) throw new ConnectError('page_size must not be negative', Code.InvalidArgument);
        if (request.after !== '' && !CURSOR.test(request.after)) throw new ConnectError('after is not a cursor', Code.InvalidArgument);
        const size = request.pageSize === 0 ? MAX_RELEASED_PAGE : Math.min(request.pageSize, MAX_RELEASED_PAGE);
        return tx(async (client) => {
          // Fix 1: the text cursor has its own name, so ORDER BY sorts the bigint seq, never its text
          // ('10' before '9' would page out of order and skip releases).
          const { rows } = await client.query<{ cursor_text: string; request_id: string; kind: string; released_at: Date }>(
            `SELECT seq::text AS cursor_text, request_id, kind, released_at FROM signup_claim_release WHERE seq > $1::bigint ORDER BY seq LIMIT $2`,
            [request.after === '' ? '0' : request.after, size],
          );
          return {
            released: rows.map((row) => ({ requestId: row.request_id, kind: RELEASE_KINDS[row.kind], releasedAt: timestampFromDate(row.released_at) })),
            nextCursor: rows.at(-1)?.cursor_text ?? request.after,
          };
        });
      },
    });
  };
}
