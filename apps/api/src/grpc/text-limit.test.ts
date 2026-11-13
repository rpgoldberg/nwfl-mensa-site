// MARKUP-DOS round 2: the API caps every long free-text field at 48 KiB as a
// browser posts it (UTF-8, each line break CRLF), the same count as the web
// form's cap (apps/web/src/lib/editor/form.ts), so neither side can be skipped.
import { Code, ConnectError } from '@connectrpc/connect';
import { describe, expect, it } from 'vitest';
import { TEXT_MAX_BYTES, postedBytes, refuseLongText } from './text-limit.js';

describe('postedBytes', () => {
  it('counts UTF-8 bytes, and each line break as CRLF', () => {
    expect(TEXT_MAX_BYTES).toBe(49_152);
    expect(postedBytes('')).toBe(0);
    expect(postedBytes('abc')).toBe(3);
    expect(postedBytes('é')).toBe(2);
    expect(postedBytes('€')).toBe(3);
    expect(postedBytes('😀')).toBe(4);
    expect(postedBytes('a\nb')).toBe(4);
    expect(postedBytes('a\r\nb')).toBe(4);
    expect(postedBytes('a\rb')).toBe(4);
    expect(postedBytes('\r\n\r\n')).toBe(4);
  });
});

describe('refuseLongText', () => {
  const refusal = (fields: Record<string, string>): ConnectError => {
    try {
      refuseLongText(fields);
    } catch (error) {
      return error as ConnectError;
    }
    throw new Error('not refused');
  };

  it('lets through text of exactly 48 KiB as posted', () => {
    expect(() => refuseLongText({ body_markup: 'a'.repeat(TEXT_MAX_BYTES) })).not.toThrow();
    expect(() => refuseLongText({ body_markup: `${'a'.repeat(TEXT_MAX_BYTES - 2)}\n` })).not.toThrow();
    expect(() => refuseLongText({ body_markup: `${'a'.repeat(TEXT_MAX_BYTES - 2)}\r\n` })).not.toThrow();
    expect(() => refuseLongText({})).not.toThrow();
  });

  it('refuses one byte more, InvalidArgument with a plain reason naming the field', () => {
    const error = refusal({ title: 'ok', body_markup: 'a'.repeat(TEXT_MAX_BYTES + 1) });
    expect(error).toBeInstanceOf(ConnectError);
    expect(error.code).toBe(Code.InvalidArgument);
    expect(error.rawMessage).toBe('Too long: 49 KB of 48 KB in body_markup');
    expect(refusal({ detail: `${'a'.repeat(TEXT_MAX_BYTES - 1)}\n` }).rawMessage).toBe('Too long: 49 KB of 48 KB in detail');
    expect(refusal({ description: 'é'.repeat(30_000) }).rawMessage).toBe('Too long: 59 KB of 48 KB in description');
  });

  it('counts three- and four-byte characters at the boundary, past the short-text skip', () => {
    // 16,384 three-byte characters are exactly 48 KiB; one more is over, though its length is far under the cap.
    expect(() => refuseLongText({ detail: '€'.repeat(16_384) })).not.toThrow();
    expect(refusal({ detail: '€'.repeat(16_385) }).rawMessage).toBe('Too long: 49 KB of 48 KB in detail');
    expect(refusal({ detail: `${'€'.repeat(16_384)}a` }).rawMessage).toBe('Too long: 49 KB of 48 KB in detail');
    expect(() => refuseLongText({ detail: '😀'.repeat(12_288) })).not.toThrow();
    expect(refusal({ detail: '😀'.repeat(12_289) }).rawMessage).toBe('Too long: 49 KB of 48 KB in detail');
    expect(() => refuseLongText({ detail: '\u0800'.repeat(16_384) })).not.toThrow();
    expect(refusal({ detail: `${'\u0800'.repeat(16_383)}\r\n\n` }).rawMessage).toBe('Too long: 49 KB of 48 KB in detail');
  });
});
