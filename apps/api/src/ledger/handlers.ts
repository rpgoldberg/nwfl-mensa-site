// ============================================================================
// The publication ledger's two RPCs (R-LEDGER), officers only: LedgerAsOf and
// VerifyLedger on RedactionPolicyService. Neither returns content: a row's
// hashes, its manifest of ids, hashes and policy cells, and a verdict.
// ============================================================================
import { create } from '@bufbuild/protobuf';
import { timestampDate, timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from '@connectrpc/connect';
import type { Audience } from '../auth/caller.js';
import { callerOf } from '../auth/caller.js';
import { requireOfficer } from '../auth/roles.js';
import type { Db } from '../db/pool.js';
import { LedgerRowSchema, LedgerSubjectKind, RedactionAudience, type RedactionPolicyService } from '../gen/nwfl/mensa/v1/redaction_pb.js';
import { type LedgerKind, type LedgerRowData, ledgerAsOf, verifyLedger } from './ledger.js';

const KIND_IN = new Map<LedgerSubjectKind, LedgerKind>([
  [LedgerSubjectKind.CONTENT_VERSION, 'content_version'],
  [LedgerSubjectKind.STORED_FILE, 'stored_file'],
]);
const KIND_OUT: Record<LedgerKind, LedgerSubjectKind> = { content_version: LedgerSubjectKind.CONTENT_VERSION, stored_file: LedgerSubjectKind.STORED_FILE };
const AUDIENCE_IN = new Map<RedactionAudience, Audience>([
  [RedactionAudience.PUBLIC, 'public'],
  [RedactionAudience.MEMBERS, 'members'],
  [RedactionAudience.OFFICERS, 'officers'],
]);
const AUDIENCE_OUT: Record<Audience, RedactionAudience> = { public: RedactionAudience.PUBLIC, members: RedactionAudience.MEMBERS, officers: RedactionAudience.OFFICERS };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const invalid = (message: string): ConnectError => new ConnectError(message, Code.InvalidArgument);

const rowMessage = (row: LedgerRowData) =>
  create(LedgerRowSchema, {
    seq: BigInt(row.seq),
    subjectKind: KIND_OUT[row.subject_kind],
    subjectId: row.subject_id,
    audience: AUDIENCE_OUT[row.audience],
    outputSha256: row.output_sha256 ?? new Uint8Array(),
    inputsJson: JSON.stringify(row.inputs),
    passagesWithheld: row.passages_withheld,
    currentFrom: timestampFromDate(row.current_from),
    ...(row.current_to !== null ? { currentTo: timestampFromDate(row.current_to) } : {}),
    prevHash: row.prev_hash,
    rowHash: row.row_hash,
  });

export function ledgerHandlers(deps: { db: Db }): Partial<ServiceImpl<typeof RedactionPolicyService>> {
  const { db } = deps;
  const officer = (ctx: HandlerContext): void => requireOfficer(callerOf(ctx.values));
  return {
    ledgerAsOf: async (request, ctx) => {
      officer(ctx);
      const kind = KIND_IN.get(request.subjectKind);
      const audience = AUDIENCE_IN.get(request.audience);
      const subject = request.subjectId.trim().toLowerCase();
      if (kind === undefined) throw invalid('choose a subject kind');
      if (audience === undefined) throw invalid('choose an audience');
      if (!UUID.test(subject)) throw invalid('a subject id is a UUID');
      if (request.at === undefined) throw invalid('choose a time');
      const result = await ledgerAsOf(db, kind, subject, audience, timestampDate(request.at));
      return {
        ...(result.row !== null ? { row: rowMessage(result.row) } : {}),
        rerenderSha256: result.rerender ?? new Uint8Array(),
        matches: result.matches,
        detail: result.detail,
      };
    },

    verifyLedger: async (_request, ctx) => {
      officer(ctx);
      const result = await verifyLedger(db);
      return { intact: result.intact, rows: BigInt(result.rows), firstBreakSeq: BigInt(result.firstBreak ?? 0), problem: result.problem, headHash: result.head };
    },
  };
}
