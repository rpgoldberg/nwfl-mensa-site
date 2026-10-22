// ============================================================================
// The gRPC port (50051). Cleartext HTTP/2 with prior knowledge (h2c): Linkerd
// terminates and originates mTLS on the mesh hop, so this process never holds
// a certificate.
//
// TRANSPORT RULE N2: this port serves ONLY the gRPC wire protocol, twice over:
//   1. the HTTP/2 layer below admits only `application/grpc` and
//      `application/grpc+proto` (gRPC with JSON is gRPC, but nothing here needs
//      it, so it is refused too) and answers anything else 415;
//   2. the Connect adapter behind it has Connect and gRPC-Web switched off.
// The server is a bare node:http2 server without `allowHTTP1`, so HTTP/1.1 is
// not spoken at all. test/grpc/transport-rule.test.ts proves layer 2 on its
// own; transport-hardening.test.ts proves layer 1 and the bounds below.
//
// BOUNDS, so one caller cannot pin the pod's memory:
//   - MAX_CONCURRENT_STREAMS per connection (HTTP/2 SETTINGS);
//   - MAX_ACTIVE_STREAMS across all connections, refused RESOURCE_EXHAUSTED;
//   - READ_MAX_BYTES per message, checked on the envelope before buffering;
//   - RECEIVE_DEADLINE_MS for the request body: a sender that has not
//     finished by then has its stream cancelled, freeing what was buffered;
//   - MAX_SESSION_MEMORY_MB for HTTP/2 session buffers.
// Worst case held in request buffers: MAX_ACTIVE_STREAMS x READ_MAX_BYTES.
//
// EARLY ERRORS: a call refused before the interceptors run (a bad envelope,
// the size cap, a bad header, a receive deadline) still gets one access-log
// line (request id, method, code; never the payload), and its grpc-message is
// replaced by a fixed text per code, so the reply never echoes caller input.
// ============================================================================
import { Code, type ConnectRouter, type Interceptor, createContextValues } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { randomUUID } from 'node:crypto';
import http2 from 'node:http2';
import type { StructuredLogger } from '../platform/logger.js';
import { codeName } from './interceptors.js';
import { REQUEST_INFO, type RequestInfo } from './request.js';

export const GRPC_PROTOCOLS = { grpc: true, grpcWeb: false, connect: false } as const;

export const ACCEPTED_CONTENT_TYPES: ReadonlySet<string> = new Set(['application/grpc', 'application/grpc+proto']);

/**
 * Largest inbound message: the gRPC default. Every RPC today carries small
 * messages; uploads (R11, PW6) will stream rather than raise this.
 */
export const READ_MAX_BYTES = 4 * 1024 * 1024;
export const MAX_CONCURRENT_STREAMS = 16;
export const MAX_ACTIVE_STREAMS = 32;
export const RECEIVE_DEADLINE_MS = 10_000;
export const MAX_SESSION_MEMORY_MB = 16;

const STATUS_UNIMPLEMENTED = String(Code.Unimplemented);
const STATUS_RESOURCE_EXHAUSTED = String(Code.ResourceExhausted);
// A gRPC path as Connect routes it; anything else is logged as "unknown".
const RPC_PATH = /^\/([A-Za-z0-9_.]+\/[A-Za-z0-9_]+)$/;

/** The fixed grpc-message of an early error: the code's name in words. */
export function fixedMessage(status: number): string {
  return Code[status] === undefined ? 'error' : codeName(status).replace(/_/g, ' ');
}

export interface GrpcServerOptions {
  routes: (router: ConnectRouter) => void;
  interceptors?: Interceptor[];
  /** Aborted at the drain deadline, so handlers still running can stop. */
  shutdownSignal?: AbortSignal;
  /** Where early errors are logged. Without one they are still answered with a fixed message. */
  logger?: StructuredLogger;
  receiveDeadlineMs?: number;
  maxActiveStreams?: number;
}

type NodeHandler = (request: http2.Http2ServerRequest, response: http2.Http2ServerResponse) => void;

