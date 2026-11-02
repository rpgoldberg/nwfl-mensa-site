// A14 (S5a-1), over the gRPC wire: /news read through the real client against
// an API that answers a call with no token as a buggy API might, with the
// members tree, a members file and a members item in full. Whatever the site
// sends, a call that went without a token is shaped as the public's.
import { create } from '@bufbuild/protobuf';
import { type ConnectRouter } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ContentItemSchema, ContentKind, ContentService, FileAudience, FileRole, ItemVisibility } from '../gen/nwfl/mensa/v1/content_pb.js';
import { grpcReads } from '../lib/api/client';
import { liveData } from './live';

const PASSAGE = 'WIRE CANARY PASSAGE';
const MEMBERS_BODY = 'WIRE CANARY MEMBERS BODY';
const MEMBERS_FILE = 'f1000000-0000-4000-8000-0000000000c1';
const PUBLIC_FILE = 'f0000000-0000-4000-8000-0000000000c1';

const para = (text: string) => ({ kind: { case: 'paragraph' as const, value: { inlines: [{ kind: { case: 'text' as const, value: { text } } }] } } });
const passage = (text: string) => ({ kind: { case: 'members' as const, value: { blocks: [para(text)] } } });
const file = (id: string, audience: FileAudience) => ({ id, filename: 'x.pdf', mimeType: 'application/pdf', audience, role: FileRole.PRIMARY, sizeBytes: 5n });

/** A buggy API's answer to a call with no token. */
function buggyAnswer(kind: ContentKind) {
  if (kind === ContentKind.DOCUMENT)
    return [
      create(ContentItemSchema, {
        id: 'd0c00000-0000-4000-8000-0000000000c1',
        kind: ContentKind.DOCUMENT,
        live: { title: 'Pensa Mensa, October-November 2026', visibility: ItemVisibility.PUBLIC, files: [file(MEMBERS_FILE, FileAudience.MEMBERS), file(PUBLIC_FILE, FileAudience.PUBLIC)] },
      }),
    ];
  if (kind === ContentKind.ARTICLE)
    return [
      create(ContentItemSchema, { id: 'a1', slug: 'open', kind: ContentKind.ARTICLE, live: { title: 'Open', visibility: ItemVisibility.PUBLIC, body: { blocks: [para('hello'), passage(PASSAGE)] as never } } }),
      create(ContentItemSchema, { id: 'a2', slug: 'members', kind: ContentKind.ARTICLE, live: { title: 'Members thing', visibility: ItemVisibility.MEMBERS, body: { blocks: [para(MEMBERS_BODY)] as never } } }),
    ];
  return [];
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** The buggy API on loopback, speaking gRPC only, remembering each request's Authorization header. */
async function buggyApi(): Promise<{ url: string; authorization: (string | undefined)[] }> {
  const authorization: (string | undefined)[] = [];
  const adapter = connectNodeAdapter({ routes: (router: ConnectRouter) => router.service(ContentService, { listPublishedItems: (req) => ({ items: buggyAnswer(req.kind) }) }), grpc: true, grpcWeb: false, connect: false });
  const sessions = new Set<http2.ServerHttp2Session>();
  const server = http2.createServer((req, res) => {
    authorization.push(req.headers['authorization']);
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
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, authorization };
}

describe('/news over the wire, from an API that sends too much to a call with no token', () => {
  it('the public read shows none of it', async () => {
    const api = await buggyApi();
    const news = await liveData(grpcReads({ baseUrl: api.url, timeoutMs: 3000 }, () => {})).news();
    expect(api.authorization).toEqual([undefined, undefined]);
    expect(news.signedIn).toBe(false);
    expect(JSON.stringify(news)).not.toMatch(new RegExp(`${PASSAGE}|${MEMBERS_BODY}|${MEMBERS_FILE}`));
  });

  it('a reader whose bearer is not one b64token goes without a token, and is shown none of it either: never read as signed in', async () => {
    const api = await buggyApi();
    const news = await liveData(grpcReads({ baseUrl: api.url, timeoutMs: 3000 }, () => {})).news({ bearer: 'not a b64token' });
    expect(api.authorization).toEqual([undefined, undefined]);
    expect(news.signedIn).toBe(false);
    expect(JSON.stringify(news)).not.toMatch(new RegExp(`${PASSAGE}|${MEMBERS_BODY}|${MEMBERS_FILE}`));
  });
});
