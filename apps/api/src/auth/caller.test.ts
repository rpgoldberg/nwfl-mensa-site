// The caller and the audience come ONLY from the verified token (P17), plus,
// for members, the account's standing in member_account (AC6 b: the database,
// not the token, which can be a month stale). No token is PUBLIC; a token that
// does not verify is refused, never downgraded; no header or field raises it.
// Each service has one kind of caller: the agent reaches only NewsletterService,
// the verifier only MembershipVerifierService, and site callers neither.
import { Code, ConnectError, createClient, createRouterTransport } from '@connectrpc/connect';
import { describe, expect, it } from 'vitest';
import { Health, HealthCheckResponse_ServingStatus } from '../gen/grpc/health/v1/health_pb.js';
import { EventService } from '../gen/nwfl/mensa/v1/event_pb.js';
import { MembershipVerifierService } from '../gen/nwfl/mensa/v1/membership_verifier_pb.js';
import { NewsletterService } from '../gen/nwfl/mensa/v1/newsletter_pb.js';
import {
  ANONYMOUS,
  type Caller,
  DEFAULT_EDGE_CLIENT_IDS,
  type MemberStanding,
  type TokenVerifier,
  audienceFor,
  authInterceptor,
  callerOf,
  isEdgePeer,
  noStanding,
  rejectAllTokens,
} from './caller.js';

describe('audienceFor', () => {
  it.each([
    [[], false, 'public'],
    [['nwfl-pending'], false, 'public'],
    [['nwfl-members'], false, 'public'],
    [['nwfl-affiliates'], false, 'public'],
    [[], true, 'members'],
    [['nwfl-officers'], false, 'officers'],
    [['nwfl-members', 'nwfl-officers', 'nwfl-office-publications'], true, 'officers'],
    [['fc-admins', 'members', 'officers', 'NWFL-OFFICERS'], false, 'public'],
  ])('maps groups %j with standing %s to %s', (groups, member, audience) => {
    expect(audienceFor(groups, member)).toBe(audience);
  });
});

const EDGE = DEFAULT_EDGE_CLIENT_IDS[0] as string;
const WEB = 'nwfl-web.nwfl.serviceaccount.identity.linkerd.cluster.local';

const fakeVerifier: TokenVerifier = {
  verify: (token) => {
    if (token === 'member-token') return Promise.resolve({ client: 'site', subject: 'sub-member', groups: ['nwfl-members', 'other-tenant'], scopes: [] });
    if (token === 'lapsed-token') return Promise.resolve({ client: 'site', subject: 'sub-lapsed', groups: ['nwfl-members'], scopes: [] });
    if (token === 'named-token') return Promise.resolve({ client: 'site', subject: 'sub-named', groups: [], scopes: [], name: 'Pat Example', email: 'pat@example.org' });
    if (token === 'officer-token') return Promise.resolve({ client: 'site', subject: 'sub-officer', groups: ['nwfl-members', 'nwfl-officers'], scopes: [] });
    if (token === 'agent-token') return Promise.resolve({ client: 'agent', subject: 'svc-nwfl-newsletter', groups: [], scopes: ['newsletter.read'] });
    if (token === 'verifier-token') return Promise.resolve({ client: 'verifier', subject: 'svc-nwfl-verifier', groups: [], scopes: ['membership.verify'] });
    return Promise.reject(new ConnectError('kid unknown: details an attacker should not see', Code.PermissionDenied));
  },
};
const standing: MemberStanding = { isMember: (subject) => Promise.resolve(subject === 'sub-member') };

