import { describe, expect, it } from 'vitest';
import { SIZE_COOKIE, THEME_COOKIE } from '../../server/prefs.mjs';
import { GET, POST } from './prefs';

type Ctx = Parameters<typeof POST>[0];

function post(fields: Record<string, string>, opts: { cookie?: string; origin?: string; type?: string } = {}) {
  const url = new URL(`${opts.origin ?? 'http://site.test'}/prefs`);
  const headers = new Headers({ 'content-type': opts.type ?? 'application/x-www-form-urlencoded' });
  if (opts.cookie) headers.set('cookie', opts.cookie);
  const request = new Request(url, { method: 'POST', headers, body: new URLSearchParams(fields).toString() });
  return POST({ request, url } as unknown as Ctx) as Promise<Response>;
}

describe('POST /prefs', () => {
  it('writes the next size and redirects back to the page, with See Other', async () => {
    const res = await post({ size: 'larger', back: '/about' }, { cookie: `${SIZE_COOKIE}=2` });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/about');
    expect(res.headers.getSetCookie()).toContain(`${SIZE_COOKIE}=3; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`);
  });

  it('reopens the Aa panel when the change came from it', async () => {
    const res = await post({ theme: 'dark', back: '/officers', from: 'menu' });
    expect(res.headers.get('location')).toBe('/officers#reader-menu');
    expect(res.headers.getSetCookie()).toContain(`${THEME_COOKIE}=dark; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`);
  });

  it('marks the cookies Secure when the site is reached over https', async () => {
    const res = await post({ theme: 'contrast', back: '/' }, { origin: 'https://nwflorida.us' });
    for (const c of res.headers.getSetCookie()) expect(c).toMatch(/; Secure$/);
  });

  it('never redirects off the site', async () => {
    const res = await post({ size: 'larger', back: '//evil.example/' });
    expect(res.headers.get('location')).toBe('/');
  });

  it('takes a multipart form too, and ignores a file where it expects text', async () => {
    const form = new FormData();
    form.set('size', 'larger');
    form.set('back', new File(['/about'], 'back.txt'));
    const url = new URL('http://site.test/prefs');
    const request = new Request(url, { method: 'POST', body: form });
    const res = (await POST({ request, url } as unknown as Ctx)) as Response;
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
    expect(res.headers.getSetCookie()[0]).toMatch(new RegExp(`^${SIZE_COOKIE}=2;`));
  });

  it('refuses a body that is not a form, and stores nothing', async () => {
    const res = await post({ size: 'larger' }, { type: 'application/json' });
    expect(res.status).toBe(415);
    expect(res.headers.getSetCookie()).toEqual([]);
    const url = new URL('http://site.test/prefs');
    const bare = (await POST({ request: new Request(url, { method: 'POST' }), url } as unknown as Ctx)) as Response;
    expect(bare.status).toBe(415);
  });
});

describe('GET /prefs', () => {
  it('sends a reader who lands here to Home', async () => {
    const res = (await GET({} as unknown as Ctx)) as Response;
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
  });
});
