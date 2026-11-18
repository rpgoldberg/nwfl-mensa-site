import { SpanKind, SpanStatusCode, TraceFlags, createTraceState, type Attributes, type SpanContext } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import { describe, expect, it } from 'vitest';
import { EVENT_ATTRIBUTE_KEYS, SPAN_ATTRIBUTE_KEYS, exportResource, redactSpan, redactTraceText } from './span-redaction.js';

const MASK = '[REDACTED]';
const EMAIL = 'avery.quill@example.com';
const NUMBER = '10234567';
const NAME = 'Avery Quill';

// One hazard per row: the text as an instrumented call might carry it, and what must not survive.
const HAZARDS: ReadonlyArray<[label: string, given: string, gone: string]> = [
  ['an email address', `lookup failed for ${EMAIL}`, EMAIL],
  ['a membership-number-shaped token', `no member ${NUMBER} on file`, NUMBER],
  ['a membership number typed with dashes', 'no member 404-17-233 on file', '404-17-233'],
  ['a membership number typed with spaces', 'no member 4041 7233 on file', '7233'],
  ['a bearer credential', 'refused Bearer abc.DEF-123_xyz', 'abc.DEF-123_xyz'],
  ['a signed token', 'refused eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln', 'eyJhbGci'],
  ['a query string', '/auth/callback?code=s3cr3tcode&state=xyz', 's3cr3tcode'],
  ['a query string, its last pair', '/auth/callback?code=s3cr3tcode&state=xyzzy', 'xyzzy'],
  ['a token pair outside a URL', 'retry with access_token=hunter2hunter2 failed', 'hunter2hunter2'],
  ['an err string with an email', `Error: duplicate key (email)=(${EMAIL}) already exists`, EMAIL],
];

const context = (overrides: Partial<SpanContext> = {}): SpanContext => ({
  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
  spanId: '00f067aa0ba902b7',
  traceFlags: TraceFlags.SAMPLED,
  ...overrides,
});

const RESOURCE = exportResource('svc-under-test');

function span(overrides: Partial<ReadableSpan> = {}): ReadableSpan {
  return {
    name: 'nwfl.v1.EventService/ListEvents',
    kind: SpanKind.SERVER,
    spanContext: () => context(),
    startTime: [1, 2],
    endTime: [3, 4],
    duration: [2, 2],
    ended: true,
    status: { code: SpanStatusCode.UNSET },
    attributes: {},
    links: [],
    events: [],
    // What the SDK would attach: never exported (the exporter sends its own resource).
    resource: { attributes: { 'service.name': 'unknown_service:node', 'host.name': 'node-17.internal', 'process.command_args': ['--token=abc'] }, merge: () => RESOURCE, getRawAttributes: () => [] },
    instrumentationScope: { name: 'nwfl-mensa-api/grpc' },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
    ...overrides,
  };
}

