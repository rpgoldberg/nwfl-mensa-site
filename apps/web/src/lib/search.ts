// ARCHIVE-SEARCH S4: what /search shows (src/pages/search.astro), shaped from the API's answer and from
// nothing else. The site holds no index and no text of its own (test/search-contract.test.ts): the API
// searches the index of the caller's audience and sends hits whose labels and snippets that audience
// may already read. Here the answer is only checked and dressed:
//
// - The query is read as the API reads it (apps/api/src/search/query.ts), so a visitor is told in plain
//   words what to change before the API is asked at all.
// - A snippet is escaped, and only then are the API's two markers (U+E000, U+E001) turned into <mark>.
//   Any markup in the page text of an issue is shown as text.
// - Every link is built from a checked file id, page number or slug. An issue opens in the reader at
//   its page with the words in the fragment, which no server is sent; the PDF itself is linked beside it.
// - Each visitor may search 20 times a minute (the API's own bucket is one for everyone, and the site is
//   its only caller). The visitor is the address Cloudflare, the site's edge, names in CF-Connecting-IP;
//   it is held in memory for the count alone, and never written anywhere. A request without one address
//   there did not come through the edge, and every such request shares one bucket: none goes uncounted.
//
// Nothing here writes a log line: the visitor's words reach no log of the site's.
import { isIP } from 'node:net';
import { formatDate } from '../data/format';
import type { LiveData } from '../data/live';
import { ContentKind } from '../gen/nwfl/mensa/v1/content_pb.js';
import type { SearchHit } from '../gen/nwfl/mensa/v1/search_pb.js';
import { ApiUnavailable, type Reader } from './api/client';

/** The API's limits (apps/api/src/search/query.ts): the site tells the visitor before the API has to. */
export const MIN_CHARS = 2;
export const MAX_CHARS = 100;
export const MAX_WORDS = 8;
export const PAGE_SIZE = 10;
export const MAX_PAGE = 10;
/** The most UTF-16 units a query is read at: a longer one is too long, and is neither normalised nor shown again. */
export const MAX_RAW_UNITS = 400;
/** The most pages an issue can have in the index (the API's cap). */
const MAX_ISSUE_PAGE = 300;

/** `echo`: what the search box shows again. */
export type Query = { kind: 'none' | 'short' | 'long' | 'words' | 'invalid'; echo: string } | { kind: 'ok'; text: string; echo: string };

/** The `q` parameter, read as the API reads a query: NFKC, runs of white space as one space, trimmed. */
export function readQuery(raw: string | null): Query {
  if (raw === null) return { kind: 'none', echo: '' };
  if (raw.length > MAX_RAW_UNITS) return { kind: 'long', echo: '' };
  const text = raw.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (text === '') return { kind: 'none', echo: '' };
  if (/\p{Cc}/u.test(text)) return { kind: 'invalid', echo: '' };
  const chars = [...text].length;
  if (chars < MIN_CHARS) return { kind: 'short', echo: text };
  if (chars > MAX_CHARS) return { kind: 'long', echo: text };
  if (text.split(' ').length > MAX_WORDS) return { kind: 'words', echo: text };
  return { kind: 'ok', text, echo: text };
}

/** The `page` parameter: 1 to 10 as plain digits, and the first page for anything else. */
export function readPage(raw: string | null): number {
  if (raw === null || !/^[1-9]\d?$/.test(raw)) return 1;
  const page = Number(raw);
  return page <= MAX_PAGE ? page : 1;
}

const START = '';
const STOP = '';
const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

/**
 * A snippet as HTML for set:html: every character escaped, then the API's two markers alone made into
 * <mark> and </mark>, kept balanced whatever order they came in.
 */
export function snippetHtml(snippet: string): string {
  let html = '';
  let open = false;
  for (const part of snippet.split(/([])/)) {
    if (part === START) {
      if (!open) html += '<mark>';
      open = true;
    } else if (part === STOP) {
      if (open) html += '</mark>';
      open = false;
    } else html += escapeHtml(part);
  }
  return open ? `${html}</mark>` : html;
}

const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

/** The id /news gives an article, for a search result to open it by; none for a slug that is not a plain one. */
export function itemAnchor(slug: string): string | undefined {
  return SLUG.test(slug) ? `item-${slug}` : undefined;
}

