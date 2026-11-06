// W-SIGNUP: the site's client for MembershipService. It sends the signed-in person's own access token
// as a bearer, on these RPCs only, over the gRPC wire protocol. A refused token asks them to sign in
// again; a sign-up or a decision the API refuses is said in plain words by its kind; anything else is
// "unavailable", logged by call and code only: never the token, the API's message, the last name or
// the membership number.
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, type ConnectRouter } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { newSession } from '../../../server/session.mjs';
import { TokenStore } from '../../../server/token-store.mjs';
import { AccountRoute, MemberStatus, MembershipService, RejectedSignupSchema, SignupRequestSchema, Verification } from '../../gen/nwfl/mensa/v1/membership_pb.js';
import type { Tokens } from '../auth/oidc';
import { ApiUnavailable } from './client';
import { DecisionRefused, MembershipSignInAgain, SignupRefused, grpcMembership, membershipApi, membershipFromEnv, sessionReader, unavailableMembership } from './membership';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function grpcServer(routes: (router: ConnectRouter) => void): Promise<{ url: string; headers: http2.IncomingHttpHeaders[] }> {
  const headers: http2.IncomingHttpHeaders[] = [];
  const adapter = connectNodeAdapter({ routes, grpc: true, grpcWeb: false, connect: false });
  const sessions = new Set<http2.ServerHttp2Session>();
  const server = http2.createServer((req, res) => {
    headers.push({ ...req.headers });
    void adapter(req, res);
  });
  server.on('session', (s) => sessions.add(s));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(
    () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        for (const s of sessions) s.destroy();
      }),
  );
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, headers };
}

const PERSON = { bearer: 'person.tok-en' };
// Obviously fake: never a real membership number.
const FAKE_NUMBER = '000012345';
const FAKE_LAST = 'Fakename';
const ID = '6a1f0c8e-1b2c-4d3e-8f40-5a6b7c8d9e0f';
const CREATED = new Date('2026-11-02T14:00:00Z');
const config = (url: string) => ({ baseUrl: url, timeoutMs: 2000 });

describe('grpcMembership: the person\'s own account', () => {
  it('reads the account with the person\'s bearer, by name, with the day it was last checked', async () => {
    const server = await grpcServer((router) =>
      router.service(MembershipService, {
        getMyAccount: () => ({ account: { status: MemberStatus.MEMBER, route: AccountRoute.INVITE, verifiedOn: { year: 2026, month: 10, day: 2 } } }),
      }),
    );
    const api = grpcMembership(config(server.url), () => {});
    expect(await api.getMyAccount(PERSON)).toEqual({ status: 'member', route: 'invite', verifiedOn: '2026-10-02' });
    expect(server.headers[0]?.['authorization']).toBe('Bearer person.tok-en');
    expect(server.headers[0]?.['content-type']).toBe('application/grpc+proto');
    expect(server.headers[0]?.['cookie']).toBeUndefined();
  });

  it('reads no account as none, and an account never checked with no day', async () => {
    let answer: object = {};
    const server = await grpcServer((router) => router.service(MembershipService, { getMyAccount: () => answer }));
    const api = grpcMembership(config(server.url), () => {});
    expect(await api.getMyAccount(PERSON)).toBeUndefined();
    answer = { account: { status: MemberStatus.PENDING, route: AccountRoute.SIGNUP } };
    expect(await api.getMyAccount(PERSON)).toEqual({ status: 'pending', route: 'signup' });
  });

  it('refuses an account it cannot read: an unset status or route', async () => {
    let answer: object = { account: { status: MemberStatus.UNSPECIFIED, route: AccountRoute.SIGNUP } };
    const server = await grpcServer((router) => router.service(MembershipService, { getMyAccount: () => answer }));
    const api = grpcMembership(config(server.url), () => {});
    await expect(api.getMyAccount(PERSON)).rejects.toBeInstanceOf(ApiUnavailable);
    answer = { account: { status: MemberStatus.MEMBER, route: AccountRoute.UNSPECIFIED } };
    await expect(api.getMyAccount(PERSON)).rejects.toBeInstanceOf(ApiUnavailable);
  });

  it('sends the sign-up\'s last name and number to the API and nowhere else', async () => {
    const seen: unknown[] = [];
    const server = await grpcServer((router) =>
      router.service(MembershipService, {
        submitSignup: (req) => {
          seen.push({ lastName: req.lastName, membershipNumber: req.membershipNumber });
          return { requestId: ID };
        },
      }),
    );
    const lines: string[] = [];
    const api = grpcMembership(config(server.url), (line) => lines.push(line));
    await api.submitSignup(PERSON, { lastName: FAKE_LAST, membershipNumber: FAKE_NUMBER });
    expect(seen).toEqual([{ lastName: FAKE_LAST, membershipNumber: FAKE_NUMBER }]);
    expect(server.headers[0]?.['authorization']).toBe('Bearer person.tok-en');
    expect(lines).toEqual([]);
  });

  it.each([
    [Code.InvalidArgument, 'invalid', 'invalid_argument'],
    [Code.AlreadyExists, 'on_file', 'already_exists'],
    [Code.FailedPrecondition, 'profile', 'failed_precondition'],
  ] as const)('says a refused sign-up (%s) by its kind, %s, and logs the call and code only', async (code, reason, logged) => {
    const server = await grpcServer((router) =>
      router.service(MembershipService, {
        submitSignup: () => {
          throw new ConnectError(`refused ${FAKE_NUMBER} ${FAKE_LAST}`, code);
        },
      }),
    );
    const lines: string[] = [];
    const api = grpcMembership(config(server.url), (line) => lines.push(line));
    const error = await api.submitSignup(PERSON, { lastName: FAKE_LAST, membershipNumber: FAKE_NUMBER }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SignupRefused);
    expect((error as SignupRefused).reason).toBe(reason);
    expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual([{ level: 'warn', msg: 'api refused the sign-up', rpc: 'SubmitSignup', code: logged }]);
    expect(`${lines.join('\n')} ${String(error)}`).not.toMatch(new RegExp(`${FAKE_NUMBER}|${FAKE_LAST}|tok-en`));
  });
});

