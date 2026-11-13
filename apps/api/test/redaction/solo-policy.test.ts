// SOLO-APPROVE, the redaction policy: loosening a public setting under each approval rule, over gRPC
// against a migrated database. Two-person (the default) is as before: the loosening waits, and its
// proposer may not approve it. One-approver applies it at once, approved by the proposer, recorded
// under that rule, and replaces a loosening still waiting. The content rule and this one are separate
// settings: the editor's "content only" answer is content one-approver with this scope left two-person.
// Every person here is made up.
import { type Client, Code } from '@connectrpc/connect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApprovalRule, ApprovalRuleService, ApprovalScope } from '../../src/gen/nwfl/mensa/v1/approval_pb.js';
import {
  RedactionAction as Action,
  RedactionAudience as Audience,
  RedactionCategory as Category,
  RedactionChangeStatus as Status,
  RedactionPolicyService,
} from '../../src/gen/nwfl/mensa/v1/redaction_pb.js';
import { type Api, OFFICER, as, startApi } from '../helpers/api.js';
import { live } from '../helpers/pg.js';

const ADMIN = as('admin-token');
const SECOND = as('pub-token');

describe.skipIf(!live)('the redaction policy under the approval rule', () => {
  let api: Api;
  let policy: Client<typeof RedactionPolicyService>;
  let rules: Client<typeof ApprovalRuleService>;

  const set = (scope: ApprovalScope, rule: ApprovalRule): Promise<unknown> => rules.setApprovalRule({ scope, rule, reason: 'test' }, ADMIN);
  const propose = (category: Category, action: Action, who: { headers: Record<string, string> } = OFFICER) => policy.proposeRedactionChange({ audience: Audience.PUBLIC, category, action }, who);
  const action = async (category: Category): Promise<Action | undefined> =>
    (await policy.getRedactionPolicy({}, OFFICER)).cells.find((c) => c.audience === Audience.PUBLIC && c.category === category)?.action;
  const ruleOf = async (changeId: string): Promise<string> =>
    (await api.pool.query<{ approval_rule: string }>(`SELECT approval_rule FROM redaction_change WHERE id = $1`, [changeId])).rows[0]!.approval_rule;

  beforeAll(async () => {
    api = await startApi('nwfl_solo_policy');
    policy = api.client(RedactionPolicyService);
    rules = api.client(ApprovalRuleService);
  });

  afterAll(async () => {
    await api?.close();
  });

  it('keeps a public loosening waiting under two-person, and refuses its proposer', async () => {
    const change = (await propose(Category.MEMBER_PHONE, Action.SHOW)).change!;
    expect(change.status).toBe(Status.PENDING);
    await expect(policy.approveRedactionChange({ changeId: change.changeId }, OFFICER)).rejects.toMatchObject({ code: Code.PermissionDenied });
    await expect(propose(Category.MEMBER_PHONE, Action.SHOW, SECOND)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    const applied = (await policy.approveRedactionChange({ changeId: change.changeId }, SECOND)).change!;
    expect(applied).toMatchObject({ status: Status.APPLIED, approvedBy: 'sub-pub' });
    expect(await ruleOf(change.changeId)).toBe('two_person');
  });

  it('applies a public loosening at once under one-approver, approved by its proposer and recorded so', async () => {
    await set(ApprovalScope.REDACTION_POLICY, ApprovalRule.ONE_APPROVER);
    const change = (await propose(Category.MEMBER_EMAIL, Action.SHOW)).change!;
    expect(change).toMatchObject({ status: Status.APPLIED, proposedBy: 'sub-officer', approvedBy: 'sub-officer' });
    expect(await ruleOf(change.changeId)).toBe('one_approver');
    expect(await action(Category.MEMBER_EMAIL)).toBe(Action.SHOW);
    await set(ApprovalScope.REDACTION_POLICY, ApprovalRule.TWO_PERSON);
  });

  it('under one-approver, replaces a loosening still waiting, and lets a proposer approve one made under two-person', async () => {
    const waiting = (await propose(Category.MEMBER_ADDRESS, Action.SHOW)).change!;
    const second = (await propose(Category.PRIVATE_VENUE, Action.SHOW)).change!;
    expect([waiting.status, second.status]).toEqual([Status.PENDING, Status.PENDING]);
    await set(ApprovalScope.REDACTION_POLICY, ApprovalRule.ONE_APPROVER);
    const replaced = (await propose(Category.MEMBER_ADDRESS, Action.SHOW, SECOND)).change!;
    expect(replaced).toMatchObject({ status: Status.APPLIED, approvedBy: 'sub-pub' });
    const { pending } = await policy.getRedactionPolicy({}, OFFICER);
    expect(pending.map((c) => c.changeId)).toEqual([second.changeId]);
    const approved = (await policy.approveRedactionChange({ changeId: second.changeId }, OFFICER)).change!;
    expect(approved).toMatchObject({ status: Status.APPLIED, proposedBy: 'sub-officer', approvedBy: 'sub-officer' });
    expect(await ruleOf(second.changeId)).toBe('one_approver');
    await set(ApprovalScope.REDACTION_POLICY, ApprovalRule.TWO_PERSON);
  });

  it('is two-person again once switched back', async () => {
    await set(ApprovalScope.REDACTION_POLICY, ApprovalRule.ONE_APPROVER);
    await set(ApprovalScope.REDACTION_POLICY, ApprovalRule.TWO_PERSON);
    const change = (await propose(Category.OFFICER_CONTACT, Action.SHOW)).change!;
    expect(change.status).toBe(Status.PENDING);
    await expect(policy.approveRedactionChange({ changeId: change.changeId }, OFFICER)).rejects.toMatchObject({ code: Code.PermissionDenied });
  });

  it('leaves a public loosening two-person while only content is one-approver ("content only")', async () => {
    // business_venue, which the public sees: tightened first, so the loosening back is one whatever
    // 0022 (REDACT-LOOK) has done to the public member_name and image cells.
    await set(ApprovalScope.CONTENT, ApprovalRule.ONE_APPROVER);
    expect((await propose(Category.BUSINESS_VENUE, Action.HIDE)).change?.status).toBe(Status.APPLIED);
    const change = (await propose(Category.BUSINESS_VENUE, Action.SHOW)).change!;
    expect(change.status).toBe(Status.PENDING);
    await expect(policy.approveRedactionChange({ changeId: change.changeId }, OFFICER)).rejects.toMatchObject({ code: Code.PermissionDenied });
    expect(await ruleOf(change.changeId)).toBe('two_person');
    await set(ApprovalScope.CONTENT, ApprovalRule.TWO_PERSON);
  });

  it('keeps the publication ledger intact through solo applies', async () => {
    expect((await policy.verifyLedger({}, OFFICER)).intact).toBe(true);
  });
});
