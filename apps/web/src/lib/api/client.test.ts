import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, type ConnectRouter } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import http2 from 'node:http2';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ContentKind, ContentService, LinkTargetKind, LinkTargetStatus } from '../../gen/nwfl/mensa/v1/content_pb.js';
import { EventOccurrenceSchema, EventService, EventVisibility } from '../../gen/nwfl/mensa/v1/event_pb.js';
import { ApiNotFound, ApiTokenRefused, ApiUnavailable, type ApiReads, type Reader, apiSetup, grpcReads, unavailableReads } from './client';

const SERIES = '0b9c1f5e-4c1a-4d55-9a3e-2f7d8e6a1b20';

interface Seen {
  path: string;
  headers: http2.IncomingHttpHeaders;
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** A gRPC server on loopback, speaking the gRPC wire protocol only (as the API does), that remembers every request. */
async function grpcServer(routes: (router: ConnectRouter) => void): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const adapter = connectNodeAdapter({ routes, grpc: true, grpcWeb: false, connect: false });
  const sessions = new Set<http2.ServerHttp2Session>();
  const server = http2.createServer((req, res) => {
    seen.push({ path: req.url, headers: { ...req.headers } });
    void adapter(req, res);
  });
  server.on('session', (s) => sessions.add(s));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise((resolve) => {
    server.close(() => resolve());
    for (const s of sessions) s.destroy();
  }));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

/** Accepts the connection and says nothing, ever: an API that hangs. */
async function silentServer(): Promise<string> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => sockets.add(socket));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise((resolve) => {
    server.close(() => resolve());
    for (const s of sockets) s.destroy();
  }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A loopback port nothing listens on. */
async function closedPort(): Promise<string> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

const logs = () => {
  const lines: Record<string, unknown>[] = [];
  return { lines, log: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) };
};

describe('apiSetup', () => {
  it('is off with no API_URL: the pages keep their bundled content', () => {
    expect(apiSetup({})).toEqual({ enabled: false });
    expect(apiSetup({ API_URL: '' })).toEqual({ enabled: false });
  });

  it('takes an http or https base URL, and a timeout of 3 s unless told otherwise', () => {
    expect(apiSetup({ API_URL: 'http://nwfl-mensa-api.nwfl-site.svc.cluster.local:50051' })).toEqual({
      enabled: true,
      config: { baseUrl: 'http://nwfl-mensa-api.nwfl-site.svc.cluster.local:50051', timeoutMs: 3000 },
    });
    expect(apiSetup({ API_URL: 'https://api.example.org/', API_TIMEOUT_MS: '1500' })).toEqual({ enabled: true, config: { baseUrl: 'https://api.example.org', timeoutMs: 1500 } });
  });

  it('refuses anything else, naming the setting but never repeating its value', () => {
    for (const env of [
      { API_URL: 'grpc://api:50051' },
      { API_URL: 'not a url' },
      { API_URL: 'http://user:secret@api:50051' },
      { API_URL: 'http://api:50051/base' },
      { API_URL: 'http://api:50051/?x=1' },
      { API_URL: 'http://api:50051', API_TIMEOUT_MS: '0' },
      { API_URL: 'http://api:50051', API_TIMEOUT_MS: '60001' },
      { API_URL: 'http://api:50051', API_TIMEOUT_MS: '1.5' },
    ]) {
      const setup = apiSetup(env);
      expect(setup.enabled, JSON.stringify(env)).toBe(true);
      expect('error' in setup && setup.error, JSON.stringify(env)).toMatch(/^API_(URL|TIMEOUT_MS) /);
      expect(JSON.stringify(setup)).not.toContain('secret');
    }
  });
});

