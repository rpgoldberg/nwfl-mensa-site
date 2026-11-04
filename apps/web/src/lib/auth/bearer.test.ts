// A14 (S5a): which signed-in reader's token the site may forward to the API.
import { describe, expect, it } from 'vitest';
import { newSession } from '../../../server/session.mjs';
import { TokenStore } from '../../../server/token-store.mjs';
import { EXPIRY_MARGIN_SECONDS, readerFor, signInLink } from './bearer';
import type { Tokens } from './oidc';

const NOW = 1_800_000_000;

function signedIn(tokens: Tokens | undefined, groups: string[] = ['nwfl-members']) {
  const store = new TokenStore<Tokens>();
  const session = newSession({ sub: '0f8e2c4a-1b3d-4e5f-8a9b-0c1d2e3f4a5b', groups }, NOW - 60);
  if (tokens) store.put(session.sid, tokens, session.exp);
  return { session, deps: { tokens: store, now: () => NOW } };
}

describe('readerFor', () => {
  it('gives the access token of a valid session whose token has more than 30 s to live', () => {
    const { session, deps } = signedIn({ access_token: 'tok.en-1', expires_at: NOW + EXPIRY_MARGIN_SECONDS + 1 });
    expect(EXPIRY_MARGIN_SECONDS).toBe(30);
    expect(readerFor(session, deps)).toEqual({ reader: { bearer: 'tok.en-1', member: true }, lapsed: false });
  });

  it("carries whether the session's groups claim holds the members group (D4): an officers or pending claim alone is not a member's", () => {
    const cases: [string[], boolean][] = [
      [['nwfl-members'], true],
      [['nwfl-members', 'nwfl-officers'], true],
      [['nwfl-officers'], false],
      [['nwfl-officers', 'nwfl-office-president'], false],
      [['nwfl-pending'], false],
      [[], false],
    ];
    for (const [groups, member] of cases) {
      const { session, deps } = signedIn({ access_token: 'tok.en-1', expires_at: NOW + 3600 }, groups);
      expect(readerFor(session, deps), JSON.stringify(groups)).toEqual({ reader: { bearer: 'tok.en-1', member }, lapsed: false });
    }
  });

  it('reads the claim under the configured prefix only: another prefix\'s members group is no members group', () => {
    const store = new TokenStore<Tokens>();
    const session = newSession({ sub: '0f8e2c4a-1b3d-4e5f-8a9b-0c1d2e3f4a5b', groups: ['nwfl-members'] }, NOW - 60, 'mensa-nwfl-');
    store.put(session.sid, { access_token: 'tok', expires_at: NOW + 3600 }, session.exp);
    expect(readerFor(session, { tokens: store, now: () => NOW }).reader).toEqual({ bearer: 'tok', member: false });
    const ours = newSession({ sub: '0f8e2c4a-1b3d-4e5f-8a9b-0c1d2e3f4a5b', groups: ['mensa-nwfl-members'] }, NOW - 60, 'mensa-nwfl-');
    store.put(ours.sid, { access_token: 'tok', expires_at: NOW + 3600 }, ours.exp);
    expect(readerFor(ours, { tokens: store, now: () => NOW }).reader).toEqual({ bearer: 'tok', member: true });
  });

  it('fails closed on a session whose member flag is anything but true', () => {
    const { session, deps } = signedIn({ access_token: 'tok', expires_at: NOW + 3600 });
    for (const member of [undefined, 'true', 1, null]) expect(readerFor({ ...session, member } as never, deps).reader, String(member)).toEqual({ bearer: 'tok', member: false });
  });

  it('gives nothing to no session', () => {
    const { deps } = signedIn({ access_token: 'a', expires_at: NOW + 3600 });
    expect(readerFor(undefined, deps)).toEqual({ reader: undefined, lapsed: false });
  });

  it('gives nothing to a session with no record on the server (signed out, or the server restarted)', () => {
    const { session, deps } = signedIn(undefined);
    expect(readerFor(session, deps)).toEqual({ reader: undefined, lapsed: false });
  });

  it('gives nothing to a session that has itself expired', () => {
    const { session, deps } = signedIn({ access_token: 'a', expires_at: NOW + 3600 });
    expect(readerFor({ ...session, exp: NOW }, deps)).toEqual({ reader: undefined, lapsed: false });
  });

  it('says lapsed, and gives nothing, once the token has 30 s or less to live, or has expired', () => {
    for (const left of [EXPIRY_MARGIN_SECONDS, 1, 0, -3600]) {
      const { session, deps } = signedIn({ access_token: 'a', expires_at: NOW + left });
      expect(readerFor(session, deps), String(left)).toEqual({ reader: undefined, lapsed: true });
    }
  });

  it('fails closed on a token whose life is unknown, or that is empty: nothing is forwarded', () => {
    for (const tokens of [{ access_token: 'a' }, { access_token: 'a', expires_at: Number.NaN }, { access_token: '', expires_at: NOW + 3600 }] as Tokens[]) {
      const { session, deps } = signedIn(tokens);
      expect(readerFor(session, deps), JSON.stringify(tokens)).toEqual({ reader: undefined, lapsed: false });
    }
  });

  it('gives nothing for a token that is not one RFC 6750 b64token: it is treated as no token, not as a reader (S5a-1)', () => {
    for (const access_token of ['two words', 'tok.en\r\nCookie: a=b', 'é', '=abc', 'Bearer x']) {
      const { session, deps } = signedIn({ access_token, expires_at: NOW + 3600 });
      expect(readerFor(session, deps), JSON.stringify(access_token)).toEqual({ reader: undefined, lapsed: false });
    }
  });
});

describe('signInLink', () => {
  const key = Buffer.alloc(32, 1);
  const on = { setup: { enabled: true as const, config: {} as never }, key };

  it('is where Sign in is, back to the page and asking for a fresh sign-in, only when sign-in is set up and the build offers it', () => {
    expect(signInLink(on, false, '/news')).toBe('/sign-in?return=%2Fnews&again=1');
    expect(signInLink({ ...on, key: undefined }, false, '/news')).toBeUndefined();
    expect(signInLink({ setup: { enabled: false, reason: 'OIDC_ISSUER is not set' }, key }, false, '/news')).toBeUndefined();
    expect(signInLink(on, true, '/news')).toBeUndefined();
  });
});
