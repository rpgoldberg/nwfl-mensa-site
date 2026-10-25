// ============================================================================
// RedactionPolicyService (REDACT R1): the per-group redaction policy. Officers
// only (auth/roles.ts requireOfficer). The group is TENANT, never a request
// field.
//
//   GetRedactionPolicy      every cell, resolved fail-closed (a missing cell
//                           reads as HIDE), and the changes waiting
//   ProposeRedactionChange  a loosening of the public audience waits for a
//                           second officer; anything else applies at once and
//                           supersedes a loosening waiting on the same cell
//   ApproveRedactionChange  a different officer applies a waiting change
//
// Every proposal, change, supersession and approval writes an audit row in the
// same transaction. Each write takes a transaction-scoped advisory lock on its
// cell, so the cell's changes are serial even when its policy row is missing.
// ============================================================================
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, type ConnectRouter, type HandlerContext } from '@connectrpc/connect';
import { recordAudit } from '../audit/audit.js';
import { type Caller, callerOf } from '../auth/caller.js';
import { requireOfficer } from '../auth/roles.js';
import { dbError } from '../db/errors.js';
import type { Db } from '../db/pool.js';
import { type TxClient, inTransaction } from '../db/tx.js';
import {
  type RedactionChange,
  RedactionAction,
  RedactionAudience,
  RedactionCategory,
  RedactionCellSchema,
  RedactionChangeSchema,
  RedactionChangeStatus,
  RedactionPolicyService,
} from '../gen/nwfl/mensa/v1/redaction_pb.js';
import {
  AUDIENCES,
  type Action,
  CATEGORIES,
  type Category,
  type PolicyAudience,
  TENANT,
  actionsFor,
  cellKey,
  needsSecondOfficer,
  resolveAction,
} from './policy.js';

export interface RedactionDeps {
  db: Db;
}

const AUDIENCE_OUT: Record<PolicyAudience, RedactionAudience> = {
  public: RedactionAudience.PUBLIC,
  members: RedactionAudience.MEMBERS,
  officers: RedactionAudience.OFFICERS,
};
const CATEGORY_OUT: Record<Category, RedactionCategory> = {
  member_name: RedactionCategory.MEMBER_NAME,
  member_address: RedactionCategory.MEMBER_ADDRESS,
  member_phone: RedactionCategory.MEMBER_PHONE,
  member_email: RedactionCategory.MEMBER_EMAIL,
  private_venue: RedactionCategory.PRIVATE_VENUE,
  business_venue: RedactionCategory.BUSINESS_VENUE,
  officer_contact: RedactionCategory.OFFICER_CONTACT,
  image: RedactionCategory.IMAGE,
};
const ACTION_OUT: Record<Action, RedactionAction> = {
  show: RedactionAction.SHOW,
  redact: RedactionAction.REDACT,
  blur: RedactionAction.BLUR,
  hide: RedactionAction.HIDE,
};
const STATUS_OUT: Record<string, RedactionChangeStatus> = {
  pending: RedactionChangeStatus.PENDING,
  applied: RedactionChangeStatus.APPLIED,
  superseded: RedactionChangeStatus.SUPERSEDED,
};

