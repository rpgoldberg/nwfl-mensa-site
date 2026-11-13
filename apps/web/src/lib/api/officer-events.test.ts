// EDITOR E6: the event screens' reads, over the gRPC wire against an API on loopback. The calendar,
// one event, the series and the venues are read with the signed-in officer's token (so a members event
// comes whole, as the API gives an officer), and the roster as the public. Each refusal becomes the one
// thing a page can act on: sign in again, not allowed, not found, or unavailable.
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError, type ConnectRouter } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ContentService } from '../../gen/nwfl/mensa/v1/content_pb.js';
import { EventOccurrenceSchema, EventService, EventVisibility, VenueKind } from '../../gen/nwfl/mensa/v1/event_pb.js';
import { ApiNotFound, ApiUnavailable } from './client';
import { NotAllowed, SignInAgain } from './editor';
import { grpcOfficerEvents, officerEventsApi, officerEventsFromEnv, unavailableOfficerEvents } from './officer-events';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function grpcServer(routes: (router: ConnectRouter) => void): Promise<{ url: string; headers: http2.IncomingHttpHeaders[] }> {
  const headers: http2.IncomingHttpHeaders[] = [];
  const adapter = connectNodeAdapter({ routes, grpc: true, grpcWeb: false, connect: false });
  const sessions = new Set<http2.ServerHttp2Session>();
  const server = http2.createServer((req, res) => {
    headers.push({ ...req.headers });
    void adapter(req, res);
  });
  server.on('session', (s) => sessions.add(s));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(
    () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        for (const s of sessions) s.destroy();
      }),
  );
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, headers };
}

const OFFICER = { bearer: 'officer.tok-en' };
const SERIES = '0b9c1f5e-4c1a-4d55-9a3e-2f7d8e6a1b20';
const MEMBERS_EVENT = create(EventOccurrenceSchema, { id: `${SERIES}:2026-11-22`, seriesId: SERIES, title: 'Members games night', visibility: EventVisibility.MEMBERS, localDate: { year: 2026, month: 11, day: 22 } });

