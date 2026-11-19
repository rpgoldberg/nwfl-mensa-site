// MACHINE-ROUTE: the site's Connect route for the machine clients (the link checker, later the newsletter
// export), in front of a stand-in API that speaks gRPC over h2c as the real one does. Each call is
// forwarded with the caller's bearer only; everything else is refused before a byte reaches the API.
// test/machine-route-live.test.ts drives the same route in front of the real API. Every address is made up.
import { create, fromBinary, toBinary, type DescMessage } from '@bufbuild/protobuf';
import { Code, ConnectError, createClient, type ConnectRouter, type HandlerContext } from '@connectrpc/connect';
import { connectNodeAdapter, createConnectTransport } from '@connectrpc/connect-node';
import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import { gzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContentService } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { LinkCheckService, RecordLinkVerdictsRequestSchema, RecordLinkVerdictsResponseSchema } from '../../src/gen/nwfl/mensa/v1/link_check_pb.js';
import { ExportEditionRequestSchema, NewsletterService } from '../../src/gen/nwfl/mensa/v1/newsletter_pb.js';
import { MACHINE_BODY_MAX, MACHINE_BODY_MS, MACHINE_LIMIT, createMachineRoute, machineRouteFromEnv, unaryMethods } from '../machine-route.mjs';
import { SECURITY_HEADERS, SESSION_COOKIE } from '../policy.mjs';
import { createSiteServer } from '../siteServer.mjs';

const TOKEN = 'mAcHiNe.tok-en_9~+/=';
const BEARER = `Bearer ${TOKEN}`;
const LIST = '/nwfl.mensa.v1.LinkCheckService/ListLinksAwaitingVerdict';
const RECORD = '/nwfl.mensa.v1.LinkCheckService/RecordLinkVerdicts';
const EXPORT = '/nwfl.mensa.v1.NewsletterService/ExportEdition';

// ---------------------------------------------------------------------------
// The stand-in API: gRPC over h2c, every method of both services, each call kept.

interface Seen {
  rpc: string;
  headers: Headers;
  message: unknown;
}
type Answer = (rpc: string, message: unknown, ctx: HandlerContext) => Promise<unknown> | unknown;

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of closers.splice(0).reverse()) await close();
});

