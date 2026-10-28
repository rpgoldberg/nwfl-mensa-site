// ============================================================================
// Structured JSON logging to stdout (R15), ported from fc-coordinator.
//
// Every line is one JSON object and carries the fc-shared trace tag
// (`trace=<traceId> span=<spanId>`) whenever a span is active. The tag is
// ABSENT, not zeroed, when no span is active. Every field passes through
// fc-shared redaction with the site's own keys added (platform/shared.ts).
//
// Shaped as a pino-compatible logger so Fastify accepts it as
// `loggerInstance`.
// ============================================================================
import { NWFL_REDACT_OPTIONS, getActiveTraceIds, redactString, redactValue, sanitizeLogValue } from './shared.js';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';

export const LOG_LEVELS: readonly LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'];

const SEVERITY: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: 100,
};

export type LogSink = (line: string) => void;

export interface LoggerOptions {
  name?: string;
  level?: LogLevel;
  /** Where a finished line goes. Default: one line on stdout. */
  sink?: LogSink;
  /** Fields merged into every line; child loggers accumulate these. */
  bindings?: Record<string, unknown>;
}

export interface StructuredLogger {
  // `string`, not LogLevel, so the logger is assignable to Fastify's
  // FastifyBaseLogger.
  readonly level: string;
  trace(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  fatal(...args: unknown[]): void;
  silent(...args: unknown[]): void;
  child(bindings: Record<string, unknown>): StructuredLogger;
}

const defaultSink: LogSink = (line) => process.stdout.write(`${line}\n`);

/** Split a pino-style call into (fields, message). An Error first is a message. */
function splitArgs(args: unknown[]): { fields: Record<string, unknown>; message: unknown } {
  const [first, ...rest] = args;
  if (first !== null && typeof first === 'object' && !(first instanceof Error) && !Array.isArray(first)) {
    return { fields: first as Record<string, unknown>, message: rest[0] };
  }
  return { fields: {}, message: first };
}

// Shallow on purpose: one Fastify `{ req }` binding would otherwise serialise
// the whole socket graph.
const MAX_FIELD_DEPTH = 4;

/**
 * Fastify's request and reply, reduced to what an access line needs. A request
 * body and its headers are never kept: method, url, id and peer only.
 */
const SERIALIZERS: Record<string, (value: unknown) => unknown> = {
  req: (value) => {
    if (value === null || typeof value !== 'object') return value;
    const req = value as { id?: unknown; method?: unknown; url?: unknown; ip?: unknown };
    return { id: req.id, method: req.method, url: req.url, remoteAddress: req.ip };
  },
  res: (value) => {
    if (value === null || typeof value !== 'object') return value;
    return { statusCode: (value as { statusCode?: unknown }).statusCode };
  },
};

function safeFields(fields: Record<string, unknown>): Record<string, unknown> {
  const reduced: Record<string, unknown> = {};
  for (const key of Object.keys(fields)) {
    const serializer = SERIALIZERS[key];
    reduced[key] = serializer ? serializer(fields[key]) : fields[key];
  }
  const redacted = redactValue(reduced, { ...NWFL_REDACT_OPTIONS, maxDepth: MAX_FIELD_DEPTH }) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(redacted)) {
    const value = redacted[key];
    out[key] = typeof value === 'string' ? sanitizeLogValue(value) : value;
  }
  return out;
}

/**
 * The message as one log-safe string. Secret shapes and email addresses are
 * masked BEFORE the length cap, so the cap cannot cut an address in half and
 * leave its local part behind; once more after, for a non-string message that
 * only becomes text in sanitizeLogValue.
 */
function safeMessage(message: unknown): string {
  const text = message instanceof Error ? message.message || 'Error (no message)' : message;
  const masked = typeof text === 'string' ? redactString(text, NWFL_REDACT_OPTIONS) : text;
  return redactString(sanitizeLogValue(masked), NWFL_REDACT_OPTIONS);
}

export function createStructuredLogger(options: LoggerOptions = {}): StructuredLogger {
  const level = options.level ?? 'info';
  const sink = options.sink ?? defaultSink;
  const bindings = options.bindings ?? {};
  const threshold = SEVERITY[level];

  const emit = (at: LogLevel, args: unknown[]): void => {
    if (SEVERITY[at] < threshold) return;
    const { fields, message } = splitArgs(args);
    const entry: Record<string, unknown> = {
      level: at,
      time: new Date().toISOString(),
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...bindings,
      ...safeFields(fields),
      msg: safeMessage(message),
    };
    const ids = getActiveTraceIds();
    if (ids !== undefined) {
      entry['trace'] = `trace=${ids.traceId} span=${ids.spanId}`;
      entry['traceId'] = ids.traceId;
      entry['spanId'] = ids.spanId;
    }
    sink(JSON.stringify(entry));
  };

  return {
    level,
    trace: (...args) => emit('trace', args),
    debug: (...args) => emit('debug', args),
    info: (...args) => emit('info', args),
    warn: (...args) => emit('warn', args),
    error: (...args) => emit('error', args),
    fatal: (...args) => emit('fatal', args),
    silent: () => {},
    child: (childBindings) =>
      createStructuredLogger({ ...options, level, sink, bindings: { ...bindings, ...safeFields(childBindings) } }),
  };
}
