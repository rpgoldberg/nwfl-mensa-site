// The OIDC client (W4): a confidential client using the authorization code
// flow with PKCE S256, state and nonce, through openid-client, which checks
// the ID token's signature, issuer, audience, expiry and nonce. The tokens it
// returns stay on the server. The secret goes in the token request's body
// (client_secret_post): Basic authentication URL-encodes the client id first
// ("nwfl-site" becomes "nwfl%2Dsite"), which not every provider decodes.
import * as client from 'openid-client';
import type { AuthConfig } from '../../../server/auth-config.mjs';

let discovered: { key: string; config: Promise<client.Configuration> } | undefined;

/** The provider's metadata, read once per issuer and client; read again after a failure. */
function discover(cfg: AuthConfig): Promise<client.Configuration> {
  const key = `${cfg.issuer.href} ${cfg.clientId}`;
  if (discovered?.key !== key) {
    const config = client
      .discovery(
        cfg.issuer,
        cfg.clientId,
        undefined,
        client.ClientSecretPost(cfg.clientSecret),
        cfg.allowInsecure ? { execute: [client.allowInsecureRequests] } : undefined,
      )
      .catch((error: unknown) => {
        discovered = undefined;
        throw error;
      });
    discovered = { key, config };
  }
  return discovered.config;
}

/** For tests: read the metadata afresh. */
export function forgetDiscovery(): void {
  discovered = undefined;
}

export interface Start {
  location: URL;
  state: string;
  nonce: string;
  verifier: string;
}

export async function startSignIn(cfg: AuthConfig): Promise<Start> {
  const config = await discover(cfg);
  const verifier = client.randomPKCECodeVerifier();
  const state = client.randomState();
  const nonce = client.randomNonce();
  const location = client.buildAuthorizationUrl(config, {
    redirect_uri: cfg.redirectUri,
    scope: cfg.scope,
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    state,
    nonce,
  });
  return { location, state, nonce, verifier };
}

export interface Tokens {
  access_token: string;
  id_token?: string | undefined;
  refresh_token?: string | undefined;
  expires_in?: number | undefined;
}

export interface SignedIn {
  claims: Record<string, unknown>;
  tokens: Tokens;
}

/**
 * Exchange the code. The response is read as if it arrived at the configured
 * redirect URI exactly, whatever URL the server saw it on behind the proxy.
 */
export async function finishSignIn(cfg: AuthConfig, responseUrl: URL, tx: Pick<Start, 'state' | 'nonce' | 'verifier'>): Promise<SignedIn> {
  const config = await discover(cfg);
  const current = new URL(cfg.redirectUri);
  current.search = responseUrl.search;
  const response = await client.authorizationCodeGrant(config, current, {
    pkceCodeVerifier: tx.verifier,
    expectedState: tx.state,
    expectedNonce: tx.nonce,
    idTokenExpected: true,
  });
  // idTokenExpected: the grant fails without an ID token, so its claims are there.
  const claims = response.claims() as client.IDToken;
  return {
    claims: { ...claims },
    tokens: { access_token: response.access_token, id_token: response.id_token, refresh_token: response.refresh_token, expires_in: response.expires_in },
  };
}

/** RP-initiated logout at the provider, or undefined when it offers none. */
export async function endSessionUrl(cfg: AuthConfig, { idToken, state }: { idToken?: string | undefined; state: string }): Promise<URL | undefined> {
  const config = await discover(cfg);
  if (!config.serverMetadata().end_session_endpoint) return undefined;
  return client.buildEndSessionUrl(config, {
    post_logout_redirect_uri: cfg.postLogoutRedirectUri,
    ...(idToken ? { id_token_hint: idToken } : {}),
    state,
  });
}
