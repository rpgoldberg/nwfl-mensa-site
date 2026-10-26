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
// Every write goes through 0013's SECURITY DEFINER functions, the app role's
// only way to change the policy: they lock the cell, hold four-eyes, and write
// the change, the cell and the audit rows together. The checks here only give
// a clear refusal first.
// ============================================================================
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, type ConnectRouter, type HandlerContext } from '@connectrpc/connect';
import { traceId } from '../audit/audit.js';
import { type Caller, callerOf } from '../auth/caller.js';
import { requireOfficer } from '../auth/roles.js';
import { ledgerHandlers } from '../ledger/handlers.js';
import { recordAll } from '../ledger/ledger.js';
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
import { markHandlers } from './marks.js';
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

  /** The caller as the redaction functions record them in audit rows. */
  const actor = (caller: Caller): [string | null, string[], string | null] => [caller.subject, [...caller.groups], traceId()];

  /** The cell's action now, fail-closed. Unlocked: for a clear refusal only; 0013's functions decide under lock. */
  const currentAction = async (client: TxClient, audience: PolicyAudience, category: Category): Promise<Action> => {
    const { rows } = await client.query<{ action: string }>(
      `SELECT action FROM redaction_policy WHERE tenant_id = $1 AND audience = $2 AND category = $3`,
      [TENANT, audience, category],
    );
    return resolveAction(new Map(rows.map((row) => [cellKey(audience, category), row.action])), audience, category);
  };

  return (router) => {
    router.service(RedactionPolicyService, {
      // Marks (R2a): add, list, and the four-eyes removal.
      ...markHandlers({ db }),
      ...ledgerHandlers({ db }),
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
          const from = await currentAction(client, audience, category);
          if (from === action) throw precondition('the policy already says that');
          if (needsSecondOfficer(audience, category, from, action)) {
            const waiting = await client.query(
              `SELECT 1 FROM redaction_change WHERE tenant_id = $1 AND audience = $2 AND category = $3 AND status = 'pending'`,
              [TENANT, audience, category],
            );
            if (waiting.rows.length > 0) throw precondition('a change to this setting is already waiting for approval');
          }
          const { rows } = await client.query<ChangeRow>(
            `SELECT ${CHANGE_COLUMNS} FROM redaction_propose($1, $2, $3, $4, $5, $6, $7)`,
            [TENANT, audience, category, action, ...actor(caller)],
          );
          const change = rows[0] as ChangeRow;
          // What each audience is given changes only when the change applies (R-LEDGER).
          if (change.status === 'applied') await recordAll(client);
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
            await client.query<{ status: string; proposed_by_sub: string }>(`SELECT status, proposed_by_sub FROM redaction_change WHERE id = $1 AND tenant_id = $2`, [
              id,
              TENANT,
            ])
          ).rows[0];
          if (found === undefined) throw new ConnectError('change not found', Code.NotFound);
          if (found.status !== 'pending') throw precondition('this change is not waiting for approval');
          if (found.proposed_by_sub === caller.subject) throw new ConnectError('a second officer approves this change', Code.PermissionDenied);
          const { rows } = await client.query<ChangeRow>(`SELECT ${CHANGE_COLUMNS} FROM redaction_approve($1, $2, $3, $4)`, [id, ...actor(caller)]);
          await recordAll(client);
          return { change: changeMessage(rows[0] as ChangeRow) };
        });
      },
    });
  };
}