describe('grpcMembership: the approvers\' queue', () => {
  it('lists the pending sign-ups by name, with how they came, the check and its day, never more', async () => {
    const server = await grpcServer((router) =>
      router.service(MembershipService, {
        listSignupRequests: () => ({
          requests: [
            create(SignupRequestSchema, {
              requestId: ID,
              displayName: 'Jesse Example',
              email: 'jesse@example.org',
              route: AccountRoute.INVITE,
              verification: Verification.VERIFIED_LOCAL,
              verifiedOn: { year: 2026, month: 11, day: 2 },
              createdAt: timestampFromDate(CREATED),
            }),
            create(SignupRequestSchema, { requestId: ID, displayName: 'Kendall Sample', email: 'kendall@example.org', route: AccountRoute.SIGNUP, verification: Verification.UNCHECKED }),
          ],
        }),
      }),
    );
    const api = grpcMembership(config(server.url), () => {});
    expect(await api.listSignupRequests(PERSON)).toEqual([
      { requestId: ID, displayName: 'Jesse Example', email: 'jesse@example.org', route: 'invite', verification: 'verified_local', verifiedOn: '2026-11-02', createdAt: CREATED },
      { requestId: ID, displayName: 'Kendall Sample', email: 'kendall@example.org', route: 'signup', verification: 'unchecked' },
    ]);
    expect(server.headers[0]?.['authorization']).toBe('Bearer person.tok-en');
  });

  it('refuses a queue it cannot read: an unset check or route', async () => {
    let request = { requestId: ID, route: AccountRoute.SIGNUP, verification: Verification.UNSPECIFIED };
    const server = await grpcServer((router) => router.service(MembershipService, { listSignupRequests: () => ({ requests: [request] }) }));
    const api = grpcMembership(config(server.url), () => {});
    await expect(api.listSignupRequests(PERSON)).rejects.toBeInstanceOf(ApiUnavailable);
    request = { requestId: ID, route: AccountRoute.UNSPECIFIED, verification: Verification.NOT_FOUND };
    await expect(api.listSignupRequests(PERSON)).rejects.toBeInstanceOf(ApiUnavailable);
  });

  it('approves and rejects by the request id', async () => {
    const seen: string[] = [];
    const server = await grpcServer((router) =>
      router.service(MembershipService, {
        approveSignup: (req) => {
          seen.push(`approve ${req.requestId}`);
          return { account: { status: MemberStatus.MEMBER, route: AccountRoute.SIGNUP } };
        },
        rejectSignup: (req) => {
          seen.push(`reject ${req.requestId}`);
          return {};
        },
      }),
    );
    const api = grpcMembership(config(server.url), () => {});
    await api.approveSignup(PERSON, ID);
    await api.rejectSignup(PERSON, ID);
    expect(seen).toEqual([`approve ${ID}`, `reject ${ID}`]);
  });

  it.each([
    [Code.PermissionDenied, 'own'],
    [Code.FailedPrecondition, 'closed'],
    [Code.NotFound, 'closed'],
    [Code.InvalidArgument, 'closed'],
  ] as const)('says a refused decision (%s) by its kind, %s', async (code, reason) => {
    const server = await grpcServer((router) =>
      router.service(MembershipService, {
        approveSignup: () => {
          throw new ConnectError('no', code);
        },
        rejectSignup: () => {
          throw new ConnectError('no', code);
        },
      }),
    );
    const lines: string[] = [];
    const api = grpcMembership(config(server.url), (line) => lines.push(line));
    for (const decide of [api.approveSignup, api.rejectSignup]) {
      const error = await decide(PERSON, ID).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DecisionRefused);
      expect((error as DecisionRefused).reason).toBe(reason);
    }
    expect(lines.map((l) => (JSON.parse(l) as { rpc: string; msg: string }).rpc)).toEqual(['ApproveSignup', 'RejectSignup']);
  });
});

