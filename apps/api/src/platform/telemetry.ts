// ============================================================================
// OpenTelemetry bootstrap.
//
//   1. An AsyncLocalStorage context manager, registered EXPLICITLY, so the
//      active span survives an `await`.
//   2. The W3C trace-context propagator, so an inbound `traceparent` is
//      continued (grpc/interceptors.ts) rather than replaced. Trace context
//      ONLY (LG-N3): no baggage propagator, so a caller's baggage header can
//      carry nothing into a span or onward.
//   3. A real TracerProvider (SDK 3.0, @opentelemetry/sdk-trace), so every log
//      line and every outbound hop carries a REAL, non-zero trace id (fc-shared
//      reads an all-zero id as "no span", which silently drops the trace tag
//      from logs).
//   4. Trace export (LG-N6), OFF unless an endpoint is configured. With
//      neither OTEL_EXPORTER_OTLP_TRACES_ENDPOINT nor
//      OTEL_EXPORTER_OTLP_ENDPOINT set to something visible, the provider has
//      no span processor: spans record, carry ids and go nowhere. The same
//      with OTEL_SDK_DISABLED=true, or OTEL_TRACES_EXPORTER set to anything
//      but `otlp`, whatever the endpoint says. Otherwise, with an endpoint
//      set, spans go to an OTLP gRPC collector through a batch processor, and
//      every span is redacted first (span-redaction.ts).
//
// Export never holds a call up and never takes the process down. Ending a
// span only puts it on a bounded queue; a full queue drops the span and counts
// it. A collector that is unreachable, slow, refusing or misconfigured costs
// the spans of that batch, which are counted too. A bad endpoint is refused at
// start with one log line and the API runs without export. Shutdown flushes,
// up to a deadline.
// ============================================================================
import { TraceFlags, context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { ExportResultCode, W3CTraceContextPropagator, type ExportResult } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { BatchSpanProcessor, TracerProvider, type ReadableSpan, type SpanExporter, type SpanProcessor } from '@opentelemetry/sdk-trace';
import { seenText } from './seen.js';
import { exportResource, redactSpan, type SpanResource } from './span-redaction.js';

export const DEFAULT_SERVICE_NAME = 'nwfl-mensa-api';

export interface TelemetryState {
  registered: boolean;
  serviceName: string;
}

/** The signal's own endpoint. It wins over the general one. */
export const TRACES_ENDPOINT_ENV = 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT';
/** The endpoint for every signal: used when the traces one is unset or blank. */
export const GENERAL_ENDPOINT_ENV = 'OTEL_EXPORTER_OTLP_ENDPOINT';

/** `true` (any case) switches export off. The SDK still makes trace ids for the log lines. */
export const SDK_DISABLED_ENV = 'OTEL_SDK_DISABLED';
/** Unset or `otlp`: export as the endpoint says. Anything else, `none` included: off. */
export const TRACES_EXPORTER_ENV = 'OTEL_TRACES_EXPORTER';

export type TraceExport =
  | { state: 'off' }
  /** Switched off by a standard variable, named here, whatever the endpoint says. */
  | { state: 'disabled'; env: string }
  | { state: 'on'; env: string; endpoint: string }
  /** Configured, but not usable: nothing is exported. The reason never repeats the value. */
  | { state: 'refused'; env: string; reason: string };

export interface TraceExportCounts {
  /** Sampled spans that were put on the queue. Each ends up in exactly one of the counts below. */
  accepted: number;
  exported: number;
  /** Ended while the queue was full. Not part of `accepted`. */
  dropped_queue_full: number;
  /** In a batch the collector did not take: unreachable, refused, timed out, or not readable. */
  dropped_export_failed: number;
  /** Still waiting, or in flight, when the shutdown deadline passed. */
  dropped_at_shutdown: number;
}

export interface TraceExportSettings {
  /** Spans that may wait. One more is dropped. */
  maxQueueSize: number;
  maxExportBatchSize: number;
  /** How long a span waits for its batch to fill. */
  scheduledDelayMillis: number;
  /** The most one export call may take. */
  exportTimeoutMillis: number;
  /** The most shutdown waits for the last flush. */
  shutdownTimeoutMillis: number;
}

export const DEFAULT_TRACE_EXPORT_SETTINGS: TraceExportSettings = {
  maxQueueSize: 2_048,
  maxExportBatchSize: 512,
  scheduledDelayMillis: 5_000,
  exportTimeoutMillis: 5_000,
  // main.ts leaves five seconds between the drain deadline and its backstop exit.
  shutdownTimeoutMillis: 2_000,
};

const REFUSED_NOT_HTTP = 'the endpoint must be an http or https URL';
const REFUSED_HIDDEN = 'the endpoint has characters that are not shown';
const REFUSED_EXTRAS = 'the endpoint must not carry a user, a path, a query or a fragment';
const REFUSED_EXPORTER = 'the exporter could not be built';

/**
 * Where traces go, from the environment. The traces endpoint wins over the general one; a value that
 * is unset, empty or made only of characters that draw nothing counts as unset, so the general one is
 * read next. The first value that is set decides: when it is refused, the other is not tried. The two
 * standard off switches are read before either.
 */
export function readTraceEndpoint(env: Record<string, string | undefined>): TraceExport {
  // The SDK itself stays on either way: log lines need its trace ids. Only export is switched off.
  if (seenText(env[SDK_DISABLED_ENV] ?? '')?.toLowerCase() === 'true') return { state: 'disabled', env: SDK_DISABLED_ENV };
  // Only OTLP is built in. Any other choice, `none` or one this service does not know, exports nothing.
  const exporter = env[TRACES_EXPORTER_ENV];
  if (exporter !== undefined && seenText(exporter) !== null && exporter.trim().toLowerCase() !== 'otlp') return { state: 'disabled', env: TRACES_EXPORTER_ENV };
  for (const name of [TRACES_ENDPOINT_ENV, GENERAL_ENDPOINT_ENV]) {
    const given = env[name];
    if (given === undefined || seenText(given) === null) continue;
    const text = given.trim();
    if (seenText(given) !== text) return { state: 'refused', env: name, reason: REFUSED_HIDDEN };
    const url = URL.parse(text);
    if (url === null || (url.protocol !== 'http:' && url.protocol !== 'https:')) return { state: 'refused', env: name, reason: REFUSED_NOT_HTTP };
    if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '' || /[?#]/.test(text)) {
      return { state: 'refused', env: name, reason: REFUSED_EXTRAS };
    }
    // gRPC has no default port of its own; a URL without one means its scheme's.
    const port = url.port !== '' ? url.port : url.protocol === 'https:' ? '443' : '80';
    return { state: 'on', env: name, endpoint: `${url.protocol}//${url.hostname}:${port}` };
  }
  return { state: 'off' };
}

const FAILED: ExportResult = { code: ExportResultCode.FAILED };

/** Failed batches in a row before the exporter is replaced: three, so 15 s at the default pace. */
const REBUILD_AFTER_FAILED_BATCHES = 3;

/** Close an exporter, whatever it answers. */
const close = (exporter: SpanExporter): Promise<void> =>
  Promise.resolve()
    .then(() => exporter.shutdown())
    .catch(() => undefined);

/**
 * The queue's bound, the redaction and the counts, around the SDK's batch processor and the OTLP
 * exporter. The processor half refuses a span when as many wait as the queue holds, so the batch
 * processor's own queue never overflows unseen; the exporter half is told of each batch as it is taken.
 */
class RedactingExport implements SpanProcessor {
  readonly counts: TraceExportCounts = { accepted: 0, exported: 0, dropped_queue_full: 0, dropped_export_failed: 0, dropped_at_shutdown: 0 };
  private readonly batches: BatchSpanProcessor;
  private inner: SpanExporter;
  private waiting = 0;
  private failedInARow = 0;
  private closed = false;

  constructor(
    private readonly build: () => SpanExporter,
    private readonly resource: SpanResource,
    private readonly settings: TraceExportSettings,
  ) {
    this.inner = build();
    this.batches = new BatchSpanProcessor({
      // The inner exporter is closed in shutdown() below, deadline or not, so not from here.
      exporter: { export: (spans, done) => this.send(spans, done), shutdown: () => Promise.resolve() },
      maxQueueSize: settings.maxQueueSize,
      maxExportBatchSize: settings.maxExportBatchSize,
      scheduledDelayMillis: settings.scheduledDelayMillis,
      // The exporter's own deadline ends a slow call; this one is the batch processor's backstop.
      exportTimeoutMillis: settings.exportTimeoutMillis + 1_000,
    });
  }

  onStart(): void {}

  /** Synchronous and constant-time: the call that ended the span waits for nothing. */
  onEnd(span: ReadableSpan): void {
    if (this.closed || (span.spanContext().traceFlags & TraceFlags.SAMPLED) === 0) return;
    if (this.waiting >= this.settings.maxQueueSize) {
      this.counts.dropped_queue_full += 1;
      return;
    }
    this.waiting += 1;
    this.counts.accepted += 1;
    this.batches.onEnd(span);
  }

  private send(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    this.waiting -= spans.length;
    let settled = false;
    const settle = (result: ExportResult): void => {
      if (settled) return;
      settled = true;
      // After the shutdown deadline the batch is already counted as left behind.
      if (!this.closed) {
        const sent = result.code === ExportResultCode.SUCCESS;
        this.counts[sent ? 'exported' : 'dropped_export_failed'] += spans.length;
        this.failedInARow = sent ? 0 : this.failedInARow + 1;
        if (this.failedInARow >= REBUILD_AFTER_FAILED_BATCHES) this.rebuild();
      }
      done(result);
    };
    try {
      this.inner.export(
        spans.map((span) => redactSpan(span, this.resource)),
        settle,
      );
    } catch {
      settle(FAILED);
    }
  }

  /**
   * A connection can end up unusable for good while the collector is healthy again (an answer larger
   * than the client accepts leaves it refusing every later call). So after a few failed batches in a
   * row the exporter is replaced by a new one, with a new connection; the old one is closed.
   */
  private rebuild(): void {
    this.failedInARow = 0;
    let next: SpanExporter;
    try {
      next = this.build();
    } catch {
      return;
    }
    const old = this.inner;
    this.inner = next;
    void close(old);
  }

  forceFlush(): Promise<void> {
    return this.batches.forceFlush();
  }

  /** Flush what waits, for at most the shutdown deadline; then whatever is unsent is counted and let go. */
  async shutdown(): Promise<void> {
    if (this.closed) return;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.settings.shutdownTimeoutMillis);
    });
    let flushed = false;
    const flush = this.batches
      .shutdown()
      .catch(() => undefined)
      .then(() => close(this.inner))
      .then(() => {
        flushed = true;
      });
    await Promise.race([flush, deadline]);
    clearTimeout(timer);
    this.closed = true;
    this.counts.dropped_at_shutdown = this.counts.accepted - this.counts.exported - this.counts.dropped_export_failed;
    // Past the deadline a call is still out, and closing the exporter waits for it: asked for, not waited on.
    if (!flushed) void close(this.inner);
  }
}

