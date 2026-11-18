import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { describe, expect, it } from 'vitest';
import { createStructuredLogger } from './logger.js';
import { GENERAL_ENDPOINT_ENV, TRACES_ENDPOINT_ENV, logTraceExport, logTraceExportCounts, readTraceEndpoint, startTelemetry, type Telemetry } from './telemetry.js';

describe('startTelemetry', () => {
  it('registers a real provider whose spans have non-zero ids', async () => {
    const telemetry = startTelemetry({ serviceName: 'svc-under-test' });
    try {
      expect(telemetry.state).toEqual({ registered: true, serviceName: 'svc-under-test' });
      const span = trace.getTracer('t').startSpan('s');
      expect(span.spanContext().traceId).not.toMatch(/^0+$/);
      expect(span.isRecording()).toBe(true);
      span.end();
    } finally {
      await telemetry.shutdown();
    }
  });

  it('registers AsyncLocalStorage explicitly, so the active span survives an await', async () => {
    const telemetry = startTelemetry();
    try {
      expect(telemetry.contextManager).toBeInstanceOf(AsyncLocalStorageContextManager);
      await trace.getTracer('t').startActiveSpan('outer', async (span) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        expect(trace.getActiveSpan()).toBe(span);
        span.end();
      });
    } finally {
      await telemetry.shutdown();
    }
  });

  it('registers the W3C trace-context propagator', async () => {
    const telemetry = startTelemetry();
    try {
      const carrier: Record<string, string> = {};
      trace.getTracer('t').startActiveSpan('s', (span) => {
        propagation.inject(context.active(), carrier);
        span.end();
      });
      expect(carrier['traceparent']).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    } finally {
      await telemetry.shutdown();
    }
  });

  // LG-N3: trace context only. Baggage would carry whatever a caller put in it into every span and hop.
  it('propagates trace context only, never baggage, in or out', async () => {
    const telemetry = startTelemetry();
    try {
      expect(propagation.fields().sort()).toEqual(['traceparent', 'tracestate']);
      const inbound = propagation.extract(context.active(), { traceparent: `00-${'4bf92f3577b34da6a3ce929d0e0e4736'}-00f067aa0ba902b7-01`, baggage: 'member=CANARY' });
      expect(propagation.getBaggage(inbound)).toBeUndefined();
      const carrier: Record<string, string> = {};
      propagation.inject(propagation.setBaggage(inbound, propagation.createBaggage({ member: { value: 'CANARY' } })), carrier);
      expect(carrier['baggage']).toBeUndefined();
      expect(carrier['traceparent']).toMatch(/^00-4bf92f3577b34da6a3ce929d0e0e4736-/);
    } finally {
      await telemetry.shutdown();
    }
  });

  it('defaults the service name and unregisters everything on shutdown', async () => {
    const telemetry = startTelemetry();
    expect(telemetry.state.serviceName).toBe('nwfl-mensa-api');
    await telemetry.shutdown();
    const span = trace.getTracer('t').startSpan('after');
    expect(span.isRecording()).toBe(false);
    span.end();
  });
});

