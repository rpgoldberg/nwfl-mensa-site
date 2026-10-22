// ============================================================================
// Keyset paging for list RPCs. A page token is opaque to callers: base64url of
// [kind, ...key], where kind names the RPC that issued it, so a token from one
// list is refused by another. It carries only the sort key of the last row
// returned, never a filter: filters come from the request each time.
// ============================================================================
import { Code, ConnectError } from '@connectrpc/connect';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;

export function pageSize(requested: number): number {
  if (requested < 0) throw new ConnectError('page_size must not be negative', Code.InvalidArgument);
  return Math.min(requested === 0 ? DEFAULT_PAGE_SIZE : requested, MAX_PAGE_SIZE);
}

export function encodeToken(kind: string, key: string[]): string {
  return Buffer.from(JSON.stringify([kind, ...key])).toString('base64url');
}

/** The key of a token this RPC issued, or undefined for the first page. */
export function decodeToken(kind: string, token: string, arity: number): string[] | undefined {
  if (token === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    parsed = undefined;
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== arity + 1 ||
    parsed[0] !== kind ||
    !parsed.every((part) => typeof part === 'string')
  ) {
    throw new ConnectError('invalid page_token', Code.InvalidArgument);
  }
  return parsed.slice(1);
}