describe('grpcReads, over the gRPC wire protocol', () => {
  it('reads the calendar as the public: HTTP/2, application/grpc, and no Authorization or Cookie header at all', async () => {
    const api = await grpcServer((router) =>
      router.service(EventService, {
        listOccurrences: (req) => {
          expect(req.from).toMatchObject({ year: 2026, month: 11, day: 1 });
          expect(req.to).toMatchObject({ year: 2026, month: 11, day: 30 });
          expect(req.includeCancelled).toBe(true);
          return { occurrences: [create(EventOccurrenceSchema, { id: `${SERIES}:2026-11-04`, title: 'Lunch', visibility: EventVisibility.PUBLIC, startsAt: timestampFromDate(new Date('2026-11-04T17:30:00Z')) })] };
        },
      }),
    );
    const reads = grpcReads({ baseUrl: api.url, timeoutMs: 2000 }, () => {});
    const list = await reads.listOccurrences('2026-11-01', '2026-11-30');
    expect(list.map((o) => o.title)).toEqual(['Lunch']);
    expect(api.seen).toHaveLength(1);
    const [call] = api.seen;
    expect(call!.path).toBe('/nwfl.mensa.v1.EventService/ListOccurrences');
    expect(call!.headers[':method']).toBe('POST');
    expect(call!.headers['content-type']).toMatch(/^application\/grpc(\+proto)?$/);
    expect(call!.headers['te']).toBe('trailers');
    expect(call!.headers['authorization']).toBeUndefined();
    expect(call!.headers['cookie']).toBeUndefined();
  });

  it('reads one event, the series, the roster and published items the same way', async () => {
    const api = await grpcServer((router) => {
      router.service(EventService, {
        getOccurrence: (req) => ({ occurrence: create(EventOccurrenceSchema, { id: req.id, title: 'One' }) }),
        listSeries: (req) => {
          expect(req.includeInactive).toBe(false);
          return { series: [{ id: SERIES, title: 'Lunch' }] };
        },
      });
      router.service(ContentService, {
        getRoster: () => ({ offices: [{ slug: 'president', title: 'President' }] }),
        listPublishedItems: (req) => {
          expect(req.kind).toBe(ContentKind.ANNOUNCEMENT);
          expect(req.pageSize).toBe(3);
          return { items: [{ slug: 'dues' }] };
        },
      });
    });
    const reads = grpcReads({ baseUrl: api.url, timeoutMs: 2000 }, () => {});
    expect((await reads.getOccurrence(SERIES))?.title).toBe('One');
    expect((await reads.listSeries()).map((s) => s.title)).toEqual(['Lunch']);
    expect((await reads.getRoster()).map((o) => o.slug)).toEqual(['president']);
    expect((await reads.listPublishedItems(ContentKind.ANNOUNCEMENT, 3)).map((i) => i.slug)).toEqual(['dues']);
    expect(api.seen.map((s) => s.path)).toEqual([
      '/nwfl.mensa.v1.EventService/GetOccurrence',
      '/nwfl.mensa.v1.EventService/ListSeries',
      '/nwfl.mensa.v1.ContentService/GetRoster',
      '/nwfl.mensa.v1.ContentService/ListPublishedItems',
    ]);
    for (const call of api.seen) expect(call.headers['authorization']).toBeUndefined();
  });

  it('answers NOT_FOUND for one event as not found, and nothing else', async () => {
    const api = await grpcServer((router) =>
      router.service(EventService, {
        getOccurrence: () => {
          throw new ConnectError('occurrence not found', Code.NotFound);
        },
      }),
    );
    await expect(grpcReads({ baseUrl: api.url, timeoutMs: 2000 }, () => {}).getOccurrence(SERIES)).rejects.toBeInstanceOf(ApiNotFound);
  });

  it('turns any other failure into ApiUnavailable, and logs the call and the code, never the message', async () => {
    const api = await grpcServer((router) =>
      router.service(EventService, {
        listSeries: () => {
          throw new ConnectError('pg: password authentication failed for user nwfl', Code.Internal);
        },
      }),
    );
    const { lines, log } = logs();
    const error = await grpcReads({ baseUrl: api.url, timeoutMs: 2000 }, log).listSeries().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiUnavailable);
    expect(String(error)).not.toContain('password');
    expect(lines).toEqual([{ level: 'error', msg: 'api call failed', rpc: 'ListSeries', code: 'internal' }]);
  });

  it('gives up on an API that is not there', async () => {
    const { lines, log } = logs();
    await expect(grpcReads({ baseUrl: await closedPort(), timeoutMs: 2000 }, log).getRoster()).rejects.toBeInstanceOf(ApiUnavailable);
    expect(lines).toEqual([{ level: 'error', msg: 'api call failed', rpc: 'GetRoster', code: 'unavailable' }]);
  });

  it('gives up on an API that never answers, once the timeout has passed', async () => {
    const { lines, log } = logs();
    const started = Date.now();
    await expect(grpcReads({ baseUrl: await silentServer(), timeoutMs: 300 }, log).listOccurrences('2026-11-01', '2026-11-30')).rejects.toBeInstanceOf(ApiUnavailable);
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(250);
    expect(took).toBeLessThan(2000);
    expect(lines).toEqual([{ level: 'error', msg: 'api call failed', rpc: 'ListOccurrences', code: 'deadline_exceeded' }]);
  });

  it('refuses an answer bigger than 4 MiB rather than hold it', async () => {
    const api = await grpcServer((router) => router.service(ContentService, { getRoster: () => ({ offices: [{ title: 'x'.repeat(5 * 1024 * 1024) }] }) }));
    await expect(grpcReads({ baseUrl: api.url, timeoutMs: 5000 }, () => {}).getRoster()).rejects.toBeInstanceOf(ApiUnavailable);
  });
});

