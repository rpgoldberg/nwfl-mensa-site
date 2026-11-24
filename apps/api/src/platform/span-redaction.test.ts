import { SpanKind, SpanStatusCode, TraceFlags, createTraceState, type Attributes, type SpanContext } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import { describe, expect, it } from 'vitest';
import { EVENT_ATTRIBUTE_KEYS, SPAN_ATTRIBUTE_KEYS, exportResource, redactSpan, redactTraceText } from './span-redaction.js';

const MASK = '[REDACTED]';
const EMAIL = 'avery.quill@example.com';
const NUMBER = '10234567';
const NAME = 'Avery Quill';
const METHOD = 'nwfl.v1.EventService/ListEvents';

// One hazard per row: a text as it might reach a span, and what must not survive.
const HAZARDS: ReadonlyArray<[label: string, given: string, gone: string]> = [
  ['a name, which no mask can know', `Find ${NAME}`, 'Quill'],
  ['an email address', `lookup failed for ${EMAIL}`, 'avery'],
  ['an email address, percent-encoded', 'lookup failed for avery.quill%40example.com', 'avery'],
  ['an email address, percent-encoded twice', 'lookup failed for avery.quill%2540example.com', 'avery'],
  ['an email address with a fullwidth at sign', 'lookup failed for avery.quill＠example.com', 'avery'],
  ['an email address with a fullwidth at sign, percent-encoded', 'lookup failed for avery.quill%EF%BC%A0example.com', 'avery'],
  ['an email address with a fullwidth percent sign', 'lookup failed for avery.quill\uff05\uff14\uff10example.com', 'avery'],
  ['an email address with a small at sign', 'lookup failed for avery.quill﹫example.com', 'avery'],
  ['an email address split by a character that is not shown', 'lookup failed for avery.quill@exa​mple.com', 'mple'],
  ['an email address at a domain outside ASCII', 'lookup failed for avery@exämple.com', 'avery'],
  ['a membership-number-shaped token', `no member ${NUMBER} on file`, NUMBER],
  ['a membership number of four digits', 'no member 1234 on file', '1234'],
  ['a membership number of five digits', 'no member 12345 on file', '12345'],
  ['a membership number typed with dashes', 'no member 404-17-233 on file', '404-17-233'],
  ['a membership number typed with spaces', 'no member 4041 7233 on file', '7233'],
  ['a membership number typed with dots', 'no member 102.345.678 on file', '345'],
  ['a membership number after a word and a dash', `no member-${NUMBER} on file`, NUMBER],
  ['a membership number after a letter', `no M${NUMBER} on file`, NUMBER],
  ['a membership number in fullwidth digits', 'no member １０２３４５６７ on file', '２３'],
  ['a membership number in other digits', 'no member ١٠٢٣٤٥٦٧ on file', '٢٣'],
  ['a membership number split by characters that are not shown', 'no member 10\u200b23\u00ad45\u200d67 on file', '23'],
  ['a bearer credential', 'refused Bearer abc.DEF-123_xyz', 'abc.DEF-123_xyz'],
  ['a signed token', 'refused eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln', 'eyJhbGci'],
  ['a query string', '/auth/callback?code=s3cr3tcode&state=xyz', 's3cr3tcode'],
  ['a query string, its last pair', '/auth/callback?code=s3cr3tcode&state=xyzzy', 'xyzzy'],
  ['a query string with no credential in it', '/events?q=findme&page=two', 'findme'],
  ['a query string, percent-encoded', '/auth/callback%3Fcode%3Ds3cr3tcode', 's3cr3tcode'],
  ['a token pair outside a URL', 'retry with access_token=hunter2hunter2 failed', 'hunter2hunter2'],
  ['a token pair with spaces', 'retry with token = hunter2hunter2 failed', 'hunter2hunter2'],
  ['a token pair in JSON', 'sent {"access_token":"hunter2hunter2"}', 'hunter2hunter2'],
  ['a pwd pair', 'tried pwd=hunter2hunter2', 'hunter2hunter2'],
  ['an err string with an email', `Error: duplicate key (email)=(${EMAIL}) already exists`, 'avery'],
];
// The same, less the one a mask cannot catch: the reason free text is not exported at all.
const MASKABLE = HAZARDS.slice(1);