async function standInApi(answer: Answer = () => ({})): Promise<{ baseUrl: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const routes = (router: ConnectRouter) => {
    for (const service of [LinkCheckService, NewsletterService]) {
      for (const method of service.methods) {
        router.rpc(method as never, (async (message: unknown, ctx: HandlerContext) => {
          seen.push({ rpc: `${service.name}/${method.name}`, headers: new Headers(ctx.requestHeader), message });
          return (await answer(method.name, message, ctx)) as never;
        }) as never);
      }
    }
  };
  const server = http2.createServer(connectNodeAdapter({ routes, grpc: true, connect: false, grpcWeb: false }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

/** The site in front of the stand-in, with an Astro stand-in that says it was reached. */
async function site(machine: ReturnType<typeof createMachineRoute> | undefined): Promise<{ base: string; astro: string[] }> {
  const astro: string[] = [];
  const server = createSiteServer(
    (req, res) => {
      astro.push(String(req.url));
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('astro');
    },
    machine ? { machine } : {},
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, astro };
}

async function stack(answer?: Answer, opts?: Parameters<typeof createMachineRoute>[1]) {
  const api = await standInApi(answer);
  const web = await site(createMachineRoute({ baseUrl: api.baseUrl, timeoutMs: 3000 }, opts));
  return { ...api, ...web };
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/** A raw HTTP/1.1 request: no header the test does not give (no Origin, as a machine client sends none). */
function send(base: string, path: string, { method = 'POST', headers = {}, body }: { method?: string; headers?: Record<string, string>; body?: Uint8Array | string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

const proto = { 'content-type': 'application/proto', 'connect-protocol-version': '1' };
const asCaller = (extra: Record<string, string> = {}) => ({ ...proto, authorization: BEARER, ...extra });
const errorOf = (reply: Reply) => JSON.parse(reply.body.toString('utf8')) as { code: string; message?: string };
const encode = <T extends DescMessage>(schema: T, init: Parameters<typeof create<T>>[1]) => toBinary(schema, create(schema, init));

/** The log lines the route wrote while `run` ran, parsed. */
async function logged(run: () => Promise<void>): Promise<{ lines: Record<string, unknown>[]; text: string }> {
  const out: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => void out.push(String(line)));
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => void out.push(String(line)));
  await run();
  // The line is written when the response closes.
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { lines: out.map((line) => JSON.parse(line) as Record<string, unknown>), text: out.join('\n') };
}

// ---------------------------------------------------------------------------

describe('forwarding', () => {
  it("forwards every method of both services with the caller's bearer, unchanged, and returns the answer as it is", async () => {
    const answers: Record<string, unknown> = {
      ListLinksAwaitingVerdict: { urls: ['https://a.example.org/'], more: true },
      RecordLinkVerdicts: { recorded: 3, notAwaiting: ['https://b.example.org/'] },
      ListEditions: { editions: [{ id: 'ed-1' }] },
      ListEditionItems: { items: [] },
      GetEditionCalendar: { series: [], occurrences: [] },
      GetEditionRoster: { offices: [] },
      ExportEdition: { contentJson: '{"issue":1}', contractVersion: 'v1' },
    };
    const { base, seen, astro } = await stack((rpc) => answers[rpc]);
    const machine = createConnectTransport({ baseUrl: base, httpVersion: '1.1', interceptors: [(next) => (req) => (req.header.set('authorization', BEARER), next(req))] });
    const links = createClient(LinkCheckService, machine);
    const letters = createClient(NewsletterService, machine);
    expect(await links.listLinksAwaitingVerdict({})).toMatchObject(answers['ListLinksAwaitingVerdict'] as object);
    expect(await links.recordLinkVerdicts({ verdicts: [{ url: 'https://b.example.org/', verdict: 2, reasons: ['dead'] }] })).toMatchObject(answers['RecordLinkVerdicts'] as object);
    expect((await letters.listEditions({})).editions.map((e) => e.id)).toEqual(['ed-1']);
    await letters.listEditionItems({ editionId: 'ed-1' });
    await letters.getEditionCalendar({ editionId: 'ed-1' });
    await letters.getEditionRoster({ editionId: 'ed-1' });
    expect(await letters.exportEdition({ editionId: 'ed-1', audience: 1 })).toMatchObject(answers['ExportEdition'] as object);
    expect(seen.map((s) => s.rpc)).toEqual([
      'LinkCheckService/ListLinksAwaitingVerdict',
      'LinkCheckService/RecordLinkVerdicts',
      'NewsletterService/ListEditions',
      'NewsletterService/ListEditionItems',
      'NewsletterService/GetEditionCalendar',
      'NewsletterService/GetEditionRoster',
      'NewsletterService/ExportEdition',
    ]);
    for (const call of seen) expect(call.headers.get('authorization'), call.rpc).toBe(BEARER);
    expect(seen[1]?.message).toMatchObject({ verdicts: [{ url: 'https://b.example.org/', verdict: 2, reasons: ['dead'] }] });
    expect(seen[6]?.message).toMatchObject({ editionId: 'ed-1', audience: 1 });
    expect(astro).toEqual([]);
  });

  it('answers a Connect JSON client too', async () => {
    const { base } = await stack(() => ({ urls: ['https://a.example.org/'], more: false }));
    const reply = await send(base, LIST, { headers: { 'content-type': 'application/json', authorization: BEARER }, body: '{}' });
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body.toString('utf8'))).toEqual({ urls: ['https://a.example.org/'] });
  });

  it("sends the API no other header of the caller's: no cookie, no origin, and the site's own traceparent", async () => {
    const { base, seen } = await stack(() => ({}));
    const callerTrace = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01';
    const { lines } = await logged(async () => {
      const reply = await send(base, LIST, {
        headers: asCaller({
          cookie: `${SESSION_COOKIE}=stolen; other=1`,
          origin: 'https://elsewhere.example.org',
          traceparent: callerTrace,
          'x-forwarded-for': '203.0.113.9',
          'x-extra': 'caller-only',
          'user-agent': 'caller-agent/1',
        }),
        body: new Uint8Array(),
      });
      expect(reply.status).toBe(200);
    });
    const headers = seen[0]?.headers as Headers;
    for (const name of ['cookie', 'origin', 'x-forwarded-for', 'x-extra', 'connect-protocol-version']) expect(headers.get(name), name).toBeNull();
    expect(headers.get('user-agent')).not.toContain('caller-agent');
    const traceparent = headers.get('traceparent') ?? '';
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(traceparent).not.toBe(callerTrace);
    expect(lines.map((l) => l['trace_id'])).toEqual([traceparent.split('-')[1]]);
  });

  it('answers with no cookie and never stores the answer, whatever the request carried', async () => {
    const { base } = await stack(() => ({}));
    const reply = await send(base, LIST, { headers: asCaller({ cookie: `${SESSION_COOKIE}=abc` }), body: new Uint8Array() });
    expect(reply.status).toBe(200);
    expect(reply.headers['set-cookie']).toBeUndefined();
    expect(reply.headers['cache-control']).toBe('private, no-store');
    expect(reply.headers['cdn-cache-control']).toBe('no-store');
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(reply.headers[name.toLowerCase()], name).toBe(value);
    const refused = await send(base, LIST, { headers: proto, body: new Uint8Array() });
    expect(refused.headers['cache-control']).toBe('private, no-store');
    expect(refused.headers['set-cookie']).toBeUndefined();
  });
});

describe('refused before a byte reaches the API', () => {
  it.each([
    ['no Authorization', {}],
    ['another scheme', { authorization: `Basic ${TOKEN}` }],
    ['a bare scheme', { authorization: 'Bearer' }],
    ['two tokens', { authorization: 'Bearer a b' }],
    ['a token that is not one b64token', { authorization: 'Bearer a,b' }],
    ['a tab for the space', { authorization: `Bearer\t${TOKEN}` }],
  ])('%s: unauthenticated', async (_label, headers) => {
    const { base, seen } = await stack();
    const reply = await send(base, RECORD, { headers: { ...proto, ...headers }, body: encode(RecordLinkVerdictsRequestSchema, {}) });
    expect(reply.status).toBe(401);
    expect(errorOf(reply).code).toBe('unauthenticated');
    expect(seen).toEqual([]);
  });

  it('takes the scheme in any case, as the API does, and forwards the header as written', async () => {
    const { base, seen } = await stack(() => ({}));
    expect((await send(base, LIST, { headers: { ...proto, authorization: `bEARER ${TOKEN}` }, body: new Uint8Array() })).status).toBe(200);
    expect(seen[0]?.headers.get('authorization')).toBe(`bEARER ${TOKEN}`);
  });

  it.each([
    '/nwfl.mensa.v1.LinkCheckService/',
    '/nwfl.mensa.v1.LinkCheckService/Nope',
    '/nwfl.mensa.v1.LinkCheckService/listLinksAwaitingVerdict',
    '/nwfl.mensa.v1.LinkCheckService/ListLinksAwaitingVerdict/',
    '/nwfl.mensa.v1.LinkCheckService/ListLinksAwaitingVerdict/x',
    '/nwfl.mensa.v1.NewsletterService/ExportEdition/',
    '/nwfl.mensa.v1.NewsletterService/RecordLinkVerdicts',
    '/nwfl.mensa.v1.NewsletterService/../nwfl.mensa.v1.ContentService/ListPublishedItems/../../nwfl.mensa.v1.NewsletterService/Nope',
  ])('an unknown method, %s: 404', async (path) => {
    const { base, seen, astro } = await stack();
    const reply = await send(base, path, { headers: asCaller(), body: new Uint8Array() });
    expect(reply.status).toBe(404);
    expect(seen).toEqual([]);
    expect(astro).toEqual([]);
  });

  it.each(['GET', 'HEAD', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])('%s on a method: 404, a Connect GET of a read included', async (method) => {
    const { base, seen, astro } = await stack();
    for (const path of [LIST, `${LIST}?encoding=proto&message=&connect=v1`, RECORD, EXPORT]) {
      const reply = await send(base, path, { method, headers: { ...asCaller(), origin: 'http://127.0.0.1' } });
      expect(reply.status, `${method} ${path}`).toBe(404);
    }
    expect(seen).toEqual([]);
    expect(astro).toEqual([]);
  });

  it(`refuses a body over ${MACHINE_BODY_MAX} bytes by its length, unread, and by its bytes when it gives none`, async () => {
    const { base, seen } = await stack(() => ({}));
    const over = new Uint8Array(MACHINE_BODY_MAX + 1);
    const byLength = await send(base, RECORD, { headers: asCaller({ 'content-length': String(over.length) }), body: over });
    expect(byLength.status).toBe(413);
    expect(errorOf(byLength).code).toBe('resource_exhausted');
    const chunked = await send(base, RECORD, { headers: asCaller({ 'transfer-encoding': 'chunked' }), body: over });
    expect(chunked.status).not.toBe(200);
    expect(errorOf(chunked).code).toBe('resource_exhausted');
    expect(seen).toEqual([]);
  });

  it(`forwards a body of exactly ${MACHINE_BODY_MAX} bytes`, async () => {
    const { base, seen } = await stack(() => ({ recorded: 0 }));
    // The url's length, less what its longer length prefixes take (three bytes each at this size, not one).
    const sized = (length: number) => encode(RecordLinkVerdictsRequestSchema, { verdicts: [{ url: `https://n.example.org/${'x'.repeat(length)}`, verdict: 2 }] });
    const body = sized(MACHINE_BODY_MAX - sized(0).length - 4);
    expect(body.length).toBe(MACHINE_BODY_MAX);
    const reply = await send(base, RECORD, { headers: asCaller(), body });
    expect(reply.status).toBe(200);
    expect(fromBinary(RecordLinkVerdictsResponseSchema, reply.body).recorded).toBe(0);
    expect(seen).toHaveLength(1);
  });

  it('refuses a compressed body: it would be unpacked past the cap', async () => {
    const { base, seen } = await stack(() => ({}));
    const reply = await send(base, LIST, { headers: asCaller({ 'content-encoding': 'gzip' }), body: new Uint8Array([0x1f, 0x8b]) });
    expect(reply.status).not.toBe(200);
    expect(seen).toEqual([]);
  });

  // Challenger C-W6: a valid gzip of a valid request, which a server that took gzip would forward.
  it.each(['gzip', 'br'])('refuses a well-formed %s body too, unforwarded', async (encoding) => {
    const { base, seen } = await stack(() => ({ urls: [], more: false }));
    const message = encode(RecordLinkVerdictsRequestSchema, { verdicts: [{ url: 'https://n.example.org/', verdict: 2 }] });
    const body = encoding === 'gzip' ? gzipSync(message) : (await import('node:zlib')).brotliCompressSync(message);
    const reply = await send(base, RECORD, { headers: asCaller({ 'content-encoding': encoding }), body });
    expect({ status: reply.status, error: errorOf(reply) }).toEqual({ status: 501, error: { code: 'unimplemented', message: FIXED.unimplemented } });
    expect(seen).toEqual([]);
  });
});

describe('the API answers', () => {
  it.each([Code.Unauthenticated, Code.PermissionDenied, Code.InvalidArgument, Code.NotFound, Code.FailedPrecondition, Code.ResourceExhausted, Code.Internal])(
    'keep their Connect code (%i), and never its message or details',
    async (code) => {
      const { base } = await stack(() => {
        throw new ConnectError('secret detail about sub-1234 and row 77', code, { 'x-api-internal': 'leak' });
      });
      const reply = await send(base, LIST, { headers: asCaller(), body: new Uint8Array() });
      const error = errorOf(reply);
      expect(error.code).toBe(Code[code].replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase());
      expect(reply.body.toString('utf8')).not.toMatch(/secret|sub-1234|leak/);
      expect(JSON.stringify(reply.headers)).not.toMatch(/secret|leak/);
    },
  );

  it('an API that cannot be reached is unavailable', async () => {
    const web = await site(createMachineRoute({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 3000 }));
    const reply = await send(web.base, LIST, { headers: asCaller(), body: new Uint8Array() });
    expect(errorOf(reply).code).toBe('unavailable');
  });

  it('an answer over the read cap is refused, not handed on', async () => {
    const { base } = await stack(() => ({ contentJson: 'x'.repeat(4 * 1024 * 1024 + 1), contractVersion: 'v1' }));
    const reply = await send(base, EXPORT, { headers: asCaller(), body: encode(ExportEditionRequestSchema, { editionId: 'ed-1' }) });
    expect(reply.status).not.toBe(200);
    expect(errorOf(reply).code).toBe('resource_exhausted');
  });

  it('an API that takes too long is cut off at the call timeout', async () => {
    const { base } = await stack(() => new Promise(() => {}), { callTimeoutMs: 100 });
    const reply = await send(base, LIST, { headers: asCaller(), body: new Uint8Array() });
    expect(errorOf(reply).code).toBe('deadline_exceeded');
  });
});

describe('it cannot starve the pages', () => {
  it(`serves at most ${MACHINE_LIMIT} calls at once; one more is refused at once, unforwarded`, async () => {
    const held: Array<() => void> = [];
    const { base, seen, astro } = await stack(() => new Promise((resolve) => held.push(() => resolve({ urls: [], more: false }))));
    const first = Array.from({ length: MACHINE_LIMIT }, () => send(base, LIST, { headers: asCaller(), body: new Uint8Array() }));
    await vi.waitFor(() => expect(seen).toHaveLength(MACHINE_LIMIT));
    const extra = await send(base, LIST, { headers: asCaller(), body: new Uint8Array() });
    expect(extra.status).toBe(429);
    expect(errorOf(extra).code).toBe('resource_exhausted');
    expect(seen).toHaveLength(MACHINE_LIMIT);
    // A page is served meanwhile.
    expect((await send(base, '/about', { method: 'GET' })).status).toBe(200);
    expect(astro).toEqual(['/about']);
    for (const release of held) release();
    for (const reply of await Promise.all(first)) expect(reply.status).toBe(200);
    held.length = 0;
    const after = send(base, LIST, { headers: asCaller(), body: new Uint8Array() });
    await vi.waitFor(() => expect(held).toHaveLength(1));
    held[0]?.();
    expect((await after).status).toBe(200);
  });

  it('drops a call whose body never ends at the deadline, and frees its place', async () => {
    const { base, seen } = await stack(() => ({}), { limit: 1, deadlineMs: 150 });
    const { port } = new URL(base);
    const slow = await new Promise<string>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: RECORD, method: 'POST', headers: asCaller({ 'content-length': '100' }) });
      req.on('error', (error) => resolve(error.constructor.name));
      req.on('response', (res) => resolve(String(res.statusCode)));
      req.write(new Uint8Array(10));
    });
    expect(slow).toBe('Error');
    expect(seen).toEqual([]);
    expect((await send(base, LIST, { headers: asCaller(), body: new Uint8Array() })).status).toBe(200);
  });
});

