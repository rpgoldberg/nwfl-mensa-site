// Database refusals become gRPC codes with FIXED messages: a constraint's own
// message can echo the row it refused, so it never reaches the caller.
import { Code, ConnectError } from '@connectrpc/connect';
import { describe, expect, it } from 'vitest';
import { dbError } from './errors.js';

const pgError = (code: string): Error => Object.assign(new Error(`duplicate key value (slug)=(secret-slug) code ${code}`), { code });

describe('dbError', () => {
  it.each([
    ['23505', Code.AlreadyExists],
    ['23503', Code.FailedPrecondition],
    ['23514', Code.InvalidArgument],
    ['23502', Code.InvalidArgument],
    ['22P02', Code.InvalidArgument],
    ['22001', Code.InvalidArgument],
    ['22007', Code.InvalidArgument],
    ['22008', Code.InvalidArgument],
    ['55000', Code.FailedPrecondition],
    ['40001', Code.Aborted],
    ['40P01', Code.Aborted],
  ])('maps SQLSTATE %s, with a fixed message', (sqlstate, code) => {
    const mapped = dbError(pgError(sqlstate));
    expect(mapped).toBeInstanceOf(ConnectError);
    expect(mapped).toMatchObject({ code });
    expect((mapped as ConnectError).rawMessage).not.toContain('secret-slug');
  });

  it('passes a ConnectError and an unknown failure through untouched', () => {
    const connect = new ConnectError('mine', Code.NotFound);
    expect(dbError(connect)).toBe(connect);
    const other = pgError('XX000');
    expect(dbError(other)).toBe(other);
    expect(dbError('a string')).toBe('a string');
  });
});
