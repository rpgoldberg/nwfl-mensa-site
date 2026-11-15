// LG-N3: what sign-in logs. A provider's or a library's error text passes through the site redactor
// (fc-shared's secret shapes plus the site's own email pattern) before it is cut, every line is stamped
// (time, service, trace id), and "signed in" says two booleans and nothing about who.
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthConfig } from '../../../server/auth-config.mjs';
import { TokenStore } from '../../../server/token-store.mjs';
import { newTrace, runWithTrace } from '../../../server/trace.mjs';
import { ConsumedStates, beginSignIn, completeSignIn, signOut, type Deps } from './flow';

const key = randomBytes(32);
const NOW = 1_800_000_000;
const cfg: AuthConfig = {
  issuer: new URL('https://login.example.test/application/o/site/'),
  clientId: 'site',
  clientSecret: 'x',
  redirectUri: 'https://site.example.test/auth/callback',
  postLogoutRedirectUri: 'https://site.example.test/signed-out',
  scope: 'openid profile',
  allowInsecure: false,
  groupPrefix: 'nwfl-',
};
// Made-up: an address and a bearer token, the shapes an HTTP client's error can echo.
const EMAIL = 'pat.example@example.test';
const TOKEN = 'Bearer abcDEF123.ghi-jkl_mno';
const LEAKY = () => new Error(`request for ${EMAIL} failed with ${TOKEN}`);

function deps(over: Partial<Deps> = {}): Deps & { lines: Record<string, unknown>[]; raw: string[] } {
  const raw: string[] = [];
  return {
    setup: { enabled: true, config: cfg },
    key,
    now: () => NOW,
    oidc: {
      startSignIn: vi.fn(async () => ({ location: new URL('https://login.example.test/auth'), state: 'state-1', nonce: 'nonce-1', verifier: 'verifier-1' })),
      finishSignIn: vi.fn(async () => ({
        claims: { sub: 'user-1', name: 'Alex Sample', email: EMAIL, groups: ['nwfl-members', 'nwfl-officers'] },
        tokens: { access_token: 'access-1', id_token: 'id-1' },
      })),
      endSessionUrl: vi.fn(async () => new URL('https://login.example.test/end')),
    },
    tokens: new TokenStore(),
    consumed: new ConsumedStates(),
    log: (line: string) => raw.push(line),
    raw,
    get lines() {
      return raw.map((l) => JSON.parse(l) as Record<string, unknown>);
    },
    ...over,
  };
}

const jar = (setCookies: string[]) => setCookies.map((c) => c.split(';')[0]).filter((c) => !c!.endsWith('=')).join('; ');
const callback = async (d: Deps) => {
  const begun = await beginSignIn(d, { cookieHeader: undefined, back: '/about' });
  if (begun.kind !== 'redirect') throw new Error(begun.kind);
  return completeSignIn(d, { url: new URL('https://site.example.test/auth/callback?code=c&state=state-1'), cookieHeader: jar(begun.cookies) });
};
const expectClean = (raw: string[]) => {
  const all = raw.join('\n');
  expect(all).not.toContain(EMAIL);
  expect(all).not.toContain('abcDEF123');
  expect(all).toContain('[REDACTED]');
};

afterEach(() => {
  vi.doUnmock('../../../server/session.mjs');
  vi.resetModules();
});

describe('sign-in error text passes through the site redactor', () => {
  it('beginSignIn: the provider could not be reached', async () => {
    const d = deps();
    vi.mocked(d.oidc.startSignIn).mockRejectedValueOnce(LEAKY());
    expect((await beginSignIn(d, { cookieHeader: undefined, back: '/' })).kind).toBe('unavailable');
    expect(d.lines[0]).toMatchObject({ level: 'error', msg: 'the sign-in provider could not be reached' });
    expectClean(d.raw);
  });

  it('completeSignIn: the callback failed', async () => {
    const d = deps();
    vi.mocked(d.oidc.finishSignIn).mockRejectedValueOnce(LEAKY());
    expect((await callback(d)).kind).toBe('refused');
    expect(d.lines.at(-1)).toMatchObject({ level: 'warn', msg: 'sign-in refused', reason: 'failed' });
    expectClean(d.raw);
  });

  it('signOut: the provider could not be reached to end its session', async () => {
    const d = deps();
    vi.mocked(d.oidc.endSessionUrl).mockRejectedValueOnce(LEAKY());
    expect((await signOut(d, { cookieHeader: undefined })).location).toBe('/signed-out');
    expectClean(d.raw);
  });

  it('masks before it cuts, so the cut cannot leave half an address behind', async () => {
    const d = deps();
    vi.mocked(d.oidc.startSignIn).mockRejectedValueOnce(new Error(`${'x'.repeat(180)} ${EMAIL}`));
    await beginSignIn(d, { cookieHeader: undefined, back: '/' });
    expect(d.raw.join()).not.toMatch(/pat\.ex/);
  });

  it('depsFromEnv: a key that cannot be read', async () => {
    vi.resetModules();
    vi.doMock('../../../server/session.mjs', async (original) => ({
      ...(await original<object>()),
      sessionKey: () => {
        throw LEAKY();
      },
    }));
    const fresh = await import('./flow');
    const raw: string[] = [];
    expect(fresh.depsFromEnv({}, (line) => raw.push(line)).key).toBeUndefined();
    expect(JSON.parse(raw[0]!)).toMatchObject({ level: 'error', service: 'nwfl-web' });
    expectClean(raw);
  });
});

describe('sign-in lines are stamped', () => {
  it('with time, service and the request’s trace id', async () => {
    const d = deps();
    const trace = newTrace();
    await runWithTrace(trace, () => beginSignIn({ ...d, key: undefined }, { cookieHeader: undefined, back: '/' }));
    expect(d.lines[0]).toMatchObject({ level: 'error', msg: 'sign-in is not set up', service: 'nwfl-web', trace_id: trace.traceId, time: expect.any(String) });
  });
});

describe('"signed in" (flow.ts) logs two booleans and nothing about who', () => {
  it('officer and member, as booleans, and no name, subject, address or token', async () => {
    const d = deps();
    expect((await callback(d)).kind).toBe('redirect');
    const line = d.lines.find((l) => l['msg'] === 'signed in')!;
    expect(Object.keys(line).sort()).toEqual(['level', 'member', 'msg', 'officer', 'service', 'time']);
    expect(line['officer']).toBe(true);
    expect(line['member']).toBe(true);
    const all = d.raw.join('\n');
    for (const word of ['Alex', 'Sample', 'user-1', EMAIL, 'access-1', 'id-1']) expect(all).not.toContain(word);
  });

  it('false for a reader in neither group', async () => {
    const d = deps();
    vi.mocked(d.oidc.finishSignIn).mockResolvedValueOnce({ claims: { sub: 'user-2', groups: [] }, tokens: { access_token: 'a', id_token: 'i' } });
    await callback(d);
    expect(d.lines.find((l) => l['msg'] === 'signed in')).toMatchObject({ officer: false, member: false });
  });
});
