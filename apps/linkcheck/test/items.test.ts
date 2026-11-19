// L-ITEM: the items mode (items.ts). The verdict mapping, the four LinkCheckService messages written and
// read by hand, the token, one Connect call, and the run, against stand-in servers on this container's own
// loopback. apps/api test/links/linkcheck-items.test.ts holds the messages to the API's generated code, and
// apps/web test/machine-route-live.test.ts drives the same code through the site's route to the real API
// (MACHINE-ROUTE). Every address is made up.
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { VERDICTS, checkAll, makeChecker } from '../src/check.js';
import { main, type Io } from '../src/cli.js';
import {
  type CheckVerdict,
  ItemsError,
  MACHINE,
  MAX_ANSWER_BYTES,
  MAX_RECORD_BYTES,
  MAX_RECORD_VERDICTS,
  MAX_ROUNDS,
  NEW_DOMAIN_DAYS,
  clientCredentials,
  decodeListResponse,
  decodeRecordResponse,
  encodeRecordRequest,
  endpoint,
  connectCall,
  newDomainSince,
  recordRequests,
  runItems,
  storedVerdict,
} from '../src/items.js';
import { type Stand, fakeDns, routedConnect, startHttps, testPki } from './helpers/servers.js';

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);
const ascii = (value: string): number[] => [...new TextEncoder().encode(value)];

