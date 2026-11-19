// @ts-check
// MACHINE-ROUTE: the machine clients' way in. The link checker (and later the newsletter export) runs on
// an officer's own machine, and Cloudflare's tunnel carries no gRPC on a public hostname, while the API
// speaks gRPC only, inside the mesh. So the site serves exactly two services, LinkCheckService and
// NewsletterService, in the Connect protocol (no gRPC, no gRPC-Web), and forwards each call to the API
// over its own gRPC client, as its pages' reads go (src/lib/api/client.ts). The API does all the auth
// (audience, scope, subject); the site never reads the token.
//
// What a call may be, and what reaches the API:
//   - POST to one method those services define, by its exact path; anything else under the two prefixes
//     is 404, and nothing else of the site changes (policy.mjs MACHINE_PREFIXES; siteServer.mjs mounts
//     the route before Astro);
//   - a bearer, one b64token after "Bearer" in any case, as the API reads it; none is unauthenticated,
//     and never forwarded;
//   - a Host that is an authority (host, optional port); any other is 400. The Host is never used: the
//     call's URL is built on a fixed authority, so no inbound Host can make it unreadable;
//   - a body of at most MACHINE_BODY_MAX bytes (the checker's largest request, 200,000 bytes, and a
//     margin), refused by its Content-Length unread, or as it arrives; read in full within
//     MACHINE_BODY_MS before the call takes a place, so a slow sender holds none; no compressed body;
//   - the API is sent the request message and the caller's Authorization header as written, and the
//     site's own traceparent (LG-N3: a caller's is never continued). Nothing else: no cookie, no Origin;
//   - its answer comes back as it is; a refusal keeps its Connect code, and its message is the route's own
//     fixed text for that code (never the API's, never a library's), with no details;
//   - at most MACHINE_LIMIT calls at once, each forwarded with MACHINE_CALL_MS to answer and dropped at
//     MACHINE_DEADLINE_MS, so the route cannot starve the pages.
// No cookie is read or set here, and every answer is never stored (policy.mjs). One log line per call:
// the method, the code, the time taken and the trace id; never the token, never the body.
import { AsyncResource } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { Code, ConnectError, createConnectRouter, createContextKey, createContextValues } from '@connectrpc/connect';
import { createGrpcTransport, universalResponseToNodeResponse } from '@connectrpc/connect-node';
import { LinkCheckService } from '../src/gen/nwfl/mensa/v1/link_check_pb.js';
import { NewsletterService } from '../src/gen/nwfl/mensa/v1/newsletter_pb.js';
import { apiSetup } from './api-setup.mjs';
import { logEntry } from './log.mjs';
import { traceInterceptor } from './trace.mjs';

/** The largest request body: the checker's record batch (apps/linkcheck items.ts MAX_RECORD_BYTES, 200,000) and a margin. */
export const MACHINE_BODY_MAX = 200 * 1024;
/** The largest answer read from the API, as the site's own reads (src/lib/api/client.ts READ_MAX_BYTES). */
export const MACHINE_READ_MAX = 4 * 1024 * 1024;
/** Calls served at once; one more is refused at once. */
export const MACHINE_LIMIT = 4;
/** The time the API has to answer a forwarded call. */
export const MACHINE_CALL_MS = 30_000;
/** The most a call may take from its first byte: its body, the API's answer and the reply. */
export const MACHINE_DEADLINE_MS = 35_000;
/** The time a call's body has to arrive in full, from its first byte; it holds no place meanwhile. */
export const MACHINE_BODY_MS = 5_000;
/** The authority the call's URL is built on: never the caller's Host. */
const FIXED_AUTHORITY = 'machine-route.invalid';
/** The caller's headers Connect reads; no other is handed on (the forwarder sends only authorization). */
const PASSED_HEADERS = ['content-type', 'content-encoding', 'connect-protocol-version', 'connect-timeout-ms', 'accept-encoding', 'authorization'];
/** The most of a Connect refusal read to learn its code. */
const REFUSAL_READ_MAX = 64 * 1024;

// RFC 6750 b64token, exactly one, after a case-insensitive "Bearer": the API's own reading (apps/api caller.ts).
const BEARER = /^Bearer [A-Za-z0-9\-._~+/]+=*$/i;
// A Host as RFC 9110 has it: a reg-name or an IP literal, then an optional port.
const HOST = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?$/;

/** The route's own words for each Connect code: the only message a refusal carries. */
export const CODE_MESSAGES = Object.freeze({
  canceled: 'the call was cancelled',
  unknown: 'the call failed',
  invalid_argument: 'the request is not valid',
  deadline_exceeded: 'the call took too long',
  not_found: 'not found',
  already_exists: 'it already exists',
  permission_denied: 'the call is not permitted',
  resource_exhausted: 'a limit was reached',
  failed_precondition: 'the call cannot be made now',
  aborted: 'the call was stopped',
  out_of_range: 'a value is out of range',
  unimplemented: 'the call is not served in this form',
  internal: 'the call failed',
  unavailable: 'the service is unavailable',
  data_loss: 'the call failed',
  unauthenticated: 'the bearer token was refused',
});

