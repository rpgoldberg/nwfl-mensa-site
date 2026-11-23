// OFFICER-VERIFY end to end, with the switch on: an officer power needs member standing as well as its
// group. For every RPC that checks a power, a token holding EVERY power group but no member standing
// gets exactly what a powerless caller gets (the same code, or the same answer), and the same groups
// WITH standing get something else, so each row proves the power is real and is withheld. Switched off
// (the default), the unverified holder keeps every power, as before. Every name is made up.
import { Code, ConnectError } from '@connectrpc/connect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TokenVerifier, VerifiedToken } from '../../src/auth/caller.js';
import { ApprovalRule, ApprovalRuleService, ApprovalScope } from '../../src/gen/nwfl/mensa/v1/approval_pb.js';
import { ContentKind, ContentService } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { EditionKind } from '../../src/gen/nwfl/mensa/v1/edition_pb.js';
import { Area, EventCategory, EventService, EventVisibility, OccurrenceStatus, VenueKind } from '../../src/gen/nwfl/mensa/v1/event_pb.js';
import { MembershipService } from '../../src/gen/nwfl/mensa/v1/membership_pb.js';
import {
  LedgerSubjectKind,
  MarkField,
  MarkSubjectKind,
  RedactionAction,
  RedactionAudience,
  RedactionCategory,
  RedactionPolicyService,
} from '../../src/gen/nwfl/mensa/v1/redaction_pb.js';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { type Api, insertId, startApi } from '../helpers/api.js';
import { membersSpan, paragraph, publishItem, text } from '../helpers/content.js';
import { live } from '../helpers/pg.js';

/** Every group with a power (groups.ts isPowerGroup), plus the enrolee group. */
const ALL_POWERS = [
  'nwfl-members',
  'nwfl-officers',
  'nwfl-admin',
  'nwfl-webmaster',
  'nwfl-membership-approvers',
  'nwfl-office-publications',
  'nwfl-office-editor',
  'nwfl-office-membership',
];
const person = (subject: string, groups: string[]): VerifiedToken => ({ client: 'site', subject, groups, scopes: [], name: 'Robin Madeup', email: `${subject}@example.org` });
const PEOPLE: Record<string, VerifiedToken> = {
  // Every power, no member_account row.
  unverified: person('sub-ov-unverified', ALL_POWERS),
  // Every power, a verified member.
  verified: person('sub-ov-verified', ALL_POWERS),
  // Every power, an affiliate (Admin-granted standing): keeps the powers (the orchestrator's ruling, 11-23).
  affiliate: person('sub-ov-affiliate', ALL_POWERS),
  // Every power, a guest member (another local group): option (a), no power.
  guest: person('sub-ov-guest', ALL_POWERS),
  // Every power, a member approved with no local group reported: no power.
  unconfirmed: person('sub-ov-unconfirmed', ALL_POWERS),
  // Every power, a member whose verification lapsed (13 months): withheld again.
  lapsed: person('sub-ov-lapsed', ALL_POWERS),
  // No power at all, no standing: the yardstick.
  powerless: person('sub-ov-powerless', ['nwfl-members']),
};
const verifier: TokenVerifier = {
  verify: (token) => {
    const found = PEOPLE[token];
    return found === undefined ? Promise.reject(new Error('unknown token')) : Promise.resolve(found);
  },
};
type Who = keyof typeof PEOPLE;
const as = (token: Who): { headers: Record<string, string> } => ({ headers: { authorization: `Bearer ${token}` } });
const OTHER = '0b6c1e5a-3d2f-4a8b-9c7d-1e2f3a4b5c6d';

/** What a call gives: its error code by name, or its answer as JSON (bigints and bytes made plain). */
async function outcome(call: () => Promise<unknown>): Promise<string> {
  try {
    const answer = await call();
    return `ok ${JSON.stringify(answer, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value instanceof Uint8Array ? [...value] : value))}`;
  } catch (error) {
    return Code[ConnectError.from(error).code];
  }
}

