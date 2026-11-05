import { gzipSync, brotliCompressSync, deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { DnsFailure } from '../src/dns.js';
import { LIMITS, USER_AGENT, follow, makeConnect, type NetDeps } from '../src/net.js';
import { type Route, type Stand, fakeDns, routedConnect, startHttp, startHttps, testPki } from './helpers/servers.js';

const PUBLIC = '93.184.215.14';
const OTHER = '93.184.215.15';
const pki = testPki(['site.example', 'www.site.example', 'other.example']);
const stands: Stand[] = [];
afterEach(async () => {
  await Promise.all(stands.splice(0).map((s) => s.close()));
});

async function https(route: Route): Promise<Stand> {
  const stand = await startHttps(route, pki);
  stands.push(stand);
  return stand;
}
async function http(route: Route): Promise<Stand> {
  const stand = await startHttp(route);
  stands.push(stand);
  return stand;
}

function deps(table: Parameters<typeof fakeDns>[0], routes: Record<string, number>, limits: Partial<typeof LIMITS> = {}): NetDeps & { dns: ReturnType<typeof fakeDns>; connect: ReturnType<typeof routedConnect> } {
  return { dns: fakeDns(table), connect: routedConnect(routes, pki.ca), limits };
}

describe('follow: one guarded request per hop, redirects by hand', () => {
  it('fetches over TLS, pinned to the address it checked, naming us, with no cookie and no compression asked', async () => {
    let seen: Record<string, string | string[] | undefined> = {};
    const stand = await https((req, res) => {
      seen = req.headers;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'a=b' });
      res.end('<p>Hello</p>');
    });
    const d = deps({ 'site.example': [PUBLIC] }, { [PUBLIC]: stand.port });
    const out = await follow('https://site.example/page?x=1', d);
    expect(out).toEqual({ hops: [{ url: 'https://site.example/page?x=1', address: PUBLIC, status: 200 }], final: { url: 'https://site.example/page?x=1', address: PUBLIC, status: 200 }, body: '<p>Hello</p>', truncated: false, contentType: 'text/html; charset=utf-8', downgraded: false });
    expect(seen['user-agent']).toBe(USER_AGENT);
    expect(seen['host']).toBe('site.example');
    expect(seen['accept-encoding']).toBe('identity');
    expect(seen['cookie']).toBeUndefined();
    expect(d.connect.targets).toEqual([{ address: PUBLIC, family: 4, port: 443, host: 'site.example', tls: true }]);
  });

  it('resolves once per hop, so a rebinding DNS cannot swap the address', async () => {
    const stand = await https((_req, res) => res.end('ok'));
    let n = 0;
    const d = deps({}, { [PUBLIC]: stand.port });
    d.dns.resolve4 = () => Promise.resolve((n += 1) === 1 ? [PUBLIC] : ['127.0.0.1']);
    d.dns.resolve6 = () => Promise.reject(new DnsFailure('nodata'));
    const out = await follow('https://site.example/', d);
    expect(out.final.status).toBe(200);
    expect(n).toBe(1);
    expect(d.connect.targets.map((t) => t.address)).toEqual([PUBLIC]);
  });

  it('follows relative and absolute redirects, records the chain and drops cookies between hops', async () => {
    const cookies: (string | undefined)[] = [];
    const stand = await https((req, res) => {
      cookies.push(req.headers.cookie);
      if (req.url === '/a') res.writeHead(301, { location: '/b', 'set-cookie': 'sid=1' }).end();
      else if (req.url === '/b') res.writeHead(302, { location: 'https://other.example/c' }).end();
      else res.writeHead(200, { 'content-type': 'text/plain' }).end('done');
    });
    const out = await follow('https://site.example/a', deps({ 'site.example': [PUBLIC], 'other.example': [OTHER] }, { [PUBLIC]: stand.port, [OTHER]: stand.port }));
    expect(out.hops.map((h) => [h.url, h.status])).toEqual([
      ['https://site.example/a', 301],
      ['https://site.example/b', 302],
      ['https://other.example/c', 200],
    ]);
    expect(out.final.url).toBe('https://other.example/c');
    expect(cookies).toEqual([undefined, undefined, undefined]);
  });

  it('stops after five redirects', async () => {
    const stand = await https((req, res) => res.writeHead(302, { location: `/r${Number(req.url?.slice(2) || 0) + 1}` }).end());
    const out = await follow('https://site.example/r0', deps({ 'site.example': [PUBLIC] }, { [PUBLIC]: stand.port }));
    expect(out.hops).toHaveLength(6);
    expect(out.failure).toBe('too-many-redirects');
  });

  it('notes a redirect from https down to http', async () => {
    const plain = await http((_req, res) => res.end('plain'));
    const tls = await https((_req, res) => res.writeHead(301, { location: 'http://site.example/' }).end());
    const out = await follow('https://site.example/', deps({ 'site.example': [PUBLIC] }, { [`${PUBLIC}:443`]: tls.port, [`${PUBLIC}:80`]: plain.port }));
    expect(out.downgraded).toBe(true);
    expect(out.final.status).toBe(200);
  });

  it.each([
    ['a private address', 'https://inside.example/', 'private-address'],
    ['the no-fetch list', 'https://members.us.mensa.org/x', 'no-fetch'],
    ['a figure site on the no-fetch list', 'https://myfigurecollection.net/item/1', 'no-fetch'],
    ['a login-walled host', 'https://www.facebook.com/groups/x', 'login-walled'],
    ['another port', 'https://site.example:8443/', 'port'],
    ['a javascript: URL', 'javascript:alert(1)', 'scheme'],
    ['a broken URL', 'http://[', 'malformed'],
    ['a decimal loopback literal', 'http://2130706433/', 'private-address'],
    ['an octal private literal', 'http://012.0.0.1/', 'private-address'],
  ])('refuses a redirect to %s, never connecting or resolving it', async (_name, location, failure) => {
    const stand = await https((_req, res) => res.writeHead(302, { location }).end());
    const d = deps({ 'site.example': [PUBLIC], 'inside.example': ['10.0.0.5'] }, { [PUBLIC]: stand.port });
    const out = await follow('https://site.example/', d);
    expect(out.failure).toBe(failure);
    expect(d.connect.targets).toHaveLength(1);
    expect(d.dns.calls.filter((c) => /mensa|figure|facebook/.test(c))).toEqual([]);
  });

  it('keeps a 3xx with no Location as the final answer', async () => {
    const stand = await https((_req, res) => res.writeHead(302).end());
    expect((await follow('https://site.example/', deps({ 'site.example': [PUBLIC] }, { [PUBLIC]: stand.port }))).final.status).toBe(302);
  });

  it.each([
    ['NXDOMAIN', {}, 'nxdomain'],
    ['no records', { 'site.example': [] }, 'nodata'],
    ['a DNS timeout', { 'site.example': 'timeout' as const }, 'dns-failure'],
  ])('reports %s', async (_name, table, failure) => {
    expect((await follow('https://site.example/', deps(table, {}))).failure).toBe(failure);
  });

  it('reports a refused connection as unreachable, after trying each address once', async () => {
    const d = deps({ 'site.example': [PUBLIC, '2606:4700::1'] }, {});
    expect((await follow('https://site.example/', d)).failure).toBe('unreachable');
    expect(d.connect.targets.map((t) => t.address)).toEqual([PUBLIC, '2606:4700::1']);
  });

  it('reports a certificate for another name, and a server that does not speak TLS, as tls', async () => {
    const wrong = testPki(['elsewhere.example']);
    const stand = await startHttps((_req, res) => res.end('x'), wrong);
    stands.push(stand);
    expect((await follow('https://site.example/', deps({ 'site.example': [PUBLIC] }, { [PUBLIC]: stand.port }))).failure).toBe('tls');
    const plain = await http((_req, res) => res.end('x'));
    expect((await follow('https://site.example/', deps({ 'site.example': [PUBLIC] }, { [PUBLIC]: plain.port }))).failure).toBe('tls');
  });

  it('reports a certificate it cannot trust as tls with the default trust store', async () => {
    const stand = await https((_req, res) => res.end('x'));
    const d = { dns: fakeDns({ 'site.example': [PUBLIC] }), connect: (t: Parameters<ReturnType<typeof makeConnect>>[0], s: AbortSignal) => makeConnect()({ ...t, address: '127.0.0.1', port: stand.port }, s) };
    expect((await follow('https://site.example/', d)).failure).toBe('tls');
  });

  it('reports a reply that is not HTTP as protocol', async () => {
    const { createServer } = await import('node:net');
    const server = createServer((socket) => socket.end('NOT HTTP AT ALL\r\n\r\n'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      expect((await follow('http://site.example/', deps({ 'site.example': [PUBLIC] }, { [PUBLIC]: port }))).failure).toBe('protocol');
    } finally {
      server.close();
    }
  });

  it('times out a server that never answers', async () => {
    const stand = await https(() => undefined);
    const start = Date.now();
    const out = await follow('https://site.example/', deps({ 'site.example': [PUBLIC] }, { [PUBLIC]: stand.port }, { hopMs: 300 }));
    expect(out.failure).toBe('timeout');
    expect(Date.now() - start).toBeLessThan(3000);
  });

  it('cuts a slow-loris body at the hop deadline and keeps the status', async () => {
    const stand = await https((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      const timer = setInterval(() => res.write('a'), 50);
      res.on('close', () => clearInterval(timer));
    });
    const start = Date.now();
    const out = await follow('https://site.example/', deps({ 'site.example': [PUBLIC] }, { [PUBLIC]: stand.port }, { hopMs: 400 }));
    expect(Date.now() - start).toBeLessThan(3000);
    expect(out.final.status).toBe(200);
    expect(out.truncated).toBe(true);
    expect(out.failure).toBeUndefined();
  });

  it('reads at most 256 KiB of a body', async () => {
    const stand = await https((_req, res) => res.writeHead(200, { 'content-type': 'text/plain' }).end('x'.repeat(1024 * 1024)));
    const out = await follow('https://site.example/', deps({ 'site.example': [PUBLIC] }, { [PUBLIC]: stand.port }));
    expect(out.body?.length).toBe(LIMITS.bodyBytes);
    expect(out.truncated).toBe(true);
  });

  it('decodes gzip, deflate and br within the same cap, so a gzip bomb stays small', async () => {
    const bomb = gzipSync(Buffer.alloc(200 * 1024 * 1024));
    const bodies: Record<string, [string, Buffer]> = {
      '/bomb': ['gzip', bomb],
      '/gz': ['gzip', gzipSync('zipped')],
      '/df': ['deflate', deflateSync('deflated')],
      '/br': ['br', brotliCompressSync('brotli')],
      '/odd': ['compress', Buffer.from('odd')],
      '/bad': ['gzip', Buffer.from('not gzip at all')],
    };
    const stand = await https((req, res) => {
      const [encoding, body] = bodies[req.url as string] as [string, Buffer];
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': encoding }).end(body);
    });
    const d = deps({ 'site.example': [PUBLIC] }, { [PUBLIC]: stand.port });
    const before = process.memoryUsage().rss;
    const bombed = await follow('https://site.example/bomb', d);
    expect(bombed.body?.length).toBeLessThanOrEqual(LIMITS.bodyBytes);
    expect(bombed.truncated).toBe(true);
    expect(process.memoryUsage().rss - before).toBeLessThan(200 * 1024 * 1024);
    expect((await follow('https://site.example/gz', d)).body).toBe('zipped');
    expect((await follow('https://site.example/df', d)).body).toBe('deflated');
    expect((await follow('https://site.example/br', d)).body).toBe('brotli');
    expect((await follow('https://site.example/odd', d)).body).toBeUndefined();
    expect((await follow('https://site.example/bad', d)).body).toBe('');
  });

  it('reads text bodies only, in their charset', async () => {
    const stand = await https((req, res) => {
      if (req.url === '/png') res.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.from([0x89, 0x50]));
      else if (req.url === '/latin') res.writeHead(200, { 'content-type': 'text/html; charset=windows-1252' }).end(Buffer.from([0x63, 0x61, 0x66, 0xe9]));
      else if (req.url === '/weird') res.writeHead(200, { 'content-type': 'text/html; charset=no-such-charset' }).end('plain');
      else if (req.url === '/json') res.writeHead(200, { 'content-type': 'application/rdap+json' }).end('{"a":1}');
      else res.writeHead(200).end('untyped');
    });
    const d = deps({ 'site.example': [PUBLIC] }, { [PUBLIC]: stand.port });
    expect((await follow('https://site.example/png', d)).body).toBeUndefined();
    expect((await follow('https://site.example/latin', d)).body).toBe('caf\u00e9');
    expect((await follow('https://site.example/weird', d)).body).toBe('plain');
    expect((await follow('https://site.example/json', d)).body).toBe('{"a":1}');
    expect((await follow('https://site.example/', d)).body).toBe('untyped');
  });

  it('can be asked for another Accept and a larger body cap', async () => {
    let accept: string | undefined;
    const stand = await https((req, res) => {
      accept = req.headers.accept;
      res.writeHead(200, { 'content-type': 'application/json' }).end('y'.repeat(300 * 1024));
    });
    const out = await follow('https://site.example/', deps({ 'site.example': [PUBLIC] }, { [PUBLIC]: stand.port }), { accept: 'application/rdap+json', bodyBytes: 512 * 1024 });
    expect(accept).toBe('application/rdap+json');
    expect(out.body?.length).toBe(300 * 1024);
  });

  it('sends the port in Host when it is not the default', async () => {
    let host: string | undefined;
    const stand = await http((req, res) => {
      host = req.headers.host;
      res.end('x');
    });
    await follow('http://site.example:443/', deps({ 'site.example': [PUBLIC] }, { [`${PUBLIC}:443`]: stand.port }));
    expect(host).toBe('site.example:443');
  });
});
