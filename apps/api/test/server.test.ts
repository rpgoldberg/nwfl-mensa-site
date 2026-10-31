import { createClient } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import http2 from 'node:http2';
import { describe, expect, it, vi } from 'vitest';
import { Health, HealthCheckResponse_ServingStatus as Status } from '../src/gen/grpc/health/v1/health_pb.js';
import type { Db } from '../src/db/pool.js';
import { EventService } from '../src/gen/nwfl/mensa/v1/event_pb.js';
import { RedactionPolicyService } from '../src/gen/nwfl/mensa/v1/redaction_pb.js';
import type { TokenVerifier } from '../src/auth/caller.js';
import { MAX_EDGE_STREAMS_PER_CLIENT, READ_MAX_BYTES } from '../src/grpc/server.js';
import { HEALTH, NEWSLETTER, edgeHeaders, edgeVerifier } from './helpers/edge.js';
import { createStructuredLogger } from '../src/platform/logger.js';
import { startTelemetry } from '../src/platform/telemetry.js';
import { startServer } from '../src/server.js';
import { startTenantGate } from '../src/tenant.js';
import { h2Request } from './helpers/h2.js';
import { captureLogs } from './helpers/servers.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

async function get(port: number, path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.json() };
}

function connectRefused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const session = http2.connect(`http://127.0.0.1:${port}`);
    session.on('error', () => resolve(true));
    session.on('connect', () => {
      session.destroy();
      resolve(false);
    });
  });
}

const base = { host: '127.0.0.1', grpcPort: 0, healthPort: 0 };

/** Readiness probes only: these tests never reach a handler that needs rows. */
const fakeDb = (query: () => Promise<unknown>): Db => ({ query }) as unknown as Db;

