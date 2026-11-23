// PROFILE-ID exposure walk (challenger's probe, kept as a regression test). What a person typed at sign-up
// (first name, last name, membership number) is kept on the sign-up row and may be shown to the approvers
// and the owner only. Here EVERY unary RPC of EVERY service is called as each person who must not see it,
// and signed out, with an empty request and then once per sign-up id in every string field. Every response
// and every error is searched for every typed value. The one exception is the verifier's own contract:
// ListPendingVerifications returns the number and last name of an unchecked sign-up, never a first name.
// The queue shown to an approver is the control that proves the walk can see a leak. Every value is made up.
import { randomInt } from 'node:crypto';
import { create, ScalarType, type DescService } from '@bufbuild/protobuf';
import { ConnectError, type Client } from '@connectrpc/connect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as approvalPb from '../../src/gen/nwfl/mensa/v1/approval_pb.js';
import * as contentPb from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import * as editionPb from '../../src/gen/nwfl/mensa/v1/edition_pb.js';
import * as eventPb from '../../src/gen/nwfl/mensa/v1/event_pb.js';
import * as membershipPb from '../../src/gen/nwfl/mensa/v1/membership_pb.js';
import * as verifierPb from '../../src/gen/nwfl/mensa/v1/membership_verifier_pb.js';
import * as newsletterPb from '../../src/gen/nwfl/mensa/v1/newsletter_pb.js';
import * as redactionPb from '../../src/gen/nwfl/mensa/v1/redaction_pb.js';
import * as rosterPb from '../../src/gen/nwfl/mensa/v1/roster_pb.js';
import { type Api, as, dump, startApi } from '../helpers/api.js';
import { live } from '../helpers/pg.js';

const { MembershipService } = membershipPb;
const { MembershipVerifierService, VerificationOutcome } = verifierPb;
const APPROVER = as('approver-token');
const ADMIN = as('admin-token');
const VERIFIER = as('verifier-token');

const SERVICES: DescService[] = [approvalPb, contentPb, editionPb, eventPb, membershipPb, verifierPb, newsletterPb, redactionPb, rosterPb]
  .flatMap((m): unknown[] => Object.values(m))
  .filter((v): v is DescService => typeof v === 'object' && v !== null && (v as { kind?: string }).kind === 'service');

const NON_APPROVERS = [
  'member-token', 'officer-token', 'pub-token', 'treasurer-token', 'webmaster-token', 'stray-admin-token',
  'affiliate-token', 'joiner2-token', 'joiner3-token', 'agent-token', 'verifier-token', 'racer-token',
] as const;

interface Typed {
  id: string;
  number: string;
  first: string;
  last: string;
}

describe.skipIf(!live)('PROFILE-ID: no RPC of any service gives a typed value to anyone but the approvers and its owner', () => {
  let api: Api;
  let membership: Client<typeof MembershipService>;
  let verifier: Client<typeof MembershipVerifierService>;
  const everyone: Typed[] = [];

  const signUp = async (token: Parameters<typeof as>[0]): Promise<Typed> => {
    const number = String(randomInt(100_000_000_000, 999_999_999_999));
    const first = `Fz${randomInt(1_000_000, 9_999_999)}`;
    const last = `Lz${randomInt(1_000_000, 9_999_999)}`;
    const { requestId } = await membership.submitSignup({ firstName: first, lastName: last, membershipNumber: number }, as(token));
    const typed = { id: requestId, number, first, last };
    everyone.push(typed);
    return typed;
  };

  beforeAll(async () => {
    api = await startApi('nwfl_exposure');
    membership = api.client(MembershipService);
    verifier = api.client(MembershipVerifierService);
    // One sign-up in every state: approved (joiner), rejected (joiner2), pending (joiner3), checked as a
    // duplicate of the approved one (invitee), reopened (spacer).
    const approved = await signUp('joiner-token');
    await verifier.reportVerification({ requestId: approved.id, outcome: VerificationOutcome.VERIFIED_LOCAL }, VERIFIER);
    await membership.approveSignup({ requestId: approved.id }, APPROVER);
    const rejected = await signUp('joiner2-token');
    await membership.rejectSignup({ requestId: rejected.id }, APPROVER);
    await signUp('joiner3-token');
    const duplicate = await signUp('invitee-token');
    await verifier.reportVerification(
      { requestId: duplicate.id, outcome: VerificationOutcome.DUPLICATE_CLAIM, conflictingRequestId: approved.id },
      VERIFIER,
    );
    const reopened = await signUp('spacer-token');
    await membership.rejectSignup({ requestId: reopened.id }, APPROVER);
    await membership.reopenSignup({ requestId: reopened.id }, ADMIN);
  });
  afterAll(async () => {
    await api?.close();
  });

  it.each([...NON_APPROVERS, 'PUBLIC'] as const)('every unary RPC of every service as %s carries no typed value', async (who) => {
    const options = who === 'PUBLIC' ? {} : as(who);
    const seen: string[] = [];
    for (const service of SERVICES) {
      const client = api.client(service) as unknown as Record<string, (request: unknown, options: unknown) => Promise<unknown>>;
      for (const method of service.methods) {
        if (method.methodKind !== 'unary') continue;
        // An empty request, then one per sign-up id with every string field set to that id.
        const requests: unknown[] = [create(method.input, {})];
        for (const { id } of everyone) {
          const fields: Record<string, unknown> = {};
          for (const f of method.input.fields) if (f.fieldKind === 'scalar' && f.scalar === ScalarType.STRING) fields[f.localName] = id;
          requests.push(create(method.input, fields as never));
        }
        for (const request of requests) {
          let out: unknown;
          try {
            out = await client[method.localName]!(request, options);
          } catch (error) {
            out = error instanceof ConnectError ? { code: error.code, message: error.rawMessage, details: error.details, metadata: [...error.metadata] } : String(error);
          }
          const text = dump(out);
          const pendingList = who === 'verifier-token' && method.name === 'ListPendingVerifications';
          for (const t of everyone) {
            // The verifier's contract returns an unchecked sign-up's number and last name, never a first name.
            const values = pendingList ? [t.first] : [t.number, t.first, t.last];
            for (const value of values) if (text.includes(value)) seen.push(`${service.typeName}.${method.name}: ${value}`);
          }
        }
      }
    }
    expect(seen).toEqual([]);
  }, 120_000);

  it('the queue shows an approver every typed value (control: the walk can see a leak)', async () => {
    const text = dump(await membership.listSignupRequests({}, APPROVER));
    expect(everyone.some((t) => text.includes(t.number) && text.includes(t.first) && text.includes(t.last))).toBe(true);
  });

  it('the verifier hears the number and last name of a pending sign-up, and never a first name', async () => {
    const text = dump(await verifier.listPendingVerifications({}, VERIFIER));
    expect(everyone.some((t) => text.includes(t.number) && text.includes(t.last))).toBe(true);
    expect(everyone.filter((t) => text.includes(t.first))).toEqual([]);
  });

  it('the API never logs any typed value', () => {
    const logged = JSON.stringify(api.logs);
    expect(everyone.flatMap((t) => [t.number, t.first, t.last]).filter((value) => logged.includes(value))).toEqual([]);
  });
});