describe('grpcMembership: reopening a rejection (REOPEN)', () => {
  const REJECTED = new Date('2026-11-04T16:00:00Z');

  it('lists the rejections by name, with the check, its day and the day of the rejection, never more', async () => {
    const server = await grpcServer((router) =>
      router.service(MembershipService, {
        listRejectedSignups: () => ({
          requests: [
            create(RejectedSignupSchema, {
              requestId: ID,
              displayName: 'Dana Sample',
              email: 'dana@example.org',
              verification: Verification.NOT_FOUND,
              verifiedOn: { year: 2026, month: 11, day: 3 },
              rejectedAt: timestampFromDate(REJECTED),
            }),
            create(RejectedSignupSchema, { requestId: ID, displayName: 'Kai Example', email: 'kai@example.org', verification: Verification.UNCHECKED }),
          ],
        }),
      }),
    );
    const api = grpcMembership(config(server.url), () => {});
    expect(await api.listRejectedSignups(PERSON)).toEqual([
      { requestId: ID, displayName: 'Dana Sample', email: 'dana@example.org', verification: 'not_found', verifiedOn: '2026-11-03', rejectedAt: REJECTED },
      { requestId: ID, displayName: 'Kai Example', email: 'kai@example.org', verification: 'unchecked' },
    ]);
    expect(server.headers[0]?.['authorization']).toBe('Bearer person.tok-en');
  });

  it('refuses a list it cannot read: an unset check', async () => {
    const server = await grpcServer((router) => router.service(MembershipService, { listRejectedSignups: () => ({ requests: [{ requestId: ID, verification: Verification.UNSPECIFIED }] }) }));
    const api = grpcMembership(config(server.url), () => {});
    await expect(api.listRejectedSignups(PERSON)).rejects.toBeInstanceOf(ApiUnavailable);
  });

  it('reopens by the request id', async () => {
    const seen: string[] = [];
    const server = await grpcServer((router) =>
      router.service(MembershipService, {
        reopenSignup: (req) => {
          seen.push(req.requestId);
          return {};
        },
      }),
    );
    await grpcMembership(config(server.url), () => {}).reopenSignup(PERSON, ID);
    expect(seen).toEqual([ID]);
  });

  it.each([
    [Code.PermissionDenied, 'own'],
    [Code.FailedPrecondition, 'closed'],
    [Code.NotFound, 'closed'],
    [Code.InvalidArgument, 'closed'],
  ] as const)('says a refused reopening (%s) by its kind, %s, logged by call and code', async (code, reason) => {
    const server = await grpcServer((router) =>
      router.service(MembershipService, {
        reopenSignup: () => {
          throw new ConnectError('no', code);
        },
      }),
    );
    const lines: string[] = [];
    const error = await grpcMembership(config(server.url), (line) => lines.push(line)).reopenSignup(PERSON, ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DecisionRefused);
    expect((error as DecisionRefused).reason).toBe(reason);
    expect(lines.map((l) => (JSON.parse(l) as { rpc: string }).rpc)).toEqual(['ReopenSignup']);
  });

  it('asks to sign in again on a refused token, and is unavailable when the API is set up wrongly', async () => {
    const refuse = () => {
      throw new ConnectError('expired', Code.Unauthenticated);
    };
    const server = await grpcServer((router) => router.service(MembershipService, { listRejectedSignups: refuse, reopenSignup: refuse }));
    const api = grpcMembership(config(server.url), () => {});
    await expect(api.listRejectedSignups(PERSON)).rejects.toBeInstanceOf(MembershipSignInAgain);
    await expect(api.reopenSignup(PERSON, ID)).rejects.toBeInstanceOf(MembershipSignInAgain);
    await expect(unavailableMembership().listRejectedSignups(PERSON)).rejects.toBeInstanceOf(ApiUnavailable);
    await expect(unavailableMembership().reopenSignup(PERSON, ID)).rejects.toBeInstanceOf(ApiUnavailable);
  });
});

