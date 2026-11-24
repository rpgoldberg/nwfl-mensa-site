// ============================================================================
// MembershipVerifierService (R33): the verifier client only (auth/caller.ts
// admits nothing else here, and no other service admits it).
//
//   ListPendingVerifications  the undecided, unchecked sign-ups that typed a
//                             number: id, number, last name, the email
//                             stored on the sign-up (VET) and, OFFICER_VERIFY
//                             on only, the typed first name, oldest first, ten
//                             at most. The verifier's only read that returns
//                             a number; each row read is audited, no payload.
//   ReportVerification        the outcome and today's date. What the sign-up
//                             typed is kept (PROFILE-ID, 0028); the sign-up
//                             leaves this list, which reads unchecked rows.
//                             A local match does not approve the sign-up: an
//                             officer still does (R24), with one exception
//                             (OFFICER-VERIFY, switched on): an invited sign-up (the
//                             invite route) reported VERIFIED_LOCAL with
//                             first_name_matched true and the chapter's own
//                             local group (CHAPTER_GROUP_NAME) is approved
//                             by the report, in its transaction, as the
//                             verifier (decided_by_sub and approved_by_sub
//                             are its subject; audited approve_auto and
//                             approve_verified). Switched on, the report also
//                             keeps first_name_matched and local_group (0032; a
//                             first-name answer for a sign-up that typed
//                             none, or a group longer than 120 characters or
//                             holding a control character, is
//                             INVALID_ARGUMENT), but only beside an outcome
//                             that confirmed the number and the last name
//                             (standing-policy.ts confirmsMember): with not
//                             found, an error or a duplicate claim both are
//                             dropped, so a check that did not confirm the
//                             person says nothing about them (fix round 3,
//                             B1). Switched off, both are ignored, as
//                             before. Fix round 3, switched on: an approved
//                             sign-up whose owner asked for a fresh check
//                             (MembershipService SubmitSignup) is listed
//                             again under the same id, while its account
//                             still stands; its report replaces the earlier
//                             answers when the outcome is a local or an
//                             other-group match; an email mismatch is held
//                             for an approver to confirm, as for a first
//                             sign-up (ruling 3: it never opens officer
//                             tools by itself); anything else only notes the outcome
//                             (recheck_outcome): the earlier answers stand,
//                             so a failed fresh check changes no one's
//                             standing. It never decides. VET: a duplicate claim
//                             may name the earlier sign-up, which must exist
//                             and be another; no other outcome may name one.
//                             SIGNOUT (C): the same report again (outcome,
//                             earlier sign-up, first-name answer and local
//                             group; a fresh check's noted outcome too)
//                             after it landed is a no-op
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
import { type Caller, callerOf } from '../auth/caller.js';
import { dbError } from '../db/errors.js';
import type { Db } from '../db/pool.js';
import { type TxClient, inTransaction } from '../db/tx.js';
import { todayIn } from '../events/zone.js';
import { ClaimReleaseKind, MembershipVerifierService, VerificationOutcome } from '../gen/nwfl/mensa/v1/membership_verifier_pb.js';
import type { OfficerVerify } from '../auth/config.js';
import { confirmsMember } from '../auth/standing-policy.js';
import { LocalGroupStanding } from '../gen/nwfl/mensa/v1/membership_pb.js';
import { approveAccount } from './approve.js';
import { localStanding } from './local-group.js';

export interface VerifierDeps {
  db: Db;
  now: () => Date;
  /** OFFICER_VERIFY (auth/config.ts): on, with the chapter's own local group; null or absent is off, as before. */
  officerVerify?: OfficerVerify | null;
}

/** The most characters in a reported local group (0032). */
const MAX_LOCAL_GROUP = 120;
const CONTROL = /\p{Cc}/u;

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
// OFFICER-VERIFY (switched on): an approved sign-up whose owner asked for a fresh check (0032).
const RECHECK = `recheck_requested_at IS NOT NULL AND decision = 'approved' AND reopened_at IS NULL`;
// The same, for the list: with a number to check, and an account that still stands.
const RECHECK_LISTED = `${RECHECK} AND membership_number IS NOT NULL
  AND EXISTS (SELECT 1 FROM member_account a WHERE a.sub = signup_request.sub AND a.status IN ('member', 'affiliate'))`;

