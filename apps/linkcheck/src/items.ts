// ============================================================================
// items (L-ITEM, SPEC-v3 3.4): the officer pieces' links, checked by the same rules as an issue's.
//
//   1. a client-credentials token from the identity provider (Authentik's machine-to-machine form:
//      client_id, the service account's name and its app password, scope links.check);
//   2. LinkCheckService.ListLinksAwaitingVerdict: addresses only, never text, words or titles;
//   3. check.ts on each address (no AI, the hardened rules), mapped to the stored verdicts:
//        ok                               -> OK      (lets the link through Approve for 7 days)
//        upgrade, confirm, review, flag   -> CONFIRM (a person looks: the address as written is not the
//                                                     one that works, it needs a sign-in, it is on the
//                                                     no-fetch list, or the checker could not tell)
//        drop                             -> DROP    (holds Approve until a yes with a note)
//      with the check's reason codes. A piece is about now, so check.ts is given the day NEW_DOMAIN_DAYS
//      before today as its issue date: a domain registered in the last 90 days is `re-registered`, which
//      is `flag`, stored as CONFIRM. A domain bought last week never gets an OK with no person looking;
//   4. LinkCheckService.RecordLinkVerdicts, in requests of at most MAX_RECORD_BYTES (the API reads no
//      message over 256 KiB), then the next list while more wait.
//
// This module needs node built-ins only, so the API's suite can drive it against the real API server
// (apps/api test/links/linkcheck-items.test.ts). The protobuf messages are written and read here by hand:
// four small messages, checked against the API's generated code in that test. The address list and the
// verdicts never reach stdout: the command prints counts only. A token is never printed.
// ============================================================================
import http2 from 'node:http2';

/** check.ts's verdicts (VERDICTS), named here so this module needs nothing else. */
export type CheckVerdict = 'ok' | 'upgrade' | 'confirm' | 'review' | 'flag' | 'drop';

/** nwfl.mensa.v1.MachineVerdict. */
export const MACHINE = { OK: 1, CONFIRM: 2, DROP: 3 } as const;
export type Machine = (typeof MACHINE)[keyof typeof MACHINE];

export interface LinkVerdict {
  url: string;
  verdict: Machine;
  reasons: string[];
}

export class ItemsError extends Error {
  override name = 'ItemsError';
}

/** A domain registered in the last this many days is a person's call (`re-registered`, stored as CONFIRM). */
export const NEW_DOMAIN_DAYS = 90;

/** The issue date check.ts is given in items mode: NEW_DOMAIN_DAYS before today (UTC), YYYY-MM-DD. A registration after it is flagged. */
export function newDomainSince(now: Date): string {
  return new Date(now.getTime() - NEW_DOMAIN_DAYS * 86_400_000).toISOString().slice(0, 10);
}

/** The stored verdict for a check result (the table above). */
export function storedVerdict(result: { url: string; verdict: CheckVerdict; reasons: readonly string[] }): LinkVerdict {
  const verdict = result.verdict === 'ok' ? MACHINE.OK : result.verdict === 'drop' ? MACHINE.DROP : MACHINE.CONFIRM;
  return { url: result.url, verdict, reasons: [...new Set(result.reasons)].slice(0, 8) };
}

// ---------------------------------------------------------------------------
// The protobuf wire format, for the four messages of LinkCheckService.

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function varint(value: number): number[] {
  const out: number[] = [];
  let v = value;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
}

function lengthDelimited(field: number, bytes: Uint8Array): number[] {
  return [...varint((field << 3) | 2), ...varint(bytes.length), ...bytes];
}

/** RecordLinkVerdictsRequest { repeated LinkVerdict verdicts = 1 }; LinkVerdict { url = 1; verdict = 2; reasons = 3 }. */
export function encodeRecordRequest(verdicts: readonly LinkVerdict[]): Uint8Array {
  const out: number[] = [];
  for (const v of verdicts) {
    const inner = [...lengthDelimited(1, encoder.encode(v.url)), ...varint(2 << 3), ...varint(v.verdict), ...v.reasons.flatMap((r) => lengthDelimited(3, encoder.encode(r)))];
    // No spread into push: an address as long as a hostile answer allows would overflow the call stack.
    for (const byte of lengthDelimited(1, new Uint8Array(inner))) out.push(byte);
  }
  return new Uint8Array(out);
}

/** The largest RecordLinkVerdicts request written: under the 256 KiB the API reads (its READ_MAX_BYTES). */
export const MAX_RECORD_BYTES = 200_000;
/** At most this many verdicts in one request: the API's own limit (MAX_AWAITING). */
export const MAX_RECORD_VERDICTS = 500;

/**
 * The RecordLinkVerdicts requests for these verdicts, in order: as few as hold them with each at most
 * MAX_RECORD_BYTES and MAX_RECORD_VERDICTS. A verdict larger than the cap by itself goes alone, so the
 * API's refusal of it costs no other verdict.
 */