describe('grpcMembership: failures', () => {
  it('asks to sign in again when the API refuses the token, on every call, and logs the call and code only', async () => {
    const refuse = () => {
      throw new ConnectError('token expired for person.tok-en', Code.Unauthenticated);
    };
    const server = await grpcServer((router) =>
      router.service(MembershipService, { getMyAccount: refuse, submitSignup: refuse, listSignupRequests: refuse, approveSignup: refuse, rejectSignup: refuse }),
    );
    const lines: string[] = [];
    const api = grpcMembership(config(server.url), (line) => lines.push(line));
    await expect(api.getMyAccount(PERSON)).rejects.toBeInstanceOf(MembershipSignInAgain);
    await expect(api.submitSignup(PERSON, { lastName: FAKE_LAST, membershipNumber: FAKE_NUMBER })).rejects.toBeInstanceOf(MembershipSignInAgain);
    await expect(api.listSignupRequests(PERSON)).rejects.toBeInstanceOf(MembershipSignInAgain);
    await expect(api.approveSignup(PERSON, ID)).rejects.toBeInstanceOf(MembershipSignInAgain);
    await expect(api.rejectSignup(PERSON, ID)).rejects.toBeInstanceOf(MembershipSignInAgain);
    expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual(
      ['GetMyAccount', 'SubmitSignup', 'ListSignupRequests', 'ApproveSignup', 'RejectSignup'].map((rpc) => ({ level: 'warn', msg: 'api refused the token', rpc, code: 'unauthenticated' })),
    );
    expect(lines.join('\n')).not.toMatch(new RegExp(`tok-en|expired|${FAKE_NUMBER}|${FAKE_LAST}`));
  });

  it('makes any other refusal or failure unavailable, logged by call and code', async () => {
    const server = await grpcServer((router) =>
      router.service(MembershipService, {
        getMyAccount: () => {
          throw new ConnectError('down', Code.Unavailable);
        },
        listSignupRequests: () => {
          throw new ConnectError('not permitted', Code.PermissionDenied);
        },
        submitSignup: () => {
          throw new ConnectError('oops', Code.Internal);
        },
        approveSignup: () => {
          throw new ConnectError('oops', Code.Internal);
        },
      }),
    );
    const lines: string[] = [];
    const api = grpcMembership(config(server.url), (line) => lines.push(line));
    await expect(api.getMyAccount(PERSON)).rejects.toBeInstanceOf(ApiUnavailable);
    await expect(api.listSignupRequests(PERSON)).rejects.toBeInstanceOf(ApiUnavailable);
    await expect(api.submitSignup(PERSON, { lastName: FAKE_LAST, membershipNumber: FAKE_NUMBER })).rejects.toBeInstanceOf(ApiUnavailable);
    await expect(api.approveSignup(PERSON, ID)).rejects.toBeInstanceOf(ApiUnavailable);
    expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual([
      { level: 'error', msg: 'api call failed', rpc: 'GetMyAccount', code: 'unavailable' },
      { level: 'error', msg: 'api call failed', rpc: 'ListSignupRequests', code: 'permission_denied' },
      { level: 'error', msg: 'api call failed', rpc: 'SubmitSignup', code: 'internal' },
      { level: 'error', msg: 'api call failed', rpc: 'ApproveSignup', code: 'internal' },
    ]);
  });

  it('never sends a bearer that is not one b64token: it asks to sign in again instead', async () => {
    const server = await grpcServer((router) => router.service(MembershipService, { getMyAccount: () => ({}) }));
    const api = grpcMembership(config(server.url), () => {});
    await expect(api.getMyAccount({ bearer: 'two words' })).rejects.toBeInstanceOf(MembershipSignInAgain);
    expect(server.headers).toEqual([]);
  });

  it('is unavailable everywhere when the API is set up wrongly', async () => {
    const api = unavailableMembership();
    await expect(api.getMyAccount(PERSON)).rejects.toBeInstanceOf(ApiUnavailable);
    await expect(api.submitSignup(PERSON, { lastName: FAKE_LAST, membershipNumber: FAKE_NUMBER })).rejects.toBeInstanceOf(ApiUnavailable);
    await expect(api.listSignupRequests(PERSON)).rejects.toBeInstanceOf(ApiUnavailable);
    await expect(api.approveSignup(PERSON, ID)).rejects.toBeInstanceOf(ApiUnavailable);
    await expect(api.rejectSignup(PERSON, ID)).rejects.toBeInstanceOf(ApiUnavailable);
  });
});

