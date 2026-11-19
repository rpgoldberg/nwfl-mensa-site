// ============================================================================
// What of a span may leave the process (LG-N6). The trace exporter
// (telemetry.ts) passes every span through redactSpan before it is sent.
//
// The rule: NO FREE TEXT leaves. A mask can recognise an address or a number,
// never a member's name, so a text is exported only when it has a fixed shape
// that a sentence cannot have, and is replaced by a fixed word or left out
// otherwise.
//
//   - Span name: kept in the gRPC form `package.Service/Method`, else `span`.
//   - Status: the code. The message is never sent.
//   - Span attributes: three keys, each only with a value of its own kind
//     (SPAN_ATTRIBUTES says why each is safe). Any other key is left out,
//     whatever it holds. A new attribute is exported only once it is added
//     there, with a rule for its value.
//   - Events: the name `exception` or the word `event`; of the attributes,
//     only `exception.type`, as an identifier. No message, no stack: an error
//     from a driver can repeat the row it failed on (grpc/interceptors.ts).
//   - Scope: the tracer's name and version in an identifier form, else
//     `scope` and no version.
//   - Span context, parent, links: ids and flags only. No tracestate, which
//     is whatever a caller sent; no link attributes.
//   - Resource: built here, not detected: the service name, and the version
//     when it looks like a release or a commit id.
//
// What is kept still passes the SAME redaction as a log field
// (platform/shared.ts: fc-shared plus the site's keys and email pattern), and
// on top of it the trace masks below, after the text is normalised: a query
// string, a `token=` style pair, anything around an at sign, and a
// membership-number-shaped run of digits.
// ============================================================================
import type { Attributes, Link, SpanContext } from '@opentelemetry/api';
import type { ReadableSpan, TimedEvent } from '@opentelemetry/sdk-trace';
import { NWFL_REDACT_OPTIONS, redactAttributes, redactString, type AttributeValue, type RedactOptions } from './shared.js';

/** `package.Service/Method`, as protobuf names them: identifiers, dots, one slash. */
const METHOD_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*\/[A-Za-z_][A-Za-z0-9_]*$/;
/** An error class or code name: `ConnectError`, `ERR_HTTP2_STREAM_ERROR`. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$.]*$/;
/** A tracer's name or version: `nwfl-mensa-api/grpc`, `1.0.0`. */
const SCOPE_TEXT = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
/** A release or a commit id: `0.1.0`, `23c36164ad1d`, `v1.2.3-rc.1+build_7`. */
const VERSION_TEXT = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

const shaped = (shape: RegExp, max: number) => (value: unknown): boolean => typeof value === 'string' && value.length <= max && shape.test(value);

const isMethodName = shaped(METHOD_NAME, 128);
const isIdentifier = shaped(IDENTIFIER, 64);
const isScopeText = shaped(SCOPE_TEXT, 64);
const isVersionText = shaped(VERSION_TEXT, 64);

type ValueRule = (value: unknown) => boolean;

/**
 * The span attributes that are exported, each with the rule its value must meet. A value that does
 * not meet it is left out with its key. Why each is safe:
 *   - rpc.system: the one constant this service sets.
 *   - rpc.method: a method name in its protobuf form, which a sentence or an address cannot have.
 *   - rpc.grpc.status_code: one of the seventeen gRPC codes, as a number.
 */
const SPAN_ATTRIBUTES: ReadonlyMap<string, ValueRule> = new Map<string, ValueRule>([
  ['rpc.system', (value) => value === 'grpc'],
  ['rpc.method', isMethodName],
  ['rpc.grpc.status_code', (value) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 16],
]);

/** The event attributes that are exported: an exception's type, as an identifier. Never its message or stack. */
const EVENT_ATTRIBUTES: ReadonlyMap<string, ValueRule> = new Map<string, ValueRule>([['exception.type', isIdentifier]]);

export const SPAN_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set(SPAN_ATTRIBUTES.keys());
export const EVENT_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set(EVENT_ATTRIBUTES.keys());

// A query string: from the question mark to the end of the URL it is in.
const QUERY_STRING = /\?[^\s"'<>]*/g;

// `access_token=...`, `token = ...`, `"access_token":"..."`, `pwd=...`: a credential written as a pair.
const CREDENTIAL_PAIR = /(?:token|secret|password|passwd|pwd|code|key|session|state|signature)["']?\s*[=:]\s*["']?[^\s&"',}]+/gi;

// Anything around an at sign: an address the stricter log pattern does not know, such as one at a
// domain outside ASCII.
const AROUND_AT = /[^\s@]{1,64}@[^\s@]{1,255}/g;

