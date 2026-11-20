// A request target is a path on this site, never an authority. An absolute-form target, or a path
// that reads as one (//[::1, /\[::1), ended the process when the site parsed it against a base URL;
// //ok/news was read as host "ok" and served as /news. A target that is no path (absolute-form, the
// asterisk) or a path with a backslash is now refused with 400 and fixed text; a path that starts
// with // is the literal path it is. The site runs in a child process, so a crash
// shows as the child's exit; every request goes over a real socket.
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

const SERVER = `
import { createMachineRoute } from '${new URL('../machine-route.mjs', import.meta.url).pathname}';
import { createSiteServer } from '${new URL('../siteServer.mjs', import.meta.url).pathname}';
const pages = new Map([['/news', '<html><body>the news page</body></html>']]);
// A stand-in for any code a request runs before the handler: it throws on one path.
const get = pages.get.bind(pages);
pages.get = (path) => { if (path === '/throws') throw new TypeError('made-up fault'); return get(path); };
const handler = (req, res) => { res.statusCode = 404; res.end('handler ' + req.url); };
const site = createSiteServer(handler, { pages, machine: createMachineRoute({ baseUrl: 'http://127.0.0.1:9', timeoutMs: 1000 }) });
site.listen(0, '127.0.0.1', () => console.log('PORT ' + site.address().port));
`;
// MACHINE-ROUTE: each rule holds on the machine route's path too.
const LIST = 'nwfl.mensa.v1.LinkCheckService/ListLinksAwaitingVerdict';

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGTERM');
});

async function startSite(source = SERVER): Promise<{ port: number; exited: () => boolean; output: () => string }> {
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let exited = false;
  let output = '';
  child.on('exit', () => (exited = true));
  child.stderr.on('data', (d: Buffer) => (output += d.toString()));
  const port = await new Promise<number>((resolve) =>
    child.stdout.on('data', (d: Buffer) => {
      output += d.toString();
      const m = /PORT (\d+)/.exec(d.toString());
      if (m) resolve(Number(m[1]));
    }),
  );
  return { port, exited: () => exited, output: () => output };
}

/** One raw request on its own socket; the whole reply, read to the socket's close. */
function raw(port: number, request: string): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    let out = '';
    s.on('data', (d) => (out += d.toString('latin1')));
    s.on('close', () => resolve(out));
    s.on('error', () => resolve(out));
    s.write(request);
  });
}

const request = (method: string, target: string, bearer: boolean) =>
  `${method} ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\n${bearer ? 'Authorization: Bearer made-up\r\n' : ''}Content-Type: application/proto\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`;
const body = (reply: string) => reply.slice(reply.indexOf('\r\n\r\n') + 4);
const settle = () => new Promise((r) => setTimeout(r, 50));

// Each target ends in "/" and gets a page path or the machine path after it.
const BAD = [
  ['an unclosed IP literal, absolute-form', 'http://[/'],
  ['a port out of range, absolute-form', 'http://x:99999/'],
  ['an unclosed IPv6 literal, absolute-form', 'http://[::1/'],
  ['an empty authority, absolute-form', 'http:///'],
  ['a broken escape in the authority, absolute-form', 'http://%zz/'],
  ['a well-formed absolute-form target', 'https://evil.example/'],
  ['another scheme', 'ftp://x/'],
  ['a backslash that reads as an authority', '/\\[::1/'],
  ['two backslashes that read as an authority', '/\\\\[::1/'],
] as const;

describe.each(BAD)('a request target with %s', (_label, prefix) => {
  it.each([
    ['a page path', 'GET', 'news'],
    ['the machine path', 'POST', LIST],
  ])('on %s, with and without a bearer, answers 400 with fixed text and the site lives on', async (_where, method, rest) => {
    const site = await startSite();
    for (const bearer of [false, true]) {
      const reply = await raw(site.port, request(method, `${prefix}${rest}`, bearer));
      expect(reply.slice(0, 12), `${prefix}${rest} bearer=${bearer}`).toBe('HTTP/1.1 400');
      expect(body(reply)).toBe('Bad request');
      expect(reply).toMatch(/\r\ncache-control: no-store\r\n/i);
    }
    const page = await raw(site.port, request('GET', '/news', false));
    expect(page.slice(0, 12)).toBe('HTTP/1.1 200');
    expect(body(page)).toContain('the news page');
    await settle();
    expect(site.exited()).toBe(false);
  }, 15_000);
});

