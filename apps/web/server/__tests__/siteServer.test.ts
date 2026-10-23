import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SECURITY_HEADERS, SESSION_COOKIE } from '../policy.mjs';
import { SIZES, SIZE_COOKIE, THEME_COOKIE, sizeSlider } from '../prefs.mjs';
import { compileRedirects } from '../redirects.mjs';
import { accountHtml } from '../account.mjs';
import { newSession, sessionSetCookie } from '../session.mjs';
import { sharedTokenStore } from '../token-store.mjs';
import { randomBytes } from 'node:crypto';
import { createSiteServer, normalisePath, withSitePolicy } from '../siteServer.mjs';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => unknown;

let server: http.Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function serve(handler: Handler, pages?: Map<string, string>, redirects?: ReturnType<typeof compileRedirects>): Promise<string> {
  server = http.createServer(withSitePolicy(handler, { ...(pages ? { pages } : {}), ...(redirects ? { redirects } : {}) }));
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
    expect(res.headers.get('cache-control')).toBe('public, max-age=60, stale-while-revalidate=60');
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
    expect(res.headers.get('cache-control')).toBe('no-store');
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
      res.writeHead(303, { Location: '/', 'Set-Cookie': ['__Host-a=1; Path=/; Secure', '__Host-b=2; Path=/; Secure'] });
      res.end();
    });
    const res = await fetch(base, { redirect: 'manual' });
    expect(res.status).toBe(303);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.getSetCookie()).toEqual(['__Host-a=1; Path=/; Secure', '__Host-b=2; Path=/; Secure']);
  });

  it('never lets a cookie out that is not host-only, and says which (MT-30)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const base = await serve((_req, res) => {
      res.setHeader('Set-Cookie', [
        '__Host-ok=1; Path=/; Secure; HttpOnly; SameSite=Lax',
        'plain=secret-value; Path=/',
        '__Host-wide=2; Path=/; Secure; Domain=mindsignals1.com',
      ]);
      res.end('page');
    });
    const res = await fetch(`${base}/`);
    expect(res.headers.getSetCookie()).toEqual(['__Host-ok=1; Path=/; Secure; HttpOnly; SameSite=Lax']);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const logged = error.mock.calls.map((c) => String(c[0]));
    expect(logged).toEqual([
      JSON.stringify({ level: 'error', msg: 'dropped a cookie that is not host-only', path: '/', cookie: 'plain' }),
      JSON.stringify({ level: 'error', msg: 'dropped a cookie that is not host-only', path: '/', cookie: '__Host-wide' }),
    ]);
    expect(logged.join()).not.toContain('secret-value');
    error.mockRestore();
  });

  it('never lets Clear-Site-Data clear cookies: they belong to the whole registered domain, the sign-in provider’s too', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const [sent, kept] of [
      ['"cookies", "storage"', '"storage"'],
      ['"cache","cookies"', '"cache"'],
      ['"*"', null],
      ['"cookies"', null],
      ['"cache", "storage"', '"cache", "storage"'],
    ] as const) {
      const base = await serve((_req, res) => {
        res.setHeader('Clear-Site-Data', sent);
        res.end('page');
      });
      expect((await fetch(base)).headers.get('clear-site-data'), sent).toBe(kept);
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    expect(error.mock.calls.map((c) => String(c[0]))).toContain(JSON.stringify({ level: 'error', msg: 'dropped Clear-Site-Data directives that clear cookies', path: '/' }));
    error.mockRestore();
  });

  it('hands the site the Host the reader asked for: never a forwarded host or port', async () => {
    let seen: { headers: http.IncomingHttpHeaders; raw: string[] } | undefined;
    const base = await serve((req, res) => {
      seen = { headers: { ...req.headers }, raw: [...req.rawHeaders] };
      res.end('page');
    });
    await new Promise<void>((resolve, reject) => {
      const req = http.request(`${base}/robots.txt`, {
        headers: { Host: 'nwfl-canary.example.org', 'X-Forwarded-Host': 'nwflorida.us', 'X-Forwarded-Port': '443', 'X-Forwarded-Proto': 'https' },
      });
      req.on('response', (res) => res.resume().on('end', resolve));
      req.on('error', reject);
      req.end();
    });
    expect(seen!.headers['host']).toBe('nwfl-canary.example.org');
    expect(seen!.headers['x-forwarded-proto']).toBe('https');
    expect(seen!.headers).not.toHaveProperty('x-forwarded-host');
    expect(seen!.headers).not.toHaveProperty('x-forwarded-port');
    expect(seen!.raw.map((h) => h.toLowerCase())).not.toContain('x-forwarded-host');
    expect(seen!.raw.map((h) => h.toLowerCase())).not.toContain('x-forwarded-port');
  });

  it('removes the header when no cookie in it is host-only', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const base = await serve((_req, res) => {
      res.writeHead(200, { 'Set-Cookie': 'a=1; Domain=example.org' });
      res.end();
    });
    const res = await fetch(base);
    expect(res.headers.has('set-cookie')).toBe(false);
    error.mockRestore();
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

  it('never stores a server error the handler writes with writeHead (challenger)', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('boom');
    });
    const res = await fetch(`${base}/calendar`);
    expect(res.status).toBe(500);
    expect(res.headers.get('cache-control')).toBe('no-store');
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
  const html = `<!DOCTYPE html><html lang="en" data-size="100"><body>About ✓ ${sizeSlider(100)}</body></html>`;
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
    // An old size 4 is 175 % now, on the page and on its slider.
    expect(body).toBe(html.replace('data-size="100"', 'data-size="175" data-theme="dark"').replace(sizeSlider(100), sizeSlider(175)));
    expect(Number(res.headers.get('content-length'))).toBe(Buffer.byteLength(body));
    expectSecurityHeaders(res);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60, stale-while-revalidate=60');
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
    expect(await (await fetch(`${base}/about`, { method: 'POST', body: 'x', headers: { origin: base } })).text()).toBe('from astro');
    expect(seen).toEqual(['GET /officers', 'POST /about']);
  });
});

