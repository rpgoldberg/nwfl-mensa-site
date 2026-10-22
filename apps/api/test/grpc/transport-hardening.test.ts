// A1-FIX: the gRPC port's edges, after the A1 challenge.
//   - Only application/grpc and application/grpc+proto get in; +json and the
//     rest are 415 before Connect sees them.
//   - An error raised before any interceptor runs (a bad envelope, a size cap,
//     a bad header) gets an access-log line (request id, method, code) and a
//     fixed grpc-message per code that never echoes the caller's input.
//   - Bounds per caller and per process: at most 16 concurrent streams per
//     connection, a cap on active streams across connections, and a receive
//     deadline, so a slow sender cannot hold a buffer.
import { create, toBinary } from '@bufbuild/protobuf';
import { createClient } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import http2 from 'node:http2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Health, HealthCheckRequestSchema } from '../../src/gen/grpc/health/v1/health_pb.js';
import { healthRoutes } from '../../src/grpc/health.js';
import { accessLogInterceptor } from '../../src/grpc/interceptors.js';
import { MAX_ACTIVE_STREAMS, MAX_CONCURRENT_STREAMS, MAX_EDGE_STREAMS, MAX_EDGE_STREAMS_PER_CLIENT, READ_MAX_BYTES, createGrpcServer } from '../../src/grpc/server.js';
import { createStructuredLogger } from '../../src/platform/logger.js';
import { createReadiness } from '../../src/readiness.js';
import type { TokenVerifier } from '../../src/auth/caller.js';
import { EDGE, HEALTH, NEWSLETTER, VERIFIER, createEdgeServer, edgeHeaders } from '../helpers/edge.js';
import { grpcFrame, h2Request } from '../helpers/h2.js';
import { captureLogs, closeHard, listen } from '../helpers/servers.js';

const CHECK = '/grpc.health.v1.Health/Check';
const CANARY = 'CANARY-caller-input-5d1e';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const checkFrame = (service = ''): Uint8Array => grpcFrame(toBinary(HealthCheckRequestSchema, create(HealthCheckRequestSchema, { service })));
const grpcHeaders = (extra: http2.OutgoingHttpHeaders = {}): http2.OutgoingHttpHeaders => ({
  ':method': 'POST',
  ':path': CHECK,
  'content-type': 'application/grpc',
  te: 'trailers',
  ...extra,
});

