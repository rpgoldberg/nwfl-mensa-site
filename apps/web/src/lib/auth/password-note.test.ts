import { describe, expect, it } from 'vitest';
import { PASSWORD_NOTE } from './password-note';

describe('the password note (S2)', () => {
  it('says, in plain words, which password to use, and never asks for the American Mensa one', () => {
    expect(PASSWORD_NOTE).toEqual({ lead: 'This is not your American Mensa password.', rest: 'Use the password you set for this site.' });
    expect(`${PASSWORD_NOTE.lead} ${PASSWORD_NOTE.rest}`).toBe('This is not your American Mensa password. Use the password you set for this site.');
    expect(Object.isFrozen(PASSWORD_NOTE)).toBe(true);
  });
});
