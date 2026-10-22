// ============================================================================
// The gRPC port (50051). Cleartext HTTP/2 with prior knowledge (h2c): Linkerd
// terminates and originates mTLS on the mesh hop, so this process never holds
// a certificate.
//
// TRANSPORT RULE N2: this port serves ONLY the gRPC wire protocol. Connect-ES
// serves three protocols by default; the Connect protocol (JSON or binary POST,
// and its GET form) and gRPC-Web are NOT gRPC on the wire, so both are switched
// off and a request in either is refused with 415. The server is a bare
// node:http2 server without `allowHTTP1`, so HTTP/1.1 is not spoken at all.
// test/grpc/transport-rule.test.ts proves each refusal and that a real gRPC
// call succeeds.
// ============================================================================
import type { ConnectRouter, Interceptor } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import http2 from 'node:http2';

export const GRPC_PROTOCOLS = { grpc: true, grpcWeb: false, connect: false } as const;

/**
 * Largest inbound message. Connect's default is ~4 GiB, which would let one
 * caller pin a pod's memory. R11 allows 10 MB attachments, so 12 MiB leaves
 * room for the envelope. Larger payloads must be streamed.
 */
export const READ_MAX_BYTES = 12 * 1024 * 1024;

const GRPC_UNIMPLEMENTED = '12';

export interface GrpcServerOptions {
  routes: (router: ConnectRouter) => void;
  interceptors?: Interceptor[];
  /** Aborted at the drain deadline, so handlers still running can stop. */
  shutdownSignal?: AbortSignal;
}

export function createGrpcServer(options: GrpcServerOptions): http2.Http2Server {
  const handler = connectNodeAdapter({
    ...GRPC_PROTOCOLS,
    routes: options.routes,
    interceptors: options.interceptors ?? [],
    readMaxBytes: READ_MAX_BYTES,
    ...(options.shutdownSignal !== undefined ? { shutdownSignal: options.shutdownSignal } : {}),
    // An unknown method: a gRPC caller gets a trailers-only UNIMPLEMENTED, the
    // answer its client library expects; anything else gets 415, the same
    // answer a non-gRPC request to a known method gets.
    fallback: (request, response) => {
      const contentType = String(request.headers['content-type'] ?? '');
      if (/^application\/grpc(?:\+proto)?$/.test(contentType)) {
        response.writeHead(200, {
          'content-type': 'application/grpc',
          'grpc-status': GRPC_UNIMPLEMENTED,
          'grpc-message': 'unknown method',
        });
      } else {
        response.writeHead(415);
      }
      response.end();
    },
  });
  return http2.createServer(handler);
}