const context = (overrides: Partial<SpanContext> = {}): SpanContext => ({
  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
  spanId: '00f067aa0ba902b7',
  traceFlags: TraceFlags.SAMPLED,
  ...overrides,
});

const RESOURCE = exportResource('svc-under-test');

function span(overrides: Partial<ReadableSpan> = {}): ReadableSpan {
  return {
    name: METHOD,
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
  it.each(MASKABLE)('masks %s', (_label, given, gone) => {
    const out = redactTraceText(given);
    expect(out).not.toContain(gone);
    expect(out).toContain(MASK);
  });

  it('leaves method names, words and numbers of up to three digits legible', () => {
    for (const kept of [METHOD, 'nwfl-mensa-api/grpc', 'status 14 after 3 tries', 'no member 123 on file', 'ConnectError', 'is it ready']) {
      expect(redactTraceText(kept)).toBe(kept);
    }
  });

  it('leaves a percent sign that encodes nothing as it is', () => {
    expect(redactTraceText('50% done, %zz and %ff%fe')).toBe('50% done, %zz and %ff%fe');
  });

  it('masks before it cuts, so a long text cannot leave half an address behind', () => {
    const out = redactTraceText(`${'x'.repeat(1_020)} ${EMAIL} ${'y'.repeat(2_000)}`);
    expect(out).not.toContain('avery');
    expect(out.length).toBeLessThan(1_100);
  });

  it('stays quick on long runs of digits, separators, pairs and encoded bytes', () => {
    const started = performance.now();
    redactTraceText(`${'1 2 3 4 '.repeat(20_000)}x`);
    redactTraceText(`${'1-'.repeat(50_000)}x`);
    redactTraceText(`${'code'.repeat(50_000)}`);
    redactTraceText(`${'a@'.repeat(50_000)}`);
    redactTraceText(`${'%2525'.repeat(30_000)}`);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('redactSpan', () => {
  describe.each(HAZARDS)('with %s', (_label, given) => {
    it('as the span name: a fixed word is sent instead', () => {
      expect(redactSpan(span({ name: given }), RESOURCE).name).toBe('span');
    });

    it('as the status message: only the code is sent', () => {
      const out = redactSpan(span({ status: { code: SpanStatusCode.ERROR, message: given } }), RESOURCE);
      expect(out.status).toEqual({ code: SpanStatusCode.ERROR });
    });

    it('as the value of a listed span attribute: the attribute is left out', () => {
      const out = redactSpan(span({ attributes: { 'rpc.method': given, 'rpc.system': given, 'rpc.grpc.status_code': given } }), RESOURCE);
      expect(out.attributes).toEqual({});
      expect(out.droppedAttributesCount).toBe(3);
      expect(redactSpan(span({ attributes: { 'rpc.method': [METHOD, given], 'rpc.system': ['grpc'] } }), RESOURCE).attributes).toEqual({});
    });

    it('as an event name, an exception message or an exception type: none is sent', () => {
      const out = redactSpan(span({ events: [{ time: [1, 1], name: given, attributes: { 'exception.message': given, 'exception.type': given } }] }), RESOURCE);
      expect(out.events).toEqual([{ time: [1, 1], name: 'event', attributes: {}, droppedAttributesCount: 2 }]);
    });

    it('as the instrumentation scope: a fixed word is sent instead, and no version', () => {
      const out = redactSpan(span({ instrumentationScope: { name: given, version: given, schemaUrl: given } }), RESOURCE);
      expect(out.instrumentationScope).toEqual({ name: 'scope' });
    });
  });

  describe.each(MASKABLE)('with %s', (_label, given, gone) => {
    it('in the resource: the service name is masked and the version left out', () => {
      const resource = exportResource(given, given);
      expect(JSON.stringify(resource.attributes)).not.toContain(gone);
      expect(Object.keys(resource.attributes)).toEqual(['service.name']);
      expect(resource.attributes['service.name']).toContain(MASK);
    });
  });

  // A text in the right shape still passes the masks: a number where a package name would be.
  it('masks a number inside a text that has an allowed shape', () => {
    const shaped = `_${NUMBER}.Svc/Get`;
    const out = redactSpan(
      span({
        name: shaped,
        attributes: { 'rpc.method': shaped },
        events: [{ time: [1, 1], name: 'exception', attributes: { 'exception.type': `E_${NUMBER}` } }],
        instrumentationScope: { name: `scope_${NUMBER}`, version: `v_${NUMBER}` },
      }),
      RESOURCE,
    );
    expect(out.name).toBe(`_${MASK}.Svc/Get`);
    expect(out.attributes).toEqual({ 'rpc.method': `_${MASK}.Svc/Get` });
    expect(out.events[0]?.attributes).toEqual({ 'exception.type': `E_${MASK}` });
    expect(out.instrumentationScope).toEqual({ name: `scope_${MASK}`, version: `v_${MASK}` });
  });

  it('keeps a span name only in the form package.Service/Method', () => {
    for (const kept of [METHOD, 'Health/Check', 'grpc.health.v1.Health/Watch', '_a.b_c/D1']) expect(redactSpan(span({ name: kept }), RESOURCE).name).toBe(kept);
    for (const replaced of ['', 'ListEvents', 'GET /events', '/ListEvents', 'nwfl.v1.EventService/', 'nwfl..EventService/List', 'a/b/c', 'nwfl.v1.EventService/List Events', '1a/B', 'a-b/C', `${'a'.repeat(200)}/B`, `nwfl.v1.X/Y\n${NAME}`]) {
      expect(redactSpan(span({ name: replaced }), RESOURCE).name).toBe('span');
    }
  });

  it('keeps exactly three span attribute keys, each only with a value of its own kind', () => {
    const attributes: Attributes = {
      'rpc.system': 'grpc',
      'rpc.method': METHOD,
      'rpc.grpc.status_code': 5,
      // Near the listed keys, with values that would pass for a listed one.
      'rpc.service': 'nwfl.v1.EventService',
      'rpc.method.original': METHOD,
      'rpc.grpc.status_code.text': 5,
      'rpc.grpc.request.metadata.authorization': 'grpc',
      'RPC.SYSTEM': 'grpc',
      ' rpc.system': 'grpc',
      'exception.type': 'ConnectError',
      // A SITE_KEYS key, a credential key, and keys no pattern could know to mask.
      'member.display_name': NAME,
      email: EMAIL,
      'http.request.header.authorization': 'Bearer abc.DEF-123_xyz',
      'peer.label': NAME,
      'url.full': 'https://site.example.org/auth/callback?code=s3cr3tcode',
      membership_number: NUMBER,
      'enduser.id': EMAIL,
      'db.statement': `select * from member where number = '${NUMBER}'`,
    };
    const out = redactSpan(span({ attributes, droppedAttributesCount: 2 }), RESOURCE);
    expect(out.attributes).toEqual({ 'rpc.system': 'grpc', 'rpc.method': METHOD, 'rpc.grpc.status_code': 5 });
    expect(out.droppedAttributesCount).toBe(17);
    expect([...SPAN_ATTRIBUTE_KEYS]).toEqual(['rpc.system', 'rpc.method', 'rpc.grpc.status_code']);
    expect([...EVENT_ATTRIBUTE_KEYS]).toEqual(['exception.type']);
  });

  it.each([
    ['rpc.system', ['http', 'GRPC', 'grpc ', 7, true]],
    ['rpc.method', [NAME, `${METHOD} ${NAME}`, 7, true]],
    ['rpc.grpc.status_code', ['5', -1, 17, 1.5, Number.NaN, true, NUMBER, Number(NUMBER)]],
  ])('leaves %s out when its value is not of its kind', (key, values) => {
    for (const value of values) expect(redactSpan(span({ attributes: { [key]: value } }), RESOURCE).attributes).toEqual({});
  });

  it('keeps every gRPC status code, 0 to 16', () => {
    for (const code of [0, 2, 16]) expect(redactSpan(span({ attributes: { 'rpc.grpc.status_code': code } }), RESOURCE).attributes).toEqual({ 'rpc.grpc.status_code': code });
  });

  it('keeps an exception as its type alone: no message, no stack, no other field', () => {
    const events = [
      {
        time: [1, 1] as [number, number],
        name: 'exception',
        attributes: {
          'exception.type': 'ConnectError',
          'exception.message': `no row for ${NAME}`,
          'exception.stacktrace': `ConnectError: no row for ${NAME}\n    at find (/app/dist/members.js:10:3)`,
          'exception.escaped': true,
          'member.display_name': NAME,
          note: NAME,
        },
        droppedAttributesCount: 1,
      },
      { time: [2, 2] as [number, number], name: `retry for ${NAME}` },
      { time: [3, 3] as [number, number], name: 'exception', attributes: { 'exception.type': `Error for ${NAME}` } },
      { time: [4, 4] as [number, number], name: 'exception', attributes: { 'exception.type': 23505 } },
    ];
    const out = redactSpan(span({ events }), RESOURCE);
    expect(out.events).toEqual([
      { time: [1, 1], name: 'exception', attributes: { 'exception.type': 'ConnectError' }, droppedAttributesCount: 6 },
      { time: [2, 2], name: 'event', attributes: {}, droppedAttributesCount: 0 },
      { time: [3, 3], name: 'exception', attributes: {}, droppedAttributesCount: 1 },
      { time: [4, 4], name: 'exception', attributes: {}, droppedAttributesCount: 1 },
    ]);
  });

  it('sends an event name that is only near `exception` as the fixed word, its text never', () => {
    const nearMisses = ['exceptionX', 'exception.message', 'exception foo', `exception: ${NAME}`, `exception${NAME}`, 'exceptions', 'exception ', ' exception', 'Exception', 'EXCEPTION', 'exception\n', 'exception​', `${NAME} exception`, 'my.exception'];
    const out = redactSpan(span({ events: nearMisses.map((name) => ({ time: [1, 1] as [number, number], name, attributes: { 'exception.type': 'ConnectError' } })) }), RESOURCE);
    expect(out.events.map((event) => event.name)).toEqual(nearMisses.map(() => 'event'));
    const sent = JSON.stringify(out.events);
    for (const gone of ['Avery', 'Quill', 'foo', 'message', 'exceptionX', 'exceptions', 'Exception', 'EXCEPTION', 'my.']) expect(sent).not.toContain(gone);
  });

  it('exports ids only from a span context: no tracestate, on the span, its parent or a link', () => {
    const traceState = createTraceState(`vendor=${NUMBER}`);
    const out = redactSpan(
      span({
        spanContext: () => context({ traceState, isRemote: false }),
        parentSpanContext: context({ spanId: '1111111111111111', traceState, isRemote: true }),
        links: [{ context: context({ spanId: '2222222222222222', traceState }), attributes: { note: NAME, 'rpc.method': METHOD }, droppedAttributesCount: 1 }],
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

  // The version is set when the image is built: a release or a commit id, which a digit mask would eat.
  it('sends a version only in the form of a release or a commit id, as it is', () => {
    for (const kept of ['0.1.0', '2026.11.18', '23c36164ad1d', 'v1.2.3-rc.1+build_7', 'dev']) expect(exportResource('svc', kept).attributes['service.version']).toBe(kept);
    for (const left of ['', ' 1.2.3', '1.2.3 for Avery', '-1', 'a'.repeat(65), 'v1/2', 'v1．2']) expect(exportResource('svc', left).attributes).toEqual({ 'service.name': 'svc' });
  });
});
