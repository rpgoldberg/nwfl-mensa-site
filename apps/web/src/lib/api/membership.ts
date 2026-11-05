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
// or one already decided or gone). Anything else is ApiUnavailable. Each failure is logged by call
// and code only: never the API's message, the token, the last name or the membership number (D6).
import { PUBLIC_ONLY } from 'astro:env/server';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, createClient } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import type { Session } from '../../../server/session.mjs';
import type { TokenStore } from '../../../server/token-store.mjs';
import type { Date as ProtoDate } from '../../gen/nwfl/mensa/v1/common_pb.js';
import { AccountRoute, MemberStatus, MembershipService, type SignupRequest, Verification } from '../../gen/nwfl/mensa/v1/membership_pb.js';
import { EXPIRY_MARGIN_SECONDS } from '../auth/bearer';
import type { Tokens } from '../auth/oidc';
import { type ApiConfig, ApiUnavailable, READ_MAX_BYTES, type Reader, apiSetup, sendable } from './client';

export type Standing = 'pending' | 'member' | 'affiliate' | 'lapsed' | 'removed';
export type Route = 'invite' | 'signup' | 'admin_grant';
export type Check = 'unchecked' | 'verified_local' | 'verified_other_group' | 'not_found' | 'error';

/** The person's own account; verifiedOn is the day it was last checked, YYYY-MM-DD. */
export interface MyAccount {
  status: Standing;
  route: Route;
  verifiedOn?: string;
}

/** A pending sign-up as an approver sees it: never the number or the last name (the API never sends them). */
export interface PendingSignup {
  requestId: string;
  displayName: string;
  email: string;
  route: Route;
  verification: Check;
  verifiedOn?: string;
  createdAt?: Date;
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
  submitSignup(as: Reader, signup: { lastName: string; membershipNumber: string }): Promise<void>;
  listSignupRequests(as: Reader): Promise<PendingSignup[]>;
  approveSignup(as: Reader, requestId: string): Promise<void>;
  rejectSignup(as: Reader, requestId: string): Promise<void>;
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
};

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
const DECISION_REFUSALS: Partial<Record<Code, DecisionRefused['reason']>> = {
  [Code.PermissionDenied]: 'own',
  [Code.FailedPrecondition]: 'closed',
  [Code.NotFound]: 'closed',
  [Code.InvalidArgument]: 'closed',
};

function pendingOf(request: SignupRequest): PendingSignup {
  return {
    requestId: request.requestId,
    displayName: request.displayName,
    email: request.email,
    route: nameOf(ROUTE, request.route),
    verification: nameOf(CHECK, request.verification),
    ...day(request.verifiedOn),
    ...(request.createdAt ? { createdAt: timestampDate(request.createdAt) } : {}),
  };
}

export function grpcMembership(config: ApiConfig, log: (line: string) => void): MembershipApi {
  const transport = createGrpcTransport({ baseUrl: config.baseUrl, defaultTimeoutMs: config.timeoutMs, readMaxBytes: READ_MAX_BYTES });
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
        log(JSON.stringify({ level: 'warn', msg: rpc === 'SubmitSignup' ? 'api refused the sign-up' : 'api refused the decision', rpc, code: codeName(code) }));
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
  const decisionRefused = (code: Code) => {
    const reason = DECISION_REFUSALS[code];
    return reason === undefined ? undefined : new DecisionRefused(reason);
  };

  return {
    getMyAccount: (as) =>
      call('GetMyAccount', as, async (headers) => {
        const { account } = await membership.getMyAccount({}, { headers });
        return account === undefined ? undefined : { status: nameOf(STANDING, account.status), route: nameOf(ROUTE, account.route), ...day(account.verifiedOn) };
      }),
    submitSignup: (as, signup) =>
      call(
        'SubmitSignup',
        as,
        async (headers) => {
          await membership.submitSignup({ lastName: signup.lastName, membershipNumber: signup.membershipNumber }, { headers });
        },
        signupRefused,
      ),
    listSignupRequests: (as) => call('ListSignupRequests', as, async (headers) => (await membership.listSignupRequests({}, { headers })).requests.map(pendingOf)),
    approveSignup: (as, requestId) =>
      call(
        'ApproveSignup',
        as,
        async (headers) => {
          await membership.approveSignup({ requestId }, { headers });
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
  };
}

/** Every call fails: the API is switched on but set up wrongly. */
export function unavailableMembership(): MembershipApi {
  const fail = (rpc: string) => () => Promise.reject(new ApiUnavailable(rpc));
  return {
    getMyAccount: fail('GetMyAccount'),
    submitSignup: fail('SubmitSignup'),
    listSignupRequests: fail('ListSignupRequests'),
    approveSignup: fail('ApproveSignup'),
    rejectSignup: fail('RejectSignup'),
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
  membershipClient ??= { api: membershipFromEnv(process.env, { publicOnly: PUBLIC_ONLY, log: (line) => console.error(line) }) };
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
