import { describe, expect, it } from 'vitest';
import { GET, POST } from '../../src/pages/sign-out';

type Ctx = Parameters<typeof POST>[0];

describe('POST /sign-out', () => {
  it('expires the session, then goes on to the signed-out page or the provider, with a 303', async () => {
    const request = new Request('https://nwflorida.us/sign-out', { method: 'POST' });
    const res = (await POST({ request } as unknown as Ctx)) as Response;
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/signed-out');
    expect(res.headers.getSetCookie().map((c) => c.split('=')[0])).toEqual(['__Host-nwfl-session', '__Host-nwfl-auth']);
  });

  // SIGNOUT: in the installed app (Android Chrome, standalone) a 303 carrying Clear-Site-Data
  // "cache" left the tap doing nothing while the browser cleared. Every members-only answer is
  // private, no-store, so there is no cache to clear; and the site keeps nothing in storage.
  it('clears no site data: never "cache", nor "storage", nor any other directive', async () => {
    const request = new Request('https://nwflorida.us/sign-out', { method: 'POST' });
    const res = (await POST({ request } as unknown as Ctx)) as Response;
    expect(res.headers.get('clear-site-data') ?? '').not.toMatch(/"cache"/);
    expect(res.headers.has('clear-site-data')).toBe(false);
  });
});

describe('GET /sign-out', () => {
  it('never signs anyone out: only a POST does', async () => {
    const res = (await GET({} as unknown as Ctx)) as Response;
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });
});
