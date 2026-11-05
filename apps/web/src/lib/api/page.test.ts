import { describe, expect, it } from 'vitest';
import { ApiUnavailable } from './client';
import { cacheControl } from '../../../server/policy.mjs';
import { attempt, markUnavailable, signInFirst } from './page';

describe('attempt', () => {
  it('gives the value of a read that worked', async () => {
    expect(await attempt(() => Promise.resolve(3))).toEqual({ ok: true, value: 3 });
  });

  it('gives "not ok" for an API that is unavailable, so the page can say so', async () => {
    expect(await attempt(() => Promise.reject(new ApiUnavailable('GetRoster')))).toEqual({ ok: false });
  });

  it('lets any other error through: a bug is not an outage', async () => {
    await expect(attempt(() => Promise.reject(new TypeError('bug')))).rejects.toBeInstanceOf(TypeError);
  });
});

describe('markUnavailable', () => {
  it('makes the response a 503 that nothing stores', () => {
    const response = { status: 200, headers: new Headers({ 'Cache-Control': 'public, max-age=60' }) };
    markUnavailable(response);
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('signInFirst (W-SIGNUP fix 1, NOTE-7)', () => {
  it('sends a signed-out reader to sign in with a 303 that no shared cache keeps', () => {
    const res = signInFirst('/sign-in?return=%2Faccount');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/sign-in?return=%2Faccount');
    // private: server/policy.mjs then answers it private, no-store.
    expect(res.headers.get('cache-control')).toBe('private');
    expect(cacheControl({ path: '/account', cookieHeader: undefined, status: 303, setsCookie: false, handler: res.headers.get('cache-control') ?? undefined })).toBe('private, no-store');
  });
});
