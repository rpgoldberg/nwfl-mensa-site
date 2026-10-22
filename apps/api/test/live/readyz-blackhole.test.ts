// A1-FIX: /readyz recovers after the database's connections are black-holed
// (a host that vanishes without a reset, then a failover to a new primary).
// A probe that times out must DESTROY its client, or the hung clients fill the
// pool and readiness never comes back. A TCP proxy in the test black-holes the
// open connections while new ones still get through.
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../../src/db/pool.js';
import { createReadiness } from '../../src/readiness.js';

const url = process.env['NWFL_TEST_DATABASE_URL'];

interface Proxy {
  port: number;
  blackhole(): number;
  close(): Promise<void>;
}

function startProxy(targetPort: number): Promise<Proxy> {
  const live = new Set<{ client: net.Socket; upstream: net.Socket; holed: boolean }>();
  const server = net.createServer((client) => {
    const upstream = net.connect(targetPort, '127.0.0.1');
    const conn = { client, upstream, holed: false };
    live.add(conn);
    client.on('data', (data) => {
      if (!conn.holed) upstream.write(data);
    });
    upstream.on('data', (data) => {
      if (!conn.holed) client.write(data);
    });
    const end = (): void => {
      live.delete(conn);
      client.destroy();
      upstream.destroy();
    };
    for (const socket of [client, upstream]) {
      socket.on('close', end);
      socket.on('error', end);
    }
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: (server.address() as net.AddressInfo).port,
        blackhole: () => {
          live.forEach((conn) => (conn.holed = true));
          return live.size;
        },
        close: () =>
          new Promise<void>((done) => {
            live.forEach((conn) => {
              conn.client.destroy();
              conn.upstream.destroy();
            });
            server.close(() => done());
          }),
      }),
    ),
  );
}

describe.skipIf(url === undefined)('readyz after the database connections go dark', () => {
  let proxy: Proxy;

  beforeAll(async () => {
    proxy = await startProxy(Number(new URL(url as string).port));
  });

  afterAll(async () => {
    await proxy?.close();
  });

  // Deterministic under load (API-FIX3): nothing healthy is held to a short
  // deadline. The pool's two connections are opened by checking them out, not
  // by probes racing a timer; a probe's deadline (1 s) only ever has to catch a
  // connection that never answers; and recovery is waited for by count, with
  // no bound on how many probes it took.
  const PROBE_TIMEOUT_MS = 1_000;

  /** A pool through the proxy holding `size` open, idle connections. */
  const warmPool = async (size: number, env: Record<string, string> = {}) => {
    const through = new URL(url as string);
    through.port = String(proxy.port);
    const pool = createPool({ DATABASE_URL: through.toString(), PG_POOL_MAX: String(size), ...env });
    const clients = await Promise.all(Array.from({ length: size }, () => pool.connect()));
    await Promise.all(clients.map((client) => client.query('SELECT 1')));
    clients.forEach((client) => client.release());
    expect(pool.idleCount).toBe(size);
    return pool;
  };

  /** Probes until ready, up to `limit` times; how many it took. */
  const untilReady = async (readiness: ReturnType<typeof createReadiness>, limit = 30): Promise<boolean[]> => {
    const seen: boolean[] = [];
    while (seen.at(-1) !== true && seen.length < limit) seen.push((await readiness.check()).ready);
    return seen;
  };

  it('reports not ready while they hang, then ready again once new connections work', async () => {
    const pool = await warmPool(2);
    const readiness = createReadiness(pool, { probeTimeoutMs: PROBE_TIMEOUT_MS });
    try {
      expect(proxy.blackhole()).toBe(2);
      // A probe on a connection that never answers cannot be ready, however slow the host.
      expect((await readiness.check()).ready).toBe(false);
      expect((await untilReady(readiness)).at(-1)).toBe(true);
    } finally {
      await Promise.race([pool.end(), new Promise((resolve) => setTimeout(resolve, 1_000))]);
    }
  }, 60_000);

  // STACK-FIX: with RPC queries in flight on the dead connections, the probe's
  // own timeout is not enough: pool.query clients hung too and filled the pool.
  // The pool's query timeout fails them, and pool.query destroys a client its
  // query failed on, so new connections replace them.
  it.each([2, 4])('recovers with %i handler queries hung on the dead connections, as every RPC runs them', async (inflight) => {
    const pool = await warmPool(2, { PG_QUERY_TIMEOUT_MS: '2000', PG_STATEMENT_TIMEOUT_MS: '1500' });
    const readiness = createReadiness(pool, { probeTimeoutMs: PROBE_TIMEOUT_MS });
    try {
      expect(proxy.blackhole()).toBe(2);
      const handlers = Array.from({ length: inflight }, () => pool.query('SELECT 1').then(() => 'answered', () => 'failed'));
      expect((await untilReady(readiness)).at(-1)).toBe(true);
      // The handlers that drew the dead connections failed; none hangs.
      expect((await Promise.all(handlers)).filter((outcome) => outcome === 'failed').length).toBeGreaterThanOrEqual(2);
      expect(await pool.query('SELECT 1 AS one')).toMatchObject({ rows: [{ one: 1 }] });
    } finally {
      await Promise.race([pool.end(), new Promise((resolve) => setTimeout(resolve, 1_000))]);
    }
  }, 60_000);
});
