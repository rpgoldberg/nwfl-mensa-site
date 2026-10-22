// A real gRPC server over a migrated throwaway database, with the production
// routes and interceptors and a FAKE token verifier, so read RPCs are tested
// end to end the way the BFF will call them. Rows are written as the app role.
import { createClient, type Client } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import type { DescService } from '@bufbuild/protobuf';
import type http2 from 'node:http2';
import pg from 'pg';
import type { TokenVerifier } from '../../src/auth/caller.js';
import { apiRoutes } from '../../src/grpc/routes.js';
import { apiInterceptors } from '../../src/grpc/interceptors.js';
import { createGrpcServer } from '../../src/grpc/server.js';
import { createStructuredLogger } from '../../src/platform/logger.js';
import { APP, APP_PW, dropDatabase, freshDatabase, migrate, urlFor } from './pg.js';
import { captureLogs, closeHard, listen } from './servers.js';

export const MEMBER = { headers: { authorization: 'Bearer member-token' } };
export const OFFICER = { headers: { authorization: 'Bearer officer-token' } };

export const fakeVerifier: TokenVerifier = {
  verify: (token) => {
    if (token === 'member-token') return Promise.resolve({ subject: 'sub-member', groups: ['nwfl-members'] });
    if (token === 'officer-token') return Promise.resolve({ subject: 'sub-officer', groups: ['nwfl-members', 'nwfl-officers'] });
    return Promise.reject(new Error('unknown token'));
  },
};

export interface Api {
  pool: pg.Pool;
  baseUrl: string;
  logs: Record<string, unknown>[];
  client<T extends DescService>(service: T): Client<T>;
  close(): Promise<void>;
}

/** Thursday 2026-10-22, 10:00 Central. */
export const NOW = new Date('2026-10-22T15:00:00Z');

export async function startApi(prefix: string): Promise<Api> {
  const db = await freshDatabase(prefix);
  const run = await migrate(db);
  if (run.code !== 0) throw new Error(`migrate failed: ${run.stderr}`);
  const pool = new pg.Pool({ connectionString: urlFor(APP, APP_PW, db), max: 4 });
  const { lines, sink } = captureLogs();
  const logger = createStructuredLogger({ sink });
  const server: http2.Http2Server = createGrpcServer({
    routes: apiRoutes({ db: pool, logger, now: () => NOW, readiness: { draining: false, startDraining: () => {}, check: () => Promise.resolve({ ready: true, db: 'ok', draining: false }) } }),
    interceptors: apiInterceptors({ logger, verifier: fakeVerifier }),
  });
  const baseUrl = await listen(server);
  const transport = createGrpcTransport({ baseUrl });
  return {
    pool,
    baseUrl,
    logs: lines,
    client: (service) => createClient(service, transport),
    close: async () => {
      await closeHard(server);
      await pool.end();
      await dropDatabase(db);
    },
  };
}

/** One row back from an INSERT ... RETURNING id. */
export async function insertId(pool: pg.Pool, text: string, values: unknown[] = []): Promise<string> {
  const result = await pool.query<{ id: string }>(text, values);
  return (result.rows[0] as { id: string }).id;
}

/** Everything a response carries, as text, for "this string appears nowhere" checks. */
export function dump(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : v,
  );
}