export function recordRequests(verdicts: readonly LinkVerdict[]): Uint8Array[] {
  const requests: Uint8Array[] = [];
  let batch: Uint8Array[] = [];
  let size = 0;
  const flush = (): void => {
    if (batch.length === 0) return;
    const request = new Uint8Array(size);
    let at = 0;
    for (const part of batch) {
      request.set(part, at);
      at += part.length;
    }
    requests.push(request);
    batch = [];
    size = 0;
  };
  for (const verdict of verdicts) {
    // A repeated field's entries, one after another, are the message.
    const one = encodeRecordRequest([verdict]);
    if (size + one.length > MAX_RECORD_BYTES || batch.length === MAX_RECORD_VERDICTS) flush();
    batch.push(one);
    size += one.length;
  }
  flush();
  return requests;
}

interface Field {
  field: number;
  wire: number;
  value: number | Uint8Array;
}

/** Every field of a message, in order; unknown ones are read and left to the caller. Groups are refused. */
function fields(bytes: Uint8Array): Field[] {
  const out: Field[] = [];
  let i = 0;
  const readVarint = (): number => {
    let result = 0;
    let scale = 1;
    for (let n = 0; n < 10; n += 1) {
      if (i >= bytes.length) throw new ItemsError('the API answer is cut short');
      const byte = bytes[i] as number;
      i += 1;
      result += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) return result;
      scale *= 128;
    }
    throw new ItemsError('the API answer holds a bad number');
  };
  while (i < bytes.length) {
    const key = readVarint();
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (wire === 0) out.push({ field, wire, value: readVarint() });
    else if (wire === 2) {
      const length = readVarint();
      if (i + length > bytes.length) throw new ItemsError('the API answer is cut short');
      out.push({ field, wire, value: bytes.subarray(i, i + length) });
      i += length;
    } else if (wire === 1 || wire === 5) {
      const length = wire === 1 ? 8 : 4;
      if (i + length > bytes.length) throw new ItemsError('the API answer is cut short');
      i += length;
    } else throw new ItemsError('the API answer is not a message this checker reads');
  }
  return out;
}

const text = (value: number | Uint8Array): string => {
  try {
    return decoder.decode(value as Uint8Array);
  } catch {
    throw new ItemsError('the API answer holds text that is not UTF-8');
  }
};

/** ListLinksAwaitingVerdictResponse { repeated string urls = 1; bool more = 2 }. */
export function decodeListResponse(bytes: Uint8Array): { urls: string[]; more: boolean } {
  const reply = { urls: [] as string[], more: false };
  for (const f of fields(bytes)) {
    if (f.field === 1 && f.wire === 2) reply.urls.push(text(f.value));
    else if (f.field === 2 && f.wire === 0) reply.more = f.value !== 0;
  }
  return reply;
}

/** RecordLinkVerdictsResponse { int32 recorded = 1; repeated string not_awaiting = 2 }. */
export function decodeRecordResponse(bytes: Uint8Array): { recorded: number; notAwaiting: string[] } {
  const reply = { recorded: 0, notAwaiting: [] as string[] };
  for (const f of fields(bytes)) {
    if (f.field === 1 && f.wire === 0) reply.recorded = f.value as number;
    else if (f.field === 2 && f.wire === 2) reply.notAwaiting.push(text(f.value));
  }
  return reply;
}

// ---------------------------------------------------------------------------
// A unary gRPC call over HTTP/2, and the token.

export const SERVICE = '/nwfl.mensa.v1.LinkCheckService';
/** The largest answer read: 500 addresses of 2,048 characters, with room. */
export const MAX_ANSWER_BYTES = 2 * 1024 * 1024;
const CALL_MS = 60_000;
// RFC 6750 b64token, as the API's caller gate reads it.
const B64TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/;
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);

/** An https URL, or http to this machine only (a test's stand-in). */
export function endpoint(name: string, value: string | undefined): URL {
  let url: URL | undefined;
  try {
    url = new URL(value ?? '');
  } catch {
    url = undefined;
  }
  if (url === undefined || !(url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname)))) throw new ItemsError(`${name} must be an https URL`);
  return url;
}

const GRPC_CODES = ['OK', 'CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND', 'ALREADY_EXISTS', 'PERMISSION_DENIED', 'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'ABORTED', 'OUT_OF_RANGE', 'UNIMPLEMENTED', 'INTERNAL', 'UNAVAILABLE', 'DATA_LOSS', 'UNAUTHENTICATED'];

function refusal(status: string, message: string | undefined): ItemsError {
  let said: string;
  try {
    said = decodeURIComponent(message ?? '');
  } catch {
    said = message ?? '';
  }
  // eslint-disable-next-line no-control-regex
  said = said.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200);
  return new ItemsError(`the API refused the call: ${GRPC_CODES[Number(status)] ?? `status ${status}`}${said === '' ? '' : ` (${said})`}`);
}

