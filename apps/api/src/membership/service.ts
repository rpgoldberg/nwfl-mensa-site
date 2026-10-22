// ============================================================================
// MembershipService (R24, R33, MT-19): sign-ups, their approval, the member
// list and affiliate grants. Site callers only (auth/caller.ts).
//
//   SubmitSignup        a signed-in person: name and email from the token,
//                       last name and number as typed. A repeat, or an
//                       account already past pending, gets ONE answer
//                       whatever the reason, so the call tells nothing.
//   GetMyAccount        the caller's own account
//   ListSignupRequests  approvers and the Admin: the pending sign-ups with the
//                       verifier's outcome and date, NEVER the number or the
//                       last name
//   ApproveSignup /     approvers and the Admin, never on their own sign-up.
//   RejectSignup        The decision erases the number and the last name in
//                       the same statement (0007, 0009). An approval makes
//                       the account a member from the verifier's date for a
//                       local match, else from today on the approver's word;
//                       an other-group match is never approved as a member
//                       (R33): it is rejected or granted as an affiliate.
//   ListMembers         approvers and the Admin: accounts with member-level
//                       standing or past it, flagged for the yearly re-check
//                       once verified more than 12 months ago (the 13th month
//                       is grace; after it standing lapses by itself)
//   RemoveMember        approvers and the Admin; a sign-up still open for the
//                       account is rejected with it, erasing its inputs
//   ConfirmMember       approvers and the Admin, never on themselves: the
//                       yearly re-check against the offline roster dates a
//                       member's (or a lapsed account's) verification today
//   GrantAffiliate      the Admin or the Webmaster: member-level reading for
//                       an invited affiliate, from the verifier's other-group
//                       date when there is one, else from today on the
//                       grantor's attestation (the audit action says which)
//
// No free-text note anywhere (R24), and a membership audit row carries no
// payload (0009): what happened is in its action and states.
// ============================================================================
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, type ConnectRouter, type HandlerContext } from '@connectrpc/connect';
import { recordAudit } from '../audit/audit.js';
import { type Caller, callerOf } from '../auth/caller.js';
import { requireGrantor, requireMembershipApprover, requireUser } from '../auth/roles.js';
import { dbError } from '../db/errors.js';
import type { Db } from '../db/pool.js';
import { type TxClient, inTransaction } from '../db/tx.js';
import { protoDate, todayIn } from '../events/zone.js';
import {
  AccountRoute,
  type MemberAccount,
  MemberAccountSchema,
  MemberSchema,
  MemberStatus,
  MembershipService,
  SignupRequestSchema,
  Verification,
} from '../gen/nwfl/mensa/v1/membership_pb.js';

export interface MembershipDeps {
  db: Db;
  now: () => Date;
}