describe('the event screens\' reads (grpcOfficerEvents)', () => {
  it('reads the calendar, one event, the series and the venues as the officer, and the roster as the public', async () => {
    const seen: Record<string, unknown> = {};
    const { url, headers } = await grpcServer((router) => {
      router.service(EventService, {
        listOccurrences: (req) => {
          seen['range'] = [req.from, req.to, req.includeCancelled];
          return { occurrences: [MEMBERS_EVENT] };
        },
        getOccurrence: (req) => {
          seen['id'] = req.id;
          return { occurrence: MEMBERS_EVENT };
        },
        listSeries: (req) => {
          seen['inactive'] = req.includeInactive;
          return { series: [{ id: SERIES, title: 'Members games night', hostOfficeId: 'office-1' }] };
        },
        listVenues: (req) => {
          seen['venuesInactive'] = req.includeInactive;
          return { venues: [{ id: 'v1', name: 'Sample Bistro', kind: VenueKind.BUSINESS, active: true }] };
        },
      });
      router.service(ContentService, {
        getRoster: () => ({ offices: [{ id: 'office-1', slug: 'president', title: 'President', active: true }, { id: 'office-2', slug: 'old', title: 'Old seat', active: false }] }),
      });
    });
    const api = grpcOfficerEvents({ baseUrl: url, timeoutMs: 2000 }, () => {});
    expect((await api.occurrences(OFFICER, '2026-11-12', '2027-02-10')).map((o) => o.title)).toEqual(['Members games night']);
    expect(seen['range']).toMatchObject([{ year: 2026, month: 11, day: 12 }, { year: 2027, month: 2, day: 10 }, true]);
    expect((await api.occurrence(OFFICER, MEMBERS_EVENT.id)).title).toBe('Members games night');
    expect(seen['id']).toBe(MEMBERS_EVENT.id);
    expect((await api.series(OFFICER)).map((s) => s.hostOfficeId)).toEqual(['office-1']);
    expect(seen['inactive']).toBe(false);
    expect((await api.venues(OFFICER)).map((v) => v.name)).toEqual(['Sample Bistro']);
    expect(seen['venuesInactive']).toBe(false);
    expect(await api.offices()).toEqual([{ id: 'office-1', slug: 'president', title: 'President' }]);
    // Four reads with the bearer, the roster with none; never a cookie.
    const bearers = headers.map((h) => h['authorization']);
    expect(bearers.filter((b) => b === 'Bearer officer.tok-en')).toHaveLength(4);
    expect(bearers.filter((b) => b === undefined)).toHaveLength(1);
    expect(headers.every((h) => h['cookie'] === undefined)).toBe(true);
  });

  it('never sends an id that is not an event id, nor a token that cannot be one', async () => {
    const { url, headers } = await grpcServer((router) => router.service(EventService, { getOccurrence: () => ({ occurrence: MEMBERS_EVENT }) }));
    const api = grpcOfficerEvents({ baseUrl: url, timeoutMs: 2000 }, () => {});
    for (const id of ['', 'new', `${SERIES}:2026-13-01x`, `${SERIES}_2026-11-22`, '../x']) await expect(api.occurrence(OFFICER, id), id).rejects.toBeInstanceOf(ApiNotFound);
    await expect(api.occurrence({ bearer: 'not a token' }, MEMBERS_EVENT.id)).rejects.toBeInstanceOf(SignInAgain);
    await expect(api.occurrences({ bearer: '' }, '2026-11-12', '2026-11-13')).rejects.toBeInstanceOf(SignInAgain);
    expect(headers).toHaveLength(0);
  });

  it('turns each refusal into what the page acts on, logging the call and code only', async () => {
    const codes: Record<string, Code> = {};
    const { url } = await grpcServer((router) =>
      router.service(EventService, {
        listOccurrences: () => {
          throw new ConnectError('secret words', codes['list']);
        },
        getOccurrence: () => {
          throw new ConnectError('secret words', codes['get']);
        },
        listSeries: () => {
          throw new ConnectError('secret words', Code.PermissionDenied);
        },
        listVenues: () => {
          throw new ConnectError('secret words', Code.Internal);
        },
      }),
    );
    const lines: string[] = [];
    const api = grpcOfficerEvents({ baseUrl: url, timeoutMs: 2000 }, (line) => lines.push(line));
    codes['list'] = Code.Unauthenticated;
    await expect(api.occurrences(OFFICER, '2026-11-12', '2026-11-13')).rejects.toBeInstanceOf(SignInAgain);
    codes['get'] = Code.NotFound;
    await expect(api.occurrence(OFFICER, MEMBERS_EVENT.id)).rejects.toBeInstanceOf(ApiNotFound);
    await expect(api.series(OFFICER)).rejects.toBeInstanceOf(NotAllowed);
    await expect(api.venues(OFFICER)).rejects.toBeInstanceOf(ApiUnavailable);
    codes['get'] = Code.InvalidArgument;
    await expect(api.occurrence(OFFICER, MEMBERS_EVENT.id)).rejects.toBeInstanceOf(ApiUnavailable);
    // The roster read fails as unavailable: there is no ContentService here.
    await expect(api.offices()).rejects.toBeInstanceOf(ApiUnavailable);
    expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual([
      { level: 'warn', msg: 'api refused the call', rpc: 'ListOccurrences', code: 'unauthenticated' },
      { level: 'warn', msg: 'api refused the call', rpc: 'GetOccurrence', code: 'not_found' },
      { level: 'warn', msg: 'api refused the call', rpc: 'ListSeries', code: 'permission_denied' },
      { level: 'error', msg: 'api call failed', rpc: 'ListVenues', code: 'internal' },
      { level: 'error', msg: 'api call failed', rpc: 'GetOccurrence', code: 'invalid_argument' },
      { level: 'error', msg: 'api call failed', rpc: 'GetRoster', code: 'unimplemented' },
    ]);
    expect(lines.join('\n')).not.toContain('secret');
    expect(lines.join('\n')).not.toContain('officer.tok-en');
  });

  it('has a client for every call that fails as unavailable, for an API set up wrongly', async () => {
    const api = unavailableOfficerEvents();
    for (const read of [() => api.occurrences(OFFICER, 'a', 'b'), () => api.occurrence(OFFICER, 'x'), () => api.series(OFFICER), () => api.venues(OFFICER), () => api.offices()]) {
      await expect(read()).rejects.toBeInstanceOf(ApiUnavailable);
    }
  });
});

describe('officerEventsFromEnv', () => {
  it('is none in a public-only build or with no API, unavailable when set up wrongly, and a client otherwise', async () => {
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    expect(officerEventsFromEnv({ API_URL: 'http://127.0.0.1:1' }, { publicOnly: true, log })).toBeUndefined();
    expect(officerEventsFromEnv({}, { publicOnly: false, log })).toBeUndefined();
    const wrong = officerEventsFromEnv({ API_URL: 'ftp://nowhere' }, { publicOnly: false, log });
    await expect(wrong!.offices()).rejects.toBeInstanceOf(ApiUnavailable);
    expect(lines).toHaveLength(1);
    expect(officerEventsFromEnv({ API_URL: 'http://127.0.0.1:1' }, { publicOnly: false, log })).toBeDefined();
  });

  it('keeps one client per process', () => {
    expect(officerEventsApi()).toBe(officerEventsApi());
  });
});