// REDACT R3c: a PDF's bytes, streamed through the site as the API serves them to the public.
describe('grpcReads.readFile', () => {
  const FILE = '3e4f5a6b-7c8d-4e9f-a0b1-c2d3e4f5a6b7';
  const head = (size: number, filename = 'picnic-with-withheld.pdf') => ({ part: { case: 'head' as const, value: { filename, mimeType: 'application/pdf', sizeBytes: BigInt(size) } } });
  const chunk = (bytes: Uint8Array) => ({ part: { case: 'chunk' as const, value: bytes } });
  const drainBody = async (body: ReadableStream<Uint8Array>) => Buffer.concat(await Array.fromAsync(body));

  it('streams the head, then the bytes, as the public', async () => {
    const api = await grpcServer((router) =>
      router.service(ContentService, {
        async *readFile(req) {
          expect(req.fileId).toBe(FILE);
          yield head(6);
          yield chunk(Buffer.from('%PDF-'));
          yield chunk(Buffer.from('1'));
        },
      }),
    );
    const file = await grpcReads({ baseUrl: api.url, timeoutMs: 2000 }, () => {}).readFile(FILE);
    expect(file.kind).toBe('pdf');
    if (file.kind !== 'pdf') return;
    expect({ filename: file.filename, size: file.size }).toEqual({ filename: 'picnic-with-withheld.pdf', size: 6 });
    expect((await drainBody(file.body)).toString()).toBe('%PDF-1');
    expect(api.seen.map((s) => s.path)).toEqual(['/nwfl.mensa.v1.ContentService/ReadFile']);
    expect(api.seen[0]!.headers['authorization']).toBeUndefined();
    expect(api.seen[0]!.headers['cookie']).toBeUndefined();
  });

  it('says not ready, and not found for NOT_FOUND', async () => {
    const api = await grpcServer((router) =>
      router.service(ContentService, {
        async *readFile(req) {
          if (req.fileId !== FILE) throw new ConnectError('file not found', Code.NotFound);
          yield { part: { case: 'notReady' as const, value: {} } };
        },
      }),
    );
    const reads = grpcReads({ baseUrl: api.url, timeoutMs: 2000 }, () => {});
    expect(await reads.readFile(FILE)).toEqual({ kind: 'not_ready' });
    expect(await reads.readFile('00000000-0000-4000-8000-000000000000')).toEqual({ kind: 'not_found' });
  });

  it('turns a failure, an empty answer, one that does not start with its head, or a file over 10 MiB into ApiUnavailable', async () => {
    for (const run of [
      // eslint-disable-next-line require-yield
      async function* () {
        throw new ConnectError('pg: secret', Code.Internal);
      },
      async function* () {},
      async function* () {
        yield chunk(Buffer.from('%PDF-'));
      },
      async function* () {
        yield head(10 * 1024 * 1024 + 1);
        yield chunk(Buffer.from('%PDF-'));
      },
    ]) {
      const api = await grpcServer((router) => router.service(ContentService, { readFile: run }));
      const { lines, log } = logs();
      await expect(grpcReads({ baseUrl: api.url, timeoutMs: 2000 }, log).readFile(FILE)).rejects.toBeInstanceOf(ApiUnavailable);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ level: 'error', msg: 'api call failed', rpc: 'ReadFile' });
      expect(JSON.stringify(lines)).not.toContain('secret');
    }
  });

  it('fails the body, and logs it, when the stream breaks or runs past or short of its head', async () => {
    for (const [name, run] of [
      [
        'broken',
        async function* () {
          yield head(10);
          yield chunk(Buffer.from('%PDF-'));
          throw new ConnectError('pg: secret', Code.Internal);
        },
      ],
      [
        'longer than its head',
        async function* () {
          yield head(3);
          yield chunk(Buffer.from('%PDF-'));
        },
      ],
      [
        'shorter than its head',
        async function* () {
          yield head(30);
          yield chunk(Buffer.from('%PDF-'));
        },
      ],
      [
        'a second head',
        async function* () {
          yield head(5);
          yield head(5);
        },
      ],
    ] as const) {
      const api = await grpcServer((router) => router.service(ContentService, { readFile: run }));
      const { lines, log } = logs();
      const file = await grpcReads({ baseUrl: api.url, timeoutMs: 5000 }, log).readFile(FILE);
      if (file.kind !== 'pdf') throw new Error(`${name}: ${file.kind}`);
      await expect(drainBody(file.body), name).rejects.toThrow();
      expect(lines, name).toEqual([expect.objectContaining({ level: 'error', msg: 'api stream failed', rpc: 'ReadFile' })]);
      expect(JSON.stringify(lines)).not.toContain('secret');
    }
  });

  it('stops reading when the reader goes away', async () => {
    let sent = 0;
    const api = await grpcServer((router) =>
      router.service(ContentService, {
        async *readFile() {
          yield head(64 * 1024 * 100);
          for (let n = 0; n < 100; n++) {
            sent++;
            yield chunk(new Uint8Array(64 * 1024));
          }
        },
      }),
    );
    const file = await grpcReads({ baseUrl: api.url, timeoutMs: 5000 }, () => {}).readFile(FILE);
    if (file.kind !== 'pdf') throw new Error(file.kind);
    const reader = file.body.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sent).toBeLessThan(100);
  });

  // PDFVIEW: /read reads a file's head only and lets its body go unread. That is no failure: nothing is logged.
  it('logs nothing when the reader lets the body go, read or unread', async () => {
    const api = await grpcServer((router) =>
      router.service(ContentService, {
        async *readFile() {
          yield head(64 * 1024 * 10);
          for (let n = 0; n < 10; n++) {
            await new Promise((resolve) => setTimeout(resolve, 20));
            yield chunk(new Uint8Array(64 * 1024));
          }
        },
      }),
    );
    for (const read of [false, true]) {
      const { lines, log } = logs();
      const file = await grpcReads({ baseUrl: api.url, timeoutMs: 5000 }, log).readFile(FILE);
      if (file.kind !== 'pdf') throw new Error(file.kind);
      if (read) {
        const reader = file.body.getReader();
        await reader.read();
        await reader.cancel();
      } else {
        await file.body.cancel();
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(lines, String(read)).toEqual([]);
    }
  });
});

