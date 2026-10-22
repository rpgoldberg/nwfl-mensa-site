// @ts-check
// The OIDC client's settings (W4), from config only: there is no default for
// any of them. In production (NODE_ENV=production, as in the image) sign-in
// happens only at https://login.nwflorida.us (MT-03), and the browser comes
// back only to the site's own callback and signed-out page. Anything else
// turns sign-in off, with the reason logged. Shared by the pages and the
// server wrapper, which lets forms lead to the issuer's origin (form-action).

export const PRODUCTION_ISSUER_ORIGIN = 'https://login.nwflorida.us';
export const PRODUCTION_REDIRECTS = Object.freeze({
  redirect: 'https://nwflorida.us/auth/callback',
  postLogout: 'https://nwflorida.us/signed-out',
});

/**
 * @typedef {{
 *   issuer: URL, clientId: string, clientSecret: string, redirectUri: string,
 *   postLogoutRedirectUri: string, scope: string, allowInsecure: boolean,
 * }} AuthConfig allowInsecure: a plain-http issuer, the local test provider, never in production
 * @typedef {{ enabled: true, config: AuthConfig } | { enabled: false, reason: string }} AuthSetup
 */

const REQUIRED = /** @type {const} */ (['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_REDIRECT_URI', 'OIDC_POST_LOGOUT_REDIRECT_URI']);
const LOOPBACK = ['localhost', '127.0.0.1'];

/** @param {string} value */
function parse(value) {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {AuthSetup}
 */
export function authConfig(env) {
  for (const name of REQUIRED) if (!env[name]) return { enabled: false, reason: `${name} is not set` };
  /** @param {(typeof REQUIRED)[number]} name */
  const value = (name) => /** @type {string} */ (env[name]);
  const issuer = parse(value('OIDC_ISSUER'));
  if (!issuer) return { enabled: false, reason: 'OIDC_ISSUER is not a URL' };
  const production = env['NODE_ENV'] === 'production';
  const redirectUri = value('OIDC_REDIRECT_URI');
  const postLogoutRedirectUri = value('OIDC_POST_LOGOUT_REDIRECT_URI');

  if (production) {
    if (issuer.origin !== PRODUCTION_ISSUER_ORIGIN) return { enabled: false, reason: `OIDC_ISSUER must be on ${PRODUCTION_ISSUER_ORIGIN}` };
    if (redirectUri !== PRODUCTION_REDIRECTS.redirect) return { enabled: false, reason: `OIDC_REDIRECT_URI must be ${PRODUCTION_REDIRECTS.redirect}` };
    if (postLogoutRedirectUri !== PRODUCTION_REDIRECTS.postLogout) {
      return { enabled: false, reason: `OIDC_POST_LOGOUT_REDIRECT_URI must be ${PRODUCTION_REDIRECTS.postLogout}` };
    }
  }
  const allowInsecure = issuer.protocol === 'http:';
  if (allowInsecure && (production || !LOOPBACK.includes(issuer.hostname))) {
    return { enabled: false, reason: 'OIDC_ISSUER must be https (plain http only for a local test provider, outside production)' };
  }
  const scope = env['OIDC_SCOPE'] || 'openid profile';
  if (!scope.split(' ').includes('openid')) return { enabled: false, reason: 'OIDC_SCOPE must include openid' };

  return {
    enabled: true,
    config: { issuer, clientId: value('OIDC_CLIENT_ID'), clientSecret: value('OIDC_CLIENT_SECRET'), redirectUri, postLogoutRedirectUri, scope, allowInsecure },
  };
}