export interface Telemetry {
  readonly state: TelemetryState;
  /** The context manager actually registered, exposed so rule 1 is assertable. */
  readonly contextManager: AsyncLocalStorageContextManager;
  /** Whether spans are exported, and where to. */
  readonly traceExport: TraceExport;
  /** What became of the spans so far; null when nothing is exported. */
  exportCounts(): TraceExportCounts | null;
  shutdown(): Promise<void>;
}

export interface TelemetryOptions {
  serviceName?: string;
  /** Read for the endpoint and SERVICE_VERSION. Default: the process environment. */
  env?: Record<string, string | undefined>;
  traceExport?: Partial<TraceExportSettings>;
  /** The exporter for an endpoint. Default: OTLP over gRPC; plain for http, TLS for https. */
  createExporter?: (endpoint: string, timeoutMillis: number) => SpanExporter;
}

const otlpGrpcExporter = (endpoint: string, timeoutMillis: number): SpanExporter => new OTLPTraceExporter({ url: endpoint, timeoutMillis });

export function startTelemetry(options: TelemetryOptions = {}): Telemetry {
  const serviceName = options.serviceName ?? DEFAULT_SERVICE_NAME;
  const env = options.env ?? process.env;

  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  context.setGlobalContextManager(contextManager);

  propagation.setGlobalPropagator(new W3CTraceContextPropagator());

  let traceExport = readTraceEndpoint(env);
  let exporting: RedactingExport | undefined;
  if (traceExport.state === 'on') {
    const settings = { ...DEFAULT_TRACE_EXPORT_SETTINGS, ...options.traceExport };
    try {
      const { endpoint } = traceExport;
      const build = (): SpanExporter => (options.createExporter ?? otlpGrpcExporter)(endpoint, settings.exportTimeoutMillis);
      exporting = new RedactingExport(build, exportResource(serviceName, seenText(env['SERVICE_VERSION'] ?? '') ?? undefined), settings);
    } catch {
      traceExport = { state: 'refused', env: traceExport.env, reason: REFUSED_EXPORTER };
    }
  }

  const provider = new TracerProvider(exporting !== undefined ? { spanProcessors: [exporting] } : {});
  trace.setGlobalTracerProvider(provider);

  return {
    state: { registered: true, serviceName },
    contextManager,
    traceExport,
    exportCounts: () => (exporting !== undefined ? { ...exporting.counts } : null),
    shutdown: async () => {
      await provider.shutdown();
      contextManager.disable();
      trace.disable();
      context.disable();
      propagation.disable();
    },
  };
}

/**
 * One line at start saying whether traces are exported: where to, or why not. Silent when no endpoint
 * is configured and no switch is set. A refused endpoint is named by its variable and the reason, never by its value.
 */
export function logTraceExport(telemetry: Telemetry, logger: { info(fields: object, message: string): void; warn(fields: object, message: string): void }): void {
  const found = telemetry.traceExport;
  if (found.state === 'on') logger.info({ env: found.env, endpoint: found.endpoint }, 'trace export on');
  if (found.state === 'disabled') logger.info({ env: found.env }, 'trace export off');
  if (found.state === 'refused') logger.warn({ env: found.env, reason: found.reason }, 'trace export refused: nothing is exported');
}

/** One line after shutdown with what became of the spans: a warning when any was dropped. Silent when nothing is exported. */
export function logTraceExportCounts(telemetry: Telemetry, logger: { info(fields: object, message: string): void; warn(fields: object, message: string): void }): void {
  const counts = telemetry.exportCounts();
  if (counts === null) return;
  if (counts.exported === counts.accepted && counts.dropped_queue_full === 0) logger.info(counts, 'trace export stopped');
  else logger.warn(counts, 'trace export stopped: spans were dropped');
}
