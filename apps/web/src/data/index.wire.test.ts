// D1 (11-03), in the production wiring: liveFromEnv, as the server builds it
// from API_URL, reads a real gRPC API on loopback with D1's teasers on. The
// public's /news lists a members article by its title and summary with the
// members box, and never its body or its files, even from an API that sends
// the public the item in full. A public-only build still reads nothing.
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { type ConnectRouter } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ContentItemSchema, ContentKind, ContentService, FileAudience, FileRole, ItemVisibility } from '../gen/nwfl/mensa/v1/content_pb.js';
import { MEMBERS_ITEM } from '../lib/document';
import { liveFromEnv } from './index';

const MEMBERS_BODY = 'WIRING CANARY MEMBERS BODY';
const PASSAGE = 'WIRING CANARY PASSAGE';
const MEMBERS_FILE = 'f1000000-0000-4000-8000-0000000000d1';
const TEASER_PUBLIC_FILE = 'f0000000-0000-4000-8000-0000000000d2';
const ISSUE_MEMBERS_FILE = 'f1000000-0000-4000-8000-0000000000d3';
const ISSUE_PUBLIC_FILE = 'f0000000-0000-4000-8000-0000000000d3';

const para = (text: string) => ({ kind: { case: 'paragraph' as const, value: { inlines: [{ kind: { case: 'text' as const, value: { text } } }] } } });
const passage = (text: string) => ({ kind: { case: 'members' as const, value: { blocks: [para(text)] } } });
const file = (id: string, audience: FileAudience) => ({ id, filename: `${id.slice(0, 8)}.pdf`, mimeType: 'application/pdf', audience, role: FileRole.PRIMARY, sizeBytes: 5n });
const approvedAt = timestampFromDate(new Date('2026-10-20T15:00:00Z'));

/** A buggy API's answer to a call with no token: the members article in full, a members passage and members files. */
function answer(kind: ContentKind) {
  if (kind === ContentKind.DOCUMENT)
    return [
      create(ContentItemSchema, {
        id: 'd0c00000-0000-4000-8000-0000000000d3',
        kind: ContentKind.DOCUMENT,
        live: { title: 'Pensa Mensa, October-November 2026', visibility: ItemVisibility.PUBLIC, files: [file(ISSUE_MEMBERS_FILE, FileAudience.MEMBERS), file(ISSUE_PUBLIC_FILE, FileAudience.PUBLIC)] },
      }),
    ];
  if (kind === ContentKind.ARTICLE)
    return [
      create(ContentItemSchema, { id: 'a1', slug: 'open', kind: ContentKind.ARTICLE, live: { title: 'Open', visibility: ItemVisibility.PUBLIC, approvedAt, body: { blocks: [para('hello'), passage(PASSAGE)] as never } } }),
      create(ContentItemSchema, {
        id: 'a2',
        slug: 'members-picnic',
        kind: ContentKind.ARTICLE,
        live: {
          title: 'Members picnic sign-up',
          summary: 'Bring a dish to share.',
          visibility: ItemVisibility.MEMBERS,
          approvedAt,
          body: { blocks: [para(MEMBERS_BODY)] as never },
          files: [file(MEMBERS_FILE, FileAudience.MEMBERS), file(TEASER_PUBLIC_FILE, FileAudience.PUBLIC)],
        },
      }),
    ];
  return [];
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** The API on loopback, gRPC only, remembering each request's Authorization header. */
async function api(): Promise<{ url: string; authorization: (string | undefined)[] }> {
  const authorization: (string | undefined)[] = [];
  const adapter = connectNodeAdapter({ routes: (router: ConnectRouter) => router.service(ContentService, { listPublishedItems: (req) => ({ items: answer(req.kind) }) }), grpc: true, grpcWeb: false, connect: false });
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

describe("the production wiring's /news (D1: members teasers on)", () => {
  it('lists a members article to the public by title and summary with the members box, never its body, its passage or any of its files', async () => {
    const server = await api();
    const live = liveFromEnv({ API_URL: server.url }, { publicOnly: false, log: () => {} })!;
    const signIn = '/sign-in?return=%2Fnews&again=1';
    const news = await live.news(undefined, { signIn });
    expect(server.authorization).toEqual([undefined, undefined]);
    expect(news.items.map((i) => [i.slug, i.membersOnly, i.teaser])).toEqual([['open', false, undefined], ['members-picnic', true, true]]);
    expect(news.items[1]).toEqual({
      slug: 'members-picnic',
      title: 'Members picnic sign-up',
      summary: 'Bring a dish to share.',
      bodyHtml: `<p class="members-note">Members only, <a href="${signIn.replace('&', '&amp;')}">sign in</a> to read.</p>`,
      publishedOn: '2026-10-20',
      source: 'submitted',
      files: [],
      membersOnly: true,
      teaser: true,
    });
    expect(news.issues.map((i) => [i.pdf, i.membersPdf])).toEqual([[`/documents/${ISSUE_PUBLIC_FILE}.pdf`, undefined]]);
    expect(JSON.stringify(news)).not.toMatch(new RegExp(`${MEMBERS_BODY}|${PASSAGE}|${MEMBERS_FILE}|${TEASER_PUBLIC_FILE}|${ISSUE_MEMBERS_FILE}`));
  });

  it('gives every anonymous reader the same teaser page, with no sign-in link where the page offers none', async () => {
    const server = await api();
    const live = liveFromEnv({ API_URL: server.url }, { publicOnly: false, log: () => {} })!;
    const [a, b] = await Promise.all([live.news(), live.news()]);
    expect(a).toEqual(b);
    expect(a.items[1]!.bodyHtml).toBe(`<p class="members-note">${MEMBERS_ITEM}</p>`);
  });
});