// A14 (S5a): a signed-in reader's token, forwarded on the two news reads only.
describe('grpcReads as a signed-in reader', () => {
  const FILE = '3e4f5a6b-7c8d-4e9f-a0b1-c2d3e4f5a6b7';
  // Shaped like a JWT (three parts, every b64token character), but plainly a test value.
  const TOKEN = 'test.member-token.sig~nature+/=';
  const member: Reader = { bearer: TOKEN };

  /** Every read the API has, answering as the public would. */
  const everything = (router: ConnectRouter) => {
    router.service(EventService, {
      listOccurrences: () => ({ occurrences: [] }),
      getOccurrence: (req) => ({ occurrence: create(EventOccurrenceSchema, { id: req.id }) }),
      listSeries: () => ({ series: [] }),
    });
    router.service(ContentService, {
      getRoster: () => ({ offices: [] }),
      listPublishedItems: () => ({ items: [{ slug: 'x' }] }),
      async *readFile() {
        yield { part: { case: 'notReady' as const, value: {} } };
      },
    });
  };

  it('sends the bearer on ListPublishedItems and ReadFile when given one, and on nothing else', async () => {
    const api = await grpcServer(everything);
    const reads = grpcReads({ baseUrl: api.url, timeoutMs: 2000 }, () => {});
    await reads.listPublishedItems(ContentKind.ARTICLE, 10, member);
    await reads.readFile(FILE, member);
    await reads.listOccurrences('2026-11-01', '2026-11-30');
    await reads.getOccurrence(SERIES);
    await reads.listSeries();
    await reads.getRoster();
    await reads.listPublishedItems(ContentKind.ANNOUNCEMENT, 3);
    await reads.readFile(FILE);
    const auth = api.seen.map((s) => [s.path.split('/').at(-1), s.headers['authorization']]);
    expect(auth).toEqual([
      ['ListPublishedItems', `Bearer ${TOKEN}`],
      ['ReadFile', `Bearer ${TOKEN}`],
      ['ListOccurrences', undefined],
      ['GetOccurrence', undefined],
      ['ListSeries', undefined],
      ['GetRoster', undefined],
      ['ListPublishedItems', undefined],
      ['ReadFile', undefined],
    ]);
    for (const call of api.seen) expect(call.headers['cookie']).toBeUndefined();
  });

  it('sends no Authorization header at all for a bearer that is not one RFC 6750 b64token: no header injection', async () => {
    const api = await grpcServer(everything);
    const reads = grpcReads({ baseUrl: api.url, timeoutMs: 2000 }, () => {});
    const bad = ['', ' ', 'two words', `${TOKEN}\r\nCookie: a=b`, `${TOKEN}\n`, 'Bearer x', 'a=b', 'é', 'tab\there', '=abc'];
    for (const bearer of bad) {
      await reads.listPublishedItems(ContentKind.ARTICLE, 10, { bearer });
      await reads.readFile(FILE, { bearer });
    }
    expect(api.seen).toHaveLength(bad.length * 2);
    for (const call of api.seen) expect(call.headers['authorization']).toBeUndefined();
  });

  it('turns UNAUTHENTICATED into ApiTokenRefused when a bearer went, and logs the call and the code, never the token', async () => {
    const api = await grpcServer((router) =>
      router.service(ContentService, {
        listPublishedItems: () => {
          throw new ConnectError(`invalid token ${TOKEN}`, Code.Unauthenticated);
        },
        // eslint-disable-next-line require-yield
        async *readFile() {
          throw new ConnectError(`invalid token ${TOKEN}`, Code.Unauthenticated);
        },
      }),
    );
    const { lines, log } = logs();
    const reads = grpcReads({ baseUrl: api.url, timeoutMs: 2000 }, log);
    const listed = await reads.listPublishedItems(ContentKind.ARTICLE, 10, member).catch((e: unknown) => e);
    const read = await reads.readFile(FILE, member).catch((e: unknown) => e);
    expect(listed).toBeInstanceOf(ApiTokenRefused);
    expect(read).toBeInstanceOf(ApiTokenRefused);
    expect(listed).not.toBeInstanceOf(ApiUnavailable);
    expect((listed as ApiTokenRefused).rpc).toBe('ListPublishedItems');
    expect(lines).toEqual([
      { level: 'warn', msg: 'api refused the token', rpc: 'ListPublishedItems', code: 'unauthenticated' },
      { level: 'warn', msg: 'api refused the token', rpc: 'ReadFile', code: 'unauthenticated' },
    ]);
    expect(JSON.stringify(lines) + String(listed) + String(read)).not.toContain(TOKEN);
  });

  it('keeps UNAUTHENTICATED without a bearer as ApiUnavailable, as before, and any other failure with one too', async () => {
    const api = await grpcServer((router) =>
      router.service(ContentService, {
        listPublishedItems: (req) => {
          throw new ConnectError('no', req.pageSize === 1 ? Code.Unauthenticated : Code.PermissionDenied);
        },
      }),
    );
    const { lines, log } = logs();
    const reads = grpcReads({ baseUrl: api.url, timeoutMs: 2000 }, log);
    expect(await reads.listPublishedItems(ContentKind.ARTICLE, 1).catch((e: unknown) => e)).toBeInstanceOf(ApiUnavailable);
    expect(await reads.listPublishedItems(ContentKind.ARTICLE, 2, member).catch((e: unknown) => e)).toBeInstanceOf(ApiUnavailable);
    expect(await reads.listPublishedItems(ContentKind.ARTICLE, 1, { bearer: 'not a token' }).catch((e: unknown) => e)).toBeInstanceOf(ApiUnavailable);
    expect(lines.map((l) => l['code'])).toEqual(['unauthenticated', 'permission_denied', 'unauthenticated']);
    expect(JSON.stringify(lines)).not.toContain(TOKEN);
  });

  it('a read the site cannot make fails the same with or without a reader', async () => {
    const reads = unavailableReads();
    await expect(reads.listPublishedItems(ContentKind.ARTICLE, 10, member)).rejects.toBeInstanceOf(ApiUnavailable);
    await expect(reads.readFile(FILE, member)).rejects.toBeInstanceOf(ApiUnavailable);
  });
});

