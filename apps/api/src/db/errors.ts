// ============================================================================
// A database refusal as a gRPC status, with a FIXED message per kind. The
// driver's message routinely quotes the refused row ("Key (slug)=(...)"), so
// it never reaches the caller or the log. Anything not listed passes through
// unchanged, and the access log masks it as INTERNAL.
// ============================================================================
import { Code, ConnectError } from '@connectrpc/connect';

const BY_SQLSTATE: Record<string, [Code, string]> = {
  '23505': [Code.AlreadyExists, 'already exists'],
  '23503': [Code.FailedPrecondition, 'refers to something missing or still in use'],
  '23514': [Code.InvalidArgument, 'a value is not allowed'],
  '23502': [Code.InvalidArgument, 'a required value is missing'],
  '22P02': [Code.InvalidArgument, 'a value has the wrong form'],
  '22001': [Code.InvalidArgument, 'a value is too long'],
  '22007': [Code.InvalidArgument, 'a date or time has the wrong form'],
  '22008': [Code.InvalidArgument, 'a date or time is out of range'],
  // object_not_in_prerequisite_state: the workflow triggers (0003, 0007).
  '55000': [Code.FailedPrecondition, 'not allowed in this state'],
  '40001': [Code.Aborted, 'conflict, try again'],
  '40P01': [Code.Aborted, 'conflict, try again'],
};

export function dbError(error: unknown): unknown {
  if (error instanceof ConnectError) return error;
  const sqlstate = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  const mapped = typeof sqlstate === 'string' ? BY_SQLSTATE[sqlstate] : undefined;
  return mapped === undefined ? error : new ConnectError(mapped[1], mapped[0]);
}