/** A socket that sends a call's head and trickles its body, never finishing it; its whole reply, read to its close. */
function slowBody(base: string, authorization = 'Bearer notarealtoken'): Promise<{ reply: string; closedMs: number }> {
  const started = performance.now();
  return new Promise((resolve) => {
    const socket = net.connect(Number(new URL(base).port), '127.0.0.1');
    let reply = '';
    const drip = setInterval(() => socket.write('x'), 50);
    socket.on('data', (d) => (reply += d.toString('latin1')));
    socket.on('close', () => {
      clearInterval(drip);
      resolve({ reply, closedMs: performance.now() - started });
    });
    socket.on('error', () => undefined);
    socket.write(`POST ${RECORD} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: ${authorization}\r\nContent-Type: application/proto\r\nContent-Length: 1000\r\n\r\nx`);
  });
}

describe('a caller whose body is slow (challenger round 1: slot hold)', () => {
  it(`holds no place while its body arrives: ${MACHINE_LIMIT} of them leave a real call served at once`, async () => {
    const { base, seen } = await stack(() => ({ urls: [], more: false }), { bodyMs: 400 });
    const slow = Array.from({ length: MACHINE_LIMIT }, () => slowBody(base));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const started = performance.now();
    const real = await send(base, LIST, { headers: asCaller(), body: new Uint8Array() });
    expect(real.status).toBe(200);
    expect(performance.now() - started).toBeLessThan(400 + 1000);
    expect(seen.map((s) => s.rpc)).toEqual(['LinkCheckService/ListLinksAwaitingVerdict']);
    // Each slow one is refused at the body time with a fixed message, and its connection closed.
    for (const { reply, closedMs } of await Promise.all(slow)) {
      expect(reply.slice(0, 12)).toBe('HTTP/1.1 408');
      expect(reply).toMatch(/\r\nconnection: close\r\n/i);
      expect(JSON.parse(reply.slice(reply.indexOf('\r\n\r\n') + 4))).toEqual({ code: 'deadline_exceeded', message: 'the request body did not arrive in time' });
      expect(closedMs).toBeLessThan(400 + 1000);
    }
    expect(seen).toHaveLength(1);
  });

  it(`gives a body ${MACHINE_BODY_MS / 1000} s to arrive by default`, () => {
    expect(MACHINE_BODY_MS).toBe(5000);
  });

  it('frees the places of calls whose bodies stall once they hold one: a full set of slow bodies with a limit of one', async () => {
    const { base } = await stack(() => ({ urls: [], more: false }), { limit: 1, bodyMs: 200 });
    await Promise.all([slowBody(base), slowBody(base)]);
    expect((await send(base, LIST, { headers: asCaller(), body: new Uint8Array() })).status).toBe(200);
  });
});

