// THE WEB REDACTION LEAK TEST (REDACT R2b, "every output format"). The real
// API serves a database seeded with random canaries that the public policy or
// a mark withholds (e2e/redaction/stack.mjs): marked passages in item and event
// titles, bodies, status notes, details, links and a series description;
// policy-redacted fields (an on-behalf-of name, a private venue's name and
// link, a member's home); a whole-item mark; an item the public policy hides;
// and an accented name in an item's slug, which the API must replace by the
// item's id.
//
// As the public, the test crawls every route under src/pages/ (e2e/routes.ts,
// which test/routes.test.ts holds to the pages folder), every link those pages
// lead to on this site, and every non-HTML output: the calendar files, each
// event's file, sitemap.xml, robots.txt and the head of every page. No canary
// may appear in any body or header, raw or however encoded. Every PDF it
// fetches is read as pdf.js reads it, and searched raw with every Flate stream
// inflated (REDACT R3c); the seeded PDF carries a marked canary. The redacted
// copies must render (the positive control), so a fixture that never reached
// a page cannot pass vacuously.
import { inflateSync } from 'node:zlib';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { PUBLIC_CACHE } from '../../server/policy.mjs';
import { SESSION_COOKIE } from '../../server/policy.mjs';
import { LIVE, STATIC, crawlSeeds, patternOf } from '../routes';
import { REDACTION } from './servers';

interface Fixture {
  canaries: Record<string, string>;
  ids: Record<string, string>;
  plainSlug: string;
  pdfPlain: string;
  pdfOriginal: string;
  stored: Record<string, number>;
}

interface Fetched {
  url: string;
  status: number;
  headers: Record<string, string>;
  contentType: string;
  body: string;
  /** For a PDF: its text as pdf.js reads it, and how many Flate streams were inflated into the body. */
  pdf?: { text: string; inflated: number };
}

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjs: Promise<PdfJs> | undefined;

/** Every text pdf.js reads on every page, and in the document's metadata. */
async function pdfText(bytes: Uint8Array): Promise<string> {
  const { getDocument } = await (pdfjs ??= import('pdfjs-dist/legacy/build/pdf.mjs'));
  const task = getDocument({ data: new Uint8Array(bytes), verbosity: 0, disableFontFace: true });
  try {
    const doc = await task.promise;
    const parts: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      parts.push((await page.getTextContent()).items.map((item) => ('str' in item ? item.str : '')).join(' '));
      parts.push(JSON.stringify(await page.getAnnotations()));
    }
    const meta = await doc.getMetadata();
    parts.push(JSON.stringify(meta.info), String(meta.metadata?.getRaw() ?? ''));
    return parts.join('\n');
  } finally {
    await task.destroy();
  }
}

/** Every Flate stream in the file, inflated. */
function inflatedStreams(bytes: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const text = bytes.toString('latin1');
  for (const m of text.matchAll(/stream\r?\n/g)) {
    const start = m.index + m[0].length;
    const end = text.indexOf('endstream', start);
    if (end < 0) continue;
    try {
      out.push(inflateSync(bytes.subarray(start, end)));
    } catch {
      // Not a Flate stream.
    }
  }
  return out;
}

/** A PDF as the crawl searches it: the raw bytes, every inflated stream, and the text pdf.js reads. */
async function pdfBody(bytes: Buffer): Promise<{ body: string; pdf: { text: string; inflated: number } }> {
  const streams = inflatedStreams(bytes);
  const text = await pdfText(bytes);
  return { body: [bytes.toString('latin1'), ...streams.map((s) => s.toString('latin1')), text].join('\n'), pdf: { text, inflated: streams.length } };
}

/** Case, accents, entities, percent-escapes, calendar folding and escapes, all undone. */
function fold(text: string): string {
  let out = text.replace(/\r?\n[ \t]/g, '');
  out = out.replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)));
  out = out.replace(/&(amp|quot|apos|lt|gt);/g, (_, n: string) => ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' })[n] ?? '');
  out = out.replace(/(%[0-9a-f]{2})+/gi, (seq) => {
    try {
      return decodeURIComponent(seq);
    } catch {
      return seq;
    }
  });
  out = out.replace(/\\([,;\\])/g, '$1').replace(/\\n/gi, '\n');
  return out.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

const TEXTUAL = /^(text\/|application\/(json|xml|manifest\+json|javascript|xhtml)|image\/svg)/;
const MAX_FETCHES = 900;

let fixture: Fixture;
const fetched = new Map<string, Fetched>();

/** What the API itself gave: the stored events and today's date of the series. */
function context(f: Fixture) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const month = today.slice(0, 7);
  const [y, m] = month.split('-').map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return { eventIds: [f.ids['games']!, f.ids['potluck']!, f.ids['online']!, `${f.ids['series']}:${today}`], months: [month, next], fileIds: [f.ids['pdf']!] };
}

