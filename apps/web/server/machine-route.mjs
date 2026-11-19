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
//   - a body of at most MACHINE_BODY_MAX bytes (the checker's largest request, 200,000 bytes, and a
//     margin), refused by its Content-Length unread, or by Connect's own cap as it arrives; no
//     compressed body;
//   - the API is sent the request message and the caller's Authorization header as written, and the
//     site's own traceparent (LG-N3: a caller's is never continued). Nothing else: no cookie, no Origin;
//   - its answer comes back as it is; a refusal keeps its Connect code and loses its message and details;
//   - at most MACHINE_LIMIT calls at once, each forwarded with MACHINE_CALL_MS to answer and dropped at
//     MACHINE_DEADLINE_MS, so the route cannot starve the pages.
// No cookie is read or set here, and every answer is never stored (policy.mjs). One log line per call:
// the method, the code, the time taken and the trace id; never the token, never the body.
import { AsyncResource } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { Code, ConnectError, createContextKey, createContextValues } from '@connectrpc/connect';
import { connectNodeAdapter, createGrpcTransport } from '@connectrpc/connect-node';
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

// RFC 6750 b64token, exactly one, after a case-insensitive "Bearer": the API's own reading (apps/api caller.ts).
const BEARER = /^Bearer [A-Za-z0-9\-._~+/]+=*$/i;

/** @typedef {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, path: string) => void} MachineHandler */
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
 * A refusal the route writes itself, as a Connect error (no message: the code says it).
 *
 * @param {import('node:http').ServerResponse} res
 * @param {Outcome} outcome
 * @param {number} status
 * @param {Code} code
 */
function refuse(res, outcome, status, code) {
  outcome.code = codeName(code);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ code: outcome.code }));
}

/**
 * The route, forwarding to the API at `config.baseUrl`.
 *
 * @param {import('./api-setup.mjs').ApiConfig} config
 * @param {{ limit?: number, deadlineMs?: number, callTimeoutMs?: number }} [opts]
 * @returns {MachineHandler}
 */
export function createMachineRoute(config, { limit = MACHINE_LIMIT, deadlineMs = MACHINE_DEADLINE_MS, callTimeoutMs = MACHINE_CALL_MS } = {}) {
  const transport = createGrpcTransport({ baseUrl: config.baseUrl, defaultTimeoutMs: config.timeoutMs, readMaxBytes: MACHINE_READ_MAX, interceptors: [traceInterceptor] });
  /** The methods served, by path, with their names for the log. @type {Map<string, string>} */
  const methods = new Map();
  /** @type {WeakMap<import('node:http').IncomingMessage, Outcome>} */
  const outcomes = new WeakMap();
  const OUTCOME = createContextKey(/** @type {Outcome} */ ({}));
  const adapter = connectNodeAdapter({
    connect: true,
    grpc: false,
    grpcWeb: false,
    readMaxBytes: MACHINE_BODY_MAX,
    acceptCompression: [],
    contextValues: (req) => createContextValues().set(OUTCOME, outcomes.get(/** @type {import('node:http').IncomingMessage} */ (req)) ?? {}),
    routes: (router) => {
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
    },
  });
  let active = 0;
  return (req, res, path) => {
    const started = performance.now();
    const rpc = methods.get(path);
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
    if (rpc === undefined || req.method !== 'POST') {
      outcome.code = 'not_found';
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Not found');
      return;
    }
    if (!BEARER.test(req.headers.authorization ?? '')) return refuse(res, outcome, 401, Code.Unauthenticated);
    if (Number(req.headers['content-length']) > MACHINE_BODY_MAX) return refuse(res, outcome, 413, Code.ResourceExhausted);
    if (active >= limit) return refuse(res, outcome, 429, Code.ResourceExhausted);
    active += 1;
    const deadline = setTimeout(() => {
      outcome.code ??= 'deadline_exceeded';
      req.destroy();
      res.destroy();
    }, deadlineMs);
    res.once('close', () => {
      active -= 1;
      clearTimeout(deadline);
    });
    outcomes.set(req, outcome);
    // The method's own path: the adapter routes by it, and an encoded form of it is the same call.
    req.url = path;
    adapter(req, res);
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