describe('targets that are no path', () => {
  it.each([
    ['a 4 kB absolute-form target', `http://${'a'.repeat(4000)}/news`],
    ['the asterisk form', '*'],
  ])('%s answers 400 and the site lives on', async (_label, target) => {
    const site = await startSite();
    const reply = await raw(site.port, request('GET', target, false));
    expect(reply.slice(0, 12)).toBe('HTTP/1.1 400');
    expect(body(reply)).toBe('Bad request');
    expect((await raw(site.port, request('GET', '/news', false))).slice(0, 12)).toBe('HTTP/1.1 200');
    await settle();
    expect(site.exited()).toBe(false);
  }, 15_000);

  // Node's own parser refuses these before the site sees them; the site lives on all the same.
  it.each(['news', '?a=1'])('%s is refused by Node with 400 and the site lives on', async (target) => {
    const site = await startSite();
    expect((await raw(site.port, request('GET', target, false))).slice(0, 12)).toBe('HTTP/1.1 400');
    expect((await raw(site.port, request('GET', '/news', false))).slice(0, 12)).toBe('HTTP/1.1 200');
    await settle();
    expect(site.exited()).toBe(false);
  }, 15_000);
});

describe('a refused target is logged', () => {
  it('in one fixed line with a fixed reason, never the target', async () => {
    const site = await startSite();
    await raw(site.port, request('GET', 'http://[zq7-target/news', false));
    await raw(site.port, request('POST', 'http://x:99999/zq7-target/news', true));
    await raw(site.port, request('POST', `http://x:99999/zq7-target/${LIST}`, true));
    await settle();
    const lines = site.output().split('\n').filter((l) => l.startsWith('{'));
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const entry = JSON.parse(line);
      expect(entry).toMatchObject({ level: 'warn', msg: 'bad request target', reason: 'not a path on this site' });
      expect(Object.keys(entry).sort()).toEqual(['level', 'msg', 'reason', 'service', 'time', 'trace_id']);
    }
    expect(site.output()).not.toContain('zq7-target');
    expect(site.output()).not.toContain('Bearer');
  }, 15_000);
});

describe('a path that starts with //', () => {
  const page = (target: string, bearer: boolean) => request('GET', target, bearer);
  const call = (target: string, bearer: boolean) =>
    `POST ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://127.0.0.1\r\n${bearer ? 'Authorization: Bearer made-up\r\n' : ''}Content-Length: 0\r\nConnection: close\r\n\r\n`;

  // The handler gets each as it came; Astro collapses the slashes (//ok/news is /ok/news, no page): 404.
  it.each([
    ['//ok/news', page, 'news'],
    ['//[::1/news', page, 'news'],
    ['//a:99999/news', page, 'news'],
    ['//[::1', page, ''],
    ['//ok/<machine path>', call, LIST],
    ['//[::1/<machine path>', call, LIST],
    ['//a:99999/<machine path>', call, LIST],
  ] as const)('%s is that literal path, never the page or the route after the "authority"', async (label, make, rest) => {
    const target = label.replace(/<machine path>|news$/, '') + rest;
    const site = await startSite();
    for (const bearer of [false, true]) {
      const reply = await raw(site.port, make(target, bearer));
      expect(reply.slice(0, 12), `${target} bearer=${bearer}`).toBe('HTTP/1.1 404');
      expect(body(reply)).toBe(`handler ${target}`);
    }
    await settle();
    expect(site.exited()).toBe(false);
  }, 15_000);
});

