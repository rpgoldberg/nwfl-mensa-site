// ============================================================================
// THE caller and audience chokepoint (R26, P17, A3). Every handler gets its
// caller from callerOf(), which reads what authInterceptor() put there:
//
//   no authorization header      -> anonymous, audience public
//   a bearer token that verifies -> its client decides the kind of caller:
//     site      a user. Officers by the officers group in the token (its
//               <SITE_GROUP_PREFIX>officers, carried as nwfl-officers: groups.ts);
//               members by member_account (AC6 b: the database, not the
//               token, which a 30-day session can leave stale). A guest
//               member (standing-policy.ts) reads as the public, but events
//               as a member (eventsAudience, read by EventService alone).
//     agent     the newsletter agent (audience members: it builds the issue
//               members receive).
//     verifier  the membership verifier (audience public).
//     linkcheck the link checker (L-ITEM; audience officers: it is handed
//               addresses from officers-only items and members-only
//               passages, never their text). No groups, whatever its token
//               carries.
//   OFFICER-VERIFY (switch OFFICER_VERIFY=on): an officer power needs member
//               standing as well as its group. A holder without standing
//               keeps only the groups that carry no power (groups.ts
//               withholdPower) and reads by its standing (standing-policy.ts:
//               chapter and affiliate hold powers; a guest by the one guest
//               policy; unconfirmed and none never); the powers ride apart
//               in `withheld`, read only for the sign-up route and
//               GetMyAccount. This is the ONE gate: every role check
//               (roles.ts) and every SQL function handed caller.groups (0014,
//               0015, 0016, 0020, 0023) sees no power. Off (the default),
//               everything is as before: the groups pass, and any standing
//               reads at member level, events too (no guest policy).
//   anything else                -> UNAUTHENTICATED, never a quiet downgrade
//   a subject starting system:   -> UNAUTHENTICATED: the database trusts the issue
//                                   loader's subject (system:issue-loader, 0029), and
//                                   no token may carry it (EDITOR A1)
//
// Then each service admits one kind of caller (the design notes, A3):
//   NewsletterService          the agent only
//   MembershipVerifierService  the verifier only
//   LinkCheckService           the link checker only
//   every other service        anonymous and site users only
// A caller of the wrong kind gets PERMISSION_DENIED; no token where one is
// required gets UNAUTHENTICATED.
//
// The mesh identity header l5d-client-id only ever NARROWS: a call that
// arrived through the edge (cloudflared) may reach the agent, verifier and
// link checker services and nothing else. linkerd2-proxy v2.359.0, the proxy of Linkerd
// edge-26.6.3, sets the header from the mTLS peer identity on every inbound
// HTTP request, replacing a client-sent value, and removes it when there is no
// identity (linkerd/app/inbound/src/http/set_identity_header.rs lines 79-85,
// layered in linkerd/app/inbound/src/http/server.rs line 63, tag
// release/v2.359.0 = 8da700cc). That holds only while port 50051 is meshed
// and not opaque, which is why the header grants nothing: token checks stand
// on their own, and the mesh policy is the first line.
// ============================================================================
import { Code, ConnectError, type ContextValues, type Interceptor, createContextKey } from '@connectrpc/connect';
import { DEFAULT_SITE_GROUP_PREFIX, internalGroups, withholdPower } from './groups.js';
import { type StandingKind, holdsOfficerPower, readsAsMember, readsEventsAsMember } from './standing-policy.js';

export type Audience = 'public' | 'members' | 'officers';
export type ClientKind = 'site' | 'agent' | 'verifier' | 'linkcheck';
export type CallerKind = 'anonymous' | 'user' | 'agent' | 'verifier' | 'linkcheck';

export interface VerifiedToken {
  client: ClientKind;
  subject: string;
  groups: readonly string[];
  scopes: readonly string[];
  /** A site token's name and email claims (Authentik's profile and email scopes), for the sign-up only. */
  name?: string;
  email?: string;
}

/** Resolves only for a token it has verified; rejects otherwise. */
export interface TokenVerifier {
  verify(token: string): Promise<VerifiedToken>;
}

/** A subject's standing from member_account (standing.ts); what each kind allows is standing-policy.ts. */
export interface MemberStanding {
  standingOf(subject: string): Promise<StandingKind>;
}

export interface Caller {
  kind: CallerKind;
  subject: string | null;
  /** The token's groups under the chapter's prefix, by their internal nwfl- names (groups.ts); empty for machine callers. */
  groups: readonly string[];
  /** OFFICER-VERIFY: the power groups withheld for want of member standing; absent when none are. */
  withheld?: readonly string[];
  scopes: readonly string[];
  audience: Audience;
  /** OFFICER-VERIFY: the audience for events, when it differs from `audience` (a guest member: standing-policy.ts). */
  eventsAudience?: Audience;
  /** A site user's name and email, as their token carries them; never a machine caller's. */
  name?: string;
  email?: string;
}

export const ANONYMOUS: Caller = Object.freeze({ kind: 'anonymous', subject: null, groups: Object.freeze([]), scopes: Object.freeze([]), audience: 'public' });

