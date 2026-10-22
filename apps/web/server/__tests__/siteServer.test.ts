import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SECURITY_HEADERS, SESSION_COOKIE } from '../policy.mjs';
import { createSiteServer, withSitePolicy } from '../siteServer.mjs';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => unknown;

let server: http.Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function serve(handler: Handler): Promise<string> {
  server = http.createServer(withSitePolicy(handler));
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
