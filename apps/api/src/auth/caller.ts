// ============================================================================
// THE caller and audience chokepoint (R26, P17, A3). Every handler gets its
// caller from callerOf(), which reads what authInterceptor() put there:
//
//   no authorization header      -> anonymous, audience public
//   a bearer token that verifies -> its client decides the kind of caller:
//     site      a user. Officers by the nwfl-officers group in the token;
//               members by member_account (AC6 b: the database, not the
//               token, which a 30-day session can leave stale).
//     agent     the newsletter agent (audience members: it builds the issue
//               members receive).
//     verifier  the membership verifier (audience public).
//   anything else                -> UNAUTHENTICATED, never a quiet downgrade
//
// Then each service admits one kind of caller (the design notes, A3):
//   NewsletterService          the agent only
//   MembershipVerifierService  the verifier only
//   every other service        anonymous and site users only
// A caller of the wrong kind gets PERMISSION_DENIED; no token where one is
// required gets UNAUTHENTICATED.
//
// The mesh identity header l5d-client-id only ever NARROWS: a call that
// arrived through the edge (cloudflared) may reach the agent and verifier
// services and nothing else. linkerd2-proxy v2.359.0, the proxy of Linkerd
// edge-26.6.3, sets the header from the mTLS peer identity on every inbound
// HTTP request, replacing a client-sent value, and removes it when there is no
// identity (linkerd/app/inbound/src/http/set_identity_header.rs lines 79-85,
// layered in linkerd/app/inbound/src/http/server.rs line 63, tag
// release/v2.359.0 = 8da700cc). That holds only while port 50051 is meshed
// and not opaque, which is why the header grants nothing: token checks stand
// on their own, and the mesh policy is the first line.
// ============================================================================
import { Code, ConnectError, type ContextValues, type Interceptor, createContextKey } from '@connectrpc/connect';

export type Audience = 'public' | 'members' | 'officers';
export type ClientKind = 'site' | 'agent' | 'verifier';
export type CallerKind = 'anonymous' | 'user' | 'agent' | 'verifier';

export interface VerifiedToken {
  client: ClientKind;
  subject: string;
  groups: readonly string[];
  scopes: readonly string[];
}

/** Resolves only for a token it has verified; rejects otherwise. */
export interface TokenVerifier {
  verify(token: string): Promise<VerifiedToken>;
}

/** Whether a subject's member_account gives member-level reading. */
export interface MemberStanding {
  isMember(subject: string): Promise<boolean>;
}

export interface Caller {
  kind: CallerKind;
  subject: string | null;
  /** The token's nwfl- groups; empty for machine callers. */
  groups: readonly string[];
  scopes: readonly string[];
  audience: Audience;
}

export const ANONYMOUS: Caller = Object.freeze({ kind: 'anonymous', subject: null, groups: Object.freeze([]), scopes: Object.freeze([]), audience: 'public' });

export const AGENT_SERVICE = 'nwfl.mensa.v1.NewsletterService';
export const VERIFIER_SERVICE = 'nwfl.mensa.v1.MembershipVerifierService';
const EDGE_SERVICES = new Set([AGENT_SERVICE, VERIFIER_SERVICE]);
export const DEFAULT_EDGE_CLIENT_IDS: readonly string[] = ['cloudflared.nwfl-edge.serviceaccount.identity.linkerd.cluster.local'];

export function audienceFor(groups: readonly string[], member: boolean): Audience {
  if (groups.includes('nwfl-officers')) return 'officers';
  return member ? 'members' : 'public';
}

export const rejectAllTokens: TokenVerifier = {
  verify: () => Promise.reject(new ConnectError('token verification is not configured', Code.Unauthenticated)),
};

export const noStanding: MemberStanding = { isMember: () => Promise.resolve(false) };

const CALLER = createContextKey<Caller | undefined>(undefined, { description: 'the verified caller' });

// RFC 6750 b64token, exactly one, after a case-insensitive "Bearer".
const BEARER = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i;

export interface AuthOptions {
  verifier: TokenVerifier;
  standing?: MemberStanding;
  /** Mesh identities of the edge (cloudflared). */
  edgeClientIds?: readonly string[];
}

async function establish(header: string | null, verifier: TokenVerifier, standing: MemberStanding): Promise<Caller> {
  if (header === null) return ANONYMOUS;
  const token = BEARER.exec(header)?.[1];
  if (token === undefined) throw new ConnectError('malformed authorization header', Code.Unauthenticated);
  let verified: VerifiedToken;
  try {
    verified = await verifier.verify(token);
  } catch {
    // The verifier's reason (a kid, an issuer, a clock) stays on this side.
    throw new ConnectError('invalid token', Code.Unauthenticated);
  }
  const scopes = [...verified.scopes];
  if (verified.client === 'agent') return { kind: 'agent', subject: verified.subject, groups: [], scopes, audience: 'members' };
  if (verified.client === 'verifier') return { kind: 'verifier', subject: verified.subject, groups: [], scopes, audience: 'public' };
  const groups = verified.groups.filter((group) => group.startsWith('nwfl-'));
  const member = await standing.isMember(verified.subject);
  return { kind: 'user', subject: verified.subject, groups, scopes, audience: audienceFor(groups, member) };
}

function admit(service: string, caller: Caller): void {
  const required = service === AGENT_SERVICE ? 'agent' : service === VERIFIER_SERVICE ? 'verifier' : undefined;
  if (required === undefined) {
    if (caller.kind === 'agent' || caller.kind === 'verifier') throw new ConnectError('this client may not call this service', Code.PermissionDenied);
    return;
  }
  if (caller.kind === 'anonymous') throw new ConnectError('a token is required', Code.Unauthenticated);
  if (caller.kind !== required) throw new ConnectError('this client may not call this service', Code.PermissionDenied);
}

export function authInterceptor(options: AuthOptions): Interceptor {
  const standing = options.standing ?? noStanding;
  const edge = new Set(options.edgeClientIds ?? DEFAULT_EDGE_CLIENT_IDS);
  return (next) => async (req) => {
    const service = req.service.typeName;
    const peer = req.header.get('l5d-client-id');
    // One identity or none: the proxy replaces the header, so a list means it did not.
    if (peer !== null && (peer.includes(',') || (edge.has(peer) && !EDGE_SERVICES.has(service)))) {
      throw new ConnectError('not served on this path', Code.PermissionDenied);
    }
    const caller = await establish(req.header.get('authorization'), options.verifier, standing);
    admit(service, caller);
    req.contextValues.set(CALLER, caller);
    return next(req);
  };
}

/** The caller of this RPC. Throws INTERNAL if the interceptor did not run: no caller, no answer. */
export function callerOf(values: ContextValues): Caller {
  const caller = values.get(CALLER);
  if (caller === undefined) throw new ConnectError('caller not established', Code.Internal);
  return caller;
}
