// EDITOR E7a: the real API as each made-up person calls it, for what has no screen yet (Approve and
// Publish come with E4) and for the attacks a browser would not send. A person's access token comes from
// the test identity provider by the same authorization-code flow the site runs (PKCE, the client secret in
// the body), with the secret the config made (E2E_EDITOR_REAL_CLIENT_SECRET); never printed. The API is
// called over plain h2c gRPC, as the site calls it in the cluster.
import { createHash, randomBytes } from 'node:crypto';
import { Code, ConnectError, createClient } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import { request } from '@playwright/test';
import { ContentService } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { EventService } from '../../src/gen/nwfl/mensa/v1/event_pb.js';
import { EDITOR_REAL } from './servers';

const transport = createGrpcTransport({ baseUrl: EDITOR_REAL.apiUrl, defaultTimeoutMs: 10_000 });
export const content = createClient(ContentService, transport);
export const events = createClient(EventService, transport);

/** The call options that carry a person's token. */
export const as = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

const tokens = new Map<string, string>();

/** A person's API access token, signed in at the provider by login (e2e/idp.mjs LOGINS). Fresh each time when `fresh`. */
export async function tokenFor(login: string, { fresh = false } = {}): Promise<string> {
  const cached = tokens.get(login);
  if (cached && !fresh) return cached;
  const ctx = await request.newContext({ ignoreHTTPSErrors: true });
  try {
    const redirect = `${EDITOR_REAL.siteUrl}/auth/callback`;
    const verifier = randomBytes(32).toString('base64url');
    const auth = new URL(`${EDITOR_REAL.idpUrl}/auth`);
    auth.search = new URLSearchParams({
      client_id: EDITOR_REAL.clientId,
      response_type: 'code',
      scope: 'openid profile email',
      redirect_uri: redirect,
      state: randomBytes(8).toString('hex'),
      nonce: randomBytes(8).toString('hex'),
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    const form = await ctx.get(auth.href);
    const action = /<form method="post" action="([^"]+)"/.exec(await form.text())?.[1];
    if (!action) throw new Error(`no sign-in form for ${login}`);
    let res = await ctx.post(new URL(action, form.url()).href, { form: { login, password: 'any' }, maxRedirects: 0 });
    for (let hops = 0; hops < 8; hops++) {
      const location = res.headers()['location'];
      if (!location) throw new Error(`the provider stopped at ${res.status()} for ${login}`);
      const next = new URL(location, res.url());
      if (next.href.startsWith(redirect)) {
        const code = next.searchParams.get('code');
        if (!code) throw new Error(`no code for ${login}`);
        const answer = await ctx.post(`${EDITOR_REAL.idpUrl}/token`, {
          form: { grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: EDITOR_REAL.clientId, client_secret: String(process.env['E2E_EDITOR_REAL_CLIENT_SECRET']), code_verifier: verifier },
        });
        const body = (await answer.json()) as { access_token?: string };
        if (!body.access_token) throw new Error(`no access token for ${login} (${answer.status()})`);
        tokens.set(login, body.access_token);
        return body.access_token;
      }
      res = await ctx.get(next.href, { maxRedirects: 0 });
    }
    throw new Error(`too many redirects for ${login}`);
  } finally {
    await ctx.dispose();
  }
}

/** The gRPC code a call fails with, or 'OK'. */
export async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'OK';
  } catch (error) {
    return Code[ConnectError.from(error).code];
  }
}
