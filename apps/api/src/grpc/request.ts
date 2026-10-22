// ============================================================================
// Per-request facts shared between the HTTP/2 layer (grpc/server.ts) and the
// interceptors: the request id every access-log line carries, and whether the
// call reached the interceptors at all. A call that did not (a bad envelope, a
// size cap, a bad header) is logged and answered by the HTTP/2 layer instead.
// ============================================================================
import { type ContextValues, createContextKey } from '@connectrpc/connect';

export interface RequestInfo {
  readonly id: string;
  /** Set by the access log once the call is inside the interceptor chain. */
  reached: boolean;
}

export const REQUEST_INFO = createContextKey<RequestInfo | undefined>(undefined, { description: 'request id and progress' });

export function requestInfoOf(values: ContextValues): RequestInfo | undefined {
  return values.get(REQUEST_INFO);
}
