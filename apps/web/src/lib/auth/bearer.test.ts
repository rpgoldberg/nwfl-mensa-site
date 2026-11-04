// A14 (S5a): which signed-in reader's token the site may forward to the API.
import { describe, expect, it } from 'vitest';
import { newSession } from '../../../server/session.mjs';
import { TokenStore } from '../../../server/token-store.mjs';
import { EXPIRY_MARGIN_SECONDS, readerFor, signInLink } from './bearer';
import type { Tokens } from './oidc';

const NOW = 1_800_000_000;

function signedIn(tokens: Tokens | undefined, groups: string[] = ['nwfl-users']) {
  const store = new TokenStore<Tokens>();
  const session = newSession({ sub: '0f8e2c4a-1b3d-4e5f-8a9b-0c1d2e3f4a5b', groups }, NOW - 60);
  if (tokens) store.put(session.sid, tokens, session.exp);
  return { session, deps: { tokens: store, now: () => NOW } };
}

describe('readerFor', () => {
  it('gives the access token of a valid session whose token has more than 30 s to live', () => {
    const { session, deps } = signedIn({ access_token: 'tok.en-1', expires_at: NOW + EXPIRY_MARGIN_SECONDS + 1 });
    expect(EXPIRY_MARGIN_SECONDS).toBe(30);
    expect(readerFor(session, deps)).toEqual({ reader: { bearer: 'tok.en-1', enrolee: true }, lapsed: false });
  });

  it("carries whether the session's groups claim holds an nwfl enrolee group (D4, AC6 b): nwfl-users or nwfl-members; an officers or pending claim alone is not one", () => {
    const cases: [string[], boolean][] = [
      [['nwfl-users'], true],
      [['nwfl-members'], true],
      [['nwfl-users', 'nwfl-officers'], true],
      [['nwfl-members', 'nwfl-officers'], true],
      [['nwfl-officers'], false],
      [['nwfl-officers', 'nwfl-office-president'], false],
      [['nwfl-pending'], false],
      [[], false],
    ];
    for (const [groups, enrolee] of cases) {
      const { session, deps } = signedIn({ access_token: 'tok.en-1', expires_at: NOW + 3600 }, groups);
      expect(readerFor(session, deps), JSON.stringify(groups)).toEqual({ reader: { bearer: 'tok.en-1', enrolee }, lapsed: false });
    }
  });

  it("reads the claim under the configured prefix only: another prefix's enrolee group is none", () => {
    const store = new TokenStore<Tokens>();
    const readerOf = (groups: string[]) => {
      const session = newSession({ sub: '0f8e2c4a-1b3d-4e5f-8a9b-0c1d2e3f4a5b', groups }, NOW - 60, 'mensa-nwfl-');
      store.put(session.sid, { access_token: 'tok', expires_at: NOW + 3600 }, session.exp);
      return readerFor(session, { tokens: store, now: () => NOW }).reader;
    };
    for (const bare of [['nwfl-members'], ['nwfl-users']]) expect(readerOf(bare), String(bare)).toEqual({ bearer: 'tok', enrolee: false });
    for (const ours of [['mensa-nwfl-members'], ['mensa-nwfl-users']]) expect(readerOf(ours), String(ours)).toEqual({ bearer: 'tok', enrolee: true });
  });

  it('reads no near miss of either enrolee group as one: case, spaces, invisible or look-alike letters, another prefix, a group past the 20th', () => {
    const readerOf = (groups: unknown, prefix?: string) => {
      const store = new TokenStore<Tokens>();
      const session = newSession({ sub: 'x', groups } as never, NOW - 60, prefix);
      store.put(session.sid, { access_token: 'tok', expires_at: NOW + 3600 }, session.exp);
      return readerFor(session, { tokens: store, now: () => NOW }).reader;
    };
    for (const role of ['members', 'users']) {
      const near: [string, unknown, string?][] = [
        ['upper', [`NWFL-${role.toUpperCase()}`]],
        ['mixed', [`nwfl-${role[0]!.toUpperCase()}${role.slice(1)}`]],
        ['trailing space', [`nwfl-${role} `]],
        ['leading space', [` nwfl-${role}`]],
        ['zero-width', [`nwfl-${role}\u200b`]],
        ['other prefix', [`mensa-nwfl-${role}`]],
        ['bare under a configured prefix', [`nwfl-${role}`], 'mensa-nwfl-'],
        ['singular', [`nwfl-${role.slice(0, -1)}`]],
        ['past the 20th', [...Array.from({ length: 20 }, (_, i) => `nwfl-g${i}`), `nwfl-${role}`]],
        ['NUL', [`nwfl-${role}\u0000`]],
        ['homoglyph', [`nwfl-${role.replace('e', '\u0435')}`]],
        ['another chapter', [`mensa-other-${role}`], 'mensa-nwfl-'],
      ];
      for (const [name, groups, prefix] of near) expect(readerOf(groups, prefix)?.enrolee, `${role}: ${name}`).toBe(false);
      expect(readerOf([`nwfl-${role}`, `nwfl-${role}`])?.enrolee, `${role}: duplicated`).toBe(true);
    }
    for (const groups of [[], undefined, ['nwfl-officers', 'nwfl-officers']]) expect(readerOf(groups)?.enrolee, JSON.stringify(groups)).toBe(false);
  });

  it('fails closed on a session whose enrolee flag is anything but true', () => {
    const { session, deps } = signedIn({ access_token: 'tok', expires_at: NOW + 3600 });
    for (const enrolee of [undefined, 'true', 1, null]) expect(readerFor({ ...session, enrolee } as never, deps).reader, String(enrolee)).toEqual({ bearer: 'tok', enrolee: false });
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
    for (const groups of [['nwfl-users'], ['nwfl-members']]) {
      for (const left of [EXPIRY_MARGIN_SECONDS, 1, 0, -3600]) {
        const { session, deps } = signedIn({ access_token: 'a', expires_at: NOW + left }, groups);
        expect(readerFor(session, deps), `${String(groups)} ${left}`).toEqual({ reader: undefined, lapsed: true });
      }
    }
  });

  it('never says lapsed to a session with no nwfl enrolee group: its token is never sent, so the page says the account has no member access', () => {
    for (const groups of [['nwfl-officers'], ['nwfl-pending'], []]) {
      for (const left of [EXPIRY_MARGIN_SECONDS, 0, -3600]) {
        const { session, deps } = signedIn({ access_token: 'a', expires_at: NOW + left }, groups);
        expect(readerFor(session, deps), `${String(groups)} ${left}`).toEqual({ reader: { bearer: 'a', enrolee: false }, lapsed: false });
      }
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
