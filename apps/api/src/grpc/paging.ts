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

/** The key of a token this RPC issued, or undefined for the first page. Each part must pass its check, so nothing made up reaches the database. */
export function decodeToken(kind: string, token: string, checks: ReadonlyArray<(part: string) => boolean>): string[] | undefined {
  if (token === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    parsed = undefined;
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== checks.length + 1 ||
    parsed[0] !== kind ||
    !parsed.slice(1).every((part, index) => typeof part === 'string' && (checks[index] as (part: string) => boolean)(part))
  ) {
    throw new ConnectError('invalid page_token', Code.InvalidArgument);
  }
  return parsed.slice(1) as string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isUuid = (value: string): boolean => UUID.test(value);

/** A real calendar date, YYYY-MM-DD, year 1000 or later. */
export function isIsoDate(value: string): boolean {
  if (!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
}

/** A UTC instant to the microsecond, as Postgres keeps it: YYYY-MM-DDTHH:MM:SS.ffffffZ. */
export function isMicroTimestamp(value: string): boolean {
  if (!/^[1-9]\d{3}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value)) return false;
  const time = Date.parse(`${value.slice(0, 19)}Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19);
}
