// @ts-check
// A local OpenID provider for the e2e suite only (oidc-provider), standing in
// for the club's Authentik: never a shared host. It knows four made-up
// people, requires PKCE, takes the client secret in the body
// (client_secret_post), puts name and groups in the ID token as Authentik does,
// and offers RP-initiated logout. Consent is skipped for the one client, as a
// first-party provider would. Its own pages are plain forms that load nothing
// from elsewhere (the library's samples import a web font, and WebKit then
// lost a sign-in now and then). Settings come from the environment.
import http from 'node:http';
import Provider from 'oidc-provider';

const env = process.env;
const port = Number(env['IDP_PORT'] ?? 9090);
const issuer = `http://127.0.0.1:${port}`;

/** @type {Record<string, { name: string, groups: string[] }>} */
const ACCOUNTS = {
  officer: { name: 'Alex Sample', groups: ['nwfl-members', 'nwfl-officers', 'nwfl-office-president'] },
  member: { name: 'Jordan Example', groups: ['nwfl-members'] },
  pending: { name: 'Casey Placeholder', groups: ['nwfl-pending'] },
  // A long name, for the header's layout on a narrow phone at large text.
  'long-name': { name: 'Maximiliana Bartholomew-Fitzgerald Examplesworth', groups: ['nwfl-members', 'nwfl-officers'] },
};

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
  /** @param {unknown} _ctx @param {string} id */
  async findAccount(_ctx, id) {
    const account = ACCOUNTS[id] ?? { name: id, groups: [] };
    return { accountId: id, claims: async () => ({ sub: id, ...account }) };
  },
  /** @param {import('oidc-provider').KoaContextWithOIDC} ctx */
  async loadExistingGrant(ctx) {
    const { oidc } = ctx;
    const grantId = oidc.result?.consent?.grantId || oidc.session?.grantIdFor(String(oidc.client?.clientId));
    if (grantId) return oidc.provider.Grant.find(grantId);
    const grant = new oidc.provider.Grant({ clientId: String(oidc.client?.clientId), accountId: String(oidc.session?.accountId) });
    grant.addOIDCScope('openid profile');
    grant.addOIDCClaims(['name', 'groups']);
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
http
  .createServer(async (req, res) => {
    const match = /^\/interaction\/([\w-]+)(\/abort)?$/.exec(new URL(req.url ?? '/', issuer).pathname);
    if (!match) return app(req, res);
    try {
      const details = await provider.interactionDetails(req, res);
      if (match[2]) {
        return await provider.interactionFinished(req, res, { error: 'access_denied', error_description: 'End-User aborted interaction' }, { mergeWithLastSubmission: false });
      }
      if (req.method === 'POST') {
        const login = (await form(req)).get('login') ?? '';
        return await provider.interactionFinished(req, res, { login: { accountId: login } }, { mergeWithLastSubmission: false });
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
  })
  .listen(port, '127.0.0.1', () => console.log(JSON.stringify({ msg: 'test identity provider listening', issuer })));
