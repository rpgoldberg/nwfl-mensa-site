// SIGNIN-SLOW, in a real browser: one fresh sign-in after a token call that stalled, and never a loop.
// Its own stack, so the token endpoint can stall and the site's cookies can be blocked: the test
// provider (e2e/idp.mjs, IDP_TEST_CONTROL=1: it counts /auth and /token, and stalls the next N token
// calls), the built site with OIDC_TIMEOUT_MS=1000, and in front of it a plain proxy that counts each
// path and, for the cookies-blocked browser, drops Cookie on the way in and Set-Cookie on the way out.
// The provider keeps its own session cookie throughout, as a reader's browser keeps Authentik's.
// One browser is enough: this is the server's rule, not the page's; Chromium desktop runs it.
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { expect, test, type Page } from '@playwright/test';
import { sessionKey, transactionSetCookie } from '../server/session.mjs';

/** The cookies the site set before SIGNIN-SLOW, all of them listed on the privacy page; it sets no other. */
const MAIN_COOKIES = ['__Host-nwfl-auth', '__Host-nwfl-links', '__Host-nwfl-session', '__Host-nwfl-size', '__Host-nwfl-theme'];

const free = async () => {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address() as net.AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
};

let idpUrl = '';
let site = '';
const children: ChildProcess[] = [];
let proxy: http.Server;
let block = false;
/** A cookie the proxy adds on the way in, as a browser would send one set long ago. */
let inject = '';
const hits = { signIn: 0, callback: 0 };
const setCookieNames = new Set<string>();
const SESSION_KEY = randomBytes(32).toString('base64');

async function up(url: string) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${url} never came up`);
}

// In order, in one worker; a failure does not skip the rest.
test.describe.configure({ mode: 'default' });

// Every test: the site sets no cookie beyond the ones it always set (a failed test restarts the worker, so per test).
test.beforeEach(() => {
  setCookieNames.clear();
  inject = '';
});
test.afterEach(() => {
  expect([...setCookieNames].filter((n) => !MAIN_COOKIES.includes(n))).toEqual([]);
});

test.beforeAll(async () => {
  test.skip(test.info().project.name !== 'chromium-desktop', 'the server’s rule: one browser is enough');
  const [idpPort, webPort, proxyPort, deadApi] = [await free(), await free(), await free(), await free()];
  idpUrl = `http://127.0.0.1:${idpPort}`;
  site = `http://127.0.0.1:${proxyPort}`;
  const client = { id: 'nwfl-site-slow', secret: randomBytes(24).toString('base64url') };
  const redirects = { REDIRECT_URI: `${site}/auth/callback`, POST_LOGOUT_REDIRECT_URI: `${site}/signed-out` };
  const env = { PATH: process.env['PATH'] ?? '' };
  children.push(spawn(process.execPath, ['e2e/idp.mjs'], { stdio: 'ignore', env: { ...env, IDP_PORT: String(idpPort), IDP_TEST_CONTROL: '1', CLIENT_ID: client.id, CLIENT_SECRET: client.secret, ...redirects } }));
  children.push(
    spawn(process.execPath, ['server/serve.mjs'], {
      stdio: 'ignore',
      env: {
        ...env,
        PORT: String(webPort),
        HOST: '127.0.0.1',
        API_URL: `http://127.0.0.1:${deadApi}`,
        API_TIMEOUT_MS: '1000',
        OIDC_ISSUER: idpUrl,
        OIDC_CLIENT_ID: client.id,
        OIDC_CLIENT_SECRET: client.secret,
        OIDC_REDIRECT_URI: redirects.REDIRECT_URI,
        OIDC_POST_LOGOUT_REDIRECT_URI: redirects.POST_LOGOUT_REDIRECT_URI,
        OIDC_TIMEOUT_MS: '1000',
        SESSION_KEY,
      },
    }),
  );
  proxy = http.createServer((req, res) => {
    const path = req.url ?? '/';
    if (path.startsWith('/sign-in')) hits.signIn++;
    if (path.startsWith('/auth/callback')) hits.callback++;
    const headers = { ...req.headers, 'x-forwarded-proto': 'https' };
    if (block) delete headers.cookie;
    if (inject) headers.cookie = [headers.cookie, inject].filter(Boolean).join('; ');
    const upstream = http.request({ host: '127.0.0.1', port: webPort, path, method: req.method, headers }, (u) => {
      const out = { ...u.headers };
      for (const c of [out['set-cookie'] ?? []].flat()) setCookieNames.add(c.slice(0, c.indexOf('=')));
      if (block) delete out['set-cookie'];
      res.writeHead(u.statusCode ?? 502, out);
      u.pipe(res);
    });
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  await new Promise<void>((r) => proxy.listen(proxyPort, '127.0.0.1', r));
  await up(`${idpUrl}/.well-known/openid-configuration`);
  await up(`http://127.0.0.1:${webPort}/healthz`);
});

test.afterAll(async () => {
  for (const child of children) child.kill('SIGTERM');
  proxy?.closeAllConnections();
  await new Promise((r) => (proxy ? proxy.close(r) : r(undefined)));
});

