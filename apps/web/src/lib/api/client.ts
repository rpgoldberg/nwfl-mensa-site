// The site's reads from nwfl-mensa-api (W3), over the gRPC wire protocol only:
// HTTP/2, application/grpc, never Connect or gRPC-Web (the API refuses both).
// In the cluster the address is the API's Service in plain h2c; the Linkerd
// proxy beside each pod adds the mTLS on the hop.
//
// Every call goes out as the public: no Authorization header, no cookie,
// nothing about the reader. The API works the audience out from what it gets
// (no token: anonymous, public; apps/api/src/auth/caller.ts), so the site
// never claims an audience of its own.
//
// Read RPCs only. ReadFile streams a PDF (REDACT R3c): the head comes first,
// then the bytes, handed on as they arrive; a stream that breaks after the
// head fails the body, which the reader sees as a cut-off download.
//
// Read RPCs only. A failure of any kind is logged by call and code (never the
// API's message) and becomes ApiUnavailable, which the pages answer with a
// plain "temporarily unavailable" and 503.
import { Code, ConnectError, createClient } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import { type ContentItem, ContentKind, ContentService, type ReadFileResponse } from '../../gen/nwfl/mensa/v1/content_pb.js';
import { type EventOccurrence, type EventSeries, EventService } from '../../gen/nwfl/mensa/v1/event_pb.js';
import type { Office } from '../../gen/nwfl/mensa/v1/roster_pb.js';

export interface ApiConfig {
  baseUrl: string;
  timeoutMs: number;
}

/** Off (no API_URL), on, or on but set up wrongly: then every read is unavailable. */
export type ApiSetup = { enabled: false } | { enabled: true; config: ApiConfig } | { enabled: true; error: string };

export const DEFAULT_TIMEOUT_MS = 3000;
/** The API's own cap on a message; a bigger answer is refused, not held. */
export const READ_MAX_BYTES = 4 * 1024 * 1024;

export class ApiUnavailable extends Error {
  constructor(readonly rpc: string) {
    super(`the API did not answer ${rpc}`);
    this.name = 'ApiUnavailable';
  }
}

/** The most ReadFile may stream (R11), and how long it may take. */
export const FILE_MAX_BYTES = 10 * 1024 * 1024;
export const FILE_TIMEOUT_MS = 60_000;

/** A file as the public may have it: its bytes, still arriving; "not ready"; or not found (missing and withheld alike). */
export type FileRead = { kind: 'pdf'; filename: string; size: number; body: ReadableStream<Uint8Array> } | { kind: 'not_ready' } | { kind: 'not_found' };

export class ApiNotFound extends Error {
  constructor(readonly rpc: string) {
    super(`the API has no such thing (${rpc})`);
    this.name = 'ApiNotFound';
  }
}

/** API_URL (http: or https:, the bare origin) and API_TIMEOUT_MS (1 to 60000, default 3000). */
export function apiSetup(env: Record<string, string | undefined>): ApiSetup {
  const raw = env['API_URL'];
  if (!raw) return { enabled: false };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { enabled: true, error: 'API_URL is not a URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { enabled: true, error: 'API_URL must be http: or https:' };
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    return { enabled: true, error: 'API_URL must be an origin only: no credentials, path, query or fragment' };
  }
  const timeout = env['API_TIMEOUT_MS'] ?? String(DEFAULT_TIMEOUT_MS);
  const timeoutMs = Number(timeout);
  if (!/^\d+$/.test(timeout) || timeoutMs < 1 || timeoutMs > 60_000) return { enabled: true, error: 'API_TIMEOUT_MS must be a whole number of milliseconds from 1 to 60000' };
  return { enabled: true, config: { baseUrl: url.origin, timeoutMs } };
}

/** What the site reads, and nothing it could write with. */
export interface ApiReads {
  listOccurrences(from: string, to: string): Promise<EventOccurrence[]>;
  /** Rejects with ApiNotFound when the API has no such event. */
  getOccurrence(id: string): Promise<EventOccurrence | undefined>;
  listSeries(): Promise<EventSeries[]>;
  getRoster(): Promise<Office[]>;
  listPublishedItems(kind: ContentKind, pageSize: number): Promise<ContentItem[]>;
  readFile(id: string): Promise<FileRead>;
}

const codeName = (code: Code) => Code[code].replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();

const protoDate = (iso: string) => ({ year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)), day: Number(iso.slice(8, 10)) });