describe('membershipFromEnv', () => {
  it('is off without API_URL and in the public-only build, unavailable when set wrongly, on otherwise', async () => {
    const lines: string[] = [];
    expect(membershipFromEnv({}, { publicOnly: false, log: () => {} })).toBeUndefined();
    expect(membershipFromEnv({ API_URL: 'http://127.0.0.1:1' }, { publicOnly: true, log: () => {} })).toBeUndefined();
    const wrong = membershipFromEnv({ API_URL: 'ftp://x' }, { publicOnly: false, log: (l) => lines.push(l) });
    await expect(wrong?.getMyAccount(PERSON)).rejects.toBeInstanceOf(ApiUnavailable);
    expect(lines).toHaveLength(1);
    expect(membershipFromEnv({ API_URL: 'http://127.0.0.1:1' }, { publicOnly: false, log: () => {} })).toBeDefined();
  });

  it('gives one client per process, from the process environment (none here: no API_URL)', () => {
    const before = process.env['API_URL'];
    delete process.env['API_URL'];
    try {
      expect(membershipApi()).toBeUndefined();
      expect(membershipApi()).toBeUndefined();
    } finally {
      if (before !== undefined) process.env['API_URL'] = before;
    }
  });
});

describe('sessionReader', () => {
  const NOW = 1_800_000_000;
  const signedIn = (groups: string[], tokens: Tokens | undefined) => {
    const store = new TokenStore<Tokens>();
    const session = newSession({ sub: '0f8e2c4a-1b3d-4e5f-8a9b-0c1d2e3f4a5b', groups }, NOW - 60);
    if (tokens) store.put(session.sid, tokens, session.exp);
    return { session, deps: { tokens: store, now: () => NOW } };
  };

  it('gives any signed-in person\'s own token with more than 30 s to live, whatever their groups', () => {
    for (const groups of [['nwfl-users'], ['nwfl-members', 'nwfl-officers'], ['nwfl-membership-approvers'], []]) {
      const { session, deps } = signedIn(groups, { access_token: 'tok.en', expires_at: NOW + 31 });
      expect(sessionReader(session, deps), groups.join()).toEqual({ reader: { bearer: 'tok.en' }, lapsed: false });
    }
  });

  it('gives nothing to no session, and says lapsed with no token, a token about to run out, or an ended session', () => {
    expect(sessionReader(undefined, signedIn([], undefined).deps)).toEqual({ reader: undefined, lapsed: false });
    const none = signedIn(['nwfl-users'], undefined);
    expect(sessionReader(none.session, none.deps)).toEqual({ reader: undefined, lapsed: true });
    const blank = signedIn(['nwfl-users'], { access_token: '', expires_at: NOW + 3600 });
    expect(sessionReader(blank.session, blank.deps)).toEqual({ reader: undefined, lapsed: true });
    const undated = signedIn(['nwfl-users'], { access_token: 'tok.en' });
    expect(sessionReader(undated.session, undated.deps)).toEqual({ reader: undefined, lapsed: true });
    const soon = signedIn(['nwfl-users'], { access_token: 'tok.en', expires_at: NOW + 30 });
    expect(sessionReader(soon.session, soon.deps)).toEqual({ reader: undefined, lapsed: true });
    const ended = signedIn(['nwfl-users'], { access_token: 'tok.en', expires_at: NOW + 3600 });
    expect(sessionReader({ ...ended.session, exp: NOW }, ended.deps)).toEqual({ reader: undefined, lapsed: true });
  });
});
