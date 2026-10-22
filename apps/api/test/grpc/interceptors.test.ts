// R15: request logging never logs request bodies. Officer-report text arrives
// in request messages, so the access log records the method, the outcome and
// the duration, and nothing the caller sent.
import { Code, createClient } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import type http2 from 'node:http2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Health } from '../../src/gen/grpc/health/v1/health_pb.js';
import { healthRoutes } from '../../src/grpc/health.js';
import { accessLogInterceptor, codeName, headersGetter, traceServerInterceptor } from '../../src/grpc/interceptors.js';
import { createGrpcServer } from '../../src/grpc/server.js';
import { createStructuredLogger } from '../../src/platform/logger.js';
import { startTelemetry, type Telemetry } from '../../src/platform/telemetry.js';
import type { Readiness } from '../../src/readiness.js';
import { captureLogs, closeHard, listen } from '../helpers/servers.js';

const CANARY = 'CANARY-officer-report-7f3a9c';
const CALLER_TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

describe('gRPC interceptors', () => {
  let telemetry: Telemetry;
  let server: http2.Http2Server;
  let baseUrl: string;
  const { lines, sink } = captureLogs();
  let behaviour: 'ok' | 'throw' | 'throw-string' = 'ok';

  const readiness: Readiness = {
    draining: false,
    startDraining: () => {},
    check: () => {
      if (behaviour === 'throw') return Promise.reject(new Error(`pg: duplicate key (slug)=(${CANARY})`));
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a non-Error rejection is the case under test
      if (behaviour === 'throw-string') return Promise.reject(CANARY);
      return Promise.resolve({ ready: true, db: 'ok', draining: false });
    },
  };

  beforeAll(async () => {
    telemetry = startTelemetry();
    const logger = createStructuredLogger({ sink });
    server = createGrpcServer({
      routes: healthRoutes(readiness),
      interceptors: [traceServerInterceptor(), accessLogInterceptor(logger)],
    });
    baseUrl = await listen(server);
  });

  afterAll(async () => {
    await closeHard(server);
    await telemetry.shutdown();
  });

  const client = () => createClient(Health, createGrpcTransport({ baseUrl }));

  it('logs the method, the code and the duration of a successful call', async () => {
    lines.length = 0;
    await client().check({ service: '' });
    const access = lines.filter((l) => l['msg'] === 'rpc');
    expect(access).toHaveLength(1);
    expect(access[0]).toMatchObject({ rpc: 'grpc.health.v1.Health/Check', code: 'ok' });
    expect(typeof access[0]?.['duration_ms']).toBe('number');
  });

  it('never logs the request message, even when the call fails', async () => {
    lines.length = 0;
    await expect(client().check({ service: CANARY })).rejects.toMatchObject({ code: Code.NotFound });
    expect(JSON.stringify(lines)).not.toContain(CANARY);
    expect(lines.find((l) => l['msg'] === 'rpc')).toMatchObject({ code: 'not_found' });
  });

  it('masks an unexpected error: INTERNAL to the caller, no error text in the log or on the wire', async () => {
    lines.length = 0;
    behaviour = 'throw';
    try {
      const error = await client().check({ service: '' }).then(
        () => undefined,
        (e: unknown) => e as { code: Code; rawMessage: string },
      );
      expect(error?.code).toBe(Code.Internal);
      expect(error?.rawMessage).toBe('internal error');
    } finally {
      behaviour = 'ok';
    }
    expect(JSON.stringify(lines)).not.toContain(CANARY);
    expect(lines.find((l) => l['msg'] === 'rpc')).toMatchObject({ code: 'internal', error: 'Error' });
  });

  it('masks a thrown non-Error value the same way, logging only its type', async () => {
    lines.length = 0;
    behaviour = 'throw-string';
    try {
      await expect(client().check({ service: '' })).rejects.toMatchObject({ code: Code.Internal, rawMessage: 'internal error' });
    } finally {
      behaviour = 'ok';
    }
    expect(JSON.stringify(lines)).not.toContain(CANARY);
    expect(lines.find((l) => l['msg'] === 'rpc')).toMatchObject({ code: 'internal', error: 'string' });
  });

  it('continues the caller trace, so the access line carries the caller trace id', async () => {
    lines.length = 0;
    await client().check(
      { service: '' },
      { headers: { traceparent: `00-${CALLER_TRACE}-00f067aa0ba902b7-01` } },
    );
    const access = lines.find((l) => l['msg'] === 'rpc');
    expect(access?.['traceId']).toBe(CALLER_TRACE);
    expect(String(access?.['trace'])).toMatch(new RegExp(`^trace=${CALLER_TRACE} span=[0-9a-f]{16}$`));
  });

  it('opens a fresh trace when the caller sends none', async () => {
    lines.length = 0;
    await client().check({ service: '' });
    const access = lines.find((l) => l['msg'] === 'rpc');
    expect(access?.['traceId']).toMatch(/^[0-9a-f]{32}$/);
    expect(access?.['traceId']).not.toBe(CALLER_TRACE);
  });
});

describe('interceptor helpers', () => {
  it('names gRPC codes in snake case', () => {
    expect(codeName(Code.NotFound)).toBe('not_found');
    expect(codeName(Code.ResourceExhausted)).toBe('resource_exhausted');
    expect(codeName(Code.Internal)).toBe('internal');
  });

  it('reads WHATWG headers for the propagator', () => {
    const headers = new Headers({ traceparent: 'x', other: 'y' });
    expect(headersGetter.get(headers, 'traceparent')).toBe('x');
    expect(headersGetter.get(headers, 'absent')).toBeUndefined();
    expect(headersGetter.keys(headers)).toEqual(['other', 'traceparent']);
  });
});
