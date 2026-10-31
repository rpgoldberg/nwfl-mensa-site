import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isHostOnlyCookie } from '../policy.mjs';
import {
  AUTH_COOKIE,
  SESSION_COOKIE,
  TRANSACTION_SECONDS,
  clearCookie,
  newSession,
  openTransaction,
  openValue,
  readSession,
  renewIfDue,
  sealTransaction,
  sealValue,
  sessionKey,
  sessionSetCookie,
  transactionSetCookie,
} from '../session.mjs';
import { TokenStore } from '../token-store.mjs';

const key = randomBytes(32);
const other = randomBytes(32);
const NOW = 1_800_000_000;

describe('sessionKey', () => {
  it('takes 32 bytes, base64, from config', () => {
    const k = sessionKey({ SESSION_KEY: key.toString('base64') });
    expect(k?.equals(key)).toBe(true);
  });

  it('has no default, and refuses a key of the wrong size', () => {
    expect(sessionKey({})).toBeUndefined();
    expect(() => sessionKey({ SESSION_KEY: randomBytes(16).toString('base64') })).toThrow(/32 bytes/);
    expect(() => sessionKey({ SESSION_KEY: 'not base64!' })).toThrow(/32 bytes/);
  });
});

describe('sealValue and openValue (AES-256-GCM)', () => {
  it('round-trips a value for one purpose only, and only with its key', () => {
    const sealed = sealValue({ a: 1 }, key, 'session');
    expect(sealed).toMatch(/^v1\.[\w-]+$/);
    expect(openValue(sealed, key, 'session')).toEqual({ a: 1 });
    expect(openValue(sealed, key, 'auth')).toBeUndefined();
    expect(openValue(sealed, other, 'session')).toBeUndefined();
  });

  it('refuses anything tampered with, truncated or malformed', () => {
    const sealed = sealValue({ a: 1 }, key, 'session');
    const body = Buffer.from(sealed.slice(3), 'base64url');
    body.writeUInt8(body.readUInt8(body.length - 1) ^ 1, body.length - 1);
    for (const bad of [`v1.${body.toString('base64url')}`, sealed.slice(0, 20), 'v2.abc', '', 'v1.', 'v1.!!!']) {
      expect(openValue(bad, key, 'session'), bad).toBeUndefined();
    }
  });

  it('never seals the same value to the same text twice (a fresh IV each time)', () => {
    expect(sealValue({ a: 1 }, key, 'session')).not.toBe(sealValue({ a: 1 }, key, 'session'));
  });
});

const claims = (groups: string[], name = 'Alex Sample') => ({ sub: 'user-1', name, groups });

describe('newSession (R10)', () => {
  it('holds who the person is and their nwfl- roles, and nothing else', () => {
    const s = newSession(claims(['nwfl-members', 'nwfl-officers', 'nwfl-office-president', 'fc-admins']), NOW);
    expect(s).toMatchObject({ sub: 'user-1', name: 'Alex Sample', member: true, officer: true, iat: NOW });
    expect(s.groups).toEqual(['nwfl-members', 'nwfl-officers', 'nwfl-office-president']);
    expect(s.sid).toMatch(/^[\w-]{22,}$/);
  });

  it('gives an officer 12 hours, and a member 30 days, renewed on use', () => {
    expect(newSession(claims(['nwfl-members', 'nwfl-officers']), NOW)).toMatchObject({ exp: NOW + 12 * 3600, sliding: false });
    expect(newSession(claims(['nwfl-members']), NOW)).toMatchObject({ exp: NOW + 30 * 86400, sliding: true });
  });

  it('a new sign-in is a new session id (rotation)', () => {
    expect(newSession(claims([]), NOW).sid).not.toBe(newSession(claims([]), NOW).sid);
  });

  it('keeps a display name short and printable, with a fallback', () => {
    expect(newSession(claims([], `A\u0007l${'x'.repeat(200)}`), NOW).name).toMatch(/^Alx{78}$/);
    expect(newSession({ sub: 's', preferred_username: 'jsample' }, NOW).name).toBe('jsample');
    expect(newSession({ sub: 's' }, NOW).name).toBe('Member');
  });

  it('refuses a groups claim that is not a list of strings, as the API refuses the token (CF-ISO-0 N3)', () => {
    for (const groups of ['nwfl-officers', { 0: 'nwfl-officers' }, ['nwfl-members', 42], ['nwfl-officers', null]]) {
      expect(() => newSession({ sub: 'u', groups }, NOW), JSON.stringify(groups)).toThrow('malformed groups claim');
    }
    expect(newSession({ sub: 'u' }, NOW).groups).toEqual([]);
  });

  it('keeps at most 20 groups, so the cookie stays small', () => {
    const many = Array.from({ length: 50 }, (_, i) => `nwfl-office-x${i}`);
    expect(newSession(claims(many), NOW).groups).toHaveLength(20);
  });
});

