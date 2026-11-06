// @ts-check
// A local OpenID provider for the e2e suite only (oidc-provider), standing in
// for the club's Authentik: never a shared host. It knows twenty-two made-up
// people, requires PKCE, takes the client secret in the body
// (client_secret_post), puts name and groups in the ID token as Authentik does,
// and offers RP-initiated logout. Consent is skipped for the one client, as a
// first-party provider would. Its own pages are plain forms that load nothing
// from elsewhere (the library's samples import a web font, and WebKit then
// lost a sign-in now and then). Settings come from the environment.
//
// A14: as A16 provisions Authentik, the access token is a JWT for the API
// alone (aud nwfl-site, RS256), with the groups claim, a UUID subject, and an
// hour's life at most (the API refuses a longer one). Three people exist for the
// edge cases: "lapsed", whose token lives 20 s (under the site's 30 s margin,
// so it is never forwarded), "refused", whose token the stand-in API
// refuses (e2e/api.mjs), and "articles-down", a member whose articles read the
// stand-in API cannot answer. With IDP_TLS_KEY and IDP_TLS_CERT (PEM) it serves
// https, as the real API requires of an issuer (the redaction lane).
import http from 'node:http';
import https from 'node:https';
import Provider, { errors } from 'oidc-provider';

const env = process.env;
const port = Number(env['IDP_PORT'] ?? 9090);
const tls = env['IDP_TLS_KEY'] && env['IDP_TLS_CERT'] ? { key: env['IDP_TLS_KEY'], cert: env['IDP_TLS_CERT'] } : undefined;
const issuer = `${tls ? 'https' : 'http'}://127.0.0.1:${port}`;

/** The API as a resource: the access token's audience is its client id, as Authentik sets it. */
const RESOURCE = 'urn:nwfl:api';
const AUDIENCE = 'nwfl-site';

/**
 * By the login typed at the sign-in form. Each id is the subject, a UUID as Authentik's user_uuid mode
 * makes it (the API refuses any other). Kept in step with e2e/stand-in.ts (ACCOUNTS).
 * @type {Record<string, { id: string, name: string, groups: string[], tokenSeconds?: number }>}
 */
