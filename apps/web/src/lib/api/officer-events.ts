// EDITOR E6: the officers' event screens' reads from nwfl-mensa-api (spec S10, S11). The calendar, one
// event, the series and the venues are read with the signed-in officer's own token, "Authorization:
// Bearer", never a cookie, so the API answers as it answers that officer: a members event whole, every
// venue (the public reads, src/lib/api/client.ts, never carry a token). The roster is read as the
// public. The writes are E2's (src/lib/api/editor.ts saveOccurrence). The same wire as editor.ts: gRPC
// over HTTP/2 only, the API's address and timeout from API_URL and API_TIMEOUT_MS.
//
// A refusal becomes the one thing a page can act on:
//   UNAUTHENTICATED (or a bearer that is not one b64token)  SignInAgain
//   PERMISSION_DENIED                                       NotAllowed
//   NOT_FOUND (or an id that is not an event id, never sent) ApiNotFound
//   anything else                                           ApiUnavailable
// Each is logged by call and code only: never the API's message or the token.
import { Code, ConnectError, createClient } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import { PUBLIC_ONLY } from 'astro:env/server';
import { ContentService } from '../../gen/nwfl/mensa/v1/content_pb.js';
import { type EventOccurrence, type EventSeries, EventService, type Venue } from '../../gen/nwfl/mensa/v1/event_pb.js';
import type { RosterOffice } from '../editor/events';
import { type ApiConfig, ApiNotFound, ApiUnavailable, READ_MAX_BYTES, type Reader, apiSetup, sendable } from './client';
import { NotAllowed, SignInAgain } from './editor';

export interface OfficerEventsApi {
  /** Every event from `from` to `to` (YYYY-MM-DD, Central), cancelled ones too, as this officer may see them. */
  occurrences(as: Reader, from: string, to: string): Promise<EventOccurrence[]>;
  /** One event, by its id or <series>:<date>; ApiNotFound when there is none. */
  occurrence(as: Reader, id: string): Promise<EventOccurrence>;
  /** The active series: each one's host office and title. */
  series(as: Reader): Promise<EventSeries[]>;
  /** The active venues, as this officer may see them. */
  venues(as: Reader): Promise<Venue[]>;
  /** The roster's active offices, in its order, read as the public. */
  offices(): Promise<RosterOffice[]>;
}

const codeName = (code: Code) => Code[code].replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
const protoDate = (iso: string) => ({ year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)), day: Number(iso.slice(8, 10)) });

/** An event's id: a stored one's own, or a series date's <series>:<YYYY-MM-DD>. */
const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?::\d{4}-\d{2}-\d{2})?$/;

export function grpcOfficerEvents(config: ApiConfig, log: (line: string) => void): OfficerEventsApi {
  const transport = createGrpcTransport({ baseUrl: config.baseUrl, defaultTimeoutMs: config.timeoutMs, readMaxBytes: READ_MAX_BYTES });
  const events = createClient(EventService, transport);
  const content = createClient(ContentService, transport);

  const failed = (rpc: string, error: unknown): Error => {
    const code = ConnectError.from(error).code;
    const answered = code === Code.Unauthenticated || code === Code.PermissionDenied || code === Code.NotFound;
    log(JSON.stringify(answered ? { level: 'warn', msg: 'api refused the call', rpc, code: codeName(code) } : { level: 'error', msg: 'api call failed', rpc, code: codeName(code) }));
    if (code === Code.Unauthenticated) return new SignInAgain(rpc);
    if (code === Code.PermissionDenied) return new NotAllowed(rpc);
    if (code === Code.NotFound) return new ApiNotFound(rpc);
    return new ApiUnavailable(rpc);
  };

  const call = async <T>(rpc: string, as: Reader, run: (options: { headers: { authorization: string } }) => Promise<T>): Promise<T> => {
    const reader = sendable(as);
    if (reader === undefined) throw new SignInAgain(rpc);
    try {
      return await run({ headers: { authorization: `Bearer ${reader.bearer}` } });
    } catch (error) {
      throw failed(rpc, error);
    }
  };

  return {
    occurrences: (as, from, to) =>
      call('ListOccurrences', as, async (o) => (await events.listOccurrences({ from: protoDate(from), to: protoDate(to), includeCancelled: true }, o)).occurrences),
    occurrence: async (as, id) => {
      // An id in a page's path is anyone's to type: one that is no event id is no event, never sent.
      if (!EVENT_ID.test(id)) throw new ApiNotFound('GetOccurrence');
      return call('GetOccurrence', as, async (o) => {
        const found = (await events.getOccurrence({ id }, o)).occurrence;
        if (found === undefined) throw new ConnectError('no occurrence in the answer', Code.DataLoss);
        return found;
      });
    },
    series: (as) => call('ListSeries', as, async (o) => (await events.listSeries({ includeInactive: false }, o)).series),
    venues: (as) => call('ListVenues', as, async (o) => (await events.listVenues({ includeInactive: false }, o)).venues),
    offices: async () => {
      try {
        return (await content.getRoster({})).offices.filter((o) => o.active).map((o) => ({ id: o.id, slug: o.slug, title: o.title }));
      } catch (error) {
        throw failed('GetRoster', error);
      }
    },
  };
}

/** Every read fails: the API is switched on but set up wrongly. */
export function unavailableOfficerEvents(): OfficerEventsApi {
  const fail = (rpc: string) => () => Promise.reject(new ApiUnavailable(rpc));
  return { occurrences: fail('ListOccurrences'), occurrence: fail('GetOccurrence'), series: fail('ListSeries'), venues: fail('ListVenues'), offices: fail('GetRoster') };
}

/** The client for this environment: none without API_URL, and none in a public-only build (no sign-in at all). */
export function officerEventsFromEnv(env: Record<string, string | undefined>, { publicOnly, log }: { publicOnly: boolean; log: (line: string) => void }): OfficerEventsApi | undefined {
  if (publicOnly) return undefined;
  const setup = apiSetup(env);
  if (!setup.enabled) return undefined;
  if ('error' in setup) {
    log(JSON.stringify({ level: 'error', msg: setup.error }));
    return unavailableOfficerEvents();
  }
  return grpcOfficerEvents(setup.config, log);
}

let client: { api: OfficerEventsApi | undefined } | undefined;

/** One per process, as editorApi() is. */
export function officerEventsApi(): OfficerEventsApi | undefined {
  client ??= { api: officerEventsFromEnv(process.env, { publicOnly: PUBLIC_ONLY, log: (line) => console.error(line) }) };
  return client.api;
}