/** Where each kind of item is listed, and what a result calls it. A kind no page lists has no entry. */
const PLACES: Partial<Record<ContentKind, { href: string; label: string }>> = {
  [ContentKind.ARTICLE]: { href: '/news', label: 'Newsletter article' },
  [ContentKind.DOCUMENT]: { href: '/news', label: 'Newsletter' },
  [ContentKind.ANNOUNCEMENT]: { href: '/', label: 'Announcement' },
  [ContentKind.PRESIDENT_REPORT]: { href: '/', label: 'From the President' },
  [ContentKind.TREASURER_SUMMARY]: { href: '/finances', label: 'Treasurer’s summary' },
  [ContentKind.MINUTES]: { href: '/minutes', label: 'Minutes' },
};

export type HitView =
  /** A page of an issue: the reader at that page, and the PDF file itself beside it. */
  | { kind: 'issue'; label: string; href: string; pdf: string; pdfLabel: string; snippetHtml: string }
  /** A published item: the page that lists it. `meta`: what it is, and its date. */
  | { kind: 'item'; label: string; href: string; meta: string; snippetHtml: string };

function dateOf(on: { year: number; month: number; day: number } | undefined): string | undefined {
  if (on === undefined) return undefined;
  const pad = (n: number, width: number) => String(n).padStart(width, '0');
  try {
    return formatDate(`${pad(on.year, 4)}-${pad(on.month, 2)}-${pad(on.day, 2)}`);
  } catch {
    return undefined;
  }
}

/** One hit as the page shows it; undefined for a hit no safe link can be built for. `query`: the words, for the reader to find. */
export function hitView(hit: SearchHit, query: string): HitView | undefined {
  const { hit: h } = hit;
  if (h.case === 'issuePage') {
    const { fileId, issueLabel, page, snippet } = h.value;
    if (!FILE_ID.test(fileId) || !Number.isInteger(page) || page < 1 || page > MAX_ISSUE_PAGE) return undefined;
    return {
      kind: 'issue',
      label: `${issueLabel.trim() || 'Newsletter issue'}, page ${page}`,
      // A fragment is never sent to a server: the words stay in the visitor's browser.
      href: `/read/${fileId}#page=${page}&find=${encodeURIComponent(query)}`,
      pdf: `/documents/${fileId}.pdf#page=${page}`,
      pdfLabel: `PDF file, page ${page}`,
      snippetHtml: snippetHtml(snippet),
    };
  }
  if (h.case === 'newsItem') {
    const place = PLACES[h.value.kind];
    if (place === undefined) return undefined;
    const anchor = h.value.kind === ContentKind.ARTICLE ? itemAnchor(h.value.slug) : undefined;
    const date = dateOf(h.value.publishedOn);
    return {
      kind: 'item',
      label: h.value.title.trim() || 'Untitled',
      href: anchor === undefined ? place.href : `${place.href}#${anchor}`,
      meta: date === undefined ? place.label : `${place.label}, ${date}`,
      snippetHtml: snippetHtml(h.value.snippet),
    };
  }
  return undefined;
}

/** The request header in which the site's edge (Cloudflare) names the visitor's address. */
export const VISITOR_HEADER = 'cf-connecting-ip';

/** The visitor every request is counted against that does not name one address in the edge's header. */
export const UNNAMED_VISITOR = 'unnamed';

/** The eight parts of an IPv6 address node has checked, as numbers; a dotted IPv4 ending is its last two. */
function parts(address: string): number[] {
  const [head = '', tail] = address.split('::');
  const partsOf = (text: string) =>
    (text === '' ? [] : text.split(':')).flatMap((part) => {
      if (!part.includes('.')) return [parseInt(part, 16)];
      const [a = 0, b = 0, c = 0, d = 0] = part.split('.').map(Number);
      return [a * 256 + b, c * 256 + d];
    });
  const before = partsOf(head);
  const after = tail === undefined ? [] : partsOf(tail);
  return [...before, ...Array<number>(8 - before.length - after.length).fill(0), ...after];
}

/** An IPv6 visitor: an IPv4-mapped address (::ffff:a.b.c.d) as its IPv4 address, any other by its /64. */
function ipv6Key(address: string): string {
  const p = parts(address);
  if (p.slice(0, 5).every((part) => part === 0) && p[5] === 0xffff) return [p[6]! >> 8, p[6]! & 255, p[7]! >> 8, p[7]! & 255].join('.');
  return p
    .slice(0, 4)
    .map((part) => part.toString(16))
    .join(':');
}

/**
 * Who a search is counted against: the one address in the edge's header, an IPv6 address by its /64.
 * When the header is missing or is not one address (a request that did not come through the edge), the
 * one unnamed visitor: all such searches share a bucket, so none is uncounted (fail closed).
 */
export function visitorKey(headers: Headers): string {
  const value = headers.get(VISITOR_HEADER)?.trim() ?? '';
  const version = isIP(value);
  if (version === 4) return value;
  // node takes a zone (fe80::1%eth0), which no address from the edge has.
  return version === 6 && !value.includes('%') ? ipv6Key(value) : UNNAMED_VISITOR;
}