function harness(verifier: TokenVerifier = fakeVerifier, memberStanding: MemberStanding = standing) {
  let seen: Caller | undefined;
  const record = (values: Parameters<typeof callerOf>[0]): void => {
    seen = callerOf(values);
  };
  const transport = createRouterTransport(
    ({ service }) => {
      service(Health, {
        check: (_request, ctx) => {
          record(ctx.values);
          return { status: HealthCheckResponse_ServingStatus.SERVING };
        },
      });
      service(EventService, {
        listVenues: (_request, ctx) => {
          record(ctx.values);
          return { venues: [] };
        },
      });
      service(NewsletterService, {
        listEditions: (_request, ctx) => {
          record(ctx.values);
          return { editions: [] };
        },
      });
      service(MembershipVerifierService, {
        listPendingVerifications: (_request, ctx) => {
          record(ctx.values);
          return { pending: [] };
        },
      });
    },
    { router: { interceptors: [authInterceptor({ verifier, standing: memberStanding })] } },
  );
  const as = (headers: Record<string, string>) => ({ headers });
  const capture = async (call: () => Promise<unknown>): Promise<Caller> => {
    seen = undefined;
    await call();
    return seen as unknown as Caller;
  };
  return {
    health: (headers: Record<string, string> = {}) => capture(() => createClient(Health, transport).check({ service: '' }, as(headers))),
    events: (headers: Record<string, string> = {}) => capture(() => createClient(EventService, transport).listVenues({}, as(headers))),
    newsletter: (headers: Record<string, string> = {}) => capture(() => createClient(NewsletterService, transport).listEditions({}, as(headers))),
    verifier: (headers: Record<string, string> = {}) =>
      capture(() => createClient(MembershipVerifierService, transport).listPendingVerifications({}, as(headers))),
  };
}

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

describe('authInterceptor: who is calling', () => {
  const api = harness();

  it('treats a call with no authorization header as anonymous, audience public', async () => {
    expect(await api.events()).toEqual(ANONYMOUS);
    expect(ANONYMOUS).toMatchObject({ kind: 'anonymous', audience: 'public' });
  });

  it('makes a site caller a member only when member_account says so, whatever the token groups say', async () => {
    expect(await api.events(bearer('member-token'))).toEqual({ kind: 'user', subject: 'sub-member', groups: ['nwfl-members'], scopes: [], audience: 'members' });
    expect(await api.events(bearer('lapsed-token'))).toMatchObject({ kind: 'user', audience: 'public' });
  });

  it('carries a site caller’s name and email from the token, and a machine caller has none', async () => {
    expect(await api.events(bearer('named-token'))).toMatchObject({ kind: 'user', subject: 'sub-named', name: 'Pat Example', email: 'pat@example.org' });
    expect(await api.newsletter(bearer('agent-token'))).not.toHaveProperty('email');
  });

  it('makes a site caller an officer from the nwfl-officers group', async () => {
    expect(await api.events({ authorization: 'bearer officer-token' })).toMatchObject({ kind: 'user', subject: 'sub-officer', audience: 'officers' });
  });

  it('identifies the agent and the verifier as machine callers', async () => {
    expect(await api.newsletter(bearer('agent-token'))).toEqual({ kind: 'agent', subject: 'svc-nwfl-newsletter', groups: [], scopes: ['newsletter.read'], audience: 'members' });
    expect(await api.verifier(bearer('verifier-token'))).toMatchObject({ kind: 'verifier', audience: 'public' });
  });

  it('refuses a token that does not verify, with no detail, instead of downgrading it to public', async () => {
    const error = await api.events(bearer('forged')).catch((e: unknown) => ConnectError.from(e));
    expect(error).toMatchObject({ code: Code.Unauthenticated, rawMessage: 'invalid token' });
  });

  it.each(['Basic dXNlcjpwYXNz', 'Bearer', 'Bearer ', 'Bearer a b', 'Token member-token', 'Bearer member-token,Bearer officer-token'])(
    'refuses a malformed authorization header: %s',
    async (header) => {
      await expect(api.events({ authorization: header })).rejects.toMatchObject({ code: Code.Unauthenticated });
    },
  );

  it('ignores every other header: no request header can choose the audience', async () => {
    expect(await api.events({ 'x-audience': 'members', 'x-nwfl-groups': 'nwfl-officers', 'l5d-client-id': WEB })).toEqual(ANONYMOUS);
  });

  it('refuses every token when verification is not configured, and makes nobody a member without a standing lookup', async () => {
    const unconfigured = harness(rejectAllTokens);
    await expect(unconfigured.events(bearer('member-token'))).rejects.toMatchObject({ code: Code.Unauthenticated });
    expect(await unconfigured.events()).toEqual(ANONYMOUS);
    expect(await harness(fakeVerifier, noStanding).events(bearer('member-token'))).toMatchObject({ audience: 'public' });
  });
});

