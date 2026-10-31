// ============================================================================
// Whether this process should receive traffic: Postgres answers, shutdown
// has not begun and, when a tenant gate is given (CF-ISO-0, tenant.ts), the
// database has been verified to serve this process's TENANT. Read by /readyz on the health port and by grpc.health.v1 on
// the gRPC port, so both report the same thing.
// ============================================================================
import { probeDatabase, type QueryableDb } from './db/pool.js';

export interface ReadinessReport {
  ready: boolean;
  db: 'ok' | 'down';
  draining: boolean;
  /** Present when a tenant gate is configured. */
  tenant?: 'verified' | 'unverified';
}

export interface Readiness {
  readonly draining: boolean;
  startDraining(): void;
  check(): Promise<ReadinessReport>;
}

export function createReadiness(db: QueryableDb, options: { probeTimeoutMs?: number; tenant?: { readonly verified: boolean } } = {}): Readiness {
  let draining = false;
  return {
    get draining() {
      return draining;
    },
    startDraining: () => {
      draining = true;
    },
    check: async () => {
      const probe = await probeDatabase(db, options.probeTimeoutMs);
      const tenant = options.tenant === undefined ? undefined : options.tenant.verified ? 'verified' : 'unverified';
      return {
        ready: probe.reachable && !draining && tenant !== 'unverified',
        db: probe.reachable ? 'ok' : 'down',
        draining,
        ...(tenant === undefined ? {} : { tenant }),
      };
    },
  };
}
