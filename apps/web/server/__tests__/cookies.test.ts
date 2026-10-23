import { describe, expect, it } from 'vitest';
import { readCookie } from '../cookies.mjs';
import { SESSION_COOKIE, hasCookie } from '../policy.mjs';
import { SIZES, SIZE_COOKIE, readPrefs } from '../prefs.mjs';

describe('readCookie (one parser for every cookie the site reads)', () => {
  it('gives the value of a name, first one wins, and nothing for a missing header', () => {
    expect(readCookie('a=1; b=2; a=3', 'a')).toBe('1');
    expect(readCookie('a=1', 'b')).toBeUndefined();
    expect(readCookie(undefined, 'a')).toBeUndefined();
    expect(readCookie(null, 'a')).toBeUndefined();
  });

  it('is what hasCookie and readPrefs see, so the two never disagree', () => {
    const size = SIZES[5];
    for (const header of [`${SIZE_COOKIE} =${size}; ${SESSION_COOKIE} =x`, `\u00a0${SIZE_COOKIE}=${size}; \u00a0${SESSION_COOKIE}=x`, `__HOST-nwfl-size=${size}; __HOST-nwfl-session=x`]) {
      expect(hasCookie(header, SESSION_COOKIE), header).toBe(readCookie(header, SESSION_COOKIE) !== undefined);
      expect(readPrefs(header).size === size, header).toBe(readCookie(header, SIZE_COOKIE) === String(size));
    }
  });
});
