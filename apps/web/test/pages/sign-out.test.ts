import { describe, expect, it } from 'vitest';
import { GET, POST } from '../../src/pages/sign-out';

type Ctx = Parameters<typeof POST>[0];

describe('POST /sign-out', () => {
  it('expires the session, clears cache and storage, then goes on to the signed-out page or the provider', async () => {
    const request = new Request('https://nwflorida.us/sign-out', { method: 'POST' });
    const res = (await POST({ request } as unknown as Ctx)) as Response;
    expect(res.status).toBe(303);
    expect(res.headers.get('clear-site-data')).toBe('"cache", "storage"');
    expect(res.headers.get('location')).toBe('/signed-out');
    expect(res.headers.getSetCookie().map((c) => c.split('=')[0])).toEqual(['__Host-nwfl-session', '__Host-nwfl-auth']);
  });
});

describe('GET /sign-out', () => {
  it('never signs anyone out: only a POST does', async () => {
    const res = (await GET({} as unknown as Ctx)) as Response;
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });
});