/** 20 searches at once, and one more every three seconds: 20 a minute. */
export const VISITOR_BURST = 20;
const REFILL_MS = 3000;
const FULL = VISITOR_BURST * REFILL_MS;
/** The most visitors counted at once: past it, the ones with nothing counted against them go, then the longest idle. */
const MAX_VISITORS = 10_000;

export interface VisitorLimit {
  /** Count one search against the visitor at `now` (ms). `retryAfter`: whole seconds. */
  take(visitor: string, now: number): { ok: true } | { ok: false; retryAfter: number };
  size(): number;
}

/** A token bucket for each visitor, in this process's memory (the site runs as one replica). */
export function visitorLimit({ maxVisitors = MAX_VISITORS }: { maxVisitors?: number } = {}): VisitorLimit {
  /** Credit in milliseconds (one search costs REFILL_MS), and when it was last brought up to date. Least recently used first. */
  const buckets = new Map<string, { credit: number; at: number }>();
  const makeRoom = (now: number) => {
    for (const [key, b] of buckets) if (b.credit + Math.max(0, now - b.at) >= FULL) buckets.delete(key);
    while (buckets.size >= maxVisitors) buckets.delete(buckets.keys().next().value!);
  };
  return {
    take(visitor, now) {
      let bucket = buckets.get(visitor);
      if (bucket === undefined) {
        if (buckets.size >= maxVisitors) makeRoom(now);
        bucket = { credit: FULL, at: now };
      } else {
        // A clock that went backwards adds nothing, and is not remembered.
        bucket.credit = Math.min(FULL, bucket.credit + Math.max(0, now - bucket.at));
        bucket.at = Math.max(bucket.at, now);
        buckets.delete(visitor);
      }
      buckets.set(visitor, bucket);
      if (bucket.credit < REFILL_MS) return { ok: false, retryAfter: Math.ceil((REFILL_MS - bucket.credit) / 1000) };
      bucket.credit -= REFILL_MS;
      return { ok: true };
    },
    size: () => buckets.size,
  };
}

let shared: VisitorLimit | undefined;

/** The site's one limit, shared by every request this process serves. */
export function siteVisitorLimit(): VisitorLimit {
  shared ??= visitorLimit();
  return shared;
}

export type SearchState = 'blank' | 'off' | 'short' | 'long' | 'words' | 'invalid' | 'limited' | 'busy' | 'down' | 'none' | 'results';

export interface SearchView {
  state: SearchState;
  /** The response's status: 400 for a query to change, 429 for the visitor's limit, 503 when search cannot answer now. */
  status: 200 | 400 | 429 | 503;
  /** Seconds, for Retry-After. */
  retryAfter?: number;
  /** What the search box shows again. */
  query: string;
  /** The page's title, which a screen reader announces on load: the count and the words searched for. */
  title: string;
  /** The results' heading: the count, never the words. */
  heading?: string;
  /** The state in plain words. */
  message?: string;
  hits: HitView[];
  /** Set when a sign-in has lapsed and a search was made: only the public copies were searched (LAPSED_NOTE). */
  lapsed?: true;
  /** Set when the API refused the reader's token: the public's answer is shown, and the page says so as /news does. */
  tokenRefused?: true;
  /** The number the first hit carries in the list. */
  start?: number;
  previous?: string;
  next?: string;
}

const REFUSALS = {
  short: { title: `Search: please type at least ${MIN_CHARS} characters`, message: `Please type at least ${MIN_CHARS} letters or numbers, then search again.` },
  long: { title: 'Search: that search is too long', message: `That search is too long. Please use ${MAX_CHARS} characters or fewer.` },
  words: { title: 'Search: that search has too many words', message: `That search has too many words. Please use ${MAX_WORDS} words or fewer.` },
  invalid: { title: 'Search: we could not search for that', message: 'We could not search for that. Please use plain words.' },
} as const;

/** How long a visitor is asked to wait when the API is at its limit. */
const BUSY_RETRY_SECONDS = 10;

/**
 * What a reader whose sign-in has lapsed is told above what a search found: the search went as the
 * public's (src/data/live.ts sends no token that has run out). The page puts "Sign in again" between.
 */
export const LAPSED_NOTE = Object.freeze({ lead: 'Your sign-in has expired, so only the public copies were searched.', rest: "to search the members' copies too." });

/**
 * The heading and words for a page with no result to show. `found`: the API sent hits, none of which can
 * be opened here (a kind no page lists); `more`: a Next link follows. Never "nothing matches" above Next.
 */
