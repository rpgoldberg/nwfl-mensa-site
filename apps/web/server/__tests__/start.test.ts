import { EventEmitter } from 'node:events';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SECURITY_HEADERS } from '../policy.mjs';
import { SIZE_COOKIE } from '../prefs.mjs';
import { listenOptions, loadPrerendered, start } from '../start.mjs';

const FIXTURE_CLIENT = new URL('./fixtures/client/', import.meta.url);

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

class FakeProcess extends EventEmitter {
  exit = vi.fn();
}

const servers: http.Server[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

async function boot(
  handler: Handler,
  opts: { env?: Record<string, string | undefined>; graceMs?: number; clientDir?: URL; oldSite?: URL; buildInfo?: URL } = {},
) {
  const env: Record<string, string | undefined> = { PORT: '0', HOST: '127.0.0.1', ...opts.env };
  const proc = new FakeProcess();
  const log = vi.fn();
  let autostartWhenLoaded: string | undefined;
  const server = await start({
    env,
    proc,
    log,
    graceMs: opts.graceMs ?? 10_000,
    ...(opts.clientDir ? { clientDir: opts.clientDir } : {}),
    ...(opts.oldSite ? { oldSite: opts.oldSite } : {}),
    ...(opts.buildInfo ? { buildInfo: opts.buildInfo } : {}),
    loadHandler: async () => {
      autostartWhenLoaded = env['ASTRO_NODE_AUTOSTART'];
      return { handler };
    },
  });
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { server, proc, log, env, autostartWhenLoaded, base: `http://127.0.0.1:${port}` };
}

describe('listenOptions', () => {
  it('defaults to every interface on 8080', () => {
    expect(listenOptions({})).toEqual({ port: 8080, host: '0.0.0.0' });
  });

  it('takes PORT and HOST from the environment', () => {
    expect(listenOptions({ PORT: '8087', HOST: '127.0.0.1' })).toEqual({ port: 8087, host: '127.0.0.1' });
  });

  it('refuses a PORT that is not a port number', () => {
    for (const PORT of ['', 'http', '80.5', '-1', '65536']) {
      expect(() => listenOptions({ PORT }), PORT).toThrow(/PORT/);
    }
  });
});

describe('loadPrerendered', () => {
  it("maps each built page's clean path, and its .html path, to its HTML", async () => {
    const pages = await loadPrerendered(FIXTURE_CLIENT);
    expect([...pages.keys()].sort()).toEqual(['/', '/about', '/about.html', '/index.html', '/nested/deep', '/nested/deep.html']);
    expect(pages.get('/about')).toContain('<body>About</body>');
    expect(pages.get('/about.html')).toBe(pages.get('/about'));
    expect(pages.get('/nested/deep')).toContain('Deep');
    expect(pages.get('/')).toContain('Home');
  });

  it('finds nothing in a folder that does not exist', async () => {
    expect((await loadPrerendered(new URL('./fixtures/none/', import.meta.url))).size).toBe(0);
  });
});

describe('start: sign-in settings from the environment (W4)', () => {
  const auth = {
    OIDC_ISSUER: 'http://localhost:9090',
    OIDC_CLIENT_ID: 'nwfl-site',
    OIDC_CLIENT_SECRET: 'x',
    OIDC_REDIRECT_URI: 'https://localhost:8443/auth/callback',
    OIDC_POST_LOGOUT_REDIRECT_URI: 'https://localhost:8443/signed-out',
  };

  it('lets forms lead to the issuer, when sign-in is set up', async () => {
    const { base } = await boot((_req, res) => res.end('x'), { env: auth });
    expect((await fetch(base)).headers.get('content-security-policy')).toMatch(/form-action 'self' http:\/\/localhost:9090$/);
  });

  it('names no issuer when sign-in is not validly set up (here: production refuses a local one)', async () => {
    const { base } = await boot((_req, res) => res.end('x'), { env: { ...auth, NODE_ENV: 'production' } });
    expect((await fetch(base)).headers.get('content-security-policy')).toMatch(/form-action 'self'$/);
  });

  it('logs a malformed session key, and runs with everyone anonymous', async () => {
    const { log } = await boot((_req, res) => res.end('x'), { env: { SESSION_KEY: 'short' } });
    expect(log.mock.calls.map((c) => String(c[0])).join()).toContain('SESSION_KEY must be 32 bytes');
  });

  it('says where sessions live: in memory, so the site runs as one replica until W5a', async () => {
    const { log } = await boot((_req, res) => res.end('x'), { env: auth });
    expect(log.mock.calls.map((c) => String(c[0]))).toContain(JSON.stringify({ level: 'info', msg: 'session_store: memory (single replica)' }));
  });

  it('ignores sign-in settings and the session key in a public-only build, and says so: forms lead nowhere else', async () => {
    const key = Buffer.alloc(32, 7).toString('base64');
    const { base, log } = await boot((_req, res) => res.end('x'), {
      env: { ...auth, SESSION_KEY: key },
      buildInfo: new URL('./fixtures/build-public-only.json', import.meta.url),
    });
    expect((await fetch(base)).headers.get('content-security-policy')).toMatch(/form-action 'self'$/);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain(JSON.stringify({ level: 'error', msg: 'a public-only build has no sign-in: OIDC_* and SESSION_KEY are ignored' }));
    expect(lines).toContain(JSON.stringify({ level: 'info', msg: 'session_store: none (public-only build)' }));
  });

  it('logs nothing amiss for a public-only build set up as it should be, with an empty value counting as unset', async () => {
    const { log } = await boot((_req, res) => res.end('x'), { env: { OIDC_ISSUER: '' }, buildInfo: new URL('./fixtures/build-public-only.json', import.meta.url) });
    expect(log.mock.calls.map((c) => String(c[0])).join()).not.toContain('"level":"error"');
  });
});

describe('start', () => {
  it('answers old URLs from the table it is given', async () => {
    const { base } = await boot(() => {}, { oldSite: new URL('./fixtures/old-site.json', import.meta.url) });
    const res = await fetch(`${base}/join-mensa.html`, { redirect: 'manual' });
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/join');
  });

  it("serves the prerendered pages it finds, with the reader's settings", async () => {
    const { base } = await boot(() => {}, { clientDir: FIXTURE_CLIENT });
    const body = await (await fetch(`${base}/about`, { headers: { cookie: `${SIZE_COOKIE}=125` } })).text();
    expect(body).toContain('<html lang="en" data-size="125">');
  });

  it("turns off the Astro entry's own server before loading it", async () => {
    const { autostartWhenLoaded, env } = await boot((_req, res) => res.end('ok'));
    expect(autostartWhenLoaded).toBe('disabled');
    expect(env['ASTRO_NODE_AUTOSTART']).toBe('disabled');
  });

  it('serves the handler behind the site policy and logs where it listens', async () => {
    const { base, log, server } = await boot((_req, res) => res.end('hello'));
    const res = await fetch(`${base}/`);
    expect(await res.text()).toBe('hello');
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(res.headers.get(name), name).toBe(value);
    const { port } = server.address() as AddressInfo;
    expect(log).toHaveBeenCalledWith(JSON.stringify({ level: 'info', msg: 'listening', host: '127.0.0.1', port }));
  });

  it('closes and exits 0 on SIGTERM', async () => {
    const { proc, server } = await boot((_req, res) => res.end('ok'));
    proc.emit('SIGTERM');
    await vi.waitFor(() => expect(proc.exit).toHaveBeenCalledWith(0));
    expect(server.listening).toBe(false);
  });

  it('exits 0 on SIGINT too', async () => {
    const { proc } = await boot((_req, res) => res.end('ok'));
    proc.emit('SIGINT');
    await vi.waitFor(() => expect(proc.exit).toHaveBeenCalledWith(0));
  });

  it('exits after the grace period when a request never finishes', async () => {
    const { proc, base } = await boot(() => {}, { graceMs: 50 });
    const pending = fetch(`${base}/slow`).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    proc.emit('SIGTERM');
    await vi.waitFor(() => expect(proc.exit).toHaveBeenCalledWith(0), { timeout: 2000 });
    servers[0]?.closeAllConnections();
    await pending;
  });
});
