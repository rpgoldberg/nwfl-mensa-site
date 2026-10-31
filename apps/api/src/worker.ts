// ============================================================================
// The PDF worker's entrypoint (W-WORKER): `node dist/worker.js`, same image as
// the server. It makes the redacted PDF copies in the background as the
// database role nwfl_worker (src/pdf/worker.ts, 0017). No listener: nothing
// calls it, and it reaches only Postgres. A dead database fails its runs
// (logged; the next run still comes); a crash exits and the kubelet restarts it.
// ============================================================================
import { createStructuredLogger } from './platform/logger.js';
import { startTelemetry } from './platform/telemetry.js';
import { readConfig } from './config.js';
import { runWorker } from './pdf/worker.js';
import { refuseToStart } from './tenant.js';

const config = readConfig();
const telemetry = startTelemetry();
const logger = createStructuredLogger({ name: `${telemetry.state.serviceName}-worker`, level: config.logLevel });

// No job runs until the database is verified to serve TENANT (CF-ISO-0); a database that is down is
// retried with backoff, and only a positive mismatch logs the reason and exits 1.
const worker = runWorker({
  env: process.env,
  tenant: {
    id: config.tenant,
    onRetry: (fields) => logger.warn({ tenant: config.tenant, ...fields }, 'tenant check: the database did not answer; no job runs yet, retrying'),
    onVerified: () => logger.info({ tenant: config.tenant }, 'tenant verified'),
    onMismatch: refuseToStart((message) => logger.error({ tenant: config.tenant }, message)),
  },
  warn: (fields, message) => logger.warn(fields, message),
  onError: (error) => logger.error({ error_name: error instanceof Error ? error.name : 'unknown', error_code: (error as { code?: string }).code }, 'pdf regeneration failed'),
});
logger.info({ service_version: process.env['SERVICE_VERSION'] ?? 'dev' }, 'pdf worker started');

let stopping = false;
const stop = (signal: string): void => {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'stopping');
  setTimeout(() => process.exit(1), config.drainTimeoutMs + 5_000).unref();
  void worker
    .stop()
    .then(() => telemetry.shutdown())
    .then(() => process.exit(0));
};

process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
