import { create } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import { ContentKind } from '../gen/nwfl/mensa/v1/content_pb.js';
import { type SearchHit, SearchHitSchema } from '../gen/nwfl/mensa/v1/search_pb.js';
import { ApiUnavailable, type Reader, type SearchRead } from './api/client';
import { VISITOR_BURST, VISITOR_HEADER, hitView, readPage, readQuery, searchView, snippetHtml, visitorKey, visitorLimit } from './search';

const FILE = 'f0000000-0000-4000-8000-000000000010';
const START = '';
const STOP = '';

const issue = (over: Partial<{ fileId: string; issueLabel: string; page: number; snippet: string }> = {}): SearchHit =>
  create(SearchHitSchema, { hit: { case: 'issuePage', value: { fileId: FILE, issueLabel: 'Pensa Mensa, March 2019', page: 4, snippet: `the ${START}picnic${STOP} is on`, ...over } } });
const news = (over: Partial<{ slug: string; title: string; snippet: string; kind: ContentKind; publishedOn: { year: number; month: number; day: number } }> = {}): SearchHit =>
  create(SearchHitSchema, {
    hit: { case: 'newsItem', value: { slug: 'spring-picnic', title: 'Spring picnic', snippet: `a ${START}picnic${STOP}`, kind: ContentKind.ARTICLE, publishedOn: { year: 2026, month: 3, day: 3 }, ...over } },
  });

describe('readQuery', () => {
  it('is none for no query, an empty one, or white space', () => {
    for (const raw of [null, '', '   ', '\t\n']) expect(readQuery(raw)).toEqual({ kind: 'none', echo: '' });
  });

  it('trims, folds white space and normalises (NFKC), as the API does', () => {
    expect(readQuery('  spring   picnic ')).toEqual({ kind: 'ok', text: 'spring picnic', echo: 'spring picnic' });
    // U+FF50: a full-width p.
    expect(readQuery('ｐicnic')).toEqual({ kind: 'ok', text: 'picnic', echo: 'picnic' });
  });

  it('says too short under two characters, counted as characters, not UTF-16 units', () => {
    expect(readQuery('a')).toEqual({ kind: 'short', echo: 'a' });
    expect(readQuery('\u{1F600}')).toEqual({ kind: 'short', echo: '\u{1F600}' });
    expect(readQuery('ab').kind).toBe('ok');
  });

  it('says too long over 100 characters, and never normalises or echoes a query over 400 units', () => {
    expect(readQuery('a'.repeat(100)).kind).toBe('ok');
    expect(readQuery('a'.repeat(101))).toEqual({ kind: 'long', echo: 'a'.repeat(101) });
    expect(readQuery('a'.repeat(401))).toEqual({ kind: 'long', echo: '' });
  });

  it('says too many words over eight', () => {
    expect(readQuery('a b c d e f g hh').kind).toBe('ok');
    expect(readQuery('a b c d e f g h i')).toEqual({ kind: 'words', echo: 'a b c d e f g h i' });
  });

  it('refuses control characters, and never echoes them', () => {
    expect(readQuery('pic\u0000nic')).toEqual({ kind: 'invalid', echo: '' });
    expect(readQuery('pic\u009Fnic')).toEqual({ kind: 'invalid', echo: '' });
  });
});

describe('readPage', () => {
  it('reads 1 to 10, and anything else as the first page', () => {
    expect(readPage(null)).toBe(1);
    expect(readPage('1')).toBe(1);
    expect(readPage('10')).toBe(10);
    for (const raw of ['0', '11', '-1', '2.5', '2e0', ' 2', 'two', '', '02', '99999999999999999999']) expect(readPage(raw), raw).toBe(1);
  });
});

describe('snippetHtml', () => {
  it('turns only the two private-use markers into <mark>', () => {
    expect(snippetHtml(`the ${START}picnic${STOP} is on`)).toBe('the <mark>picnic</mark> is on');
  });

  it('shows any other markup in a snippet as text: escaped first, so nothing in page text is ever live', () => {
    const hostile = `<script>alert(1)</script> <mark>x</mark> <img src=x onerror="a()"> & 'q' ${START}<b>hit</b>${STOP} </mark>`;
    const html = snippetHtml(hostile);
    expect(html).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt; &lt;mark&gt;x&lt;/mark&gt; &lt;img src=x onerror=&quot;a()&quot;&gt; &amp; &#39;q&#39; <mark>&lt;b&gt;hit&lt;/b&gt;</mark> &lt;/mark&gt;',
    );
    // The only tags in the result are the marks the markers made.
    expect(html.match(/<[^>]*>/g)).toEqual(['<mark>', '</mark>']);
  });

  it('keeps the marks balanced whatever the markers do: a stray stop, a start inside a start, a start never closed', () => {
    expect(snippetHtml(`a${STOP}b`)).toBe('ab');
    expect(snippetHtml(`${START}a${START}b${STOP}c${STOP}`)).toBe('<mark>ab</mark>c');
    expect(snippetHtml(`a ${START}b`)).toBe('a <mark>b</mark>');
    expect(snippetHtml('')).toBe('');
  });
});

