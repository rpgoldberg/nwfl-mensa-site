// Page tokens: refused unless every part is what this RPC issued, so nothing a
// caller makes up reaches the database (STACK-FIX: a date Postgres could not
// read was INTERNAL).
import { Code } from '@connectrpc/connect';
import { describe, expect, it } from 'vitest';
import { decodeToken, encodeToken, isIsoDate, isMicroTimestamp, isUuid } from './paging.js';

const forged = (parts: unknown[]): string => Buffer.from(JSON.stringify(parts)).toString('base64url');
const ID = '7a0d3d4e-1f1b-4c55-9a51-0b8f1c6a2e01';

describe('decodeToken', () => {
  it('returns the key of a token this list issued', () => {
    expect(decodeToken('items', encodeToken('items', ['2026-10-05T12:00:00.123456Z', ID]), [isMicroTimestamp, isUuid])).toEqual(['2026-10-05T12:00:00.123456Z', ID]);
    expect(decodeToken('items', '', [isMicroTimestamp, isUuid])).toBeUndefined();
  });

  it.each([
    ['not base64 JSON', 'garbage'],
    ['another list', forged(['editions', '2026-10-05T12:00:00.123456Z', ID])],
    ['too few parts', forged(['items', ID])],
    ['a number for a part', forged(['items', 5, ID])],
    ['milliseconds only', forged(['items', '2026-10-05T12:00:00.123Z', ID])],
    ['a day that does not exist', forged(['items', '2026-02-30T12:00:00.000000Z', ID])],
    ['an hour that does not exist', forged(['items', '2026-02-03T24:00:00.000000Z', ID])],
    ['year zero', forged(['items', '0000-01-01T00:00:00.000000Z', ID])],
    ['a bad id', forged(['items', '2026-10-05T12:00:00.123456Z', 'x'])],
  ])('refuses %s with INVALID_ARGUMENT', (_label, token) => {
    expect(() => decodeToken('items', token, [isMicroTimestamp, isUuid])).toThrow(expect.objectContaining({ code: Code.InvalidArgument }));
  });

  it('reads a date only when it is a real calendar date', () => {
    expect(isIsoDate('2026-10-01')).toBe(true);
    expect(isIsoDate('2026-13-45')).toBe(false);
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('October')).toBe(false);
  });
});
