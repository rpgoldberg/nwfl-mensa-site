import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SECURITY_HEADERS, SESSION_COOKIE } from '../policy.mjs';
import { SIZE_COOKIE, THEME_COOKIE } from '../prefs.mjs';
import { createSiteServer, withSitePolicy } from '../siteServer.mjs';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => unknown;

let server: http.Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function serve(handler: Handler, pages?: Map<string, string>): Promise<string> {
  server = http.createServer(withSitePolicy(handler, pages ? { pages } : undefined));
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function expectSecurityHeaders(res: Response): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(res.headers.get(name), name).toBe(value);
}

describe('withSitePolicy', () => {
  it('puts the security headers on a response written with writeHead and its own headers', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'none'" });
      res.end('<p>hi</p>');
    });
    const res = await fetch(`${base}/about`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html');
    expectSecurityHeaders(res);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    expect(res.headers.get('vary')).toBe('Cookie');
  });

  it('puts them on a response whose headers are written implicitly', async () => {
    const base = await serve((_req, res) => {
      res.statusCode = 404;
      res.setHeader('Content-Security-Policy', "default-src 'none'");
      res.end('missing');
    });
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
    expectSecurityHeaders(res);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
  });

  it('keeps a reason phrase and a flat header array passed to writeHead', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(201, 'Made', ['X-One', '1', 'X-Two', '2']);
      res.end();
    });
    const res = await fetch(base);
    expect(res.status).toBe(201);
    expect(res.statusText).toBe('Made');
    expect(res.headers.get('x-one')).toBe('1');
    expect(res.headers.get('x-two')).toBe('2');
    expectSecurityHeaders(res);
  });

  it('skips a header the handler left undefined', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { 'X-Set': 'yes', 'X-Unset': undefined });
      res.end();
    });
    const res = await fetch(base);
    expect(res.headers.get('x-set')).toBe('yes');
    expect(res.headers.has('x-unset')).toBe(false);
  });

  it('keeps a reason phrase passed without headers', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(202, 'Queued');
      res.end();
    });
    const res = await fetch(base);
    expect(res.statusText).toBe('Queued');
    expectSecurityHeaders(res);
  });

  it('makes a response private and unstored when the request carries the session cookie', async () => {
    const base = await serve((_req, res) => res.end('page'));
    const res = await fetch(`${base}/`, { headers: { cookie: `${SESSION_COOKIE}=abc` } });
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('makes a response that sets a cookie private and unstored, and keeps every cookie', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(303, { Location: '/', 'Set-Cookie': ['a=1; Path=/', 'b=2; Path=/'] });
      res.end();
    });
    const res = await fetch(base, { redirect: 'manual' });
    expect(res.status).toBe(303);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
  });

  it('overrides a Cache-Control the handler set', async () => {
    const base = await serve((_req, res) => {
      res.setHeader('Cache-Control', 'public, max-age=99999');
      res.end('page');
    });
    const res = await fetch(base, { headers: { cookie: `${SESSION_COOKIE}=abc` } });
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('caches hashed build assets for a year, without Vary', async () => {
    const base = await serve((_req, res) => res.end('body{}'));
    const res = await fetch(`${base}/_astro/site.abc123.css?v=1`);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('vary')).toBeNull();
    expectSecurityHeaders(res);
  });

  it('answers a handler that throws with a 500 that is never stored', async () => {
    const base = await serve(() => {
      throw new Error('boom');
    });
    const res = await fetch(base);
    expect(res.status).toBe(500);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expectSecurityHeaders(res);
  });

  it('answers a handler that rejects with a 500', async () => {
    const base = await serve(async () => {
      throw new Error('boom');
    });
    const res = await fetch(base);
    expect(res.status).toBe(500);
  });

  it('ends the response when a handler fails after the headers went out', async () => {
    const base = await serve(async (_req, res) => {
      res.writeHead(200);
      res.write('partial');
      throw new Error('late');
    });
    await expect(fetch(base).then((r) => r.text())).rejects.toThrow();
  });

  it('answers /healthz itself, without the handler', async () => {
    let called = false;
    const base = await serve(() => {
      called = true;
    });
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expectSecurityHeaders(res);
    expect(called).toBe(false);
  });
});

describe('prerendered pages', () => {
  const html = '<!DOCTYPE html><html lang="en" data-size="1"><body>About ✓</body></html>';
  const pages = new Map([['/about', html]]);
  const neverCalled: Handler = () => {
    throw new Error('the handler must not see a prerendered page');
  };

  it("serves a prerendered page with the reader's size and theme from the cookie", async () => {
    const base = await serve(neverCalled, pages);
    const res = await fetch(`${base}/about`, { headers: { cookie: `${SIZE_COOKIE}=4; ${THEME_COOKIE}=dark` } });
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(body).toBe(html.replace('data-size="1"', 'data-size="4" data-theme="dark"'));
    expect(Number(res.headers.get('content-length'))).toBe(Buffer.byteLength(body));
    expectSecurityHeaders(res);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    expect(res.headers.get('vary')).toBe('Cookie');
  });

  it('serves the built file unchanged to a reader with no settings, whatever the query', async () => {
    const base = await serve(neverCalled, pages);
    const res = await fetch(`${base}/about?from=newsletter`);
    expect(await res.text()).toBe(html);
  });

  it('answers HEAD with the headers and no body', async () => {
    const base = await serve(neverCalled, pages);
    const res = await fetch(`${base}/about`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(Number(res.headers.get('content-length'))).toBe(Buffer.byteLength(html));
    expect(await res.text()).toBe('');
  });

  it('leaves other paths and other methods to the handler', async () => {
    const seen: string[] = [];
    const base = await serve((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.end('from astro');
    }, pages);
    expect(await (await fetch(`${base}/officers`)).text()).toBe('from astro');
    expect(await (await fetch(`${base}/about`, { method: 'POST', body: 'x' })).text()).toBe('from astro');
    expect(seen).toEqual(['GET /officers', 'POST /about']);
  });
});

describe('createSiteServer', () => {
  it('listens on the given host and port', async () => {
    server = createSiteServer((_req, res) => res.end('hello'));
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(await res.text()).toBe('hello');
    expectSecurityHeaders(res);
  });
});