describe('the verdict mapping', () => {
  it('names every verdict check.ts gives', () => {
    const all: readonly CheckVerdict[] = VERDICTS;
    expect([...all].sort()).toEqual(['confirm', 'drop', 'flag', 'ok', 'review', 'upgrade']);
  });

  it.each([
    ['ok', MACHINE.OK],
    ['upgrade', MACHINE.CONFIRM],
    ['confirm', MACHINE.CONFIRM],
    ['review', MACHINE.CONFIRM],
    ['flag', MACHINE.CONFIRM],
    ['drop', MACHINE.DROP],
  ] as const)('stores %s as %i', (verdict, stored) => {
    expect(storedVerdict({ url: 'https://a.example.org/', verdict, reasons: [] })).toEqual({ url: 'https://a.example.org/', verdict: stored, reasons: [] });
  });

  it('keeps the reason codes once each, at most 8', () => {
    const reasons = ['dead', 'dead', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    expect(storedVerdict({ url: 'u', verdict: 'drop', reasons }).reasons).toEqual(['dead', 'a', 'b', 'c', 'd', 'e', 'f', 'g']);
  });
});

describe('the messages', () => {
  it('writes RecordLinkVerdictsRequest field by field', () => {
    const one = [...[0x0a, 3], ...ascii('u:1'), 0x10, 3, ...[0x1a, 4], ...ascii('dead')];
    expect(encodeRecordRequest([{ url: 'u:1', verdict: MACHINE.DROP, reasons: ['dead'] }])).toEqual(bytes(0x0a, one.length, ...one));
    expect(encodeRecordRequest([])).toEqual(bytes());
  });

  it('writes a length over 127 as a varint', () => {
    const url = `https://example.org/${'a'.repeat(200)}`;
    const out = encodeRecordRequest([{ url, verdict: MACHINE.OK, reasons: [] }]);
    // Outer length 225 (2 bytes): the URL's tag, its length 220 (2 bytes), the URL, the verdict's tag and value.
    expect([...out.subarray(0, 6)]).toEqual([0x0a, 0xe1, 0x01, 0x0a, 0xdc, 0x01]);
    expect(out.length).toBe(3 + 3 + 220 + 2);
  });

  it('reads ListLinksAwaitingVerdictResponse, skipping fields it does not know', () => {
    const answer = bytes(0x0a, 3, ...ascii('a:1'), 0x0a, 3, ...ascii('b:2'), 0x10, 1, 0x18, 0x96, 0x01, 0x21, 1, 2, 3, 4, 5, 6, 7, 8, 0x2d, 1, 2, 3, 4, 0x32, 1, 0x7a);
    expect(decodeListResponse(answer)).toEqual({ urls: ['a:1', 'b:2'], more: true });
    expect(decodeListResponse(bytes())).toEqual({ urls: [], more: false });
    expect(decodeListResponse(bytes(0x10, 0))).toEqual({ urls: [], more: false });
  });

  it('reads RecordLinkVerdictsResponse', () => {
    expect(decodeRecordResponse(bytes(0x08, 0xac, 0x02, 0x12, 3, ...ascii('c:3')))).toEqual({ recorded: 300, notAwaiting: ['c:3'] });
    expect(decodeRecordResponse(bytes())).toEqual({ recorded: 0, notAwaiting: [] });
  });

  it.each([
    ['a length past the end', bytes(0x0a, 9, 1)],
    ['a varint cut short', bytes(0x08, 0x80)],
    ['a varint of more than 10 bytes', bytes(0x08, ...Array.from({ length: 11 }, () => 0x80))],
    ['a fixed64 cut short', bytes(0x21, 1, 2)],
    ['a group', bytes(0x0b)],
    ['text that is not UTF-8', bytes(0x0a, 1, 0xff)],
  ])('refuses %s', (_label, answer) => {
    expect(() => decodeListResponse(answer)).toThrow(ItemsError);
  });

  it('reads a field of another wire type than its own as unknown, and refuses an address that is not UTF-8', () => {
    expect(decodeListResponse(bytes(0x08, 1, 0x12, 1, 0x41))).toEqual({ urls: [], more: false });
    expect(decodeRecordResponse(bytes(0x0a, 1, 0x41, 0x10, 1))).toEqual({ recorded: 0, notAwaiting: [] });
    expect(() => decodeRecordResponse(bytes(0x12, 1, 0xc3))).toThrow(/UTF-8/);
  });
});

describe('endpoint', () => {
  it('takes https, and http to this machine only', () => {
    expect(endpoint('X', 'https://api.example.org/base').href).toBe('https://api.example.org/base');
    for (const local of ['http://127.0.0.1:26100', 'http://localhost:26100', 'http://[::1]:26100']) expect(endpoint('X', local).protocol).toBe('http:');
    for (const bad of [undefined, '', 'not a url', 'http://api.example.org/', 'ftp://127.0.0.1/']) expect(() => endpoint('LINKCHECK_API_URL', bad)).toThrow('LINKCHECK_API_URL must be an https URL');
  });
});

describe('clientCredentials', () => {
  const request = { tokenUrl: new URL('https://login.example.org/application/o/token/'), clientId: 'nwfl-linkcheck', username: 'svc-nwfl-linkcheck', password: 'app-password', scope: 'links.check' };
  const answering = (status: number, body: string, seen: Array<{ url: string; init: RequestInit | undefined }> = []): typeof fetch =>
    ((url: URL, init?: RequestInit) => {
      seen.push({ url: String(url), init });
      return Promise.resolve(new Response(body, { status }));
    }) as typeof fetch;

  it("posts Authentik's machine-to-machine form and returns the access token", async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    expect(await clientCredentials(request, answering(200, JSON.stringify({ access_token: 'eyJ.abc-_.x', token_type: 'Bearer' }), seen))).toBe('eyJ.abc-_.x');
    expect(seen[0]?.url).toBe('https://login.example.org/application/o/token/');
    expect(seen[0]?.init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(Object.fromEntries(seen[0]?.init?.body as URLSearchParams)).toEqual({
      grant_type: 'client_credentials',
      client_id: 'nwfl-linkcheck',
      username: 'svc-nwfl-linkcheck',
      password: 'app-password',
      scope: 'links.check',
    });
  });

  it.each([
    ['a refusal', answering(401, '{}'), /refused the sign-in \(HTTP 401\)/],
    ['an answer that is not JSON', answering(200, '<html>'), /other than JSON/],
    ['no token', answering(200, '{}'), /no access token/],
    ['a token that is not a bearer token', answering(200, JSON.stringify({ access_token: 'a b\r\nX: y' })), /no access token/],
    ['no answer at all', (() => Promise.reject(new TypeError('fetch failed'))), /could not be reached/],
  ])('refuses %s', async (_label, fetcher, message) => {
    await expect(clientCredentials(request, fetcher)).rejects.toThrow(message);
  });
});

// ---------------------------------------------------------------------------
// A stand-in for the site's Connect route (HTTP/1.1 on loopback).

interface Call {
  path: string;
  method: string;
  authorization: string | undefined;
  contentType: string | undefined;
  protocolVersion: string | undefined;
  body: Uint8Array;
}
/** Success: the message, as application/proto. Otherwise: the HTTP status, and a body and type of the test's choosing. */
type Answer = { status: 0; message: Uint8Array } | { http: number; contentType?: string; raw?: Buffer | string; location?: string };

const servers: http.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function standIn(answer: (call: Call) => Answer): Promise<{ url: URL; calls: Call[] }> {
  const calls: Call[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const call = {
        path: String(req.url),
        method: String(req.method),
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        protocolVersion: req.headers['connect-protocol-version'] as string | undefined,
        body: new Uint8Array(Buffer.concat(chunks)),
      };
      calls.push(call);
      const reply = answer(call);
      if ('message' in reply) {
        res.writeHead(200, { 'content-type': 'application/proto' }).end(Buffer.from(reply.message));
        return;
      }
      res.writeHead(reply.http, { ...(reply.contentType !== undefined ? { 'content-type': reply.contentType } : {}), ...(reply.location !== undefined ? { location: reply.location } : {}) }).end(reply.raw ?? '');
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`), calls };
}

const list = (urls: string[], more = false): Uint8Array => bytes(...urls.flatMap((u) => [0x0a, u.length, ...ascii(u)]), ...(more ? [0x10, 1] : []));
const recorded = (n: number, notAwaiting: string[] = []): Uint8Array => bytes(0x08, n, ...notAwaiting.flatMap((u) => [0x12, u.length, ...ascii(u)]));
const connectError = (http: number, body: unknown): Answer => ({ http, contentType: 'application/json', raw: JSON.stringify(body) });

describe('connectCall', () => {
  it('posts the message as Connect binary to the method with the bearer token, and returns the answer', async () => {
    const { url, calls } = await standIn(() => ({ status: 0, message: list(['https://a.example.org/']) }));
    expect(decodeListResponse(await connectCall(url, 'ListLinksAwaitingVerdict', 'tok-1', bytes()))).toEqual({ urls: ['https://a.example.org/'], more: false });
    expect(calls).toEqual([
      { path: '/nwfl.mensa.v1.LinkCheckService/ListLinksAwaitingVerdict', method: 'POST', authorization: 'Bearer tok-1', contentType: 'application/proto', protocolVersion: '1', body: bytes() },
    ]);
  });

  it('keeps a base path, and sends the message bytes as they are', async () => {
    const { url, calls } = await standIn(() => ({ status: 0, message: bytes() }));
    await connectCall(new URL(`${url.origin}/api/`), 'RecordLinkVerdicts', 't', bytes(1, 2));
    expect(calls[0]).toMatchObject({ path: '/api/nwfl.mensa.v1.LinkCheckService/RecordLinkVerdicts', body: bytes(1, 2) });
  });

  it.each([
    ['a Connect refusal, with its message', connectError(400, { code: 'invalid_argument', message: 'the link checker cannot accept' }), 'the API refused the call: INVALID_ARGUMENT (the link checker cannot accept)'],
    ['a Connect refusal with no message', connectError(401, { code: 'unauthenticated' }), 'the API refused the call: UNAUTHENTICATED'],
    ['a refusal of the size', connectError(413, { code: 'resource_exhausted', message: '' }), 'the API refused the call: RESOURCE_EXHAUSTED'],
    ['a code Connect does not name', connectError(400, { code: 'not_a_code', message: 'x' }), 'the API refused the call: HTTP 400'],
    ['a refusal that is not JSON', { http: 404, contentType: 'text/plain', raw: 'Not found' }, 'the API refused the call: HTTP 404'],
    ['a refusal that is JSON but no object', connectError(503, ['unavailable']), 'the API refused the call: HTTP 503'],
    ['a message with control characters', connectError(403, { code: 'permission_denied', message: 'no\nway' }), 'the API refused the call: PERMISSION_DENIED (no way)'],
    ['a message that is not text', connectError(403, { code: 'permission_denied', message: 7 }), 'the API refused the call: PERMISSION_DENIED'],
    ['an answer that is not application/proto', { http: 200, contentType: 'application/json', raw: '{}' }, 'the API answer is not one plain Connect message'],
    ['an answer with no type', { http: 200, raw: 'x' }, 'the API answer is not one plain Connect message'],
    ['a redirect, never followed with the token', { http: 302, location: 'https://elsewhere.example.org/' }, /^the API could not be reached \(\w+\)$/],
  ] as const)('refuses %s', async (_label, reply, message) => {
    const { url, calls } = await standIn(() => reply);
    await expect(connectCall(url, 'X', 't', bytes())).rejects.toThrow(message);
    expect(calls).toHaveLength(1);
  });

  it('takes application/proto with parameters', async () => {
    const { url } = await standIn(() => ({ http: 200, contentType: 'application/proto; charset=binary', raw: Buffer.from(recorded(2)) }));
    expect(decodeRecordResponse(await connectCall(url, 'X', 't', bytes()))).toEqual({ recorded: 2, notAwaiting: [] });
  });

  it('refuses an answer over its size cap, and a refusal over its own', async () => {
    const big = await standIn(() => ({ http: 200, contentType: 'application/proto', raw: Buffer.alloc(MAX_ANSWER_BYTES + 1) }));
    await expect(connectCall(big.url, 'X', 't', bytes())).rejects.toThrow('the API answer is too large');
    const exact = await standIn(() => ({ http: 200, contentType: 'application/proto', raw: Buffer.alloc(MAX_ANSWER_BYTES) }));
    expect(await connectCall(exact.url, 'X', 't', bytes())).toHaveLength(MAX_ANSWER_BYTES);
    const refusal = await standIn(() => ({ http: 500, contentType: 'application/json', raw: `{"code":"internal","message":"${'x'.repeat(70_000)}"}` }));
    await expect(connectCall(refusal.url, 'X', 't', bytes())).rejects.toThrow('the API refused the call: HTTP 500');
  });

  it('refuses an answer cut short', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/proto', 'content-length': '100' });
      res.write(Buffer.alloc(10));
      setTimeout(() => res.destroy(), 20);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    await expect(connectCall(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`), 'X', 't', bytes())).rejects.toThrow('the API answer was cut short');
  });

  // Challenger C-L1: the redirect's target is a live server on this machine, so following it would show.
  it.each([
    ['to another origin', true],
    ['to another path of the same origin', false],
  ])('never follows a redirect %s: nothing is sent there, the bearer least of all', async (_label, otherOrigin) => {
    const target = await standIn(() => ({ status: 0, message: bytes() }));
    const first = await standIn((call) => (call.path === '/moved' ? { status: 0, message: bytes() } : { http: 307, location: otherOrigin ? `${target.url.origin}/moved` : '/moved' }));
    await expect(connectCall(first.url, 'X', 't', bytes())).rejects.toThrow(/^the API could not be reached \(\w+\)$/);
    expect(first.calls.map((c) => c.path)).toEqual(['/nwfl.mensa.v1.LinkCheckService/X']);
    expect(target.calls).toEqual([]);
  });

  // Challenger C-L4: an API that takes the call and never answers, or answers only its head.
  it.each([
    ['says nothing', () => undefined],
    ['sends its head and stalls', (_req: IncomingMessage, res: ServerResponse) => void res.writeHead(200, { 'content-type': 'application/proto', 'content-length': '10' }).write(Buffer.alloc(2))],
  ])('gives up on an API that %s at the call time', async (_label, handler) => {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const started = performance.now();
    await expect(connectCall(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`), 'X', 't', bytes(), 200)).rejects.toThrow('the API did not answer in time');
    expect(performance.now() - started).toBeLessThan(2000);
  }, 5000);

  it('never sends a token that is not a bearer token, and names an unreachable API by its error class only', async () => {
    await expect(connectCall(new URL('http://127.0.0.1:1'), 'X', 'a b', bytes())).rejects.toThrow('the token is not a bearer token');
    await expect(connectCall(new URL('http://127.0.0.1:1'), 'X', 't', bytes())).rejects.toThrow(/^the API could not be reached \(\w+\)$/);
  });
});

describe('runItems', () => {
  const checker = (verdicts: Record<string, CheckVerdict>) => (urls: readonly string[]) => Promise.resolve(urls.map((url) => ({ url, verdict: verdicts[url] ?? 'ok', reasons: verdicts[url] === 'drop' ? ['dead'] : [] })));

  it('lists, checks, records, and asks again while more wait', async () => {
    let lists = 0;
    const { url, calls } = await standIn((call) => {
      if (call.path.endsWith('/ListLinksAwaitingVerdict')) {
        lists += 1;
        return { status: 0, message: lists === 1 ? list(['https://a.example.org/', 'https://b.example.org/'], true) : list(['https://c.example.org/']) };
      }
      return { status: 0, message: lists === 1 ? recorded(3) : recorded(0, ['https://c.example.org/']) };
    });
    const totals = await runItems({ api: url, token: 't', check: checker({ 'https://b.example.org/': 'drop', 'https://c.example.org/': 'flag' }) });
    expect(totals).toEqual({ checked: 3, ok: 1, confirm: 1, drop: 1, recorded: 3, notAwaiting: 1, more: false });
    expect(calls.map((c) => c.path.split('/').at(-1))).toEqual(['ListLinksAwaitingVerdict', 'RecordLinkVerdicts', 'ListLinksAwaitingVerdict', 'RecordLinkVerdicts']);
    expect(calls[1]?.body).toEqual(encodeRecordRequest([{ url: 'https://a.example.org/', verdict: MACHINE.OK, reasons: [] }, { url: 'https://b.example.org/', verdict: MACHINE.DROP, reasons: ['dead'] }]));
  });

  it('stops on an empty list, and on a round that records nothing (it would be handed the same list)', async () => {
    const empty = await standIn(() => ({ status: 0, message: list([]) }));
    expect(await runItems({ api: empty.url, token: 't', check: checker({}) })).toMatchObject({ checked: 0, recorded: 0 });
    expect(empty.calls).toHaveLength(1);
    const stuck = await standIn((call) => (call.path.endsWith('/ListLinksAwaitingVerdict') ? { status: 0, message: list(['https://a.example.org/'], true) } : { status: 0, message: recorded(0) }));
    expect(await runItems({ api: stuck.url, token: 't', check: checker({}) })).toMatchObject({ checked: 1, recorded: 0, more: true });
    expect(stuck.calls).toHaveLength(2);
  });

  it(`stops after ${MAX_ROUNDS} lists`, async () => {
    const endless = await standIn((call) => (call.path.endsWith('/ListLinksAwaitingVerdict') ? { status: 0, message: list(['https://a.example.org/'], true) } : { status: 0, message: recorded(1) }));
    expect(await runItems({ api: endless.url, token: 't', check: checker({}) })).toMatchObject({ checked: MAX_ROUNDS, recorded: MAX_ROUNDS, more: true });
  });
});

describe('the items command', () => {
  const ioFor = (env: Record<string, string>, files: Record<string, string>, fetcher: typeof fetch): Io & { out: string[]; err: string[] } => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      readFile: (path) => (files[path] === undefined ? Promise.reject(new Error('ENOENT')) : Promise.resolve(new TextEncoder().encode(files[path]))),
      writeFile: () => Promise.reject(new Error('items writes no file')),
      print: (line) => out.push(line),
      warn: (line) => err.push(line),
      env,
      now: () => new Date('2026-11-15T15:00:00Z'),
      checkDeps: (issueDate) => deps(issueDate),
      extract: () => Promise.reject(new Error('items reads no PDF')),
      fetch: fetcher,
    };
  };
 // Offline: only the Facebook host resolves (it is never fetched); any other name is NXDOMAIN.
  const deps = (issueDate: string) => ({ dns: fakeDns({ 'www.facebook.com': ['157.240.1.35'] }), connect: () => Promise.reject(new Error('no network in this test')), issueDate });
  const token: typeof fetch = (() => Promise.resolve(new Response(JSON.stringify({ access_token: 'stand-in-token' }))));

  it('signs in, checks the addresses handed out, records them, and prints counts only', async () => {
    const { url, calls } = await standIn((call) =>
      call.path.endsWith('/ListLinksAwaitingVerdict') ? { status: 0, message: list(['https://secret-a.example.org/', 'https://www.facebook.com/groups/example']) } : { status: 0, message: recorded(2) },
    );
    const io = ioFor({ LINKCHECK_API_URL: url.href, LINKCHECK_TOKEN_URL: 'https://login.example.org/token/', LINKCHECK_PASSWORD_FILE: '/run/pw' }, { '/run/pw': 'app-password\n' }, token);
    expect(await main(['items'], io)).toBe(0);
    expect(io.out).toEqual(['items: 2 addresses checked: 0 ok, 1 confirm, 1 drop; 2 recorded, 0 no longer waiting']);
    expect(io.out.join('\n')).not.toContain('example');
    expect(calls.every((c) => c.authorization === 'Bearer stand-in-token')).toBe(true);
    // The very check.ts results, with the day 90 days back as the issue date, each mapped; a login-walled host is never OK.
    const results = await checkAll(['https://secret-a.example.org/', 'https://www.facebook.com/groups/example'], deps('2026-08-17'));
    expect(results.map((r) => [r.verdict, storedVerdict(r).verdict])).toEqual([
      ['drop', MACHINE.DROP],
      ['confirm', MACHINE.CONFIRM],
    ]);
    expect(calls[1]?.body).toEqual(encodeRecordRequest(results.map(storedVerdict)));
  });

  it('says when more wait', async () => {
    const { url } = await standIn((call) => (call.path.endsWith('/ListLinksAwaitingVerdict') ? { status: 0, message: list(['mailto:a@example.org'], true) } : { status: 0, message: recorded(0) }));
    const io = ioFor({ LINKCHECK_API_URL: url.href, LINKCHECK_TOKEN_URL: 'https://login.example.org/token/', LINKCHECK_PASSWORD_FILE: '/run/pw' }, { '/run/pw': 'pw' }, token);
    expect(await main(['items'], io)).toBe(0);
    expect(io.out).toEqual(['items: 1 addresses checked: 0 ok, 0 confirm, 1 drop; 0 recorded, 0 no longer waiting; more wait, run again']);
  });

  it.each([
    ['no API URL', {}, {}, 'linkcheck: LINKCHECK_API_URL must be an https URL'],
    ['an http API URL off this machine', { LINKCHECK_API_URL: 'http://api.example.org/' }, {}, 'linkcheck: LINKCHECK_API_URL must be an https URL'],
    ['no token URL', { LINKCHECK_API_URL: 'https://api.example.org/' }, {}, 'linkcheck: LINKCHECK_TOKEN_URL must be an https URL'],
    ['no password file', { LINKCHECK_API_URL: 'https://api.example.org/', LINKCHECK_TOKEN_URL: 'https://login.example.org/' }, {}, 'linkcheck: LINKCHECK_PASSWORD_FILE is needed'],
    ['a password file it cannot read', { LINKCHECK_API_URL: 'https://api.example.org/', LINKCHECK_TOKEN_URL: 'https://login.example.org/', LINKCHECK_PASSWORD_FILE: '/run/none' }, {}, 'linkcheck: cannot read /run/none'],
    ['an empty password file', { LINKCHECK_API_URL: 'https://api.example.org/', LINKCHECK_TOKEN_URL: 'https://login.example.org/', LINKCHECK_PASSWORD_FILE: '/run/pw' }, { '/run/pw': '\n' }, 'linkcheck: /run/pw is empty'],
  ])('refuses %s, with exit code 1', async (_label, env, files, message) => {
    const io = ioFor(env, files, token);
    expect(await main(['items'], io)).toBe(1);
    expect(io.err).toEqual([message]);
  });

  it('reports a refused sign-in, and takes no flag', async () => {
    const io = ioFor({ LINKCHECK_API_URL: 'https://api.example.org/', LINKCHECK_TOKEN_URL: 'https://login.example.org/', LINKCHECK_PASSWORD_FILE: '/run/pw' }, { '/run/pw': 'pw' }, (() =>
      Promise.resolve(new Response('', { status: 400 }))));
    expect(await main(['items'], io)).toBe(1);
    expect(io.err).toEqual(['linkcheck: the identity provider refused the sign-in (HTTP 400)']);
    expect(await main(['items', '--out', 'x'], io)).toBe(2);
  });
});

// Fix round 1 (GATE-2): a piece is about now, so "after the issue date" would never fire with today as
// the date. In items mode a domain registered in the last NEW_DOMAIN_DAYS days is a person's call.
describe('a newly registered domain in items mode', () => {
  const A = '93.184.216.1';
  const pki = testPki(['squat.example', 'hop.example']);
  let tls: Stand;
  const route = (req: IncomingMessage, res: ServerResponse): void => {
    const host = (req.headers.host ?? '').split(':')[0];
    if (host === 'hop.example' && req.url === '/') {
      res.writeHead(302, { location: 'https://hop.example/login' }).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end('<p>Welcome to the club page. Lots of real text here about events and lunches.</p>');
  };
  beforeAll(async () => {
    tls = await startHttps(route, pki);
  });
  afterAll(async () => {
    await tls.close();
  });
  const net = (issueDate: string, registered: string) => ({
    dns: fakeDns({ 'squat.example': [A], 'hop.example': [A] }, { ns: {} }),
    connect: routedConnect({ [`${A}:443`]: tls.port }, pki.ca),
    rdap: { registered: () => Promise.resolve({ status: 'dated' as const, date: registered }) },
    issueDate,
    limits: { hopMs: 500 },
  });

  it(`counts back ${NEW_DOMAIN_DAYS} days from today, in UTC`, () => {
    expect(NEW_DOMAIN_DAYS).toBe(90);
    expect(newDomainSince(new Date('2026-11-16T15:00:00Z'))).toBe('2026-08-18');
    expect(newDomainSince(new Date('2026-03-31T23:59:59Z'))).toBe('2025-12-31');
  });

  it.each([
    ['last week', '2026-11-10', MACHINE.CONFIRM, ['re-registered']],
    ['89 days ago', '2026-08-19', MACHINE.CONFIRM, ['re-registered']],
    ['90 days ago', '2026-08-18', MACHINE.OK, []],
    ['years ago', '2011-04-02', MACHINE.OK, []],
  ] as const)('a domain registered %s (%s) is recorded as verdict %i', async (_label, registered, verdict, reasons) => {
    const seen: string[] = [];
    const { url, calls } = await standIn((call) => (call.path.endsWith('/ListLinksAwaitingVerdict') ? { status: 0, message: list(['https://squat.example/']) } : { status: 0, message: recorded(1) }));
    const out: string[] = [];
    const io: Io = {
      readFile: () => Promise.resolve(new TextEncoder().encode('app-password\n')),
      writeFile: () => Promise.reject(new Error('items writes no file')),
      print: (line) => out.push(line),
      warn: (line) => out.push(line),
      env: { LINKCHECK_API_URL: url.href, LINKCHECK_TOKEN_URL: 'https://login.example.org/token/', LINKCHECK_PASSWORD_FILE: '/run/pw' },
      now: () => new Date('2026-11-16T15:00:00Z'),
      checkDeps: (issueDate) => {
        seen.push(issueDate);
        return net(issueDate, registered);
      },
      extract: () => Promise.reject(new Error('items reads no PDF')),
      fetch: () => Promise.resolve(new Response(JSON.stringify({ access_token: 'stand-in-token' }))),
    };
    expect(await main(['items'], io)).toBe(0);
    expect(seen).toEqual(['2026-08-18']);
    expect(calls[1]?.body).toEqual(encodeRecordRequest([{ url: 'https://squat.example/', verdict, reasons: [...reasons] }]));
    expect(out).toEqual([`items: 1 addresses checked: ${verdict === MACHINE.OK ? 1 : 0} ok, ${verdict === MACHINE.CONFIRM ? 1 : 0} confirm, 0 drop; 1 recorded, 0 no longer waiting`]);
  });

  // Challenger C3 (round 0, held): a redirect on the same site is followed, and the page it ends on is the one judged.
  it('follows a redirect on the same site and judges where it ends', async () => {
    const result = await makeChecker(net('2026-08-18', '2011-04-02')).check('https://hop.example/');
    expect(result.chain).toEqual([
      { url: 'https://hop.example/', status: 302 },
      { url: 'https://hop.example/login', status: 200 },
    ]);
    expect(storedVerdict(result)).toEqual({ url: 'https://hop.example/', verdict: MACHINE.OK, reasons: [] });
  });
});

// Challenger C4 to C7 (round 0, held): a hostile API answer costs a bounded amount and tells nothing.
describe('a hostile API', () => {
  it('reads the most empty addresses its size cap lets through', () => {
    const count = MAX_ANSWER_BYTES / 2;
    const answer = new Uint8Array(MAX_ANSWER_BYTES);
    for (let i = 0; i < count; i += 1) answer[2 * i] = 0x0a;
    expect(decodeListResponse(answer).urls).toHaveLength(count);
  });

  it.each([
    ['a length of 2^63', [0x0a, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f], 'the API answer is cut short'],
    ['an 11-byte varint', [0x10, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01], 'the API answer holds a bad number'],
    ['a group', [0x0b], 'the API answer is not a message this checker reads'],
    ['a huge field number', [0xff, 0xff, 0xff, 0xff, 0x7a, 0x00], 'the API answer is not a message this checker reads'],
    ['an address that is not UTF-8', [0x0a, 0x01, 0xff], 'the API answer holds text that is not UTF-8'],
  ])('refuses %s', (_label, given, message) => {
    expect(() => decodeListResponse(bytes(...given))).toThrow(new ItemsError(message));
  });

  it('reads field 0 as unknown, and a 10-byte "more" as true', () => {
    expect(decodeListResponse(bytes(0x02, 0x00))).toEqual({ urls: [], more: false });
    expect(decodeListResponse(bytes(0x10, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x02))).toEqual({ urls: [], more: true });
  });

  it(`stops an endless list after ${MAX_ROUNDS} lists and as many records`, async () => {
    const { url, calls } = await standIn((call) => (call.path.endsWith('/ListLinksAwaitingVerdict') ? { status: 0, message: list(['https://site.example/aaaa'], true) } : { status: 0, message: recorded(1) }));
    let checked = 0;
    const totals = await runItems({
      api: url,
      token: 'abc',
      check: (urls) => {
        checked += urls.length;
        return Promise.resolve(urls.map((u) => ({ url: u, verdict: 'ok' as const, reasons: [] })));
      },
    });
    expect(totals).toEqual({ checked: MAX_ROUNDS, ok: MAX_ROUNDS, confirm: 0, drop: 0, recorded: MAX_ROUNDS, notAwaiting: 0, more: true });
    expect(checked).toBe(MAX_ROUNDS);
    expect(calls.filter((c) => c.path.endsWith('/ListLinksAwaitingVerdict'))).toHaveLength(MAX_ROUNDS);
    expect(calls.filter((c) => c.path.endsWith('/RecordLinkVerdicts'))).toHaveLength(MAX_ROUNDS);
  });

  it('cuts a refusal message to 200 characters with no control character', async () => {
    const { url } = await standIn(() => connectError(403, { code: 'permission_denied', message: `\u001b[31mYOUR TOKEN abc\u0007${'x'.repeat(5000)}` }));
    const error = await connectCall(url, 'ListLinksAwaitingVerdict', 'abc', new Uint8Array()).then(
      () => new Error('the call was not refused'),
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(ItemsError);
    // eslint-disable-next-line no-control-regex
    expect(error.message).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(error.message).toHaveLength('the API refused the call: PERMISSION_DENIED ()'.length + 200);
    expect(error.message.startsWith('the API refused the call: PERMISSION_DENIED ( [31mYOUR TOKEN abc x')).toBe(true);
  });
});

// Fix round 1 (GATE-1): the API reads messages of at most 256 KiB, so the verdicts go in requests of at
// most MAX_RECORD_BYTES and MAX_RECORD_VERDICTS each, in the order given.
describe('recordRequests', () => {
  const verdict = (i: number, length: number) => ({ url: `https://n${String(i).padStart(3, '0')}.example.org/${'x'.repeat(length)}`, verdict: MACHINE.OK, reasons: ['upgraded'] });
  /** `count` verdicts whose one request would be `total` bytes. */
  const sized = (total: number) => {
    const one = encodeRecordRequest([verdict(0, 1900)]).length;
    const count = Math.floor(total / one);
    const verdicts = Array.from({ length: count }, (_, i) => verdict(i, 1900));
    verdicts[count - 1] = verdict(count - 1, 1900 + total - count * one);
    expect(encodeRecordRequest(verdicts)).toHaveLength(total);
    return verdicts;
  };

  it('keeps the cap under the 256 KiB the API reads, with room for the frame', () => {
    expect(MAX_RECORD_BYTES).toBe(200_000);
    expect(MAX_RECORD_VERDICTS).toBe(500);
  });

  it('writes no request for no verdicts, and one for a few', () => {
    expect(recordRequests([])).toEqual([]);
    const few = [verdict(0, 10), verdict(1, 10)];
    expect(recordRequests(few)).toEqual([encodeRecordRequest(few)]);
  });

  it('writes one request at exactly the byte cap', () => {
    const verdicts = sized(MAX_RECORD_BYTES);
    expect(recordRequests(verdicts)).toEqual([encodeRecordRequest(verdicts)]);
  });

  it('writes two requests at one byte over the cap: the last verdict goes in the second', () => {
    const verdicts = sized(MAX_RECORD_BYTES + 1);
    expect(recordRequests(verdicts)).toEqual([encodeRecordRequest(verdicts.slice(0, -1)), encodeRecordRequest(verdicts.slice(-1))]);
  });

  it(`writes at most ${MAX_RECORD_VERDICTS} verdicts in a request`, () => {
    const verdicts = Array.from({ length: MAX_RECORD_VERDICTS + 1 }, (_, i) => verdict(i, 0));
    expect(recordRequests(verdicts)).toEqual([encodeRecordRequest(verdicts.slice(0, MAX_RECORD_VERDICTS)), encodeRecordRequest(verdicts.slice(MAX_RECORD_VERDICTS))]);
  });

  it('sends a verdict larger than the cap on its own: the API refuses it, and nothing else is lost with it', () => {
    const verdicts = [verdict(0, 10), verdict(1, MAX_RECORD_BYTES), verdict(2, 10)];
    expect(recordRequests(verdicts)).toEqual(verdicts.map((v) => encodeRecordRequest([v])));
  });

  it('records a round in as many calls as it needs, and adds up what each kept', async () => {
    const urls = Array.from({ length: 120 }, (_, i) => `https://n${String(i).padStart(3, '0')}.example.org/${'x'.repeat(1990)}`);
    const big = new Uint8Array([...urls.flatMap((u) => [0x0a, ...[(u.length & 0x7f) | 0x80, u.length >> 7], ...ascii(u)])]);
    const { url, calls } = await standIn((call) => (call.path.endsWith('/ListLinksAwaitingVerdict') ? { status: 0, message: big } : { status: 0, message: recorded(call.body.length > 100_000 ? 90 : 7, ['https://gone.example.org/']) }));
    const totals = await runItems({ api: url, token: 't', check: (given) => Promise.resolve(given.map((u) => ({ url: u, verdict: 'ok' as const, reasons: [] }))) });
    const records = calls.filter((c) => c.path.endsWith('/RecordLinkVerdicts'));
    expect(records.length).toBe(2);
    for (const call of records) expect(call.body.length).toBeLessThanOrEqual(MAX_RECORD_BYTES);
    expect(Buffer.concat(records.map((c) => c.body))).toEqual(Buffer.from(encodeRecordRequest(urls.map((u) => ({ url: u, verdict: MACHINE.OK, reasons: [] })))));
    expect(totals).toEqual({ checked: 120, ok: 120, confirm: 0, drop: 0, recorded: 97, notAwaiting: 2, more: false });
  });
});
