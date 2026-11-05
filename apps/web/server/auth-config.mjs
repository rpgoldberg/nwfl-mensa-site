// @ts-check
// The OIDC client's settings (W4), from config only: there is no default for
// any of them. In production (NODE_ENV=production, as in the image) the site
// signs in only on one of the frozen profiles below (S2), named by SITE_ORIGIN:
// the issuer is https on the profile's issuer origin at /application/o/<slug>/
// (an Authentik provider), and the browser comes back only to that profile's
// callback and signed-out page. Anything else turns sign-in off, with the
// reason logged; a reason names settings and the profile's own values, never
// a value it was given. Outside production no profile is read, so the tests
// and the e2e suite run against their local provider as before. Shared by the
// pages and the server wrapper, which lets forms lead to the issuer's origin
// (form-action). SITE_GROUP_PREFIX (CF-ISO-0, groups.mjs) names the chapter's
// groups, nwfl- by default; the API must be given the same value. A bad one
// turns sign-in off.

import { parseGroupPrefix } from './groups.mjs';

/**
 * @typedef {{ issuerOrigin: string, redirect: string, postLogout: string }} SiteProfile
 */

/**
 * The origins the site signs in on, by SITE_ORIGIN. The session cookie is
 * host-only, so each origin has its own callback and signed-out page. No
 * nwflorida.us row: the public domain waits on the ExComm (DOMAIN2); adding it
 * is one row and its tests.
 *
 * @type {Readonly<Record<string, Readonly<SiteProfile>>>}
 */
export const SITE_PROFILES = Object.freeze({
  'https://canary.nwflmensa.us': Object.freeze({
    issuerOrigin: 'https://login.nwflmensa.us',
    redirect: 'https://canary.nwflmensa.us/auth/callback',
    postLogout: 'https://canary.nwflmensa.us/signed-out',
  }),
  'https://nwflmensa.us': Object.freeze({
    issuerOrigin: 'https://login.nwflmensa.us',
    redirect: 'https://nwflmensa.us/auth/callback',
    postLogout: 'https://nwflmensa.us/signed-out',
  }),
});

/**
 * The profile for exactly this origin, if there is one; never an inherited name.
 *
 * @param {string | undefined} origin
 * @returns {Readonly<SiteProfile> | undefined}
 */
export function siteProfile(origin) {
  return origin !== undefined && Object.hasOwn(SITE_PROFILES, origin) ? SITE_PROFILES[origin] : undefined;
}

/** An Authentik provider's issuer path: /application/o/<slug>/. */
const ISSUER_PATH = /^\/application\/o\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/;

/**
 * The issuer, exactly as written: https on the profile's issuer origin, at
 * /application/o/<slug>/. What was written must be exactly that origin and
 * path, so no user part, port, query or fragment gets in, not even an empty
 * ? or # (the parsed search and hash do not show those).
 *
 * @param {URL} issuer
 * @param {string} raw
 * @param {Readonly<SiteProfile>} profile
 */
function profileIssuer(issuer, raw, profile) {
  return raw === issuer.origin + issuer.pathname && issuer.origin === profile.issuerOrigin && ISSUER_PATH.test(issuer.pathname);
}

/**
 * @typedef {{
 *   issuer: URL, clientId: string, clientSecret: string, redirectUri: string,
 *   postLogoutRedirectUri: string, scope: string, allowInsecure: boolean, groupPrefix: string,
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
    if (!env['SITE_ORIGIN']) return { enabled: false, reason: 'SITE_ORIGIN is not set' };
    const profile = siteProfile(env['SITE_ORIGIN']);
    if (!profile) return { enabled: false, reason: `SITE_ORIGIN must be one of ${Object.keys(SITE_PROFILES).join(', ')}` };
    if (!profileIssuer(issuer, value('OIDC_ISSUER'), profile)) {
      return { enabled: false, reason: `OIDC_ISSUER must be ${profile.issuerOrigin}/application/o/<slug>/` };
    }
    if (redirectUri !== profile.redirect) return { enabled: false, reason: `OIDC_REDIRECT_URI must be ${profile.redirect}` };
    if (postLogoutRedirectUri !== profile.postLogout) {
      return { enabled: false, reason: `OIDC_POST_LOGOUT_REDIRECT_URI must be ${profile.postLogout}` };
    }
  }
  const allowInsecure = issuer.protocol === 'http:';
  if (allowInsecure && (production || !LOOPBACK.includes(issuer.hostname))) {
    return { enabled: false, reason: 'OIDC_ISSUER must be https (plain http only for a local test provider, outside production)' };
  }
  const scope = env['OIDC_SCOPE'] || 'openid profile';
  if (!scope.split(' ').includes('openid')) return { enabled: false, reason: 'OIDC_SCOPE must include openid' };
  let groupPrefix;
  try {
    groupPrefix = parseGroupPrefix(env['SITE_GROUP_PREFIX']);
  } catch (error) {
    return { enabled: false, reason: /** @type {Error} */ (error).message };
  }

  return {
    enabled: true,
    config: { issuer, clientId: value('OIDC_CLIENT_ID'), clientSecret: value('OIDC_CLIENT_SECRET'), redirectUri, postLogoutRedirectUri, scope, allowInsecure, groupPrefix },
  };
}
