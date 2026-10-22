import { describe, expect, it, vi } from 'vitest';
import { makeOnRequest } from './compose';

const context = (path: string) => ({ url: new URL(`https://nwflorida.us${path}`), locals: {}, rewrite: vi.fn(async () => new Response('404 page', { status: 404 })) });

describe('makeOnRequest', () => {
  it('in a full build, reads the session on every page', async () => {
    const session = vi.fn(async (_c: unknown, next: () => Promise<Response>) => next());
    const onRequest = makeOnRequest(false, session as never);
    const res = (await onRequest(context('/about') as never, (async () => new Response('page')) as never)) as Response;
    expect(await res.text()).toBe('page');
    expect(session).toHaveBeenCalledOnce();
  });

  it('in the public-only build, never reads a session, even a valid one: no page shows anyone signed in', async () => {
    const session = vi.fn(async (_c: unknown, next: () => Promise<Response>) => next());
    const onRequest = makeOnRequest(true, session as never);
    const res = (await onRequest(context('/about') as never, (async () => new Response('page')) as never)) as Response;
    expect(await res.text()).toBe('page');
    const gated = context('/sign-out');
    await onRequest(gated as never, (async () => new Response('page')) as never);
    expect(gated.rewrite).toHaveBeenCalledWith('/404');
    expect(session).not.toHaveBeenCalled();
  });
});
