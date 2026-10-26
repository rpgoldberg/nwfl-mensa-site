// A real gRPC server over a migrated throwaway database, with the production
// routes and interceptors and a FAKE token verifier, so read RPCs are tested
// end to end the way the BFF will call them. Rows are written as the app role.
import { createClient, type Client } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import type { DescService } from '@bufbuild/protobuf';
import type http2 from 'node:http2';
import pg from 'pg';
import type { TokenVerifier, VerifiedToken } from '../../src/auth/caller.js';
import { dbStanding } from '../../src/auth/standing.js';
import { apiRoutes } from '../../src/grpc/routes.js';
import { apiInterceptors } from '../../src/grpc/interceptors.js';
import { createGrpcServer } from '../../src/grpc/server.js';
import { createStructuredLogger } from '../../src/platform/logger.js';
import { APP, APP_PW, WORKER, WORKER_PW, dropDatabase, freshDatabase, migrate, urlFor } from './pg.js';
import { captureLogs, closeHard, listen } from './servers.js';

export const MEMBER = { headers: { authorization: 'Bearer member-token' } };
export const OFFICER = { headers: { authorization: 'Bearer officer-token' } };

/** Made-up people, by token. Groups as the nwfl-site provider would emit them. */
export const PEOPLE: Record<string, VerifiedToken> = {
  'member-token': { client: 'site', subject: 'sub-member', groups: ['nwfl-members'], scopes: [] },
  'officer-token': { client: 'site', subject: 'sub-officer', groups: ['nwfl-members', 'nwfl-officers'], scopes: [] },
  // Publications Officer.
  'pub-token': { client: 'site', subject: 'sub-pub', groups: ['nwfl-members', 'nwfl-officers', 'nwfl-office-publications'], scopes: [] },
  // Treasurer.
  'treasurer-token': { client: 'site', subject: 'sub-treasurer', groups: ['nwfl-members', 'nwfl-officers', 'nwfl-office-treasurer'], scopes: [] },
  // The Admin, who also holds two offices (the Ross pattern, with a made-up subject).
  'admin-token': {
    client: 'site',
    subject: 'sub-admin',
    groups: ['nwfl-members', 'nwfl-officers', 'nwfl-office-publications', 'nwfl-office-editor', 'nwfl-admin'],
    scopes: [],
  },
  // People signing up: pending, with the name and email their token carries.
  'joiner-token': { client: 'site', subject: 'sub-joiner', groups: ['nwfl-pending'], scopes: [], name: 'Jamie Example', email: 'jamie@example.org' },
  'joiner2-token': { client: 'site', subject: 'sub-joiner2', groups: ['nwfl-pending'], scopes: [], name: 'Robin Sample', email: 'robin@example.org' },
  'joiner3-token': { client: 'site', subject: 'sub-joiner3', groups: ['nwfl-pending'], scopes: [], name: 'Morgan Fictional', email: 'morgan@example.org' },
  'affiliate-token': { client: 'site', subject: 'sub-affiliate', groups: ['nwfl-affiliates', 'nwfl-role-rvc'], scopes: [], name: 'Avery Madeup', email: 'avery@example.org' },
  'noprofile-token': { client: 'site', subject: 'sub-noprofile', groups: ['nwfl-pending'], scopes: [] },
  'bademail-token': { client: 'site', subject: 'sub-bademail', groups: ['nwfl-pending'], scopes: [], name: 'Lee Example', email: 'not an address' },
  'racer-token': { client: 'site', subject: 'sub-racer', groups: ['nwfl-pending'], scopes: [], name: 'Quinn Example', email: 'quinn@example.org' },
  // The Membership Officer: approves sign-ups; also signs up once, to show no one decides their own.
  'approver-token': {
    client: 'site',
    subject: 'sub-approver',
    groups: ['nwfl-members', 'nwfl-officers', 'nwfl-office-membership', 'nwfl-membership-approvers'],
    scopes: [],
    name: 'Casey Placeholder',
    email: 'casey@example.org',
  },
  // The newsletter agent and the membership verifier (machine clients).
  'agent-token': { client: 'agent', subject: 'svc-nwfl-newsletter', groups: [], scopes: ['newsletter.read'] },
  'verifier-token': { client: 'verifier', subject: 'svc-nwfl-verifier', groups: [], scopes: ['membership.verify'] },
  // The Webmaster, who also holds the webmaster seat.
  'webmaster-token': { client: 'site', subject: 'sub-webmaster', groups: ['nwfl-members', 'nwfl-officers', 'nwfl-office-webmaster', 'nwfl-webmaster'], scopes: [] },
};

export const fakeVerifier: TokenVerifier = {
  verify: (token) => {
    const person = PEOPLE[token];
    return person === undefined ? Promise.reject(new Error('unknown token')) : Promise.resolve(person);
  },
};

/** Call options carrying a made-up person's bearer token. */
export const as = (token: keyof typeof PEOPLE  ): { headers: Record<string, string> } => ({ headers: { authorization: `Bearer ${token}` } });

export interface Api {
  pool: pg.Pool;
  /** The PDF regeneration worker's connection (0017): only it may run the job. */
  worker: pg.Pool;
  baseUrl: string;
  logs: Record<string, unknown>[];
  client<T extends DescService>(service: T): Client<T>;
  close(): Promise<void>;
}

/** Thursday 2026-10-22, 10:00 Central. */
export const NOW = new Date('2026-10-22T15:00:00Z');

export async function startApi(prefix: string, options: { verifier?: TokenVerifier; now?: () => Date } = {}): Promise<Api> {
  const now = options.now ?? ((): Date => NOW);
  const db = await freshDatabase(prefix);
  const run = await migrate(db);
  if (run.code !== 0) throw new Error(`migrate failed: ${run.stderr}`);
  const pool = new pg.Pool({ connectionString: urlFor(APP, APP_PW, db), max: 4 });
  const worker = new pg.Pool({ connectionString: urlFor(WORKER, WORKER_PW, db), max: 2 });
  // The member reads at member level because member_account says so (AC6 b), not because of its token groups.
  await pool.query(
    `INSERT INTO member_account (sub, status, route, approved_by_sub, approved_at, verified_on) VALUES ('sub-member', 'member', 'signup', 'sub-approver', now(), '2026-10-01')`,
  );
  const { lines, sink } = captureLogs();
  const logger = createStructuredLogger({ sink });
  const server: http2.Http2Server = createGrpcServer({
    routes: apiRoutes({ db: pool, logger, now, readiness: { draining: false, startDraining: () => {}, check: () => Promise.resolve({ ready: true, db: 'ok', draining: false }) } }),
    interceptors: apiInterceptors({ logger, verifier: options.verifier ?? fakeVerifier, standing: dbStanding(pool, now) }),
    // As in production: the gate's verifier also admits edge streams.
    verifier: options.verifier ?? fakeVerifier,
  });
  const baseUrl = await listen(server);
  const transport = createGrpcTransport({ baseUrl });
  return {
    pool,
    worker,
    baseUrl,
    logs: lines,
    client: (service) => createClient(service, transport),
    close: async () => {
      await closeHard(server);
      await pool.end();
      await worker.end();
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