/** The reads over one HTTP/2 connection to the API. `log` takes one JSON line. */
export function grpcReads(config: ApiConfig, log: (line: string) => void): ApiReads {
  const transport = createGrpcTransport({ baseUrl: config.baseUrl, defaultTimeoutMs: config.timeoutMs, readMaxBytes: READ_MAX_BYTES });
  const events = createClient(EventService, transport);
  const content = createClient(ContentService, transport);

  const call = async <T>(rpc: string, run: () => Promise<T>, notFound = false): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      const code = ConnectError.from(error).code;
      if (notFound && code === Code.NotFound) throw new ApiNotFound(rpc);
      log(JSON.stringify({ level: 'error', msg: 'api call failed', rpc, code: codeName(code) }));
      throw new ApiUnavailable(rpc);
    }
  };

  /** The bytes after the head, as a stream that fails on a break, or on more or fewer bytes than the head said. */
  const fileBody = (messages: AsyncIterator<ReadFileResponse>, size: number, abort: AbortController): ReadableStream<Uint8Array> => {
    let seen = 0;
    const fail = (controller: ReadableStreamDefaultController<Uint8Array>, code: string) => {
      log(JSON.stringify({ level: 'error', msg: 'api stream failed', rpc: 'ReadFile', code }));
      abort.abort();
      controller.error(new ApiUnavailable('ReadFile'));
    };
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        let next: IteratorResult<ReadFileResponse>;
        try {
          next = await messages.next();
        } catch (error) {
          fail(controller, codeName(ConnectError.from(error).code));
          return;
        }
        if (next.done) {
          if (seen === size) controller.close();
          else fail(controller, 'short');
          return;
        }
        const { part } = next.value;
        if (part.case !== 'chunk') return fail(controller, 'unexpected_message');
        seen += part.value.length;
        if (seen > size) return fail(controller, 'too_long');
        controller.enqueue(part.value);
      },
      cancel() {
        abort.abort();
      },
    });
  };

  const readFile = async (id: string): Promise<FileRead> => {
    const abort = new AbortController();
    try {
      return await call(
        'ReadFile',
        async (): Promise<FileRead> => {
          const messages = content.readFile({ fileId: id }, { signal: abort.signal, timeoutMs: FILE_TIMEOUT_MS })[Symbol.asyncIterator]();
          const first = await messages.next();
          const part = first.done ? undefined : first.value.part;
          if (part?.case === 'notReady') return { kind: 'not_ready' };
          if (part?.case !== 'head') throw new ConnectError('the answer did not start with its head', Code.DataLoss);
          // Over the cap: refused before a byte is handed on (the body checks it keeps to the head's size).
          if (part.value.sizeBytes > BigInt(FILE_MAX_BYTES)) throw new ConnectError('the file is over 10 MiB', Code.ResourceExhausted);
          return { kind: 'pdf', filename: part.value.filename, size: Number(part.value.sizeBytes), body: fileBody(messages, Number(part.value.sizeBytes), abort) };
        },
        true,
      );
    } catch (error) {
      abort.abort();
      if (error instanceof ApiNotFound) return { kind: 'not_found' };
      throw error;
    }
  };

  return {
    readFile,
    listOccurrences: (from, to) =>
      call('ListOccurrences', async () => (await events.listOccurrences({ from: protoDate(from), to: protoDate(to), includeCancelled: true })).occurrences),
    getOccurrence: (id) => call('GetOccurrence', async () => (await events.getOccurrence({ id })).occurrence, true),
    listSeries: () => call('ListSeries', async () => (await events.listSeries({ includeInactive: false })).series),
    getRoster: () => call('GetRoster', async () => (await content.getRoster({})).offices),
    listPublishedItems: (kind, pageSize) => call('ListPublishedItems', async () => (await content.listPublishedItems({ kind, pageSize })).items),
  };
}

/** Every read fails: the API is switched on but set up wrongly. */
export function unavailableReads(): ApiReads {
  const fail = (rpc: string) => () => Promise.reject(new ApiUnavailable(rpc));
  return {
    listOccurrences: fail('ListOccurrences'),
    getOccurrence: fail('GetOccurrence'),
    listSeries: fail('ListSeries'),
    getRoster: fail('GetRoster'),
    listPublishedItems: fail('ListPublishedItems'),
    readFile: fail('ReadFile'),
  };
}
