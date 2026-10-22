// ============================================================================
// Process configuration from the environment, validated before anything binds.
//
//   GRPC_PORT     50051  gRPC only, h2c; Linkerd adds mTLS on the mesh hop.
//   HEALTH_PORT    8081  plain HTTP: /healthz (liveness), /readyz (Postgres).
//   HOST        0.0.0.0
//   LOG_LEVEL      info
//   DRAIN_TIMEOUT_MS 20000  how long in-flight calls may finish after SIGTERM;
//                           keep it under the pod's terminationGracePeriod.
// ============================================================================
import { LOG_LEVELS, type LogLevel } from './platform/logger.js';

export interface ServiceConfig {
  host: string;
  grpcPort: number;
  healthPort: number;
  logLevel: LogLevel;
  drainTimeoutMs: number;
}

type Env = Record<string, string | undefined>;

function port(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be a port number between 1 and 65535`);
  }
  return value;
}

export function readConfig(env: Env = process.env): ServiceConfig {
  const grpcPort = port(env, 'GRPC_PORT', 50051);
  const healthPort = port(env, 'HEALTH_PORT', 8081);
  if (grpcPort === healthPort) throw new Error('GRPC_PORT and HEALTH_PORT must differ');

  const logLevel = (env['LOG_LEVEL'] ?? 'info') as LogLevel;
  if (!LOG_LEVELS.includes(logLevel)) throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`);

  const drainTimeoutMs = Number(env['DRAIN_TIMEOUT_MS'] ?? '20000');
  if (!Number.isInteger(drainTimeoutMs) || drainTimeoutMs < 0) {
    throw new Error('DRAIN_TIMEOUT_MS must be a whole number of milliseconds');
  }

  return { host: env['HOST'] ?? '0.0.0.0', grpcPort, healthPort, logLevel, drainTimeoutMs };
}