const LOGINS = {
  officer: { id: '00000000-0000-4000-8000-0000000000a1', name: 'Alex Sample', groups: ['nwfl-members', 'nwfl-officers', 'nwfl-office-president'] },
  member: { id: '00000000-0000-4000-8000-0000000000b2', name: 'Jordan Example', groups: ['nwfl-members'] },
  // PDFVIEW fix 2: a member to whom the API lists two issues as their public copy alone (api.mjs MIXED_PUBLIC_ONLY).
  mixed: { id: '00000000-0000-4000-8000-0000000000b3', name: 'Ellis Example', groups: ['nwfl-members'] },
  pending: { id: '00000000-0000-4000-8000-0000000000c3', name: 'Casey Placeholder', groups: ['nwfl-pending'] },
  // A long name, for the header's layout on a narrow phone at large text.
  'long-name': { id: '00000000-0000-4000-8000-0000000000d4', name: 'Maximiliana Bartholomew-Fitzgerald Examplesworth', groups: ['nwfl-members', 'nwfl-officers'] },
  refused: { id: '00000000-0000-4000-8000-0000000000e5', name: 'Riley Testcase', groups: ['nwfl-members'] },
  lapsed: { id: '00000000-0000-4000-8000-0000000000f6', name: 'Quinn Example', groups: ['nwfl-members'], tokenSeconds: 20 },
  'articles-down': { id: '00000000-0000-4000-8000-0000000000a7', name: 'Morgan Example', groups: ['nwfl-members'] },
  // D4: member standing in the API's records, but no members group in the claim (a stale or missing group).
  stale: { id: '00000000-0000-4000-8000-0000000000b8', name: 'Avery Sample', groups: [] },
  // D4: the officers group alone, without the members group: the site does not read it as a member's.
  'officer-only': { id: '00000000-0000-4000-8000-0000000000a9', name: 'Drew Example', groups: ['nwfl-officers'] },
  // AC6 (b): every enrolee is in nwfl-users alone; standing lives only in the API's records (member here, pending next).
  enrolee: { id: '00000000-0000-4000-8000-0000000000c1', name: 'Sam Sample', groups: ['nwfl-users'] },
  'enrolee-pending': { id: '00000000-0000-4000-8000-0000000000c2', name: 'Robin Example', groups: ['nwfl-users'] },
  // No enrolee group and a token that lapses at once: never told to sign in again for members reading.
  'lapsed-outsider': { id: '00000000-0000-4000-8000-0000000000c4', name: 'Jamie Placeholder', groups: ['nwfl-officers'], tokenSeconds: 20 },
  // SOLO-APPROVE: the Admin, who alone sets the approval rule, and the Webmaster, who approves but is not the Admin.
  admin: { id: '00000000-0000-4000-8000-0000000000ad', name: 'Pat Example', groups: ['nwfl-members', 'nwfl-officers', 'nwfl-office-publications', 'nwfl-admin'] },
  webmaster: { id: '00000000-0000-4000-8000-0000000000eb', name: 'Lee Placeholder', groups: ['nwfl-members', 'nwfl-officers', 'nwfl-webmaster'] },
  // SOLO-APPROVE: the Admin's group alone, without the officers group (the API serves the Admin either way).
  'lone-admin': { id: '00000000-0000-4000-8000-0000000000ae', name: 'Rowan Example', groups: ['nwfl-admin'] },
  // S2: the Admin, an officer, whose token lapses at once: each officer page then says to sign in again.
  'lapsed-admin': { id: '00000000-0000-4000-8000-0000000000af', name: 'Hollis Sample', groups: ['nwfl-members', 'nwfl-officers', 'nwfl-admin'], tokenSeconds: 20 },
  // W-SIGNUP: an enrolee with no account yet; one an officer invited (fc INVITE1's groups); and the
  // Membership Officer, a membership approver, who also has a sign-up of their own in the queue.
  newcomer: { id: '00000000-0000-4000-8000-0000000000d1', name: 'Sky Sample', groups: ['nwfl-users'] },
  invitee: { id: '00000000-0000-4000-8000-0000000000d2', name: 'Taylor Example', groups: ['nwfl-users', 'nwfl-members', 'nwfl-invited'] },
  approver: { id: '00000000-0000-4000-8000-0000000000d3', name: 'Blair Example', groups: ['nwfl-members', 'nwfl-officers', 'nwfl-office-membership', 'nwfl-membership-approvers'] },
  // W-SIGNUP fix 1: an enrolee whose sign-up an approver rejected (the API removed the account with it);
  // a membership approver who is not an officer; and a Webmaster who is not in the officers group.
  'turned-down': { id: '00000000-0000-4000-8000-0000000000d5', name: 'Dana Sample', groups: ['nwfl-users'] },
  'lone-approver': { id: '00000000-0000-4000-8000-0000000000d6', name: 'Jordan Placeholder', groups: ['nwfl-users', 'nwfl-membership-approvers'] },
  'lone-webmaster': { id: '00000000-0000-4000-8000-0000000000d7', name: 'Kai Example', groups: ['nwfl-users', 'nwfl-webmaster'] },
  // REOPEN: rejected sign-ups (the API removed each account with it), one per browser project, which
  // that project's run reopens (api.mjs REJECTED).
  'reopen-desktop': { id: '00000000-0000-4000-8000-0000000000e1', name: 'Ari Example', groups: ['nwfl-users'] },
  'reopen-phone': { id: '00000000-0000-4000-8000-0000000000e2', name: 'Bo Sample', groups: ['nwfl-users'] },
  'reopen-iphone': { id: '00000000-0000-4000-8000-0000000000e3', name: 'Cam Placeholder', groups: ['nwfl-users'] },
  // REOPEN: the Membership Officer's seat without the approvers group: reopens, never decides; and the
  // same seat whose token the stand-in API refuses (api.mjs REFUSED_SEAT_SUBJECT).
  'seat-only': { id: '00000000-0000-4000-8000-0000000000e6', name: 'Quinn Placeholder', groups: ['nwfl-users', 'nwfl-officers', 'nwfl-office-membership'] },
  'seat-refused': { id: '00000000-0000-4000-8000-0000000000e7', name: 'Morgan Sample', groups: ['nwfl-users', 'nwfl-officers', 'nwfl-office-membership'] },
};
const BY_ID = new Map(Object.values(LOGINS).map((a) => [a.id, a]));

