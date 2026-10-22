import { describe, expect, it } from 'vitest';
import { readCookie } from '../cookies.mjs';
import { SESSION_COOKIE, hasCookie } from '../policy.mjs';
import { SIZE_COOKIE, readPrefs } from '../prefs.mjs';

describe('readCookie (one parser for every cookie the site reads)', () => {
  it('gives the value of a name, first one wins, and nothing for a missing header', () => {
    expect(readCookie('a=1; b=2; a=3', 'a')).toBe('1');
    expect(readCookie('a=1', 'b')).toBeUndefined();
    expect(readCookie(undefined, 'a')).toBeUndefined();
    expect(readCookie(null, 'a')).toBeUndefined();
  });

  it('is what hasCookie and readPrefs see, so the two never disagree', () => {
    for (const header of [`${SIZE_COOKIE} =4; ${SESSION_COOKIE} =x`, `\u00a0${SIZE_COOKIE}=4; \u00a0${SESSION_COOKIE}=x`, `__HOST-nwfl-size=4; __HOST-nwfl-session=x`]) {
      expect(hasCookie(header, SESSION_COOKIE), header).toBe(readCookie(header, SESSION_COOKIE) !== undefined);
      expect(readPrefs(header).size === 4, header).toBe(readCookie(header, SIZE_COOKIE) === '4');
    }
  });
});
