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
// only the sidecar, never a fallback, and PDF_GATE_SOCKET must name the gate
// sidecar's (socket-gate.ts), or the worker refuses to start. Either way the
// output gate is re-run on every copy before it is stored (rerun.ts), and
// never in this process: in the gate sidecar, or (in the in-pod mode, the
// pre-sidecar mode only) in a capped child of the worker (gate-isolated.ts).
//
// LINKS L3: LINK_ORIGIN (link-annots.ts linkOrigin; the site's by default) is what a
// copy's links point to, checked before the pool opens. Once the job may run
// (the tenant verified), the worker sweeps once before its first run (regenerate.ts sweepCopies):
// every file with no copy for its current inputs is queued, so an engine bump
// or a new origin is made good without waiting for a trigger.
//
// ARCHIVE-SEARCH S2: the worker also keeps the search index's issue text
// (search/pages.ts): the text of each copy an audience is served, read by the
// gate (workerText: the sidecar, or the in-pod child), never here, and written
// through search_page_put. After each finished run, and in a sweep of its own.
// ============================================================================
import pg from 'pg';
import { type Env, type Warn, onIdleError, poolConfigFromEnv } from '../db/pool.js';
import { type IsolatedGateOptions, isolatedGate, isolatedText } from './gate-isolated.js';
import { isolatedRedact } from './isolated.js';
import { type Redact, type RegenerateOptions, startRegenerator, sweepCopies } from './regenerate.js';
import { linkOrigin } from './link-annots.js';
import { type Gate, withGateRerun } from './rerun.js';
import { socketRedact, workerSockets } from './socket-engine.js';
import { socketGate, socketText } from './socket-gate.js';
import { type Texter, indexFile, indexSweeper } from '../search/pages.js';
import { type TenantGate, type TenantGateOptions, policyTenants, startTenantGate } from '../tenant.js';
import { UNTRUSTED_PDF_READY } from './untrusted.js';

export const WORKER_ROLE = 'nwfl_worker';

/**
 * The in-pod gate child's memory cap: 384 MiB in fix round 3 refused ordinary copies of about 4 MiB with
 * photos, so 640 MiB from fix round 4 (S3). With the worker's ~150 MiB, a check fits the worker container
 * only at 1Gi (fc decides: fc-manifest-needs.md, the in-pod rows). If the kernel's OOM killer acts anyway,
 * it kills the whole container (k3s on cgroup v2), which restarts, and the job retries under the attempt
 * cap. The gate sidecar keeps GATE_MAX_RSS_BYTES in its own 1Gi container.
 */
export const IN_POD_GATE_MAX_RSS_BYTES = 640 * 1024 * 1024;

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
  /** Where PDF_GATE_SOCKET may point (default /run/pdf-gate); another, for tests. */
  gateSocketDirs?: readonly string[];
  /** How long the worker waits for the engine sidecar's reply (default SOCKET_TIMEOUT_MS). */
  engineTimeoutMs?: number;
  /** How long the worker waits for the gate sidecar's reply (default GATE_SOCKET_TIMEOUT_MS). */
  gateTimeoutMs?: number;
  /** An engine of the caller's; the gate is still re-run on it. */
  redact?: Redact;
  /** The in-pod gate child's module (default the built gate-child.js), its Node flags, deadline and memory cap; for tests. */
  gateChild?: string;
  gateNodeFlags?: readonly string[];
  gateChildTimeoutMs?: number;
  gateMaxRssBytes?: number;
  /** How the in-pod gate child's memory is read; a spy, for tests. */
  gateRss?: (pid: number) => number;
  /** UNTRUSTED_PDF_READY (default the flag itself); injected, for tests only. */
  ready?: boolean;
}

/**
 * The engine the worker makes copies with, and the gate that checks each copy: the sidecars when
 * PDF_ENGINE_SOCKET (and so PDF_GATE_SOCKET) is set, else the in-pod children. Throws for a socket
 * outside its directory, PDF_ENGINE_SOCKET without PDF_GATE_SOCKET, or both in one directory; and,
 * once UNTRUSTED_PDF_READY is true, without both sockets (fix round 3, S6): the in-pod children run
 * as the worker's uid, beside its database login, so they are the pre-sidecar mode only.
 */
export function workerRedact(env: Env, options: EngineOptions): Redact {
  const sockets = workerSockets(env, { engineDirs: options.socketDirs, gateDirs: options.gateSocketDirs });
  if ((options.ready ?? UNTRUSTED_PDF_READY) && (sockets.engine === undefined || sockets.gate === undefined)) {
    throw new Error('UNTRUSTED_PDF_READY is true: the worker parses PDFs only in the sidecars; set PDF_ENGINE_SOCKET and PDF_GATE_SOCKET');
  }
  const engine =
    options.redact ??
    (sockets.engine === undefined
      ? isolatedRedact(options.engine === undefined ? {} : { module: options.engine })
      : socketRedact({ path: sockets.engine, ...(options.engineTimeoutMs === undefined ? {} : { timeoutMs: options.engineTimeoutMs }) }));
  const gate: Gate =
    sockets.gate === undefined ? isolatedGate(inPodChild(options)) : socketGate({ path: sockets.gate, ...(options.gateTimeoutMs === undefined ? {} : { timeoutMs: options.gateTimeoutMs }) });
  return withGateRerun(engine, gate);
}

/** The in-pod gate child's limits (the pre-sidecar mode): a check's and a text reading's are the same. */
function inPodChild(options: EngineOptions): IsolatedGateOptions {
  return {
    ...(options.gateChild === undefined ? {} : { module: options.gateChild }),
    ...(options.gateNodeFlags === undefined ? {} : { nodeFlags: options.gateNodeFlags }),
    ...(options.gateChildTimeoutMs === undefined ? {} : { timeoutMs: options.gateChildTimeoutMs }),
    maxRssBytes: options.gateMaxRssBytes ?? IN_POD_GATE_MAX_RSS_BYTES,
    ...(options.gateRss === undefined ? {} : { rss: options.gateRss }),
  };
}

/**
 * How the worker reads the text of a stored copy's pages for the search index (ARCHIVE-SEARCH S2), never in this
 * process: the gate sidecar when PDF_GATE_SOCKET is set, and then only the sidecar; else the gate's capped in-pod
 * child (the pre-sidecar mode). Throws as workerRedact does for a socket outside its directory.
 */
export function workerText(env: Env, options: EngineOptions): Texter {
  const sockets = workerSockets(env, { engineDirs: options.socketDirs, gateDirs: options.gateSocketDirs });
  return sockets.gate === undefined ? isolatedText(inPodChild(options)) : socketText({ path: sockets.gate, ...(options.gateTimeoutMs === undefined ? {} : { timeoutMs: options.gateTimeoutMs }) });
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
  const text = workerText(options.env, options);
  const origin = options.origin ?? linkOrigin(options.env);
  const pool = createWorkerPool(options.env, options.warn);
  const indexing = { text, origin, ...(options.warn === undefined ? {} : { warn: options.warn }) };
  // The boot sweep runs before the first drain (regenerate.ts startRegenerator). Each copy made is indexed once its
  // run is done, and the index's own sweep (search/pages.ts) goes a batch at a time after each drain until it is
  // through, so a first deploy or a new TEXT_VERSION never holds the copies up.
  const start = (): { stop(): Promise<void> } =>
    startRegenerator({
      ...options,
      origin,
      redact,
      db: pool,
      before: () => sweepCopies(pool, { origin }),
      index: (fileId) => indexFile(pool, fileId, indexing),
      after: indexSweeper(pool, indexing),
    });
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
