import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE, newSession, readSession, sessionSetCookie } from '../../../server/session.mjs';
import { TokenStore } from '../../../server/token-store.mjs';
import { makeSessionStep } from './middleware';

const key = randomBytes(32);
const NOW = 1_800_000_000;
let tokens = new TokenStore();

function run(cookie: string | undefined, now = NOW, response = new Response('page')) {
  const context = { request: new Request('https://nwflorida.us/', { headers: cookie ? { cookie } : {} }), locals: {} as App.Locals };
  const next = vi.fn(async () => response);
  return { result: makeSessionStep(() => ({ key, now: () => now, tokens }))(context as never, next as never) as Promise<Response>, context };
}

/** A signed-in session's cookie, its record on the server. */
function cookieFor(groups: string[]) {
  const session = newSession({ sub: 'u', name: 'Jordan Example', groups }, NOW);
  tokens.put(session.sid, { id_token: 'id' }, session.exp);
  return sessionSetCookie(session, key, NOW).split(';')[0] as string;
}
const sidOf = (cookie: string) => readSession(cookie, key, NOW, tokens)!.sid;

describe('makeSessionStep', () => {
  beforeEach(() => {
    tokens = new TokenStore();
  });

  it('reads a cookie whose record is gone (signed out, or the server restarted) as nobody', async () => {
    const cookie = cookieFor(['nwfl-members']);
    tokens.take(sidOf(cookie), NOW);
    const { result, context } = run(cookie);
    await result;
    expect(context.locals.session).toBeUndefined();
  });

  it('puts the signed-in reader on the request for the page', async () => {
    const { result, context } = run(cookieFor(['nwfl-members']));
    await result;
    expect(context.locals.session).toMatchObject({ name: 'Jordan Example', member: true });
  });

  it('leaves the request anonymous with no cookie, a bad one, or no key', async () => {
    for (const cookie of [undefined, `${SESSION_COOKIE}=v1.forged`]) {
      const { result, context } = run(cookie);
      await result;
      expect(context.locals.session).toBeUndefined();
    }
    const context = { request: new Request('https://nwflorida.us/', { headers: { cookie: cookieFor([]) } }), locals: {} as App.Locals };
    await makeSessionStep(() => ({ key: undefined, now: () => NOW, tokens }))(context as never, (async () => new Response('x')) as never);
    expect(context.locals.session).toBeUndefined();
  });

  it('renews a member session past half its life, on the page that sees it', async () => {
    const { result } = run(cookieFor(['nwfl-members']), NOW + 20 * 86400);
    const res = await result;
    const renewed = readSession(res.headers.get('set-cookie')!.split(';')[0], key, NOW + 20 * 86400, tokens);
    expect(renewed?.exp).toBe(NOW + 50 * 86400);
    // Its record lives as long: the renewed session is not cut off at the first one's end.
    expect(tokens.has(renewed!.sid, NOW + 45 * 86400)).toBe(true);
  });

  it('renews on a redirect too, whose headers cannot be changed in place', async () => {
    const { result } = run(cookieFor(['nwfl-members']), NOW + 20 * 86400, Response.redirect('https://nwflorida.us/about', 303));
    const res = await result;
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://nwflorida.us/about');
    expect(res.headers.get('set-cookie')).toMatch(new RegExp(`^${SESSION_COOKIE}=v1\\.`));
  });

  it('leaves a page being prerendered alone: there is no reader at build time', async () => {
    const context = {
      isPrerendered: true,
      get request(): Request {
        throw new Error('headers are not available while prerendering');
      },
      locals: {} as App.Locals,
    };
    const res = await makeSessionStep(() => ({ key, now: () => NOW, tokens }))(context as never, (async () => new Response('built')) as never);
    expect(await (res as Response).text()).toBe('built');
  });

  it('never renews over a page that sets the session itself: sign-out expiring it, or a sign-in rotating it', async () => {
    const later = NOW + 20 * 86400;
    for (const own of [`${SESSION_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly; Secure`, `${SESSION_COOKIE}=v1.new; Path=/; Max-Age=60; SameSite=Lax; HttpOnly; Secure`]) {
      const page = new Response(null, { status: 303, headers: [['Location', '/'], ['Set-Cookie', '__Host-nwfl-auth=; Path=/; Max-Age=0'], ['Set-Cookie', own]] });
      const res = await run(cookieFor(['nwfl-members']), later, page).result;
      expect(res.headers.getSetCookie().filter((c) => c.startsWith(`${SESSION_COOKIE}=`))).toEqual([own]);
    }
  });

  it('sets nothing for a fresh session or an officer', async () => {
    expect((await run(cookieFor(['nwfl-members']), NOW + 86400).result).headers.get('set-cookie')).toBeNull();
    expect((await run(cookieFor(['nwfl-members', 'nwfl-officers']), NOW + 11 * 3600).result).headers.get('set-cookie')).toBeNull();
  });
});