/** Resets the counts; the next `stalls` token calls never answer. */
async function stallTokens(stalls: number) {
  hits.signIn = hits.callback = 0;
  await fetch(`${idpUrl}/test/stall-tokens?n=${stalls}`, { method: 'POST' });
}
const provider = async () => (await (await fetch(`${idpUrl}/test/counts`)).json()) as { auth: number; token: number };

async function logIn(page: Page, login = 'member') {
  await page.locator('input[name="login"]').fill(login);
  await page.locator('input[name="password"]').fill('any');
  await page.getByRole('button', { name: 'Sign-in' }).click();
}

const heading = (page: Page) => page.getByRole('heading', { level: 1 });

test('cookies blocked, provider session kept: one refusal page and no fresh round, however long it is left', async ({ page }) => {
  block = true;
  try {
    await stallTokens(0);
    // A stale callback from elsewhere: no transaction at all, so the page at once, as before.
    const stale = await page.goto(`${site}/auth/callback?code=old&state=old`);
    expect(stale?.status()).toBe(400);
    await expect(page.getByRole('main')).toContainText('took more than ten minutes');
    expect((await provider()).auth).toBe(0);

    // The reader presses Sign in: the provider asks for the login once, then keeps its session.
    await page.goto(`${site}/sign-in?return=%2Fabout`);
    await logIn(page);
    await expect(heading(page)).toHaveText('We could not sign you in');
    // "Start signing in again": the provider passes straight through, and the page again.
    await page.getByRole('link', { name: 'Start signing in again' }).click();
    await expect(heading(page)).toHaveText('We could not sign you in');
    const settled = { ...(await provider()), ...hits };
    await page.waitForTimeout(10_000);
    const after = { ...(await provider()), ...hits };
    expect(after).toEqual(settled);
    expect(after.auth).toBeLessThanOrEqual(2);
    expect(after).toMatchObject({ signIn: 2, callback: 3, token: 0 });
    await expect(heading(page)).toHaveText('We could not sign you in');
  } finally {
    block = false;
  }
});

test('a token call that stalls once: one fresh round, then signed in on the reader’s page', async ({ page }) => {
  await stallTokens(1);
  await page.goto(`${site}/sign-in?return=%2Fabout`);
  await logIn(page);
  await expect(page.getByRole('banner')).toContainText('Jordan Example', { timeout: 15_000 });
  expect(new URL(page.url()).pathname).toBe('/about');
  expect({ ...(await provider()), ...hits }).toEqual({ auth: 2, token: 2, signIn: 2, callback: 2 });
  expect([...setCookieNames].sort()).toEqual(['__Host-nwfl-auth', '__Host-nwfl-session']);
});

test('a second stall in the same chain: the refusal page, never a third round', async ({ page }) => {
  await stallTokens(2);
  await page.goto(`${site}/sign-in?return=%2Fabout`);
  await logIn(page);
  await expect(heading(page)).toHaveText('We could not sign you in', { timeout: 15_000 });
  await expect(page.getByRole('main')).toContainText('Something went wrong');
  await page.waitForTimeout(3000);
  expect({ ...(await provider()), ...hits }).toEqual({ auth: 2, token: 2, signIn: 2, callback: 2 });
});

test('"Sign in again" (again=1) survives the fresh round: a new sign-in, not a silent return', async ({ page }) => {
  await stallTokens(0);
  await page.goto(`${site}/sign-in?return=%2Fabout`);
  await logIn(page);
  await expect(page.getByRole('banner')).toContainText('Jordan Example');
  const before = (await page.context().cookies()).find((c) => c.name === '__Host-nwfl-session')?.value;
  await stallTokens(1);
  const fresh: string[] = [];
  page.on('response', (r) => {
    const to = r.headers()['location'];
    if (r.url().includes('/auth/callback') && to) fresh.push(to);
  });
  await page.goto(`${site}/sign-in?again=1&return=%2Fabout`);
  await expect(page).toHaveURL(`${site}/about`, { timeout: 15_000 });
  expect(fresh[0]).toBe('/sign-in?return=%2Fabout&again=1&fresh=1');
  expect({ ...(await provider()), ...hits }).toEqual({ auth: 2, token: 2, signIn: 2, callback: 2 });
  expect((await page.context().cookies()).find((c) => c.name === '__Host-nwfl-session')?.value).not.toBe(before);
});

test('cancelled at the provider eleven minutes after starting: the cancelled page, no round', async ({ page }) => {
  await stallTokens(0);
  const key = sessionKey({ SESSION_KEY })!;
  const started = Math.floor(Date.now() / 1000) - 11 * 60;
  const tx = transactionSetCookie({ state: 'st-old', nonce: 'n', verifier: 'v'.repeat(43), back: '/about' }, key, started).split(';')[0]!;
  inject = tx;
  const res = await page.goto(`${site}/auth/callback?error=access_denied&state=st-old`);
  expect(res?.status()).toBe(400);
  await expect(page.getByRole('main')).toContainText('Sign-in was cancelled');
  await page.waitForTimeout(1000);
  expect({ ...(await provider()), ...hits }).toEqual({ auth: 0, token: 0, signIn: 0, callback: 1 });
});