describe('authInterceptor: one kind of caller per service', () => {
  const api = harness();

  it('admits only the agent to NewsletterService', async () => {
    await expect(api.newsletter()).rejects.toMatchObject({ code: Code.Unauthenticated });
    await expect(api.newsletter(bearer('officer-token'))).rejects.toMatchObject({ code: Code.PermissionDenied });
    await expect(api.newsletter(bearer('verifier-token'))).rejects.toMatchObject({ code: Code.PermissionDenied });
    expect((await api.newsletter(bearer('agent-token'))).kind).toBe('agent');
  });

  it('admits only the verifier to MembershipVerifierService', async () => {
    await expect(api.verifier()).rejects.toMatchObject({ code: Code.Unauthenticated });
    await expect(api.verifier(bearer('member-token'))).rejects.toMatchObject({ code: Code.PermissionDenied });
    await expect(api.verifier(bearer('agent-token'))).rejects.toMatchObject({ code: Code.PermissionDenied });
    expect((await api.verifier(bearer('verifier-token'))).kind).toBe('verifier');
  });

  it('refuses the agent and the verifier everywhere else, health included', async () => {
    for (const token of ['agent-token', 'verifier-token']) {
      await expect(api.events(bearer(token))).rejects.toMatchObject({ code: Code.PermissionDenied });
      await expect(api.health(bearer(token))).rejects.toMatchObject({ code: Code.PermissionDenied });
    }
    expect((await api.events(bearer('member-token'))).kind).toBe('user');
  });
});

describe('authInterceptor: the mesh identity (l5d-client-id) only ever narrows', () => {
  // linkerd2-proxy v2.359.0 (the proxy of Linkerd edge-26.6.3) sets this header
  // on every inbound HTTP request from the mTLS peer identity, replacing any
  // value the client sent, and removes it when there is none
  // (linkerd/app/inbound/src/http/set_identity_header.rs lines 79-85, applied
  // in linkerd/app/inbound/src/http/server.rs line 63). The API still never
  // lets it GRANT anything: it only restricts the edge path.
  const api = harness();

  it('limits a call that arrived through the edge to the agent and verifier services', async () => {
    await expect(api.events({ ...bearer('officer-token'), 'l5d-client-id': EDGE })).rejects.toMatchObject({ code: Code.PermissionDenied });
    await expect(api.events({ 'l5d-client-id': EDGE })).rejects.toMatchObject({ code: Code.PermissionDenied });
    await expect(api.health({ 'l5d-client-id': EDGE })).rejects.toMatchObject({ code: Code.PermissionDenied });
    expect((await api.newsletter({ ...bearer('agent-token'), 'l5d-client-id': EDGE })).kind).toBe('agent');
    expect((await api.verifier({ ...bearer('verifier-token'), 'l5d-client-id': EDGE })).kind).toBe('verifier');
  });

  it('gives a forged web identity nothing: the agent still cannot reach EventService, and an anonymous call stays public', async () => {
    await expect(api.events({ ...bearer('agent-token'), 'l5d-client-id': WEB })).rejects.toMatchObject({ code: Code.PermissionDenied });
    expect(await api.events({ 'l5d-client-id': WEB })).toEqual(ANONYMOUS);
    await expect(api.newsletter({ ...bearer('member-token'), 'l5d-client-id': WEB })).rejects.toMatchObject({ code: Code.PermissionDenied });
  });

  it('reads the edge identity without regard to case, so a case variant is narrowed too', async () => {
    await expect(api.events({ 'l5d-client-id': EDGE.toUpperCase() })).rejects.toMatchObject({ code: Code.PermissionDenied });
    expect((await api.newsletter({ ...bearer('agent-token'), 'l5d-client-id': EDGE.toUpperCase() })).kind).toBe('agent');
  });

  it('reads a header given as several values, and no header as no edge', () => {
    const edge = new Set([EDGE]);
    expect(isEdgePeer([WEB, EDGE.toUpperCase()], edge)).toBe(true);
    expect(isEdgePeer([WEB], edge)).toBe(false);
    expect(isEdgePeer(undefined, edge)).toBe(false);
    expect(isEdgePeer(null, edge)).toBe(false);
  });

  it('refuses a header carrying several identities, which the proxy never sends', async () => {
    await expect(api.newsletter({ ...bearer('agent-token'), 'l5d-client-id': `${WEB}, ${EDGE}` })).rejects.toMatchObject({ code: Code.PermissionDenied });
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