describe('the log', () => {
  it('writes one line per call: the method, the code, the time taken and the trace id; never the token or the body', async () => {
    const { base } = await stack((rpc) => {
      if (rpc === 'RecordLinkVerdicts') throw new ConnectError('no', Code.PermissionDenied);
      return { urls: ['https://secret-address.example.org/'], more: false };
    });
    const canary = 'https://canary-body.example.org/';
    const { lines, text } = await logged(async () => {
      await send(base, LIST, { headers: asCaller(), body: new Uint8Array() });
      await send(base, RECORD, { headers: asCaller(), body: encode(RecordLinkVerdictsRequestSchema, { verdicts: [{ url: canary, verdict: 1 }] }) });
      await send(base, RECORD, { headers: proto, body: new Uint8Array() });
      await send(base, '/nwfl.mensa.v1.NewsletterService/Nope', { headers: asCaller(), body: new Uint8Array() });
      await send(base, RECORD, { headers: asCaller({ 'content-length': String(MACHINE_BODY_MAX + 1) }), body: new Uint8Array(MACHINE_BODY_MAX + 1) });
    });
    expect(lines.map(({ time, service, trace_id, ms, ...rest }) => (expect(typeof ms).toBe('number'), expect(trace_id).toMatch(/^[0-9a-f]{32}$/), expect(service).toBe('nwfl-web'), expect(typeof time).toBe('string'), rest))).toEqual([
      { level: 'info', msg: 'machine call', rpc: 'LinkCheckService/ListLinksAwaitingVerdict', code: 'ok' },
      { level: 'warn', msg: 'machine call', rpc: 'LinkCheckService/RecordLinkVerdicts', code: 'permission_denied' },
      { level: 'warn', msg: 'machine call', rpc: 'LinkCheckService/RecordLinkVerdicts', code: 'unauthenticated' },
      { level: 'warn', msg: 'machine call', rpc: 'unknown', code: 'not_found' },
      { level: 'warn', msg: 'machine call', rpc: 'LinkCheckService/RecordLinkVerdicts', code: 'resource_exhausted' },
    ]);
    expect(new Set(lines.map((l) => l['trace_id'])).size).toBe(5);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(canary);
    expect(text).not.toContain('secret-address');
  });

  it('names the code of an answer the route did not write itself by its HTTP status', async () => {
    const { base } = await stack(() => ({}));
    const { lines } = await logged(async () => {
      await send(base, RECORD, { headers: asCaller({ 'transfer-encoding': 'chunked' }), body: new Uint8Array(MACHINE_BODY_MAX + 1) });
      await send(base, LIST, { headers: { authorization: BEARER, 'content-type': 'text/html' }, body: 'x' });
    });
    // The size by the route's own read of the body (resource_exhausted), and a type Connect does not read (415).
    expect(lines.map((l) => l['code'])).toEqual(['resource_exhausted', 'http_415']);
  });
});

