// ============================================================================
// W-WORKER: the PDF regeneration job's own process (src/worker.ts), as its own
// database role, nwfl_worker (0017). Only that role may claim a file and read
// its original; the server's role, nwfl, no longer can.
//
// The connection comes from the same variables as the server's (db/pool.ts:
// DATABASE_URL or PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD, PGSSLMODE,
// PGSSLROOTCERT, PG_POOL_MAX), set in the worker's own Deployment from its own
// Secret. PGUSER defaults to nwfl_worker, and any other user is refused, so the
// worker can never be started with the server's credentials. The pool is 2.
// ============================================================================
import pg from 'pg';
import { type Env, poolConfigFromEnv } from '../db/pool.js';
import { isolatedRedact } from './isolated.js';
import { type RegenerateOptions, startRegenerator } from './regenerate.js';

export const WORKER_ROLE = 'nwfl_worker';

const ignore = (): void => {};

/** The worker's pool settings; throws unless they connect as nwfl_worker. */
export function workerPoolConfig(env: Env): pg.PoolConfig {
  const config = poolConfigFromEnv({ PG_POOL_MAX: '2', ...env, PGUSER: env['PGUSER'] ?? WORKER_ROLE });
  let user: string | undefined;
  if (config.connectionString === undefined) user = config.user;
  else {
    try {
      user = decodeURIComponent(new URL(config.connectionString).username);
    } catch {
      throw new Error('DATABASE_URL is not a URL');
    }
  }
  if (user !== WORKER_ROLE) throw new Error(`the PDF worker connects as ${WORKER_ROLE}, not ${user === undefined || user === '' ? 'an unnamed role' : user}`);
  return config;
}

/** The worker's pool. An idle client dropping emits 'error' on it; unhandled, that would end the process. */
export function createWorkerPool(env: Env): pg.Pool {
  const pool = new pg.Pool(workerPoolConfig(env));
  pool.on('error', ignore);
  return pool;
}

/**
 * Starts the job on its own pool; stop() lets the current run finish, then closes the pool. Each copy
 * is made in a child process (isolated.ts; `engine` names another child module, for tests).
 */
export function runWorker(
  options: RegenerateOptions & { env: Env; engine?: string; intervalMs?: number; onError?: (error: unknown) => void },
): { stop(): Promise<void> } {
  const pool = createWorkerPool(options.env);
  const job = startRegenerator({ redact: isolatedRedact(options.engine === undefined ? {} : { module: options.engine }), ...options, db: pool });
  // The job's timer is unref'd (it never held the server open) and the worker has no listener, so
  // without this the process would exit at once. Cleared on stop, so a stopped worker can exit.
  const alive = setInterval(ignore, 60_000);
  return {
    stop: async () => {
      clearInterval(alive);
      await job.stop();
      await pool.end();
    },
  };
}
