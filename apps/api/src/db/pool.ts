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
  const poolMax = Number(env['PG_POOL_MAX']);
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
    max: Number.isFinite(poolMax) && poolMax > 0 ? poolMax : DEFAULT_POOL_MAX,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
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
  try {
    await Promise.race([db.query('SELECT 1'), timeout]);
    return { reachable: true, latencyMs: elapsed() };
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : 'UNKNOWN';
    return { reachable: false, latencyMs: elapsed(), code };
  } finally {
    clearTimeout(timer);
  }
}