describe('the gRPC port after A1-FIX', () => {
  const { lines, sink } = captureLogs();
  let server: http2.Http2Server;
  let baseUrl: string;
  let handled = 0;

  beforeAll(async () => {
    const logger = createStructuredLogger({ sink });
    const readiness = createReadiness({
      query: () => {
        handled += 1;
        return Promise.resolve({});
      },
    });
    server = createGrpcServer({
      routes: healthRoutes(readiness),
      interceptors: [accessLogInterceptor(logger)],
      logger,
      receiveDeadlineMs: 300,
      maxActiveStreams: 3,
    });
    baseUrl = await listen(server);
  });

  afterAll(async () => {
    await closeHard(server);
  });

  const statusOf = (res: Awaited<ReturnType<typeof h2Request>>): string | undefined =>
    (res.trailers['grpc-status'] ?? res.headers['grpc-status']) as string | undefined;
  const messageOf = (res: Awaited<ReturnType<typeof h2Request>>): string =>
    String(res.trailers['grpc-message'] ?? res.headers['grpc-message'] ?? '');

  describe('content types', () => {
    it.each(['application/grpc', 'application/grpc+proto'])('serves %s', async (contentType) => {
      const res = await h2Request(baseUrl, grpcHeaders({ 'content-type': contentType }), checkFrame());
      expect(statusOf(res)).toBe('0');
    });

    it.each(['application/grpc+json', 'application/grpc; charset=utf-8', 'application/grpc+xml', 'application/json', 'application/connect+proto'])(
      'refuses %s with 415 before any handler runs',
      async (contentType) => {
        const before = handled;
        const res = await h2Request(baseUrl, grpcHeaders({ 'content-type': contentType }), '{"service":""}');
        expect(res.status).toBe(415);
        expect(handled).toBe(before);
      },
    );

    it('answers an unknown method with an accepted content type UNIMPLEMENTED', async () => {
      for (const contentType of ['application/grpc', 'application/grpc+proto']) {
        const res = await h2Request(baseUrl, grpcHeaders({ ':path': '/nwfl.mensa.v1.NoSuch/Get', 'content-type': contentType }), checkFrame());
        expect(statusOf(res), contentType).toBe('12');
      }
    });
  });

  describe('errors raised before any interceptor', () => {
    const early = async (headers: http2.OutgoingHttpHeaders, body: Uint8Array | string): Promise<{ status: string | undefined; message: string; line: Record<string, unknown> | undefined }> => {
      const count = lines.length;
      const res = await h2Request(baseUrl, grpcHeaders(headers), body);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { status: statusOf(res), message: messageOf(res), line: lines.slice(count).find((l) => l['msg'] === 'rpc') };
    };

    it('logs a size-cap refusal by request id, method and code, with a fixed message', async () => {
      const header = new Uint8Array(5);
      new DataView(header.buffer).setUint32(1, READ_MAX_BYTES + 123);
      const { status, message, line } = await early({}, header);
      expect(status).toBe('8');
      expect(message).toBe('resource exhausted');
      expect(message).not.toContain(String(READ_MAX_BYTES + 123));
      expect(line).toMatchObject({ rpc: 'grpc.health.v1.Health/Check', code: 'resource_exhausted', early: true });
      expect(String(line?.['request_id'])).toMatch(UUID);
    });

    it('never echoes a bad header value back', async () => {
      const { status, message, line } = await early({ 'grpc-timeout': CANARY }, checkFrame());
      expect(status).toBe('3');
      expect(message).toBe('invalid argument');
      expect(line).toMatchObject({ code: 'invalid_argument', early: true });
      expect(JSON.stringify(lines)).not.toContain(CANARY);
    });

    it('never echoes or logs an undecodable payload', async () => {
      const bad = grpcFrame(new Uint8Array([0x0a, 0x30, ...Buffer.from(CANARY)]));
      const { status, message, line } = await early({}, bad);
      expect(status).not.toBe('0');
      expect(message).not.toContain(CANARY);
      expect(line).toMatchObject({ early: true });
      expect(JSON.stringify(lines)).not.toContain(CANARY);
    });

    it('logs no method name the caller made up', async () => {
      const { line } = await early({ ':path': `/${CANARY}/Get` }, checkFrame());
      expect(line).toMatchObject({ rpc: 'unknown', early: true });
      expect(JSON.stringify(lines)).not.toContain(CANARY);
    });

    it('keeps a handler-raised message, and gives every normal line its request id', async () => {
      const count = lines.length;
      const client = createClient(Health, createGrpcTransport({ baseUrl }));
      await expect(client.check({ service: 'nope' })).rejects.toMatchObject({ rawMessage: 'unknown service' });
      const line = lines.slice(count).find((l) => l['msg'] === 'rpc');
      expect(line).toMatchObject({ code: 'not_found' });
      expect(line?.['early']).toBeUndefined();
      expect(String(line?.['request_id'])).toMatch(UUID);
    });
  });

  describe('bounds', () => {
    it('holds at most 128 MiB in request buffers across the whole process, site and edge budgets together', () => {
      expect((MAX_ACTIVE_STREAMS + MAX_EDGE_STREAMS) * READ_MAX_BYTES).toBeLessThanOrEqual(128 * 1024 * 1024);
    });

    it(`advertises ${MAX_CONCURRENT_STREAMS} concurrent streams per connection: room for both budgets, and no more`, async () => {
      expect(MAX_CONCURRENT_STREAMS).toBe(MAX_ACTIVE_STREAMS + MAX_EDGE_STREAMS);
      const session = http2.connect(baseUrl);
      try {
        await new Promise<void>((resolve) => session.once('remoteSettings', () => resolve()));
        expect(session.remoteSettings.maxConcurrentStreams).toBe(MAX_CONCURRENT_STREAMS);
      } finally {
        session.destroy();
      }
    });

    it('cancels a stream whose sender does not finish within the receive deadline, and logs it', async () => {
      const count = lines.length;
      const session = http2.connect(baseUrl);
      try {
        const stream = session.request(grpcHeaders());
        const header = new Uint8Array(5);
        new DataView(header.buffer).setUint32(1, 1000);
        stream.write(header);
        stream.write(new Uint8Array(10));
        const closed = await new Promise<number>((resolve) => stream.once('close', () => resolve(stream.rstCode)));
        expect(closed).toBe(http2.constants.NGHTTP2_CANCEL);
      } finally {
        session.destroy();
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(lines.slice(count).find((l) => l['msg'] === 'rpc')).toMatchObject({ code: 'deadline_exceeded', early: true });
    });

    it('refuses a stream beyond the active-stream cap with RESOURCE_EXHAUSTED, across connections', async () => {
      const sessions = [http2.connect(baseUrl), http2.connect(baseUrl)];
      const held: http2.ClientHttp2Stream[] = [];
      try {
        for (let i = 0; i < 3; i += 1) {
          const stream = (sessions[i % 2] as http2.ClientHttp2Session).request(grpcHeaders());
          stream.on('error', () => {});
          stream.write(new Uint8Array([0, 0, 0, 0, 100]));
          held.push(stream);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
        const res = await h2Request(baseUrl, grpcHeaders(), checkFrame());
        expect(statusOf(res)).toBe('8');
        expect(messageOf(res)).toBe('resource exhausted');
      } finally {
        held.forEach((stream) => stream.close());
        sessions.forEach((session) => session.destroy());
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      const res = await h2Request(baseUrl, grpcHeaders(), checkFrame());
      expect(statusOf(res)).toBe('0');
    });
  });
});

// STACK-FIX (blocker), then API-FIX3: an edge stream is admitted only once its
// bearer token is verified, at stream start, and then to its own client's
// budget: the agent's four or the verifier's four. A stream with no valid
// token is refused at once and holds nothing, so neither held streams from the
// internet nor one client's slow calls can take the other's slots, or the site's.
describe('edge admission', () => {
  let server: http2.Http2Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createEdgeServer({ receiveDeadlineMs: 2_000, maxActiveStreams: 3, maxEdgeStreamsPerClient: 2 });
    baseUrl = await listen(server);
  });

  afterAll(async () => {
    await closeHard(server);
  });

  const statusOf = (res: Awaited<ReturnType<typeof h2Request>>): string | undefined =>
    (res.trailers['grpc-status'] ?? res.headers['grpc-status']) as string | undefined;
  const call = async (headers: http2.OutgoingHttpHeaders): Promise<string | undefined> => statusOf(await h2Request(baseUrl, headers, grpcFrame(new Uint8Array())));

  /** Opens `count` streams that announce a body and never send it, the way the starvation probes do. */
  const hold = async (count: number, headers: http2.OutgoingHttpHeaders) => {
    const sessions = [http2.connect(baseUrl), http2.connect(baseUrl)];
    sessions.forEach((session) => session.on('error', () => {}));
    const streams: http2.ClientHttp2Stream[] = [];
    for (let i = 0; i < count; i += 1) {
      const stream = (sessions[i % 2] as http2.ClientHttp2Session).request(headers);
      stream.on('error', () => {});
      stream.write(new Uint8Array([0, 0, 0, 0, 10]));
      streams.push(stream);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    return {
      open: (): number => streams.filter((stream) => !stream.closed).length,
      release: async (): Promise<void> => {
        streams.forEach((stream) => stream.close());
        sessions.forEach((session) => session.destroy());
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
    };
  };

  it('refuses an edge stream with no valid token at once, so held ones take no slot from the agent or the verifier', async () => {
    const anonymous = await hold(20, edgeHeaders(NEWSLETTER));
    const forged = await hold(20, edgeHeaders(VERIFIER, 'forged-token'));
    try {
      expect(anonymous.open() + forged.open()).toBe(0);
      for (let i = 0; i < 5; i += 1) {
        expect(await call(edgeHeaders(NEWSLETTER, 'agent-token'))).toBe('0');
        expect(await call(edgeHeaders(VERIFIER, 'verifier-token'))).toBe('0');
      }
      expect(await call(edgeHeaders(NEWSLETTER))).toBe('16');
    } finally {
      await anonymous.release();
      await forged.release();
    }
  });

  it('gives the agent and the verifier a budget each: one client full leaves the other and the site served', async () => {
    const agent = await hold(2, edgeHeaders(NEWSLETTER, 'agent-token'));
    try {
      expect(agent.open()).toBe(2);
      expect(await call(edgeHeaders(NEWSLETTER, 'agent-token'))).toBe('8');
      expect(await call(edgeHeaders(VERIFIER, 'verifier-token'))).toBe('0');
      expect(await call(grpcHeaders())).toBe('0');
    } finally {
      await agent.release();
    }
    expect(await call(edgeHeaders(NEWSLETTER, 'agent-token'))).toBe('0');
  });

  it('refuses at once an edge stream whose token belongs to another service or a site user, so it holds no slot either', async () => {
    const elsewhere = await hold(4, edgeHeaders(HEALTH, 'agent-token'));
    expect(elsewhere.open()).toBe(0);
    await elsewhere.release();
    expect(await call(edgeHeaders(VERIFIER, 'agent-token'))).toBe('7');
    expect(await call(edgeHeaders(NEWSLETTER, 'verifier-token'))).toBe('7');
    expect(await call(edgeHeaders(NEWSLETTER, 'site-token'))).toBe('7');
    expect(await call(edgeHeaders(HEALTH, 'agent-token'))).toBe('7');
  });

  it('counts a case variant and a list naming the edge as edge calls', async () => {
    expect(await call(edgeHeaders(NEWSLETTER, undefined, { 'l5d-client-id': EDGE.toUpperCase() }))).toBe('16');
    expect(await call(edgeHeaders(NEWSLETTER, undefined, { 'l5d-client-id': `web.example, ${EDGE}` }))).toBe('16');
  });

  it('does not let site calls use the edge budgets either', async () => {
    const site = await hold(3, grpcHeaders());
    try {
      expect(await call(grpcHeaders())).toBe('8');
      expect(await call(edgeHeaders(NEWSLETTER, 'agent-token'))).toBe('0');
    } finally {
      await site.release();
    }
  });

  it('counts nothing for a stream that closed while its token was being checked, so slots never leak', async () => {
    // A verifier that answers only when told: the streams close first.
    const waiting: Array<() => void> = [];
    const slow: TokenVerifier = {
      verify: (token) =>
        new Promise((resolve, reject) => {
          waiting.push(() => (token === 'agent-token' ? resolve({ client: 'agent', subject: 'svc-nwfl-newsletter', groups: [], scopes: ['newsletter.read'] }) : reject(new Error('no'))));
        }),
    };
    const gated = createEdgeServer({ verifier: slow, maxEdgeStreamsPerClient: 2 });
    const url = await listen(gated);
    try {
      const session = http2.connect(url);
      session.on('error', () => {});
      for (const token of ['agent-token', 'agent-token', 'agent-token', 'forged']) {
        const stream = session.request(edgeHeaders(NEWSLETTER, token));
        stream.on('error', () => {});
        stream.close();
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      waiting.splice(0).forEach((answer) => answer());
      await new Promise((resolve) => setTimeout(resolve, 50));
      // Both of the agent's slots are still free.
      const held = [0, 1].map(() => {
        const stream = session.request(edgeHeaders(NEWSLETTER, 'agent-token'));
        stream.on('error', () => {});
        stream.write(new Uint8Array([0, 0, 0, 0, 10]));
        return stream;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      waiting.splice(0).forEach((answer) => answer());
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(held.filter((stream) => !stream.closed)).toHaveLength(2);
      held.forEach((stream) => stream.close());
      session.destroy();
    } finally {
      await closeHard(gated);
    }
  });

  it('splits the edge into two client budgets of four, eight in all', () => {
    expect(MAX_EDGE_STREAMS_PER_CLIENT).toBe(4);
    expect(MAX_EDGE_STREAMS).toBe(2 * MAX_EDGE_STREAMS_PER_CLIENT);
  });
});

// One connection can hold both budgets at once: the mesh proxy may carry all
// of the pod's traffic over a single connection, and then a per-connection cap
// below the two budgets would bind first and starve the site behind the edge.
describe('the per-connection cap and the budgets, on one connection', () => {
  let server: http2.Http2Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createEdgeServer({ receiveDeadlineMs: 5_000 });
    baseUrl = await listen(server);
  });

  afterAll(async () => {
    await closeHard(server);
  });

  /** A Check on an existing session; resolves to its grpc-status, or 'queued' if it never got a stream. */
  const check = (session: http2.ClientHttp2Session, extra: http2.OutgoingHttpHeaders = {}): Promise<string> =>
    new Promise((resolve) => {
      const stream = session.request(grpcHeaders(extra));
      let status = 'queued';
      const timer = setTimeout(() => resolve(status), 1_500);
      stream.on('response', (headers) => {
        if (headers['grpc-status'] !== undefined) status = String(headers['grpc-status']);
      });
      stream.on('trailers', (trailers: http2.IncomingHttpHeaders) => {
        status = String(trailers['grpc-status']);
      });
      stream.on('error', () => {});
      stream.on('close', () => {
        clearTimeout(timer);
        resolve(status);
      });
      stream.resume();
      stream.end(checkFrame());
    });

  const holder = (session: http2.ClientHttp2Session) => {
    const held: http2.ClientHttp2Stream[] = [];
    return {
      hold: (count: number, extra: http2.OutgoingHttpHeaders = {}): void => {
        for (let i = 0; i < count; i += 1) {
          const stream = session.request(grpcHeaders(extra));
          stream.on('error', () => {});
          stream.write(new Uint8Array([0, 0, 0, 0, 10]));
          held.push(stream);
        }
      },
      /** How many held streams the server has not closed: all of them, or the budget refused one. */
      open: (): number => held.filter((stream) => !stream.closed).length,
      release: async (): Promise<void> => {
        held.forEach((stream) => stream.close());
        // Let the server see them go, so the next test starts with empty budgets.
        await new Promise((resolve) => setTimeout(resolve, 200));
      },
    };
  };

  it('runs the full edge budget and the full site budget on a single connection', async () => {
    const session = http2.connect(baseUrl);
    session.on('error', () => {});
    const { hold, open, release } = holder(session);
    try {
      await new Promise<void>((resolve) => session.once('remoteSettings', () => resolve()));
      hold(MAX_EDGE_STREAMS_PER_CLIENT, edgeHeaders(NEWSLETTER, 'agent-token'));
      hold(MAX_EDGE_STREAMS_PER_CLIENT, edgeHeaders(VERIFIER, 'verifier-token'));
      hold(MAX_ACTIVE_STREAMS - 1);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(open()).toBe(MAX_EDGE_STREAMS + MAX_ACTIVE_STREAMS - 1);
      // The site's last slot, on the same connection: served, not queued behind the cap.
      expect(await check(session)).toBe('0');
    } finally {
      await release();
      session.destroy();
    }
  });

  it('refuses a site call over its budget at once, on the same connection, instead of queueing it', async () => {
    const session = http2.connect(baseUrl);
    session.on('error', () => {});
    const { hold, open, release } = holder(session);
    try {
      await new Promise<void>((resolve) => session.once('remoteSettings', () => resolve()));
      hold(MAX_ACTIVE_STREAMS);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(open()).toBe(MAX_ACTIVE_STREAMS);
      expect(await check(session)).toBe('8');
    } finally {
      await release();
      session.destroy();
    }
  });
});
