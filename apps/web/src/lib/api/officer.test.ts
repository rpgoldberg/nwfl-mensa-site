// SOLO-APPROVE: the officer area's client for ApprovalRuleService. It sends the signed-in officer's
// access token as a bearer, on these RPCs only, over the gRPC wire protocol; a refused token asks the
// officer to sign in again, and any other failure is "unavailable", logged by call and code only.
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, type ConnectRouter } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { newSession } from '../../../server/session.mjs';
import { TokenStore } from '../../../server/token-store.mjs';
import { ApprovalRule, ApprovalRuleService, ApprovalScope, ApprovalSettingSchema } from '../../gen/nwfl/mensa/v1/approval_pb.js';
import type { Tokens } from '../auth/oidc';
import { ApiUnavailable } from './client';
import { OfficerSignInAgain, grpcOfficer, officerFromEnv, officerReader, unavailableOfficer } from './officer';

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

const NOV_3 = new Date('2026-11-03T19:35:00Z');
const OFFICER = { bearer: 'officer.tok-en' };
const SECRET_REASON = 'reason-not-for-logs';

describe('grpcOfficer', () => {
  it('reads both settings with the officer\'s bearer, by name, and the date set', async () => {
    const server = await grpcServer((router) =>
      router.service(ApprovalRuleService, {
        getApprovalRules: () => ({
          settings: [
            create(ApprovalSettingSchema, { scope: ApprovalScope.CONTENT, rule: ApprovalRule.ONE_APPROVER, setAt: timestampFromDate(NOV_3) }),
            create(ApprovalSettingSchema, { scope: ApprovalScope.REDACTION_POLICY, rule: ApprovalRule.TWO_PERSON }),
          ],
        }),
      }),
    );
    const api = grpcOfficer({ baseUrl: server.url, timeoutMs: 2000 }, () => {});
    expect(await api.getApprovalRules(OFFICER)).toEqual([
      { scope: 'content', rule: 'one_approver', setAt: NOV_3 },
      { scope: 'redaction_policy', rule: 'two_person' },
    ]);
    expect(server.headers[0]?.['authorization']).toBe('Bearer officer.tok-en');
    expect(server.headers[0]?.['content-type']).toBe('application/grpc+proto');
    expect(server.headers[0]?.['cookie']).toBeUndefined();
  });

  it('sets a rule with its reason and says whether it changed', async () => {
    const seen: unknown[] = [];
    const server = await grpcServer((router) =>
      router.service(ApprovalRuleService, {
        setApprovalRule: (req) => {
          seen.push({ scope: req.scope, rule: req.rule, reason: req.reason });
          return { setting: { scope: req.scope, rule: req.rule, setAt: timestampFromDate(NOV_3) }, changed: true };
        },
      }),
    );
    const api = grpcOfficer({ baseUrl: server.url, timeoutMs: 2000 }, () => {});
    expect(await api.setApprovalRule(OFFICER, { scope: 'redaction_policy', rule: 'one_approver', reason: 'away' })).toEqual({ changed: true });
    expect(seen).toEqual([{ scope: ApprovalScope.REDACTION_POLICY, rule: ApprovalRule.ONE_APPROVER, reason: 'away' }]);
    expect(server.headers[0]?.['authorization']).toBe('Bearer officer.tok-en');
  });

  it('asks to sign in again when the API refuses the token, and logs the call and code only', async () => {
    const server = await grpcServer((router) =>
      router.service(ApprovalRuleService, {
        getApprovalRules: () => {
          throw new ConnectError('token expired for officer.tok-en', Code.Unauthenticated);
        },
        setApprovalRule: () => {
          throw new ConnectError('token expired', Code.Unauthenticated);
        },
      }),
    );
    const lines: string[] = [];
    const api = grpcOfficer({ baseUrl: server.url, timeoutMs: 2000 }, (line) => lines.push(line));
    await expect(api.getApprovalRules(OFFICER)).rejects.toBeInstanceOf(OfficerSignInAgain);
    await expect(api.setApprovalRule(OFFICER, { scope: 'content', rule: 'one_approver', reason: SECRET_REASON })).rejects.toBeInstanceOf(OfficerSignInAgain);
    expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual([
      { level: 'warn', msg: 'api refused the token', rpc: 'GetApprovalRules', code: 'unauthenticated' },
      { level: 'warn', msg: 'api refused the token', rpc: 'SetApprovalRule', code: 'unauthenticated' },
    ]);
    expect(lines.join('\n')).not.toMatch(/tok-en|expired|reason-not/);
  });

  it('makes any other refusal or failure unavailable', async () => {
    const server = await grpcServer((router) =>
      router.service(ApprovalRuleService, {
        getApprovalRules: () => {
          throw new ConnectError('not permitted', Code.PermissionDenied);
        },
        setApprovalRule: () => {
          throw new ConnectError('bad', Code.InvalidArgument);
        },
      }),
    );
    const lines: string[] = [];
    const api = grpcOfficer({ baseUrl: server.url, timeoutMs: 2000 }, (line) => lines.push(line));
    await expect(api.getApprovalRules(OFFICER)).rejects.toBeInstanceOf(ApiUnavailable);
    await expect(api.setApprovalRule(OFFICER, { scope: 'content', rule: 'two_person', reason: 'x' })).rejects.toBeInstanceOf(ApiUnavailable);
    expect(lines.map((l) => (JSON.parse(l) as { code: string }).code)).toEqual(['permission_denied', 'invalid_argument']);
  });

  it('refuses an answer it cannot read: an unset scope or rule, or no setting back', async () => {
    const server = await grpcServer((router) =>
      router.service(ApprovalRuleService, {
        getApprovalRules: () => ({ settings: [{ scope: ApprovalScope.CONTENT, rule: ApprovalRule.UNSPECIFIED }] }),
        setApprovalRule: () => ({ changed: true }),
      }),
    );
    const api = grpcOfficer({ baseUrl: server.url, timeoutMs: 2000 }, () => {});
    await expect(api.getApprovalRules(OFFICER)).rejects.toBeInstanceOf(ApiUnavailable);
    await expect(api.setApprovalRule(OFFICER, { scope: 'content', rule: 'two_person', reason: 'x' })).rejects.toBeInstanceOf(ApiUnavailable);
  });

  it('never sends a bearer that is not one b64token: it asks to sign in again instead', async () => {
    const server = await grpcServer((router) => router.service(ApprovalRuleService, { getApprovalRules: () => ({ settings: [] }) }));
    const api = grpcOfficer({ baseUrl: server.url, timeoutMs: 2000 }, () => {});
    await expect(api.getApprovalRules({ bearer: 'two words' })).rejects.toBeInstanceOf(OfficerSignInAgain);
    expect(server.headers).toEqual([]);
  });

  it('is unavailable everywhere when the API is set up wrongly', async () => {
    const api = unavailableOfficer();
    await expect(api.getApprovalRules(OFFICER)).rejects.toBeInstanceOf(ApiUnavailable);
    await expect(api.setApprovalRule(OFFICER, { scope: 'content', rule: 'two_person', reason: 'x' })).rejects.toBeInstanceOf(ApiUnavailable);
  });
});