describe('redactTraceText', () => {
  it.each(HAZARDS)('masks %s', (_label, given, gone) => {
    const out = redactTraceText(given);
    expect(out).not.toContain(gone);
    expect(out).toContain(MASK);
  });

  it('leaves ids, method names and short numbers legible', () => {
    for (const kept of [
      'nwfl.v1.EventService/ListEvents',
      'trace 4bf92f3577b34da6a3ce929d0e0e4736 span 00f067aa0ba902b7',
      'issue 550e8400-e29b-41d4-a716-446655440000',
      'issue 12345678-e29b-41d4-a716-446655440000',
      'status 14 after 3 tries',
      'is it ready',
    ]) {
      expect(redactTraceText(kept)).toBe(kept);
    }
  });

  it('masks before it cuts, so a long text cannot leave half an address behind', () => {
    const out = redactTraceText(`${'x'.repeat(1_020)} ${EMAIL} ${'y'.repeat(2_000)}`);
    expect(out).not.toContain('avery');
    expect(out.length).toBeLessThan(1_100);
  });

  it('stays quick on a long run of digits and separators that ends in a letter', () => {
    const started = performance.now();
    redactTraceText(`${'1 2 3 4 '.repeat(20_000)}x`);
    redactTraceText(`${'1-'.repeat(50_000)}x`);
    redactTraceText(`${'code'.repeat(50_000)}`);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('redactSpan', () => {
  describe.each(HAZARDS)('with %s', (_label, given, gone) => {
    it('in the span name', () => {
      const out = redactSpan(span({ name: given }), RESOURCE);
      expect(out.name).not.toContain(gone);
      expect(out.name).toContain(MASK);
    });

    it('in the status message', () => {
      const out = redactSpan(span({ status: { code: SpanStatusCode.ERROR, message: given } }), RESOURCE);
      expect(out.status.code).toBe(SpanStatusCode.ERROR);
      expect(out.status.message).not.toContain(gone);
      expect(out.status.message).toContain(MASK);
    });

    it('in the value of an allowed span attribute, a string or a list', () => {
      const out = redactSpan(span({ attributes: { 'rpc.method': given, 'rpc.system': [given, 'grpc'] } }), RESOURCE);
      expect(JSON.stringify(out.attributes)).not.toContain(gone);
      expect(out.attributes['rpc.method']).toContain(MASK);
      expect((out.attributes['rpc.system'] as string[])[1]).toBe('grpc');
    });

    it('in an event name and in an allowed event attribute', () => {
      const out = redactSpan(span({ events: [{ time: [1, 1], name: given, attributes: { 'exception.message': given, 'exception.type': given } }] }), RESOURCE);
      expect(JSON.stringify(out.events)).not.toContain(gone);
      expect(out.events[0]?.name).toContain(MASK);
      expect(out.events[0]?.attributes?.['exception.message']).toContain(MASK);
      expect(out.events[0]?.attributes?.['exception.type']).toContain(MASK);
    });

    it('in the instrumentation scope', () => {
      const out = redactSpan(span({ instrumentationScope: { name: given, version: given, schemaUrl: given } }), RESOURCE);
      expect(JSON.stringify(out.instrumentationScope)).not.toContain(gone);
    });

    it('in the resource', () => {
      const resource = exportResource(given, given);
      expect(JSON.stringify(resource.attributes)).not.toContain(gone);
      expect(resource.attributes['service.name']).toContain(MASK);
      expect(resource.attributes['service.version']).toContain(MASK);
    });
  });

  it('keeps only the allowed span attribute keys, and counts what it dropped', () => {
    const attributes: Attributes = {
      'rpc.system': 'grpc',
      'rpc.method': 'nwfl.v1.EventService/ListEvents',
      'rpc.grpc.status_code': 5,
      // A SITE_KEYS key, a credential key, and keys no pattern could know to mask.
      'member.display_name': NAME,
      email: EMAIL,
      'http.request.header.authorization': 'Bearer abc.DEF-123_xyz',
      'peer.label': NAME,
      'url.full': 'https://site.example.org/auth/callback?code=s3cr3tcode',
      membership_number: NUMBER,
    };
    const out = redactSpan(span({ attributes, droppedAttributesCount: 2 }), RESOURCE);
    expect(out.attributes).toEqual({ 'rpc.system': 'grpc', 'rpc.method': 'nwfl.v1.EventService/ListEvents', 'rpc.grpc.status_code': 5 });
    expect(out.droppedAttributesCount).toBe(8);
    expect([...SPAN_ATTRIBUTE_KEYS].sort()).toEqual(['rpc.grpc.status_code', 'rpc.method', 'rpc.system']);
  });

  it('keeps an exception as its type and a masked message, never its stack or any other field', () => {
    const events = [
      {
        time: [1, 1] as [number, number],
        name: 'exception',
        attributes: {
          'exception.type': 'ConnectError',
          'exception.message': `no row for ${EMAIL}`,
          'exception.stacktrace': `ConnectError: no row for ${EMAIL}\n    at find (/app/dist/members.js:10:3)`,
          'member.display_name': NAME,
          note: NAME,
        },
        droppedAttributesCount: 1,
      },
      { time: [2, 2] as [number, number], name: 'plain' },
    ];
    const out = redactSpan(span({ events }), RESOURCE);
    expect(out.events).toEqual([
      { time: [1, 1], name: 'exception', attributes: { 'exception.type': 'ConnectError', 'exception.message': `no row for ${MASK}` }, droppedAttributesCount: 4 },
      { time: [2, 2], name: 'plain', attributes: {}, droppedAttributesCount: 0 },
    ]);
    expect([...EVENT_ATTRIBUTE_KEYS].sort()).toEqual(['exception.message', 'exception.type']);
  });

  it('exports ids only from a span context: no tracestate, on the span, its parent or a link', () => {
    const traceState = createTraceState(`vendor=${NUMBER}`);
    const out = redactSpan(
      span({
        spanContext: () => context({ traceState, isRemote: false }),
        parentSpanContext: context({ spanId: '1111111111111111', traceState, isRemote: true }),
        links: [{ context: context({ spanId: '2222222222222222', traceState }), attributes: { note: NAME, 'rpc.method': NAME }, droppedAttributesCount: 1 }],
      }),
      RESOURCE,
    );
    expect(out.spanContext()).toEqual({ traceId: '4bf92f3577b34da6a3ce929d0e0e4736', spanId: '00f067aa0ba902b7', traceFlags: TraceFlags.SAMPLED, isRemote: false });
    expect(out.parentSpanContext).toEqual({ traceId: '4bf92f3577b34da6a3ce929d0e0e4736', spanId: '1111111111111111', traceFlags: TraceFlags.SAMPLED, isRemote: true });
    expect(out.links).toEqual([{ context: { traceId: '4bf92f3577b34da6a3ce929d0e0e4736', spanId: '2222222222222222', traceFlags: TraceFlags.SAMPLED }, droppedAttributesCount: 3 }]);
  });

  it('carries the timing and kind through, and sends the given resource, not the span one', () => {
    const given = span({ status: { code: SpanStatusCode.OK } });
    const out = redactSpan(given, RESOURCE);
    expect(out.resource).toBe(RESOURCE);
    expect(out.parentSpanContext).toBeUndefined();
    expect(out.status).toEqual({ code: SpanStatusCode.OK });
    expect(out.instrumentationScope).toEqual({ name: 'nwfl-mensa-api/grpc' });
    expect({ kind: out.kind, startTime: out.startTime, endTime: out.endTime, duration: out.duration, ended: out.ended }).toEqual({ kind: SpanKind.SERVER, startTime: [1, 2], endTime: [3, 4], duration: [2, 2], ended: true });
    expect({ events: out.droppedEventsCount, links: out.droppedLinksCount }).toEqual({ events: 0, links: 0 });
  });
});

describe('exportResource', () => {
  it('is the service name alone, with the version when one is known', () => {
    expect(exportResource('svc').attributes).toEqual({ 'service.name': 'svc' });
    expect(exportResource('svc', '1.2.3').attributes).toEqual({ 'service.name': 'svc', 'service.version': '1.2.3' });
    const resource = exportResource('svc');
    expect(resource.merge(null)).toBe(resource);
    expect(resource.getRawAttributes()).toEqual([['service.name', 'svc']]);
    expect(resource.asyncAttributesPending).toBe(false);
  });
});