describe('normalisePath (the policy decides on the path the handler serves)', () => {
  it('decodes the path as the static handler does', () => {
    expect(normalisePath('/about')).toBe('/about');
    expect(normalisePath('/%61bout')).toBe('/about');
    expect(normalisePath('/caf%C3%A9')).toBe('/café');
  });

  it('refuses an encoded separator or NUL, which would decode into another path, and broken encoding', () => {
    for (const raw of ['/_astro/..%2fabout', '/_astro/..%2Fabout', '/a%5cb', '/a%5Cb', '/a%00b', '/%E0%A4%A']) {
      expect(normalisePath(raw), raw).toBeUndefined();
    }
  });
});

describe('a path the handler would read differently', () => {
  it('is a 400 under the site policy, and the handler never sees it', async () => {
    const base = await serve(() => {
      throw new Error('the handler must not see an ambiguous path');
    });
    for (const path of ['/_astro/..%2fabout', '/x%5c..%5cabout', '/%E0%A4%A']) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(400);
      expectSecurityHeaders(res);
      expect(res.headers.get('cache-control'), path).toBe('no-store');
    }
  });

  it('caches for a year only on the raw path: an encoded letter in an asset name is not immutable', async () => {
    const base = await serve((_req, res) => res.end('body{}'));
    const res = await fetch(`${base}/_astro/%42ase.5t8Gl8HW.css`);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60, stale-while-revalidate=60');
  });

  it('finds a prerendered page by its decoded path', async () => {
    const html = '<!DOCTYPE html><html lang="en" data-size="100"><body>About</body></html>';
    const base = await serve(() => {
      throw new Error('a prerendered page is served from memory');
    }, new Map([['/about', html]]));
    const res = await fetch(`${base}/%61bout`, { headers: { cookie: `${SIZE_COOKIE}=${SIZES[5]}` } });
    expect(await res.text()).toContain(`data-size="${SIZES[5]}"`);
  });
});

describe('a state-changing request with no origin to check', () => {
  const seen: string[] = [];
  const handler: Handler = (req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.end('handled');
  };

  it('is refused with 403 when it has neither Origin nor Sec-Fetch-Site: same-origin', async () => {
    seen.length = 0;
    const base = await serve(handler);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await fetch(`${base}/prefs`, { method, body: 'size=larger', headers: { referer: 'https://evil.example/page' } });
      expect(res.status, method).toBe(403);
      expectSecurityHeaders(res);
    }
    const crossSite = await fetch(`${base}/prefs`, { method: 'POST', body: 'x', headers: { 'sec-fetch-site': 'cross-site' } });
    expect(crossSite.status).toBe(403);
    expect(seen).toEqual([]);
  });

  it('goes on to the handler, whose origin check decides, when it says where it comes from', async () => {
    seen.length = 0;
    const base = await serve(handler);
    await fetch(`${base}/prefs`, { method: 'POST', body: 'x', headers: { origin: 'https://evil.example' } });
    await fetch(`${base}/prefs`, { method: 'POST', body: 'x', headers: { 'sec-fetch-site': 'same-origin' } });
    await fetch(`${base}/about`);
    expect(seen).toEqual(['POST /prefs', 'POST /prefs', 'GET /about']);
  });
});

