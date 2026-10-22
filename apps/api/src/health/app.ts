// ============================================================================
// The health port (8081): plain HTTP for kubelet, never reachable through the
// mesh policy by any other caller, and never an RPC surface.
//
//   GET /healthz  liveness. The process is up and serving. It does NOT touch
//                 Postgres: a database outage must not restart every pod.
//   GET /readyz   readiness. Postgres answers and shutdown has not begun.
//
// The bodies say which subsystem is unhappy and nothing else: no host, no
// error text, no versions.
// ============================================================================
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import { createStructuredLogger, type StructuredLogger } from '../platform/logger.js';
import type { Readiness } from '../readiness.js';

export interface HealthAppOptions {
  readiness: Readiness;
  logger?: StructuredLogger;
}

export function buildHealthApp(options: HealthAppOptions): FastifyInstance {
  const app = Fastify({
    loggerInstance: options.logger ?? createStructuredLogger({ level: 'silent' }),
    // A probe every few seconds is noise, not an access log.
    logController: new LogController({ disableRequestLogging: true }),
  });

  app.get('/healthz', (_request, reply) => reply.send({ status: 'ok' }));

  app.get('/readyz', async (_request, reply) => {
    const report = await options.readiness.check();
    if (report.ready) return reply.code(200).send({ status: 'ready', db: report.db });
    return reply.code(503).send({ status: report.draining ? 'draining' : 'not_ready', db: report.db });
  });

  return app;
}
