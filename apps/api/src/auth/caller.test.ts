// The audience comes ONLY from the verified token (P17). No token is PUBLIC; a
// token that does not verify is refused, never downgraded; no header, field or
// group outside nwfl- can raise it.
import { Code, ConnectError, createClient, createRouterTransport } from '@connectrpc/connect';
import { describe, expect, it } from 'vitest';
import { Health, HealthCheckResponse_ServingStatus } from '../gen/grpc/health/v1/health_pb.js';
import { ANONYMOUS, type Caller, type TokenVerifier, audienceFor, authInterceptor, callerOf, rejectAllTokens } from './caller.js';

describe('audienceFor', () => {
  it.each([
    [[], 'public'],
    [['nwfl-pending'], 'public'],
    [['nwfl-members'], 'members'],
    [['nwfl-affiliates'], 'members'],
    [['nwfl-officers'], 'officers'],
    [['nwfl-members', 'nwfl-officers', 'nwfl-office-publications'], 'officers'],
    [['fc-admins', 'members', 'officers', 'NWFL-OFFICERS'], 'public'],
  ])('maps %j to %s', (groups, audience) => {
    expect(audienceFor(groups)).toBe(audience);
  });
});

function harness(verifier: TokenVerifier): { call: (headers?: Record<string, string>) => Promise<Caller> } {
  let seen: Caller | undefined;
  const transport = createRouterTransport(
    ({ service }) => {
      service(Health, {
        check: (_request, ctx) => {
          seen = callerOf(ctx.values);
          return { status: HealthCheckResponse_ServingStatus.SERVING };
        },
      });
    },
    { router: { interceptors: [authInterceptor(verifier)] } },
  );
  const client = createClient(Health, transport);
  return {
    call: async (headers = {}) => {
      seen = undefined;
      await client.check({ service: '' }, { headers });
      return seen as unknown as Caller;
    },
  };
}

const fakeVerifier: TokenVerifier = {
  verify: (token) => {
    if (token === 'member-token') return Promise.resolve({ subject: 'sub-member', groups: ['nwfl-members', 'other-tenant'] });
    if (token === 'officer-token') return Promise.resolve({ subject: 'sub-officer', groups: ['nwfl-members', 'nwfl-officers'] });
    return Promise.reject(new ConnectError('kid unknown: details an attacker should not see', Code.PermissionDenied));
  },
};

describe('authInterceptor', () => {
  const { call } = harness(fakeVerifier);

  it('treats a call with no authorization header as anonymous, audience public', async () => {
    expect(await call()).toEqual(ANONYMOUS);
    expect(ANONYMOUS.audience).toBe('public');
  });

  it('derives the caller from a verified bearer token, keeping only nwfl- groups', async () => {
    expect(await call({ authorization: 'Bearer member-token' })).toEqual({ subject: 'sub-member', groups: ['nwfl-members'], audience: 'members' });
    expect(await call({ authorization: 'bearer officer-token' })).toMatchObject({ subject: 'sub-officer', audience: 'officers' });
  });

  it('refuses a token that does not verify, with no detail, instead of downgrading it to public', async () => {
    const error = await call({ authorization: 'Bearer forged' }).catch((e: unknown) => ConnectError.from(e));
    expect(error).toMatchObject({ code: Code.Unauthenticated, rawMessage: 'invalid token' });
  });

  it.each(['Basic dXNlcjpwYXNz', 'Bearer', 'Bearer ', 'Bearer a b', 'Token member-token', 'Bearer member-token,Bearer officer-token'])(
    'refuses a malformed authorization header: %s',
    async (header) => {
      await expect(call({ authorization: header })).rejects.toMatchObject({ code: Code.Unauthenticated });
    },
  );

  it('ignores every other header: no request header can choose the audience', async () => {
    expect(
      await call({ 'x-audience': 'members', 'x-nwfl-groups': 'nwfl-officers', 'l5d-client-id': 'nwfl-web.nwfl.serviceaccount.identity.linkerd.cluster.local' }),
    ).toEqual(ANONYMOUS);
  });

  it('refuses every token until A3 configures verification', async () => {
    const { call: unconfigured } = harness(rejectAllTokens);
    await expect(unconfigured({ authorization: 'Bearer member-token' })).rejects.toMatchObject({ code: Code.Unauthenticated });
    expect(await unconfigured()).toEqual(ANONYMOUS);
  });
});

describe('callerOf', () => {
  it('fails closed when the interceptor did not run', async () => {
    const transport = createRouterTransport(({ service }) => {
      service(Health, {
        check: (_request, ctx) => {
          callerOf(ctx.values);
          return { status: HealthCheckResponse_ServingStatus.SERVING };
        },
      });
    });
    await expect(createClient(Health, transport).check({ service: '' })).rejects.toMatchObject({ code: Code.Internal });
  });
});
