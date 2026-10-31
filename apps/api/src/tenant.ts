// ============================================================================
// CF-ISO-0: the chapter this deployment serves, from config, checked against
// the database at startup.
//
//   TENANT   default nwflorida (0012's one tenant row). The same pattern as
//            0012's CHECK, ^[a-z][a-z0-9-]{1,40}$, so it is safe where code
//            writes it into SQL text (ledger.ts), and anything else refuses
//            to start.
//
// The API and the worker check it in the background (startTenantGate): the
// database must hold exactly that one tenant. Until it answers, the API stays
// up but not ready (readiness.ts) and the worker claims no job; each failed
// read is logged as a plain line (attempt, next wait, the error's code and
// name, never its text) and retried with backoff, 1 s doubling to 15 s, so a
// Postgres blip costs at most 15 s once it is back. Only a POSITIVE mismatch
// (another tenant's row, no row, several rows) refuses: the process logs the
// reason and exits 1 (refuseToStart). Availability with the database down is
// as before: the process starts and reports not ready.
//
// The SQL defaults and literals ('nwflorida' in 0012-0020) stay as they are;
// they move to a function in CF-ISO-S.
// ============================================================================
import type { Db } from './db/pool.js';

export const DEFAULT_TENANT = 'nwflorida';
const TENANT_ID = /^[a-z][a-z0-9-]{1,40}$/;

/** TENANT, validated; unset is the default. Throws, so a malformed value refuses to start. */
export function parseTenant(value: string | undefined): string {
  if (value === undefined) return DEFAULT_TENANT;
  if (!TENANT_ID.test(value)) throw new Error('TENANT must be a tenant id as 0012 allows: a lowercase letter, then 1 to 40 lowercase letters, digits or hyphens');
  return value;
}

/** The reason a positive answer is not this process's tenant, or undefined when it is exactly [tenant]. */
export function tenantMismatch(ids: readonly string[], tenant: string, what = 'tenant row'): string | undefined {
  if (ids.length === 0) return `TENANT is ${tenant} but the database has no ${what}: refusing to start`;
  if (ids.length > 1) return `the database has ${ids.length} ${what}s (${ids.join(', ')}) and this process serves exactly one: refusing to start`;
  if (ids[0] !== tenant) return `TENANT is ${tenant} but the database serves ${ids[0]}: refusing to start`;
  return undefined;
}

/** What one failed read logs: no message text, which can carry a host or a user. */
export interface RetryFields {
  attempt: number;
  retry_in_ms: number;
  error_name: string;
  error_code?: string;
}

export interface TenantGateOptions {
  /** A positive mismatch (tenantMismatch's reason). The entrypoints pass refuseToStart. */
  onMismatch: (message: string) => void;
  onRetry?: (fields: RetryFields) => void;
  onVerified?: () => void;
  /** What the read returns, for the reason. Default "tenant row". */
  what?: string;
  /** Backoff: the first wait, doubled each attempt up to the max. Defaults 1000 and 15000 ms. */
  firstDelayMs?: number;
  maxDelayMs?: number;
  /** For tests; the default is an unref'd timer that stop() cuts short. */
  sleep?: (ms: number) => Promise<void>;
}

export interface TenantGate {
  /** True once the database answered exactly [tenant]; readiness and the worker's job wait on it. */
  readonly verified: boolean;
  readonly settled: Promise<'verified' | 'mismatch' | 'stopped'>;
  stop(): void;
}

/** Checks the tenant in the background until the database answers; never throws, never exits by itself. */
export function startTenantGate(read: () => Promise<string[]>, tenant: string, options: TenantGateOptions): TenantGate {
  const { firstDelayMs = 1_000, maxDelayMs = 15_000, what = 'tenant row' } = options;
  let verified = false;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let wake: (() => void) | undefined;
  const pause =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, ms);
        timer.unref();
      }));
  const settled = (async (): Promise<'verified' | 'mismatch' | 'stopped'> => {
    for (let attempt = 1; ; attempt += 1) {
      let ids: string[];
      try {
        ids = await read();
      } catch (error) {
        if (stopped) return 'stopped';
        const delay = Math.min(firstDelayMs * 2 ** (attempt - 1), maxDelayMs);
        const code = (error as { code?: unknown } | null)?.code;
        options.onRetry?.({ attempt, retry_in_ms: delay, error_name: error instanceof Error ? error.name : 'unknown', ...(typeof code === 'string' ? { error_code: code } : {}) });
        await pause(delay);
        if (stopped) return 'stopped';
        continue;
      }
      if (stopped) return 'stopped';
      const problem = tenantMismatch(ids, tenant, what);
      if (problem !== undefined) {
        options.onMismatch(problem);
        return 'mismatch';
      }
      verified = true;
      options.onVerified?.();
      return 'verified';
    }
  })();
  return {
    get verified() {
      return verified;
    },
    settled,
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      wake?.();
    },
  };
}

/** The entrypoints' onMismatch: log the plain reason, then exit 1. */
export function refuseToStart(log: (message: string) => void, exit: (code: number) => void = (code) => process.exit(code)): (message: string) => void {
  return (message) => {
    log(message);
    exit(1);
  };
}

/** The tenant table's ids, as the app role reads them. */
export const tenantRows =
  (db: Db) =>
  async (): Promise<string[]> =>
    (await db.query<{ id: string }>('SELECT id FROM tenant ORDER BY id')).rows.map((row) => row.id);

/**
 * The tenants the redaction policy references, for the worker, which may not read the tenant table
 * (0017/0019 grant nwfl_worker only tenant_id on redaction_policy; tenant_id references tenant (id)).
 */
export const policyTenants =
  (db: Db) =>
  async (): Promise<string[]> =>
    (await db.query<{ id: string }>('SELECT DISTINCT tenant_id AS id FROM redaction_policy ORDER BY 1')).rows.map((row) => row.id);
