// EDITOR E2: ItemArticle.astro is the article markup Home and /news write today, extracted for the
// officers' previews and not yet used by either page. Home and /news are rendered here as they are, by
// Astro's container, from an API on loopback with made-up items; each <article> they write must be
// byte for byte what ItemArticle writes for the same item, so wiring it in later changes no byte.
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { type ConnectRouter } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ItemArticle from '../../src/components/ItemArticle.astro';
import { liveData } from '../../src/data';
import { ContentItemSchema, ContentKind, ContentService, FileAudience, FileRole, ItemVisibility } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { EventService } from '../../src/gen/nwfl/mensa/v1/event_pb.js';
import { MEMBERS_RULE } from '../../src/lib/document';
import Home from '../../src/pages/index.astro';
import News from '../../src/pages/news.astro';

const para = (text: string) => ({ kind: { case: 'paragraph' as const, value: { inlines: [{ kind: { case: 'text' as const, value: { text } } }] } } });
const REDACTED = { kind: { case: 'redacted' as const, value: {} } };
const pdf = (id: string, filename: string) => ({ id, filename, mimeType: 'application/pdf', audience: FileAudience.PUBLIC, role: FileRole.PRIMARY, sizeBytes: 5n });
const APPROVED = timestampFromDate(new Date('2026-11-03T18:00:00Z'));

const item = (id: string, kind: ContentKind, title: string, summary: string, blocks: unknown[], visibility = ItemVisibility.PUBLIC, files: ReturnType<typeof pdf>[] = []) =>
  create(ContentItemSchema, { id, slug: `s-${id.slice(-4)}`, kind, live: { title, summary, visibility, body: { blocks: blocks as never }, approvedAt: APPROVED, files } });

const ITEMS: Partial<Record<ContentKind, ReturnType<typeof item>[]>> = {
  [ContentKind.PRESIDENT_REPORT]: [
    item('a0000000-0000-4000-8000-000000000001', ContentKind.PRESIDENT_REPORT, 'A note from the President & co <3', 'Lunch moves to "Wednesdays"', [para('First paragraph.'), REDACTED], ItemVisibility.PUBLIC, [
      pdf('f0000000-0000-4000-8000-0000000000e1', 'report.pdf'),
    ]),
  ],
  [ContentKind.ANNOUNCEMENT]: [
    item('a0000000-0000-4000-8000-000000000002', ContentKind.ANNOUNCEMENT, 'Picnic', 'Bring a dish', [para('At the park.')]),
    item('a0000000-0000-4000-8000-000000000003', ContentKind.ANNOUNCEMENT, 'No summary here', '', [para('Plain.')], ItemVisibility.PUBLIC, [pdf('f0000000-0000-4000-8000-0000000000e3', 'flyer.pdf')]),
  ],
  [ContentKind.ARTICLE]: [
    item('a0000000-0000-4000-8000-000000000004', ContentKind.ARTICLE, 'A public article', 'Its summary', [para('Body.'), REDACTED]),
    item('a0000000-0000-4000-8000-000000000005', ContentKind.ARTICLE, 'A members article', 'Members summary', [REDACTED], ItemVisibility.MEMBERS),
    create(ContentItemSchema, { id: 'a0000000-0000-4000-8000-000000000006', slug: 's-0006', kind: ContentKind.ARTICLE, live: { title: 'Not dated', summary: '', visibility: ItemVisibility.PUBLIC, body: { blocks: [para('x')] as never } } }),
  ],
};

let close: () => Promise<void> = async () => {};
let container: AstroContainer;

beforeAll(async () => {
  const routes = (router: ConnectRouter) => {
    router.service(ContentService, { listPublishedItems: (req) => ({ items: ITEMS[req.kind] ?? [] }) });
    router.service(EventService, { listOccurrences: () => ({ occurrences: [] }) });
  };
  const adapter = connectNodeAdapter({ routes, grpc: true, grpcWeb: false, connect: false });
  const sessions = new Set<http2.ServerHttp2Session>();
  const server = http2.createServer((req, res) => void adapter(req, res));
  server.on('session', (s) => sessions.add(s));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  close = () =>
    new Promise((resolve) => {
      server.close(() => resolve());
      for (const s of sessions) s.destroy();
    });
  // The pages' API, read once per process (src/data/index.ts): set before the first render.
  process.env['API_URL'] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  container = await AstroContainer.create();
});

afterAll(async () => {
  delete process.env['API_URL'];
  await close();
});

/** Every <article class="item"> a page wrote, in order. */
const articles = (html: string) => [...html.matchAll(/<article class="item"[\s\S]*?<\/article>/g)].map((m) => m[0]);
const render = (props: Record<string, unknown>) => container.renderToString(ItemArticle, { props });

describe('ItemArticle, against the pages that write the same markup today', () => {
  it("writes Home's President's report and announcements byte for byte", async () => {
    const page = articles(await container.renderToString(Home, { request: new Request('http://localhost/'), locals: {} }));
    const live = liveData()!;
    const report = (await live.presidentReport())!;
    const announcements = await live.announcements();
    expect(page).toHaveLength(3);
    expect(page[0]).toBe(await render({ layout: 'report', ...report, labelId: 'president-title' }));
    expect(page[1]).toBe(await render({ layout: 'announcement', ...announcements[0] }));
    expect(page[2]).toBe(await render({ layout: 'announcement', ...announcements[1] }));
    // What made the comparison worth having: escaping, the date line, the lead, the placeholder, the file.
    expect(page[0]).toContain('A note from the President &amp; co &lt;3');
    expect(page[0]).toContain(' · Tuesday, 3 November 2026');
    expect(page[0]).toContain('<p class="lead">Lunch moves to &quot;Wednesdays&quot;</p>');
    expect(page[0]).toContain('report.pdf (PDF)');
    expect(page[2]).not.toContain('<p></p>');
  });

  it("writes /news's articles byte for byte: dated or not, and a members teaser", async () => {
    const page = articles(await container.renderToString(News, { request: new Request('http://localhost/news'), locals: {} }));
    const news = await liveData()!.news(undefined, { signIn: undefined });
    expect(page).toHaveLength(3);
    for (const [i, a] of news.items.entries()) expect(page[i], a.title).toBe(await render({ layout: 'article', ...a }));
    expect(page[1]).toContain('Members only.');
    expect(page[1]).not.toContain(MEMBERS_RULE);
    expect(page[2]).not.toContain('class="muted"');
  });

  it('marks a members article a member may read with the members line, above its date', async () => {
    const html = await render({ layout: 'article', title: 'T', summary: '', bodyHtml: '', files: [], publishedOn: '2026-11-03', membersOnly: true });
    expect(html).toBe('<article class="item"><h3>T</h3><p class="members-rule">Members only, please don&#39;t forward</p><p class="muted">Tuesday, 3 November 2026</p><div class="prose"></div></article>');
  });

  it('gives the report line no id unless asked', async () => {
    expect(await render({ layout: 'report', title: 'T', summary: '', bodyHtml: '', files: [] })).toContain('<p class="eyebrow">From the President</p>');
  });
});
