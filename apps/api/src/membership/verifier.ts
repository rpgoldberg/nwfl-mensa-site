// ============================================================================
// MembershipVerifierService (R33): the verifier client only (auth/caller.ts
// admits nothing else here, and no other service admits it).
//
//   ListPendingVerifications  the undecided, unchecked sign-ups that typed a
//                             number: id, number and last name, oldest first,
//                             ten at most. The only read that returns a
//                             number; each row read is audited, no payload.
//   ReportVerification        the outcome and today's date, with the number
//                             and the last name erased in the same statement.
//                             A local match does not approve the sign-up: an
//                             officer still does (R24).
// ============================================================================
import { Code, ConnectError, type ConnectRouter, type HandlerContext } from '@connectrpc/connect';
import { recordAudit } from '../audit/audit.js';
import { callerOf } from '../auth/caller.js';
import { dbError } from '../db/errors.js';
import type { Db } from '../db/pool.js';
import { type TxClient, inTransaction } from '../db/tx.js';
import { todayIn } from '../events/zone.js';
import { MembershipVerifierService, VerificationOutcome } from '../gen/nwfl/mensa/v1/membership_verifier_pb.js';

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
          const { rows } = await client.query<{ id: string; membership_number: string; last_name: string }>(
            `SELECT id, membership_number, last_name FROM signup_request WHERE ${WAITING} ORDER BY created_at, id LIMIT $1`,
            [size],
          );
          for (const row of rows) await recordAudit(client, caller, { action: 'verification_listed', subjectKind: 'signup_request', subjectId: row.id });
          return { pending: rows.map((row) => ({ requestId: row.id, membershipNumber: row.membership_number, lastName: row.last_name })) };
        });
      },

      reportVerification: async (request, ctx: HandlerContext) => {
        const outcome = OUTCOMES[request.outcome];
        if (outcome === undefined) throw new ConnectError('outcome is required', Code.InvalidArgument);
        if (!UUID.test(request.requestId)) throw new ConnectError('request_id is not an id', Code.InvalidArgument);
        const caller = callerOf(ctx.values);
        return tx(async (client) => {
          const { rows } = await client.query(
            `UPDATE signup_request SET verification = $2, verified_on = $3, membership_number = NULL, last_name = NULL
             WHERE id = $1 AND ${WAITING} RETURNING id`,
            [request.requestId, outcome, todayIn(deps.now())],
          );
          if (rows.length === 0) {
            const { rows: known } = await client.query(`SELECT 1 FROM signup_request WHERE id = $1`, [request.requestId]);
            if (known.length === 0) throw new ConnectError('sign-up not found', Code.NotFound);
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
    });
  };
}
