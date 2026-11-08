// ============================================================================
// MembershipService (R24, R33, MT-19): sign-ups, their approval, the member
// list and affiliate grants. Site callers only (auth/caller.ts).
//
//   SubmitSignup        a signed-in person: name and email from the token,
//                       last name and number as typed, both required for
//                       every sign-up, invited or not (W-SIGNUP D1), with
//                       no control character in the last name; the first
//                       name as typed, optional (PROFILE-ID). A token
//                       with the invited group (fc INVITE1) opens the
//                       account with the invite route; it still waits for
//                       the verifier or an approver (D2). A repeat, or an
//                       account already past pending, gets ONE answer
//                       whatever the reason, so the call tells nothing.
//   GetMyAccount        the caller's own account and, for an approved member,
//                       their profile: the names and the number (PROFILE-ID)
//   UpdateMyProfile     PROFILE-ID: an approved member changes their first and
//                       last name; never the number, which no request field
//                       carries (a request with any other field is refused)
//   ListSignupRequests  approvers and the Admin: the pending sign-ups with
//                       what they typed (PROFILE-ID: names and number) and the
//                       verifier's outcome and date. VET: a duplicate claim
//                       shows the earlier sign-up the verifier named, by
//                       display name, date and what it typed; one rejected or
//                       reopened since is shown as closed, by date alone
//                       (fix 1)
//   ApproveSignup /     approvers and the Admin, never on their own sign-up.
//   RejectSignup        What the sign-up typed is kept (0028). A rejection removes
//                       the account still waiting on it, in the same
//                       transaction, so GetMyAccount reports it and no second
//                       sign-up is taken (W-SIGNUP fix 1). An approval makes
//                       the account a member from the verifier's date for a
//                       local match, else from today on the approver's word
//                       (VET: an email mismatch or a duplicate claim is never
//                       a local match, so it is approved only that way, and
//                       only with confirmed_warning, which the audit records:
//                       fix 1);
//                       an other-group match is never approved as a member
//                       (R33): it is rejected or granted as an affiliate.
//   ListMembers         approvers and the Admin: accounts with member-level
//                       standing or past it, flagged for the yearly re-check
//                       once verified more than 12 months ago (the 13th month
//                       is grace; after it standing lapses by itself)
//   RemoveMember        approvers and the Admin; a sign-up still open for the
//                       account is rejected with it
//   ConfirmMember       approvers and the Admin, never on themselves: the
//                       yearly re-check, confirmed by an officer, dates a
//                       member's (or a lapsed account's) verification today
//   GrantAffiliate      the Admin or the Webmaster: member-level reading for
//                       an invited affiliate, from the verifier's other-group
//                       date when there is one, else from today on the
//                       grantor's attestation (the audit action says which)
//   ListRejectedSignups the Admin and the Membership Officer (REOPEN): the
//                       rejections whose closed account is still closed,
//                       newest first, never their own, with what they typed
//   ReopenSignup        the Admin and the Membership Officer, never on their
//                       own: the rejected row stays as it was, marked reopened
//                       by whom and when (0026), and the account the rejection
//                       closed is deleted, so the person can sign up again.
//                       Not rejected, already
//                       reopened, or an account no longer closed (granted
//                       meanwhile): FAILED_PRECONDITION, so a double reopen is
//                       refused, never repeated.
//
// A person has one open sign-up at most: the rows not reopened (0026). Every
// lookup by subject reads only those.
//
// No free-text note anywhere (R24), and a membership audit row carries no
// payload (0009): what happened is in its action and states. The number is
// never logged and never given back in an error.
// ============================================================================
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, type ConnectRouter, type HandlerContext } from '@connectrpc/connect';
import { recordAudit } from '../audit/audit.js';
import { type Caller, callerOf } from '../auth/caller.js';
import { requireGrantor, requireMembershipApprover, requireSignupReopener, requireUser } from '../auth/roles.js';
import { dbError } from '../db/errors.js';
import type { Db } from '../db/pool.js';
import { type TxClient, inTransaction } from '../db/tx.js';
import { protoDate, todayIn } from '../events/zone.js';
import {
  AccountRoute,
  EarlierClaimSchema,
  type MemberAccount,
  MemberAccountSchema,
  MemberProfileSchema,
  MemberSchema,
  MemberStatus,
  MembershipService,
  RejectedSignupSchema,
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
  email_mismatch: Verification.EMAIL_MISMATCH,
  duplicate_claim: Verification.DUPLICATE_CLAIM,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NUMBER = /^[0-9]{1,12}$/;
/**
 * VET fix 1: typing noise in a number, dropped before the digit rule: any space (a no-break space
 * too) and any dash or minus. Letters and every other character are still refused.
 */
const NUMBER_NOISE = /[\p{Zs}\p{Pd}\u2212]/gu;
/** VET fix 1: the outcomes an approver must confirm before approving, and what to do first. */
const CONFIRM_FIRST: Partial<Record<string, string>> = {
  email_mismatch: 'the membership verification service did not confirm the email: confirm with the member, then approve with confirmed_warning',
  duplicate_claim: 'another sign-up already claimed this number: resolve the earlier claim, then approve with confirmed_warning',
};
const EMAIL = /^[^@\s]+@[^@\s]+$/;
/** The most characters in a first or a last name (0005, 0028). */
const MAX_NAME = 80;
/** Any control character (a NUL, a line break, an escape code), as the site's sign-up form checks (web src/lib/signup.ts). */
const CONTROL = /\p{Cc}/u;
const MAX_DISPLAY_NAME = 120;
/** The one answer to a sign-up that cannot be taken, whatever the reason (MT-19). */
const ON_FILE = 'a sign-up is already on file for this account';
const RECHECK_MONTHS = 12;
/**
 * REOPEN: the most rejections listed for reopening, newest first, with no paging (NOTE-4). Plenty for
 * this group's size; the site says "Showing the latest 50" when the list is full (apps/web
 * src/lib/signup.ts REJECTED_LISTED_MAX, kept equal), so an older one is never hidden without a word.
 * Raise both, or add paging, if the group ever needs more.
 */
const MAX_REJECTED_LISTED = 50;
/**
 * REOPEN: an account the rejection closed and nothing reopened since: removed, never approved,
 * granted or checked (0026's delete rule). For member_account aliased `a`.
 */
const CLOSED_BY_REJECTION = `a.status = 'removed' AND a.verified_on IS NULL AND a.approved_by_sub IS NULL AND a.affiliate_granted_by_sub IS NULL`;
/** W-SIGNUP D2: an officer invited this person (fc INVITE1's <prefix>invited, renamed by groups.ts). */
const INVITED_GROUP = 'nwfl-invited';

interface AccountRow {
  status: string;
  route: string;
  verified_on: string | null;
}

/** PROFILE-ID: what a sign-up typed, as the approvers and the owner read it. */
interface TypedRow {
  first_name: string | null;
  last_name: string | null;
  membership_number: string | null;
}

/** As the wire carries it: empty for a value not held (a first name from before 0028). */
const typedFields = (row: TypedRow): { firstName: string; lastName: string; membershipNumber: string } => ({
  firstName: row.first_name ?? '',
  lastName: row.last_name ?? '',
  membershipNumber: row.membership_number ?? '',
});

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

/** A first or last name as typed: trimmed, needed, at most 80 characters, no control character. Never echoed. */
function nameOf(value: string, which: 'first name' | 'last name'): string {
  const name = value.trim();
  if (name === '') throw invalid(`a ${which} is needed`);
  if ([...name].length > MAX_NAME) throw invalid(`a ${which} is at most ${MAX_NAME} characters`);
  // As the site refuses it: no name holds a control character, and a NUL would never reach the database.
  if (CONTROL.test(name)) throw invalid(`a ${which} has a hidden character`);
  return name;
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

  /** Decides a sign-up. What it typed is kept (0028). */
  const decide = (client: TxClient, id: string, decision: 'approved' | 'rejected', by: string): Promise<unknown> =>
    client.query(`UPDATE signup_request SET decision = $2, decided_at = now(), decided_by_sub = $3 WHERE id = $1`, [id, decision, by]);

  return (router) => {
    router.service(MembershipService, {
      submitSignup: async (request, ctx) => {
        const caller = callerIn(ctx);
        requireUser(caller);
        const sub = caller.subject as string;
        // First, so an account already on file gets the one answer whatever else is wrong.
        const onFile = async (client: Pick<Db, 'query'>): Promise<void> => {
          const { rows } = await client.query(
            `SELECT 1 FROM signup_request WHERE sub = $1 AND reopened_at IS NULL UNION ALL SELECT 1 FROM member_account WHERE sub = $1 AND status <> 'pending'`,
            [sub],
          );
          if (rows.length > 0) throw new ConnectError(ON_FILE, Code.AlreadyExists);
        };
        await onFile(db);
        const name = [...(caller.name ?? '').trim()].slice(0, MAX_DISPLAY_NAME).join('');
        const email = (caller.email ?? '').trim();
        if (name === '' || email === '') throw precondition('add your name and email to your account first');
        if (email.length > 254 || !EMAIL.test(email)) throw precondition('the email on your account is not an address');
        // W-SIGNUP D1: the number and the last name, for every sign-up. Neither is ever echoed.
        const typed = request.membershipNumber.trim();
        if (typed === '') throw invalid('a membership number is needed');
        const number = typed.replace(NUMBER_NOISE, '');
        if (!NUMBER.test(number)) throw invalid('a membership number is 1 to 12 digits');
        const lastName = nameOf(request.lastName, 'last name');
        // PROFILE-ID: optional, so a sign-up from a site that does not ask for it yet is still taken.
        const firstName = request.firstName.trim() === '' ? null : nameOf(request.firstName, 'first name');
        // D2: an officer's invitation (the <prefix>invited group, by its internal name) is the account's route.
        const route = caller.groups.includes(INVITED_GROUP) ? 'invite' : 'signup';
        return tx(async (client) => {
          // A sign-up racing this one waits here for it, then gets the same one answer.
          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO signup_request (sub, display_name, email, first_name, last_name, membership_number) VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (sub) WHERE reopened_at IS NULL DO NOTHING RETURNING id`,
            [sub, name, email, firstName, lastName, number],
          );
          const id = rows[0]?.id;
          if (id === undefined) throw new ConnectError(ON_FILE, Code.AlreadyExists);
          await client.query(`INSERT INTO member_account (sub, status, route) VALUES ($1, 'pending', $2) ON CONFLICT (sub) DO NOTHING`, [sub, route]);
          await recordAudit(client, caller, { action: 'signup', subjectKind: 'signup_request', subjectId: id });
          return { requestId: id };
        });
      },

      getMyAccount: async (_request, ctx) => {
        const caller = callerIn(ctx);
        requireUser(caller);
        // PROFILE-ID: an approved member's profile is their approved sign-up, read by them alone.
        const { rows } = await db.query<AccountRow & TypedRow & { profile: boolean }>(
          `SELECT a.status, a.route, a.verified_on::text AS verified_on, s.id IS NOT NULL AS profile, s.first_name, s.last_name, s.membership_number
           FROM member_account a LEFT JOIN signup_request s
             ON s.sub = a.sub AND s.reopened_at IS NULL AND s.decision = 'approved' AND a.status IN ('member', 'affiliate', 'lapsed')
           WHERE a.sub = $1`,
          [caller.subject],
        );
        const row = rows[0];
        if (row === undefined) return {};
        return { account: accountMessage(row), ...(row.profile ? { profile: create(MemberProfileSchema, typedFields(row)) } : {}) };
      },

      updateMyProfile: async (request, ctx) => {
        const caller = callerIn(ctx);
        requireUser(caller);
        // The number has no field here: a request that carries one, under any field number, changes nothing.
        if ((request.$unknown?.length ?? 0) > 0) throw invalid('only the first and last name can be changed');
        const firstName = nameOf(request.firstName, 'first name');
        const lastName = nameOf(request.lastName, 'last name');
        return tx(async (client) => {
          const { rows } = await client.query<{ id: string }>(
            `UPDATE signup_request s SET first_name = $2, last_name = $3
             FROM member_account a
             WHERE s.sub = $1 AND s.reopened_at IS NULL AND s.decision = 'approved' AND a.sub = s.sub AND a.status IN ('member', 'affiliate', 'lapsed')
             RETURNING s.id`,
            [caller.subject, firstName, lastName],
          );
          const id = rows[0]?.id;
          if (id === undefined) throw precondition('only an approved member has a profile to change');
          await recordAudit(client, caller, { action: 'profile_update', subjectKind: 'signup_request', subjectId: id });
          return {};
        });
      },

      listSignupRequests: async (_request, ctx) => {
        requireMembershipApprover(callerIn(ctx));
        const { rows } = await db.query<
          TypedRow & {
            id: string;
            display_name: string;
            email: string;
            verification: string;
            verified_on: string | null;
            created_at: Date;
            route: string;
            earlier_name: string | null;
            earlier_at: Date | null;
            earlier_closed: boolean | null;
            earlier_first: string | null;
            earlier_last: string | null;
            earlier_number: string | null;
          }
        >(
          // Fix 1 (N2): a rejected (or reopened) earlier sign-up's name stays with the Admin and the
          // Membership Officer (ListRejectedSignups): it is never read here, nor (PROFILE-ID) what it typed.
          `SELECT s.id, s.display_name, s.email, s.verification, s.verified_on::text AS verified_on, s.created_at, coalesce(a.route, 'signup') AS route,
             s.first_name, s.last_name, s.membership_number,
             CASE WHEN c.decision = 'rejected' THEN '' ELSE c.display_name END AS earlier_name, c.created_at AS earlier_at, c.decision = 'rejected' AS earlier_closed,
             CASE WHEN c.decision = 'rejected' THEN NULL ELSE c.first_name END AS earlier_first,
             CASE WHEN c.decision = 'rejected' THEN NULL ELSE c.last_name END AS earlier_last,
             CASE WHEN c.decision = 'rejected' THEN NULL ELSE c.membership_number END AS earlier_number
           FROM signup_request s LEFT JOIN member_account a ON a.sub = s.sub LEFT JOIN signup_request c ON c.id = s.conflicting_request_id
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
              ...typedFields(row),
              ...(row.earlier_name !== null
                ? {
                    earlierClaim: create(EarlierClaimSchema, {
                      displayName: row.earlier_name,
                      signedUpAt: timestampFromDate(row.earlier_at as Date),
                      closed: row.earlier_closed === true,
                      ...typedFields({ first_name: row.earlier_first, last_name: row.earlier_last, membership_number: row.earlier_number }),
                    }),
                  }
                : {}),
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
          const confirmFirst = CONFIRM_FIRST[row.verification];
          if (confirmFirst !== undefined && !request.confirmedWarning) throw precondition(confirmFirst);
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
          // Fix 1: approved despite the warning, on the approver's confirmation (no note or payload on a
          // membership record, 0004/0009: the action says it).
          if (confirmFirst !== undefined) await recordAudit(client, caller, { action: `approve_confirmed_${row.verification}`, subjectKind: 'signup_request', subjectId: id });
          return { account: accountMessage(account) };
        });
      },

      rejectSignup: async (request, ctx) => {
        const caller = callerIn(ctx);
        requireMembershipApprover(caller);
        const id = requestId(request.requestId);
        return tx(async (client) => {
          const row = await decidable(client, caller, id);
          await decide(client, id, 'rejected', caller.subject as string);
          await recordAudit(client, caller, { action: 'reject', subjectKind: 'signup_request', subjectId: id, fromState: 'pending', toState: 'rejected' });
          // W-SIGNUP fix 1: the account waiting on it is removed with it, so GetMyAccount tells the person; an
          // account no longer waiting (approved or granted meanwhile) is left as it is.
          const { rowCount } = await client.query(
            `UPDATE member_account SET status = 'removed', removed_at = now(), updated_at = now() WHERE sub = $1 AND status = 'pending'`,
            [row.sub],
          );
          if (rowCount === 1) await recordAudit(client, caller, { action: 'reject', subjectKind: 'member_account', subjectId: row.sub, fromState: 'pending', toState: 'removed' });
          return {};
        });
      },

      listMembers: async (request, ctx) => {
        requireMembershipApprover(callerIn(ctx));
        const { rows } = await db.query<AccountRow & { sub: string; display_name: string | null; email: string | null; recheck_due: boolean }>(
          `SELECT a.sub, s.display_name, s.email, a.status, a.route, a.verified_on::text AS verified_on,
             coalesce(a.verified_on < $1::date - make_interval(months => $2), true) AS recheck_due
           FROM member_account a LEFT JOIN signup_request s ON s.sub = a.sub AND s.reopened_at IS NULL
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
          // A sign-up still open for the account is rejected with it, so it leaves both queues.
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
              `SELECT id, sub, decision, verification, verified_on::text AS verified_on FROM signup_request WHERE sub = $1 AND reopened_at IS NULL FOR UPDATE`,
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

      listRejectedSignups: async (_request, ctx) => {
        const caller = callerIn(ctx);
        requireSignupReopener(caller);
        const { rows } = await db.query<TypedRow & { id: string; display_name: string; email: string; verification: string; verified_on: string | null; decided_at: Date }>(
          `SELECT s.id, s.display_name, s.email, s.verification, s.verified_on::text AS verified_on, s.decided_at, s.first_name, s.last_name, s.membership_number
           FROM signup_request s LEFT JOIN member_account a ON a.sub = s.sub
           WHERE s.decision = 'rejected' AND s.reopened_at IS NULL AND s.sub <> $1 AND (a.sub IS NULL OR (${CLOSED_BY_REJECTION}))
           ORDER BY s.decided_at DESC, s.id DESC LIMIT $2`,
          [caller.subject, MAX_REJECTED_LISTED],
        );
        return {
          requests: rows.map((row) =>
            create(RejectedSignupSchema, {
              requestId: row.id,
              displayName: row.display_name,
              email: row.email,
              verification: VERIFICATIONS[row.verification],
              ...(row.verified_on !== null ? { verifiedOn: protoDate(row.verified_on) } : {}),
              rejectedAt: timestampFromDate(row.decided_at),
              ...typedFields(row),
            }),
          ),
        };
      },

      reopenSignup: async (request, ctx) => {
        const caller = callerIn(ctx);
        requireSignupReopener(caller);
        const id = requestId(request.requestId);
        return tx(async (client) => {
          const row = (
            await client.query<{ sub: string; decision: string; reopened: boolean }>(
              `SELECT sub, decision, reopened_at IS NOT NULL AS reopened FROM signup_request WHERE id = $1 FOR UPDATE`,
              [id],
            )
          ).rows[0];
          if (row === undefined) throw new ConnectError('sign-up not found', Code.NotFound);
          if (row.sub === caller.subject) throw new ConnectError('no one reopens their own sign-up', Code.PermissionDenied);
          if (row.decision !== 'rejected' || row.reopened) throw precondition('only a rejected sign-up is reopened, and only once');
          const account = (
            await client.query<{ closed: boolean }>(`SELECT (${CLOSED_BY_REJECTION}) AS closed FROM member_account a WHERE a.sub = $1 FOR UPDATE`, [row.sub])
          ).rows[0];
          if (account !== undefined && !account.closed) throw precondition('this account is no longer closed by the rejection');
          await client.query(`UPDATE signup_request SET reopened_at = now(), reopened_by_sub = $2 WHERE id = $1`, [id, caller.subject]);
          await recordAudit(client, caller, { action: 'reopen', subjectKind: 'signup_request', subjectId: id, fromState: 'rejected', toState: 'reopened' });
          if (account !== undefined) {
            // The person reads as one who never signed up (GetMyAccount: no account), so the site offers the form again.
            await client.query(`DELETE FROM member_account WHERE sub = $1`, [row.sub]);
            await recordAudit(client, caller, { action: 'reopen', subjectKind: 'member_account', subjectId: row.sub, fromState: 'removed' });
          }
          return {};
        });
      },
    });
  };
}