describe.skipIf(!live)('OFFICER-VERIFY: every officer power needs member standing, switched on', () => {
  let api: Api;
  let off: Api;
  let item: string;
  let publications: string;

  beforeAll(async () => {
    api = await startApi('nwfl_officer_verify', { verifier, officerVerify: true });
    off = await startApi('nwfl_officer_verify_off', { verifier });
    for (const db of [api, off]) {
      await db.pool.query(
        `INSERT INTO member_account (sub, status, route, approved_by_sub, approved_at, verified_on, chapter_member) VALUES
           ('sub-ov-verified', 'member', 'invite', 'svc-nwfl-verifier', now(), '2026-10-01', true),
           ('sub-ov-guest', 'member', 'invite', 'svc-nwfl-verifier', now(), '2026-10-01', false),
           ('sub-ov-unconfirmed', 'member', 'signup', 'sub-ov-verified', now(), '2026-10-01', NULL),
           ('sub-ov-lapsed', 'member', 'invite', 'svc-nwfl-verifier', now(), '2025-08-01', true)`,
      );
      await db.pool.query(
        `INSERT INTO member_account (sub, status, route, affiliate_granted_by_sub, affiliate_granted_at, verified_on) VALUES ('sub-ov-affiliate', 'affiliate', 'admin_grant', 'sub-ov-verified', now(), '2026-10-01')`,
      );
    }
    publications = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ('publications', 'Publications Officer', 'appointed') RETURNING id`);
    await api.pool.query(`INSERT INTO office (slug, title, kind) VALUES ('editor', 'Newsletter Editor', 'appointed'), ('membership', 'Membership Officer', 'appointed')`);
    item = (await publishItem(api.pool, { slug: 'report', officeId: publications, title: 'Report', body: { blocks: [paragraph(text('Call 850-555-0143.'))] } })).itemId;
    await publishItem(api.pool, { slug: 'board-only', officeId: publications, visibility: 'officers', title: 'Board only', body: { blocks: [paragraph(text('For the board.'))] } });
    await publishItem(api.pool, { slug: 'members-note', officeId: publications, visibility: 'members', title: 'Members note', body: { blocks: [paragraph(membersSpan('Members only line.'))] } });
  });

  afterAll(async () => {
    await api?.close();
    await off?.close();
  });

  const content = () => api.client(ContentService);
  const events = () => api.client(EventService);
  const redaction = () => api.client(RedactionPolicyService);
  const membership = () => api.client(MembershipService);
  const approval = () => api.client(ApprovalRuleService);
  const series = () => ({
    slug: 'ov-lunch',
    title: 'Lunch',
    category: EventCategory.LUNCH,
    recurrence: 'FREQ=WEEKLY;BYDAY=WE',
    startsOn: { year: 2026, month: 11, day: 4 },
    defaultStart: { hours: 11, minutes: 30 },
    defaultDurationMinutes: 90,
    area: Area.BAY,
    hostOfficeId: publications,
    visibility: EventVisibility.PUBLIC,
  });
  const occurrence = () => ({
    title: 'One-off',
    startsAt: timestampFromDate(new Date('2026-11-20T17:00:00Z')),
    status: OccurrenceStatus.SCHEDULED,
    visibility: EventVisibility.PUBLIC,
    ownerOfficeId: publications,
  });
  const edition = { slug: 'ov-2027-02', title: 'Issue', kind: EditionKind.REGULAR, periodStart: { year: 2027, month: 2, day: 1 }, periodEnd: { year: 2027, month: 3, day: 31 } };

  // Each row: the RPC (by service and method), called the same way for each person.
  const ROWS: Array<[string, (who: Who) => Promise<unknown>]> = [
    // Reads at the officers audience (caller.ts audienceFor).
    ['ContentService.ListPublishedItems (audience)', (who) => content().listPublishedItems({}, as(who))],
    // approval/service.ts: requireOfficerOrAdmin, requireAdmin.
    ['ApprovalRuleService.GetApprovalRules', (who) => approval().getApprovalRules({}, as(who))],
    ['ApprovalRuleService.ListApprovalRuleChanges', (who) => approval().listApprovalRuleChanges({}, as(who))],
    ['ApprovalRuleService.SetApprovalRule', (who) => approval().setApprovalRule({ scope: ApprovalScope.CONTENT, rule: ApprovalRule.ONE_APPROVER, reason: 'away' }, as(who))],
    // events/writes.ts: requireOfficer, requireOwner (requireOffice, or the Admin).
    ['EventService.SaveVenue', (who) => events().saveVenue({ venue: { kind: VenueKind.BUSINESS, name: `Grill ${who}`, businessAddress: '1 Example Way', area: Area.BAY } }, as(who))],
    ['EventService.SaveSeries', (who) => events().saveSeries({ series: { ...series(), slug: `ov-lunch-${who}` } }, as(who))],
    ['EventService.SaveOccurrence', (who) => events().saveOccurrence({ occurrence: occurrence() }, as(who))],
    // content/workflow.ts: requireOffice, requireReviewer, requirePublisher, requireEditorReader, roles of requireUser.
    ['ContentService.CreateItem', (who) => content().createItem({ kind: ContentKind.ARTICLE, officeId: publications, slug: `ov-${who}`, title: 'Item' }, as(who))],
    ['ContentService.SaveDraft', (who) => content().saveDraft({ itemId: item, title: 'Report', bodyMarkup: 'Changed.' }, as(who))],
    ['ContentService.MarkReady', (who) => content().markReady({ itemId: item }, as(who))],
    ['ContentService.SendBack', (who) => content().sendBack({ itemId: item, note: 'Please fix.' }, as(who))],
    ['ContentService.Approve', (who) => content().approve({ itemId: item }, as(who))],
    ['ContentService.Publish', (who) => content().publish({ itemId: item }, as(who))],
    ['ContentService.ListWorkingItems', (who) => content().listWorkingItems({}, as(who))],
    ['ContentService.GetWorkingItem', (who) => content().getWorkingItem({ itemId: item }, as(who))],
    ['ContentService.ListItemHistory', (who) => content().listItemHistory({ itemId: item }, as(who))],
    ['ContentService.PreviewWorkingItem', (who) => content().previewWorkingItem({ itemId: item }, as(who))],
    // content/link-gate.ts: roles of requireUser, requireReviewer.
    ['ContentService.GetItemLinks', (who) => content().getItemLinks({ itemId: item }, as(who))],
    ['ContentService.ConfirmLinks', (who) => content().confirmLinks({ itemId: item }, as(who))],
    // content/editions.ts: requireEditor (the Admin or the editor seat).
    ['ContentService.SaveEdition', (who) => content().saveEdition({ edition: { ...edition, slug: `ov-${who}` } }, as(who))],
    ['ContentService.FreezeEdition', (who) => content().freezeEdition({ editionId: OTHER }, as(who))],
    // redaction/service.ts and marks.ts: requireOfficer, roles of requireUser; ledger/handlers.ts: requireOfficer.
    ['RedactionPolicyService.GetRedactionPolicy', (who) => redaction().getRedactionPolicy({}, as(who))],
    [
      'RedactionPolicyService.ProposeRedactionChange',
      (who) => redaction().proposeRedactionChange({ audience: RedactionAudience.PUBLIC, category: RedactionCategory.MEMBER_NAME, action: RedactionAction.REDACT }, as(who)),
    ],
    ['RedactionPolicyService.ApproveRedactionChange', (who) => redaction().approveRedactionChange({ changeId: OTHER }, as(who))],
    [
      'RedactionPolicyService.AddRedactionMark',
      (who) =>
        redaction().addRedactionMark(
          { subjectKind: MarkSubjectKind.CONTENT_ITEM, subjectId: item, field: MarkField.BODY, quote: '850-555-0143', category: RedactionCategory.MEMBER_PHONE },
          as(who),
        ),
    ],
    ['RedactionPolicyService.ListRedactionMarks', (who) => redaction().listRedactionMarks({ subjectKind: MarkSubjectKind.CONTENT_ITEM, subjectId: item }, as(who))],
    ['RedactionPolicyService.ProposeMarkRemoval', (who) => redaction().proposeMarkRemoval({ markId: OTHER }, as(who))],
    ['RedactionPolicyService.ApproveMarkRemoval', (who) => redaction().approveMarkRemoval({ removalId: OTHER }, as(who))],
    [
      'RedactionPolicyService.LedgerAsOf',
      (who) => redaction().ledgerAsOf({ subjectKind: LedgerSubjectKind.CONTENT_VERSION, subjectId: OTHER, audience: RedactionAudience.PUBLIC, at: timestampFromDate(new Date()) }, as(who)),
    ],
    ['RedactionPolicyService.VerifyLedger', (who) => redaction().verifyLedger({}, as(who))],
    // membership/service.ts: requireMembershipApprover, requireGrantor, requireSignupReopener.
    ['MembershipService.ListSignupRequests', (who) => membership().listSignupRequests({}, as(who))],
    ['MembershipService.ApproveSignup', (who) => membership().approveSignup({ requestId: OTHER }, as(who))],
    ['MembershipService.RejectSignup', (who) => membership().rejectSignup({ requestId: OTHER }, as(who))],
    ['MembershipService.ListMembers', (who) => membership().listMembers({}, as(who))],
    ['MembershipService.RemoveMember', (who) => membership().removeMember({ subject: 'sub-nobody' }, as(who))],
    ['MembershipService.ConfirmMember', (who) => membership().confirmMember({ subject: 'sub-nobody' }, as(who))],
    ['MembershipService.GrantAffiliate', (who) => membership().grantAffiliate({ subject: 'sub-nobody' }, as(who))],
    ['MembershipService.ListRejectedSignups', (who) => membership().listRejectedSignups({}, as(who))],
    ['MembershipService.ReopenSignup', (who) => membership().reopenSignup({ requestId: OTHER }, as(who))],
  ];

  it.each(ROWS)('%s: no standing gets what the powerless get; standing gets the power', async (_name, call) => {
    const powerless = await outcome(() => call('powerless'));
    expect(await outcome(() => call('unverified'))).toBe(powerless);
    expect(await outcome(() => call('lapsed'))).toBe(powerless);
    expect(await outcome(() => call('verified'))).not.toBe(powerless);
  });

  it('gives an unconfirmed member member-level reading and no power', async () => {
    const read = (who: Who) => outcome(() => content().listPublishedItems({}, as(who)));
    expect(await outcome(() => approval().getApprovalRules({}, as('unconfirmed')))).toBe('PermissionDenied');
    expect(await outcome(() => membership().listSignupRequests({}, as('unconfirmed')))).toBe('PermissionDenied');
    // The members' note in full, the board-only item not at all: between the public and the officers.
    expect(await read('unconfirmed')).toContain('Members only line.');
    expect(await read('unconfirmed')).not.toContain('Board only');
    expect(await read('powerless')).not.toContain('Members only line.');
    expect(await read('verified')).toContain('Board only');
  });

  // Ross's GUEST ruling (11-23): public pages, events as a member, no power but an Admin's affiliate grant.
  it('gives a guest the public\'s pages and news, members-level events, and no power', async () => {
    expect(await outcome(() => approval().getApprovalRules({}, as('guest')))).toBe('PermissionDenied');
    expect(await outcome(() => membership().listSignupRequests({}, as('guest')))).toBe('PermissionDenied');
    const read = (who: Who) => outcome(() => content().listPublishedItems({}, as(who)));
    expect(await read('guest')).toBe(await read('powerless'));
    await events().saveOccurrence(
      { occurrence: { ...occurrence(), title: 'Members dinner', visibility: EventVisibility.MEMBERS, startsAt: timestampFromDate(new Date('2026-11-21T23:00:00Z')) } },
      as('verified'),
    );
    const titles = async (who: Who) =>
      (await events().listOccurrences({ from: { year: 2026, month: 11, day: 1 }, to: { year: 2026, month: 11, day: 30 } }, as(who))).occurrences.map((o) => o.title);
    expect(await titles('guest')).toContain('Members dinner');
    expect(await titles('unconfirmed')).toContain('Members dinner');
    expect(await titles('powerless')).not.toContain('Members dinner');
  });

  it('keeps the powers of an affiliate (Admin-granted standing)', async () => {
    expect(await outcome(() => approval().getApprovalRules({}, as('affiliate')))).toBe(await outcome(() => approval().getApprovalRules({}, as('verified'))));
    expect(await outcome(() => membership().listSignupRequests({}, as('affiliate')))).toMatch(/^ok /);
  });

  it('records the groups actually used: an unverified holder\'s audit rows carry no power group', async () => {
    await outcome(() => membership().submitSignup({ membershipNumber: '1234567', lastName: 'Madeup', firstName: 'Robin' }, as('unverified')));
    const { rows } = await api.pool.query<{ groups: string[] }>(`SELECT actor_groups AS groups FROM audit_event WHERE actor_sub = 'sub-ov-unverified'`);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.groups).toEqual(['nwfl-members']);
  });

  it('switched off (the default), the unverified holder keeps every power, as before', async () => {
    const offApproval = off.client(ApprovalRuleService);
    expect(await outcome(() => offApproval.getApprovalRules({}, as('unverified')))).toMatch(/^ok /);
    expect(await outcome(() => off.client(MembershipService).listSignupRequests({}, as('unverified')))).toMatch(/^ok /);
    expect(await outcome(() => offApproval.getApprovalRules({}, as('powerless')))).toBe('PermissionDenied');
  });
});
