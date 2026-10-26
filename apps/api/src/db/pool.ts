// ============================================================================
// The ONE place Postgres connections are configured. Production sets
// DATABASE_URL (or the discrete PG* variables) plus PGSSLMODE=verify-full and
// PGSSLROOTCERT, the mounted CNPG CA. TLS is a deployment setting, never a code
// change.
// ============================================================================
import { readFileSync } from 'node:fs';
import type { ConnectionOptions } from 'node:tls';
import pg from 'pg';

export type Env = Record<string, string | undefined>;

const DEFAULT_POOL_MAX = 10;
// node-postgres waits for a connection forever by default; a pod whose
// database has gone away should fail its calls, not hang them.
const CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
// Every query, not only the probe's: the server ends a statement after
// statement_timeout, and the client gives up on a reply after query_timeout,
// which is what frees a client whose connection went dark without a reset
// (pool.query destroys a client its query failed on; inTransaction does too).
// The client's limit is the longer, so a slow but live query gets the
// server's own error first. keepAlive lets the kernel notice a dead peer.
const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000;
const DEFAULT_QUERY_TIMEOUT_MS = 12_000;
// HARDEN-1: one row (publication_ledger_head) serializes every ledger append and every change that
// can alter a rendering. A writer waiting on it gives up after lock_timeout rather than queueing
// behind a stuck holder, and a transaction left open and idle is ended by the server after
// idle_in_transaction_session_timeout, so no connection can hold the lock indefinitely. Both are
// startup parameters, so they are set on every connection the pool opens, the worker's too.
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_TX_TIMEOUT_MS = 30_000;

const positive = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * PGSSLMODE -> node-postgres `ssl`. verify-full reads the CA file CONTENTS:
 * the driver wants PEM bytes, and a path would give an unverifiable session.
 */
export function sslFromEnv(env: Env = process.env): ConnectionOptions | undefined {
  const mode = env['PGSSLMODE'];
  if (mode === undefined || mode === '' || mode === 'disable') return undefined;
  if (mode === 'require') return { rejectUnauthorized: false };
  if (mode === 'verify-full') {
    const caPath = env['PGSSLROOTCERT'];
    return { rejectUnauthorized: true, ...(caPath !== undefined ? { ca: readFileSync(caPath, 'utf8') } : {}) };
  }
  throw new Error(`unsupported PGSSLMODE '${mode}' (supported: disable | require | verify-full)`);
}

export function poolConfigFromEnv(env: Env = process.env): pg.PoolConfig {
  const url = env['DATABASE_URL'];
  const ssl = sslFromEnv(env);
  return {
    ...(url !== undefined
      ? { connectionString: url }
      : {
          host: env['PGHOST'] ?? '127.0.0.1',
          port: Number(env['PGPORT'] ?? '5432'),
          user: env['PGUSER'] ?? 'nwfl',
          password: env['PGPASSWORD'] ?? '',
          database: env['PGDATABASE'] ?? 'nwfl',
        }),
    // After the URL, so PGSSLMODE beats any sslmode inside it.
    ...(ssl !== undefined ? { ssl } : {}),
    max: positive(env['PG_POOL_MAX'], DEFAULT_POOL_MAX),
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: positive(env['PG_STATEMENT_TIMEOUT_MS'], DEFAULT_STATEMENT_TIMEOUT_MS),
    query_timeout: positive(env['PG_QUERY_TIMEOUT_MS'], DEFAULT_QUERY_TIMEOUT_MS),
    lock_timeout: positive(env['PG_LOCK_TIMEOUT_MS'], DEFAULT_LOCK_TIMEOUT_MS),
    idle_in_transaction_session_timeout: positive(env['PG_IDLE_TX_TIMEOUT_MS'], DEFAULT_IDLE_TX_TIMEOUT_MS),
    keepAlive: true,
  };
}

/** host:port/database for the startup log. The userinfo, which holds the password, is dropped. */
export function describeTarget(env: Env = process.env): string {
  const url = env['DATABASE_URL'];
  if (url !== undefined) {
    try {
      const parsed = new URL(url);
      return `${parsed.host}${parsed.pathname}`;
    } catch {
      return '<unparseable>';
    }
  }
  const host = env['PGHOST'];
  if (host === undefined) return 'unknown';
  return `${host}:${env['PGPORT'] ?? '5432'}/${env['PGDATABASE'] ?? 'nwfl'}`;
}

export function createPool(env: Env = process.env): pg.Pool {
  const pool = new pg.Pool(poolConfigFromEnv(env));
  // An IDLE client dropping emits 'error' on the pool; unhandled, that would
  // crash the process. Checked-out clients surface errors per query.
  pool.on('error', () => {});
  return pool;
}

/** The slice of pg.Pool a probe needs, so readiness is testable without a database. */
export interface QueryableDb {
  query(text: string): Promise<unknown>;
  /** A pool's checkout. When present the probe uses its own client, and destroys it on a timeout. */
  connect?(): Promise<{ query(text: string): Promise<unknown>; release(destroy?: boolean): void }>;
}

/** The slice of pg.Pool the RPC handlers need: parameterised queries that return rows. */
export interface Db extends QueryableDb {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

export interface DatabaseProbe {
  reachable: boolean;
  latencyMs: number;
  /** The driver's error CODE only. Its MESSAGE routinely echoes the DSN or the user. */
  code?: string;
}

export async function probeDatabase(db: QueryableDb, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Promise<DatabaseProbe> {
  const started = performance.now();
  const elapsed = (): number => performance.now() - started;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('probe timeout'), { code: 'TIMEOUT' })), timeoutMs);
  });
  // A pool: check out a client of our own, so a probe that times out can DESTROY it. Released
  // normally, a client stuck on a black-holed connection would go back to the pool and the
  // next probe would hang on it; kept checked out, hung clients fill the pool until readiness
  // never recovers. release(true) drops the connection and lets the pool open a new one.
  let client: Awaited<ReturnType<NonNullable<QueryableDb['connect']>>> | undefined;
  let abandoned = false;
  const attempt =
    db.connect === undefined
      ? db.query('SELECT 1')
      : db.connect().then(async (checkedOut) => {
          if (abandoned) {
            checkedOut.release(true);
            return;
          }
          client = checkedOut;
          await checkedOut.query('SELECT 1');
        });
  attempt.catch(() => {});
  try {
    await Promise.race([attempt, timeout]);
    client?.release();
    return { reachable: true, latencyMs: elapsed() };
  } catch (error) {
    abandoned = true;
    client?.release(true);
    const code =
      typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : 'UNKNOWN';
    return { reachable: false, latencyMs: elapsed(), code };
  } finally {
    clearTimeout(timer);
  }
}
