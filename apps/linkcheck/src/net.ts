// ============================================================================
// The checker's only way out to the network (SPEC D4, SSRF; the home LAN is the target):
//   - every hop's URL is read by parseLink: http or https, ports 80 and 443, no credentials;
//   - a host on the no-fetch list or a login-walled host is never resolved nor requested;
//   - the name is resolved here (dns.ts), every address must be global unicast, and the socket is
//     opened to that very address (pinned: nothing resolves the name again), with TLS verified
//     against the name (SNI and the certificate check use the host, never the address);
//   - redirects are followed by hand, at most 5, and every hop is checked again from the top;
//   - each hop has one deadline (10 s) for the connection, the headers and the body; a body is read
//     to at most 256 KiB (a caller may ask for more: the RDAP bootstrap file, 1 MiB), and a compressed
//     one is inflated to at most the same, so a gzip bomb stays small. Compression is not asked for;
//   - no cookie is ever sent (Set-Cookie is ignored), no script runs and no form is sent: a body is
//     text handed to the caller, which treats it as data, never as instructions;
//   - the User-Agent names us.
// ============================================================================
import { type IncomingMessage, request } from 'node:http';
import { isIP, connect as netConnect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { checkServerIdentity, connect as tlsConnect } from 'node:tls';
import { constants, createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { type Dns, resolveAddresses } from './dns.js';
import { isLoginWalled, isNoFetch, parseLink } from './urls.js';

export const LIMITS = { maxRedirects: 5, bodyBytes: 256 * 1024, hopMs: 10_000 };
export type Limits = typeof LIMITS;

export const USER_AGENT = 'nwfl-mensa-linkcheck/0.1 (+https://nwflorida.us/; checks the links in the Northwest Florida Mensa newsletter)';

export interface Target {
  address: string;
  family: 4 | 6;
  port: number;
  /** The name, for SNI, the certificate check and the Host header. */
  host: string;
  tls: boolean;
}

/** Opens a connected socket (TLS done, when asked) to exactly the target's address. */
export type Connect = (target: Target, signal: AbortSignal) => Promise<Duplex>;

/** The production connect. `ca` replaces the trust store (tests only give their own CA). */
export function makeConnect(options: { ca?: string } = {}): Connect {
  return (target, signal) =>
    new Promise<Duplex>((resolve, reject) => {
      let socket: Socket;
      const fail = (error: Error): void => {
        socket.destroy();
        reject(error);
      };
      if (target.tls) {
        socket = tlsConnect({
          host: target.address,
          port: target.port,
          ...(isIP(target.host) === 0 ? { servername: target.host } : {}),
          // The certificate is checked against the name, not the address dialled.
          checkServerIdentity: (_host, cert) => checkName(target.host, cert),
          ALPNProtocols: ['http/1.1'],
          minVersion: 'TLSv1.2',
          ...(options.ca === undefined ? {} : { ca: options.ca }),
        });
        socket.once('secureConnect', () => resolve(socket));
      } else {
        socket = netConnect({ host: target.address, port: target.port, family: target.family });
        socket.once('connect', () => resolve(socket));
      }
      socket.once('error', fail);
      signal.addEventListener('abort', () => fail(Object.assign(new Error('timeout'), { code: 'ABORT_ERR' })), { once: true });
    });
}

const checkName = (host: string, cert: Parameters<typeof checkServerIdentity>[1]): Error | undefined => checkServerIdentity(host, cert);

export type HopFailure =
  | 'no-fetch'
  | 'login-walled'
  | 'scheme'
  | 'port'
  | 'credentials'
  | 'malformed'
  | 'too-long'
  | 'control'
  | 'nxdomain'
  | 'nodata'
  | 'dns-failure'
  | 'private-address'
  | 'timeout'
  | 'tls'
  | 'unreachable'
  | 'protocol'
  | 'too-many-redirects';

export interface Hop {
  url: string;
  address?: string;
  status?: number;
}

export interface Fetched {
  hops: Hop[];
  /** The last hop reached: the answer, or where it stopped. */
  final: Hop;
  /** Why it stopped short of an answer. */
  failure?: HopFailure;
  /** The final answer's text, for text and JSON types; undefined for other types or an encoding it does not read. */
  body?: string;
  truncated?: boolean;
  contentType?: string;
  /** Whether a redirect went from https down to http. */
  downgraded: boolean;
}

export interface NetDeps {
  dns: Dns;
  connect: Connect;
  limits?: Partial<Limits>;
}

export interface FollowOptions {
  accept?: string;
  bodyBytes?: number;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const TEXTUAL = /^(text\/|application\/([a-z0-9.+-]*\+)?json\b|application\/(xhtml\+)?xml\b)/i;

class HopError extends Error {
  constructor(readonly failure: HopFailure) {
    super(failure);
  }
}

function classify(error: unknown): HopFailure {
  if (error instanceof HopError) return error.failure;
  const { code: rawCode, message: rawText } = error as { code?: unknown; message?: unknown };
  const code = typeof rawCode === 'string' ? rawCode : '';
  const text = typeof rawText === 'string' ? rawText : '';
  if (code === 'ABORT_ERR') return 'timeout';
  if (code.startsWith('HPE_')) return 'protocol';
  if (/^(ERR_TLS|ERR_SSL|CERT_|UNABLE_TO|DEPTH_ZERO|SELF_SIGNED|ERR_OSSL|HOSTNAME_MISMATCH)/.test(code) || /SSL|TLS|certificate|altnames/i.test(text)) return 'tls';
  return 'unreachable';
}

interface Answer {
  status: number;
  location?: string;
  contentType?: string;
  encoding?: string;
  raw: Buffer;
  truncated: boolean;
}

/** One GET over a socket already open to the pinned address. Resolves at the headers' arrival plus the body, or the deadline. */
function get(socket: Duplex, url: URL, accept: string, bodyBytes: number, signal: AbortSignal): Promise<Answer> {
  return new Promise<Answer>((resolve, reject) => {
    let response: IncomingMessage | undefined;
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (truncated: boolean): void => {
      if (done || response === undefined) return;
      done = true;
      const header = (name: string): string | undefined => {
        const value = (response as IncomingMessage).headers[name];
        return typeof value === 'string' ? value : undefined;
      };
      resolve({
        status: response.statusCode ?? 0,
        location: header('location'),
        contentType: header('content-type'),
        encoding: header('content-encoding')?.trim().toLowerCase(),
        raw: Buffer.concat(chunks).subarray(0, bodyBytes),
        truncated,
      });
      req.destroy();
    };
    const req = request({
      createConnection: () => socket,
      method: 'GET',
      path: `${url.pathname}${url.search}`,
      setHost: false,
      headers: { Host: url.host, 'User-Agent': USER_AGENT, Accept: accept, 'Accept-Encoding': 'identity', 'Accept-Language': 'en' },
    });
    signal.addEventListener(
      'abort',
      () => {
        if (response !== undefined) finish(true);
        else if (!done) {
          done = true;
          req.destroy();
          reject(new HopError('timeout'));
        }
      },
      { once: true },
    );
    req.once('response', (res) => {
      response = res;
      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        size += chunk.length;
        if (size >= bodyBytes) finish(true);
      });
      res.once('end', () => finish(false));
      res.once('error', () => finish(true));
    });
    req.once('error', (error) => {
      if (done) return;
      done = true;
      reject(error);
    });
    req.end();
  });
}

/** A compressed body inflated to at most `cap` bytes; a bomb is cut there. Undefined for an encoding not read. */
function inflate(raw: Buffer, encoding: string | undefined, cap: number): Promise<{ body: Buffer; truncated: boolean } | undefined> {
  if (encoding === undefined || encoding === '' || encoding === 'identity') return Promise.resolve({ body: raw, truncated: false });
  const flush = { finishFlush: constants.Z_SYNC_FLUSH };
  const stream = encoding === 'gzip' || encoding === 'x-gzip' ? createGunzip(flush) : encoding === 'deflate' ? createInflate(flush) : encoding === 'br' ? createBrotliDecompress() : undefined;
  if (stream === undefined) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (truncated: boolean): void => {
      if (done) return;
      done = true;
      stream.destroy();
      resolve({ body: Buffer.concat(chunks).subarray(0, cap), truncated });
    };
    stream.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= cap) finish(true);
    });
    stream.once('end', () => finish(false));
    stream.once('error', () => finish(chunks.length > 0));
    stream.end(raw);
  });
}

