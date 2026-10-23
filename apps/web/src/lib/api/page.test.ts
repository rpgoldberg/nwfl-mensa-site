import { describe, expect, it } from 'vitest';
import { ApiUnavailable } from './client';
import { attempt, markUnavailable } from './page';

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