async function get(request: APIRequestContext, url: string): Promise<Fetched> {
  const res = await request.get(url, { maxRedirects: 0 });
  const headers = res.headers();
  const contentType = headers['content-type'] ?? '';
  if (contentType === 'application/pdf') return { url, status: res.status(), headers, contentType, ...(await pdfBody(await res.body())) };
  const body = TEXTUAL.test(contentType) || contentType === '' ? await res.text() : '';
  return { url, status: res.status(), headers, contentType, body };
}

/** Same-site links, sources and form actions in a page. */
function links(page: Fetched, months: readonly string[]): string[] {
  if (!page.contentType.startsWith('text/html')) return [];
  const out: string[] = [];
  for (const m of page.body.matchAll(/\s(?:href|src|action)="([^"]+)"/g)) {
    const raw = m[1]!.replace(/&amp;/g, '&');
    let url: URL;
    try {
      url = new URL(raw, REDACTION.siteUrl);
    } catch {
      continue;
    }
    if (url.origin !== new URL(REDACTION.siteUrl).origin) continue;
    // A query is the reader's own (a return path, a search) except a calendar month, kept to the seeded ones.
    const month = url.searchParams.get('month');
    if (month !== null && !months.includes(month)) continue;
    out.push(month === null ? url.pathname : `${url.pathname}?month=${month}`);
  }
  return out;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright }) => {
  const stack = await playwright.request.newContext();
  fixture = (await (await stack.get(`${REDACTION.stackUrl}/fixture`)).json()) as Fixture;
  await stack.dispose();
});

test('the PDF check finds the canaries in the original: it would see one in a copy', async () => {
  const { body, pdf } = await pdfBody(Buffer.from(fixture.pdfOriginal, 'base64'));
  expect(pdf.inflated).toBeGreaterThan(0);
  expect(pdf.text).toContain(fixture.pdfPlain);
  for (const name of ['phone', 'pdfName']) {
    expect(fold(pdf.text), name).toContain(fold(fixture.canaries[name]!));
    expect(fold(body), name).toContain(fold(fixture.canaries[name]!));
  }
  // The raw bytes alone do not show them: the page is compressed.
  expect(Buffer.from(fixture.pdfOriginal, 'base64').toString('latin1')).not.toContain(fixture.canaries['pdfName']);
});

test('every canary is in the database the API reads: the seed reached its place', () => {
  expect(Object.keys(fixture.canaries).length).toBeGreaterThanOrEqual(15);
  for (const [name, count] of Object.entries(fixture.stored)) expect(count, name).toBeGreaterThan(0);
});

test('as the public, every route and every page it links to carries no canary in any body or header', async ({ request }) => {
  const ctx = context(fixture);
  const queue = [...new Set(crawlSeeds(ctx))];
  while (queue.length > 0 && fetched.size < MAX_FETCHES) {
    const url = queue.shift()!;
    if (fetched.has(url)) continue;
    const page = await get(request, url);
    fetched.set(url, page);
    for (const next of links(page, ctx.months)) if (!fetched.has(next) && !queue.includes(next)) queue.push(next);
  }
  expect(queue, 'the crawl stopped at its cap').toEqual([]);
  console.log(JSON.stringify({ crawled: fetched.size }));

  // Every route was reached, and a live route answered 200 at least once.
  const reached = new Map<string, number[]>();
  for (const page of fetched.values()) {
    const pattern = patternOf(new URL(page.url, REDACTION.siteUrl).pathname);
    if (pattern) reached.set(pattern, [...(reached.get(pattern) ?? []), page.status]);
  }
  expect([...Object.keys(LIVE), ...Object.keys(STATIC)].filter((r) => !reached.has(r))).toEqual([]);
  for (const route of Object.keys(LIVE)) expect(reached.get(route), route).toContain(200);
  // Each series date the calendar listed was followed, page and file.
  expect((reached.get('/events/[id]') ?? []).length).toBeGreaterThan(20);
  expect((reached.get('/events/[id].ics') ?? []).length).toBeGreaterThan(3);

  const needles = Object.entries(fixture.canaries).map(([name, value]) => [name, fold(value)] as const);
  const leaks: string[] = [];
  for (const page of fetched.values()) {
    const haystacks = [page.body, ...Object.entries(page.headers).map(([k, v]) => `${k}: ${v}`)].map(fold);
    for (const [name, needle] of needles) if (haystacks.some((h) => h.includes(needle))) leaks.push(`${name} in ${page.url}`);
  }
  expect(leaks).toEqual([]);
});

