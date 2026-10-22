// ============================================================================
// Bearer-token verification (A3), with jose against each client's JWKS.
//
// Three clients, each configured with its own issuer, audience and key set
// (Authentik gives every provider its own issuer and JWKS unless the issuer
// mode is global; selection works either way):
//
//   site      nwfl-site: a user's token forwarded by the BFF. Groups count.
//   agent     nwfl-agent: the newsletter agent's client-credentials token.
//             Needs its scope and its service-account subject. No groups.
//   verifier  nwfl-verifier: the membership verifier, likewise.
//
// A token is matched to exactly one client by its (unverified) issuer and
// audience, then verified for real against that client only: signature by a
// key in that client's set, an allowed algorithm (RS256, ES256; never none or
// HMAC), the issuer, the audience, a subject, an issue time and an expiry. A
// token's lifetime (exp - iat), and its age, is at most MAX_LIFETIME_SECONDS
// for its kind: 1 h for a site token, 24 h for a machine token, so a leaked
// token cannot be minted to last for years. A token naming two of our
// audiences is refused, so one token never works for two clients.
// The reason a token fails is never returned to the caller (auth/caller.ts).
// ============================================================================
import { type JWTPayload, type JWTVerifyGetKey, decodeJwt, jwtVerify } from 'jose';
import type { ClientKind, TokenVerifier, VerifiedToken } from './caller.js';

export type { ClientKind } from './caller.js';

export interface ClientConfig {
  kind: ClientKind;
  issuer: string;
  audience: string;
  jwks: JWTVerifyGetKey;
  /** A scope the token must carry (agent, verifier). */
  scope?: string;
  /** The subject the token must have (the service account of a machine client). */
  subject?: string;
}

export const ALGORITHMS = ['RS256', 'ES256'];
const CLOCK_TOLERANCE_SECONDS = 30;
export const MAX_LIFETIME_SECONDS: Record<ClientKind, number> = { site: 3600, agent: 86_400, verifier: 86_400 };

class TokenRefused extends Error {
  override name = 'TokenRefused';
}

const audiences = (payload: JWTPayload): string[] => (Array.isArray(payload.aud) ? payload.aud : payload.aud === undefined ? [] : [payload.aud]);

export function createJwtVerifier(clients: ClientConfig[]): TokenVerifier {
  const ours = new Set(clients.map((client) => client.audience));
  return {
    verify: async (token: string): Promise<VerifiedToken> => {
      const claimed = decodeJwt(token);
      const named = audiences(claimed).filter((aud) => ours.has(aud));
      if (named.length !== 1) throw new TokenRefused('token must name exactly one of our audiences');
      const client = clients.find((candidate) => candidate.issuer === claimed.iss && candidate.audience === named[0]);
      if (client === undefined) throw new TokenRefused('no client for this issuer and audience');

      const { payload } = await jwtVerify(token, client.jwks, {
        issuer: client.issuer,
        audience: client.audience,
        algorithms: ALGORITHMS,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        requiredClaims: ['exp', 'sub', 'iat'],
        // Requires iat, refuses one in the future, and bounds the age since it.
        maxTokenAge: MAX_LIFETIME_SECONDS[client.kind],
      });
      if ((payload.exp as number) - (payload.iat as number) > MAX_LIFETIME_SECONDS[client.kind]) throw new TokenRefused('token lifetime is too long');
      const subject = payload.sub as string;
      if (client.subject !== undefined && subject !== client.subject) throw new TokenRefused('unexpected subject');
      const scopes = typeof payload['scope'] === 'string' ? payload['scope'].split(' ').filter((scope) => scope !== '') : [];
      if (client.scope !== undefined && !scopes.includes(client.scope)) throw new TokenRefused('missing scope');

      let groups: string[] = [];
      if (client.kind === 'site' && payload['groups'] !== undefined) {
        const claim = payload['groups'];
        if (!Array.isArray(claim) || !claim.every((group) => typeof group === 'string')) throw new TokenRefused('malformed groups claim');
        groups = claim;
      }
      return { client: client.kind, subject, groups, scopes };
    },
  };
}
