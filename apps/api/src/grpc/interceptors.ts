// ============================================================================
// Server interceptors for the gRPC port, outermost first:
//
//   traceServerInterceptor  continues the caller's W3C `traceparent` and opens
//                           a SERVER span for the call, so every line logged
//                           while it runs carries the caller's trace id.
//   accessLogInterceptor    one line per call: method, outcome, duration.
//   authInterceptor         the verified caller, and from it the audience
//                           (auth/caller.ts). Inside the access log, so a
//                           refused token is logged as unauthenticated.
//
// THE ACCESS LOG NEVER READS THE REQUEST MESSAGE (R15). Officer reports,
// minutes and member-typed text all arrive as request messages; the only safe
// log of a body is no log of it. Error MESSAGES are not logged either: a
// driver error can echo the row it refused. An unexpected error is logged by
// class name and reaches the caller as INTERNAL "internal error", so neither
// the log nor the wire carries its text.
// ============================================================================
import {
  type Attributes,
  SpanKind,
  SpanStatusCode,
  context,
  propagation,
  trace,
  type TextMapGetter,
} from '@opentelemetry/api';
import { Code, ConnectError, type Interceptor } from '@connectrpc/connect';
import { type AuthOptions, authInterceptor } from '../auth/caller.js';
import type { StructuredLogger } from '../platform/logger.js';
import { requestInfoOf } from './request.js';

export const TRACER_NAME = 'nwfl-mensa-api/grpc';

/** Connect's headers are WHATWG `Headers`; the propagator needs get/keys accessors. */
export const headersGetter: TextMapGetter<Headers> = {
  get: (carrier, key) => carrier.get(key) ?? undefined,
  keys: (carrier) => [...carrier.keys()],
};

/** `not_found`, `internal`: the gRPC status name in snake case. */
export function codeName(code: Code): string {
  return Code[code].replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
}

function rpcName(req: { service: { typeName: string }; method: { name: string } }): string {
  return `${req.service.typeName}/${req.method.name}`;
}

export function traceServerInterceptor(): Interceptor {
  return (next) => async (req) => {
    const parent = propagation.extract(context.active(), req.header, headersGetter);
    const attributes: Attributes = { 'rpc.system': 'grpc', 'rpc.method': rpcName(req) };
    return trace
      .getTracer(TRACER_NAME)
      .startActiveSpan(rpcName(req), { kind: SpanKind.SERVER, attributes }, parent, async (span) => {
        try {
          return await next(req);
        } catch (error) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          span.setAttribute('rpc.grpc.status_code', ConnectError.from(error).code);
          throw error;
        } finally {
          span.end();
        }
      });
  };
}

export function accessLogInterceptor(logger: StructuredLogger): Interceptor {
  return (next) => async (req) => {
    const started = performance.now();
    const rpc = rpcName(req);
    const info = requestInfoOf(req.contextValues);
    if (info !== undefined) info.reached = true;
    const requestId = info?.id;
    const duration = (): number => Math.round((performance.now() - started) * 10) / 10;
    try {
      const response = await next(req);
      logger.info({ rpc, code: 'ok', duration_ms: duration(), request_id: requestId }, 'rpc');
      return response;
    } catch (error) {
      if (error instanceof ConnectError) {
        logger.info({ rpc, code: codeName(error.code), duration_ms: duration(), request_id: requestId }, 'rpc');
        throw error;
      }
      const name = error instanceof Error ? error.name : typeof error;
      logger.error({ rpc, code: codeName(Code.Internal), error: name, duration_ms: duration(), request_id: requestId }, 'rpc');
      throw new ConnectError('internal error', Code.Internal);
    }
  };
}

/** The production chain, outermost first. */
export function apiInterceptors(options: { logger: StructuredLogger } & AuthOptions): Interceptor[] {
  const { logger, ...auth } = options;
  return [traceServerInterceptor(), accessLogInterceptor(logger.child({ component: 'grpc' })), authInterceptor(auth)];
}