// A membership number is 1 to 12 digits (migrations/0005), and members type it with spaces, dashes or
// dots. Masked here: four or more digits, of any script, alone or in groups joined by one such
// separator, wherever they stand (`member-10234567`, `M10234567`). Numbers, as opposed to digits in
// a text, are not touched: a status code is a number attribute.
const NUMBER_SHAPE = /\p{Nd}(?:[ .-]?\p{Nd}){3,}/gu;

/** No text in a span needs more than this; the cut comes after the masks. */
const MAX_TEXT_LENGTH = 1_024;

const TRACE_REDACT_OPTIONS: RedactOptions = {
  ...NWFL_REDACT_OPTIONS,
  secretValuePatterns: [...(NWFL_REDACT_OPTIONS.secretValuePatterns ?? []), QUERY_STRING, CREDENTIAL_PAIR, AROUND_AT, NUMBER_SHAPE],
  maxStringLength: MAX_TEXT_LENGTH,
};

const NOT_SHOWN = /[\p{Cc}\p{Cf}]/gu;
const ENCODED_BYTES = /(?:%[0-9A-Fa-f]{2})+/g;

function decoded(bytes: string): string {
  try {
    return decodeURIComponent(bytes);
  } catch {
    return bytes;
  }
}

/**
 * The text as a reader, or a later decoder, would take it, so a mask meets what it is looking for:
 * compatibility forms folded (a fullwidth at sign or digit), characters that are not shown taken out,
 * percent-encoding undone. Three times, for a text encoded more than once.
 */
function normalised(text: string): string {
  let out = text;
  for (let round = 0; round < 3; round += 1) out = out.replace(ENCODED_BYTES, decoded).normalize('NFKC').replace(NOT_SHOWN, '');
  return out;
}

/** A text as a span may carry it: normalised, the log redaction, the trace masks, then the length cap. */
export function redactTraceText(text: string): string {
  return redactString(normalised(text), TRACE_REDACT_OPTIONS);
}

function allowed(attributes: Attributes | undefined, rules: ReadonlyMap<string, ValueRule>): { kept: Attributes; removed: number } {
  const picked: Record<string, AttributeValue> = {};
  let removed = 0;
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (rules.get(key)?.(value) === true) picked[key] = value as AttributeValue;
    else removed += 1;
  }
  return { kept: redactAttributes(picked, TRACE_REDACT_OPTIONS), removed };
}

/** What stands in for a name that is not in an exported form. */
const OTHER_SPAN = 'span';
const OTHER_EVENT = 'event';
const OTHER_SCOPE = 'scope';
const EXCEPTION_EVENT = 'exception';

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
  const { kept, removed } = allowed(event.attributes, EVENT_ATTRIBUTES);
  return { time: event.time, name: event.name === EXCEPTION_EVENT ? EXCEPTION_EVENT : OTHER_EVENT, attributes: kept, droppedAttributesCount: (event.droppedAttributesCount ?? 0) + removed };
}

function redactLink(link: Link): Link {
  return { context: idsOnly(link.context), droppedAttributesCount: (link.droppedAttributesCount ?? 0) + Object.keys(link.attributes ?? {}).length };
}

export type SpanResource = ReadableSpan['resource'];

/**
 * The resource every exported span carries: the service name, and its version when it is known and
 * looks like a release or a commit id. Built
 * here rather than detected, so no host name, process argument or environment value is in it.
 */
export function exportResource(serviceName: string, serviceVersion?: string): SpanResource {
  const attributes: Attributes = {
    'service.name': redactTraceText(serviceName),
    // Set when the image is built, and sent as it is: a digit mask would eat a commit id.
    ...(isVersionText(serviceVersion) ? { 'service.version': serviceVersion } : {}),
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
  const { kept, removed } = allowed(span.attributes, SPAN_ATTRIBUTES);
  const context = idsOnly(span.spanContext());
  const scope = span.instrumentationScope;
  return {
    name: isMethodName(span.name) ? redactTraceText(span.name) : OTHER_SPAN,
    kind: span.kind,
    spanContext: () => context,
    ...(span.parentSpanContext !== undefined ? { parentSpanContext: idsOnly(span.parentSpanContext) } : {}),
    startTime: span.startTime,
    endTime: span.endTime,
    duration: span.duration,
    ended: span.ended,
    status: { code: span.status.code },
    attributes: kept,
    links: span.links.map(redactLink),
    events: span.events.map(redactEvent),
    resource,
    instrumentationScope: {
      name: isScopeText(scope.name) ? redactTraceText(scope.name) : OTHER_SCOPE,
      ...(isScopeText(scope.name) && isScopeText(scope.version) ? { version: redactTraceText(scope.version as string) } : {}),
    },
    droppedAttributesCount: span.droppedAttributesCount + removed,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  };
}