describe('hitView', () => {
  it('opens an issue page in the reader at the page, with the words to find in the fragment, and the PDF beside it', () => {
    expect(hitView(issue(), 'spring picnic')).toEqual({
      kind: 'issue',
      label: 'Pensa Mensa, March 2019, page 4',
      href: `/read/${FILE}#page=4&find=spring%20picnic`,
      pdf: `/documents/${FILE}.pdf#page=4`,
      pdfLabel: 'PDF file, page 4',
      snippetHtml: 'the <mark>picnic</mark> is on',
    });
  });

  it('encodes the words, so a query can never add a parameter or leave the fragment', () => {
    const view = hitView(issue(), 'a&page=9#x "q" <b>');
    expect(view?.href).toBe(`/read/${FILE}#page=4&find=a%26page%3D9%23x%20%22q%22%20%3Cb%3E`);
  });

  it('labels an issue with no title plainly', () => {
    expect(hitView(issue({ issueLabel: '  ' }), 'picnic')?.label).toBe('Newsletter issue, page 4');
  });

  it('drops an issue hit whose file id is not a file id, or whose page is not a page: no link is built from it', () => {
    for (const fileId of ['', '../../sign-out', 'F0000000-0000-4000-8000-000000000010', `${FILE}/x`, 'javascript:alert(1)']) expect(hitView(issue({ fileId }), 'picnic'), fileId).toBeUndefined();
    for (const page of [0, -1, 301]) expect(hitView(issue({ page }), 'picnic'), String(page)).toBeUndefined();
  });

  it('opens an article at its place on /news, by the slug the API gave', () => {
    expect(hitView(news(), 'picnic')).toEqual({
      kind: 'item',
      label: 'Spring picnic',
      href: '/news#item-spring-picnic',
      meta: 'Newsletter article, Tuesday, 3 March 2026',
      snippetHtml: 'a <mark>picnic</mark>',
    });
    // Where a mark changes the reading, the API gives the item's id as the slug.
    expect(hitView(news({ slug: 'a0000000-0000-4000-8000-000000000004' }), 'picnic')?.href).toBe('/news#item-a0000000-0000-4000-8000-000000000004');
  });

  it('sends an article whose slug is not a plain slug to /news itself', () => {
    for (const slug of ['', 'a b', 'x"onmouseover="y', '../x', 'a#b']) expect(hitView(news({ slug }), 'picnic')?.href, slug).toBe('/news');
  });

  it('sends every other kind to the page that lists it, and says what it is', () => {
    const at = (kind: ContentKind) => {
      const view = hitView(news({ kind }), 'picnic');
      return view?.kind === 'item' ? [view.href, view.meta] : undefined;
    };
    expect(at(ContentKind.DOCUMENT)).toEqual(['/news', 'Newsletter, Tuesday, 3 March 2026']);
    expect(at(ContentKind.ANNOUNCEMENT)).toEqual(['/', 'Announcement, Tuesday, 3 March 2026']);
    expect(at(ContentKind.PRESIDENT_REPORT)).toEqual(['/', 'From the President, Tuesday, 3 March 2026']);
    expect(at(ContentKind.TREASURER_SUMMARY)).toEqual(['/finances', 'Treasurer’s summary, Tuesday, 3 March 2026']);
    expect(at(ContentKind.MINUTES)).toEqual(['/minutes', 'Minutes, Tuesday, 3 March 2026']);
  });

  it('drops a hit of a kind no page lists, and a hit that is neither an issue page nor an item', () => {
    expect(hitView(news({ kind: ContentKind.PAGE }), 'picnic')).toBeUndefined();
    expect(hitView(news({ kind: ContentKind.UNSPECIFIED }), 'picnic')).toBeUndefined();
    expect(hitView(news({ kind: 99 as ContentKind }), 'picnic')).toBeUndefined();
    expect(hitView(create(SearchHitSchema, {}), 'picnic')).toBeUndefined();
  });

  it('leaves out a date the API did not give, or one that is no date, and labels an untitled item plainly', () => {
    const undated = create(SearchHitSchema, { hit: { case: 'newsItem', value: { slug: 's', title: '', snippet: '', kind: ContentKind.ARTICLE } } });
    expect(hitView(undated, 'picnic')).toMatchObject({ label: 'Untitled', meta: 'Newsletter article' });
    expect(hitView(news({ publishedOn: { year: 2026, month: 2, day: 31 } }), 'picnic')).toMatchObject({ meta: 'Newsletter article' });
  });
});

