// ============================================================================
// Every service the gRPC port serves, in one place. A service left out here
// answers UNIMPLEMENTED (grpc/server.ts). Read handlers take the audience from
// the verified caller only (auth/caller.ts), so the routes need no auth
// configuration of their own.
// ============================================================================
import type { DescService } from '@bufbuild/protobuf';
import type { ConnectRouter } from '@connectrpc/connect';
import { approvalRoutes } from '../approval/service.js';
import { linkCheckRoutes } from '../content/link-check.js';
import { contentRoutes } from '../content/service.js';
import { ApprovalRuleService } from '../gen/nwfl/mensa/v1/approval_pb.js';
import { Health } from '../gen/grpc/health/v1/health_pb.js';
import { ContentService } from '../gen/nwfl/mensa/v1/content_pb.js';
import { EventService } from '../gen/nwfl/mensa/v1/event_pb.js';
import { LinkCheckService } from '../gen/nwfl/mensa/v1/link_check_pb.js';
import type { Db } from '../db/pool.js';
import { eventRoutes } from '../events/service.js';
import { membershipRoutes } from '../membership/service.js';
import { verifierRoutes } from '../membership/verifier.js';
import { newsletterRoutes } from '../newsletter/service.js';
import { MembershipService } from '../gen/nwfl/mensa/v1/membership_pb.js';
import { MembershipVerifierService } from '../gen/nwfl/mensa/v1/membership_verifier_pb.js';
import { NewsletterService } from '../gen/nwfl/mensa/v1/newsletter_pb.js';
import { RedactionPolicyService } from '../gen/nwfl/mensa/v1/redaction_pb.js';
import type { StructuredLogger } from '../platform/logger.js';
import type { Readiness } from '../readiness.js';
import { redactionRoutes } from '../redaction/service.js';
import { healthRoutes } from './health.js';

/** Every service apiRoutes registers. The canary sweeps the reads of each. */
export const SERVED_SERVICES: readonly DescService[] = [
  Health,
  EventService,
  ContentService,
  NewsletterService,
  MembershipVerifierService,
  LinkCheckService,
  MembershipService,
  RedactionPolicyService,
  ApprovalRuleService,
];

export interface ApiDeps {
  db: Db;
  logger: StructuredLogger;
  readiness: Readiness;
  /** The clock "today" is read from. Tests pin it. */
  now?: () => Date;
  /** CHAPTER_GROUP_NAME (auth/config.ts): the chapter's own local group; null or unset for none. */
  chapterGroup?: string | null;
}

export function apiRoutes(deps: ApiDeps): (router: ConnectRouter) => void {
  const now = deps.now ?? ((): Date => new Date());
  const routes = [
    healthRoutes(deps.readiness),
    eventRoutes({ db: deps.db, logger: deps.logger.child({ component: 'events' }), now }),
    contentRoutes({ db: deps.db, logger: deps.logger.child({ component: 'content' }), now }),
    newsletterRoutes({ db: deps.db, logger: deps.logger.child({ component: 'newsletter' }) }),
    membershipRoutes({ db: deps.db, now, chapterGroup: deps.chapterGroup ?? null }),
    verifierRoutes({ db: deps.db, now, chapterGroup: deps.chapterGroup ?? null }),
    linkCheckRoutes({ db: deps.db, logger: deps.logger.child({ component: 'linkcheck' }), now }),
    redactionRoutes({ db: deps.db }),
    approvalRoutes({ db: deps.db }),
  ];
  return (router) => routes.forEach((register) => register(router));
}