/** @param {string} title @param {string} body */
const page = (title, body) =>
  `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;

const provider = new Provider(issuer, {
  clients: [
    {
      client_id: String(env['CLIENT_ID']),
      client_secret: String(env['CLIENT_SECRET']),
      redirect_uris: [String(env['REDIRECT_URI'])],
      post_logout_redirect_uris: [String(env['POST_LOGOUT_REDIRECT_URI'])],
      token_endpoint_auth_method: 'client_secret_post',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    },
  ],
  pkce: { required: () => true },
  claims: { openid: ['sub'], profile: ['name', 'groups'] },
  conformIdTokenClaims: false,
  cookies: { keys: ['e2e-only-not-a-secret'] },
  features: {
    devInteractions: { enabled: false },
    resourceIndicators: {
      enabled: true,
      defaultResource: () => RESOURCE,
      // The client asks for no resource at the token endpoint: the granted one is used, so the access token is the API's JWT.
      useGrantedResource: () => true,
      /** @param {import('oidc-provider').KoaContextWithOIDC} ctx @param {string} indicator */
      getResourceServerInfo(ctx, indicator) {
        if (indicator !== RESOURCE) throw new errors.InvalidTarget();
        const accountId = ctx.oidc.entities.AuthorizationCode?.accountId;
        const seconds = (accountId && BY_ID.get(accountId)?.tokenSeconds) || 3600;
        return { scope: 'site', audience: AUDIENCE, accessTokenTTL: seconds, accessTokenFormat: 'jwt', jwt: { sign: { alg: 'RS256' } } };
      },
    },
    rpInitiatedLogout: {
      enabled: true,
      /** @param {import('oidc-provider').KoaContextWithOIDC} ctx @param {string} form */
      async logoutSource(ctx, form) {
        ctx.body = page(
          'Sign out of the provider?',
          `${form}<button type="submit" form="op.logoutForm" name="logout" value="yes">Yes, sign me out</button> <button type="submit" form="op.logoutForm">No, stay signed in</button>`,
        );
      },
    },
  },
  /** The groups claim in the API's access token, as Authentik's scope mapping puts it there. @param {unknown} _ctx @param {any} token */
  async extraTokenClaims(_ctx, token) {
    return token.kind === 'AccessToken' ? { groups: BY_ID.get(String(token.accountId))?.groups ?? [] } : undefined;
  },
  /** @param {unknown} _ctx @param {string} id */
  async findAccount(_ctx, id) {
    const account = BY_ID.get(id);
    const claims = account ? { name: account.name, groups: account.groups } : { name: id, groups: [] };
    return { accountId: id, claims: async () => ({ sub: id, ...claims }) };
  },
  /** @param {import('oidc-provider').KoaContextWithOIDC} ctx */
  async loadExistingGrant(ctx) {
    const { oidc } = ctx;
    const grantId = oidc.result?.consent?.grantId || oidc.session?.grantIdFor(String(oidc.client?.clientId));
    if (grantId) return oidc.provider.Grant.find(grantId);
    const grant = new oidc.provider.Grant({ clientId: String(oidc.client?.clientId), accountId: String(oidc.session?.accountId) });
    grant.addOIDCScope('openid profile');
    grant.addOIDCClaims(['name', 'groups']);
    grant.addResourceScope(RESOURCE, 'site');
    await grant.save();
    return grant;
  },
});

/** @param {http.IncomingMessage} req */
async function form(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return new URLSearchParams(body);
}

const app = provider.callback();

// The sign-in step (the library's own interaction pages are off): a login
// form, any password, and a Cancel link that answers access_denied.
/** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
async function listener(req, res) {
  const match = /^\/interaction\/([\w-]+)(\/abort)?$/.exec(new URL(req.url ?? '/', issuer).pathname);
  if (!match) return app(req, res);
  try {
    const details = await provider.interactionDetails(req, res);
    if (match[2]) {
      return await provider.interactionFinished(req, res, { error: 'access_denied', error_description: 'End-User aborted interaction' }, { mergeWithLastSubmission: false });
    }
    if (req.method === 'POST') {
      const login = (await form(req)).get('login') ?? '';
      return await provider.interactionFinished(req, res, { login: { accountId: LOGINS[login]?.id ?? login } }, { mergeWithLastSubmission: false });
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(
      page(
        'Sign-in',
        `<form method="post" action="/interaction/${details.uid}"><label>Login <input required type="text" name="login"></label> <label>Password <input required type="password" name="password"></label> <button type="submit">Sign-in</button></form><p><a href="/interaction/${details.uid}/abort">[ Cancel ]</a></p>`,
      ),
    );
  } catch (error) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end(String(error));
  }
}

(tls ? https.createServer(tls, listener) : http.createServer(listener)).listen(port, '127.0.0.1', () => console.log(JSON.stringify({ msg: 'test identity provider listening', issuer })));