describe('startServer', () => {
  it('serves gRPC and health on two separate ports', async () => {
    const { sink } = captureLogs();
    const server = await startServer({ ...base, db: fakeDb(() => Promise.resolve({})), logger: createStructuredLogger({ sink }) });
    try {
      expect(server.grpcPort).not.toBe(server.healthPort);
      const client = createClient(Health, createGrpcTransport({ baseUrl: `http://127.0.0.1:${server.grpcPort}` }));
      expect((await client.check({ service: '' })).status).toBe(Status.SERVING);
      expect(await get(server.healthPort, '/readyz')).toEqual({ status: 200, body: { status: 'ready', db: 'ok' } });
      // The health port is plain HTTP/1.1 and serves no RPC.
      expect((await fetch(`http://127.0.0.1:${server.healthPort}/grpc.health.v1.Health/Check`, { method: 'POST' })).status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('starts with the database down, stays not ready, and becomes ready once the tenant check passes, with no exit (CF-ISO-0)', async () => {
    const { sink } = captureLogs();
    let dbUp = false;
    const db = fakeDb(() => (dbUp ? Promise.resolve({ rows: [{ id: 'nwflorida' }] }) : Promise.reject(Object.assign(new Error('down'), { code: 'ECONNREFUSED' }))));
    const onMismatch = vi.fn();
    const gate = startTenantGate(() => db.query<{ id: string }>('SELECT id FROM tenant').then((r) => r.rows.map((row) => row.id)), 'nwflorida', { onMismatch, firstDelayMs: 10, maxDelayMs: 20 });
    const server = await startServer({ ...base, db, logger: createStructuredLogger({ sink }), tenantGate: gate });
    try {
      expect(await get(server.healthPort, '/readyz')).toEqual({ status: 503, body: { status: 'not_ready', db: 'down', tenant: 'unverified' } });
      dbUp = true;
      expect(await gate.settled).toBe('verified');
      expect(await get(server.healthPort, '/readyz')).toEqual({ status: 200, body: { status: 'ready', db: 'ok', tenant: 'verified' } });
      expect(onMismatch).not.toHaveBeenCalled();
    } finally {
      gate.stop();
      await server.close();
    }
  });

  it('hands the chapter\'s group prefix to the caller gate (CF-ISO-0)', async () => {
    const { sink } = captureLogs();
    const chapter: TokenVerifier = { verify: () => Promise.resolve({ client: 'site', subject: 'sub-chapter', groups: ['mensa-nwfl-officers'], scopes: [] }) };
    const db = fakeDb(() => Promise.resolve({ rows: [] }));
    const officerRead = async (groupPrefix?: string): Promise<unknown> => {
      const server = await startServer({ ...base, db, logger: createStructuredLogger({ sink }), verifier: chapter, ...(groupPrefix === undefined ? {} : { groupPrefix }) });
      try {
        const client = createClient(RedactionPolicyService, createGrpcTransport({ baseUrl: `http://127.0.0.1:${server.grpcPort}` }));
        return await client.getRedactionPolicy({}, { headers: { authorization: 'Bearer t' } }).then(() => 'ok', (error: { code?: number }) => error.code);
      } finally {
        await server.close();
      }
    };
    expect(await officerRead('mensa-nwfl-')).toBe('ok');
    // The default prefix, nwfl-, does not read mensa-nwfl-officers as an officer: PERMISSION_DENIED.
    expect(await officerRead()).toBe(7);
  });

  it('hands the configured edge identities and its verifier to the caller gate and the edge admission', async () => {
    const { sink } = captureLogs();
    const server = await startServer({ ...base, db: fakeDb(() => Promise.resolve({})), logger: createStructuredLogger({ sink }), edgeClientIds: ['edge.example'], verifier: edgeVerifier });
    const baseUrl = `http://127.0.0.1:${server.grpcPort}`;
    const viaEdge = (path: string, token?: string): http2.OutgoingHttpHeaders => edgeHeaders(path, token, { 'l5d-client-id': 'edge.example' });
    const statusOf = (res: Awaited<ReturnType<typeof h2Request>>): unknown => res.trailers['grpc-status'] ?? res.headers['grpc-status'];
    const session = http2.connect(baseUrl);
    session.on('error', () => {});
    try {
      // Admission: no token is refused at once; the gate: the agent reaches only its own service.
      expect(statusOf(await h2Request(baseUrl, viaEdge(NEWSLETTER), new Uint8Array(5)))).toBe('16');
      expect(statusOf(await h2Request(baseUrl, viaEdge(HEALTH, 'agent-token'), new Uint8Array(5)))).toBe('7');
      // The agent's budget: its streams held, its next call is refused and a site call is not.
      const held = Array.from({ length: MAX_EDGE_STREAMS_PER_CLIENT }, () => {
        const stream = session.request(viaEdge(NEWSLETTER, 'agent-token'));
        stream.on('error', () => {});
        stream.write(new Uint8Array([0, 0, 0, 0, 10]));
        return stream;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(statusOf(await h2Request(baseUrl, viaEdge(NEWSLETTER, 'agent-token'), new Uint8Array(5)))).toBe('8');
      expect(statusOf(await h2Request(baseUrl, edgeHeaders(HEALTH, undefined, { 'l5d-client-id': undefined }), new Uint8Array(5)))).toBe('0');
      held.forEach((stream) => stream.close());
    } finally {
      session.destroy();
      await server.close();
    }
  });

  it('drains: in-flight calls finish, readiness reports draining, new connections are refused', async () => {
    const { lines, sink } = captureLogs();
    const gate = deferred();
    let calls = 0;
    const db = fakeDb(() => {
      calls += 1;
      // The first call (the in-flight RPC) waits on the gate; probes do not.
      return calls === 1 ? gate.promise : Promise.resolve({});
    });
    const server = await startServer({ ...base, db, logger: createStructuredLogger({ sink }), drainTimeoutMs: 5_000 });
    const client = createClient(Health, createGrpcTransport({ baseUrl: `http://127.0.0.1:${server.grpcPort}` }));

    const inFlight = client.check({ service: '' });
    await expect.poll(() => calls).toBe(1);

    let closed = false;
    const closing = server.close().then(() => (closed = true));

    await expect.poll(async () => (await get(server.healthPort, '/readyz')).body).toEqual({ status: 'draining', db: 'ok' });
    expect(await connectRefused(server.grpcPort)).toBe(true);
    expect(closed).toBe(false);

    gate.resolve();
    await expect(inFlight).resolves.toMatchObject({ status: Status.NOT_SERVING });
    await closing;
    expect(closed).toBe(true);
    expect(await connectRefused(server.grpcPort)).toBe(true);
    await expect(fetch(`http://127.0.0.1:${server.healthPort}/healthz`)).rejects.toThrow();
    expect(lines.map((l) => l['msg'])).toEqual(expect.arrayContaining(['draining', 'drained']));
  });

  it('stops waiting at the drain deadline and cancels a wedged call', async () => {
    const { lines, sink } = captureLogs();
    let calls = 0;
    const db = fakeDb(() => (++calls === 1 ? new Promise<never>(() => {}) : Promise.resolve({})));
    const server = await startServer({ ...base, db, logger: createStructuredLogger({ sink }), drainTimeoutMs: 100 });
    const client = createClient(Health, createGrpcTransport({ baseUrl: `http://127.0.0.1:${server.grpcPort}` }));

    // The outcome is captured at once: the call fails DURING close(), and an
    // expectation attached afterwards would see an unhandled rejection first.
    const wedged = client.check({ service: '' }).then(
      () => 'resolved',
      (error: unknown) => error,
    );
    await expect.poll(() => calls).toBe(1);
    const started = Date.now();
    await server.close();
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(await wedged).toBeInstanceOf(Error);
    expect(lines.map((l) => l['msg'])).toContain('drain deadline reached');
  });

  it('wires the production interceptors in order: trace, then access log, then auth', async () => {
    const telemetry = startTelemetry();
    const { lines, sink } = captureLogs();
    const server = await startServer({ ...base, db: fakeDb(() => Promise.resolve({})), logger: createStructuredLogger({ sink }) });
    try {
      const caller = '4bf92f3577b34da6a3ce929d0e0e4736';
      const baseUrl = `http://127.0.0.1:${server.grpcPort}`;
      await createClient(Health, createGrpcTransport({ baseUrl })).check({ service: '' }, { headers: { traceparent: `00-${caller}-00f067aa0ba902b7-01` } });
      // Inside the trace span: the access line carries the caller's trace id.
      expect(lines.find((l) => l['msg'] === 'rpc')).toMatchObject({ component: 'grpc', rpc: 'grpc.health.v1.Health/Check', code: 'ok', traceId: caller });
      // Auth inside the access log: a refused token is still logged.
      await expect(createClient(EventService, createGrpcTransport({ baseUrl })).listVenues({}, { headers: { authorization: 'Bearer x' } })).rejects.toThrow();
      const refused = lines.filter((l) => l['msg'] === 'rpc').at(-1);
      expect(refused).toMatchObject({ rpc: 'nwfl.mensa.v1.EventService/ListVenues', code: 'unauthenticated' });
      // Logged by the access log itself, not as an early error of the gRPC layer.
      expect(refused?.['early']).toBeUndefined();
      expect(typeof refused?.['duration_ms']).toBe('number');
      // Early errors are logged too, by the gRPC layer itself.
      const header = new Uint8Array(5);
      new DataView(header.buffer).setUint32(1, READ_MAX_BYTES + 1);
      await h2Request(baseUrl, { ':method': 'POST', ':path': '/grpc.health.v1.Health/Check', 'content-type': 'application/grpc', te: 'trailers' }, header);
      await expect.poll(() => lines.filter((l) => l['msg'] === 'rpc').at(-1)).toMatchObject({ code: 'resource_exhausted', early: true, component: 'grpc' });
    } finally {
      await server.close();
      await telemetry.shutdown();
    }
  });

  it('sends GOAWAY to idle sessions at once, so close() does not wait for the deadline', async () => {
    const { sink } = captureLogs();
    const server = await startServer({ ...base, db: fakeDb(() => Promise.resolve({})), logger: createStructuredLogger({ sink }), drainTimeoutMs: 5_000 });
    // The client keeps its session open after the call: idle, not in flight.
    await createClient(Health, createGrpcTransport({ baseUrl: `http://127.0.0.1:${server.grpcPort}` })).check({ service: '' });
    const started = Date.now();
    await server.close();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('closes only once when asked twice', async () => {
    const { sink } = captureLogs();
    const server = await startServer({ ...base, db: fakeDb(() => Promise.resolve({})), logger: createStructuredLogger({ sink }) });
    const first = server.close();
    const second = server.close();
    expect(second).toBe(first);
    await first;
  });
});
