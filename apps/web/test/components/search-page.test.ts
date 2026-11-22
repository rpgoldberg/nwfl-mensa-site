// ARCHIVE-SEARCH S4: /search and /news's anchors, rendered by Astro's container from an API on loopback
// that answers each made-up query in its own way. What a visitor is sent: the status, the headers, the
// title, the count, the list, and a snippet whose only markup is the marks.
import { Code, ConnectError, type ConnectRouter } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ContentKind, ContentService, ItemVisibility } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { SearchService } from '../../src/gen/nwfl/mensa/v1/search_pb.js';
import News from '../../src/pages/news.astro';
import Search from '../../src/pages/search.astro';

const FILE = 'f0000000-0000-4000-8000-000000000010';
const START = '';
const STOP = '';
const issue = (page: number, snippet = `the ${START}picnic${STOP} is on`) => ({ hit: { case: 'issuePage' as const, value: { fileId: FILE, issueLabel: 'Pensa Mensa, March 2019', page, snippet } } });
const article = { hit: { case: 'newsItem' as const, value: { slug: 'spring-picnic', title: 'Spring <picnic> & more', snippet: `a ${START}picnic${STOP}`, kind: ContentKind.ARTICLE, publishedOn: { year: 2026, month: 3, day: 3 } } } };
const HOSTILE = `<script>alert(1)</script><img src=x onerror=alert(2)> ${START}picnic${STOP} <mark>fake</mark>`;

const asked: { query: string; page: number; authorization: string | null }[] = [];
let close: () => Promise<void> = async () => {};
let container: AstroContainer;

