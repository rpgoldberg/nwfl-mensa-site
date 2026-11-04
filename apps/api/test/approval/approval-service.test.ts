// SOLO-APPROVE: ApprovalRuleService through the real gRPC server and a migrated database. Only the
// Admin flips a scope's rule; every flip is written once to the flip ledger and the audit log, with a
// required reason; a repeat changes nothing; officers read the setting and the ledger, nobody else
// does. Every person here is made up.
import { type Client, Code } from '@connectrpc/connect';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
  const revision = async (scope: ApprovalScope): Promise<string | undefined> =>
    (await rules.getApprovalRules({}, OFFICER)).settings.find((s) => s.scope === scope)?.revision;
  /** How many times `run` made the API call approval_rule_set: the handler's own checks come first. */
  const writes = async (run: () => Promise<unknown>): Promise<number> => {
    const spy = vi.spyOn(api.pool, 'query');
    try {
      await run();
      return spy.mock.calls.filter(([text]) => String(typeof text === 'string' ? text : (text as { text?: string }).text).includes('approval_rule_set')).length;
    } finally {
      spy.mockRestore();
    }
  };

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
      // Refused by the handler, before the database's own check (0023's 42501) is ever asked.
      const calls = await writes(async () => {
        for (const token of REFUSED) {
          await expect(rules.setApprovalRule({ scope: ApprovalScope.CONTENT, rule: ApprovalRule.ONE_APPROVER, reason: 'away' }, as(token)), token).rejects.toMatchObject({
            code: Code.PermissionDenied,
          });
        }
      });
      expect(calls).toBe(0);
      expect(await ledger()).toEqual(before);
      expect(await setting(ApprovalScope.CONTENT)).toBe(ApprovalRule.TWO_PERSON);
    });

    it('checks the Admin before anything else: a bad request from anyone else is still refused as not permitted', async () => {
      await expect(rules.setApprovalRule({}, OFFICER)).rejects.toMatchObject({ code: Code.PermissionDenied });
    });

    it('refuses an unset or unknown scope or rule, a reason that is blank, says nothing or is over-long, and an over-long revision', async () => {
      const before = await ledger();
      const reason = 'say why, in 1 to 2000 characters, in words';
      const plain = 'write the reason in plain text, without control characters';
      const calls = await writes(async () => {
        for (const [request, message] of [
          [{ scope: ApprovalScope.UNSPECIFIED, rule: ApprovalRule.ONE_APPROVER, reason: 'away' }, 'choose what the rule is for'],
          [{ scope: ApprovalScope.CONTENT, rule: ApprovalRule.UNSPECIFIED, reason: 'away' }, 'choose two officers or one'],
          [{ scope: 99 as ApprovalScope, rule: ApprovalRule.ONE_APPROVER, reason: 'away' }, 'choose what the rule is for'],
          [{ scope: ApprovalScope.CONTENT, rule: 99 as ApprovalRule, reason: 'away' }, 'choose two officers or one'],
          [{ scope: ApprovalScope.CONTENT, rule: ApprovalRule.ONE_APPROVER, reason: '   ' }, reason],
          [{ scope: ApprovalScope.CONTENT, rule: ApprovalRule.TWO_PERSON, reason: '' }, reason],
          [{ scope: ApprovalScope.CONTENT, rule: ApprovalRule.ONE_APPROVER, reason: 'x'.repeat(2001) }, reason],
          [{ scope: ApprovalScope.CONTENT, rule: ApprovalRule.ONE_APPROVER, reason: '\t\n' }, reason],
          [{ scope: ApprovalScope.CONTENT, rule: ApprovalRule.ONE_APPROVER, reason: '\u200b' }, reason],
          [{ scope: ApprovalScope.CONTENT, rule: ApprovalRule.ONE_APPROVER, reason: '\u00a0\ufeff' }, reason],
          [{ scope: ApprovalScope.CONTENT, rule: ApprovalRule.ONE_APPROVER, reason: '...' }, reason],
          // A NUL, an escape code, DEL or a C1 code: never kept in the record, and never an internal error.
          [{ scope: ApprovalScope.CONTENT, rule: ApprovalRule.ONE_APPROVER, reason: 'a\u0000b' }, plain],
          [{ scope: ApprovalScope.CONTENT, rule: ApprovalRule.ONE_APPROVER, reason: 'away\u001b[2J' }, plain],
          [{ scope: ApprovalScope.CONTENT, rule: ApprovalRule.ONE_APPROVER, reason: 'away\u007f' }, plain],
          [{ scope: ApprovalScope.CONTENT, rule: ApprovalRule.ONE_APPROVER, reason: 'away\u0085' }, plain],
          [{ scope: ApprovalScope.CONTENT, rule: ApprovalRule.ONE_APPROVER, reason: '\u0007away' }, plain],
          [{ scope: ApprovalScope.CONTENT, rule: ApprovalRule.ONE_APPROVER, reason: 'away', expectedRevision: 'r'.repeat(65) }, 'no such revision'],
        ] as const) {
          await expect(rules.setApprovalRule(request, ADMIN), JSON.stringify({ ...request, reason: request.reason.slice(0, 8) })).rejects.toMatchObject({ code: Code.InvalidArgument, rawMessage: message });
        }
      });
      expect(calls).toBe(0);
      expect(await ledger()).toEqual(before);
    });

    it('takes a reason in any alphabet, or a number, and stores it trimmed of every kind of space', async () => {
      const done = await rules.setApprovalRule({ scope: ApprovalScope.CONTENT, rule: ApprovalRule.ONE_APPROVER, reason: '\u00a0\u0395\u03bb\u03bb\u03ac\u03b4\u03b1\u2003' }, ADMIN);
      expect(done.changed).toBe(true);
      const { rows } = await api.pool.query(`SELECT reason FROM approval_rule_change ORDER BY changed_at DESC LIMIT 1`);
      expect(rows[0]).toEqual({ reason: '\u0395\u03bb\u03bb\u03ac\u03b4\u03b1' });
      expect((await rules.setApprovalRule({ scope: ApprovalScope.CONTENT, rule: ApprovalRule.TWO_PERSON, reason: '2' }, ADMIN)).changed).toBe(true);
      // A tab and a line break, as a textarea sends them, stay.
      expect((await rules.setApprovalRule({ scope: ApprovalScope.CONTENT, rule: ApprovalRule.ONE_APPROVER, reason: 'away\r\nback\tFriday' }, ADMIN)).changed).toBe(true);
      expect((await api.pool.query(`SELECT reason FROM approval_rule_change ORDER BY changed_at DESC LIMIT 1`)).rows[0]).toEqual({ reason: 'away\r\nback\tFriday' });
      expect((await rules.setApprovalRule({ scope: ApprovalScope.CONTENT, rule: ApprovalRule.TWO_PERSON, reason: 'back' }, ADMIN)).changed).toBe(true);
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

    it('names the revision it read, and refuses a stale form sent again after a later switch', async () => {
      const read = await revision(ApprovalScope.CONTENT);
      const away = { scope: ApprovalScope.CONTENT, rule: ApprovalRule.ONE_APPROVER, reason: 'Webmaster away this week', expectedRevision: read };
      const first = await rules.setApprovalRule(away, ADMIN);
      expect(first.changed).toBe(true);
      expect(first.setting?.revision).toMatch(/^[0-9a-f-]{36}$/);
      expect(first.setting?.revision).not.toBe(read);
      expect(await revision(ApprovalScope.CONTENT)).toBe(first.setting?.revision);
      // Pressed twice: nothing changes, nothing is refused.
      expect((await rules.setApprovalRule(away, ADMIN)).changed).toBe(false);
      await rules.setApprovalRule({ scope: ApprovalScope.CONTENT, rule: ApprovalRule.TWO_PERSON, reason: 'Webmaster back', expectedRevision: first.setting!.revision }, ADMIN);
      const before = await ledger();
      await expect(rules.setApprovalRule(away, ADMIN)).rejects.toMatchObject({ code: Code.FailedPrecondition });
      expect(await ledger()).toEqual(before);
      expect(await setting(ApprovalScope.CONTENT)).toBe(ApprovalRule.TWO_PERSON);
      // With the revision in force it goes through; with none named, nothing is checked.
      expect((await rules.setApprovalRule({ ...away, expectedRevision: (await revision(ApprovalScope.CONTENT))! }, ADMIN)).changed).toBe(true);
      expect((await rules.setApprovalRule({ scope: away.scope, rule: ApprovalRule.TWO_PERSON, reason: away.reason }, ADMIN)).changed).toBe(true);
    });

    it('serves the Admin without the officers group as it serves officers: reads the setting and the record, and flips it', async () => {
      const lone = as('lone-admin-token');
      expect((await rules.getApprovalRules({}, lone)).settings).toHaveLength(2);
      expect((await rules.setApprovalRule({ scope: ApprovalScope.REDACTION_POLICY, rule: ApprovalRule.ONE_APPROVER, reason: 'lone admin' }, lone)).changed).toBe(true);
      expect((await rules.listApprovalRuleChanges({ pageSize: 1 }, lone)).changes[0]).toMatchObject({ reason: 'lone admin', changedBy: 'sub-lone-admin' });
      await rules.setApprovalRule({ scope: ApprovalScope.REDACTION_POLICY, rule: ApprovalRule.TWO_PERSON, reason: 'lone admin, back' }, lone);
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
      expect(all.length).toBe(16);
      expect(all[0]).toMatchObject({ scope: ApprovalScope.CONTENT, fromRule: ApprovalRule.ONE_APPROVER, toRule: ApprovalRule.TWO_PERSON, reason: 'neither', changedBy: 'sub-admin' });
      expect(all[0]?.changeId).toMatch(/^[0-9a-f-]{36}$/);
      expect(all[0]?.changedAt).toBeDefined();
      expect(all.at(-1)).toMatchObject({ fromRule: ApprovalRule.TWO_PERSON, toRule: ApprovalRule.ONE_APPROVER, reason: '\u0395\u03bb\u03bb\u03ac\u03b4\u03b1' });
      expect(all.map((c) => c.reason)).toContain('Webmaster away until Monday');
      const policy = (await rules.listApprovalRuleChanges({ scope: ApprovalScope.REDACTION_POLICY }, OFFICER)).changes;
      expect(policy.map((c) => c.reason)).toEqual(['content only', 'policy only', 'lone admin, back', 'lone admin']);
      expect((await rules.listApprovalRuleChanges({ pageSize: 2 }, OFFICER)).changes).toHaveLength(2);
      await expect(rules.listApprovalRuleChanges({ pageSize: -1 }, OFFICER)).rejects.toMatchObject({ code: Code.InvalidArgument });
      await expect(rules.listApprovalRuleChanges({ scope: 99 as ApprovalScope }, OFFICER)).rejects.toMatchObject({ code: Code.InvalidArgument });
    });
  });
});