// LG-N6: the exporter is off unless an endpoint is configured, and a bad endpoint never stops the API.
describe('readTraceEndpoint', () => {
  it.each([
    ['nothing set', {}],
    ['both empty', { [TRACES_ENDPOINT_ENV]: '', [GENERAL_ENDPOINT_ENV]: '' }],
    ['spaces and a tab', { [TRACES_ENDPOINT_ENV]: ' \t ', [GENERAL_ENDPOINT_ENV]: '\n' }],
    ['characters that draw nothing', { [TRACES_ENDPOINT_ENV]: '\u200b\u2060\ufeff', [GENERAL_ENDPOINT_ENV]: '\u00a0\u200e\u3164' }],
  ])('is off with %s', (_label, env) => {
    expect(readTraceEndpoint(env)).toEqual({ state: 'off' });
  });

  it('takes the traces endpoint over the general one, and the general one when the traces one is blank', () => {
    const both = { [TRACES_ENDPOINT_ENV]: 'http://traces.example.net:14317', [GENERAL_ENDPOINT_ENV]: 'http://general.example.net:4317' };
    expect(readTraceEndpoint(both)).toEqual({ state: 'on', env: TRACES_ENDPOINT_ENV, endpoint: 'http://traces.example.net:14317' });
    expect(readTraceEndpoint({ ...both, [TRACES_ENDPOINT_ENV]: ' \u200b ' })).toEqual({ state: 'on', env: GENERAL_ENDPOINT_ENV, endpoint: 'http://general.example.net:4317' });
    expect(readTraceEndpoint({ [GENERAL_ENDPOINT_ENV]: '  https://general.example.net:4317/  ' })).toEqual({ state: 'on', env: GENERAL_ENDPOINT_ENV, endpoint: 'https://general.example.net:4317' });
  });

  it('gives a URL with no port the port of its scheme', () => {
    expect(readTraceEndpoint({ [TRACES_ENDPOINT_ENV]: 'http://collector.example.net' })).toMatchObject({ endpoint: 'http://collector.example.net:80' });
    expect(readTraceEndpoint({ [TRACES_ENDPOINT_ENV]: 'https://collector.example.net' })).toMatchObject({ endpoint: 'https://collector.example.net:443' });
    expect(readTraceEndpoint({ [TRACES_ENDPOINT_ENV]: 'HTTP://[::1]:4317' })).toMatchObject({ endpoint: 'http://[::1]:4317' });
  });

  it.each([
    ['no scheme', 'collector.example.net:4317', 'the endpoint must be an http or https URL'],
    ['not a URL at all', 'http://', 'the endpoint must be an http or https URL'],
    ['a unix socket', 'unix:///run/otel.sock', 'the endpoint must be an http or https URL'],
    ['another scheme', 'grpc://collector.example.net:4317', 'the endpoint must be an http or https URL'],
    ['a file', 'file:///etc/hostname', 'the endpoint must be an http or https URL'],
    ['a hidden character inside', 'http://collector\u200b.example.net:4317', 'the endpoint has characters that are not shown'],
    ['a user and password', 'http://user:hunter2@example.net:4317', 'the endpoint must not carry a user, a path, a query or a fragment'],
    ['a path', 'http://collector.example.net:4318/v1/traces', 'the endpoint must not carry a user, a path, a query or a fragment'],
    ['a query', 'http://collector.example.net:4317?key=hunter2', 'the endpoint must not carry a user, a path, a query or a fragment'],
    ['a fragment', 'http://collector.example.net:4317#hunter2', 'the endpoint must not carry a user, a path, a query or a fragment'],
  ])('refuses %s, and does not fall back to the general endpoint', (_label, value, reason) => {
    expect(readTraceEndpoint({ [TRACES_ENDPOINT_ENV]: value, [GENERAL_ENDPOINT_ENV]: 'http://general.example.net:4317' })).toEqual({ state: 'refused', env: TRACES_ENDPOINT_ENV, reason });
  });
});