beforeAll(async () => {
  const routes = (router: ConnectRouter) => {
    router.service(SearchService, {
      search: (req, ctx) => {
        asked.push({ query: req.query, page: req.page, authorization: ctx.requestHeader.get('authorization') });
        if (req.query === 'busy day') throw new ConnectError('at the limit', Code.ResourceExhausted);
        if (req.query === 'down day') throw new ConnectError('down', Code.Unavailable);
        if (req.query === 'zebra') return { hits: [], hasMore: false };
        if (req.query === 'hostile') return { hits: [issue(2, HOSTILE)], hasMore: false };
        if (req.query === 'many') return { hits: Array.from({ length: 10 }, (_, i) => issue(i + 1)), hasMore: true };
        return { hits: [issue(4), article], hasMore: false };
      },
    });
    router.service(ContentService, {
      listPublishedItems: (req) => ({
        items:
          req.kind === ContentKind.ARTICLE
            ? [
                { id: 'a0000000-0000-4000-8000-000000000004', slug: 'spring-picnic', kind: ContentKind.ARTICLE, live: { title: 'Spring picnic', visibility: ItemVisibility.PUBLIC } },
                { id: 'a0000000-0000-4000-8000-000000000005', slug: 'a0000000-0000-4000-8000-000000000005', kind: ContentKind.ARTICLE, live: { title: 'Marked', visibility: ItemVisibility.PUBLIC } },
              ]
            : [],
      }),
    });
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

const get = (query: string, headers: Record<string, string> = {}) => container.renderToResponse(Search, { request: new Request(`http://localhost/search${query}`, { headers }), locals: {} });
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const results = (html: string) => /<div[^>]*data-search-results[^>]*>([\s\S]*?)<\/div>\s*<nav|<div[^>]*data-search-results[^>]*>([\s\S]*?)<\/div>\s*<\/section>/.exec(html)?.slice(1).find((m) => m !== undefined) ?? '';

describe('/search', () => {
  it('with no query, is the form alone: a GET to /search, never stored, never indexed', async () => {
    const res = await get('');
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain('<title>Search | Northwest Florida Mensa</title>');
    expect(html).toMatch(/<form class="search-form" role="search" method="get" action="\/search">/);
    expect(html).toMatch(/<label for="q">Search the newsletter archive<\/label>/);
    expect(html).not.toContain('data-search-results');
    expect(asked).toEqual([]);
  });

  it('shows the results: the count in the title and a heading, then an ordered list of plainly labelled links', async () => {
    const res = await get('?q=spring+picnic');
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private');
    expect(asked.at(-1)).toEqual({ query: 'spring picnic', page: 1, authorization: null });
    expect(html).toContain('<title>Search: 2 results for spring picnic | Northwest Florida Mensa</title>');
    expect(html).toMatch(/<h2 id="results-title"[^>]*>2 results<\/h2>/);
    expect(html).toMatch(/<section[^>]*aria-labelledby="results-title"/);
    const list = results(html);
    expect(list).toMatch(/^\s*<ol class="hits">/);
    expect(list.match(/<li/g)).toHaveLength(2);
    expect(list).toContain(`<a class="hit__link" href="/read/${FILE}#page=4&amp;find=spring%20picnic">Pensa Mensa, March 2019, page 4</a>`);
    expect(list).toContain(`<a href="/documents/${FILE}.pdf#page=4">PDF file, page 4<span class="visually-hidden"> of Pensa Mensa, March 2019</span></a>`);
    expect(list).toContain('<a class="hit__link" href="/news#item-spring-picnic">Spring &lt;picnic&gt; &amp; more</a>');
    expect(list).toContain('Newsletter article, Tuesday, 3 March 2026');
    expect(list).toContain('the <mark>picnic</mark> is on');
    // The box keeps the words; the results region never repeats them (the leak suite reads that region).
    expect(html).toMatch(/<input id="q" name="q" type="search" value="spring picnic"/);
    expect(text(list)).not.toContain('spring picnic');
  });

  it('shows any markup in a snippet as text: only the marks are live', async () => {
    const html = await (await get('?q=hostile')).text();
    const list = results(html);
    expect(list).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(2)&gt; <mark>picnic</mark> &lt;mark&gt;fake&lt;/mark&gt;');
    expect(list).not.toMatch(/<script|<img/);
    expect(list.match(/<mark>/g)).toHaveLength(1);
  });

  it('echoes a hostile query as text everywhere it appears', async () => {
    const html = await (await get(`?q=${encodeURIComponent('"><script>x</script>')}`)).text();
    // Once, inside the box's quoted value, where it is text; in the title it is escaped as text is.
    expect(html.split('<script>x</script>')).toHaveLength(2);
    expect(html).toContain('<input id="q" name="q" type="search" value="&quot;><script>x</script>"');
    expect(html).toContain('<title>Search: 2 results for &quot;&gt;&lt;script&gt;x&lt;/script&gt; | Northwest Florida Mensa</title>');
  });

  it('links Previous and Next as plain links when there is more', async () => {
    const first = await (await get('?q=many')).text();
    expect(first).toContain('<title>Search: results 1 to 10 for many | Northwest Florida Mensa</title>');
    expect(first).toMatch(/<nav class="pager" aria-label="More results">/);
    expect(first).toMatch(/<a class="button" href="\/search\?q=many&amp;page=2" rel="next">Next results<\/a>/);
    expect(first).not.toMatch(/rel="prev"/);
    const second = await (await get('?q=many&page=2')).text();
    expect(asked.at(-1)).toMatchObject({ query: 'many', page: 2 });
    expect(second).toMatch(/<h2 id="results-title"[^>]*>Results 11 to 20<\/h2>/);
    expect(second).toMatch(/<a class="button" href="\/search\?q=many" rel="prev">Previous results<\/a>/);
    expect(second).toMatch(/<ol class="hits" start="11">/);
  });

  it('says nothing matched, in plain words', async () => {
    const res = await get('?q=zebra');
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('<title>Search: no results for zebra | Northwest Florida Mensa</title>');
    expect(html).toMatch(/<h2 id="results-title"[^>]*>No results<\/h2>/);
    expect(text(results(html))).toContain('Nothing in the archive matches those words. Check the spelling, or try fewer or different words.');
    expect(html).not.toContain('<ol class="hits"');
  });

  it('says a query is too short, 400, and asks the API nothing', async () => {
    const before = asked.length;
    const res = await get('?q=a');
    const html = await res.text();
    expect(res.status).toBe(400);
    expect(res.headers.get('cache-control')).toBe('private');
    expect(html).toContain('<title>Search: please type at least 2 characters | Northwest Florida Mensa</title>');
    expect(html).toMatch(/<p class="notice" id="search-note">Please type at least 2 letters or numbers, then search again\.<\/p>/);
    expect(html).toMatch(/<input id="q"[^>]*aria-describedby="search-note"/);
    expect(asked).toHaveLength(before);
  });

  it('says search is busy, 503 with Retry-After, when the API is at its limit', async () => {
    const res = await get('?q=busy+day');
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('10');
    expect(res.headers.get('cache-control')).toBe('private');
    expect(text(await res.text())).toContain('Search is busy right now. Please wait a moment, then try again.');
  });

  it('says search is temporarily unavailable, 503, when the API does not answer it, and keeps the form', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await get('?q=down+day');
      const html = await res.text();
      expect(res.status).toBe(503);
      expect(res.headers.get('cache-control')).toBe('private');
      expect(text(html)).toContain('Search is temporarily unavailable. Please try again in a few minutes. The rest of the site still works.');
      expect(html).toMatch(/<input id="q" name="q" type="search" value="down day"/);
      // The one line the failure logs names the call and the code: never the words searched for.
      expect(error.mock.calls.map((c) => String(c[0])).join('\n')).not.toMatch(/down day|down\+day/);
    } finally {
      error.mockRestore();
    }
  });

  it("holds one visitor to 20 searches a minute at the site, by the edge's address header: 429 with Retry-After, and others go on", async () => {
    const visitor = { 'cf-connecting-ip': '203.0.113.77' };
    for (let i = 0; i < 20; i++) expect((await get('?q=picnic', visitor)).status, String(i)).toBe(200);
    const before = asked.length;
    const res = await get('?q=picnic', visitor);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(Number(res.headers.get('retry-after'))).toBeLessThanOrEqual(3);
    expect(res.headers.get('cache-control')).toBe('private');
    expect(text(await res.text())).toContain('You have searched many times in a short while. Please wait a moment, then try again.');
    expect(asked).toHaveLength(before);
    expect((await get('?q=picnic', { 'cf-connecting-ip': '203.0.113.78' })).status).toBe(200);
    expect((await get('?q=picnic')).status).toBe(200);
  });

  it('keeps the breadcrumb and the page heading plain: the query is in the title and the box only', async () => {
    const html = await (await get('?q=zebra')).text();
    expect(html).toMatch(/<h1>Search<\/h1>/);
    const outside = text(html.replace(/<title>[\s\S]*?<\/title>/, '').replace(/<input[^>]*>/g, ''));
    expect(outside).not.toContain('zebra');
  });

  it('writes nothing to the log for a search that is answered', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await (await get('?q=quokka')).text();
      expect([...log.mock.calls, ...error.mock.calls]).toEqual([]);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});

describe('/news', () => {
  it('gives each article the id a search result opens it by: item-<slug>, with the slug as the API gave it', async () => {
    const html = await container.renderToString(News, { request: new Request('http://localhost/news'), locals: {} });
    expect([...html.matchAll(/<article class="item" id="([^"]*)"/g)].map((m) => m[1])).toEqual(['item-spring-picnic', 'item-a0000000-0000-4000-8000-000000000005']);
  });
});
