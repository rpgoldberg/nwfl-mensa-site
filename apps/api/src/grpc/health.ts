// ============================================================================
// grpc.health.v1.Health, the standard gRPC health service, answered from the
// same readiness as /readyz. Only the whole server ("") is known; per-service
// health would claim a granularity this process does not have. Watch is left
// unimplemented, which the protocol tells clients not to retry.
// ============================================================================
import { Code, ConnectError, type ConnectRouter } from '@connectrpc/connect';
import { Health, HealthCheckResponse_ServingStatus as ServingStatus } from '../gen/grpc/health/v1/health_pb.js';
import type { Readiness } from '../readiness.js';

const OVERALL = '';

export function healthRoutes(readiness: Readiness): (router: ConnectRouter) => void {
  const overall = async (): Promise<ServingStatus> =>
    (await readiness.check()).ready ? ServingStatus.SERVING : ServingStatus.NOT_SERVING;

  return (router) => {
    router.service(Health, {
      check: async (request) => {
        if (request.service !== OVERALL) throw new ConnectError('unknown service', Code.NotFound);
        return { status: await overall() };
      },
      list: async () => ({ statuses: { [OVERALL]: { status: await overall() } } }),
    });
  };
}
