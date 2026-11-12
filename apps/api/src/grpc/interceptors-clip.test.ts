// MARKUP-DOS round 3 (the challenger's N1): a status message that echoes what the caller wrote is clipped to
// MESSAGE_MAX characters, so it always fits the HTTP/2 frame and the caller gets the real code.
import { Code, ConnectError } from '@connectrpc/connect';
import { describe, expect, it } from 'vitest';
import { MESSAGE_MAX, clipped } from './interceptors.js';

describe('clipped', () => {
  it('leaves a message of MESSAGE_MAX characters as it is', () => {
    const error = new ConnectError('a'.repeat(MESSAGE_MAX), Code.InvalidArgument);
    expect(clipped(error)).toBe(error);
  });

  it('cuts a longer one to MESSAGE_MAX characters, keeping the code and metadata, never splitting a pair', () => {
    const error = new ConnectError(`recurrence: ${'😀'.repeat(20_000)}`, Code.InvalidArgument, { 'x-probe': '1' });
    const cut = clipped(error);
    expect(cut.code).toBe(Code.InvalidArgument);
    expect(cut.metadata.get('x-probe')).toBe('1');
    expect([...cut.rawMessage]).toHaveLength(MESSAGE_MAX);
    expect(cut.rawMessage.endsWith('😀…')).toBe(true);
    expect(cut.cause).toBe(error);
  });
});