describe('officerFromEnv', () => {
  it('is off without API_URL and in the public-only build, unavailable when set wrongly, on otherwise', () => {
    const lines: string[] = [];
    expect(officerFromEnv({}, { publicOnly: false, log: () => {} })).toBeUndefined();
    expect(officerFromEnv({ API_URL: 'http://127.0.0.1:1' }, { publicOnly: true, log: () => {} })).toBeUndefined();
    expect(officerFromEnv({ API_URL: 'ftp://x' }, { publicOnly: false, log: (l) => lines.push(l) })).toBeDefined();
    expect(lines).toHaveLength(1);
    expect(officerFromEnv({ API_URL: 'http://127.0.0.1:1' }, { publicOnly: false, log: () => {} })).toBeDefined();
  });
});

describe('officerReader', () => {
  const NOW = 1_800_000_000;
  const signedIn = (groups: string[], tokens: Tokens | undefined) => {
    const store = new TokenStore<Tokens>();
    const session = newSession({ sub: '0f8e2c4a-1b3d-4e5f-8a9b-0c1d2e3f4a5b', groups }, NOW - 60);
    if (tokens) store.put(session.sid, tokens, session.exp);
    return { session, deps: { tokens: store, now: () => NOW } };
  };

  it('gives an officer\'s token with more than 30 s to live', () => {
    const { session, deps } = signedIn(['nwfl-members', 'nwfl-officers'], { access_token: 'tok.en', expires_at: NOW + 31 });
    expect(officerReader(session, deps)).toEqual({ reader: { bearer: 'tok.en' }, lapsed: false });
  });

  it('gives nothing to no session, a member, or an officer with no token on the server', () => {
    expect(officerReader(undefined, signedIn([], undefined).deps)).toEqual({ reader: undefined, lapsed: false });
    const member = signedIn(['nwfl-members'], { access_token: 'tok.en', expires_at: NOW + 3600 });
    expect(officerReader(member.session, member.deps)).toEqual({ reader: undefined, lapsed: false });
    const none = signedIn(['nwfl-officers'], undefined);
    expect(officerReader(none.session, none.deps)).toEqual({ reader: undefined, lapsed: true });
    const blank = signedIn(['nwfl-officers'], { access_token: '', expires_at: NOW + 3600 });
    expect(officerReader(blank.session, blank.deps)).toEqual({ reader: undefined, lapsed: true });
  });

  it('says lapsed once the token has 30 s or less to live, or the session has ended', () => {
    const { session, deps } = signedIn(['nwfl-officers'], { access_token: 'tok.en', expires_at: NOW + 30 });
    expect(officerReader(session, deps)).toEqual({ reader: undefined, lapsed: true });
    const ended = signedIn(['nwfl-officers'], { access_token: 'tok.en', expires_at: NOW + 3600 });
    expect(officerReader({ ...ended.session, exp: NOW }, ended.deps)).toEqual({ reader: undefined, lapsed: true });
  });
});