function decodeText(body: Buffer, contentType: string | undefined): string {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType ?? '')?.[1];
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

/** A URL fetched by the rules above, redirects followed by hand. Never throws: a failure is reported in the result. */
export async function follow(start: string, deps: NetDeps, options: FollowOptions = {}): Promise<Fetched> {
  const limits = { ...LIMITS, ...deps.limits };
  const bodyBytes = options.bodyBytes ?? limits.bodyBytes;
  const accept = options.accept ?? 'text/html,text/plain;q=0.9,*/*;q=0.5';
  const hops: Hop[] = [];
  let downgraded = false;
  let next = start;
  const stop = (failure: HopFailure, hop: Hop): Fetched => ({ hops, final: hop, failure, downgraded });
  for (let redirects = 0; ; redirects += 1) {
    const parsed = parseLink(next);
    const hop: Hop = { url: parsed.ok ? parsed.link.url : next };
    hops.push(hop);
    if (!parsed.ok) return stop(parsed.reason, hop);
    if (parsed.link.kind !== 'web') return stop('scheme', hop);
    const { host } = parsed.link;
    if (isNoFetch(host)) return stop('no-fetch', hop);
    if (isLoginWalled(host)) return stop('login-walled', hop);
    const resolved = await resolveAddresses(host, deps.dns);
    if (!resolved.ok) return stop(resolved.reason, hop);
    const url = new URL(parsed.link.url);
    const tls = url.protocol === 'https:';
    const port = url.port === '' ? (tls ? 443 : 80) : Number(url.port);
    let answer: Answer | undefined;
    let failure: HopFailure = 'unreachable';
    for (const { address, family } of resolved.addresses.slice(0, 2)) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), limits.hopMs);
      try {
        hop.address = address;
        const socket = await deps.connect({ address, family, port, host, tls }, controller.signal);
        answer = await get(socket, url, accept, bodyBytes, controller.signal);
        break;
      } catch (error) {
        failure = classify(error);
        if (failure !== 'unreachable') break;
      } finally {
        clearTimeout(timer);
      }
    }
    if (answer === undefined) return stop(failure, hop);
    hop.status = answer.status;
    if (REDIRECTS.has(answer.status) && answer.location !== undefined) {
      if (redirects === limits.maxRedirects) return stop('too-many-redirects', hop);
      let target: URL;
      try {
        target = new URL(answer.location, url);
      } catch {
        hops.push({ url: answer.location.slice(0, 2048) });
        return stop('malformed', hops.at(-1) as Hop);
      }
      if (tls && target.protocol === 'http:') downgraded = true;
      next = target.href;
      continue;
    }
    const result: Fetched = { hops, final: hop, downgraded, truncated: answer.truncated };
    if (answer.contentType !== undefined) result.contentType = answer.contentType;
    if (answer.contentType === undefined || TEXTUAL.test(answer.contentType)) {
      const inflated = await inflate(answer.raw, answer.encoding, bodyBytes);
      if (inflated !== undefined) {
        result.body = decodeText(inflated.body, answer.contentType);
        result.truncated = answer.truncated || inflated.truncated;
      }
    }
    return result;
  }
}
