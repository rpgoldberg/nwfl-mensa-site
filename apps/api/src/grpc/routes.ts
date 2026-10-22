// ============================================================================
// Every service the gRPC port serves, in one place. A service left out here
// answers UNIMPLEMENTED (grpc/server.ts). Read handlers take the audience from
// the verified caller only (auth/caller.ts), so the routes need no auth
// configuration of their own.
// ============================================================================
import type { DescService } from '@bufbuild/protobuf';
import type { ConnectRouter } from '@connectrpc/connect';
import { contentRoutes } from '../content/service.js';
import { Health } from '../gen/grpc/health/v1/health_pb.js';
import { ContentService } from '../gen/nwfl/mensa/v1/content_pb.js';
import { EventService } from '../gen/nwfl/mensa/v1/event_pb.js';
import type { Db } from '../db/pool.js';
import { eventRoutes } from '../events/service.js';
import { newsletterRoutes } from '../newsletter/service.js';
import { MembershipService } from '../gen/nwfl/mensa/v1/membership_pb.js';
import { MembershipVerifierService } from '../gen/nwfl/mensa/v1/membership_verifier_pb.js';
import { NewsletterService } from '../gen/nwfl/mensa/v1/newsletter_pb.js';
import type { StructuredLogger } from '../platform/logger.js';
import type { Readiness } from '../readiness.js';
import { healthRoutes } from './health.js';

/** Every service apiRoutes registers. The canary sweeps the reads of each. */
export const SERVED_SERVICES: readonly DescService[] = [
  Health,
  EventService,
  ContentService,
  NewsletterService,
  MembershipVerifierService,
  MembershipService,
];

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
    contentRoutes({ db: deps.db, logger: deps.logger.child({ component: 'content' }), now }),
    newsletterRoutes({ db: deps.db, logger: deps.logger.child({ component: 'newsletter' }) }),
    // Registered with no handlers yet (A5), so the caller gate already applies
    // to them: an unregistered service would answer before any interceptor
    // ran. Each method answers UNIMPLEMENTED once past the gate.
    (router: ConnectRouter) => {
      router.service(MembershipVerifierService, {});
      router.service(MembershipService, {});
    },
  ];
  return (router) => routes.forEach((register) => register(router));
}