describe('grpcReads.getLinkTarget (LINKS L4)', () => {
  const LINK = 'abcdefghijklmnopqrstuvwxyz';
  const FILE = '3e4f5a6b-7c8d-4e9f-a0b1-c2d3e4f5a6b7';
  const AT = new Date('2026-11-04T15:00:00Z');
  const TOKEN = 'test.member-token.sig~nature+/=';

  it('reads an active link as the public: its URL, host, kind, confirm flag, file, page and date, with no Authorization or Cookie', async () => {
    const api = await grpcServer((router) =>
      router.service(ContentService, {
        getLinkTarget: (req) =>
          req.linkId === LINK
            ? { status: LinkTargetStatus.ACTIVE, url: 'https://club.example/a', host: 'club.example', kind: LinkTargetKind.WEB, confirm: true, fileId: FILE, page: 2, statusAt: timestampFromDate(AT) }
            : { status: LinkTargetStatus.ACTIVE, url: 'mailto:events@example.org', host: 'example.org', kind: LinkTargetKind.MAIL, fileId: FILE, page: 1 },
      }),
    );
    const reads = grpcReads({ baseUrl: api.url, timeoutMs: 2000 }, () => {});
    expect(await reads.getLinkTarget(LINK)).toEqual({ kind: 'active', url: 'https://club.example/a', host: 'club.example', mail: false, confirm: true, fileId: FILE, page: 2, checkedAt: AT });
    expect(await reads.getLinkTarget('bbbbbbbbbbbbbbbbbbbbbbbbbb')).toEqual({ kind: 'active', url: 'mailto:events@example.org', host: 'example.org', mail: true, confirm: false, fileId: FILE, page: 1 });
    expect(api.seen.map((s) => s.path)).toEqual(['/nwfl.mensa.v1.ContentService/GetLinkTarget', '/nwfl.mensa.v1.ContentService/GetLinkTarget']);
    for (const call of api.seen) {
      expect(call.headers['authorization']).toBeUndefined();
      expect(call.headers['cookie']).toBeUndefined();
    }
  });

  it('reads a link turned off as disabled, with its date, file and page and nothing else', async () => {
    const api = await grpcServer((router) =>
      router.service(ContentService, {
        getLinkTarget: (req) => ({ status: LinkTargetStatus.DISABLED, url: 'https://ignored.example/', host: 'ignored.example', fileId: FILE, page: 3, ...(req.linkId === LINK ? { statusAt: timestampFromDate(AT) } : {}) }),
      }),
    );
    const reads = grpcReads({ baseUrl: api.url, timeoutMs: 2000 }, () => {});
    expect(await reads.getLinkTarget(LINK)).toEqual({ kind: 'disabled', fileId: FILE, page: 3, at: AT });
    expect(await reads.getLinkTarget('bbbbbbbbbbbbbbbbbbbbbbbbbb')).toEqual({ kind: 'disabled', fileId: FILE, page: 3 });
  });

  it('reads NOT_FOUND, an unknown status and an unknown kind as not found', async () => {
    const api = await grpcServer((router) =>
      router.service(ContentService, {
        getLinkTarget: (req) => {
          if (req.linkId === LINK) throw new ConnectError('link not found', Code.NotFound);
          if (req.linkId.startsWith('b')) return { status: LinkTargetStatus.UNSPECIFIED, url: 'https://club.example/', host: 'club.example', kind: LinkTargetKind.WEB, fileId: FILE, page: 1 };
          return { status: LinkTargetStatus.ACTIVE, url: 'https://club.example/', host: 'club.example', kind: LinkTargetKind.UNSPECIFIED, fileId: FILE, page: 1 };
        },
      }),
    );
    const reads = grpcReads({ baseUrl: api.url, timeoutMs: 2000 }, () => {});
    expect(await reads.getLinkTarget(LINK)).toEqual({ kind: 'not_found' });
    expect(await reads.getLinkTarget('bbbbbbbbbbbbbbbbbbbbbbbbbb')).toEqual({ kind: 'not_found' });
    expect(await reads.getLinkTarget('cccccccccccccccccccccccccc')).toEqual({ kind: 'not_found' });
  });

  it("sends a signed-in reader's token, and turns UNAUTHENTICATED with one into ApiTokenRefused, any other failure into ApiUnavailable", async () => {
    const api = await grpcServer((router) =>
      router.service(ContentService, {
        getLinkTarget: (req) => {
          throw new ConnectError(`no ${TOKEN}`, req.linkId === LINK ? Code.Unauthenticated : Code.Internal);
        },
      }),
    );
    const { lines, log } = logs();
    const reads = grpcReads({ baseUrl: api.url, timeoutMs: 2000 }, log);
    expect(await reads.getLinkTarget(LINK, { bearer: TOKEN }).catch((e: unknown) => e)).toBeInstanceOf(ApiTokenRefused);
    expect(await reads.getLinkTarget('bbbbbbbbbbbbbbbbbbbbbbbbbb', { bearer: TOKEN }).catch((e: unknown) => e)).toBeInstanceOf(ApiUnavailable);
    expect(await reads.getLinkTarget(LINK).catch((e: unknown) => e)).toBeInstanceOf(ApiUnavailable);
    await reads.getLinkTarget(LINK, { bearer: 'not a token' }).catch(() => undefined);
    expect(api.seen.map((s) => s.headers['authorization'])).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`, undefined, undefined]);
    expect(lines.map((l) => [l['rpc'], l['code']])).toEqual([
      ['GetLinkTarget', 'unauthenticated'],
      ['GetLinkTarget', 'internal'],
      ['GetLinkTarget', 'unauthenticated'],
      ['GetLinkTarget', 'unauthenticated'],
    ]);
    expect(JSON.stringify(lines)).not.toContain(TOKEN);
    await expect(unavailableReads().getLinkTarget(LINK)).rejects.toBeInstanceOf(ApiUnavailable);
  });
});

/** Compile-time only (never run): the calendar, the roster and the series take no reader, so no page can forward a token on them. */
export function onlyTheNewsReadsTakeAReader(reads: ApiReads, as: Reader): void {
  // @ts-expect-error listOccurrences takes no reader
  void reads.listOccurrences('2026-11-01', '2026-11-30', as);
  // @ts-expect-error getOccurrence takes no reader
  void reads.getOccurrence(SERIES, as);
  // @ts-expect-error listSeries takes no reader
  void reads.listSeries(as);
  // @ts-expect-error getRoster takes no reader
  void reads.getRoster(as);
}
