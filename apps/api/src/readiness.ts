// ============================================================================
// Whether this process should receive traffic: Postgres answers and shutdown
// has not begun. Read by /readyz on the health port and by grpc.health.v1 on
// the gRPC port, so both report the same thing.
// ============================================================================
import { probeDatabase, type QueryableDb } from './db/pool.js';

export interface ReadinessReport {
  ready: boolean;
  db: 'ok' | 'down';
  draining: boolean;
}

export interface Readiness {
  readonly draining: boolean;
  startDraining(): void;
  check(): Promise<ReadinessReport>;
}

export function createReadiness(db: QueryableDb, options: { probeTimeoutMs?: number } = {}): Readiness {
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
      return { ready: probe.reachable && !draining, db: probe.reachable ? 'ok' : 'down', draining };
    },
  };
}
