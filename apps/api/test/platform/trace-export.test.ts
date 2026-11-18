// LG-N6: the trace exporter against a real OTLP gRPC receiver on 127.0.0.1, and
// against collectors that are closed, silent, refusing or speaking the wrong
// protocol. What leaves the process is read from the receiver's own bytes.
import { SpanStatusCode, TraceFlags, context, propagation, trace } from '@opentelemetry/api';
import { ExportResultCode } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { traceServerInterceptor } from '../../src/grpc/interceptors.js';
import { TRACES_ENDPOINT_ENV, startTelemetry, type Telemetry } from '../../src/platform/telemetry.js';
import { closedPort, startOtlpReceiver, type OtlpReceiver } from '../helpers/otlp-receiver.js';

const EMAIL = 'avery.quill@example.com';
const NUMBER = '10234567';
const NAME = 'Avery Quill';
const CANARIES = [EMAIL, 'avery', NUMBER, NAME, 'Quill', 's3cr3tcode', 'abc.DEF-123_xyz', 'hunter2', 'members.js', 'node-17'];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await sleep(10);
  }
}

const total = (telemetry: Telemetry): number => {
  const counts = telemetry.exportCounts();
  if (counts === null) throw new Error('no exporter');
  return counts.exported + counts.dropped_queue_full + counts.dropped_export_failed + counts.dropped_at_shutdown;
};

/** One call through the API's own tracing interceptor, as an RPC makes it. Returns how long it took. */
async function rpc(headers: Record<string, string> = {}, fail = false): Promise<number> {
  const interceptor = traceServerInterceptor();
  const request = { service: { typeName: 'nwfl.v1.EventService' }, method: { name: 'ListEvents' }, header: new Headers(headers) };
  const next = async (): Promise<unknown> => {
    await Promise.resolve();
    if (fail) throw new Error(`no row for ${EMAIL}`);
    return { header: new Headers() };
  };
  const started = performance.now();
  await (interceptor(next as never)(request as never) as Promise<unknown>).catch(() => undefined);
  return performance.now() - started;
}

