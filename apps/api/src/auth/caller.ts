// ============================================================================
// THE audience chokepoint (R26, P17). Every read handler gets its audience from
// callerOf(), which reads what authInterceptor() put there, which comes from a
// VERIFIED token and nothing else:
//
//   no authorization header       -> anonymous, audience public
//   a bearer token that verifies  -> its nwfl- groups decide the audience
//   anything else                 -> UNAUTHENTICATED, never a quiet downgrade
//
// No request field and no other header is read. The token's groups are
// filtered to nwfl- before use, so a group from another tenant on the shared
// Authentik instance can never count.
//
// The TokenVerifier is a seam: A3 supplies the JWKS verifier and the member
// status check against member_account (AC6 b). Until then rejectAllTokens
// refuses every presented token, so the service is public-only.
// ============================================================================
import { Code, ConnectError, type ContextValues, type Interceptor, createContextKey } from '@connectrpc/connect';

export type Audience = 'public' | 'members' | 'officers';

export interface VerifiedToken {
  subject: string;
  groups: readonly string[];
}

/** Resolves only for a token it has verified; rejects otherwise. */
export interface TokenVerifier {
  verify(token: string): Promise<VerifiedToken>;
}

export interface Caller {
  subject: string | null;
  groups: readonly string[];
  audience: Audience;
}

export const ANONYMOUS: Caller = Object.freeze({ subject: null, groups: Object.freeze([]), audience: 'public' });

const OFFICER_GROUPS = new Set(['nwfl-officers']);
// Affiliates (the RVC) read at member level by explicit grant (R33).
const MEMBER_GROUPS = new Set(['nwfl-members', 'nwfl-affiliates']);

export function audienceFor(groups: readonly string[]): Audience {
  if (groups.some((group) => OFFICER_GROUPS.has(group))) return 'officers';
  if (groups.some((group) => MEMBER_GROUPS.has(group))) return 'members';
  return 'public';
}

export const rejectAllTokens: TokenVerifier = {
  verify: () => Promise.reject(new ConnectError('token verification is not configured', Code.Unauthenticated)),
};

const CALLER = createContextKey<Caller | undefined>(undefined, { description: 'the verified caller' });

// RFC 6750 b64token, exactly one, after a case-insensitive "Bearer".
const BEARER = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i;

export function authInterceptor(verifier: TokenVerifier): Interceptor {
  return (next) => async (req) => {
    const header = req.header.get('authorization');
    if (header === null) {
      req.contextValues.set(CALLER, ANONYMOUS);
      return next(req);
    }
    const token = BEARER.exec(header)?.[1];
    if (token === undefined) throw new ConnectError('malformed authorization header', Code.Unauthenticated);
    let verified: VerifiedToken;
    try {
      verified = await verifier.verify(token);
    } catch {
      // The verifier's reason (a kid, an issuer, a clock) stays on this side.
      throw new ConnectError('invalid token', Code.Unauthenticated);
    }
    const groups = verified.groups.filter((group) => group.startsWith('nwfl-'));
    req.contextValues.set(CALLER, { subject: verified.subject, groups, audience: audienceFor(groups) });
    return next(req);
  };
}

/** The caller of this RPC. Throws INTERNAL if the interceptor did not run: no caller, no answer. */
export function callerOf(values: ContextValues): Caller {
  const caller = values.get(CALLER);
  if (caller === undefined) throw new ConnectError('caller not established', Code.Internal);
  return caller;
}