/** The Connect adapter alone (layer 2): the gRPC protocol on, Connect and gRPC-Web off. */
export function createConnectHandler(options: GrpcServerOptions, values?: (request: http2.Http2ServerRequest) => ReturnType<typeof createContextValues>): NodeHandler {
  return connectNodeAdapter({
    ...GRPC_PROTOCOLS,
    routes: options.routes,
    interceptors: options.interceptors ?? [],
    readMaxBytes: READ_MAX_BYTES,
    ...(options.shutdownSignal !== undefined ? { shutdownSignal: options.shutdownSignal } : {}),
    ...(values !== undefined ? { contextValues: values as (request: unknown) => ReturnType<typeof createContextValues> } : {}),
    // An unknown method: a gRPC caller gets a trailers-only UNIMPLEMENTED, the
    // answer its client library expects; anything else gets 415, the same
    // answer a non-gRPC request to a known method gets.
    fallback: (request, response) => {
      if (ACCEPTED_CONTENT_TYPES.has(String(request.headers['content-type'] ?? '').toLowerCase())) {
        response.writeHead(200, { 'content-type': 'application/grpc', 'grpc-status': STATUS_UNIMPLEMENTED, 'grpc-message': 'unknown method' });
      } else {
        response.writeHead(415);
      }
      response.end();
    },
  });
}

export function createGrpcServer(options: GrpcServerOptions): http2.Http2Server {
  const { logger } = options;
  const receiveDeadlineMs = options.receiveDeadlineMs ?? RECEIVE_DEADLINE_MS;
  const maxActiveStreams = options.maxActiveStreams ?? MAX_ACTIVE_STREAMS;
  const infos = new WeakMap<http2.Http2ServerRequest, RequestInfo>();
  const connect = createConnectHandler(options, (request) => {
    const values = createContextValues();
    values.set(REQUEST_INFO, infos.get(request));
    return values;
  });
  let active = 0;

  const handler: NodeHandler = (request, response) => {
    const info: RequestInfo = { id: randomUUID(), reached: false };
    infos.set(request, info);
    const rpc = RPC_PATH.exec(request.url.split('?', 1)[0] ?? '')?.[1] ?? 'unknown';
    let status: string | undefined;
    let timedOut = false;

    // Rewrite an early error's message; remember the code for the log line.
    const fix = (headers: unknown): void => {
      if (typeof headers !== 'object' || headers === null) return;
      const record = headers as Record<string, unknown>;
      const raw = record['grpc-status'];
      if (typeof raw !== 'string' && typeof raw !== 'number') return;
      status = String(raw);
      if (!info.reached && status !== '0') record['grpc-message'] = fixedMessage(Number(status));
    };
    const writeHead = response.writeHead.bind(response) as (...args: unknown[]) => http2.Http2ServerResponse;
    response.writeHead = ((...args: unknown[]) => {
      fix(args.at(-1));
      return writeHead(...args);
    });
    const addTrailers = response.addTrailers.bind(response);
    response.addTrailers = (trailers) => {
      fix(trailers);
      addTrailers(trailers);
    };

    active += 1;
    const deadline = setTimeout(() => {
      if (!request.complete) {
        timedOut = true;
        request.stream.close(http2.constants.NGHTTP2_CANCEL);
      }
    }, receiveDeadlineMs);
    request.stream.once('close', () => {
      active -= 1;
      clearTimeout(deadline);
      if (info.reached || logger === undefined) return;
      const code = timedOut ? 'deadline_exceeded' : status !== undefined ? codeName(Number(status)) : undefined;
      logger.info({ rpc, code, http_status: response.statusCode, request_id: info.id, early: true }, 'rpc');
    });

    if (!ACCEPTED_CONTENT_TYPES.has(String(request.headers['content-type'] ?? '').toLowerCase())) {
      response.writeHead(415);
      response.end();
      return;
    }
    if (active > maxActiveStreams) {
      response.writeHead(200, { 'content-type': 'application/grpc', 'grpc-status': STATUS_RESOURCE_EXHAUSTED });
      response.end();
      return;
    }
    connect(request, response);
  };

  return http2.createServer({ settings: { maxConcurrentStreams: MAX_CONCURRENT_STREAMS }, maxSessionMemory: MAX_SESSION_MEMORY_MB }, handler);
}