describe('trace export', () => {
  let receiver: OtlpReceiver | undefined;
  let telemetry: Telemetry | undefined;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => void unhandled.push(reason);

  beforeEach(() => {
    unhandled.length = 0;
    process.on('unhandledRejection', onUnhandled);
  });

  afterEach(async () => {
    await telemetry?.shutdown();
    await receiver?.close();
    telemetry = undefined;
    receiver = undefined;
    process.off('unhandledRejection', onUnhandled);
  });

  it('sends spans to a real receiver with every hazard masked or left out', async () => {
    receiver = await startOtlpReceiver();
    telemetry = startTelemetry({
      serviceName: `svc ${EMAIL}`,
      env: { [TRACES_ENDPOINT_ENV]: receiver.url, SERVICE_VERSION: '1.2.3', HOSTNAME: 'node-17.internal' },
      traceExport: { scheduledDelayMillis: 20 },
    });

    const tracer = trace.getTracer(`scope for ${EMAIL}`);
    const inbound = propagation.extract(context.active(), { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01', tracestate: `vendor=${NUMBER}`, baggage: `member=${NUMBER}` });
    const span = tracer.startSpan(
      `GET /auth/callback?code=s3cr3tcode for ${EMAIL}`,
      {
        attributes: {
          'rpc.system': 'grpc',
          'rpc.method': `nwfl.v1.MemberService/Find ${EMAIL} ${NUMBER} Bearer abc.DEF-123_xyz /x?code=s3cr3tcode access_token=hunter2`,
          'rpc.grpc.status_code': 13,
          'member.display_name': NAME,
          'peer.label': NAME,
          email: EMAIL,
          membership_number: NUMBER,
          'http.request.header.authorization': 'Bearer abc.DEF-123_xyz',
          'url.full': 'https://site.example.org/auth/callback?code=s3cr3tcode',
        },
        links: [{ context: { traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'b7ad6b7169203331', traceFlags: TraceFlags.SAMPLED }, attributes: { note: NAME } }],
      },
      inbound,
    );
    const failure = new Error(`duplicate key (email)=(${EMAIL}) for member ${NUMBER}`);
    failure.stack = `Error: duplicate key (email)=(${EMAIL})\n    at find (/app/dist/members.js:10:3)`;
    span.recordException(failure);
    span.addEvent(`retry for ${EMAIL}`, { note: NAME, 'peer.label': NAME });
    span.setStatus({ code: SpanStatusCode.ERROR, message: `Error: no row for ${EMAIL} (${NUMBER}), token=hunter2` });
    span.end();
    await rpc({ traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01', baggage: `member=${NUMBER}` }, true);

    const sending = telemetry;
    await until(() => sending.exportCounts()?.exported === 2);
    const spans = (receiver?.spans() ?? []).sort((a, b) => a.name.localeCompare(b.name));
    expect(spans).toHaveLength(2);
    const raw = receiver?.rawText() ?? '';
    for (const canary of CANARIES) expect(raw).not.toContain(canary);

    const [manual, call] = spans;
    expect(manual?.resource).toEqual({ 'service.name': 'svc [REDACTED]', 'service.version': '1.2.3' });
    expect(manual?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(manual?.traceState).toBe('');
    expect(manual?.name).toBe('GET /auth/callback[REDACTED] for [REDACTED]');
    expect(manual?.scope).toBe('scope for [REDACTED]');
    expect(Object.keys(manual?.attributes ?? {}).sort()).toEqual(['rpc.grpc.status_code', 'rpc.method', 'rpc.system']);
    expect(manual?.attributes['rpc.method']).toBe('nwfl.v1.MemberService/Find [REDACTED] [REDACTED] [REDACTED] /x[REDACTED] access_[REDACTED]');
    expect(manual?.attributes['rpc.grpc.status_code']).toBe(13);
    expect(manual?.events).toEqual([
      { name: 'exception', attributes: { 'exception.type': 'Error', 'exception.message': 'duplicate key (email)=([REDACTED]) for member [REDACTED]' } },
      { name: 'retry for [REDACTED]', attributes: {} },
    ]);
    expect(manual?.links).toBe(1);
    expect(manual?.statusMessage).toBe('Error: no row for [REDACTED] ([REDACTED]), [REDACTED]');
    expect(manual?.statusCode).toBe(SpanStatusCode.ERROR);

    // The API's own span for a failed call: the method, the code, nothing of the error.
    expect(call).toMatchObject({ name: 'nwfl.v1.EventService/ListEvents', traceId: '4bf92f3577b34da6a3ce929d0e0e4736', statusCode: SpanStatusCode.ERROR, statusMessage: '', events: [] });
    expect(call?.attributes).toEqual({ 'rpc.system': 'grpc', 'rpc.method': 'nwfl.v1.EventService/ListEvents', 'rpc.grpc.status_code': 2 });
    expect(telemetry.exportCounts()).toEqual({ accepted: 2, exported: 2, dropped_queue_full: 0, dropped_export_failed: 0, dropped_at_shutdown: 0 });
    expect(unhandled).toEqual([]);
  });

  it('does not export a span the caller marked as not sampled', async () => {
    receiver = await startOtlpReceiver();
    telemetry = startTelemetry({ env: { [TRACES_ENDPOINT_ENV]: receiver.url }, traceExport: { scheduledDelayMillis: 10 } });
    await rpc({ traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00' });
    await rpc();
    const sending = telemetry;
    await until(() => sending.exportCounts()?.exported === 1);
    expect(telemetry.exportCounts()).toMatchObject({ accepted: 1, exported: 1 });
    expect(receiver.spans()).toHaveLength(1);
  });

  // The same calls with no exporter at all: what an RPC costs today.
  const CALLS = 200;
  const EACH_MS = 500;
  const ALL_MS = 3_000;

  describe.each([
    ['nothing listens on the port', async () => `http://127.0.0.1:${await closedPort()}`, 'none'],
    ['the collector never answers', async () => (receiver = await startOtlpReceiver('hang')).url, 'hang'],
    ['the collector answers UNAVAILABLE', async () => (receiver = await startOtlpReceiver('unavailable')).url, 'unavailable'],
    ['the collector does not speak TLS and the endpoint is https', async () => (receiver = await startOtlpReceiver()).url.replace('http://127.0.0.1', 'https://localhost'), 'tls'],
  ])('when %s', (_label, endpoint, kind) => {
    it('keeps every call quick, drops and counts every span, and rejects nothing unhandled', async () => {
      telemetry = startTelemetry({
        env: { [TRACES_ENDPOINT_ENV]: await endpoint() },
        traceExport: { scheduledDelayMillis: 5, maxExportBatchSize: 8, maxQueueSize: 64, exportTimeoutMillis: 1_000, shutdownTimeoutMillis: 300 },
      });
      const started = performance.now();
      let slowest = 0;
      for (let i = 0; i < CALLS; i += 1) {
        slowest = Math.max(slowest, await rpc({}, i % 2 === 0));
        if (i % 20 === 0) await sleep(1);
      }
      const took = performance.now() - started;
      // An export attempt lasts up to a second here; a call that waited for one would show it.
      expect(slowest).toBeLessThan(EACH_MS);
      expect(took).toBeLessThan(ALL_MS);

      const stopping = performance.now();
      await telemetry.shutdown();
      expect(performance.now() - stopping).toBeLessThan(1_500);
      const counts = telemetry.exportCounts();
      expect(counts?.exported).toBe(0);
      expect(total(telemetry)).toBe(CALLS);
      expect((counts?.accepted ?? 0) + (counts?.dropped_queue_full ?? 0)).toBe(CALLS);
      if (kind === 'hang' || kind === 'unavailable') expect(receiver?.calls()).toBeGreaterThan(0);
      if (kind !== 'hang') expect(counts?.dropped_export_failed).toBeGreaterThan(0);
      await sleep(50);
      expect(unhandled).toEqual([]);
      telemetry = undefined;
    });
  });

  it('drops, and counts, what does not fit in the queue', async () => {
    receiver = await startOtlpReceiver('hang');
    telemetry = startTelemetry({
      env: { [TRACES_ENDPOINT_ENV]: receiver.url },
      traceExport: { scheduledDelayMillis: 60_000, maxExportBatchSize: 4, maxQueueSize: 16, exportTimeoutMillis: 5_000, shutdownTimeoutMillis: 100 },
    });
    const tracer = trace.getTracer('t');
    for (let i = 0; i < 100; i += 1) tracer.startSpan(`s${i}`).end();
    // The first full batch is taken at once and is in flight; sixteen more wait; the rest have nowhere to go.
    expect(telemetry.exportCounts()).toEqual({ accepted: 20, exported: 0, dropped_queue_full: 80, dropped_export_failed: 0, dropped_at_shutdown: 0 });
    await telemetry.shutdown();
    expect(total(telemetry)).toBe(100);
    expect(telemetry.exportCounts()).toMatchObject({ accepted: 20, exported: 0, dropped_queue_full: 80 });
    telemetry = undefined;
  });

  it('flushes what is waiting on shutdown', async () => {
    receiver = await startOtlpReceiver();
    telemetry = startTelemetry({ env: { [TRACES_ENDPOINT_ENV]: receiver.url }, traceExport: { scheduledDelayMillis: 60_000 } });
    for (let i = 0; i < 5; i += 1) await rpc();
    expect(receiver.spans()).toHaveLength(0);
    await telemetry.shutdown();
    expect(receiver.spans()).toHaveLength(5);
    expect(telemetry.exportCounts()).toEqual({ accepted: 5, exported: 5, dropped_queue_full: 0, dropped_export_failed: 0, dropped_at_shutdown: 0 });
    telemetry = undefined;
  });

  it('gives up the flush at its deadline when the collector never answers, and counts what was left', async () => {
    receiver = await startOtlpReceiver('hang');
    telemetry = startTelemetry({
      env: { [TRACES_ENDPOINT_ENV]: receiver.url },
      traceExport: { scheduledDelayMillis: 60_000, exportTimeoutMillis: 30_000, shutdownTimeoutMillis: 200 },
    });
    for (let i = 0; i < 5; i += 1) await rpc();
    const started = performance.now();
    await telemetry.shutdown();
    const took = performance.now() - started;
    expect(took).toBeGreaterThanOrEqual(190);
    expect(took).toBeLessThan(1_500);
    expect(telemetry.exportCounts()).toEqual({ accepted: 5, exported: 0, dropped_queue_full: 0, dropped_export_failed: 0, dropped_at_shutdown: 5 });
    // The provider is gone all the same, and a late answer changes no count.
    expect(trace.getTracer('t').startSpan('after').isRecording()).toBe(false);
    await sleep(100);
    expect(total(telemetry)).toBe(5);
    expect(unhandled).toEqual([]);
    telemetry = undefined;
  });

  describe('an exporter that misbehaves', () => {
    const start = (exporter: SpanExporter): Telemetry =>
      startTelemetry({ env: { [TRACES_ENDPOINT_ENV]: 'http://127.0.0.1:9' }, createExporter: () => exporter, traceExport: { scheduledDelayMillis: 5, shutdownTimeoutMillis: 200 } });

    it('throws from export: the batch is dropped and counted, nothing escapes', async () => {
      telemetry = start({
        export: () => {
          throw new Error('boom');
        },
        shutdown: () => Promise.reject(new Error('boom')),
      });
      await rpc();
      const sending = telemetry;
      await until(() => sending.exportCounts()?.dropped_export_failed === 1);
      await telemetry.shutdown();
      await sleep(20);
      expect(unhandled).toEqual([]);
    });

    it('gets a span it cannot read: the batch is dropped and counted, the inner exporter never sees it', async () => {
      const seen: ReadableSpan[] = [];
      telemetry = start({ export: (spans, done) => (seen.push(...spans), done({ code: ExportResultCode.SUCCESS })), shutdown: () => Promise.resolve() });
      const span = trace.getTracer('t').startSpan('s');
      Object.defineProperty(span, 'attributes', { get: () => { throw new Error('unreadable'); } });
      span.end();
      const sending = telemetry;
      await until(() => sending.exportCounts()?.dropped_export_failed === 1);
      expect(seen).toEqual([]);
      expect(unhandled).toEqual([]);
    });

    it('answers twice: the first answer counts', async () => {
      telemetry = start({ export: (_spans, done) => (done({ code: ExportResultCode.SUCCESS }), done({ code: ExportResultCode.FAILED })), shutdown: () => Promise.resolve() });
      await rpc();
      const sending = telemetry;
      await until(() => sending.exportCounts()?.exported === 1);
      await sleep(20);
      expect(telemetry.exportCounts()).toEqual({ accepted: 1, exported: 1, dropped_queue_full: 0, dropped_export_failed: 0, dropped_at_shutdown: 0 });
    });

    it('answers after shutdown: the span stays counted as left behind', async () => {
      let answer: ((result: { code: ExportResultCode }) => void) | undefined;
      telemetry = start({
        export: (_spans, done) => {
          answer = done;
        },
        shutdown: () => Promise.resolve(),
        forceFlush: () => Promise.resolve(),
      });
      await rpc();
      await until(() => answer !== undefined);
      await telemetry.shutdown();
      expect(telemetry.exportCounts()).toMatchObject({ accepted: 1, exported: 0, dropped_at_shutdown: 1 });
      answer?.({ code: ExportResultCode.SUCCESS });
      answer?.({ code: ExportResultCode.FAILED });
      expect(telemetry.exportCounts()).toEqual({ accepted: 1, exported: 0, dropped_queue_full: 0, dropped_export_failed: 0, dropped_at_shutdown: 1 });
      telemetry = undefined;
    });
  });
});