describe('renamed pages (W-LOOK)', () => {
  it('answers /calendar and /newsletter with 301 to /events and /news, query kept, under the site policy', async () => {
    const base = await serve(() => {
      throw new Error('the handler must not see a renamed path');
    });
    for (const [from, to] of [
      ['/calendar', '/events'],
      ['/calendar?month=2026-11', '/events?month=2026-11'],
      ['/calendar/event/1b4e28ba-2fa1-11d2-883f-0016d3cca427.ics', '/events/1b4e28ba-2fa1-11d2-883f-0016d3cca427.ics'],
      ['/newsletter', '/news'],
    ]) {
      const res = await fetch(`${base}${from}`, { redirect: 'manual' });
      expect(res.status, from).toBe(301);
      expect(res.headers.get('location'), from).toBe(to);
      expectSecurityHeaders(res);
      expect(res.headers.get('cache-control')).toBe('public, max-age=60, stale-while-revalidate=60');
    }
  });

  it('leaves /calendar.ics, the feed phones subscribe to, to the handler', async () => {
    const base = await serve((req, res) => res.end(`feed ${req.url}`));
    expect(await (await fetch(`${base}/calendar.ics`)).text()).toBe('feed /calendar.ics');
  });
});

describe('old URLs (R16)', () => {
  const redirects = compileRedirects({
    moved: { '/join-mensa': '/join' },
    interim: {},
    gone: ['/2015-mind-games'],
    uploads: {},
    goneUploads: [],
    goneDirs: ['/w_api/'],
  });

  it('redirects an old page under the site policy, and the handler never sees it', async () => {
    const base = await serve(() => {
      throw new Error('the handler must not see an old URL');
    }, undefined, redirects);
    const res = await fetch(`${base}/join-mensa.html`, { redirect: 'manual' });
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/join');
    expectSecurityHeaders(res);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60, stale-while-revalidate=60');
  });

  it("answers a retired URL with 410 and the site's own gone page", async () => {
    const seen: string[] = [];
    const base = await serve((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.statusCode = 200;
      res.end('<h1>This page is no longer here</h1>');
    }, undefined, redirects);
    const res = await fetch(`${base}/2015-mind-games.html?x=1`);
    expect(res.status).toBe(410);
    expect(await res.text()).toContain('no longer here');
    expect(seen).toEqual(['GET /gone']);
    expectSecurityHeaders(res);
  });

  it('answers any other method on a retired URL with a bare 410, without the handler', async () => {
    const base = await serve(() => {
      throw new Error('the handler must not see a POST to a retired URL');
    }, undefined, redirects);
    const res = await fetch(`${base}/w_api/APIHandler.php`, { method: 'POST', body: 'x' });
    expect(res.status).toBe(410);
    expectSecurityHeaders(res);
  });

  it('leaves new pages to the handler', async () => {
    const base = await serve((_req, res) => res.end('new'), undefined, redirects);
    expect(await (await fetch(`${base}/join`)).text()).toBe('new');
  });
});

describe('signed in, on a prerendered page (W4)', () => {
  const key = randomBytes(32);
  const now = Math.floor(Date.now() / 1000);
  const html = `<!DOCTYPE html><html lang="en" data-size="100"><body><header>${accountHtml(undefined, { back: '/about', signIn: true })}</header>About</body></html>`;
  const serveSigned = async () => {
    server = http.createServer(withSitePolicy(() => {}, { pages: new Map([['/about', html]]), sessionKey: key }));
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  it('shows the reader’s own account area in place of Sign in, never cached', async () => {
    const base = await serveSigned();
    const session = newSession({ sub: 'u', name: 'Alex Sample', groups: ['nwfl-members', 'nwfl-officers'] }, now);
    sharedTokenStore().put(session.sid, {}, session.exp);
    const cookie = sessionSetCookie(session, key, now).split(';')[0]!;
    const res = await fetch(`${base}/about`, { headers: { cookie } });
    const body = await res.text();
    expect(body).toContain('Alex Sample');
    expect(body).toContain('href="/officer-area"');
    expect(body).not.toContain('>Sign in<');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('shows Sign in for a session signed out elsewhere: its record is gone', async () => {
    const base = await serveSigned();
    const session = newSession({ sub: 'u', name: 'Alex Sample', groups: ['nwfl-members'] }, now);
    const cookie = sessionSetCookie(session, key, now).split(';')[0]!;
    expect(await (await fetch(`${base}/about`, { headers: { cookie } })).text()).toBe(html);
  });

  it('shows Sign in to everyone else, a forged cookie included', async () => {
    const base = await serveSigned();
    const res = await fetch(`${base}/about`, { headers: { cookie: '__Host-nwfl-session=v1.forged' } });
    expect(await res.text()).toBe(html);
  });
});

describe('the sign-in provider in form-action (W4)', () => {
  it('is named only when the server is told it', async () => {
    server = http.createServer(withSitePolicy((_req, res) => res.end('x'), { formAction: ['https://login.nwflorida.us'] }));
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    expect(res.headers.get('content-security-policy')).toMatch(/form-action 'self' https:\/\/login\.nwflorida\.us$/);
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
