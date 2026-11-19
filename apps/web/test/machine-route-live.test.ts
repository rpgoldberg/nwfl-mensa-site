// MACHINE-ROUTE, end to end: the REAL web server (server/start.mjs, with Astro stood in: the route is
// mounted before it) in front of the REAL API server code (the production routes and caller gate over a
// migrated throwaway database: apps/api test/helpers/api.ts, which needs apps/api/scripts/test-db.sh), with
// tokens the API verifies for real (its JWT verifier, over a key made here), and the REAL checker CLI's
// items mode (apps/linkcheck cli.ts) calling the site's Connect route. The check runs offline: the
// addresses resolve through a stand-in DNS to a TLS stand-in on loopback, or not at all.
//
// It moves here the two live suites of apps/api test/links/linkcheck-items.test.ts, which drove the
// checker straight at the API: the checker now calls the site. Every person, place and address is made up.
import { randomUUID } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DescService } from '@bufbuild/protobuf';
import type { Client } from '@connectrpc/connect';
import { ContentKind, ContentService, type ContentItem, ItemVisibility, MachineVerdict } from '../src/gen/nwfl/mensa/v1/content_pb.js';
import { MACHINE_BODY_MAX } from '../server/machine-route.mjs';
import { start } from '../server/start.mjs';

// The API's harness and the checker, loaded only when live, by paths the site's type check does not
// follow (each app is type-checked by its own settings): what this test uses of them. The live rule is
// the harness's own (apps/api test/helpers/pg.ts): the throwaway Postgres's two variables.
const live = process.env['NWFL_TEST_DATABASE_URL'] !== undefined && process.env['NWFL_TEST_PG_CONTAINER'] !== undefined;
type Headers = { headers: Record<string, string> };
interface Verifier {
  verify(token: string): Promise<unknown>;
}
interface Api {
  pool: { query<R = unknown>(sql: string, values?: unknown[]): Promise<{ rows: R[] }> };
  baseUrl: string;
  logs: Record<string, unknown>[];
  client<T extends DescService>(service: T): Client<T>;
  close(): Promise<void>;
}
interface Harness {
  startApi(prefix: string, options: { verifier: Verifier }): Promise<Api>;
  insertId(pool: Api['pool'], sql: string): Promise<string>;
  fakeVerifier: Verifier;
  as(token: string): Headers;
}
interface Jwt {
  createJwtVerifier(clients: Array<{ kind: string; issuer: string; audience: string; jwks: unknown; scope?: string; subject?: string }>): Verifier;
}
type Verdict = { url: string; verdict: number; reasons: string[] };
interface Items {
  MACHINE: { OK: number; CONFIRM: number; DROP: number };
  MAX_RECORD_BYTES: number;
  encodeRecordRequest(verdicts: readonly Verdict[]): Uint8Array;
  recordRequests(verdicts: readonly Verdict[]): Uint8Array[];
  decodeRecordResponse(bytes: Uint8Array): { recorded: number; notAwaiting: string[] };
  connectCall(api: URL, method: string, token: string, message: Uint8Array): Promise<Uint8Array>;
  runItems(deps: { api: URL; token: string; check(urls: readonly string[]): Promise<Array<{ url: string; verdict: 'ok'; reasons: string[] }>> }): Promise<Record<string, number | boolean>>;
}
interface Cli {
  main(argv: readonly string[], io: Record<string, unknown>): Promise<number>;
}
interface Helpers {
  fakeDns(table: Record<string, string[]>, extra: { ns: Record<string, string[]> }): unknown;
  routedConnect(routes: Record<string, number>, ca: string): unknown;
  testPki(names: string[]): { ca: string };
  startHttps(route: (req: IncomingMessage, res: ServerResponse) => void, pki: { ca: string }): Promise<{ port: number; close(): Promise<void> }>;
}
const load = <T>(file: string): Promise<T> => import(/* @vite-ignore */ new URL(`../../${file}`, import.meta.url).href) as Promise<T>;

const ISSUER = 'https://login.example.org/application/o/nwfl/';
const FACEBOOK = 'https://www.facebook.com/groups/example-chess';
// The harness's stand-in names for the officers who write and read the pieces (no dots: never a signed token).
const PUB = { headers: { authorization: 'Bearer pub-token' } };
const TREASURER = { headers: { authorization: 'Bearer treasurer-token' } };
const clientOf = (a: Api) => a.client(ContentService);

