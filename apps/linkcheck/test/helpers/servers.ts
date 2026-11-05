// HTTP and HTTPS stand-in servers on the container's loopback, and the fake DNS and connect the
// checker is driven with: a name resolves to a made-up public address, and the connect rewrites only
// where the socket goes (to the stand-in's port), handing the production connect the same target
// otherwise, so the pinning, SNI and certificate check run as they do for real.
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { DnsFailure, type Dns } from '../../src/dns.js';
import { type Connect, type Target, makeConnect } from '../../src/net.js';
import { type TestPki, testPki } from './cert.js';

export type Route = (req: IncomingMessage, res: ServerResponse) => void;

export interface Stand {
  port: number;
  server: Server;
  close(): Promise<void>;
}

async function listen(server: Server): Promise<Stand> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    server,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export const startHttp = (route: Route): Promise<Stand> => listen(createServer(route));

export const startHttps = (route: Route, pki: TestPki): Promise<Stand> => listen(createTlsServer({ key: pki.key, cert: pki.cert }, route));

/** A DNS from a table: name -> addresses (v4 and v6 by form), or a failure code. MX and NS from their own tables. */
export function fakeDns(table: Record<string, string[] | DnsFailure['code']>, extra: { mx?: Record<string, { exchange: string; priority: number }[] | DnsFailure['code']>; ns?: Record<string, string[] | DnsFailure['code']> } = {}): Dns & { calls: string[] } {
  const calls: string[] = [];
  const pick = (entry: string[] | DnsFailure['code'] | undefined, filter: (a: string) => boolean): string[] => {
    if (entry === undefined) throw new DnsFailure('nxdomain');
    if (typeof entry === 'string') throw new DnsFailure(entry);
    const out = entry.filter(filter);
    if (out.length === 0) throw new DnsFailure('nodata');
    return out;
  };
  return {
    calls,
    resolve4: (host) => (calls.push(`A ${host}`), Promise.resolve().then(() => pick(table[host], (a) => !a.includes(':')))),
    resolve6: (host) => (calls.push(`AAAA ${host}`), Promise.resolve().then(() => pick(table[host], (a) => a.includes(':')))),
    resolveMx: (host) =>
      (calls.push(`MX ${host}`),
      Promise.resolve().then(() => {
        const entry = extra.mx?.[host];
        if (entry === undefined) throw new DnsFailure('nodata');
        if (typeof entry === 'string') throw new DnsFailure(entry);
        return entry;
      })),
    resolveNs: (host) => (calls.push(`NS ${host}`), Promise.resolve().then(() => pick(extra.ns?.[host] ?? 'nodata', () => true))),
  };
}

/** The production connect, with each made-up public address sent to a stand-in's loopback port instead. */
export function routedConnect(routes: Record<string, number>, ca?: string): Connect & { targets: Target[] } {
  const real = makeConnect(ca === undefined ? {} : { ca });
  const targets: Target[] = [];
  const connect = (target: Target, signal: AbortSignal) => {
    targets.push(target);
    const port = routes[`${target.address}:${target.port}`] ?? routes[target.address];
    if (port === undefined) return Promise.reject(Object.assign(new Error('no route'), { code: 'ECONNREFUSED' }));
    return real({ ...target, address: '127.0.0.1', family: 4, port }, signal);
  };
  return Object.assign(connect, { targets });
}

export { testPki };
