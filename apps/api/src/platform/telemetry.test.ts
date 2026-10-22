import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { describe, expect, it } from 'vitest';
import { startTelemetry } from './telemetry.js';

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

  it('defaults the service name and unregisters everything on shutdown', async () => {
    const telemetry = startTelemetry();
    expect(telemetry.state.serviceName).toBe('nwfl-mensa-api');
    await telemetry.shutdown();
    const span = trace.getTracer('t').startSpan('after');
    expect(span.isRecording()).toBe(false);
    span.end();
  });
});
