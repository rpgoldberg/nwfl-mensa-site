// SOLO-APPROVE: ApprovalRuleService through the real gRPC server and a migrated database. Only the
// Admin flips a scope's rule; every flip is written once to the flip ledger and the audit log, with a
// required reason; a repeat changes nothing; officers read the setting and the ledger, nobody else
// does. Every person here is made up.
import { type Client, Code } from '@connectrpc/connect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApprovalRule, ApprovalRuleService, ApprovalScope } from '../../src/gen/nwfl/mensa/v1/approval_pb.js';
import { type Api, as, startApi } from '../helpers/api.js';
import { live } from '../helpers/pg.js';

const ADMIN = as('admin-token');
const OFFICER = as('officer-token');
const REFUSED = ['member-token', 'officer-token', 'pub-token', 'treasurer-token', 'webmaster-token', 'approver-token', 'agent-token', 'verifier-token', 'stray-admin-token'] as const;

describe.skipIf(!live)('ApprovalRuleService', () => {
  let api: Api;
  let rules: Client<typeof ApprovalRuleService>;

  const ledger = async (): Promise<{ changes: number; audits: number }> => {
    const { rows } = await api.pool.query<{ changes: number; audits: number }>(
      `SELECT (SELECT count(*)::int FROM approval_rule_change) AS changes, (SELECT count(*)::int FROM audit_event WHERE action = 'approval_rule_set') AS audits`,
    );
    return rows[0]!;
  };
  const setting = async (scope: ApprovalScope): Promise<ApprovalRule | undefined> =>
    (await rules.getApprovalRules({}, OFFICER)).settings.find((s) => s.scope === scope)?.rule;

  beforeAll(async () => {
    api = await startApi('nwfl_solo_api');
    rules = api.client(ApprovalRuleService);
  });

  afterAll(async () => {
    await api?.close();
  });

  describe('who may flip it', () => {
    it('refuses everyone but the Admin, in the API, writing nothing', async () => {
      const before = await ledger();
      await expect(rules.setApprovalRule({ scope: ApprovalScope.CONTENT, rule: ApprovalRule.ONE_APPROVER, reason: 'away' })).rejects.toMatchObject({ code: Code.Unauthenticated });
      for (const token of REFUSED) {
        await expect(rules.setApprovalRule({ scope: ApprovalScope.CONTENT, rule: ApprovalRule.ONE_APPROVER, reason: 'away' }, as(token)), token).rejects.toMatchObject({
          code: Code.PermissionDenied,
        });
      }
      expect(await ledger()).toEqual(before);
      expect(await setting(ApprovalScope.CONTENT)).toBe(ApprovalRule.TWO_PERSON);
    });

    it('checks the Admin before anything else: a bad request from anyone else is still refused as not permitted', async () => {
      await expect(rules.setApprovalRule({}, OFFICER)).rejects.toMatchObject({ code: Code.PermissionDenied });
    });

    it('refuses an unset or unknown scope or rule, and a blank or over-long reason', async () => {
      const before = await ledger();
      for (const request of [
        { scope: ApprovalScope.UNSPECIFIED, rule: ApprovalRule.ONE_APPROVER, reason: 'away' },
        { scope: ApprovalScope.CONTENT, rule: ApprovalRule.UNSPECIFIED, reason: 'away' },
        { scope: 99 as ApprovalScope, rule: ApprovalRule.ONE_APPROVER, reason: 'away' },
        { scope: ApprovalScope.CONTENT, rule: 99 as ApprovalRule, reason: 'away' },
        { scope: ApprovalScope.CONTENT, rule: ApprovalRule.ONE_APPROVER, reason: '   ' },
        { scope: ApprovalScope.CONTENT, rule: ApprovalRule.TWO_PERSON, reason: '' },
        { scope: ApprovalScope.CONTENT, rule: ApprovalRule.ONE_APPROVER, reason: 'x'.repeat(2001) },
      ]) {
        await expect(rules.setApprovalRule(request, ADMIN), JSON.stringify({ ...request, reason: request.reason.slice(0, 8) })).rejects.toMatchObject({ code: Code.InvalidArgument });
      }
      expect(await ledger()).toEqual(before);
    });
  });

  describe('a flip', () => {
    it('sets one scope, records it once, and is a no-op when repeated', async () => {
      const before = await ledger();
      const first = await rules.setApprovalRule({ scope: ApprovalScope.CONTENT, rule: ApprovalRule.ONE_APPROVER, reason: '  Webmaster away until Monday ' }, ADMIN);
      expect(first.changed).toBe(true);
      expect(first.setting).toMatchObject({ scope: ApprovalScope.CONTENT, rule: ApprovalRule.ONE_APPROVER });
      expect(first.setting?.setAt).toBeDefined();
      expect(await ledger()).toEqual({ changes: before.changes + 1, audits: before.audits + 1 });

      const again = await rules.setApprovalRule({ scope: ApprovalScope.CONTENT, rule: ApprovalRule.ONE_APPROVER, reason: 'pressed again' }, ADMIN);
      expect(again.changed).toBe(false);
      expect(again.setting).toEqual(first.setting);
      expect(await ledger()).toEqual({ changes: before.changes + 1, audits: before.audits + 1 });

      expect(await setting(ApprovalScope.CONTENT)).toBe(ApprovalRule.ONE_APPROVER);
      expect(await setting(ApprovalScope.REDACTION_POLICY)).toBe(ApprovalRule.TWO_PERSON);

      const { rows } = await api.pool.query(`SELECT changed_by_sub, changed_by_groups, from_rule, to_rule, reason FROM approval_rule_change ORDER BY changed_at DESC LIMIT 1`);
      expect(rows[0]).toEqual({
        changed_by_sub: 'sub-admin',
        changed_by_groups: ['nwfl-members', 'nwfl-officers', 'nwfl-office-publications', 'nwfl-office-editor', 'nwfl-admin'],
        from_rule: 'two_person',
        to_rule: 'one_approver',
        reason: 'Webmaster away until Monday',
      });
      await rules.setApprovalRule({ scope: ApprovalScope.CONTENT, rule: ApprovalRule.TWO_PERSON, reason: 'Webmaster back' }, ADMIN);
    });

    it('keeps the two scopes apart, both ways and together', async () => {
      const both = async (): Promise<Array<ApprovalRule | undefined>> => [await setting(ApprovalScope.CONTENT), await setting(ApprovalScope.REDACTION_POLICY)];
      await rules.setApprovalRule({ scope: ApprovalScope.REDACTION_POLICY, rule: ApprovalRule.ONE_APPROVER, reason: 'policy only' }, ADMIN);
      expect(await both()).toEqual([ApprovalRule.TWO_PERSON, ApprovalRule.ONE_APPROVER]);
      await rules.setApprovalRule({ scope: ApprovalScope.CONTENT, rule: ApprovalRule.ONE_APPROVER, reason: 'both' }, ADMIN);
      expect(await both()).toEqual([ApprovalRule.ONE_APPROVER, ApprovalRule.ONE_APPROVER]);
      await rules.setApprovalRule({ scope: ApprovalScope.REDACTION_POLICY, rule: ApprovalRule.TWO_PERSON, reason: 'content only' }, ADMIN);
      expect(await both()).toEqual([ApprovalRule.ONE_APPROVER, ApprovalRule.TWO_PERSON]);
      await rules.setApprovalRule({ scope: ApprovalScope.CONTENT, rule: ApprovalRule.TWO_PERSON, reason: 'neither' }, ADMIN);
      expect(await both()).toEqual([ApprovalRule.TWO_PERSON, ApprovalRule.TWO_PERSON]);
    });
  });

  describe('reading it', () => {
    it('gives officers both settings, with the date set and never who set it', async () => {
      const { settings } = await rules.getApprovalRules({}, as('treasurer-token'));
      expect(settings.map((s) => s.scope)).toEqual([ApprovalScope.CONTENT, ApprovalScope.REDACTION_POLICY]);
      expect(settings.every((s) => s.setAt !== undefined)).toBe(true);
      expect(JSON.stringify(settings, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v))).not.toContain('sub-admin');
    });

    it('refuses the setting to the public, members and machines', async () => {
      await expect(rules.getApprovalRules({})).rejects.toMatchObject({ code: Code.Unauthenticated });
      for (const token of ['member-token', 'agent-token', 'verifier-token'] as const) {
        await expect(rules.getApprovalRules({}, as(token)), token).rejects.toMatchObject({ code: Code.PermissionDenied });
        await expect(rules.listApprovalRuleChanges({}, as(token)), token).rejects.toMatchObject({ code: Code.PermissionDenied });
      }
      await expect(rules.listApprovalRuleChanges({})).rejects.toMatchObject({ code: Code.Unauthenticated });
    });

    it('lists the flips to officers, newest first, by scope and a page at a time', async () => {
      const all = (await rules.listApprovalRuleChanges({}, OFFICER)).changes;
      expect(all.length).toBe(6);
      expect(all[0]).toMatchObject({ scope: ApprovalScope.CONTENT, fromRule: ApprovalRule.ONE_APPROVER, toRule: ApprovalRule.TWO_PERSON, reason: 'neither', changedBy: 'sub-admin' });
      expect(all[0]?.changeId).toMatch(/^[0-9a-f-]{36}$/);
      expect(all[0]?.changedAt).toBeDefined();
      expect(all.at(-1)).toMatchObject({ fromRule: ApprovalRule.TWO_PERSON, toRule: ApprovalRule.ONE_APPROVER, reason: 'Webmaster away until Monday' });
      const policy = (await rules.listApprovalRuleChanges({ scope: ApprovalScope.REDACTION_POLICY }, OFFICER)).changes;
      expect(policy.map((c) => c.reason)).toEqual(['content only', 'policy only']);
      expect((await rules.listApprovalRuleChanges({ pageSize: 2 }, OFFICER)).changes).toHaveLength(2);
      await expect(rules.listApprovalRuleChanges({ pageSize: -1 }, OFFICER)).rejects.toMatchObject({ code: Code.InvalidArgument });
      await expect(rules.listApprovalRuleChanges({ scope: 99 as ApprovalScope }, OFFICER)).rejects.toMatchObject({ code: Code.InvalidArgument });
    });
  });
});