function noneWords(page: number, found: boolean, more: boolean): [string, string] {
  if (found && more) return ['No results to show on this page', 'The results on this page cannot be opened from this site. There are more on the next page.'];
  if (page > 1) return ['No more results', 'There are no more results.'];
  if (found) return ['No results', 'None of the results can be opened from this site. Try fewer or different words.'];
  return ['No results', 'Nothing in the archive matches those words. Check the spelling, or try fewer or different words.'];
}

const pageHref = (query: string, page: number) => `/search?${new URLSearchParams(page === 1 ? { q: query } : { q: query, page: String(page) }).toString()}`;

export interface SearchRequest {
  /** undefined: this site reads no API (the public-only build, or no API_URL). */
  live: Pick<LiveData, 'search'> | undefined;
  params: URLSearchParams;
  /** The signed-in reader whose token goes with the search, if any (src/lib/auth/bearer.ts). The API decides the audience. */
  reader: Reader | undefined;
  /** Whether the reader's sign-in has lapsed (readerFor in src/lib/auth/bearer.ts): the search then goes as the public's. */
  lapsed: boolean;
  /** visitorKey's answer. */
  visitor: string;
  limit: VisitorLimit;
  /** Milliseconds. */
  now: number;
}

/** What /search shows for one request. A failure that is not the API being unavailable is a bug, and is thrown. */
export async function searchView({ live, params, reader, lapsed, visitor, limit, now }: SearchRequest): Promise<SearchView> {
  const query = readQuery(params.get('q'));
  if (query.kind === 'none') return { state: 'blank', status: 200, query: '', title: 'Search', hits: [] };
  const refuse = (kind: keyof typeof REFUSALS, echo: string): SearchView => ({ state: kind, status: 400, query: echo, ...REFUSALS[kind], hits: [] });
  if (query.kind !== 'ok') return refuse(query.kind, query.echo);
  const q = query.text;
  if (live === undefined) return { state: 'off', status: 200, query: q, title: 'Search', message: 'Search is not available on this site yet.', hits: [] };

  const allowed = limit.take(visitor, now);
  if (!allowed.ok) {
    return {
      state: 'limited',
      status: 429,
      retryAfter: allowed.retryAfter,
      query: q,
      title: 'Search: please wait a moment',
      message: 'You have searched many times in a short while. Please wait a moment, then try again.',
      hits: [],
    };
  }

  const page = readPage(params.get('page'));
  let read: Awaited<ReturnType<LiveData['search']>>;
  try {
    read = await live.search(q, page, reader);
  } catch (error) {
    if (!(error instanceof ApiUnavailable)) throw error;
    return {
      state: 'down',
      status: 503,
      query: q,
      title: 'Search is temporarily unavailable',
      message: 'Search is temporarily unavailable. Please try again in a few minutes. The rest of the site still works.',
      hits: [],
    };
  }
  if (read.kind === 'invalid') return refuse('invalid', q);
  if (read.kind === 'busy') {
    return { state: 'busy', status: 503, retryAfter: BUSY_RETRY_SECONDS, query: q, title: 'Search is busy', message: 'Search is busy right now. Please wait a moment, then try again.', hits: [] };
  }

  const hits = read.hits.flatMap((hit) => hitView(hit, q) ?? []);
  const next = read.hasMore && page < MAX_PAGE ? pageHref(q, page + 1) : undefined;
  const paging = {
    ...(page > 1 ? { previous: pageHref(q, page - 1) } : {}),
    ...(next === undefined ? {} : { next }),
  };
  const note = { ...(lapsed ? { lapsed: true as const } : {}), ...(read.tokenRefused ? { tokenRefused: true as const } : {}) };
  if (hits.length === 0) {
    const [heading, message] = noneWords(page, read.hits.length > 0, next !== undefined);
    return { state: 'none', status: 200, query: q, title: `Search: ${heading.toLowerCase()} for ${q}`, heading, message, ...note, hits, ...paging };
  }
  const start = (page - 1) * PAGE_SIZE + 1;
  const whole = page === 1 && !read.hasMore;
  const heading = whole ? `${hits.length} ${hits.length === 1 ? 'result' : 'results'}` : `Results ${start} to ${start + hits.length - 1}`;
  return {
    state: 'results',
    status: 200,
    query: q,
    title: `Search: ${whole ? heading : heading.toLowerCase()} for ${q}`,
    heading,
    ...note,
    ...(read.hasMore && page === MAX_PAGE ? { message: `Only the first ${PAGE_SIZE * MAX_PAGE} results are shown. Add a word to narrow the search.` } : {}),
    hits,
    start,
    ...paging,
  };
}