// Challenger round 1, item 5: each refusal carries a fixed plain message, never a library's or the API's text.
const FIXED = {
  invalid_argument: 'the request is not valid',
  unimplemented: 'the call is not served in this form',
  permission_denied: 'the call is not permitted',
  unauthenticated: 'the bearer token was refused',
} as const;

describe('the refusals the route writes', () => {
  it.each([
    ['no bearer', RECORD, { ...proto }, new Uint8Array(), 401, { code: 'unauthenticated', message: 'a bearer token is needed' }],
    ['a body too large by its length', RECORD, asCaller({ 'content-length': String(MACHINE_BODY_MAX + 1) }), new Uint8Array(MACHINE_BODY_MAX + 1), 413, { code: 'resource_exhausted', message: 'the request body is too large' }],
    ['a body too large by its bytes', RECORD, asCaller({ 'transfer-encoding': 'chunked' }), new Uint8Array(MACHINE_BODY_MAX + 1), 413, { code: 'resource_exhausted', message: 'the request body is too large' }],
    // Connect calls a body it cannot decode internal; the route keeps the code and writes its own words.
    ['a body that is no message', LIST, asCaller(), new Uint8Array([0xff, 0xff, 0xff]), 500, { code: 'internal', message: 'the call failed' }],
    ['a JSON body that is no message', LIST, { ...asCaller(), 'content-type': 'application/json' }, '{"nope": [', 400, { code: 'invalid_argument', message: FIXED.invalid_argument }],
    ['a timeout that is no number', LIST, asCaller({ 'connect-timeout-ms': 'soon' }), new Uint8Array(), 400, { code: 'invalid_argument', message: FIXED.invalid_argument }],
  ] as const)('%s: a fixed message', async (_label, path, headers, body, status, error) => {
    const { base, seen } = await stack(() => ({ urls: [], more: false }));
    const reply = await send(base, path, { headers: headers as Record<string, string>, body });
    expect({ status: reply.status, error: errorOf(reply) }).toEqual({ status, error });
    expect(reply.body.toString('utf8')).not.toMatch(/readMaxBytes|cannot decode|premature|unexpected|protocol|timeout value/i);
    expect(seen).toEqual([]);
  });

  it('too many at once: a fixed message', async () => {
    const held: Array<() => void> = [];
    const { base } = await stack(() => new Promise((resolve) => held.push(() => resolve({ urls: [], more: false }))), { limit: 1 });
    const first = send(base, LIST, { headers: asCaller(), body: new Uint8Array() });
    await vi.waitFor(() => expect(held).toHaveLength(1));
    const extra = await send(base, LIST, { headers: asCaller(), body: new Uint8Array() });
    expect({ status: extra.status, error: errorOf(extra) }).toEqual({ status: 429, error: { code: 'resource_exhausted', message: 'too many calls at once; try again shortly' } });
    held[0]?.();
    expect((await first).status).toBe(200);
  });

  it('a type Connect does not read: 415 with no body at all', async () => {
    const { base } = await stack(() => ({}));
    const reply = await send(base, LIST, { headers: { authorization: BEARER, 'content-type': 'text/html' }, body: 'x' });
    expect({ status: reply.status, body: reply.body.toString('utf8') }).toEqual({ status: 415, body: '' });
  });

  it.each([
    [Code.PermissionDenied, 403, 'permission_denied'],
    [Code.Unauthenticated, 401, 'unauthenticated'],
  ] as const)("an API refusal (%i) keeps its code and gets the route's fixed message for it", async (code, status, name) => {
    const { base } = await stack(() => {
      throw new ConnectError('secret detail about sub-1234', code);
    });
    const reply = await send(base, LIST, { headers: asCaller(), body: new Uint8Array() });
    expect({ status: reply.status, error: errorOf(reply) }).toEqual({ status, error: { code: name, message: FIXED[name] } });
  });
});