/**
 * A Host header the site can read as an authority.
 *
 * @param {string | undefined} host
 */
export function validHost(host) {
  const m = HOST.exec(host ?? '');
  return m !== null && (m[1] === undefined || Number(m[1]) <= 65535);
}

/** @typedef {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, path: string) => void | Promise<void>} MachineHandler */
/** @typedef {{ code?: string }} Outcome */

/**
 * A service's methods, each a unary call: the forwarder hands on one message each way.
 *
 * @param {import('@bufbuild/protobuf').DescService} service
 */
export function unaryMethods(service) {
  for (const method of service.methods) if (method.methodKind !== 'unary') throw new Error(`${service.typeName}.${method.name} is not a unary call`);
  return service.methods;
}

/** @param {Code} code the code as Connect writes it, snake case */
const codeName = (code) => Code[code].replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();

/**
 * A refusal the route writes itself, as a Connect error with a fixed plain message. `close` ends the
 * connection once it is sent: the caller's body was not read to its end.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {Outcome} outcome
 * @param {number} status
 * @param {Code} code
 * @param {string} message
 * @param {boolean} [close]
 */
function refuse(res, outcome, status, code, message, close = false) {
  outcome.code = codeName(code);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  if (close) res.setHeader('Connection', 'close');
  res.end(JSON.stringify({ code: outcome.code, message }));
}

class TooLarge extends Error {}
class TooSlow extends Error {}

/**
 * The request's body, read in full: refused past `max` bytes, or when it has not ended by `ms`.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} max
 * @param {number} ms
 * @returns {Promise<Uint8Array>}
 */
function readBody(req, max, ms) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    const stop = (/** @type {Error | undefined} */ error) => {
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('close', onError);
      req.pause();
      if (error) reject(error);
      else resolve(Buffer.concat(chunks, size));
    };
    const onData = (/** @type {Buffer} */ chunk) => {
      size += chunk.length;
      if (size > max) stop(new TooLarge());
      else chunks.push(chunk);
    };
    const onEnd = () => stop(undefined);
    const onError = () => stop(new TooSlow());
    const timer = setTimeout(() => stop(new TooSlow()), ms);
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('close', onError);
  });
}

/**
 * A Connect refusal with the route's fixed message for its code; an answer of any other kind as it is.
 *
 * @param {import('@connectrpc/connect/protocol').UniversalServerResponse} answer
 * @returns {Promise<import('@connectrpc/connect/protocol').UniversalServerResponse>}
 */
async function withFixedMessage(answer) {
  if (answer.status === 200 || answer.body === undefined) return answer;
  /** @type {Uint8Array[]} */
  const chunks = [];
  let size = 0;
  for await (const chunk of answer.body) {
    size += chunk.length;
    if (size > REFUSAL_READ_MAX) break;
    chunks.push(chunk);
  }
  /** @type {unknown} */
  let error;
  try {
    error = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    error = undefined;
  }
  const code = /** @type {{ code?: unknown }} */ (error ?? {}).code;
  const known = typeof code === 'string' && Object.hasOwn(CODE_MESSAGES, code) ? /** @type {keyof typeof CODE_MESSAGES} */ (code) : 'unknown';
  const header = new Headers({ 'content-type': 'application/json' });
  const body = new TextEncoder().encode(JSON.stringify({ code: known, message: CODE_MESSAGES[known] }));
  return { status: answer.status, header, body: (async function* () { yield body; })() };
}

/**
 * The route, forwarding to the API at `config.baseUrl`.
 *
 * @param {import('./api-setup.mjs').ApiConfig} config
 * @param {{ limit?: number, deadlineMs?: number, callTimeoutMs?: number, bodyMs?: number }} [opts]
 * @returns {MachineHandler}
 */
