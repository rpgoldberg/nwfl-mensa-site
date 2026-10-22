// ============================================================================
// Process entrypoint: configuration, telemetry, the pool, both listeners, and
// the signal path. No logic of its own; everything here is covered through
// startServer() and the modules it wires.
//
// Telemetry starts BEFORE anything logs, so the first line already has a real
// provider behind it.
// ============================================================================
import { readConfig } from './config.js';
import { createPool, describeTarget } from './db/pool.js';
import { createStructuredLogger } from './platform/logger.js';
import { startTelemetry } from './platform/telemetry.js';
import { startServer } from './server.js';

const config = readConfig();
const telemetry = startTelemetry();
const logger = createStructuredLogger({ name: telemetry.state.serviceName, level: config.logLevel });
const pool = createPool();

// The database target is logged once here, for operators; no endpoint reports it.
logger.info({ db_target: describeTarget(), service_version: process.env['SERVICE_VERSION'] ?? 'dev' }, 'starting');

const server = await startServer({
  host: config.host,
  grpcPort: config.grpcPort,
  healthPort: config.healthPort,
  db: pool,
  logger,
  drainTimeoutMs: config.drainTimeoutMs,
});

let stopping = false;
const stop = (signal: string): void => {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'stopping');
  // Backstop: if the drain itself wedges, leave anyway, before the kubelet's
  // SIGKILL. unref'd, so it never holds a clean exit open.
  setTimeout(() => process.exit(1), config.drainTimeoutMs + 5_000).unref();
  void server
    .close()
    .then(() => pool.end())
    .then(() => telemetry.shutdown())
    .then(() => process.exit(0));
};

process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