/** The stored name for a wire value, or undefined for UNSPECIFIED and unknown numbers. */
function nameOf<K extends string, V>(table: Record<K, V>, value: V): K | undefined {
  return (Object.keys(table) as K[]).find((key) => table[key] === value);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const invalid = (message: string): ConnectError => new ConnectError(message, Code.InvalidArgument);
const precondition = (message: string): ConnectError => new ConnectError(message, Code.FailedPrecondition);

interface ChangeRow {
  id: string;
  audience: PolicyAudience;
  category: Category;
  from_action: Action;
  to_action: Action;
  status: string;
  proposed_by_sub: string;
  proposed_at: Date;
  approved_by_sub: string | null;
  approved_at: Date | null;
}

const CHANGE_COLUMNS = `id, audience, category, from_action, to_action, status, proposed_by_sub, proposed_at, approved_by_sub, approved_at`;

function changeMessage(row: ChangeRow): RedactionChange {
  return create(RedactionChangeSchema, {
    changeId: row.id,
    audience: AUDIENCE_OUT[row.audience],
    category: CATEGORY_OUT[row.category],
    fromAction: ACTION_OUT[row.from_action],
    toAction: ACTION_OUT[row.to_action],
    status: STATUS_OUT[row.status],
    proposedBy: row.proposed_by_sub,
    proposedAt: timestampFromDate(row.proposed_at),
    approvedBy: row.approved_by_sub ?? '',
    ...(row.approved_at !== null ? { approvedAt: timestampFromDate(row.approved_at) } : {}),
  });
}

const policySubject = (audience: PolicyAudience, category: Category): string => `${TENANT}:${audience}:${category}`;

export function redactionRoutes(deps: RedactionDeps): (router: ConnectRouter) => void {
  const { db } = deps;
  const callerIn = (ctx: HandlerContext): Caller => callerOf(ctx.values);

  const tx = async <T>(fn: (client: TxClient) => Promise<T>): Promise<T> => {
    try {
      return await inTransaction(db, fn);
    } catch (error) {
      throw dbError(error);
    }
  };

  /** Serialises every write to one cell, and returns its action now, fail-closed. */
  const lockCell = async (client: TxClient, audience: PolicyAudience, category: Category): Promise<Action> => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`redaction_policy:${policySubject(audience, category)}`]);
    const { rows } = await client.query<{ action: string }>(
      `SELECT action FROM redaction_policy WHERE tenant_id = $1 AND audience = $2 AND category = $3`,
      [TENANT, audience, category],
    );
    return resolveAction(new Map(rows.map((row) => [cellKey(audience, category), row.action])), audience, category);
  };

  /** Writes the cell and its audit row. */
  const setCell = async (client: TxClient, caller: Caller, change: ChangeRow): Promise<void> => {
    await client.query(
      `INSERT INTO redaction_policy (tenant_id, audience, category, action, updated_by_sub) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, audience, category) DO UPDATE SET action = EXCLUDED.action, updated_by_sub = EXCLUDED.updated_by_sub, updated_at = now()`,
      [TENANT, change.audience, change.category, change.to_action, caller.subject],
    );
    await recordAudit(client, caller, {
      action: 'redaction_set',
      subjectKind: 'redaction_policy',
      subjectId: policySubject(change.audience, change.category),
      fromState: change.from_action,
      toState: change.to_action,
      payload: { change_id: change.id },
    });
  };

  return (router) => {
    router.service(RedactionPolicyService, {
      getRedactionPolicy: async (_request, ctx) => {
        requireOfficer(callerIn(ctx));
        const cells = await db.query<{ audience: string; category: string; action: string }>(
          `SELECT audience, category, action FROM redaction_policy WHERE tenant_id = $1`,
          [TENANT],
        );
        const policy = new Map(cells.rows.map((row) => [cellKey(row.audience, row.category), row.action]));
        const pending = await db.query<ChangeRow>(
          `SELECT ${CHANGE_COLUMNS} FROM redaction_change WHERE tenant_id = $1 AND status = 'pending' ORDER BY proposed_at, id`,
          [TENANT],
        );
        return {
          cells: AUDIENCES.flatMap((audience) =>
            CATEGORIES.map((category) =>
              create(RedactionCellSchema, {
                audience: AUDIENCE_OUT[audience],
                category: CATEGORY_OUT[category],
                action: ACTION_OUT[resolveAction(policy, audience, category)],
              }),
            ),
          ),
          pending: pending.rows.map(changeMessage),
        };
      },

      proposeRedactionChange: async (request, ctx) => {
        const caller = callerIn(ctx);
        requireOfficer(caller);
        const audience = nameOf(AUDIENCE_OUT, request.audience);
        const category = nameOf(CATEGORY_OUT, request.category);
        const action = nameOf(ACTION_OUT, request.action);
        if (audience === undefined) throw invalid('choose an audience');
        if (category === undefined) throw invalid('choose a category');
        if (action === undefined || !actionsFor(category).includes(action)) {
          throw invalid(category === 'image' ? 'an image is shown, blurred or hidden' : 'text is shown, redacted or hidden');
        }
        return tx(async (client) => {
          const from = await lockCell(client, audience, category);
          if (from === action) throw precondition('the policy already says that');
          if (needsSecondOfficer(audience, category, from, action)) {
            const waiting = await client.query(
              `SELECT 1 FROM redaction_change WHERE tenant_id = $1 AND audience = $2 AND category = $3 AND status = 'pending'`,
              [TENANT, audience, category],
            );
            if (waiting.rows.length > 0) throw precondition('a change to this setting is already waiting for approval');
            const { rows } = await client.query<ChangeRow>(
              `INSERT INTO redaction_change (tenant_id, audience, category, from_action, to_action, status, proposed_by_sub)
               VALUES ($1, $2, $3, $4, $5, 'pending', $6) RETURNING ${CHANGE_COLUMNS}`,
              [TENANT, audience, category, from, action, caller.subject],
            );
            const change = rows[0] as ChangeRow;
            await recordAudit(client, caller, {
              action: 'redaction_propose',
              subjectKind: 'redaction_change',
              subjectId: change.id,
              fromState: from,
              toState: action,
              payload: { tenant: TENANT, audience, category },
            });
            return { change: changeMessage(change) };
          }
          // Applies at once, and replaces a loosening still waiting on this cell.
          const superseded = await client.query<{ id: string }>(
            `UPDATE redaction_change SET status = 'superseded', decided_at = now()
             WHERE tenant_id = $1 AND audience = $2 AND category = $3 AND status = 'pending' RETURNING id`,
            [TENANT, audience, category],
          );
          for (const { id } of superseded.rows) {
            await recordAudit(client, caller, { action: 'redaction_supersede', subjectKind: 'redaction_change', subjectId: id, fromState: 'pending', toState: 'superseded' });
          }
          const { rows } = await client.query<ChangeRow>(
            `INSERT INTO redaction_change (tenant_id, audience, category, from_action, to_action, status, proposed_by_sub, decided_at)
             VALUES ($1, $2, $3, $4, $5, 'applied', $6, now()) RETURNING ${CHANGE_COLUMNS}`,
            [TENANT, audience, category, from, action, caller.subject],
          );
          const change = rows[0] as ChangeRow;
          await setCell(client, caller, change);
          return { change: changeMessage(change) };
        });
      },

      approveRedactionChange: async (request, ctx) => {
        const caller = callerIn(ctx);
        requireOfficer(caller);
        const id = request.changeId.trim().toLowerCase();
        if (!UUID.test(id)) throw invalid('a change id is a UUID');
        return tx(async (client) => {
          const found = (
            await client.query<{ audience: PolicyAudience; category: Category }>(
              `SELECT audience, category FROM redaction_change WHERE id = $1 AND tenant_id = $2`,
              [id, TENANT],
            )
          ).rows[0];
          if (found === undefined) throw new ConnectError('change not found', Code.NotFound);
          // The cell first, as a proposal takes it, then the change.
          await lockCell(client, found.audience, found.category);
          const change = (await client.query<ChangeRow>(`SELECT ${CHANGE_COLUMNS} FROM redaction_change WHERE id = $1 FOR UPDATE`, [id])).rows[0] as ChangeRow;
          if (change.status !== 'pending') throw precondition('this change is not waiting for approval');
          if (change.proposed_by_sub === caller.subject) throw new ConnectError('a second officer approves this change', Code.PermissionDenied);
          const { rows } = await client.query<ChangeRow>(
            `UPDATE redaction_change SET status = 'applied', approved_by_sub = $2, approved_at = now(), decided_at = now()
             WHERE id = $1 RETURNING ${CHANGE_COLUMNS}`,
            [id, caller.subject],
          );
          const applied = rows[0] as ChangeRow;
          await recordAudit(client, caller, { action: 'redaction_approve', subjectKind: 'redaction_change', subjectId: id, fromState: 'pending', toState: 'applied' });
          await setCell(client, caller, applied);
          return { change: changeMessage(applied) };
        });
      },
    });
  };
}