/** One unary call: the message in a gRPC frame, the answer's one frame back, or the API's refusal. */
export function grpcCall(api: URL, method: string, token: string, message: Uint8Array): Promise<Uint8Array> {
  if (!B64TOKEN.test(token)) return Promise.reject(new ItemsError('the token is not a bearer token'));
  return new Promise((resolve, reject) => {
    const session = http2.connect(api.origin);
    const timers: { call?: NodeJS.Timeout } = {};
    const fail = (error: Error): void => {
      clearTimeout(timers.call);
      session.destroy();
      reject(error instanceof ItemsError ? error : new ItemsError(`the API could not be reached (${error.constructor.name})`));
    };
    session.on('error', fail);
    timers.call = setTimeout(() => fail(new ItemsError('the API did not answer in time')), CALL_MS);
    const stream = session.request({
      ':method': 'POST',
      ':path': `${api.pathname.replace(/\/$/, '')}${SERVICE}/${method}`,
      'content-type': 'application/grpc',
      te: 'trailers',
      authorization: `Bearer ${token}`,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let status: string | undefined;
    let said: string | undefined;
    const statusFrom = (headers: http2.IncomingHttpHeaders): void => {
      const value = headers['grpc-status'];
      if (value === undefined) return;
      status = String(value);
      said = headers['grpc-message'] as string | undefined;
    };
    stream.on('response', statusFrom);
    stream.on('trailers', statusFrom);
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_ANSWER_BYTES + 5) {
        stream.close();
        fail(new ItemsError('the API answer is too large'));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('error', fail);
    stream.on('end', () => {
      clearTimeout(timers.call);
      session.close();
      if (status !== '0') {
        reject(status === undefined ? new ItemsError('the API answer has no status') : refusal(status, said));
        return;
      }
      const body = Buffer.concat(chunks);
      const length = body.length >= 5 ? body.readUInt32BE(1) : -1;
      if (body.length < 5 || body[0] !== 0 || length !== body.length - 5) {
        reject(new ItemsError('the API answer is not one plain gRPC message'));
        return;
      }
      resolve(new Uint8Array(body.subarray(5)));
    });
    const frame = Buffer.alloc(5 + message.length);
    frame.writeUInt32BE(message.length, 1);
    frame.set(message, 5);
    stream.end(frame);
  });
}

export interface TokenRequest {
  tokenUrl: URL;
  clientId: string;
  username: string;
  password: string;
  scope: string;
}

/** The access token of a client-credentials grant (Authentik's username and app password form). */
export async function clientCredentials(request: TokenRequest, fetcher: typeof fetch = fetch): Promise<string> {
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: request.clientId, username: request.username, password: request.password, scope: request.scope });
  let response: Response;
  try {
    response = await fetcher(request.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, redirect: 'error', signal: AbortSignal.timeout(CALL_MS) });
  } catch {
    throw new ItemsError('the identity provider could not be reached');
  }
  if (!response.ok) throw new ItemsError(`the identity provider refused the sign-in (HTTP ${response.status})`);
  let token: unknown;
  try {
    token = ((await response.json()) as { access_token?: unknown }).access_token;
  } catch {
    throw new ItemsError('the identity provider answered with something other than JSON');
  }
  if (typeof token !== 'string' || !B64TOKEN.test(token)) throw new ItemsError('the identity provider gave no access token');
  return token;
}

// ---------------------------------------------------------------------------
// The run.

/** At most this many lists in one run: a guard against a list that never empties. */
export const MAX_ROUNDS = 20;

export interface ItemsDeps {
  api: URL;
  token: string;
  /** check.ts on these addresses. */
  check(urls: readonly string[]): Promise<Array<{ url: string; verdict: CheckVerdict; reasons: readonly string[] }>>;
}

export interface ItemsTotals {
  checked: number;
  ok: number;
  confirm: number;
  drop: number;
  recorded: number;
  notAwaiting: number;
  more: boolean;
}

/** Lists, checks and records until nothing waits (or MAX_ROUNDS lists). Counts only come back. */
export async function runItems(deps: ItemsDeps): Promise<ItemsTotals> {
  const totals: ItemsTotals = { checked: 0, ok: 0, confirm: 0, drop: 0, recorded: 0, notAwaiting: 0, more: false };
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const list = decodeListResponse(await grpcCall(deps.api, 'ListLinksAwaitingVerdict', deps.token, new Uint8Array()));
    totals.more = list.more;
    if (list.urls.length === 0) break;
    const verdicts = (await deps.check(list.urls)).map(storedVerdict);
    totals.checked += verdicts.length;
    for (const v of verdicts) totals[v.verdict === MACHINE.OK ? 'ok' : v.verdict === MACHINE.DROP ? 'drop' : 'confirm'] += 1;
    let kept = 0;
    for (const request of recordRequests(verdicts)) {
      const recorded = decodeRecordResponse(await grpcCall(deps.api, 'RecordLinkVerdicts', deps.token, request));
      kept += recorded.recorded;
      totals.notAwaiting += recorded.notAwaiting.length;
    }
    totals.recorded += kept;
    // Nothing kept: the next list would be this one again.
    if (!list.more || kept === 0) break;
  }
  return totals;
}
