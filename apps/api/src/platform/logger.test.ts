import { trace } from '@opentelemetry/api';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createStructuredLogger } from './logger.js';
import { startTelemetry, type Telemetry } from './telemetry.js';

function capture(): { lines: Record<string, unknown>[]; sink: (line: string) => void } {
  const lines: Record<string, unknown>[] = [];
  return { lines, sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>) };
}

describe('createStructuredLogger', () => {
  let telemetry: Telemetry;
  beforeAll(() => {
    telemetry = startTelemetry();
  });
  afterAll(async () => {
    await telemetry.shutdown();
  });

  it('writes one JSON object per line with level, time, name and message', () => {
    const { lines, sink } = capture();
    createStructuredLogger({ name: 'nwfl-mensa-api', sink }).info({ rpc: 'a/B' }, 'hello');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'info', name: 'nwfl-mensa-api', rpc: 'a/B', msg: 'hello' });
    expect(typeof lines[0]?.['time']).toBe('string');
  });

  it('accepts a bare message and an Error as the first argument', () => {
    const { lines, sink } = capture();
    const log = createStructuredLogger({ sink });
    log.warn('just text');
    log.error(new Error('boom'));
    expect(lines[0]?.['msg']).toBe('just text');
    expect(String(lines[1]?.['msg'])).toContain('boom');
  });

  it('drops lines below the threshold and emits nothing at silent', () => {
    const { lines, sink } = capture();
    const log = createStructuredLogger({ level: 'warn', sink });
    log.trace('t');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.fatal('f');
    log.silent('s');
    expect(lines.map((l) => l['msg'])).toEqual(['w', 'f']);
    expect(log.level).toBe('warn');
  });

  it('redacts officer-report text and credentials by key, at any depth', () => {
    const { lines, sink } = capture();
    createStructuredLogger({ sink }).info(
      { item: { body_src: 'The treasurer reports', note: 'send back' }, authorization: 'Bearer abc.def' },
      'saved',
    );
    const line = JSON.stringify(lines[0]);
    expect(line).not.toContain('The treasurer reports');
    expect(line).not.toContain('send back');
    expect(line).not.toContain('abc.def');
  });

  it('reduces a Fastify request to method and url, never its body or headers', () => {
    const { lines, sink } = capture();
    const req = { id: 'req-1', method: 'GET', url: '/readyz', ip: '10.0.0.1', body: 'secret body', headers: { cookie: 'c' } };
    createStructuredLogger({ sink }).info({ req, res: { statusCode: 200, raw: {} } }, 'done');
    expect(lines[0]?.['req']).toEqual({ id: 'req-1', method: 'GET', url: '/readyz', remoteAddress: '10.0.0.1' });
    expect(lines[0]?.['res']).toEqual({ statusCode: 200 });
    expect(JSON.stringify(lines[0])).not.toContain('secret body');
  });

  it('passes a non-object req or res through unchanged', () => {
    const { lines, sink } = capture();
    createStructuredLogger({ sink }).info({ req: 'r', res: null }, 'odd');
    expect(lines[0]).toMatchObject({ req: 'r', res: null });
  });

  it('neutralises log injection in messages and string fields', () => {
    const { lines, sink } = capture();
    createStructuredLogger({ sink }).info({ path: 'a\nb' }, 'line1\nline2');
    expect(String(lines[0]?.['msg'])).not.toContain('\n');
    expect(String(lines[0]?.['path'])).not.toContain('\n');
  });

  it('child loggers accumulate redacted bindings', () => {
    const { lines, sink } = capture();
    const child = createStructuredLogger({ sink, bindings: { svc: 'x' } }).child({ component: 'grpc', email: 'a@b.c' });
    child.info('from child');
    expect(lines[0]).toMatchObject({ svc: 'x', component: 'grpc', email: '[REDACTED]', msg: 'from child' });
  });

  it('carries the fc-shared trace tag inside an active span and omits it outside', () => {
    const { lines, sink } = capture();
    const log = createStructuredLogger({ sink });
    log.info('outside');
    trace.getTracer('test').startActiveSpan('op', (span) => {
      log.info('inside');
      span.end();
    });
    expect(lines[0]?.['trace']).toBeUndefined();
    expect(String(lines[1]?.['trace'])).toMatch(/^trace=[0-9a-f]{32} span=[0-9a-f]{16}$/);
    expect(lines[1]?.['traceId']).toMatch(/^[0-9a-f]{32}$/);
  });

  it('writes to stdout by default', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      createStructuredLogger().info('to stdout');
      expect(String(write.mock.calls[0]?.[0])).toMatch(/"msg":"to stdout"\}\n$/);
    } finally {
      write.mockRestore();
    }
  });
});
