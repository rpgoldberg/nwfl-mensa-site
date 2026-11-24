// OFFICER-VERIFY: the officer area's one gate. A signed-in person whose officer tools wait for their
// membership check (the API's GetMyAccount says AWAITING_CHECK) is sent to /account, where the sign-up
// form and the notice are, from every page under /officer-area. Anyone else goes on to the page, which
// still checks its own groups, and the API decides again on every call.
import { describe, expect, it, vi } from 'vitest';
import { newSession } from '../../../server/session.mjs';
import { TokenStore } from '../../../server/token-store.mjs';
import type { MembershipApi, MyStanding } from '../api/membership';
import type { Tokens } from './oidc';
import { afterSession, makeOfficerGate } from './officer-gate';

const NOW = 1_800_000_000;

function setup(answer: () => Promise<MyStanding>, options: { signedIn?: boolean; token?: boolean; api?: boolean } = {}) {
  const tokens = new TokenStore<Tokens>();
  const session = newSession({ sub: 'u', name: 'Jordan Example', groups: ['nwfl-officers'] }, NOW - 60);
  if (options.token !== false) tokens.put(session.sid, { access_token: 'tok.en', expires_at: NOW + 3600 } as Tokens, session.exp);
  const asked: string[] = [];
  const api = { getMyStanding: (as: { bearer: string }) => (asked.push(as.bearer), answer()) } as unknown as MembershipApi;
  const gate = makeOfficerGate(() => ({ api: options.api === false ? undefined : api, readerDeps: { tokens, now: () => NOW } }));
  const visit = async (path: string) => {
    const context = { request: new Request(`https://nwflorida.us${path}`), locals: { session: options.signedIn === false ? undefined : session } };
    const next = vi.fn(async () => new Response('page'));
    const response = (await gate(context as never, next as never)) as Response;
    return { response, next };
  };
  return { visit, asked };
}

describe('makeOfficerGate', () => {
  it('sends a person whose officer tools wait for the check to /account, from every officer-area page', async () => {
    const { visit, asked } = setup(() => Promise.resolve({ officerTools: 'awaiting_check' }));
    for (const path of ['/officer-area', '/officer-area/', '/officer-area/sign-ups', '/officer-area/news/new?x=1']) {
      const { response, next } = await visit(path);
      expect(response.status, path).toBe(303);
      expect(response.headers.get('location')).toBe('/account');
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(next).not.toHaveBeenCalled();
    }
    expect(asked).toEqual(['tok.en', 'tok.en', 'tok.en', 'tok.en']);
  });

  it('lets open tools, no tools, and an API that cannot say go on to the page', async () => {
    for (const answer of [() => Promise.resolve<MyStanding>({ officerTools: 'open' }), () => Promise.resolve<MyStanding>({ officerTools: 'none' }), () => Promise.reject(new Error('down'))]) {
      const { visit } = setup(answer);
      const { response, next } = await visit('/officer-area/sign-ups');
      expect(await response.text()).toBe('page');
      expect(next).toHaveBeenCalledOnce();
    }
  });

  it('never asks the API outside the officer area, for nobody signed in, with no live token, or with no API', async () => {
    const answer = () => Promise.resolve<MyStanding>({ officerTools: 'awaiting_check' });
    const outside = setup(answer);
    for (const path of ['/', '/account', '/officer-areas', '/news/officer-area']) expect(await (await outside.visit(path)).response.text()).toBe('page');
    expect(outside.asked).toEqual([]);
    for (const options of [{ signedIn: false }, { token: false }, { api: false }]) {
      const { visit, asked } = setup(answer, options);
      expect(await (await visit('/officer-area')).response.text()).toBe('page');
      expect(asked).toEqual([]);
    }
  });
});

describe('afterSession', () => {
  it('runs the gate after the session step, inside it, then the page', async () => {
    const order: string[] = [];
    const session = vi.fn(async (_c: unknown, next: () => Promise<Response>) => {
      order.push('session');
      return next();
    });
    const gate = vi.fn(async (_c: unknown, next: () => Promise<Response>) => {
      order.push('gate');
      return next();
    });
    const handler = afterSession(session as never, gate as never);
    const response = (await handler({} as never, (async () => (order.push('page'), new Response('page'))) as never)) as Response;
    expect(await response.text()).toBe('page');
    expect(order).toEqual(['session', 'gate', 'page']);
  });
});
