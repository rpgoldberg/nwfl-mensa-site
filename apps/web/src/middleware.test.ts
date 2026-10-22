// src/middleware.ts with the flag from the stub of astro:env/server
// (vitest.config.ts): a full build, so every request goes through.
import { describe, expect, it, vi } from 'vitest';
import { onRequest } from './middleware';

describe('middleware', () => {
  it('is the gate for the build flag, here a full build', async () => {
    const next = vi.fn(async () => new Response('page'));
    const context = { url: new URL('https://nwflorida.us/sign-in'), rewrite: vi.fn() };
    const res = (await onRequest(context as never, next as never)) as Response;
    expect(await res.text()).toBe('page');
    expect(context.rewrite).not.toHaveBeenCalled();
  });
});
