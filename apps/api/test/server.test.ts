import { createClient } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import http2 from 'node:http2';
import { describe, expect, it } from 'vitest';
import { Health, HealthCheckResponse_ServingStatus as Status } from '../src/gen/grpc/health/v1/health_pb.js';
import type { Db } from '../src/db/pool.js';
import { createStructuredLogger } from '../src/platform/logger.js';
import { startServer } from '../src/server.js';
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

  it('closes only once when asked twice', async () => {
    const { sink } = captureLogs();
    const server = await startServer({ ...base, db: fakeDb(() => Promise.resolve({})), logger: createStructuredLogger({ sink }) });
    const first = server.close();
    const second = server.close();
    expect(second).toBe(first);
    await first;
  });
});
