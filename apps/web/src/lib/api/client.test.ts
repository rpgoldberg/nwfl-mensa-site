import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, type ConnectRouter } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import http2 from 'node:http2';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ContentKind, ContentService } from '../../gen/nwfl/mensa/v1/content_pb.js';
import { EventOccurrenceSchema, EventService, EventVisibility } from '../../gen/nwfl/mensa/v1/event_pb.js';
import { ApiNotFound, ApiUnavailable, apiSetup, grpcReads } from './client';

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
