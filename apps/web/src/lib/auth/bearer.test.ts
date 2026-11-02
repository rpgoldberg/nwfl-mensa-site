// A14 (S5a): which signed-in reader's token the site may forward to the API.
import { describe, expect, it } from 'vitest';
import { newSession } from '../../../server/session.mjs';
import { TokenStore } from '../../../server/token-store.mjs';
import { EXPIRY_MARGIN_SECONDS, readerFor, signInLink } from './bearer';
import type { Tokens } from './oidc';

const NOW = 1_800_000_000;

function signedIn(tokens: Tokens | undefined) {
  const store = new TokenStore<Tokens>();
  const session = newSession({ sub: '0f8e2c4a-1b3d-4e5f-8a9b-0c1d2e3f4a5b', groups: ['nwfl-members'] }, NOW - 60);
  if (tokens) store.put(session.sid, tokens, session.exp);
  return { session, deps: { tokens: store, now: () => NOW } };
}

describe('readerFor', () => {
  it('gives the access token of a valid session whose token has more than 30 s to live', () => {
    const { session, deps } = signedIn({ access_token: 'tok.en-1', expires_at: NOW + EXPIRY_MARGIN_SECONDS + 1 });
    expect(EXPIRY_MARGIN_SECONDS).toBe(30);
    expect(readerFor(session, deps)).toEqual({ reader: { bearer: 'tok.en-1' }, lapsed: false });
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
