// W-SIGNUP: the site's client for MembershipService, for the first-sign-in page (/account) and the
// approvers' queue (/officer-area/sign-ups). The same wire as client.ts and officer.ts (gRPC over
// HTTP/2, never Connect or gRPC-Web; the API's address and timeout from API_URL and API_TIMEOUT_MS),
// and every call carries the signed-in person's own access token as "Authorization: Bearer". The API
// takes the name and email from that token and decides who may do what (the approvers and the Admin
// alone list and decide sign-ups, never their own); the site only hides what is not theirs.
//
// A refused token (UNAUTHENTICATED), or a bearer that is not one b64token, is MembershipSignInAgain.
// A sign-up the API refuses is SignupRefused by kind (a value it would not take, one already on file,
// or an account with no name or email); a decision it refuses is DecisionRefused (their own sign-up,
// or one already decided or gone). REOPEN: the Admin and the Membership Officer alone list the
// rejections and reopen one; a reopening the API refuses is DecisionRefused too (not theirs to
// reopen, or no longer reopenable). PROFILE-ID: the approvers' queue and rejections carry what each
// sign-up typed (names and number), and an approved member's own account carries their profile; the
// member changes the two names (a change the API refuses is ProfileRefused), never the number.
// Anything else is ApiUnavailable. Each failure is logged by call and code only: never the API's
// message, the token, a name or the membership number (D6).
//
// OFFICER-VERIFY: GetMyAccount also says whether the person's officer tools are open, wait for their
// membership check, or are not theirs (getMyStanding, for /account and the officer area's gate), and an
// account and a pending sign-up carry the reported local group: a chapter member, a guest, or a guest
// in a group the site does not know. getSignupDecision reads one sign-up's decision for the approvers'
// banner; on any failure at all it answers nothing, so no banner is shown.
import { PUBLIC_ONLY } from 'astro:env/server';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, createClient } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import { apiLog } from '../../../server/log.mjs';
import { traceInterceptor } from '../../../server/trace.mjs';
import type { Session } from '../../../server/session.mjs';
import type { TokenStore } from '../../../server/token-store.mjs';
import type { Date as ProtoDate } from '../../gen/nwfl/mensa/v1/common_pb.js';
import {
  AccountRoute,
  type EarlierClaim as EarlierClaimMessage,
  LocalGroupStanding,
  MemberStatus,
  MembershipService,
  OfficerTools,
  type RejectedSignup as RejectedSignupMessage,
  SignupDecision,
  type SignupRequest,
  Verification,
} from '../../gen/nwfl/mensa/v1/membership_pb.js';
import { EXPIRY_MARGIN_SECONDS } from '../auth/bearer';
import type { Tokens } from '../auth/oidc';
import { type ApiConfig, ApiUnavailable, READ_MAX_BYTES, type Reader, apiSetup, sendable } from './client';

export type Standing = 'pending' | 'member' | 'affiliate' | 'lapsed' | 'removed';
export type Route = 'invite' | 'signup' | 'admin_grant';
export type Check = 'unchecked' | 'verified_local' | 'verified_other_group' | 'not_found' | 'error' | 'email_mismatch' | 'duplicate_claim';
/** OFFICER-VERIFY: what the reported local group makes the person; none reported is left out. */
export type LocalGroup = 'chapter' | 'guest' | 'guest_unlisted';
/** OFFICER-VERIFY: the person's officer tools. */
export type OfficerToolsState = 'open' | 'awaiting_check' | 'none';
/** GetSignupRequest: where one sign-up stands. */
export type Decision = 'pending' | 'approved' | 'rejected' | 'reopened';

/** PROFILE-ID: what a sign-up typed, as the API sends it to the approvers; a value not held is left out. */
export interface Typed {
  firstName?: string;
  lastName?: string;
  membershipNumber?: string;
}

/** VET: the earlier sign-up a duplicate claim names, as the site already holds it, with what it typed (PROFILE-ID). */
export interface EarlierClaim extends Typed {
  /** Empty when closed. */
  displayName: string;
  signedUpAt?: Date;
  /** Fix 1 (N2): rejected or reopened since; the API then sends no name. */
  closed?: true;
}

/** PROFILE-ID: an approved member's own names and number. */
export interface Profile {
  firstName: string;
  lastName: string;
  membershipNumber: string;
  /** OFFICER-VERIFY: the local group the membership check reported, when it did. */
  localGroup?: string;
}

