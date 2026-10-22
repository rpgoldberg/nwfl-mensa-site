import { describe, expect, it, vi } from 'vitest';
import { SIGN_IN_PATHS, isSignInPath, makeGate } from './access';

describe('isSignInPath', () => {
  it('covers sign-in, every OIDC route under /auth and the officer area', () => {
    expect(SIGN_IN_PATHS).toEqual(['/sign-in', '/auth', '/officer-area']);
    for (const path of ['/sign-in', '/sign-in/', '/auth', '/auth/callback', '/auth/sign-out', '/officer-area', '/officer-area/new', '/officer-area/queue']) {
      expect(isSignInPath(path), path).toBe(true);
    }
  });

  it('leaves the public pages alone, the public roster included', () => {
    for (const path of ['/', '/officers', '/officer-areas', '/authors', '/sign-in-help', '/about', '/prefs']) {
      expect(isSignInPath(path), path).toBe(false);
    }
  });
});

describe('makeGate (the public-only build flag)', () => {
  function call(publicOnly: boolean, path: string) {
    const next = vi.fn(async () => new Response('page'));
    const rewrite = vi.fn(async () => new Response('not found', { status: 404 }));
    const context = { url: new URL(`https://nwfl-canary.example.org${path}`), rewrite };
    const result = makeGate(publicOnly)(context as never, next as never) as Promise<Response>;
    return { result, next, rewrite };
  }

  it('answers every sign-in route with the 404 page when sign-in is off', async () => {
    for (const path of ['/sign-in', '/auth/callback', '/officer-area/new']) {
      const { result, next, rewrite } = call(true, path);
      expect((await result).status, path).toBe(404);
      expect(rewrite).toHaveBeenCalledWith('/404');
      expect(next).not.toHaveBeenCalled();
    }
  });

  it('serves the public pages as usual when sign-in is off', async () => {
    const { result, next } = call(true, '/officers');
    expect(await (await result).text()).toBe('page');
    expect(next).toHaveBeenCalledOnce();
  });

  it('changes nothing in a full build', async () => {
    const { result, next, rewrite } = call(false, '/sign-in');
    expect(await (await result).text()).toBe('page');
    expect(next).toHaveBeenCalledOnce();
    expect(rewrite).not.toHaveBeenCalled();
  });
});
