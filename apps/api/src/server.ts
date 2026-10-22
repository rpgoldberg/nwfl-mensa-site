// ============================================================================
// The two listeners and their orderly shutdown.
//
// SHUTDOWN, in order, once close() is called (main.ts calls it on SIGTERM):
//   1. Readiness flips to draining: /readyz answers 503 and grpc.health.v1
//      answers NOT_SERVING, so nothing new is routed here.
//   2. The gRPC listener stops accepting connections, and every open HTTP/2
//      session is asked to close (GOAWAY). Calls already running finish.
//   3. If they have not finished by the drain deadline, the handlers' shutdown
//      signal is aborted and the sessions are destroyed.
//   4. The health listener closes last, so probes can see the drain.
// The database pool and telemetry are closed by the caller, after this.
// ============================================================================
import type http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { type TokenVerifier, rejectAllTokens } from './auth/caller.js';
import type { Db } from './db/pool.js';
import { apiInterceptors } from './grpc/interceptors.js';
import { apiRoutes } from './grpc/routes.js';
import { createGrpcServer } from './grpc/server.js';
import { buildHealthApp } from './health/app.js';
import type { StructuredLogger } from './platform/logger.js';
import { createReadiness } from './readiness.js';

export interface ServerOptions {
  host: string;
  grpcPort: number;
  healthPort: number;
  db: Db;
  logger: StructuredLogger;
  drainTimeoutMs?: number;
  /** Verifies bearer tokens. Default: refuse every token, so callers are public only (A3 supplies the JWKS verifier). */
  verifier?: TokenVerifier;
}

export interface RunningServer {
  readonly grpcPort: number;
  readonly healthPort: number;
  /** Idempotent: a second call returns the same promise. */
  close(): Promise<void>;
}

const DEFAULT_DRAIN_TIMEOUT_MS = 20_000;

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const { logger } = options;
  const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const readiness = createReadiness(options.db);
  const shutdown = new AbortController();

  const grpc = createGrpcServer({
    routes: apiRoutes({ db: options.db, logger, readiness }),
    interceptors: apiInterceptors({ logger, verifier: options.verifier ?? rejectAllTokens }),
    shutdownSignal: shutdown.signal,
  });
  const sessions = new Set<http2.ServerHttp2Session>();
  grpc.on('session', (session: http2.ServerHttp2Session) => {
    sessions.add(session);
    session.once('close', () => sessions.delete(session));
  });
  await new Promise<void>((resolve) => grpc.listen(options.grpcPort, options.host, resolve));

  const health = buildHealthApp({ readiness, logger: logger.child({ component: 'health' }) });
  await health.listen({ port: options.healthPort, host: options.host });

  const grpcPort = (grpc.address() as AddressInfo).port;
  const healthPort = (health.server.address() as AddressInfo).port;
  logger.info({ grpc_port: grpcPort, health_port: healthPort }, 'listening');

  const drainGrpc = async (): Promise<void> => {
    const closed = new Promise<void>((resolve) => grpc.close(() => resolve()));
    for (const session of sessions) session.close();
    let deadline: NodeJS.Timeout | undefined;
    const expired = new Promise<'expired'>((resolve) => {
      deadline = setTimeout(() => resolve('expired'), drainTimeoutMs);
    });
    const outcome = await Promise.race([closed, expired]);
    clearTimeout(deadline);
    if (outcome === 'expired') {
      logger.warn({ open_sessions: sessions.size }, 'drain deadline reached');
      shutdown.abort();
      for (const session of sessions) session.destroy();
      await closed;
    }
  };

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      readiness.startDraining();
      logger.info({ drain_timeout_ms: drainTimeoutMs }, 'draining');
      await drainGrpc();
      await health.close();
      logger.info('drained');
    })();
    return closing;
  };

  return { grpcPort, healthPort, close };
}