const STATUSES: Record<string, MemberStatus> = {
  pending: MemberStatus.PENDING,
  member: MemberStatus.MEMBER,
  affiliate: MemberStatus.AFFILIATE,
  lapsed: MemberStatus.LAPSED,
  removed: MemberStatus.REMOVED,
};
const ROUTES: Record<string, AccountRoute> = { invite: AccountRoute.INVITE, signup: AccountRoute.SIGNUP, admin_grant: AccountRoute.ADMIN_GRANT };
const VERIFICATIONS: Record<string, Verification> = {
  unchecked: Verification.UNCHECKED,
  verified_local: Verification.VERIFIED_LOCAL,
  verified_other_group: Verification.VERIFIED_OTHER_GROUP,
  not_found: Verification.NOT_FOUND,
  error: Verification.ERROR,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NUMBER = /^[0-9]{1,12}$/;
const EMAIL = /^[^@\s]+@[^@\s]+$/;
const MAX_LAST_NAME = 80;
const MAX_DISPLAY_NAME = 120;
/** The one answer to a sign-up that cannot be taken, whatever the reason (MT-19). */
const ON_FILE = 'a sign-up is already on file for this account';
const RECHECK_MONTHS = 12;

interface AccountRow {
  status: string;
  route: string;
  verified_on: string | null;
}

interface SignupRow {
  id: string;
  sub: string;
  decision: string;
  verification: string;
  verified_on: string | null;
}

const invalid = (message: string): ConnectError => new ConnectError(message, Code.InvalidArgument);
const precondition = (message: string): ConnectError => new ConnectError(message, Code.FailedPrecondition);

function accountMessage(row: AccountRow): MemberAccount {
  return create(MemberAccountSchema, {
    status: STATUSES[row.status],
    route: ROUTES[row.route],
    ...(row.verified_on !== null ? { verifiedOn: protoDate(row.verified_on) } : {}),
  });
}

function requestId(id: string): string {
  if (!UUID.test(id)) throw invalid('request_id is not an id');
  return id;
}

function subjectOf(subject: string): string {
  if (subject.length < 1 || subject.length > 255) throw invalid('subject must be 1 to 255 characters');
  return subject;
}

export function membershipRoutes(deps: MembershipDeps): (router: ConnectRouter) => void {
  const { db } = deps;
  const callerIn = (ctx: HandlerContext): Caller => callerOf(ctx.values);
  const today = (): string => todayIn(deps.now());

  const tx = async <T>(fn: (client: TxClient) => Promise<T>): Promise<T> => {
    try {
      return await inTransaction(db, fn);
    } catch (error) {
      throw dbError(error);
    }
  };

  /** The pending sign-up an approver may decide, locked. */
  const decidable = async (client: TxClient, caller: Caller, id: string): Promise<SignupRow> => {
    const row = (
      await client.query<SignupRow>(
        `SELECT id, sub, decision, verification, verified_on::text AS verified_on FROM signup_request WHERE id = $1 FOR UPDATE`,
        [id],
      )
    ).rows[0];
    if (row === undefined) throw new ConnectError('sign-up not found', Code.NotFound);
    if (row.sub === caller.subject) throw new ConnectError('no one decides their own sign-up', Code.PermissionDenied);
    if (row.decision !== 'pending') throw precondition('this sign-up is already decided');
    return row;
  };

  /** Decides a sign-up, erasing the number and the last name in the same statement. */
  const decide = (client: TxClient, id: string, decision: 'approved' | 'rejected', by: string): Promise<unknown> =>
    client.query(
      `UPDATE signup_request SET decision = $2, decided_at = now(), decided_by_sub = $3, membership_number = NULL, last_name = NULL WHERE id = $1`,
      [id, decision, by],
    );

  return (router) => {
    router.service(MembershipService, {
      submitSignup: async (request, ctx) => {
        const caller = callerIn(ctx);
        requireUser(caller);
        const sub = caller.subject as string;
        // First, so an account already on file gets the one answer whatever else is wrong.
        const onFile = async (client: Pick<Db, 'query'>): Promise<void> => {
          const { rows } = await client.query(
            `SELECT 1 FROM signup_request WHERE sub = $1 UNION ALL SELECT 1 FROM member_account WHERE sub = $1 AND status <> 'pending'`,
            [sub],
          );
          if (rows.length > 0) throw new ConnectError(ON_FILE, Code.AlreadyExists);
        };
        await onFile(db);
        const name = [...(caller.name ?? '').trim()].slice(0, MAX_DISPLAY_NAME).join('');
        const email = (caller.email ?? '').trim();
        if (name === '' || email === '') throw precondition('add your name and email to your account first');
        if (email.length > 254 || !EMAIL.test(email)) throw precondition('the email on your account is not an address');
        const number = request.membershipNumber.trim();
        let lastName: string | null = null;
        if (number !== '') {
          if (!NUMBER.test(number)) throw invalid('a membership number is 1 to 12 digits');
          lastName = request.lastName.trim();
          if (lastName === '') throw invalid('a last name is needed with a membership number');
          if ([...lastName].length > MAX_LAST_NAME) throw invalid(`a last name is at most ${MAX_LAST_NAME} characters`);
        }
        return tx(async (client) => {
          // A sign-up racing this one waits here for it, then gets the same one answer.
          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO signup_request (sub, display_name, email, last_name, membership_number) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (sub) DO NOTHING RETURNING id`,
            [sub, name, email, lastName, number === '' ? null : number],
          );
          const id = rows[0]?.id;
          if (id === undefined) throw new ConnectError(ON_FILE, Code.AlreadyExists);
          await client.query(`INSERT INTO member_account (sub, status, route) VALUES ($1, 'pending', 'signup') ON CONFLICT (sub) DO NOTHING`, [sub]);
          await recordAudit(client, caller, { action: 'signup', subjectKind: 'signup_request', subjectId: id });
          return { requestId: id };
        });
      },

      getMyAccount: async (_request, ctx) => {
        const caller = callerIn(ctx);
        requireUser(caller);
        const { rows } = await db.query<AccountRow>(`SELECT status, route, verified_on::text AS verified_on FROM member_account WHERE sub = $1`, [caller.subject]);
        const row = rows[0];
        return row === undefined ? {} : { account: accountMessage(row) };
      },

      listSignupRequests: async (_request, ctx) => {
        requireMembershipApprover(callerIn(ctx));
        const { rows } = await db.query<{
          id: string;
          display_name: string;
          email: string;
          verification: string;
          verified_on: string | null;
          created_at: Date;
          route: string;
        }>(
          `SELECT s.id, s.display_name, s.email, s.verification, s.verified_on::text AS verified_on, s.created_at, coalesce(a.route, 'signup') AS route
           FROM signup_request s LEFT JOIN member_account a ON a.sub = s.sub
           WHERE s.decision = 'pending' ORDER BY s.created_at, s.id`,
        );
        return {
          requests: rows.map((row) =>
            create(SignupRequestSchema, {
              requestId: row.id,
              displayName: row.display_name,
              email: row.email,
              verification: VERIFICATIONS[row.verification],
              ...(row.verified_on !== null ? { verifiedOn: protoDate(row.verified_on) } : {}),
              createdAt: timestampFromDate(row.created_at),
              route: ROUTES[row.route],
            }),
          ),
        };
      },

      approveSignup: async (request, ctx) => {
        const caller = callerIn(ctx);
        requireMembershipApprover(caller);
        const id = requestId(request.requestId);
        return tx(async (client) => {
          const row = await decidable(client, caller, id);
          if (row.verification === 'verified_other_group') throw precondition('an other-group member is rejected or granted affiliate standing, not approved');
          await decide(client, id, 'approved', caller.subject as string);
          const local = row.verification === 'verified_local' && row.verified_on !== null;
          const { rows } = await client.query<AccountRow>(
            `INSERT INTO member_account (sub, status, route, approved_by_sub, approved_at, verified_on) VALUES ($1, 'member', 'signup', $2, now(), $3)
             ON CONFLICT (sub) DO UPDATE SET status = 'member', approved_by_sub = EXCLUDED.approved_by_sub, approved_at = now(),
               verified_on = EXCLUDED.verified_on, updated_at = now()
             WHERE member_account.status IN ('pending', 'lapsed')
             RETURNING status, route, verified_on::text AS verified_on`,
            [row.sub, caller.subject, local ? row.verified_on : today()],
          );
          const account = rows[0];
          if (account === undefined) throw precondition('this account is not waiting for approval');
          await recordAudit(client, caller, { action: 'approve', subjectKind: 'signup_request', subjectId: id, fromState: 'pending', toState: 'approved' });
          await recordAudit(client, caller, {
            action: local ? 'approve_verified' : 'approve_attested',
            subjectKind: 'member_account',
            subjectId: row.sub,
            toState: 'member',
          });
          return { account: accountMessage(account) };
        });
      },

      rejectSignup: async (request, ctx) => {
        const caller = callerIn(ctx);
        requireMembershipApprover(caller);
        const id = requestId(request.requestId);
        return tx(async (client) => {
          await decidable(client, caller, id);
          await decide(client, id, 'rejected', caller.subject as string);
          await recordAudit(client, caller, { action: 'reject', subjectKind: 'signup_request', subjectId: id, fromState: 'pending', toState: 'rejected' });
          return {};
        });
      },

      listMembers: async (request, ctx) => {
        requireMembershipApprover(callerIn(ctx));
        const { rows } = await db.query<AccountRow & { sub: string; display_name: string | null; email: string | null; recheck_due: boolean }>(
          `SELECT a.sub, s.display_name, s.email, a.status, a.route, a.verified_on::text AS verified_on,
             coalesce(a.verified_on < $1::date - make_interval(months => $2), true) AS recheck_due
           FROM member_account a LEFT JOIN signup_request s ON s.sub = a.sub
           WHERE a.status IN ('member', 'affiliate', 'lapsed')
             AND (NOT $3 OR coalesce(a.verified_on < $1::date - make_interval(months => $2), true))
           ORDER BY coalesce(s.display_name, ''), a.sub`,
          [today(), RECHECK_MONTHS, request.recheckDueOnly],
        );
        return {
          members: rows.map((row) =>
            create(MemberSchema, {
              subject: row.sub,
              displayName: row.display_name ?? '',
              email: row.email ?? '',
              status: STATUSES[row.status],
              route: ROUTES[row.route],
              ...(row.verified_on !== null ? { verifiedOn: protoDate(row.verified_on) } : {}),
              recheckDue: row.recheck_due,
            }),
          ),
        };
      },

      removeMember: async (request, ctx) => {
        const caller = callerIn(ctx);
        requireMembershipApprover(caller);
        const sub = subjectOf(request.subject);
        return tx(async (client) => {
          const row = (await client.query<{ status: string }>(`SELECT status FROM member_account WHERE sub = $1 FOR UPDATE`, [sub])).rows[0];
          if (row === undefined) throw new ConnectError('account not found', Code.NotFound);
          if (row.status === 'removed') throw precondition('this account is already removed');
          await client.query(`UPDATE member_account SET status = 'removed', removed_at = now(), updated_at = now() WHERE sub = $1`, [sub]);
          await recordAudit(client, caller, { action: 'remove', subjectKind: 'member_account', subjectId: sub, fromState: row.status, toState: 'removed' });
          // A sign-up still open for the account is rejected with it, so its number leaves both queues.
          const open = (await client.query<{ id: string }>(`SELECT id FROM signup_request WHERE sub = $1 AND decision = 'pending' FOR UPDATE`, [sub])).rows[0];
          if (open !== undefined) {
            await decide(client, open.id, 'rejected', caller.subject as string);
            await recordAudit(client, caller, { action: 'reject', subjectKind: 'signup_request', subjectId: open.id, fromState: 'pending', toState: 'rejected' });
          }
          return {};
        });
      },

      confirmMember: async (request, ctx) => {
        const caller = callerIn(ctx);
        requireMembershipApprover(caller);
        const sub = subjectOf(request.subject);
        if (sub === caller.subject) throw new ConnectError('no one confirms themselves', Code.PermissionDenied);
        return tx(async (client) => {
          const row = (await client.query<{ status: string }>(`SELECT status FROM member_account WHERE sub = $1 FOR UPDATE`, [sub])).rows[0];
          if (row === undefined) throw new ConnectError('account not found', Code.NotFound);
          if (row.status !== 'member' && row.status !== 'lapsed') throw precondition('only a member or a lapsed account is confirmed');
          const { rows } = await client.query<AccountRow>(
            `UPDATE member_account SET status = 'member', verified_on = $2, approved_by_sub = coalesce(approved_by_sub, $3),
               approved_at = coalesce(approved_at, now()), updated_at = now()
             WHERE sub = $1 RETURNING status, route, verified_on::text AS verified_on`,
            [sub, today(), caller.subject],
          );
          await recordAudit(client, caller, { action: 'confirm_attested', subjectKind: 'member_account', subjectId: sub, fromState: row.status, toState: 'member' });
          return { account: accountMessage(rows[0] as AccountRow) };
        });
      },

      grantAffiliate: async (request, ctx) => {
        const caller = callerIn(ctx);
        requireGrantor(caller);
        const sub = subjectOf(request.subject);
        if (sub === caller.subject) throw new ConnectError('no one grants themselves', Code.PermissionDenied);
        return tx(async (client) => {
          const current = (await client.query<{ status: string }>(`SELECT status FROM member_account WHERE sub = $1 FOR UPDATE`, [sub])).rows[0];
          if (current !== undefined && !['pending', 'lapsed'].includes(current.status)) throw precondition('this account cannot be granted affiliate standing');
          const signup = (
            await client.query<SignupRow>(
              `SELECT id, sub, decision, verification, verified_on::text AS verified_on FROM signup_request WHERE sub = $1 FOR UPDATE`,
              [sub],
            )
          ).rows[0];
          const verified = signup?.verification === 'verified_other_group' && signup.verified_on !== null;
          if (signup !== undefined && signup.decision === 'pending') {
            // The request for access is answered by this grant.
            await decide(client, signup.id, 'approved', caller.subject as string);
            await recordAudit(client, caller, { action: 'approve', subjectKind: 'signup_request', subjectId: signup.id, fromState: 'pending', toState: 'affiliate' });
          }
          const { rows } = await client.query<AccountRow>(
            `INSERT INTO member_account (sub, status, route, affiliate_granted_by_sub, affiliate_granted_at, verified_on) VALUES ($1, 'affiliate', 'admin_grant', $2, now(), $3)
             ON CONFLICT (sub) DO UPDATE SET status = 'affiliate', affiliate_granted_by_sub = EXCLUDED.affiliate_granted_by_sub, affiliate_granted_at = now(),
               verified_on = EXCLUDED.verified_on, updated_at = now()
             RETURNING status, route, verified_on::text AS verified_on`,
            [sub, caller.subject, verified ? signup.verified_on : today()],
          );
          await recordAudit(client, caller, {
            action: verified ? 'grant_affiliate_verified' : 'grant_affiliate_attested',
            subjectKind: 'member_account',
            subjectId: sub,
            fromState: current?.status ?? null,
            toState: 'affiliate',
          });
          return { account: accountMessage(rows[0] as AccountRow) };
        });
      },
    });
  };
}