describe('startTelemetry, trace export', () => {
  const lines = (): { sink: (line: string) => void; read: () => Array<Record<string, unknown>> } => {
    const kept: string[] = [];
    return { sink: (line) => kept.push(line), read: () => kept.map((line) => JSON.parse(line) as Record<string, unknown>) };
  };

  it.each([
    ['unset', {}],
    ['blank', { [TRACES_ENDPOINT_ENV]: '  ', [GENERAL_ENDPOINT_ENV]: '' }],
    ['invisible', { [TRACES_ENDPOINT_ENV]: '\u200b\ufeff' }],
  ])('has no exporter when the endpoint is %s, and says nothing about it', async (_label, env) => {
    const telemetry = startTelemetry({ env });
    try {
      expect(telemetry.traceExport).toEqual({ state: 'off' });
      expect(telemetry.exportCounts()).toBeNull();
      expect(trace.getTracer('t').startSpan('s').isRecording()).toBe(true);
      const out = lines();
      logTraceExport(telemetry, createStructuredLogger({ sink: out.sink }));
      logTraceExportCounts(telemetry, createStructuredLogger({ sink: out.sink }));
      expect(out.read()).toEqual([]);
    } finally {
      await telemetry.shutdown();
    }
  });

  it('has an exporter when the endpoint is set, and says where it sends', async () => {
    // Nothing listens there, and no span is made: the exporter connects only to send.
    const telemetry = startTelemetry({ env: { [TRACES_ENDPOINT_ENV]: 'http://127.0.0.1:9', SERVICE_VERSION: ' 1.2.3 ' } });
    try {
      expect(telemetry.traceExport).toEqual({ state: 'on', env: TRACES_ENDPOINT_ENV, endpoint: 'http://127.0.0.1:9' });
      expect(telemetry.exportCounts()).toEqual({ accepted: 0, exported: 0, dropped_queue_full: 0, dropped_export_failed: 0, dropped_at_shutdown: 0 });
      const out = lines();
      logTraceExport(telemetry, createStructuredLogger({ sink: out.sink }));
      expect(out.read()).toMatchObject([{ level: 'info', msg: 'trace export on', env: TRACES_ENDPOINT_ENV, endpoint: 'http://127.0.0.1:9' }]);
    } finally {
      await telemetry.shutdown();
    }
  });

  it('refuses a bad endpoint with one line that does not repeat it, and still starts', async () => {
    const telemetry = startTelemetry({ env: { [GENERAL_ENDPOINT_ENV]: 'ftp://user:hunter2@example.net' } });
    try {
      expect(telemetry.traceExport).toEqual({ state: 'refused', env: GENERAL_ENDPOINT_ENV, reason: 'the endpoint must be an http or https URL' });
      expect(telemetry.exportCounts()).toBeNull();
      expect(telemetry.state.registered).toBe(true);
      expect(trace.getTracer('t').startSpan('s').spanContext().traceId).not.toMatch(/^0+$/);
      const out = lines();
      logTraceExport(telemetry, createStructuredLogger({ sink: out.sink }));
      expect(out.read()).toMatchObject([{ level: 'warn', msg: 'trace export refused: nothing is exported', env: GENERAL_ENDPOINT_ENV, reason: 'the endpoint must be an http or https URL' }]);
      expect(JSON.stringify(out.read())).not.toContain('hunter2');
      expect(JSON.stringify(out.read())).not.toContain('example.net');
    } finally {
      await telemetry.shutdown();
    }
  });

  it('refuses, and still starts, when the exporter cannot be built', async () => {
    const telemetry = startTelemetry({
      env: { [TRACES_ENDPOINT_ENV]: 'http://127.0.0.1:9' },
      createExporter: () => {
        throw new Error('no exporter today');
      },
    });
    try {
      expect(telemetry.traceExport).toEqual({ state: 'refused', env: TRACES_ENDPOINT_ENV, reason: 'the exporter could not be built' });
      expect(trace.getTracer('t').startSpan('s').isRecording()).toBe(true);
    } finally {
      await telemetry.shutdown();
    }
  });

  it('says at the end what became of the spans, as a warning when any was dropped', () => {
    const zero = { accepted: 0, exported: 0, dropped_queue_full: 0, dropped_export_failed: 0, dropped_at_shutdown: 0 };
    const said = (counts: typeof zero): Array<Record<string, unknown>> => {
      const out = lines();
      logTraceExportCounts({ exportCounts: () => counts } as Telemetry, createStructuredLogger({ sink: out.sink }));
      return out.read();
    };
    expect(said({ ...zero, accepted: 3, exported: 3 })).toMatchObject([{ level: 'info', msg: 'trace export stopped', accepted: 3, exported: 3 }]);
    expect(said({ ...zero, accepted: 3, exported: 2, dropped_export_failed: 1 })).toMatchObject([{ level: 'warn', msg: 'trace export stopped: spans were dropped', dropped_export_failed: 1 }]);
    expect(said({ ...zero, accepted: 3, exported: 3, dropped_queue_full: 4 })).toMatchObject([{ level: 'warn', dropped_queue_full: 4 }]);
    expect(said({ ...zero, accepted: 3, exported: 1, dropped_at_shutdown: 2 })).toMatchObject([{ level: 'warn', dropped_at_shutdown: 2 }]);
  });
});
