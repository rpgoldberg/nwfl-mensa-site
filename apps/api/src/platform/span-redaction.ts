// ============================================================================
// What of a span may leave the process (LG-N6). The trace exporter
// (telemetry.ts) passes every span through redactSpan before it is sent.
//
// Two layers, in this order:
//
//   1. An ALLOW-LIST of attribute keys. Every span here is made by this
//      service's own instrumentation (grpc/interceptors.ts), so the keys worth
//      exporting are known and few. A deny-list could only mask what a pattern
//      recognises, and nothing recognises a member's name in a value; a key
//      that is not listed is left out, whatever it holds. A new attribute is
//      exported only once its key is added here.
//   2. The SAME redaction as a log field (platform/shared.ts: fc-shared plus
//      the site's keys and email pattern) on every text that remains: the span
//      name, the status message, event names, the scope, the resource and the
//      values of the allowed keys. Three shapes are masked on top of it, since
//      a trace store is searched by more people-shaped text than a log line:
//      a query string, a `token=` style pair, and a membership-number-shaped
//      run of digits.
//
// An exception event keeps its type and its masked message; its stack trace is
// not an allowed key. A span context is exported as ids only: no tracestate,
// which is whatever a caller sent. Links keep their ids and no attributes.
// ============================================================================
import type { Attributes, Link, SpanContext } from '@opentelemetry/api';
import type { ReadableSpan, TimedEvent } from '@opentelemetry/sdk-trace';
import { NWFL_REDACT_OPTIONS, redactAttributes, redactString, type AttributeValue, type RedactOptions } from './shared.js';

/** The span attribute keys that are exported. Everything else is left out. */
export const SPAN_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set(['rpc.system', 'rpc.method', 'rpc.grpc.status_code']);

/** The event attribute keys that are exported: an exception's type and message, never its stack. */
export const EVENT_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set(['exception.type', 'exception.message']);

// A query string: from the question mark to the end of the URL it is in.
const QUERY_STRING = /\?[^\s"'<>]*/g;

// `access_token=...`, `code=...`: a credential written as a pair outside a URL.
const CREDENTIAL_PAIR = /(?:token|secret|password|passwd|code|key|session|state|signature)=[^\s&"']+/gi;

// A membership number is 1 to 12 digits (migrations/0005), and members type it with spaces or dashes.
// Masked here: four or more digits, alone or in groups joined by one space or dash, that are not part of
// a longer word or id (a UUID, a hex id and `v1` stay legible). Numbers, as opposed to digits in a
// text, are not touched: a status code or a duration is a number attribute. The look-behinds also keep
// the scan linear: a run is tried from its first digit only.
const NUMBER_SHAPE = /(?<![0-9A-Za-z])(?<![0-9A-Za-z]-)(?<!\d )\d(?:[ -]?\d){3,}(?![0-9A-Za-z])(?!-[0-9A-Za-z])/g;

/** No text in a span needs more than this; the cut comes after the masks. */
const MAX_TEXT_LENGTH = 1_024;

const TRACE_REDACT_OPTIONS: RedactOptions = {
  ...NWFL_REDACT_OPTIONS,
  secretValuePatterns: [...(NWFL_REDACT_OPTIONS.secretValuePatterns ?? []), QUERY_STRING, CREDENTIAL_PAIR, NUMBER_SHAPE],
  maxStringLength: MAX_TEXT_LENGTH,
};

/** A text as a span may carry it: the log redaction, then the trace-only shapes, then the length cap. */
export function redactTraceText(text: string): string {
  return redactString(text, TRACE_REDACT_OPTIONS);
}

function allowed(attributes: Attributes | undefined, keys: ReadonlySet<string>): { kept: Attributes; removed: number } {
  const picked: Record<string, AttributeValue> = {};
  let removed = 0;
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (keys.has(key)) picked[key] = value as AttributeValue;
    else removed += 1;
  }
  return { kept: redactAttributes(picked, TRACE_REDACT_OPTIONS), removed };
}

/** Ids and flags only. */
function idsOnly(given: SpanContext): SpanContext {
  return {
    traceId: given.traceId,
    spanId: given.spanId,
    traceFlags: given.traceFlags,
    ...(given.isRemote !== undefined ? { isRemote: given.isRemote } : {}),
  };
}

function redactEvent(event: TimedEvent): TimedEvent {
  const { kept, removed } = allowed(event.attributes, EVENT_ATTRIBUTE_KEYS);
  return { time: event.time, name: redactTraceText(event.name), attributes: kept, droppedAttributesCount: (event.droppedAttributesCount ?? 0) + removed };
}

function redactLink(link: Link): Link {
  return { context: idsOnly(link.context), droppedAttributesCount: (link.droppedAttributesCount ?? 0) + Object.keys(link.attributes ?? {}).length };
}

export type SpanResource = ReadableSpan['resource'];

/**
 * The resource every exported span carries: the service name, and its version when known. Built
 * here rather than detected, so no host name, process argument or environment value is in it.
 */
export function exportResource(serviceName: string, serviceVersion?: string): SpanResource {
  const attributes: Attributes = {
    'service.name': redactTraceText(serviceName),
    ...(serviceVersion !== undefined ? { 'service.version': redactTraceText(serviceVersion) } : {}),
  };
  const resource: SpanResource = {
    asyncAttributesPending: false,
    attributes,
    merge: () => resource,
    getRawAttributes: () => Object.entries(attributes),
  };
  return resource;
}

/** A copy of the span that is safe to export. The span itself is not changed. */
export function redactSpan(span: ReadableSpan, resource: SpanResource): ReadableSpan {
  const { kept, removed } = allowed(span.attributes, SPAN_ATTRIBUTE_KEYS);
  const context = idsOnly(span.spanContext());
  const scope = span.instrumentationScope;
  return {
    name: redactTraceText(span.name),
    kind: span.kind,
    spanContext: () => context,
    ...(span.parentSpanContext !== undefined ? { parentSpanContext: idsOnly(span.parentSpanContext) } : {}),
    startTime: span.startTime,
    endTime: span.endTime,
    duration: span.duration,
    ended: span.ended,
    status: { code: span.status.code, ...(span.status.message !== undefined ? { message: redactTraceText(span.status.message) } : {}) },
    attributes: kept,
    links: span.links.map(redactLink),
    events: span.events.map(redactEvent),
    resource,
    instrumentationScope: {
      name: redactTraceText(scope.name),
      ...(scope.version !== undefined ? { version: redactTraceText(scope.version) } : {}),
    },
    droppedAttributesCount: span.droppedAttributesCount + removed,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  };
}
