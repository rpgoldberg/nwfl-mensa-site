// MACHINE-ROUTE round 1 (challenger: pre-auth crash). connect-node builds a URL from the inbound Host,
// and a Host it cannot read threw past the site's guard and ended the process. No request of any shape
// may do that: a Host that is no authority is refused with 400, with or without a bearer, and the site
// goes on serving pages. The site runs in a child process, so a crash shows as the child's exit.
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

const SERVER = `
import { createMachineRoute } from '${new URL('../machine-route.mjs', import.meta.url).pathname}';
import { createSiteServer } from '${new URL('../siteServer.mjs', import.meta.url).pathname}';
const site = createSiteServer((_q, r) => r.end('astro'), { machine: createMachineRoute({ baseUrl: 'http://127.0.0.1:9', timeoutMs: 1000 }) });
site.listen(0, '127.0.0.1', () => console.log('PORT ' + site.address().port));
`;
const LIST = '/nwfl.mensa.v1.LinkCheckService/ListLinksAwaitingVerdict';
const BAD_HOST = { code: 'invalid_argument', message: 'the request has no valid Host header' };

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGTERM');
});

async function startSite(): Promise<{ port: number; exited: () => boolean }> {
  const child = spawn(process.execPath, ['--input-type=module', '-e', SERVER], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let exited = false;
  child.on('exit', () => (exited = true));
  const port = await new Promise<number>((resolve) =>
    child.stdout.on('data', (d: Buffer) => {
      const m = /PORT (\d+)/.exec(d.toString());
      if (m) resolve(Number(m[1]));
    }),
  );
  return { port, exited: () => exited };
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

const post = (version: string, host: string | undefined, bearer: boolean) =>
  `POST ${LIST} HTTP/${version}\r\n${host === undefined ? '' : `Host: ${host}\r\n`}${bearer ? 'Authorization: Bearer made-up\r\n' : ''}Content-Type: application/proto\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`;

describe.each([
  ['HTTP/1.0 with no Host', '1.0', undefined],
  ['a Host that is no authority', '1.1', '['],
  ['a port out of range', '1.1', 'x:99999'],
  ['an unclosed IPv6 literal', '1.1', '[::1'],
  ['a Host with user info', '1.1', 'a@b'],
  ['a Host with a path', '1.1', 'x/y'],
  ['a port that is no number', '1.1', 'x:port'],
  ['an empty Host', '1.1', ''],
  ['a Host with a space', '1.1', 'x y'],
] as const)('the machine route given %s', (_label, version, host) => {
  it.each([true, false])('with a bearer: %s, answers 400 with a fixed message, and the site lives on', async (bearer) => {
    const site = await startSite();
    const reply = await raw(site.port, post(version, host, bearer));
    expect(reply.slice(0, 12)).toBe('HTTP/1.1 400');
    expect(JSON.parse(reply.slice(reply.indexOf('\r\n\r\n') + 4))).toEqual(BAD_HOST);
    const page = await raw(site.port, 'GET /about HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    expect(page.slice(0, 12)).toBe('HTTP/1.1 200');
    expect(site.exited()).toBe(false);
  }, 15_000);
});

describe('a valid Host', () => {
  it.each(['127.0.0.1', '127.0.0.1:8080', 'nwflmensa.example.org', '[::1]:65535', 'LOCALHOST'])('%s goes on to the bearer check', async (host) => {
    const site = await startSite();
    const reply = await raw(site.port, post('1.1', host, false));
    expect(reply.slice(0, 12)).toBe('HTTP/1.1 401');
  }, 15_000);
});
