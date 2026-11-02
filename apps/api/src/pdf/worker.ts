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
//
// UNTRUSTED-PDF-GATE: the engine is the in-pod child (isolated.ts) unless
// PDF_ENGINE_SOCKET names the engine sidecar's socket (socket-engine.ts); then
// only the sidecar, never a fallback. Either way the output gate is re-run
// here on every copy before it is stored (rerun.ts).
// ============================================================================
import pg from 'pg';
import { type Env, type Warn, onIdleError, poolConfigFromEnv } from '../db/pool.js';
import { isolatedRedact } from './isolated.js';
import { type Redact, type RegenerateOptions, startRegenerator } from './regenerate.js';
import { withGateRerun } from './rerun.js';
import { engineSocketPath, socketRedact } from './socket-engine.js';
import { type TenantGate, type TenantGateOptions, policyTenants, startTenantGate } from '../tenant.js';

export const WORKER_ROLE = 'nwfl_worker';

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

/** The worker's pool; a dropped idle connection is logged (db/pool.ts onIdleError), never fatal. */
export function createWorkerPool(env: Env, warn?: Warn): pg.Pool {
  return onIdleError(new pg.Pool(workerPoolConfig(env)), warn);
}

export interface EngineOptions {
  /** The in-pod child's module (default the built engine-child.js); another, for tests. */
  engine?: string;
  /** Where PDF_ENGINE_SOCKET may point (default /run/pdf-engine); another, for tests. */
  socketDirs?: readonly string[];
  /** How long the worker waits for the sidecar's reply (default SOCKET_TIMEOUT_MS). */
  engineTimeoutMs?: number;
  /** An engine of the caller's; the gate is still re-run on it. */
  redact?: Redact;
}

/**
 * The engine the worker makes copies with: the sidecar when PDF_ENGINE_SOCKET is set, else the
 * in-pod child, with the output gate re-run on every copy. Throws for a PDF_ENGINE_SOCKET outside
 * the allowed directory.
 */
export function workerRedact(env: Env, options: EngineOptions): Redact {
  const socket = engineSocketPath(env, options.socketDirs);
  const engine =
    options.redact ??
    (socket === undefined
      ? isolatedRedact(options.engine === undefined ? {} : { module: options.engine })
      : socketRedact({ path: socket, ...(options.engineTimeoutMs === undefined ? {} : { timeoutMs: options.engineTimeoutMs }) }));
  return withGateRerun(engine);
}

/**
 * Starts the job on its own pool; stop() lets the current run finish, then closes the pool. Each copy
 * is made by workerRedact's engine: in a child process (isolated.ts; `engine` names another child
 * module, for tests) or in the sidecar.
 *
 * With `tenant` (CF-ISO-0, tenant.ts), the job starts only once the database is verified to serve that
 * tenant; until then a database that does not answer is retried with backoff and no file is claimed.
 * nwfl_worker may not read the tenant table, so the gate reads the tenant its redaction policy references.
 */
export function runWorker(
  options: RegenerateOptions &
    EngineOptions & {
    env: Env;
    intervalMs?: number;
    onError?: (error: unknown) => void;
    warn?: Warn;
    tenant?: { id: string } & Omit<TenantGateOptions, 'what'>;
  },
): { stop(): Promise<void> } {
  const redact = workerRedact(options.env, options);
  const pool = createWorkerPool(options.env, options.warn);
  const start = (): { stop(): Promise<void> } => startRegenerator({ ...options, redact, db: pool });
  let job: { stop(): Promise<void> } | undefined;
  let gate: TenantGate | undefined;
  let stopping = false;
  let started: Promise<void> = Promise.resolve();
  if (options.tenant === undefined) job = start();
  else {
    const { id, ...gateOptions } = options.tenant;
    gate = startTenantGate(policyTenants(pool), id, { ...gateOptions, what: 'redaction policy tenant' });
    started = gate.settled.then((outcome) => {
      if (outcome === 'verified' && !stopping) job = start();
    });
  }
  // The job's timer is unref'd (it never held the server open) and the worker has no listener, so
  // without this the process would exit at once. Cleared on stop, so a stopped worker can exit.
  const alive = setInterval(Date.now, 60_000); // any cheap callback: the timer is what keeps the process up
  return {
    stop: async () => {
      stopping = true;
      clearInterval(alive);
      gate?.stop();
      await started;
      await job?.stop();
      await pool.end();
    },
  };
}