describe('the site guard (challenger round 1: pre-auth crash)', () => {
  it.each([
    ['throws', () => {
      throw new Error('made-up failure');
    }],
    ['rejects', () => Promise.reject(new Error('made-up failure'))],
  ])('a route that %s is answered 500 by the site, which goes on serving pages', async (_label, machine) => {
    const web = await site(machine as unknown as ReturnType<typeof createMachineRoute>);
    const { lines } = await logged(async () => {
      const reply = await send(web.base, LIST, { headers: asCaller(), body: new Uint8Array() });
      expect({ status: reply.status, body: reply.body.toString('utf8') }).toEqual({ status: 500, body: 'Internal Server Error' });
    });
    expect(lines.map((l) => [l['msg'], l['err']])).toEqual([['request failed', 'Error']]);
    expect((await send(web.base, '/about', { method: 'GET' })).status).toBe(200);
  });
});

describe('the Origin rule (Added 07:3xC)', () => {
  it('lets a POST with no Origin reach the route on the two prefixes only', async () => {
    const { base, seen, astro } = await stack(() => ({}));
    expect((await send(base, LIST, { headers: asCaller(), body: new Uint8Array() })).status).toBe(200);
    expect((await send(base, EXPORT, { headers: asCaller(), body: new Uint8Array() })).status).toBe(200);
    expect(seen).toHaveLength(2);
    for (const path of [
      '/nwfl.mensa.v1.LinkCheckServiceX/ListLinksAwaitingVerdict',
      '/nwfl.mensa.v1.linkcheckservice/ListLinksAwaitingVerdict',
      '/x/nwfl.mensa.v1.LinkCheckService/ListLinksAwaitingVerdict',
      '/nwfl.mensa.v1.ContentService/ListPublishedItems',
      '/nwfl.mensa.v1.LinkCheckService',
      '/sign-out',
      '/officers/editor',
    ]) {
      expect((await send(base, path, { headers: asCaller(), body: new Uint8Array() })).status, path).toBe(403);
    }
    // POST only: any other method on the prefixes still needs an Origin.
    expect((await send(base, LIST, { method: 'PUT', headers: asCaller(), body: new Uint8Array() })).status).toBe(403);
    expect(astro).toEqual([]);
    expect(seen).toHaveLength(2);
  });

  it('leaves the rule as it was everywhere else: a POST with an Origin goes on to Astro', async () => {
    const { base, astro } = await stack();
    expect((await send(base, '/nwfl.mensa.v1.ContentService/ListPublishedItems', { headers: { ...asCaller(), origin: 'http://127.0.0.1' }, body: '' })).status).toBe(200);
    expect(astro).toEqual(['/nwfl.mensa.v1.ContentService/ListPublishedItems']);
  });

  it('a cross-site POST still needs a bearer, and the API still judges it', async () => {
    const { base, seen } = await stack((_rpc, _message, ctx) => {
      if (ctx.requestHeader.get('authorization') !== BEARER) throw new ConnectError('bad token', Code.Unauthenticated);
      return {};
    });
    const crossSite = { origin: 'https://evil.example.net', 'sec-fetch-site': 'cross-site' };
    const bare = await send(base, LIST, { headers: { ...proto, ...crossSite }, body: new Uint8Array() });
    expect(errorOf(bare).code).toBe('unauthenticated');
    expect(seen).toEqual([]);
    const wrong = await send(base, LIST, { headers: { ...proto, ...crossSite, authorization: 'Bearer not-the-token' }, body: new Uint8Array() });
    expect(errorOf(wrong).code).toBe('unauthenticated');
    expect(seen).toHaveLength(1);
    expect((await send(base, LIST, { headers: { ...asCaller(), ...crossSite }, body: new Uint8Array() })).status).toBe(200);
  });
});