test('the redacted copies render: "[withheld]" in every format, the dropped items gone, the controls shown', async () => {
  const body = (url: string) => {
    const page = fetched.get(url);
    expect(page, url).toBeDefined();
    expect(page!.status, url).toBe(200);
    return page!.body.replace(/\r\n /g, '');
  };
  const games = `/events/${fixture.ids['games']}`;
  for (const url of ['/', '/events', '/finances', '/calendar.ics', '/events.ics', games, `${games}.ics`]) expect(body(url), url).toContain('[withheld]');
  // The head of an event page is built from the same redacted copy.
  const head = /<head>([\s\S]*?)<\/head>/.exec(body(games))?.[1] ?? '';
  expect(head).toMatch(/<title>Games night with \[withheld\][^<]*<\/title>/);
  // A whole-item mark and a hidden category drop the item; the control item stays.
  expect(body('/')).toContain('Helpers wanted');
  for (const url of ['/', '/finances']) {
    expect(body(url), url).not.toContain('Remembering a friend');
    expect(body(url), url).not.toContain('Mailing list');
  }
  // A private venue's name and link, and a member's home, by area only.
  expect(body(`/events/${fixture.ids['online']}`)).toContain('Online: [withheld]');
  expect(body(`/events/${fixture.ids['potluck']}`)).toContain("A member's home in Okaloosa County");
});

test('an item whose slug the API withheld is shown by its id; an unmarked item keeps its slug', () => {
  const finances = fetched.get('/finances')!.body;
  expect(finances).toContain(`id="summary-${fixture.ids['accented']}"`);
  expect(finances).toContain(`id="summary-${fixture.plainSlug}"`);
  expect(finances).toContain('Report by [withheld]');
});

test('the event pages load by the id the API gave, and the calendar links them by it', () => {
  const ics = fetched.get('/calendar.ics')!.body;
  for (const key of ['games', 'potluck', 'online']) {
    expect(ics).toContain(`UID:${fixture.ids[key]}@nwflorida.us`);
    expect(fetched.get(`/events/${fixture.ids[key]}`)?.status, key).toBe(200);
  }
});

test('the PDF is linked where its item renders, and served as the redacted copy: a PDF, inline, publicly cached', () => {
  const url = `/documents/${fixture.ids['pdf']}.pdf`;
  expect(fetched.get('/finances')!.body).toContain(`href="${url}"`);
  const pdf = fetched.get(url);
  expect(pdf?.status).toBe(200);
  expect(pdf!.contentType).toBe('application/pdf');
  expect(pdf!.headers['content-disposition']).toMatch(/^inline; filename="[a-z0-9-]+\.pdf"$/);
  expect(pdf!.headers['content-disposition']).toContain('withheld');
  expect(pdf!.headers['cache-control']).toBe(PUBLIC_CACHE);
  // The positive control: the copy was read, and it is not the original.
  expect(pdf!.pdf?.text).toContain(fixture.pdfPlain);
  expect(pdf!.pdf?.inflated).toBeGreaterThan(0);
  expect(pdf!.body).not.toContain(Buffer.from(fixture.pdfOriginal, 'base64').toString('latin1'));
});

test('sitemap.xml and robots.txt list no API-made URL', () => {
  expect(fetched.get('/sitemap.xml')!.body).not.toMatch(/\/events\/[0-9a-f-]{36}/);
  expect(fetched.get('/robots.txt')!.body).not.toMatch(/\/events\/[0-9a-f-]{36}/);
});

test('cache by audience: no response is stored publicly for a signed-in reader, on any route', async ({ request }) => {
  const wrong: string[] = [];
  for (const url of crawlSeeds(context(fixture))) {
    const res = await request.get(url, { maxRedirects: 0, headers: { cookie: `${SESSION_COOKIE}=x` } });
    const cache = res.headers()['cache-control'] ?? '';
    if (!/(^|, )(private|no-store)(,|$)/.test(cache) || /\bpublic\b|s-maxage/.test(cache)) wrong.push(`${url}: ${cache}`);
  }
  expect(wrong).toEqual([]);
});