describe('newSession with a chapter group prefix (CF-ISO-0)', () => {
  it('with mensa-nwfl-, a mensa-nwfl-officers sign-in is an officer, held under the internal names', () => {
    const s = newSession(claims(['mensa-nwfl-members', 'mensa-nwfl-officers', 'mensa-nwfl-office-president']), NOW, 'mensa-nwfl-');
    expect(s).toMatchObject({ member: true, officer: true, exp: NOW + 12 * 3600, groups: ['nwfl-members', 'nwfl-officers', 'nwfl-office-president'] });
  });

  it('with mensa-nwfl-, a bare nwfl-officers sign-in and another chapter\'s are neither member nor officer', () => {
    expect(newSession(claims(['nwfl-members', 'nwfl-officers']), NOW, 'mensa-nwfl-')).toMatchObject({ member: false, officer: false, groups: [] });
    expect(newSession(claims(['mensa-other-members', 'mensa-other-officers']), NOW, 'mensa-nwfl-')).toMatchObject({ member: false, officer: false, groups: [] });
  });
});

describe('the session cookie', () => {
  it('is host-only, httpOnly and Lax, for as long as the session lasts', () => {
    const s = newSession(claims(['nwfl-members']), NOW);
    const cookie = sessionSetCookie(s, key, NOW);
    expect(cookie.startsWith(`${SESSION_COOKIE}=v1.`)).toBe(true);
    expect(cookie).toMatch(new RegExp(`; Path=/; Max-Age=${30 * 86400}; SameSite=Lax; HttpOnly; Secure$`));
    expect(isHostOnlyCookie(cookie)).toBe(true);
  });

  it('stays well under the 4 KB a browser keeps, at the largest session we make', () => {
    const big = newSession(claims(Array.from({ length: 50 }, (_, i) => `nwfl-office-${'y'.repeat(40)}${i}`), 'Z'.repeat(500)), NOW);
    expect(sessionSetCookie(big, key, NOW).length).toBeLessThan(3500);
  });

  it('is read back while its record is on the server, and refused once expired or under another key', () => {
    const s = newSession(claims(['nwfl-members']), NOW);
    const store = new TokenStore();
    store.put(s.sid, {}, s.exp);
    const header = `a=1; ${sessionSetCookie(s, key, NOW).split(';')[0]}`;
    expect(readSession(header, key, NOW + 10, store)).toEqual(s);
    expect(readSession(header, key, s.exp, store)).toBeUndefined();
    expect(readSession(header, other, NOW, store)).toBeUndefined();
    expect(readSession(header, undefined, NOW, store)).toBeUndefined();
    expect(readSession(undefined, key, NOW, store)).toBeUndefined();
  });

  it('is dead the moment its record goes: a copy of the cookie kept past sign-out reads as nobody', () => {
    const s = newSession(claims(['nwfl-members']), NOW);
    const store = new TokenStore();
    store.put(s.sid, {}, s.exp);
    const header = sessionSetCookie(s, key, NOW).split(';')[0];
    store.take(s.sid, NOW);
    expect(readSession(header, key, NOW, store)).toBeUndefined();
    expect(readSession(header, key, NOW, new TokenStore())).toBeUndefined();
  });

  it('is cleared with an expired host-only cookie', () => {
    expect(clearCookie(SESSION_COOKIE)).toBe(`${SESSION_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly; Secure`);
  });
});

describe('renewIfDue (members: renewed on use)', () => {
  it('renews a member session past half its life, with the same id', () => {
    const s = newSession(claims(['nwfl-members']), NOW);
    expect(renewIfDue(s, NOW + 86400)).toBeUndefined();
    const renewed = renewIfDue(s, NOW + 16 * 86400);
    expect(renewed).toMatchObject({ sid: s.sid, exp: NOW + 16 * 86400 + 30 * 86400 });
  });

  it('never renews an officer session', () => {
    const s = newSession(claims(['nwfl-members', 'nwfl-officers']), NOW);
    expect(renewIfDue(s, NOW + 11 * 3600)).toBeUndefined();
  });
});

describe('the sign-in transaction cookie', () => {
  const tx = { state: 's'.repeat(43), nonce: 'n'.repeat(43), verifier: 'v'.repeat(43), back: '/about' };

  it('is host-only, httpOnly and Lax, for ten minutes', () => {
    const cookie = transactionSetCookie(tx, key, NOW);
    expect(cookie.startsWith(`${AUTH_COOKIE}=v1.`)).toBe(true);
    expect(cookie).toMatch(new RegExp(`; Path=/; Max-Age=${TRANSACTION_SECONDS}; SameSite=Lax; HttpOnly; Secure$`));
    expect(isHostOnlyCookie(cookie)).toBe(true);
  });

  it('opens within ten minutes, and not after', () => {
    const sealed = sealTransaction(tx, key, NOW);
    expect(openTransaction(`${AUTH_COOKIE}=${sealed}`, key, NOW + TRANSACTION_SECONDS - 1)).toEqual({ ...tx, at: NOW });
    expect(openTransaction(`${AUTH_COOKIE}=${sealed}`, key, NOW + TRANSACTION_SECONDS)).toBeUndefined();
    expect(openTransaction(`${AUTH_COOKIE}=${sealed}`, key, NOW - 61)).toBeUndefined();
    expect(openTransaction(undefined, key, NOW)).toBeUndefined();
  });

  it('is never mistaken for a session, nor a session for it', () => {
    const sealed = sealTransaction(tx, key, NOW);
    expect(readSession(`${SESSION_COOKIE}=${sealed}`, key, NOW, { has: () => true })).toBeUndefined();
    const session = sessionSetCookie(newSession(claims([]), NOW), key, NOW).split(';')[0]!.split('=')[1];
    expect(openTransaction(`${AUTH_COOKIE}=${session}`, key, NOW)).toBeUndefined();
  });
});
