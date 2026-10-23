import { describe, expect, it } from 'vitest';
import { SIZES, SIZE_COOKIE, THEME_COOKIE } from '../../server/prefs.mjs';
import { GET, POST } from '../../src/pages/prefs';

type Ctx = Parameters<typeof POST>[0];

function post(fields: Record<string, string>, opts: { cookie?: string; origin?: string; type?: string } = {}) {
  const url = new URL(`${opts.origin ?? 'http://site.test'}/prefs`);
  const headers = new Headers({ 'content-type': opts.type ?? 'application/x-www-form-urlencoded' });
  if (opts.cookie) headers.set('cookie', opts.cookie);
  const request = new Request(url, { method: 'POST', headers, body: new URLSearchParams(fields).toString() });
  return POST({ request, url } as unknown as Ctx) as Promise<Response>;
}

const FORM = 'application/x-www-form-urlencoded';

/** A body that arrives in pieces, with no Content-Length (chunked). */
function chunked(parts: string[], fail?: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
      if (fail) controller.error(new Error(fail));
      else controller.close();
    },
  });
}

function postBody(body: BodyInit, headers: Record<string, string>) {
  const url = new URL('http://site.test/prefs');
  const request = new Request(url, { method: 'POST', headers, body, duplex: 'half' } as RequestInit);
  return POST({ request, url } as unknown as Ctx) as Promise<Response>;
}

describe('POST /prefs: what it will read (the memory blocker)', () => {
  it('refuses a declared body over 4 KiB unread, and closes the connection', async () => {
    const res = await postBody(`back=${'a'.repeat(4995)}`, { 'content-type': FORM, 'content-length': '5000' });
    expect(res.status).toBe(413);
    expect(res.headers.get('connection')).toBe('close');
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('refuses on the declared length alone, before reading a byte', async () => {
    const untouchable = new ReadableStream({
      pull() {
        throw new Error('the body was read');
      },
    });
    const res = await postBody(untouchable, { 'content-type': FORM, 'content-length': String(100 * 1024 * 1024) });
    expect(res.status).toBe(413);
  });

  it('refuses a chunked body as soon as it runs over 4 KiB', async () => {
    const res = await postBody(chunked([`back=${'a'.repeat(3000)}`, 'a'.repeat(3000)]), { 'content-type': FORM });
    expect(res.status).toBe(413);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('still takes a chunked form that fits', async () => {
    const res = await postBody(chunked(['size=lar', 'ger&back=%2Fabout']), { 'content-type': FORM });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/about');
  });

  it('takes an empty form as no change, and sends the reader Home', async () => {
    const url = new URL('http://site.test/prefs');
    const request = new Request(url, { method: 'POST', headers: { 'content-type': FORM } });
    const res = (await POST({ request, url } as unknown as Ctx)) as Response;
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
  });

  it('answers 400 to a form it cannot read, or a body that breaks off', async () => {
    expect((await postBody('size=larger', { 'content-type': 'multipart/form-data' })).status).toBe(400);
    expect((await postBody(chunked(['size=lar'], 'the client went away'), { 'content-type': FORM })).status).toBe(400);
  });

  it("answers 413 when Astro's own 64 KiB cap stops a chunked body before this handler sees it", async () => {
    // Undici reads ahead, so Astro's limiter can fail the stream first.
    const capped = chunked(['size=lar'], 'Body size limit exceeded: received more than 65536 bytes');
    expect((await postBody(capped, { 'content-type': FORM })).status).toBe(413);
  });
});

describe('POST /prefs', () => {
  it('writes the next size and redirects back to the page, with See Other', async () => {
    const res = await post({ size: 'larger', back: '/about' }, { cookie: `${SIZE_COOKIE}=${SIZES[4]}` });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/about');
    expect(res.headers.getSetCookie()).toContain(`${SIZE_COOKIE}=${SIZES[5]}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly; Secure`);
  });

  it("writes the slider's notch on Use this size, and only then", async () => {
    const set = await post({ size: 'set', step: '0', back: '/about', from: 'menu' });
    expect(set.headers.get('location')).toBe('/about#reader-menu');
    expect(set.headers.getSetCookie()).toContain(`${SIZE_COOKIE}=${SIZES[0]}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly; Secure`);
    // A− and the theme buttons submit the same form, slider value and all.
    const smaller = await post({ size: 'smaller', step: '6', back: '/about' }, { cookie: `${SIZE_COOKIE}=${SIZES[5]}` });
    expect(smaller.headers.getSetCookie()[0]).toMatch(new RegExp(`^${SIZE_COOKIE}=${SIZES[4]};`));
    const theme = await post({ theme: 'dark', step: '6', back: '/about' }, { cookie: `${SIZE_COOKIE}=${SIZES[4]}` });
    expect(theme.headers.getSetCookie()[0]).toMatch(new RegExp(`^${SIZE_COOKIE}=${SIZES[4]};`));
  });

  it('reopens the Aa panel when the change came from it', async () => {
    const res = await post({ theme: 'dark', back: '/officers', from: 'menu' });
    expect(res.headers.get('location')).toBe('/officers#reader-menu');
    expect(res.headers.getSetCookie()).toContain(`${THEME_COOKIE}=dark; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly; Secure`);
  });

  it('sets only host-only cookies, Secure whatever the scheme the server saw', async () => {
    for (const origin of ['https://nwflorida.us', 'http://localhost:8080']) {
      const res = await post({ theme: 'contrast-white', back: '/' }, { origin });
      const cookies = res.headers.getSetCookie();
      expect(cookies.length).toBe(2);
      for (const c of cookies) {
        expect(c).toMatch(/^__Host-/);
        expect(c).toMatch(/; Secure$/);
        expect(c).not.toMatch(/domain=/i);
      }
    }
  });

  it('sends a back path with a control or non-ASCII character Home, never a 500', async () => {
    for (const back of ['/\u0001x', '/\u007f', '/\u20ac']) {
      const res = await post({ size: 'larger', back });
      expect(res.status, JSON.stringify(back)).toBe(303);
      expect(res.headers.get('location')).toBe('/');
    }
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
    expect(res.headers.getSetCookie()[0]).toMatch(new RegExp(`^${SIZE_COOKIE}=${SIZES[4]};`));
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