describe('visitorKey', () => {
  const key = (value?: string) => visitorKey(new Headers(value === undefined ? {} : { [VISITOR_HEADER]: value }));

  it("is the address the edge names (Cloudflare's CF-Connecting-IP), and nothing without it", () => {
    expect(VISITOR_HEADER).toBe('cf-connecting-ip');
    expect(key('203.0.113.9')).toBe('203.0.113.9');
    expect(key(' 203.0.113.9 ')).toBe('203.0.113.9');
    expect(key()).toBeUndefined();
  });

  it('is nothing for a value that is not one address', () => {
    for (const value of ['', 'unknown', '203.0.113.9, 198.51.100.1', '999.1.1.1', '<script>']) expect(key(value), value).toBeUndefined();
  });

  it("is an IPv6 visitor's /64, so one household's addresses share a bucket", () => {
    expect(key('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2');
    expect(key('2001:DB8:1:2::9')).toBe('2001:db8:1:2');
    expect(key('2001:db8::1')).toBe('2001:db8:0:0');
    expect(key('::1')).toBe('0:0:0:0');
    expect(key('2001:db8:1:2:3:4:203.0.113.9')).toBe('2001:db8:1:2');
  });
});

describe('visitorLimit', () => {
  it('lets a visitor search 20 times at once, then once every three seconds, and says how long to wait', () => {
    const limit = visitorLimit();
    expect(VISITOR_BURST).toBe(20);
    for (let i = 0; i < 20; i++) expect(limit.take('203.0.113.9', 1000), String(i)).toEqual({ ok: true });
    expect(limit.take('203.0.113.9', 1000)).toEqual({ ok: false, retryAfter: 3 });
    expect(limit.take('203.0.113.9', 2500)).toEqual({ ok: false, retryAfter: 2 });
    expect(limit.take('203.0.113.9', 4000)).toEqual({ ok: true });
    expect(limit.take('203.0.113.9', 4000)).toEqual({ ok: false, retryAfter: 3 });
    // A minute on, the whole 20 again, and never more.
    for (let i = 0; i < 20; i++) expect(limit.take('203.0.113.9', 600_000), String(i)).toEqual({ ok: true });
    expect(limit.take('203.0.113.9', 600_000).ok).toBe(false);
  });

  it('keeps each visitor to their own bucket, and never limits a request with no visitor named', () => {
    const limit = visitorLimit();
    for (let i = 0; i < 20; i++) limit.take('203.0.113.9', 0);
    expect(limit.take('203.0.113.9', 0).ok).toBe(false);
    expect(limit.take('198.51.100.1', 0)).toEqual({ ok: true });
    for (let i = 0; i < 50; i++) expect(limit.take(undefined, 0)).toEqual({ ok: true });
  });

  it('is not fooled by a clock that goes backwards', () => {
    const limit = visitorLimit();
    for (let i = 0; i < 20; i++) limit.take('203.0.113.9', 10_000);
    expect(limit.take('203.0.113.9', 0).ok).toBe(false);
    expect(limit.take('203.0.113.9', 13_000)).toEqual({ ok: true });
  });

  it('holds a bounded number of visitors: the ones whose bucket is full again go first, then the longest idle', () => {
    const limit = visitorLimit({ maxVisitors: 3 });
    limit.take('a', 0);
    limit.take('a', 0);
    limit.take('b', 0);
    limit.take('c', 2000);
    expect(limit.size()).toBe(3);
    // At 4 s, b is full again and is dropped; a (two taken) and c (taken at 2 s) stay.
    limit.take('d', 4000);
    expect(limit.size()).toBe(3);
    // None is full at 4 s: the longest idle, a, goes.
    limit.take('e', 4000);
    expect(limit.size()).toBe(3);
    for (let i = 0; i < 19; i++) limit.take('c', 4000);
    expect(limit.take('c', 4000).ok).toBe(false);
    // a starts afresh: forgetting a visitor only ever gives them a full bucket.
    for (let i = 0; i < 20; i++) expect(limit.take('a', 4000).ok).toBe(true);
  });
});

describe('searchView', () => {
  type Live = Parameters<typeof searchView>[0]['live'];
  const params = (query: string) => new URLSearchParams(query);
  const answer = (read: SearchRead) => {
    const asked: { query: string; page: number; as: Reader | undefined }[] = [];
    const live: Live = { search: (query, page, as) => (asked.push({ query, page, as }), Promise.resolve(read)) };
    return { live, asked };
  };
  const hits = (n: number) => Array.from({ length: n }, (_, i) => issue({ page: i + 1 }));
  const view = (live: Live, query: string, over: Partial<Parameters<typeof searchView>[0]> = {}) => searchView({ live, params: params(query), reader: undefined, visitor: undefined, limit: visitorLimit(), now: 0, ...over });

  it('with no query, shows the form alone and asks nothing', async () => {
    const { live, asked } = answer({ kind: 'ok', hits: [], hasMore: false });
    expect(await view(live, '')).toEqual({ state: 'blank', status: 200, query: '', title: 'Search', hits: [] });
    expect(asked).toEqual([]);
  });

  it('says in plain words that a query is too short, too long, has too many words or is not plain words, and asks nothing', async () => {
    const { live, asked } = answer({ kind: 'ok', hits: [], hasMore: false });
    expect(await view(live, 'q=a')).toEqual({ state: 'short', status: 400, query: 'a', title: 'Search: please type at least 2 characters', message: 'Please type at least 2 letters or numbers, then search again.', hits: [] });
    expect(await view(live, `q=${'a'.repeat(101)}`)).toMatchObject({ state: 'long', status: 400, title: 'Search: that search is too long', message: 'That search is too long. Please use 100 characters or fewer.' });
    expect(await view(live, 'q=a+b+c+d+e+f+g+h+i')).toMatchObject({ state: 'words', status: 400, title: 'Search: that search has too many words', message: 'That search has too many words. Please use 8 words or fewer.' });
    expect(await view(live, 'q=a%00b')).toMatchObject({ state: 'invalid', status: 400, query: '', title: 'Search: we could not search for that', message: 'We could not search for that. Please use plain words.' });
    expect(asked).toEqual([]);
  });

  it('says search is not available where the site reads no API (the public-only build)', async () => {
    expect(await view(undefined, 'q=picnic')).toEqual({ state: 'off', status: 200, query: 'picnic', title: 'Search', message: 'Search is not available on this site yet.', hits: [] });
    expect(await view(undefined, '')).toMatchObject({ state: 'blank' });
  });

  it('asks the API for the normalised query and the page, as the reader given, and shows the hits with their count', async () => {
    const { live, asked } = answer({ kind: 'ok', hits: [issue(), news()], hasMore: false });
    const reader = { bearer: 'member.token', enrolee: true };
    const got = await view(live, 'q=+Spring++picnic+', { reader });
    expect(asked).toEqual([{ query: 'Spring picnic', page: 1, as: reader }]);
    expect(got).toMatchObject({ state: 'results', status: 200, query: 'Spring picnic', title: 'Search: 2 results for Spring picnic', heading: '2 results' });
    expect(got.hits.map((h) => h.label)).toEqual(['Pensa Mensa, March 2019, page 4', 'Spring picnic']);
    expect(got.hits[0]).toMatchObject({ href: `/read/${FILE}#page=4&find=Spring%20picnic` });
    expect(got.previous).toBeUndefined();
    expect(got.next).toBeUndefined();
  });

  it('says "1 result" for one', async () => {
    expect(await view(answer({ kind: 'ok', hits: [issue()], hasMore: false }).live, 'q=picnic')).toMatchObject({ title: 'Search: 1 result for picnic', heading: '1 result' });
  });

  it('with more to come, says which results these are and links the next page; on a later page, the previous one too', async () => {
    const first = await view(answer({ kind: 'ok', hits: hits(10), hasMore: true }).live, 'q=a%26b+c');
    expect(first).toMatchObject({ title: 'Search: results 1 to 10 for a&b c', heading: 'Results 1 to 10', next: '/search?q=a%26b+c&page=2' });
    expect(first.previous).toBeUndefined();
    const { live, asked } = answer({ kind: 'ok', hits: hits(4), hasMore: false });
    const third = await view(live, 'q=picnic&page=3');
    expect(asked[0]).toMatchObject({ page: 3 });
    expect(third).toMatchObject({ title: 'Search: results 21 to 24 for picnic', heading: 'Results 21 to 24', previous: '/search?q=picnic&page=2' });
    expect(third.next).toBeUndefined();
    expect((await view(answer({ kind: 'ok', hits: hits(10), hasMore: true }).live, 'q=picnic&page=2')).previous).toBe('/search?q=picnic');
  });

  it('never links past the tenth page, and says only the first hundred are shown', async () => {
    const last = await view(answer({ kind: 'ok', hits: hits(10), hasMore: true }).live, 'q=picnic&page=10');
    expect(last.next).toBeUndefined();
    expect(last).toMatchObject({ heading: 'Results 91 to 100', previous: '/search?q=picnic&page=9', message: 'Only the first 100 results are shown. Add a word to narrow the search.' });
  });

  it('says nothing matched, in words that do not repeat the query', async () => {
    const none = await view(answer({ kind: 'ok', hits: [], hasMore: false }).live, 'q=zebra');
    expect(none).toEqual({
      state: 'none',
      status: 200,
      query: 'zebra',
      title: 'Search: no results for zebra',
      heading: 'No results',
      message: 'Nothing in the archive matches those words. Check the spelling, or try fewer or different words.',
      hits: [],
    });
  });

  it('on a later page with nothing on it, says there are no more and links back', async () => {
    expect(await view(answer({ kind: 'ok', hits: [], hasMore: false }).live, 'q=zebra&page=4')).toMatchObject({
      state: 'none',
      title: 'Search: no more results for zebra',
      heading: 'No more results',
      message: 'There are no more results.',
      previous: '/search?q=zebra&page=3',
    });
  });

  it('counts only the hits it can show', async () => {
    const got = await view(answer({ kind: 'ok', hits: [issue(), issue({ fileId: 'nope' }), news({ kind: ContentKind.PAGE })], hasMore: false }).live, 'q=picnic');
    expect(got).toMatchObject({ state: 'results', heading: '1 result' });
    expect(await view(answer({ kind: 'ok', hits: [issue({ fileId: 'nope' })], hasMore: false }).live, 'q=picnic')).toMatchObject({ state: 'none', heading: 'No results' });
  });

  it('says busy, 503 with a time to come back, when the API is at its limit or ran out of time', async () => {
    expect(await view(answer({ kind: 'busy' }).live, 'q=picnic')).toEqual({
      state: 'busy',
      status: 503,
      retryAfter: 10,
      query: 'picnic',
      title: 'Search is busy',
      message: 'Search is busy right now. Please wait a moment, then try again.',
      hits: [],
    });
  });

  it('says so when the API will not take the query the site let through', async () => {
    expect(await view(answer({ kind: 'invalid' }).live, 'q=picnic')).toMatchObject({ state: 'invalid', status: 400, query: 'picnic', message: 'We could not search for that. Please use plain words.' });
  });

  it('says temporarily unavailable, 503, when the API does not answer; any other failure is a bug and is thrown', async () => {
    const down: Live = { search: () => Promise.reject(new ApiUnavailable('Search')) };
    expect(await view(down, 'q=picnic')).toEqual({
      state: 'down',
      status: 503,
      query: 'picnic',
      title: 'Search is temporarily unavailable',
      message: 'Search is temporarily unavailable. Please try again in a few minutes. The rest of the site still works.',
      hits: [],
    });
    const broken: Live = { search: () => Promise.reject(new TypeError('a bug')) };
    await expect(view(broken, 'q=picnic')).rejects.toBeInstanceOf(TypeError);
  });

  it("holds each visitor to the limit before the API is asked: 429, how long to wait, and the API's bucket untouched", async () => {
    const { live, asked } = answer({ kind: 'ok', hits: [issue()], hasMore: false });
    const limit = visitorLimit();
    for (let i = 0; i < 20; i++) expect((await view(live, 'q=picnic', { visitor: '203.0.113.9', limit, now: 0 })).state).toBe('results');
    expect(await view(live, 'q=picnic', { visitor: '203.0.113.9', limit, now: 0 })).toEqual({
      state: 'limited',
      status: 429,
      retryAfter: 3,
      query: 'picnic',
      title: 'Search: please wait a moment',
      message: 'You have searched many times in a short while. Please wait a moment, then try again.',
      hits: [],
    });
    expect(asked).toHaveLength(20);
    // Another visitor is not held up, and nor is a look at the empty form or a query that is refused anyway.
    expect((await view(live, 'q=picnic', { visitor: '198.51.100.1', limit, now: 0 })).state).toBe('results');
    expect((await view(live, '', { visitor: '203.0.113.9', limit, now: 0 })).state).toBe('blank');
    expect((await view(live, 'q=a', { visitor: '203.0.113.9', limit, now: 0 })).state).toBe('short');
  });
});
