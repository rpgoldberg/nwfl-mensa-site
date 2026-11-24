// A local OTLP gRPC trace receiver for tests: plain HTTP/2 on 127.0.0.1, the
// TraceService/Export method only. It keeps every request's bytes and a decoded
// view of them, so a test reads exactly what left the process. It can also
// misbehave: never answer, or refuse every call as UNAVAILABLE.
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { BinaryReader, WireType } from '@bufbuild/protobuf/wire';

export type ReceiverMode = 'ok' | 'hang' | 'unavailable';

export interface ReceivedEvent {
  name: string;
  attributes: Record<string, unknown>;
}

export interface ReceivedSpan {
  traceId: string;
  traceState: string;
  name: string;
  attributes: Record<string, unknown>;
  events: ReceivedEvent[];
  links: number;
  statusMessage: string;
  statusCode: number;
  resource: Record<string, unknown>;
  scope: string;
}

export interface OtlpReceiver {
  readonly port: number;
  /** `http://127.0.0.1:<port>`. */
  readonly url: string;
  /** Export calls seen so far, answered or not. */
  calls(): number;
  spans(): ReceivedSpan[];
  /** Every request message received, concatenated, as text. */
  rawText(): string;
  close(): Promise<void>;
}

const EXPORT_PATH = '/opentelemetry.proto.collector.trace.v1.TraceService/Export';

type Field = { no: number; bytes?: Uint8Array; varint?: number };

function fields(bytes: Uint8Array): Field[] {
  const reader = new BinaryReader(bytes);
  const out: Field[] = [];
  while (reader.pos < reader.len) {
    const [no, wireType] = reader.tag();
    if (wireType === WireType.LengthDelimited) out.push({ no, bytes: reader.bytes() });
    else if (wireType === WireType.Varint) out.push({ no, varint: Number(reader.uint64()) });
    else reader.skip(wireType);
  }
  return out;
}

const text = (bytes: Uint8Array | undefined): string => Buffer.from(bytes ?? []).toString('utf8');
const hex = (bytes: Uint8Array | undefined): string => Buffer.from(bytes ?? []).toString('hex');
const all = (list: Field[], no: number): Uint8Array[] => list.filter((f) => f.no === no && f.bytes !== undefined).map((f) => f.bytes as Uint8Array);
const one = (list: Field[], no: number): Uint8Array | undefined => all(list, no)[0];

/** AnyValue: 1 string, 2 bool, 3 int, 5 array, 6 key-value list. */
function anyValue(bytes: Uint8Array | undefined): unknown {
  for (const field of fields(bytes ?? new Uint8Array())) {
    if (field.no === 1) return text(field.bytes);
    if (field.no === 2) return field.varint === 1;
    if (field.no === 3) return field.varint;
    if (field.no === 5) return all(fields(field.bytes as Uint8Array), 1).map(anyValue);
    if (field.no === 6) return keyValues(all(fields(field.bytes as Uint8Array), 1));
  }
  return undefined;
}

function keyValues(list: Uint8Array[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const bytes of list) {
    const pair = fields(bytes);
    out[text(one(pair, 1))] = anyValue(one(pair, 2));
  }
  return out;
}

function decode(message: Uint8Array): ReceivedSpan[] {
  const spans: ReceivedSpan[] = [];
  for (const resourceSpans of all(fields(message), 1)) {
    const rs = fields(resourceSpans);
    const resource = keyValues(all(fields(one(rs, 1) ?? new Uint8Array()), 1));
    for (const scopeSpans of all(rs, 2)) {
      const ss = fields(scopeSpans);
      const scope = text(one(fields(one(ss, 1) ?? new Uint8Array()), 1));
      for (const spanBytes of all(ss, 2)) {
        const span = fields(spanBytes);
        const status = fields(one(span, 15) ?? new Uint8Array());
        spans.push({
          traceId: hex(one(span, 1)),
          traceState: text(one(span, 3)),
          name: text(one(span, 5)),
          attributes: keyValues(all(span, 9)),
          events: all(span, 11).map((bytes) => {
            const event = fields(bytes);
            return { name: text(one(event, 2)), attributes: keyValues(all(event, 3)) };
          }),
          links: all(span, 13).length,
          statusMessage: text(one(status, 2)),
          statusCode: status.find((f) => f.no === 3)?.varint ?? 0,
          resource,
          scope,
        });
      }
    }
  }
  return spans;
}

export async function startOtlpReceiver(mode: ReceiverMode = 'ok'): Promise<OtlpReceiver> {
  const messages: Buffer[] = [];
  const sessions = new Set<http2.ServerHttp2Session>();
  let calls = 0;
  const server = http2.createServer();
  server.on('session', (session) => {
    sessions.add(session);
    session.on('close', () => sessions.delete(session));
  });
  server.on('stream', (stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on('error', () => {});
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => {
      calls += 1;
      if (mode === 'hang') return;
      if (mode === 'unavailable' || headers[':path'] !== EXPORT_PATH) {
        stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': mode === 'unavailable' ? '14' : '12', 'grpc-message': 'refused' }, { endStream: true });
        return;
      }
      // One length-prefixed message: a flag byte, four length bytes, the message.
      messages.push(Buffer.concat(chunks).subarray(5));
      stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
      stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
      stream.end(Buffer.alloc(5));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    calls: () => calls,
    spans: () => messages.flatMap((message) => decode(message)),
    rawText: () => Buffer.concat(messages).toString('utf8'),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const session of sessions) session.destroy();
      }),
  };
}

/** A port on 127.0.0.1 that nothing listens on: bound once, then closed. */
export async function closedPort(): Promise<number> {
  const receiver = await startOtlpReceiver();
  await receiver.close();
  return receiver.port;
}
