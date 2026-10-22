// ============================================================================
// OpenTelemetry bootstrap. There is no trace collector in the estate yet (P7),
// so nothing is exported; the provider exists so that every log line and every
// outbound hop carries a REAL, non-zero trace id (fc-shared reads an all-zero
// id as "no span", which silently drops the trace tag from logs).
//
//   1. An AsyncLocalStorage context manager, registered EXPLICITLY, so the
//      active span survives an `await`.
//   2. The W3C trace-context propagator, so an inbound `traceparent` is
//      continued (grpc/interceptors.ts) rather than replaced.
//   3. A real TracerProvider (SDK 3.0, @opentelemetry/sdk-trace) with no span
//      processor: spans record and carry ids, and go nowhere.
//
// When a collector lands, add a span processor with a redacting exporter here.
// ============================================================================
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from '@opentelemetry/core';
import { TracerProvider } from '@opentelemetry/sdk-trace';

export const DEFAULT_SERVICE_NAME = 'nwfl-mensa-api';

export interface TelemetryState {
  registered: boolean;
  serviceName: string;
}

export interface Telemetry {
  readonly state: TelemetryState;
  /** The context manager actually registered, exposed so rule 1 is assertable. */
  readonly contextManager: AsyncLocalStorageContextManager;
  shutdown(): Promise<void>;
}

export function startTelemetry(options: { serviceName?: string } = {}): Telemetry {
  const serviceName = options.serviceName ?? DEFAULT_SERVICE_NAME;

  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  context.setGlobalContextManager(contextManager);

  propagation.setGlobalPropagator(
    new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()] }),
  );

  const provider = new TracerProvider();
  trace.setGlobalTracerProvider(provider);

  return {
    state: { registered: true, serviceName },
    contextManager,
    shutdown: async () => {
      await provider.shutdown();
      contextManager.disable();
      trace.disable();
      context.disable();
      propagation.disable();
    },
  };
}