describe('without the route (a public-only build, or no API)', () => {
  it('answers 404 on the prefixes, with or without an Origin, and never reaches Astro', async () => {
    const web = await site(undefined);
    for (const path of [LIST, RECORD, EXPORT, '/nwfl.mensa.v1.LinkCheckService/Nope']) {
      expect((await send(web.base, path, { headers: asCaller(), body: new Uint8Array() })).status, path).toBe(404);
      expect((await send(web.base, path, { headers: { ...asCaller(), origin: 'http://127.0.0.1' }, body: new Uint8Array() })).status, path).toBe(404);
    }
    expect((await send(web.base, LIST, { method: 'GET' })).status).toBe(404);
    expect(web.astro).toEqual([]);
  });
});

describe('machineRouteFromEnv', () => {
  it('is the route when API_URL is a valid origin, and none without one or with a bad one', () => {
    expect(machineRouteFromEnv({})).toBeUndefined();
    expect(machineRouteFromEnv({ API_URL: 'not a url' })).toBeUndefined();
    expect(machineRouteFromEnv({ API_URL: 'http://api.example.org/path' })).toBeUndefined();
    expect(typeof machineRouteFromEnv({ API_URL: 'http://127.0.0.1:1' })).toBe('function');
  });
});

describe('unaryMethods', () => {
  it('names every method of a service of unary calls, and refuses a service with a stream', () => {
    expect(unaryMethods(LinkCheckService).map((m) => m.name)).toEqual(['ListLinksAwaitingVerdict', 'RecordLinkVerdicts']);
    expect(() => unaryMethods(ContentService)).toThrow(/ReadFile is not a unary call/);
  });
});