export const AGENT_SERVICE = 'nwfl.mensa.v1.NewsletterService';
export const VERIFIER_SERVICE = 'nwfl.mensa.v1.MembershipVerifierService';
export const LINKCHECK_SERVICE = 'nwfl.mensa.v1.LinkCheckService';
/** The one service each machine client may call, and no other caller may. */
export const MACHINE_SERVICES: Readonly<Record<'agent' | 'verifier' | 'linkcheck', string>> = Object.freeze({
  agent: AGENT_SERVICE,
  verifier: VERIFIER_SERVICE,
  linkcheck: LINKCHECK_SERVICE,
});
const EDGE_SERVICES = new Set(Object.values(MACHINE_SERVICES));
export const DEFAULT_EDGE_CLIENT_IDS: readonly string[] = ['cloudflared.nwfl-edge.serviceaccount.identity.linkerd.cluster.local'];

/**
 * Whether an l5d-client-id value names an edge identity. Compared without
 * case, and any entry of a list counts: the header only ever narrows, so
 * reading more values as the edge can only refuse more.
 */
export function isEdgePeer(header: string | readonly string[] | null | undefined, edge: ReadonlySet<string>): boolean {
  if (header === null || header === undefined) return false;
  const lower = new Set([...edge].map((id) => id.toLowerCase()));
  return (typeof header === 'string' ? [header] : header).some((value) => value.split(',').some((id) => lower.has(id.trim().toLowerCase())));
}

export function audienceFor(groups: readonly string[], member: boolean): Audience {
  if (groups.includes('nwfl-officers')) return 'officers';
  return member ? 'members' : 'public';
}

export const rejectAllTokens: TokenVerifier = {
  verify: () => Promise.reject(new ConnectError('token verification is not configured', Code.Unauthenticated)),
};

export const noStanding: MemberStanding = { standingOf: () => Promise.resolve('none') };

/** The prefix of the subjects the API writes as itself (load.ts LOADER); never a token's. */
export const SYSTEM_SUBJECT = 'system:';

const CALLER = createContextKey<Caller | undefined>(undefined, { description: 'the verified caller' });

// RFC 6750 b64token, exactly one, after a case-insensitive "Bearer".
const BEARER = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i;

export interface AuthOptions {
  verifier: TokenVerifier;
  standing?: MemberStanding;
  /** Mesh identities of the edge (cloudflared). */
  edgeClientIds?: readonly string[];
  /** The chapter's group prefix (SITE_GROUP_PREFIX, groups.ts); default nwfl-. */
  groupPrefix?: string;
  /** OFFICER_VERIFY (auth/config.ts): whether an officer power needs member standing too; default off. */
  officerVerify?: boolean;
}

async function establish(header: string | null, verifier: TokenVerifier, standing: MemberStanding, groupPrefix: string, officerVerify: boolean): Promise<Caller> {
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
  // Compared without case: no variant of a system subject reads as a person.
  if (verified.subject.toLowerCase().startsWith(SYSTEM_SUBJECT)) throw new ConnectError('invalid token', Code.Unauthenticated);
  const scopes = [...verified.scopes];
  if (verified.client === 'agent') return { kind: 'agent', subject: verified.subject, groups: [], scopes, audience: 'members' };
  if (verified.client === 'verifier') return { kind: 'verifier', subject: verified.subject, groups: [], scopes, audience: 'public' };
  if (verified.client === 'linkcheck') return { kind: 'linkcheck', subject: verified.subject, groups: [], scopes, audience: 'officers' };
  const kind = await standing.standingOf(verified.subject);
  // Switched off, as before: any standing reads at member level (there is no guest), and no power waits.
  const member = officerVerify ? readsAsMember(kind) : kind !== 'none';
  const all = internalGroups(verified.groups, groupPrefix);
  const { kept: groups, withheld } = officerVerify && !holdsOfficerPower(kind) ? withholdPower(all) : { kept: all, withheld: [] };
  const audience = audienceFor(groups, member);
  const eventsAudience = officerVerify ? audienceFor(groups, readsEventsAsMember(kind)) : audience;
  return {
    kind: 'user',
    subject: verified.subject,
    groups,
    ...(withheld.length > 0 ? { withheld } : {}),
    scopes,
    audience,
    ...(eventsAudience !== audience ? { eventsAudience } : {}),
    ...(verified.name !== undefined ? { name: verified.name } : {}),
    ...(verified.email !== undefined ? { email: verified.email } : {}),
  };
}

function admit(service: string, caller: Caller): void {
  const required = (Object.keys(MACHINE_SERVICES) as Array<keyof typeof MACHINE_SERVICES>).find((kind) => MACHINE_SERVICES[kind] === service);
  if (required === undefined) {
    if (caller.kind !== 'anonymous' && caller.kind !== 'user') throw new ConnectError('this client may not call this service', Code.PermissionDenied);
    return;
  }
  if (caller.kind === 'anonymous') throw new ConnectError('a token is required', Code.Unauthenticated);
  if (caller.kind !== required) throw new ConnectError('this client may not call this service', Code.PermissionDenied);
}

export function authInterceptor(options: AuthOptions): Interceptor {
  const standing = options.standing ?? noStanding;
  const edge = new Set(options.edgeClientIds ?? DEFAULT_EDGE_CLIENT_IDS);
  const groupPrefix = options.groupPrefix ?? DEFAULT_SITE_GROUP_PREFIX;
  const officerVerify = options.officerVerify === true;
  return (next) => async (req) => {
    const service = req.service.typeName;
    const peer = req.header.get('l5d-client-id');
    // One identity or none: the proxy replaces the header, so a list means it did not.
    if (peer !== null && (peer.includes(',') || (isEdgePeer(peer, edge) && !EDGE_SERVICES.has(service)))) {
      throw new ConnectError('not served on this path', Code.PermissionDenied);
    }
    const caller = await establish(req.header.get('authorization'), options.verifier, standing, groupPrefix, officerVerify);
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
