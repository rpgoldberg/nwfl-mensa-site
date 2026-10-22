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
import { MAX_ACTIVE_STREAMS, MAX_CONCURRENT_STREAMS, READ_MAX_BYTES, createGrpcServer } from '../../src/grpc/server.js';
import { createStructuredLogger } from '../../src/platform/logger.js';
import { createReadiness } from '../../src/readiness.js';
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
    it('holds at most 128 MiB in request buffers across the whole process', () => {
      expect(MAX_ACTIVE_STREAMS * READ_MAX_BYTES).toBeLessThanOrEqual(128 * 1024 * 1024);
    });

    it(`advertises at most ${MAX_CONCURRENT_STREAMS} concurrent streams per connection`, async () => {
      expect(MAX_CONCURRENT_STREAMS).toBeLessThanOrEqual(16);
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
