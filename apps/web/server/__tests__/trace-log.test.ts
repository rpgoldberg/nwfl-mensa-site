// LG-N3: one W3C trace per request at the web edge, sent on every API call, and one JSON log line shape.
import { describe, expect, it, vi } from 'vitest';
import { SERVICE, logEntry, stamped } from '../log.mjs';
import { currentTrace, newTrace, runWithTrace, traceInterceptor, traceparent } from '../trace.mjs';

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/;

describe('newTrace and traceparent', () => {
  it('mints random, non-zero, lower-case ids in the W3C traceparent shape, sampled', () => {
    const a = newTrace();
    const b = newTrace();
    expect(traceparent(a)).toMatch(TRACEPARENT);
    expect(traceparent(a)).toBe(`00-${a.traceId}-${a.spanId}-01`);
    expect(a.traceId).not.toBe(b.traceId);
    expect(a.spanId).not.toBe(b.spanId);
    expect(a.traceId).not.toMatch(/^0+$/);
    expect(a.spanId).not.toMatch(/^0+$/);
  });

  it('never mints an all-zero id, which W3C reads as no trace', async () => {
    vi.resetModules();
    vi.doMock('node:crypto', async (original) => {
      const real = await original<typeof import('node:crypto')>();
      let calls = 0;
      // The first draw of each id is all zeros, the next is not.
      return { ...real, randomBytes: (n: number) => (calls++ % 2 === 0 ? Buffer.alloc(n) : Buffer.alloc(n, 0xab)) };
    });
    try {
      const fresh = await import('../trace.mjs');
      const trace = fresh.newTrace();
      expect(trace.traceId).toBe('ab'.repeat(16));
      expect(trace.spanId).toBe('ab'.repeat(8));
    } finally {
      vi.doUnmock('node:crypto');
      vi.resetModules();
    }
  });
});

describe('runWithTrace and currentTrace', () => {
  it('holds the trace across awaits, and none outside', async () => {
    const trace = newTrace();
    expect(currentTrace()).toBeUndefined();
    await runWithTrace(trace, async () => {
      await new Promise((r) => setTimeout(r, 1));
      expect(currentTrace()).toBe(trace);
    });
    expect(currentTrace()).toBeUndefined();
  });

  it('is one store however many copies of the module load (the server bundle has its own copy)', async () => {
    vi.resetModules();
    const copy = await import('../trace.mjs');
    const trace = newTrace();
    runWithTrace(trace, () => expect(copy.currentTrace()).toBe(trace));
  });
});

describe('traceInterceptor', () => {
  const call = async (header: Headers) => {
    const next = vi.fn(async (req: { header: Headers }) => req);
    await traceInterceptor(next as never)({ header } as never);
    return header;
  };

  it('sends the request’s traceparent on an API call made while serving it', async () => {
    const trace = newTrace();
    const header = await runWithTrace(trace, () => call(new Headers()));
    expect(header.get('traceparent')).toBe(traceparent(trace));
  });

  it('sends none outside a request', async () => {
    expect((await call(new Headers())).get('traceparent')).toBeNull();
  });
});

describe('logEntry and stamped', () => {
  it('is one JSON line with an ISO time, the service and the fields', () => {
    const line = JSON.parse(logEntry({ level: 'info', msg: 'hello' })) as Record<string, unknown>;
    expect(line).toEqual({ level: 'info', msg: 'hello', time: expect.any(String), service: 'nwfl-web' });
    expect(new Date(String(line['time'])).toISOString()).toBe(line['time']);
    expect(SERVICE).toBe('nwfl-web');
  });

  it('carries the trace id while serving a request, which no field can replace', () => {
    const trace = newTrace();
    const line = runWithTrace(trace, () => JSON.parse(logEntry({ level: 'info', msg: 'x', trace_id: 'spoof', service: 'other', time: 'then' })));
    expect(line).toMatchObject({ trace_id: trace.traceId, service: 'nwfl-web' });
    expect(line.time).not.toBe('then');
    expect(JSON.parse(logEntry({ msg: 'x', trace_id: 'spoof' }))).not.toHaveProperty('trace_id');
  });

  it('stamps a JSON line passed to a log callback, and wraps any other text as its msg', () => {
    const out: string[] = [];
    const log = stamped((line) => out.push(line));
    log(JSON.stringify({ level: 'warn', msg: 'api refused the token', rpc: 'x' }));
    log('not json');
    log('"a json string"');
    const [first, second, third] = out.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(first).toMatchObject({ level: 'warn', msg: 'api refused the token', rpc: 'x', service: 'nwfl-web' });
    expect(second).toMatchObject({ msg: 'not json', service: 'nwfl-web' });
    expect(third).toMatchObject({ msg: '"a json string"', service: 'nwfl-web' });
  });
});
