// The services the gRPC port serves, and the real clock when none is pinned.
import { Code, createClient, createRouterTransport } from '@connectrpc/connect';
import { describe, expect, it } from 'vitest';
import { rejectAllTokens } from '../../src/auth/caller.js';
import { ContentService } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { EventService } from '../../src/gen/nwfl/mensa/v1/event_pb.js';
import { MembershipService } from '../../src/gen/nwfl/mensa/v1/membership_pb.js';
import { MembershipVerifierService } from '../../src/gen/nwfl/mensa/v1/membership_verifier_pb.js';
import { NewsletterService } from '../../src/gen/nwfl/mensa/v1/newsletter_pb.js';
import { apiInterceptors } from '../../src/grpc/interceptors.js';
import { apiRoutes } from '../../src/grpc/routes.js';
import { createStructuredLogger } from '../../src/platform/logger.js';
import { createReadiness } from '../../src/readiness.js';

describe('apiRoutes', () => {
  const queries: unknown[][] = [];
  const db = {
    query: (_text: string, values: unknown[] = []) => {
      queries.push(values);
      return Promise.resolve({ rows: [] });
    },
  };
  const logger = createStructuredLogger({ level: 'silent' });
  const transport = createRouterTransport(apiRoutes({ db, logger, readiness: createReadiness(db) }), {
    router: { interceptors: apiInterceptors({ logger, verifier: rejectAllTokens }) },
  });

  it('reads "today" from the real clock when none is pinned', async () => {
    await createClient(EventService, transport).listOccurrences({});
    const lower = queries.at(-1)?.[0] as Date;
    expect(Math.abs(lower.getTime() - Date.now())).toBeLessThan(3 * 86_400_000);
  });

  it('serves the event and content reads', async () => {
    await expect(createClient(ContentService, transport).getRoster({})).resolves.toEqual(expect.objectContaining({ offices: [] }));
  });

  it('serves MembershipService, which needs a signed-in caller', async () => {
    await expect(createClient(MembershipService, transport).getMyAccount({})).rejects.toMatchObject({ code: Code.Unauthenticated });
  });

  it.each([
    ['NewsletterService', () => createClient(NewsletterService, transport).listEditions({})],
    ['MembershipVerifierService', () => createClient(MembershipVerifierService, transport).listPendingVerifications({})],
  ])('registers %s, so the caller gate runs before the missing handler', async (_name, call) => {
    await expect(call()).rejects.toMatchObject({ code: Code.Unauthenticated });
  });
});