/** The person's own account; verifiedOn is the day it was last checked, YYYY-MM-DD. */
export interface MyAccount {
  status: Standing;
  route: Route;
  verifiedOn?: string;
  /** OFFICER-VERIFY: a chapter member or a guest, when a local group was reported. */
  localGroup?: LocalGroup;
  /** PROFILE-ID: for an approved member. */
  profile?: Profile;
}

/** OFFICER-VERIFY: the person's account, if any, and their officer tools. */
export interface MyStanding {
  account?: MyAccount;
  officerTools: OfficerToolsState;
}

/** A pending sign-up as an approver sees it, with what it typed (PROFILE-ID). */
export interface PendingSignup extends Typed {
  requestId: string;
  displayName: string;
  email: string;
  route: Route;
  verification: Check;
  verifiedOn?: string;
  createdAt?: Date;
  /** VET: for a duplicate claim, the earlier sign-up the verifier named, if any. */
  earlierClaim?: EarlierClaim;
  /** OFFICER-VERIFY: whether the check confirmed the typed first name, when it said. */
  firstNameMatched?: boolean;
  /** OFFICER-VERIFY: the reported local group and what it makes the person, when one was reported. */
  localGroup?: string;
  localGroupStanding?: LocalGroup;
}

/** REOPEN: a rejected sign-up that can be reopened, as the Admin or the Membership Officer sees it. */
export interface RejectedSignup extends Typed {
  requestId: string;
  displayName: string;
  email: string;
  verification: Check;
  verifiedOn?: string;
  rejectedAt?: Date;
}

/** The person's token was refused, has run out, or is not one to send: sign in again. */
export class MembershipSignInAgain extends Error {
  constructor(readonly rpc: string) {
    super(`sign in again for ${rpc}`);
    this.name = 'MembershipSignInAgain';
  }
}

/** invalid: a value the API would not take; on_file: a sign-up is already on file; profile: no name or email on the account. */
export class SignupRefused extends Error {
  constructor(readonly reason: 'invalid' | 'on_file' | 'profile') {
    super(`the sign-up was refused (${reason})`);
    this.name = 'SignupRefused';
  }
}

/** PROFILE-ID. invalid: a name the API would not take; not_member: no approved sign-up to change. */
export class ProfileRefused extends Error {
  constructor(readonly reason: 'invalid' | 'not_member') {
    super(`the profile change was refused (${reason})`);
    this.name = 'ProfileRefused';
  }
}

/** own: the approver's own sign-up; closed: decided already, gone, or not one the API can find. */
export class DecisionRefused extends Error {
  constructor(readonly reason: 'own' | 'closed') {
    super(`the decision was refused (${reason})`);
    this.name = 'DecisionRefused';
  }
}

export interface MembershipApi {
  /** Undefined: the person has no account yet. */
  getMyAccount(as: Reader): Promise<MyAccount | undefined>;
  /** OFFICER-VERIFY: the account, if any, and the officer tools, in one call. */
  getMyStanding(as: Reader): Promise<MyStanding>;
  /** One sign-up's decision, for the approvers; undefined on any failure (no banner). Never throws. */
  getSignupDecision(as: Reader, requestId: string): Promise<Decision | undefined>;
  submitSignup(as: Reader, signup: { firstName: string; lastName: string; membershipNumber: string }): Promise<void>;
  /** PROFILE-ID: an approved member's two names; never the number. */
  updateMyProfile(as: Reader, names: { firstName: string; lastName: string }): Promise<void>;
  listSignupRequests(as: Reader): Promise<PendingSignup[]>;
  /** VET fix 1: confirmedWarning, the approver confirmed an email mismatch or resolved a duplicate claim. */
  approveSignup(as: Reader, requestId: string, options?: { confirmedWarning?: boolean }): Promise<void>;
  rejectSignup(as: Reader, requestId: string): Promise<void>;
  /** REOPEN: the Admin and the Membership Officer only. */
  listRejectedSignups(as: Reader): Promise<RejectedSignup[]>;
  reopenSignup(as: Reader, requestId: string): Promise<void>;
}

