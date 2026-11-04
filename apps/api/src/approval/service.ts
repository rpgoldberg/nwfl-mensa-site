// ============================================================================
// ApprovalRuleService (SOLO-APPROVE): whether a second officer must approve,
// per scope. 0023 holds the setting, its flip ledger and the rules each scope
// follows under it; this service reads it for officers and lets the Admin
// switch it.
//
//   GetApprovalRules         officers and the Admin: both scopes, when each
//                            was set and by which switch (the revision),
//                            never who set it
//   SetApprovalRule          the Admin alone (checked first, authoritative):
//                            a known scope and rule and a reason of 1 to 2000
//                            characters with a letter or digit in it, all
//                            checked before the database is asked; the same
//                            rule again changes nothing; a switch from a
//                            revision that has moved on is refused
//   ListApprovalRuleChanges  officers and the Admin: every switch, newest first
//
// readRule is how the content workflow and the issue loader read the content
// rule: under FOR SHARE (0023 approval_rule_read), after the item's row lock
// and before the ledger head, so a flip and an approval serialize.
// ============================================================================
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, type ConnectRouter, type HandlerContext } from '@connectrpc/connect';
import { traceId } from '../audit/audit.js';
import { type Caller, callerOf } from '../auth/caller.js';
import { requireAdmin, requireOfficerOrAdmin } from '../auth/roles.js';
import { dbError } from '../db/errors.js';
import type { Db } from '../db/pool.js';
import type { TxClient } from '../db/tx.js';
import {
  type ApprovalRuleChange,
  ApprovalRuleChangeSchema,
  ApprovalRuleService,
  type ApprovalSetting,
  ApprovalSettingSchema,
  ApprovalRule,
  ApprovalScope,
} from '../gen/nwfl/mensa/v1/approval_pb.js';
import { pageSize } from '../grpc/paging.js';

export type Scope = 'content' | 'redaction_policy';
export type Rule = 'two_person' | 'one_approver';

export interface ApprovalDeps {
  db: Db;
}

const SCOPE_OUT: Record<Scope, ApprovalScope> = { content: ApprovalScope.CONTENT, redaction_policy: ApprovalScope.REDACTION_POLICY };
const RULE_OUT: Record<Rule, ApprovalRule> = { two_person: ApprovalRule.TWO_PERSON, one_approver: ApprovalRule.ONE_APPROVER };
const MAX_REASON = 2_000;
/** A uuid is 36; anything much longer is not a revision this API gave out. */
const MAX_REVISION = 64;
/** A reason says something: a letter in any alphabet, or a digit (0023's [[:alnum:]] under pg_c_utf8). */
const SAYS_SOMETHING = /[\p{Alphabetic}0-9]/u;

/** The stored name for a wire value, or undefined for UNSPECIFIED and unknown numbers. */
function nameOf<K extends string, V>(table: Record<K, V>, value: V): K | undefined {
  return (Object.keys(table) as K[]).find((key) => table[key] === value);
}

const invalid = (message: string): ConnectError => new ConnectError(message, Code.InvalidArgument);

/** A scope's rule now, under a share lock held to the end of the transaction. */
export async function readRule(client: TxClient, scope: Scope): Promise<Rule> {
  const { rows } = await client.query<{ rule: Rule }>(`SELECT approval_rule_read($1) AS rule`, [scope]);
  return (rows[0] as { rule: Rule }).rule;
}

interface SettingRow {
  scope: Scope;
  rule: Rule;
  set_at: Date | null;
  change_id: string | null;
}

const settingMessage = (row: SettingRow): ApprovalSetting =>
  create(ApprovalSettingSchema, {
    scope: SCOPE_OUT[row.scope],
    rule: RULE_OUT[row.rule],
    ...(row.set_at !== null ? { setAt: timestampFromDate(row.set_at) } : {}),
    revision: row.change_id ?? '',
  });

interface ChangeRow {
  id: string;
  scope: Scope;
  from_rule: Rule;
  to_rule: Rule;
  reason: string;
  changed_by_sub: string;
  changed_at: Date;
}

const changeMessage = (row: ChangeRow): ApprovalRuleChange =>
  create(ApprovalRuleChangeSchema, {
    changeId: row.id,
    scope: SCOPE_OUT[row.scope],
    fromRule: RULE_OUT[row.from_rule],
    toRule: RULE_OUT[row.to_rule],
    reason: row.reason,
    changedBy: row.changed_by_sub,
    changedAt: timestampFromDate(row.changed_at),
  });

export function approvalRoutes(deps: ApprovalDeps): (router: ConnectRouter) => void {
  const { db } = deps;
  const callerIn = (ctx: HandlerContext): Caller => callerOf(ctx.values);

  return (router) => {
    router.service(ApprovalRuleService, {
      getApprovalRules: async (_request, ctx) => {
        requireOfficerOrAdmin(callerIn(ctx));
        const { rows } = await db.query<SettingRow>(`SELECT scope, rule, set_at, change_id FROM approval_rule ORDER BY scope`);
        return { settings: rows.map(settingMessage) };
      },

      setApprovalRule: async (request, ctx) => {
        const caller = callerIn(ctx);
        requireAdmin(caller);
        const scope = nameOf(SCOPE_OUT, request.scope);
        const rule = nameOf(RULE_OUT, request.rule);
        const reason = request.reason.trim();
        if (scope === undefined) throw invalid('choose what the rule is for');
        if (rule === undefined) throw invalid('choose two officers or one');
        if (reason.length > MAX_REASON || !SAYS_SOMETHING.test(reason)) throw invalid('say why, in 1 to 2000 characters, in words');
        const expected = request.expectedRevision;
        if (expected !== undefined && expected.length > MAX_REVISION) throw invalid('no such revision');
        try {
          const { rows } = await db.query<{ rule: Rule; set_at: Date | null; change_id: string | null; changed: boolean }>(
            `SELECT rule, set_at, change_id, changed FROM approval_rule_set($1, $2, $3, $4, $5, $6, $7)`,
            [scope, rule, reason, caller.subject, [...caller.groups], traceId(), expected ?? null],
          );
          const row = rows[0] as { rule: Rule; set_at: Date | null; change_id: string | null; changed: boolean };
          return { setting: settingMessage({ scope, rule: row.rule, set_at: row.set_at, change_id: row.change_id }), changed: row.changed };
        } catch (error) {
          throw dbError(error);
        }
      },

      listApprovalRuleChanges: async (request, ctx) => {
        requireOfficerOrAdmin(callerIn(ctx));
        const size = pageSize(request.pageSize);
        const scope = request.scope === ApprovalScope.UNSPECIFIED ? null : nameOf(SCOPE_OUT, request.scope);
        if (scope === undefined) throw invalid('no such scope');
        const { rows } = await db.query<ChangeRow>(
          `SELECT id, scope, from_rule, to_rule, reason, changed_by_sub, changed_at FROM approval_rule_change
           WHERE $1::text IS NULL OR scope = $1 ORDER BY changed_at DESC, id DESC LIMIT $2`,
          [scope, size],
        );
        return { changes: rows.map(changeMessage) };
      },
    });
  };
}
