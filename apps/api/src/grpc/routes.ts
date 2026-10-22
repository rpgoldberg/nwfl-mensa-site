// ============================================================================
// Every service the gRPC port serves, in one place. A service left out here
// answers UNIMPLEMENTED (grpc/server.ts). Read handlers take the audience from
// the verified caller only (auth/caller.ts), so the routes need no auth
// configuration of their own.
// ============================================================================
import type { ConnectRouter } from '@connectrpc/connect';
import { contentRoutes } from '../content/service.js';
import type { Db } from '../db/pool.js';
import { eventRoutes } from '../events/service.js';
import type { StructuredLogger } from '../platform/logger.js';
import type { Readiness } from '../readiness.js';
import { healthRoutes } from './health.js';

export interface ApiDeps {
  db: Db;
  logger: StructuredLogger;
  readiness: Readiness;
  /** The clock "today" is read from. Tests pin it. */
  now?: () => Date;
}

export function apiRoutes(deps: ApiDeps): (router: ConnectRouter) => void {
  const now = deps.now ?? ((): Date => new Date());
  const routes = [
    healthRoutes(deps.readiness),
    eventRoutes({ db: deps.db, logger: deps.logger.child({ component: 'events' }), now }),
    contentRoutes({ db: deps.db, now }),
  ];
  return (router) => routes.forEach((register) => register(router));
}