export function createMachineRoute(config, { limit = MACHINE_LIMIT, deadlineMs = MACHINE_DEADLINE_MS, callTimeoutMs = MACHINE_CALL_MS, bodyMs = MACHINE_BODY_MS } = {}) {
  const transport = createGrpcTransport({ baseUrl: config.baseUrl, defaultTimeoutMs: config.timeoutMs, readMaxBytes: MACHINE_READ_MAX, interceptors: [traceInterceptor] });
  /** The methods served, by path, with their names for the log. @type {Map<string, string>} */
  const methods = new Map();
  const OUTCOME = createContextKey(/** @type {Outcome} */ ({}));
  // Connect only, no compression: the router's own handlers, driven here with a request this route builds
  // (a fixed authority, the body already read), so no inbound Host reaches a URL and no slow body a place.
  const router = createConnectRouter({ connect: true, grpc: false, grpcWeb: false, readMaxBytes: MACHINE_BODY_MAX,
    acceptCompression: [],
  });
  for (const service of [LinkCheckService, NewsletterService]) {
    for (const method of unaryMethods(service)) {
      methods.set(`/${service.typeName}/${method.name}`, `${service.name}/${method.name}`);
      // One message each way: the types are the method's own, which the loop cannot name.
      router.rpc(/** @type {any} */ (method), async (/** @type {any} */ message, /** @type {import('@connectrpc/connect').HandlerContext} */ ctx) => {
        const outcome = ctx.values.get(OUTCOME);
        try {
          const answer = await transport.unary(/** @type {any} */ (method), ctx.signal, callTimeoutMs, { authorization: String(ctx.requestHeader.get('authorization')) }, message);
          outcome.code = 'ok';
          return answer.message;
        } catch (error) {
          // The code only: the API's message and details are its own.
          const { code } = ConnectError.from(error);
          outcome.code = codeName(code);
          throw new ConnectError('', code);
        }
      });
    }
  }
  /** The router's handler of each method, by its path. */
  const handlers = new Map(router.handlers.map((handler) => [handler.requestPath, handler]));
  let active = 0;
  return async (req, res, path) => {
    const started = performance.now();
    const rpc = methods.get(path);
    const handler = handlers.get(path);
    /** @type {Outcome} */
    const outcome = {};
    // Bound to the request's context: 'close' fires from the socket, outside it, and the line carries its trace id.
    res.once(
      'close',
      AsyncResource.bind(() => {
        const code = outcome.code ?? `http_${res.statusCode}`;
        console.log(logEntry({ level: code === 'ok' ? 'info' : 'warn', msg: 'machine call', rpc: rpc ?? 'unknown', code, ms: Math.round(performance.now() - started) }));
      }),
    );
    if (rpc === undefined || handler === undefined || req.method !== 'POST') {
      outcome.code = 'not_found';
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Not found');
      return;
    }
    if (!validHost(req.headers.host)) return refuse(res, outcome, 400, Code.InvalidArgument, 'the request has no valid Host header', true);
    if (!BEARER.test(req.headers.authorization ?? '')) return refuse(res, outcome, 401, Code.Unauthenticated, 'a bearer token is needed', true);
    if (Number(req.headers['content-length']) > MACHINE_BODY_MAX) return refuse(res, outcome, 413, Code.ResourceExhausted, 'the request body is too large', true);
    const deadline = setTimeout(() => {
      outcome.code ??= 'deadline_exceeded';
      req.destroy();
      res.destroy();
    }, deadlineMs);
    res.once('close', () => clearTimeout(deadline));
    /** @type {Uint8Array} */
    let body;
    try {
      // Read before the call takes a place: a sender that trickles its body holds none.
      body = await readBody(req, MACHINE_BODY_MAX, bodyMs);
    } catch (error) {
      if (res.destroyed) return;
      if (error instanceof TooLarge) return refuse(res, outcome, 413, Code.ResourceExhausted, 'the request body is too large', true);
      return refuse(res, outcome, 408, Code.DeadlineExceeded, 'the request body did not arrive in time', true);
    }
    if (active >= limit) return refuse(res, outcome, 429, Code.ResourceExhausted, 'too many calls at once; try again shortly');
    active += 1;
    const abort = new AbortController();
    res.once('close', () => {
      active -= 1;
      abort.abort();
    });
    const header = new Headers();
    for (const name of PASSED_HEADERS) {
      const value = req.headers[name];
      if (typeof value === 'string') header.set(name, value);
    }
    const answer = await handler({
      httpVersion: req.httpVersion,
      method: 'POST',
      // A fixed authority: the caller's Host is never read into a URL.
      url: `http://${FIXED_AUTHORITY}${path}`,
      header,
      body: (async function* () {
        yield body;
      })(),
      signal: abort.signal,
      contextValues: createContextValues().set(OUTCOME, outcome),
    });
    // A caller gone while its answer is written: nothing more to do than drop the connection.
    await universalResponseToNodeResponse(await withFixedMessage(answer), res).catch(() => res.destroy());
  };
}

/**
 * The route for this environment: none without a valid API_URL (siteServer.mjs then answers 404 on the
 * prefixes). start.mjs mounts none in a public-only build.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {MachineHandler | undefined}
 */
export function machineRouteFromEnv(env) {
  const setup = apiSetup(env);
  return setup.enabled && 'config' in setup ? createMachineRoute(setup.config) : undefined;
}