/** OFFICER-VERIFY (switched on): the sign-up decided and the account a member from the report's date, as the verifier. */
async function approveByReport(client: TxClient, caller: Caller, reported: { id: string; sub: string; verified_on: string }): Promise<void> {
  const by = caller.subject as string;
  await client.query(`UPDATE signup_request SET decision = 'approved', decided_at = now(), decided_by_sub = $2 WHERE id = $1`, [reported.id, by]);
  await recordAudit(client, caller, { action: 'approve_auto', subjectKind: 'signup_request', subjectId: reported.id, fromState: 'pending', toState: 'approved' });
  // The account is pending (the report read its route from a pending account, in this transaction).
  await approveAccount(client, { sub: reported.sub, by, verifiedOn: reported.verified_on });
  await recordAudit(client, caller, { action: 'approve_verified', subjectKind: 'member_account', subjectId: reported.sub, toState: 'member' });
}

export function verifierRoutes(deps: VerifierDeps): (router: ConnectRouter) => void {
  const { db } = deps;
  // OFFICER-VERIFY: null is switched off, and then the contract is as before (fix round 1).
  const officerVerify = deps.officerVerify ?? null;
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
            // Switched off, the query is as before. Switched on, the fresh checks asked for are listed with the
            // first checks, each by when it was asked.
            officerVerify === null
              ? `SELECT id, membership_number, last_name, email FROM signup_request WHERE ${WAITING} ORDER BY created_at, id LIMIT $1`
              : `SELECT id, membership_number, last_name, email FROM signup_request WHERE (${WAITING}) OR (${RECHECK_LISTED})
                 ORDER BY coalesce(recheck_requested_at, created_at), id LIMIT $1`,
            [size],
          );
          for (const row of rows) await recordAudit(client, caller, { action: 'verification_listed', subjectKind: 'signup_request', subjectId: row.id });
          const listed = { pending: rows.map((row) => ({ requestId: row.id, membershipNumber: row.membership_number, lastName: row.last_name, email: row.email })) };
          // Switched off, exactly as before (PROFILE-ID: no first name to the verifier); the first name is not even read.
          if (officerVerify === null) return listed;
          // OFFICER-VERIFY, switched on: the typed first name too, for the check to compare.
          const { rows: named } = await client.query<{ id: string; first_name: string | null }>(`SELECT id, first_name FROM signup_request WHERE id = ANY($1::uuid[])`, [
            rows.map((row) => row.id),
          ]);
          const firstNames = new Map(named.map((row) => [row.id, row.first_name ?? '']));
          return { pending: listed.pending.map((item) => ({ ...item, firstName: firstNames.get(item.requestId) ?? '' })) };
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
        // OFFICER-VERIFY, switched on only: the local group as reported, trimmed (empty is not reported), and the
        // first-name answer. Switched off, both are ignored, as an API before them ignored them.
        const reportedGroup = officerVerify === null || request.localGroup.trim() === '' ? null : request.localGroup.trim();
        if (reportedGroup !== null && ([...reportedGroup].length > MAX_LOCAL_GROUP || CONTROL.test(reportedGroup))) {
          throw new ConnectError(`local_group is at most ${MAX_LOCAL_GROUP} characters, with no control character`, Code.InvalidArgument);
        }
        // Fix round 3 (B1): both are kept only beside an outcome that confirmed the person. With any other, a
        // group or a first-name answer says nothing, and is dropped here (0032 refuses to store it).
        const confirming = confirmsMember(outcome);
        const localGroup = confirming ? reportedGroup : null;
        const firstNameMatched = officerVerify === null || !confirming ? null : (request.firstNameMatched ?? null);
        const caller = callerOf(ctx.values);
        return tx(async (client) => {
          if (firstNameMatched !== null) {
            const { rows: typed } = await client.query(`SELECT 1 FROM signup_request WHERE id = $1 AND first_name IS NULL`, [request.requestId]);
            if (typed.length > 0) throw new ConnectError('first_name_matched goes with a sign-up that typed a first name', Code.InvalidArgument);
          }
          if (conflicting !== null) {
            const { rows: earlier } = await client.query(`SELECT 1 FROM signup_request WHERE id = $1`, [conflicting]);
            if (earlier.length === 0) throw new ConnectError('conflicting_request_id names no sign-up', Code.InvalidArgument);
          }
          const { rows } = await client.query<{ id: string; sub: string; route: string | null; verified_on: string }>(
            `UPDATE signup_request s SET verification = $2, verified_on = $3, conflicting_request_id = $4, first_name_matched = $5, local_group = $6
             WHERE id = $1 AND ${WAITING}
             RETURNING id, sub, verified_on::text AS verified_on, (SELECT route FROM member_account a WHERE a.sub = s.sub AND a.status = 'pending') AS route`,
            [request.requestId, outcome, todayIn(deps.now()), conflicting, firstNameMatched, localGroup],
          );
          const reported = rows[0];
          if (reported === undefined && officerVerify !== null) {
            // Fix round 3: the answer to a fresh check an approved member asked for. A confirming outcome
            // replaces the earlier answers; any other is only noted, and the earlier answers stand. The
            // decision and the account are never touched.
            // Ruling 3: an email mismatch is held, with its answers, for an approver (MembershipService ApproveSignup).
            const replaces = confirming && outcome !== 'email_mismatch';
            const { rows: again } = await client.query(
              replaces
                ? `UPDATE signup_request SET verification = $2, verified_on = $3, conflicting_request_id = NULL, first_name_matched = $4, local_group = $5,
                     recheck_requested_at = NULL, recheck_outcome = NULL
                   WHERE id = $1 AND ${RECHECK} RETURNING id`
                : `UPDATE signup_request SET recheck_outcome = $2, recheck_first_name_matched = $3, recheck_local_group = $4, recheck_requested_at = NULL
                   WHERE id = $1 AND ${RECHECK} RETURNING id`,
              replaces ? [request.requestId, outcome, todayIn(deps.now()), firstNameMatched, localGroup] : [request.requestId, outcome, firstNameMatched, localGroup],
            );
            if (again.length > 0) {
              await recordAudit(client, caller, { action: 'recheck_report', subjectKind: 'signup_request', subjectId: request.requestId, fromState: 'asked', toState: outcome });
              return {};
            }
          }
          if (reported === undefined) {
            // SIGNOUT (C): a retry of the report that landed (the same outcome, earlier sign-up and, OFFICER-VERIFY,
            // the same answers) is a no-op, decided since or not; anything else is refused as before.
            const { rows: known } = await client.query<{ landed: boolean }>(
              `SELECT (verification = $2 AND conflicting_request_id IS NOT DISTINCT FROM $3::uuid
                 AND (NOT $6::boolean OR (first_name_matched IS NOT DISTINCT FROM $4::boolean AND local_group IS NOT DISTINCT FROM $5::text)))
                 OR ($6::boolean AND recheck_requested_at IS NULL AND recheck_outcome IS NOT DISTINCT FROM $2
                   AND recheck_first_name_matched IS NOT DISTINCT FROM $4::boolean AND recheck_local_group IS NOT DISTINCT FROM $5::text) AS landed
               FROM signup_request WHERE id = $1`,
              [request.requestId, outcome, conflicting, firstNameMatched, localGroup, officerVerify !== null],
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
          // OFFICER-VERIFY, switched on only: an invited sign-up that passed every check is approved by the report itself.
          const full =
            officerVerify !== null &&
            outcome === 'verified_local' &&
            firstNameMatched === true &&
            reported.route === 'invite' &&
            localStanding(localGroup, outcome, officerVerify.chapterGroup) === LocalGroupStanding.CHAPTER;
          if (full) await approveByReport(client, caller, reported);
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