describe.skipIf(!live)('the machine route in front of the real API', () => {
  let api: Api;
  let harness: Harness;
  let limits: { MAX_AWAITING_BYTES: number; READ_MAX_BYTES: number };
  let items: Items;
  let cli: Cli;
  let helpers: Helpers;
  let content: ReturnType<typeof clientOf>;
  let web: http.Server;
  let site: string;
  let tokenUrl: string;
  let tokenServer: http.Server;
  let tls: Awaited<ReturnType<Helpers['startHttps']>>;
  let pki: ReturnType<Helpers['testPki']>;
  let office: string;
  let n = 0;
  /** What the token endpoint hands out: the checker's own token, or one for another audience. */
  let issuing: 'linkcheck' | 'site' | 'stranger' = 'linkcheck';
  const issued: string[] = [];
  const webLines: string[] = [];
  let mint: (claims: { aud: string; sub: string; scope?: string }) => Promise<string>;

  const piece = async (body: string, title = 'Chess night') => {
    const item = (await content.createItem({ kind: ContentKind.ARTICLE, officeId: office, slug: `mr-${(n += 1)}`, title }, PUB)).item as ContentItem;
    await content.saveDraft({ itemId: item.id, title, summary: '', visibility: ItemVisibility.PUBLIC, bodyMarkup: body }, PUB);
    await content.markReady({ itemId: item.id }, PUB);
    return item.id;
  };
  const linkcheckToken = async () => {
    const token = await mint({ aud: 'nwfl-linkcheck', sub: 'svc-nwfl-linkcheck', scope: 'links.check' });
    issued.push(token);
    return token;
  };
  /** The API's rpc log lines for a method. */
  const apiCalls = (method: string) => api.logs.filter((line) => String(line['rpc']).endsWith(`/${method}`));
  /** The route's log lines. */
  const routeLines = () => webLines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line['msg'] === 'machine call');

  /** The checker's items command, as the officer's machine runs it, against the site. */
  const runCli = async () => {
    const out: string[] = [];
    const err: string[] = [];
    const A = '93.184.216.7';
    const code = await cli.main(['items'], {
      readFile: () => Promise.resolve(new TextEncoder().encode('made-up-app-password\n')),
      writeFile: () => Promise.reject(new Error('items writes no file')),
      print: (line: string) => out.push(line),
      warn: (line: string) => err.push(line),
      env: { LINKCHECK_API_URL: site, LINKCHECK_TOKEN_URL: tokenUrl, LINKCHECK_PASSWORD_FILE: '/run/pw' },
      now: () => new Date(),
      checkDeps: (issueDate: string) => ({
        dns: helpers.fakeDns({ 'club.example.org': [A], 'www.facebook.com': ['157.240.1.35'] }, { ns: {} }),
        connect: helpers.routedConnect({ [`${A}:443`]: tls.port }, pki.ca),
        rdap: { registered: () => Promise.resolve({ status: 'dated' as const, date: '2011-04-02' }) },
        issueDate,
        limits: { hopMs: 2000 },
      }),
      extract: () => Promise.reject(new Error('items reads no PDF')),
    });
    return { code, out, err };
  };

  beforeAll(async () => {
    // Only when live: the checker's own packages are installed beside it (apps/linkcheck).
    let jwtModule: Jwt;
    let linkCheck: { MAX_AWAITING_BYTES: number };
    let grpcServer: { READ_MAX_BYTES: number };
    [items, cli, helpers, harness, jwtModule, linkCheck, grpcServer] = await Promise.all([
      load<Items>('linkcheck/src/items.ts'),
      load<Cli>('linkcheck/src/cli.ts'),
      load<Helpers>('linkcheck/test/helpers/servers.ts'),
      load<Harness>('api/test/helpers/api.ts'),
      load<Jwt>('api/src/auth/jwt.ts'),
      load<{ MAX_AWAITING_BYTES: number }>('api/src/content/link-check.ts'),
      load<{ READ_MAX_BYTES: number }>('api/src/grpc/server.ts'),
    ]);
    limits = { MAX_AWAITING_BYTES: linkCheck.MAX_AWAITING_BYTES, READ_MAX_BYTES: grpcServer.READ_MAX_BYTES };
    for (const method of ['log', 'error'] as const) vi.spyOn(console, method).mockImplementation((line: unknown) => void webLines.push(String(line)));

    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }] });
    mint = ({ aud, sub, scope }) =>
      new SignJWT(scope === undefined ? {} : { scope }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(ISSUER).setAudience(aud).setSubject(sub).setIssuedAt().setExpirationTime('10m').sign(privateKey);
    const keys = jwks;
    const jwt = jwtModule.createJwtVerifier([
      { kind: 'linkcheck', issuer: ISSUER, audience: 'nwfl-linkcheck', jwks: keys, scope: 'links.check', subject: 'svc-nwfl-linkcheck' },
      { kind: 'agent', issuer: ISSUER, audience: 'nwfl-agent', jwks: keys, scope: 'newsletter.read', subject: 'svc-nwfl-newsletter' },
      { kind: 'site', issuer: ISSUER, audience: 'nwfl-site', jwks: keys },
    ]);
    // Signed tokens are verified for real; the harness's stand-in names (no dots) write the pieces.
    const verifier: Verifier = { verify: (token) => (token.includes('.') ? jwt.verify(token) : harness.fakeVerifier.verify(token)) };
    api = await harness.startApi('nwfl_machine_route', { verifier });
    content = clientOf(api);
    office = await harness.insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ('publications', 'Publications Officer', 'appointed') RETURNING id`);

    // The identity provider's token endpoint, as the checker calls it (client credentials).
    tokenServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      req.on('end', () => {
        const form = new URLSearchParams(body);
        if (form.get('grant_type') !== 'client_credentials' || form.get('password') !== 'made-up-app-password') {
          res.writeHead(401).end('{}');
          return;
        }
        const claims =
          issuing === 'linkcheck'
            ? { aud: 'nwfl-linkcheck', sub: 'svc-nwfl-linkcheck', scope: 'links.check' }
            : issuing === 'site'
              ? { aud: 'nwfl-site', sub: randomUUID(), scope: 'links.check' }
              : { aud: 'nwfl-elsewhere', sub: 'svc-nwfl-linkcheck', scope: 'links.check' };
        void mint(claims).then((token) => {
          issued.push(token);
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: token, token_type: 'Bearer' }));
        });
      });
    });
    await new Promise<void>((resolve) => tokenServer.listen(0, '127.0.0.1', resolve));
    tokenUrl = `http://127.0.0.1:${(tokenServer.address() as AddressInfo).port}/application/o/token/`;

    // A club page that answers, for an OK.
    pki = helpers.testPki(['club.example.org']);
    tls = await helpers.startHttps((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<p>Welcome to the club page. Lots of real text here about events and lunches.</p>');
    }, pki);

    // The site: a full build with the API's address.
    web = await start({
      env: { PORT: '0', HOST: '127.0.0.1', API_URL: api.baseUrl },
      proc: { once: () => undefined, exit: () => undefined },
      log: (line) => webLines.push(line),
      loadHandler: () => Promise.resolve({ handler: (_req: IncomingMessage, res: ServerResponse) => res.end('astro') }),
    });
    site = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    web?.closeAllConnections();
    await new Promise((resolve) => (web ? web.close(resolve) : resolve(undefined)));
    await new Promise((resolve) => (tokenServer ? tokenServer.close(resolve) : resolve(undefined)));
    await tls?.close();
    await api?.close();
    vi.restoreAllMocks();
  });

  it('the checker CLI lists, checks and records through the route, and the API keeps its verdicts', async () => {
    const itemId = await piece(`Play at https://club.example.org/chess, see [the old page](https://gone.example.org/), or [our group](${FACEBOOK}).`);
    issuing = 'linkcheck';
    const run = await runCli();
    expect(run.err).toEqual([]);
    expect(run).toMatchObject({ code: 0, out: ['items: 3 addresses checked: 1 ok, 1 confirm, 1 drop; 3 recorded, 0 no longer waiting'] });
    const links = (await content.getItemLinks({ itemId }, TREASURER)).links;
    expect(links.map((l) => [l.url, l.machineVerdict])).toEqual([
      ['https://club.example.org/chess', MachineVerdict.OK],
      ['https://gone.example.org/', MachineVerdict.DROP],
      [FACEBOOK, MachineVerdict.CONFIRM],
    ]);
    // The route's lines and the API's agree, call by call, and share each call's trace id.
    const route = routeLines().map((line) => [line['rpc'], line['code']]);
    expect(route).toEqual([
      ['LinkCheckService/ListLinksAwaitingVerdict', 'ok'],
      ['LinkCheckService/RecordLinkVerdicts', 'ok'],
    ]);
    expect(apiCalls('ListLinksAwaitingVerdict').map((l) => l['code'])).toEqual(['ok']);
    expect(apiCalls('RecordLinkVerdicts').map((l) => l['code'])).toEqual(['ok']);
    // A second run has nothing to do for a day.
    expect((await runCli()).out).toEqual(['items: 0 addresses checked: 0 ok, 0 confirm, 0 drop; 0 recorded, 0 no longer waiting']);
  });

  it.each([
    ['a site token (another audience)', 'site', 'PERMISSION_DENIED'],
    ['a token for no audience of ours', 'stranger', 'UNAUTHENTICATED'],
  ] as const)('%s is refused by the API, through the route, and nothing is recorded', async (_label, kind, code) => {
    const itemId = await piece('See https://refused.example.org/.');
    issuing = kind;
    const before = apiCalls('ListLinksAwaitingVerdict').length;
    const run = await runCli();
    issuing = 'linkcheck';
    expect(run.code).toBe(1);
    expect(run.err).toEqual([`linkcheck: the API refused the call: ${code}`]);
    // The API judged it: the call reached it, and it refused.
    expect(apiCalls('ListLinksAwaitingVerdict').slice(before).map((l) => l['code'])).toEqual([code.toLowerCase()]);
    expect((await api.pool.query(`SELECT 1 FROM content_link_check WHERE item_id = $1`, [itemId])).rows).toEqual([]);
    // The checker's own token then takes the address, so the next suite starts from an empty list.
    expect(await items.runItems({ api: new URL(site), token: await linkcheckToken(), check: (urls) => Promise.resolve(urls.map((url) => ({ url, verdict: 'ok' as const, reasons: [] }))) })).toMatchObject({ recorded: 1 });
  });

  it('refuses before the API: no bearer, an unknown method, a GET, a body over the cap', async () => {
    const token = await linkcheckToken();
    const before = api.logs.length;
    const post = (path: string, init: RequestInit = {}) => fetch(`${site}${path}`, { method: 'POST', ...init, headers: { 'content-type': 'application/proto', ...(init.headers ?? {}) } });
    const bare = await post('/nwfl.mensa.v1.LinkCheckService/ListLinksAwaitingVerdict', { body: new Uint8Array() });
    expect([bare.status, (await bare.json()) as unknown]).toEqual([401, { code: 'unauthenticated' }]);
    for (const path of ['/nwfl.mensa.v1.LinkCheckService/DeleteEverything', '/nwfl.mensa.v1.NewsletterService/', '/nwfl.mensa.v1.LinkCheckService/listLinksAwaitingVerdict']) {
      expect((await post(path, { headers: { authorization: `Bearer ${token}` }, body: new Uint8Array() })).status, path).toBe(404);
    }
    const get = await fetch(`${site}/nwfl.mensa.v1.LinkCheckService/ListLinksAwaitingVerdict?encoding=proto&message=`, { headers: { authorization: `Bearer ${token}` } });
    expect(get.status).toBe(404);
    const big = await post('/nwfl.mensa.v1.LinkCheckService/RecordLinkVerdicts', { headers: { authorization: `Bearer ${token}` }, body: new Uint8Array(MACHINE_BODY_MAX + 1) });
    expect([big.status, (await big.json()) as unknown]).toEqual([413, { code: 'resource_exhausted' }]);
    // Not one of them reached the API.
    expect(api.logs.slice(before)).toEqual([]);
  });

  it('the largest request the run writes passes the route; one over the cap is refused there, never forwarded', async () => {
    const token = await linkcheckToken();
    const verdict = (i: number, length: number) => ({ url: `https://n${String(i).padStart(3, '0')}.example.org/${'x'.repeat(length)}`, verdict: items.MACHINE.CONFIRM, reasons: [] });
    const one = items.encodeRecordRequest([verdict(0, 1960)]).length;
    const count = Math.floor(items.MAX_RECORD_BYTES / one);
    const verdicts = Array.from({ length: count }, (_, i) => verdict(i, 1960));
    verdicts[count - 1] = verdict(count - 1, 1960 + items.MAX_RECORD_BYTES - count * one);
    const requests = items.recordRequests(verdicts);
    expect(requests.map((r) => r.length)).toEqual([items.MAX_RECORD_BYTES]);
    expect(items.MAX_RECORD_BYTES).toBeLessThan(MACHINE_BODY_MAX);
    expect(MACHINE_BODY_MAX).toBeLessThan(limits.READ_MAX_BYTES);
    const reply = items.decodeRecordResponse(await items.connectCall(new URL(site), 'RecordLinkVerdicts', token, requests[0] as Uint8Array));
    expect(reply).toEqual({ recorded: 0, notAwaiting: verdicts.map((v) => v.url) });
    const before = apiCalls('RecordLinkVerdicts').length;
    const tooBig = items.encodeRecordRequest(Array.from({ length: 110 }, (_, i) => verdict(i, 1960)));
    expect(tooBig.length).toBeGreaterThan(MACHINE_BODY_MAX);
    await expect(items.connectCall(new URL(site), 'RecordLinkVerdicts', token, tooBig)).rejects.toThrow('the API refused the call: RESOURCE_EXHAUSTED');
    expect(apiCalls('RecordLinkVerdicts').length).toBe(before);
  });

  it('gives every one of 155 long addresses a verdict on the first run, the short one that sorts last included', async () => {
    const token = await linkcheckToken();
    const bytesOf = (urls: readonly string[]): number => urls.reduce((sum, url) => sum + Buffer.byteLength(url), 0);
    const victim = await piece('Lunch at https://zz-lunch.example.org/menu.', 'Long');
    const long: string[] = [];
    for (let p = 0; p < 7; p += 1) {
      const urls = Array.from({ length: 22 }, (_, i) => `https://a${p}.example.org/${String(i).padStart(3, '0')}${'q'.repeat(2000)}`);
      long.push(...urls);
      await piece(urls.join(' '), 'Long');
    }
    expect(bytesOf(long)).toBeGreaterThan(limits.READ_MAX_BYTES);
    const lists: string[][] = [];
    const totals = await items.runItems({
      api: new URL(site),
      token,
      check: (urls) => {
        lists.push([...urls]);
        return Promise.resolve(urls.map((url) => ({ url, verdict: 'ok' as const, reasons: [] })));
      },
    });
    expect(totals).toEqual({ checked: 155, ok: 155, confirm: 0, drop: 0, recorded: 155, notAwaiting: 0, more: false });
    const rows = (await api.pool.query<{ url: string; answer: string }>(`SELECT url, answer FROM content_link_check WHERE item_id = $1 AND source = 'machine' ORDER BY id`, [victim])).rows;
    expect(rows).toEqual([{ url: 'https://zz-lunch.example.org/menu', answer: 'ok' }]);
    expect(lists.length).toBeGreaterThan(1);
    for (const urls of lists) expect(bytesOf(urls)).toBeLessThanOrEqual(limits.MAX_AWAITING_BYTES);
    expect(lists.flat()).toEqual([...long, 'https://zz-lunch.example.org/menu']);
  });

  it("forwards the newsletter agent's reads too, with its own token", async () => {
    const token = await mint({ aud: 'nwfl-agent', sub: 'svc-nwfl-newsletter', scope: 'newsletter.read' });
    issued.push(token);
    const res = await fetch(`${site}/nwfl.mensa.v1.NewsletterService/ListEditions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{}' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    // The checker's token is not the agent's: the API refuses it there.
    const wrong = await fetch(`${site}/nwfl.mensa.v1.NewsletterService/ListEditions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${await linkcheckToken()}` }, body: '{}' });
    expect(((await wrong.json()) as { code: string }).code).toBe('permission_denied');
  });

  it('is 404 on the public-only build, with the real API behind it', async () => {
    const canary = await start({
      env: { PORT: '0', HOST: '127.0.0.1', API_URL: api.baseUrl },
      proc: { once: () => undefined, exit: () => undefined },
      log: (line) => webLines.push(line),
      buildInfo: new URL('../server/__tests__/fixtures/build-public-only.json', import.meta.url),
      loadHandler: () => Promise.resolve({ handler: (_req: IncomingMessage, res: ServerResponse) => res.end('astro') }),
    });
    try {
      const before = api.logs.length;
      const res = await fetch(`http://127.0.0.1:${(canary.address() as AddressInfo).port}/nwfl.mensa.v1.LinkCheckService/ListLinksAwaitingVerdict`, {
        method: 'POST',
        headers: { 'content-type': 'application/proto', authorization: `Bearer ${await linkcheckToken()}` },
        body: new Uint8Array(),
      });
      expect(res.status).toBe(404);
      expect(await res.text()).toBe('Not found');
      expect(api.logs.slice(before)).toEqual([]);
    } finally {
      canary.closeAllConnections();
      await new Promise((resolve) => canary.close(resolve));
    }
  });

  it('never writes a token into any log line: the site, the API or the checker', () => {
    expect(issued.length).toBeGreaterThan(5);
    const everything = [...webLines, ...api.logs.map((line) => JSON.stringify(line))].join('\n');
    expect(routeLines().length).toBeGreaterThan(10);
    for (const token of issued) {
      expect(everything).not.toContain(token);
      // Nor its signature alone.
      expect(everything).not.toContain(token.split('.')[2]);
    }
  });
});
