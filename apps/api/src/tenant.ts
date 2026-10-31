// ============================================================================
// CF-ISO-0: the chapter this deployment serves, from config, checked against
// the database at startup.
//
//   TENANT   default nwflorida (0012's one tenant row). The same pattern as
//            0012's CHECK, ^[a-z][a-z0-9-]{1,40}$, so it is safe where code
//            writes it into SQL text (ledger.ts), and anything else refuses
//            to start.
//
// The API and the worker check it before they serve or claim anything
// (main.ts, worker.ts): the database must hold exactly that one tenant. A
// mismatch, a missing row or several rows refuse to start at once, with a
// plain reason; a database that does not answer yet is retried a few times
// first (attempts x delayMs, 30 s by default), then refuses as well.
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

export interface CheckOptions {
  /** How many reads before giving up on a database that does not answer. Default 10. */
  attempts?: number;
  /** The wait between them. Default 3000 ms. */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** What the read returns, for the reason. Default "tenant row". */
  what?: string;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves when `read` gives exactly [tenant]; otherwise throws a plain reason that ends "refusing to start". */
export async function checkTenant(read: () => Promise<string[]>, tenant: string, options: CheckOptions = {}): Promise<void> {
  const { attempts = 10, delayMs = 3_000, sleep = wait, what = 'tenant row' } = options;
  let ids: string[] | undefined;
  for (let attempt = 1; ids === undefined; attempt += 1) {
    try {
      ids = await read();
    } catch (error) {
      if (attempt >= attempts) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`could not check TENANT against the database after ${attempts} attempts (${reason}): refusing to start`, { cause: error });
      }
      await sleep(delayMs);
    }
  }
  if (ids.length === 0) throw new Error(`TENANT is ${tenant} but the database has no ${what}: refusing to start`);
  if (ids.length > 1) throw new Error(`the database has ${ids.length} ${what}s (${ids.join(', ')}) and this process serves exactly one: refusing to start`);
  if (ids[0] !== tenant) throw new Error(`TENANT is ${tenant} but the database serves ${ids[0]}: refusing to start`);
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