const STANDING: Record<Standing, MemberStatus> = {
  pending: MemberStatus.PENDING,
  member: MemberStatus.MEMBER,
  affiliate: MemberStatus.AFFILIATE,
  lapsed: MemberStatus.LAPSED,
  removed: MemberStatus.REMOVED,
};
const ROUTE: Record<Route, AccountRoute> = { invite: AccountRoute.INVITE, signup: AccountRoute.SIGNUP, admin_grant: AccountRoute.ADMIN_GRANT };
const CHECK: Record<Check, Verification> = {
  unchecked: Verification.UNCHECKED,
  verified_local: Verification.VERIFIED_LOCAL,
  verified_other_group: Verification.VERIFIED_OTHER_GROUP,
  not_found: Verification.NOT_FOUND,
  error: Verification.ERROR,
  email_mismatch: Verification.EMAIL_MISMATCH,
  duplicate_claim: Verification.DUPLICATE_CLAIM,
};

const LOCAL_GROUP: Record<LocalGroup, LocalGroupStanding> = {
  chapter: LocalGroupStanding.CHAPTER,
  guest: LocalGroupStanding.GUEST,
  guest_unlisted: LocalGroupStanding.GUEST_UNLISTED,
};
const TOOLS: Record<OfficerToolsState, OfficerTools> = { none: OfficerTools.UNSPECIFIED, open: OfficerTools.OPEN, awaiting_check: OfficerTools.AWAITING_CHECK };
const DECISION: Record<Decision, SignupDecision> = {
  pending: SignupDecision.PENDING,
  approved: SignupDecision.APPROVED,
  rejected: SignupDecision.REJECTED,
  reopened: SignupDecision.REOPENED,
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A reported local group's standing, left out when none was reported. */
const localGroupOf = (standing: LocalGroupStanding) => (standing === LocalGroupStanding.UNSPECIFIED ? undefined : nameOf(LOCAL_GROUP, standing));

/** The name for a wire value; an unset or unknown one is an answer the site cannot read. */
function nameOf<K extends string, V>(table: Record<K, V>, value: V): K {
  const key = (Object.keys(table) as K[]).find((k) => table[k] === value);
  if (key === undefined) throw new ConnectError('a membership value the site cannot read', Code.DataLoss);
  return key;
}

const pad = (n: number) => String(n).padStart(2, '0');
const day = (date: ProtoDate | undefined) => (date === undefined ? {} : { verifiedOn: `${date.year}-${pad(date.month)}-${pad(date.day)}` });

const codeName = (code: Code) => Code[code].replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();

const SIGNUP_REFUSALS: Partial<Record<Code, SignupRefused['reason']>> = {
  [Code.InvalidArgument]: 'invalid',
  [Code.AlreadyExists]: 'on_file',
  [Code.FailedPrecondition]: 'profile',
};
const PROFILE_REFUSALS: Partial<Record<Code, ProfileRefused['reason']>> = {
  [Code.InvalidArgument]: 'invalid',
  [Code.FailedPrecondition]: 'not_member',
};
const DECISION_REFUSALS: Partial<Record<Code, DecisionRefused['reason']>> = {
  [Code.PermissionDenied]: 'own',
  [Code.FailedPrecondition]: 'closed',
  [Code.NotFound]: 'closed',
  [Code.InvalidArgument]: 'closed',
};

/** What was typed, leaving out each value not held. */
function typedOf(message: Pick<EarlierClaimMessage, 'firstName' | 'lastName' | 'membershipNumber'>): Typed {
  return {
    ...(message.firstName !== '' ? { firstName: message.firstName } : {}),
    ...(message.lastName !== '' ? { lastName: message.lastName } : {}),
    ...(message.membershipNumber !== '' ? { membershipNumber: message.membershipNumber } : {}),
  };
}

function pendingOf(request: SignupRequest): PendingSignup {
  const standing = localGroupOf(request.localGroupStanding);
  return {
    requestId: request.requestId,
    displayName: request.displayName,
    email: request.email,
    route: nameOf(ROUTE, request.route),
    verification: nameOf(CHECK, request.verification),
    ...typedOf(request),
    ...day(request.verifiedOn),
    ...(request.createdAt ? { createdAt: timestampDate(request.createdAt) } : {}),
    ...(request.firstNameMatched !== undefined ? { firstNameMatched: request.firstNameMatched } : {}),
    ...(request.localGroup !== '' ? { localGroup: request.localGroup } : {}),
    ...(standing !== undefined ? { localGroupStanding: standing } : {}),
    ...(request.earlierClaim
      ? {
          earlierClaim: {
            displayName: request.earlierClaim.displayName,
            ...(request.earlierClaim.signedUpAt ? { signedUpAt: timestampDate(request.earlierClaim.signedUpAt) } : {}),
            ...(request.earlierClaim.closed ? { closed: true as const } : {}),
            ...typedOf(request.earlierClaim),
          },
        }
      : {}),
  };
}

function rejectedOf(request: RejectedSignupMessage): RejectedSignup {
  return {
    requestId: request.requestId,
    displayName: request.displayName,
    email: request.email,
    verification: nameOf(CHECK, request.verification),
    ...typedOf(request),
    ...day(request.verifiedOn),
    ...(request.rejectedAt ? { rejectedAt: timestampDate(request.rejectedAt) } : {}),
  };
}

const REFUSED_MSG: Record<string, string> = {
  SubmitSignup: 'api refused the sign-up',
  UpdateMyProfile: 'api refused the profile change',
  GetSignupRequest: 'api gave no sign-up for the banner',
};

export function grpcMembership(config: ApiConfig, log: (line: string) => void): MembershipApi {
  const transport = createGrpcTransport({ baseUrl: config.baseUrl, defaultTimeoutMs: config.timeoutMs, readMaxBytes: READ_MAX_BYTES, interceptors: [traceInterceptor] });
  const membership = createClient(MembershipService, transport);

  /** refusals: the codes this call says in words, as the error each makes. */
  const call = async <T>(rpc: string, as: Reader, run: (headers: { authorization: string }) => Promise<T>, refused?: (code: Code) => Error | undefined): Promise<T> => {
    const reader = sendable(as);
    if (reader === undefined) throw new MembershipSignInAgain(rpc);
    try {
      return await run({ authorization: `Bearer ${reader.bearer}` });
    } catch (error) {
      const code = ConnectError.from(error).code;
      if (code === Code.Unauthenticated) {
        log(JSON.stringify({ level: 'warn', msg: 'api refused the token', rpc, code: codeName(code) }));
        throw new MembershipSignInAgain(rpc);
      }
      const said = refused?.(code);
      if (said !== undefined) {
        log(JSON.stringify({ level: 'warn', msg: REFUSED_MSG[rpc] ?? 'api refused the decision', rpc, code: codeName(code) }));
        throw said;
      }
      log(JSON.stringify({ level: 'error', msg: 'api call failed', rpc, code: codeName(code) }));
      throw new ApiUnavailable(rpc);
    }
  };

  const signupRefused = (code: Code) => {
    const reason = SIGNUP_REFUSALS[code];
    return reason === undefined ? undefined : new SignupRefused(reason);
  };
  const profileRefused = (code: Code) => {
    const reason = PROFILE_REFUSALS[code];
    return reason === undefined ? undefined : new ProfileRefused(reason);
  };
  const decisionRefused = (code: Code) => {
    const reason = DECISION_REFUSALS[code];
    return reason === undefined ? undefined : new DecisionRefused(reason);
  };

  const getMyStanding = (as: Reader): Promise<MyStanding> =>
    call('GetMyAccount', as, async (headers) => {
      const { account, profile, officerTools } = await membership.getMyAccount({}, { headers });
      const tools = nameOf(TOOLS, officerTools);
      if (account === undefined) return { officerTools: tools };
      const group = localGroupOf(account.localGroupStanding);
      return {
        account: {
          status: nameOf(STANDING, account.status),
          route: nameOf(ROUTE, account.route),
          ...day(account.verifiedOn),
          ...(group !== undefined ? { localGroup: group } : {}),
          ...(profile
            ? {
                profile: {
                  firstName: profile.firstName,
                  lastName: profile.lastName,
                  membershipNumber: profile.membershipNumber,
                  ...(profile.localGroup !== '' ? { localGroup: profile.localGroup } : {}),
                },
              }
            : {}),
        },
        officerTools: tools,
      };
    });

  return {
    getMyAccount: async (as) => (await getMyStanding(as)).account,
    getMyStanding,
    getSignupDecision: async (as, requestId) => {
      if (!UUID.test(requestId)) return undefined;
      try {
        // A sign-up gone or not theirs is an answer, logged as a refusal, not a failure.
        const { decision } = await call('GetSignupRequest', as, (headers) => membership.getSignupRequest({ requestId }, { headers }), decisionRefused);
        return nameOf(DECISION, decision);
      } catch {
        // Gone, not theirs, unreadable or the API down: no banner (each failure is logged by call() by code).
        return undefined;
      }
    },
    updateMyProfile: (as, names) =>
      call(
        'UpdateMyProfile',
        as,
        async (headers) => {
          await membership.updateMyProfile({ firstName: names.firstName, lastName: names.lastName }, { headers });
        },
        profileRefused,
      ),
    submitSignup: (as, signup) =>
      call(
        'SubmitSignup',
        as,
        async (headers) => {
          await membership.submitSignup({ firstName: signup.firstName, lastName: signup.lastName, membershipNumber: signup.membershipNumber }, { headers });
        },
        signupRefused,
      ),
    listSignupRequests: (as) => call('ListSignupRequests', as, async (headers) => (await membership.listSignupRequests({}, { headers })).requests.map(pendingOf)),
    approveSignup: (as, requestId, options) =>
      call(
        'ApproveSignup',
        as,
        async (headers) => {
          await membership.approveSignup({ requestId, confirmedWarning: options?.confirmedWarning === true }, { headers });
        },
        decisionRefused,
      ),
    rejectSignup: (as, requestId) =>
      call(
        'RejectSignup',
        as,
        async (headers) => {
          await membership.rejectSignup({ requestId }, { headers });
        },
        decisionRefused,
      ),
    listRejectedSignups: (as) => call('ListRejectedSignups', as, async (headers) => (await membership.listRejectedSignups({}, { headers })).requests.map(rejectedOf)),
    reopenSignup: (as, requestId) =>
      call(
        'ReopenSignup',
        as,
        async (headers) => {
          await membership.reopenSignup({ requestId }, { headers });
        },
        decisionRefused,
      ),
  };
}

/** Every call fails: the API is switched on but set up wrongly. */
export function unavailableMembership(): MembershipApi {
  const fail = (rpc: string) => () => Promise.reject(new ApiUnavailable(rpc));
  return {
    getMyAccount: fail('GetMyAccount'),
    getMyStanding: fail('GetMyAccount'),
    getSignupDecision: () => Promise.resolve(undefined),
    submitSignup: fail('SubmitSignup'),
    updateMyProfile: fail('UpdateMyProfile'),
    listSignupRequests: fail('ListSignupRequests'),
    approveSignup: fail('ApproveSignup'),
    rejectSignup: fail('RejectSignup'),
    listRejectedSignups: fail('ListRejectedSignups'),
    reopenSignup: fail('ReopenSignup'),
  };
}

/** The membership client for this environment: none without API_URL, and none in a public-only build (no sign-in at all). */
export function membershipFromEnv(env: Record<string, string | undefined>, { publicOnly, log }: { publicOnly: boolean; log: (line: string) => void }): MembershipApi | undefined {
  if (publicOnly) return undefined;
  const setup = apiSetup(env);
  if (!setup.enabled) return undefined;
  if ('error' in setup) {
    log(JSON.stringify({ level: 'error', msg: setup.error }));
    return unavailableMembership();
  }
  return grpcMembership(setup.config, log);
}

let membershipClient: { api: MembershipApi | undefined } | undefined;

/** One per process, as officerApi() is. */
export function membershipApi(): MembershipApi | undefined {
  membershipClient ??= { api: membershipFromEnv(process.env, { publicOnly: PUBLIC_ONLY, log: apiLog }) };
  return membershipClient.api;
}

export interface SessionReaderDeps {
  tokens: Pick<TokenStore<Tokens>, 'get'>;
  /** Seconds. */
  now: () => number;
}

/**
 * The signed-in person's own access token to send, if any: for a live session whose token has more
 * than 30 seconds to live, whatever their groups (the API decides what the token may do). Lapsed when
 * that session or token has run out (sign in again).
 */
export function sessionReader(session: Session | undefined, { tokens, now }: SessionReaderDeps): { reader: Reader | undefined; lapsed: boolean } {
  if (session === undefined) return { reader: undefined, lapsed: false };
  const at = now();
  if (session.exp <= at) return { reader: undefined, lapsed: true };
  const record = tokens.get(session.sid, at);
  const expiresAt = record?.expires_at;
  if (record === undefined || record.access_token === '' || typeof expiresAt !== 'number' || expiresAt - EXPIRY_MARGIN_SECONDS <= at) return { reader: undefined, lapsed: true };
  return { reader: { bearer: record.access_token }, lapsed: false };
}
