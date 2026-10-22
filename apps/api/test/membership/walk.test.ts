// A5: one sign-up, walked the whole way (R24, R33). A person signs up with
// their number; the verifier finds them in the local group; an officer still
// approves; they read at member level; 12 months on they are due for the
// re-check and still read as a member; 13 months on, unverified, they read at
// public level by themselves. The clock is the API's own, moved by the test.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContentService } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { MemberStatus, MembershipService, Verification } from '../../src/gen/nwfl/mensa/v1/membership_pb.js';
import { MembershipVerifierService, VerificationOutcome } from '../../src/gen/nwfl/mensa/v1/membership_verifier_pb.js';
import { type Api, NOW, as, dump, insertId, startApi } from '../helpers/api.js';
import { paragraph, publishItem, text } from '../helpers/content.js';
import { live } from '../helpers/pg.js';

const JOINER = as('joiner-token');
const SECRET = 'Members-only words for the walk';

describe.skipIf(!live)('a sign-up from submission to lapse', () => {
  let api: Api;
  let clock = NOW;

  beforeAll(async () => {
    api = await startApi('nwfl_walk', { now: () => clock });
    const office = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ('membership', 'Membership Officer', 'appointed') RETURNING id`);
    await publishItem(api.pool, { slug: 'members-notice', officeId: office, visibility: 'members', title: 'Members notice', body: { blocks: [paragraph(text(SECRET))] } });
  });

  afterAll(async () => {
    await api?.close();
  });

  const reads = async (): Promise<boolean> => dump(await api.client(ContentService).getPublishedItem({ slug: 'members-notice' }, JOINER)).includes(SECRET);

  it('walks: submit, verifier report, approval, member level, re-check due at 12 months, public at 13', async () => {
    const membership = api.client(MembershipService);
    const verifier = api.client(MembershipVerifierService);

    // 1. Submitted: pending, reading at public level.
    const { requestId } = await membership.submitSignup({ lastName: 'Examplesson', membershipNumber: '40417233' }, JOINER);
    expect((await membership.getMyAccount({}, JOINER)).account?.status).toBe(MemberStatus.PENDING);
    expect(await reads()).toBe(false);

    // 2. The verifier finds a local match; the number and last name are gone.
    expect((await verifier.listPendingVerifications({}, as('verifier-token'))).pending.map((p) => p.requestId)).toEqual([requestId]);
    await verifier.reportVerification({ requestId, outcome: VerificationOutcome.VERIFIED_LOCAL }, as('verifier-token'));
    const { rows } = await api.pool.query(`SELECT membership_number, last_name FROM signup_request WHERE id = $1`, [requestId]);
    expect(rows).toEqual([{ membership_number: null, last_name: null }]);

    // 3. Not a member yet: an officer still decides, seeing the outcome.
    expect(await reads()).toBe(false);
    const listed = (await membership.listSignupRequests({}, as('approver-token'))).requests;
    expect(listed.map((r) => [r.requestId, r.verification])).toEqual([[requestId, Verification.VERIFIED_LOCAL]]);
    await membership.approveSignup({ requestId }, as('approver-token'));

    // 4. Member level, from the verifier's date.
    expect((await membership.getMyAccount({}, JOINER)).account).toMatchObject({ status: MemberStatus.MEMBER, verifiedOn: { year: 2026, month: 10, day: 22 } });
    expect(await reads()).toBe(true);
    const due = async (): Promise<boolean | undefined> =>
      (await membership.listMembers({}, as('approver-token'))).members.find((m) => m.subject === 'sub-joiner')?.recheckDue;
    expect(await due()).toBe(false);

    // 5. Twelve months and a day on: due for the yearly re-check, still a member (the grace month).
    clock = new Date('2027-10-23T15:00:00Z');
    expect(await due()).toBe(true);
    expect(await reads()).toBe(true);

    // 6. Thirteen months to the day: the last day at member level.
    clock = new Date('2027-11-22T15:00:00Z');
    expect(await reads()).toBe(true);

    // 7. Thirteen months and a day, not re-verified: public level, with no one acting.
    clock = new Date('2027-11-23T15:00:00Z');
    expect(await reads()).toBe(false);
    expect((await membership.getMyAccount({}, JOINER)).account?.status).toBe(MemberStatus.MEMBER);
  });
});

// API-FIX3: the yearly re-check keeps a member. The walk runs two years back,
// so every date it writes is in the past: a verification date is never in the
// future (0009), and the walk's month 24 is today.
describe.skipIf(!live)('a member confirmed at the yearly re-check', () => {
  let api: Api;
  let clock = new Date('2024-10-22T15:00:00Z');

  beforeAll(async () => {
    api = await startApi('nwfl_walk_confirm', { now: () => clock });
    const office = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ('membership', 'Membership Officer', 'appointed') RETURNING id`);
    await publishItem(api.pool, { slug: 'members-notice', officeId: office, visibility: 'members', title: 'Members notice', body: { blocks: [paragraph(text(SECRET))] } });
  });

  afterAll(async () => {
    await api?.close();
  });

  const reads = async (): Promise<boolean> => dump(await api.client(ContentService).getPublishedItem({ slug: 'members-notice' }, JOINER)).includes(SECRET);

  it('walks: approved at month 0, confirmed at month 12, still a member at month 24', async () => {
    const membership = api.client(MembershipService);
    const { requestId } = await membership.submitSignup({ lastName: 'Examplesson', membershipNumber: '40417233' }, JOINER);
    await api.client(MembershipVerifierService).reportVerification({ requestId, outcome: VerificationOutcome.VERIFIED_LOCAL }, as('verifier-token'));
    await membership.approveSignup({ requestId }, as('approver-token'));
    expect(await reads()).toBe(true);

    // Month 12: the approver checks the offline roster and confirms.
    clock = new Date('2025-10-22T15:00:00Z');
    expect((await membership.confirmMember({ subject: 'sub-joiner' }, as('approver-token'))).account?.verifiedOn).toEqual(expect.objectContaining({ year: 2025, month: 10, day: 22 }));

    // Month 24: two years from approval, a member still, and not yet due again.
    clock = NOW;
    expect(await reads()).toBe(true);
    expect((await membership.listMembers({}, as('approver-token'))).members.find((m) => m.subject === 'sub-joiner')?.recheckDue).toBe(false);
    expect((await membership.getMyAccount({}, JOINER)).account?.status).toBe(MemberStatus.MEMBER);
  });
});

