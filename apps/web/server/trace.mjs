// @ts-check
// LG-N3: the request's W3C trace. The site is the public edge, so every request gets a trace
// minted here; a traceparent a browser sends is never continued (an outsider would choose the id
// our logs and the API's request_id carry). Every API call made while serving the request sends
// it (traceInterceptor), and every line logged meanwhile carries its trace id (log.mjs).
//
// The store lives on globalThis: the server bundle carries its own copy of this module beside the
// one siteServer.mjs loads, and both must see the same request (as token-store.mjs does).
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

/** @typedef {{ traceId: string, spanId: string }} Trace */

const SHARED = Symbol.for('nwfl-mensa.trace');

/** @returns {AsyncLocalStorage<Trace>} */
function store() {
  const global = /** @type {Record<symbol, AsyncLocalStorage<Trace> | undefined>} */ (/** @type {unknown} */ (globalThis));
  return (global[SHARED] ??= new AsyncLocalStorage());
}

/** `bytes` random bytes as lower-case hex, never all zeros (W3C reads an all-zero id as invalid). */
function randomId(/** @type {number} */ bytes) {
  for (;;) {
    const id = randomBytes(bytes).toString('hex');
    if (!/^0+$/.test(id)) return id;
  }
}

/** @returns {Trace} a new trace id and the site's span id within it */
export function newTrace() {
  return { traceId: randomId(16), spanId: randomId(8) };
}

/**
 * The W3C traceparent for a trace, sampled: the site is the root, and a span the API records
 * belongs to it.
 *
 * @param {Trace} trace
 */
export function traceparent(trace) {
  return `00-${trace.traceId}-${trace.spanId}-01`;
}

/**
 * @template T
 * @param {Trace} trace
 * @param {() => T} fn
 * @returns {T}
 */
export function runWithTrace(trace, fn) {
  return store().run(trace, fn);
}

/** @returns {Trace | undefined} the trace of the request being served, if any */
export function currentTrace() {
  return store().getStore();
}

/**
 * Sends the request's traceparent on every call a client makes while serving it.
 *
 * @type {import('@connectrpc/connect').Interceptor}
 */
export const traceInterceptor = (next) => async (req) => {
  const trace = currentTrace();
  if (trace) req.header.set('traceparent', traceparent(trace));
  return next(req);
};
