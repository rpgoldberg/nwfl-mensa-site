// A gRPC port with the two edge services answering at once and no database,
// for the edge admission tests: a fake verifier knows an agent, a verifier and
// a site user by token.
import type { ConnectRouter } from '@connectrpc/connect';
import type http2 from 'node:http2';
import { type TokenVerifier, authInterceptor } from '../../src/auth/caller.js';
import { MembershipVerifierService } from '../../src/gen/nwfl/mensa/v1/membership_verifier_pb.js';
import { NewsletterService } from '../../src/gen/nwfl/mensa/v1/newsletter_pb.js';
import { healthRoutes } from '../../src/grpc/health.js';
import { type GrpcServerOptions, createGrpcServer } from '../../src/grpc/server.js';
import { createReadiness } from '../../src/readiness.js';

export const EDGE = 'cloudflared.nwfl-edge.serviceaccount.identity.linkerd.cluster.local';
export const NEWSLETTER = '/nwfl.mensa.v1.NewsletterService/ListEditions';
export const VERIFIER = '/nwfl.mensa.v1.MembershipVerifierService/ListPendingVerifications';
export const HEALTH = '/grpc.health.v1.Health/Check';

export const edgeVerifier: TokenVerifier = {
  verify: (token) => {
    if (token === 'agent-token') return Promise.resolve({ client: 'agent', subject: 'svc-nwfl-newsletter', groups: [], scopes: ['newsletter.read'] });
    if (token === 'verifier-token') return Promise.resolve({ client: 'verifier', subject: 'svc-nwfl-verifier', groups: [], scopes: ['membership.verify'] });
    if (token === 'site-token') return Promise.resolve({ client: 'site', subject: 'sub-member', groups: ['nwfl-members'], scopes: [] });
    return Promise.reject(new Error('unknown token'));
  },
};

const edgeRoutes = (router: ConnectRouter): void => {
  healthRoutes(createReadiness({ query: () => Promise.resolve({}) }))(router);
  router.service(NewsletterService, { listEditions: () => Promise.resolve({ editions: [] }) });
  router.service(MembershipVerifierService, { listPendingVerifications: () => Promise.resolve({ pending: [] }) });
};

export function createEdgeServer(options: Partial<GrpcServerOptions> = {}): http2.Http2Server {
  return createGrpcServer({
    routes: edgeRoutes,
    interceptors: [authInterceptor({ verifier: edgeVerifier, edgeClientIds: [EDGE] })],
    verifier: edgeVerifier,
    edgeClientIds: [EDGE],
    ...options,
  });
}

/** Headers for a call through the edge as `token` (none: no authorization header). */
export function edgeHeaders(path: string, token?: string, extra: http2.OutgoingHttpHeaders = {}): http2.OutgoingHttpHeaders {
  return {
    ':method': 'POST',
    ':path': path,
    'content-type': 'application/grpc',
    te: 'trailers',
    'l5d-client-id': EDGE,
    ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}