describe('a renamed page whose path decodes to non-ASCII', () => {
  it('redirects with the path percent-encoded, and the site lives on', async () => {
    const site = await startSite();
    const reply = await raw(site.port, request('GET', '/newsletter/%C4%80?page=2', false));
    expect(reply.slice(0, 12)).toBe('HTTP/1.1 301');
    expect(reply).toMatch(/\r\nlocation: \/news\/%C4%80\?page=2\r\n/i);
    expect((await raw(site.port, request('GET', '/news', false))).slice(0, 12)).toBe('HTTP/1.1 200');
    await settle();
    expect(site.exited()).toBe(false);
  }, 15_000);

  it('keeps a reserved character that decodes from the path inside the path', async () => {
    const site = await startSite();
    const query = await raw(site.port, request('GET', '/newsletter/%3Fa=1', false));
    expect(query.slice(0, 12)).toBe('HTTP/1.1 301');
    expect(query).toMatch(/\r\nlocation: \/news\/%3Fa%3D1\r\n/i);
    const fragment = await raw(site.port, request('GET', '/newsletter/%23top', false));
    expect(fragment.slice(0, 12)).toBe('HTTP/1.1 301');
    expect(fragment).toMatch(/\r\nlocation: \/news\/%23top\r\n/i);
    await settle();
    expect(site.exited()).toBe(false);
  }, 15_000);
});

describe('a fault in any code a request runs before the handler', () => {
  it('answers 500, logs the error by name only, and the site lives on', async () => {
    const site = await startSite();
    const reply = await raw(site.port, request('GET', '/throws', false));
    expect(reply.slice(0, 12)).toBe('HTTP/1.1 500');
    expect(body(reply)).toBe('Internal Server Error');
    expect((await raw(site.port, request('GET', '/news', false))).slice(0, 12)).toBe('HTTP/1.1 200');
    await settle();
    expect(site.exited()).toBe(false);
    expect(site.output()).toContain('"msg":"request failed","path":"/throws","err":"TypeError"');
    expect(site.output()).not.toContain('made-up fault');
  }, 15_000);
});

// LAUNCH-FIX round 3: with the site's own error page built, a fault before the handler shows that
// page (status 500, never stored, no error text), as a fault in the handler does; the site lives on.
const ERROR_HTML = '<!doctype html><html lang="en" data-size="100" data-theme="auto" data-links="ask"><body><h1>Something went wrong on our side</h1><form method="post" action="/prefs"><input type="hidden" name="back" value="/"></form><a href="/officers">tell an officer</a></body></html>';
const SERVER_WITH_ERROR_PAGE = SERVER.replace(
  "new Map([['/news', '<html><body>the news page</body></html>']])",
  `new Map([['/news', '<html><body>the news page</body></html>'], ['/500', ${JSON.stringify(ERROR_HTML)}]])`,
);

describe('a fault before the handler, with the error page built', () => {
  it('answers with the error page, not plain text, logs the error by name only, and the site lives on', async () => {
    expect(SERVER_WITH_ERROR_PAGE).not.toBe(SERVER);
    const site = await startSite(SERVER_WITH_ERROR_PAGE);
    const reply = await raw(site.port, request('GET', '/throws', false));
    expect(reply.slice(0, 12)).toBe('HTTP/1.1 500');
    expect(reply).toMatch(/\r\ncontent-type: text\/html; charset=utf-8\r\n/i);
    expect(reply).toMatch(/\r\ncache-control: no-store\r\n/i);
    expect(body(reply)).toContain('<h1>Something went wrong on our side</h1>');
    expect(body(reply)).not.toMatch(/Internal Server Error|made-up fault|TypeError/);
    // The error page's controls still go Home, never back to the error page.
    expect(body(reply)).toContain('<input type="hidden" name="back" value="/">');
    expect(body(reply)).not.toMatch(/(href|action|value)="\/500/);
    expect((await raw(site.port, request('GET', '/news', false))).slice(0, 12)).toBe('HTTP/1.1 200');
    await settle();
    expect(site.exited()).toBe(false);
    expect(site.output()).toContain('"msg":"request failed","path":"/throws","err":"TypeError"');
    expect(site.output()).not.toContain('made-up fault');
  }, 15_000);
});
