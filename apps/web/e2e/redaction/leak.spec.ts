// THE WEB REDACTION LEAK TEST (REDACT R2b, "every output format"). The real
// API serves a database seeded with random canaries that the public policy or
// a mark withholds (e2e/redaction/stack.mjs): marked passages in item and event
// titles, bodies, status notes, details, links and a series description;
// policy-redacted fields (a private venue's name and link, a member's home); a
// whole-item mark; an item the public policy hides; and an accented name in an
// item's slug, which the API must replace by the item's id. REDACT-LOOK (0022,
// Ross's 11-02 decision): the public is shown members' names, so the canaries
// are marked as phones, addresses and e-mails, which it still has withheld,
// and a marked name and a marked on-behalf-of byline must now reach it.
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
//
// A14: /news as a signed-in reader, through the same real API, with the test
// identity provider's JWT access tokens (playwright.redaction.config.ts). A
// member sees the members passage, the members article and the members copy
// (the positive control); a pending account none of it, nor a members file id;
// an officer never the officers article; with sign-in off, a session cookie
// changes nothing. D4 with AC6 (b): the members view needs an nwfl enrolee
// group in the session's claim AND member standing in the API's records. An
// account in nwfl-users alone with member standing gets it (the AC6 b path),
// one with pending standing does not, and an officers-only account, which the
// API itself would answer as an officer's, never has its token sent.
import { inflateSync } from 'node:zlib';
import { expect, test, type APIRequest, type APIRequestContext } from '@playwright/test';
import { ContentKind } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { grpcReads } from '../../src/lib/api/client';
import { PUBLIC_CACHE } from '../../server/policy.mjs';
import { SESSION_COOKIE } from '../../server/policy.mjs';
import { LIVE, STATIC, crawlSeeds, patternOf } from '../routes';
import { REDACTION } from './servers';

interface Fixture {
  canaries: Record<string, string>;
  /** Marked member names the public is shown since 0022: on a page, in the PDF, and the report's byline. */
  shown: { name: string; pdfName: string; byline: string };
  ids: Record<string, string>;
  plainSlug: string;
  pdfPlain: string;
  pdfOriginal: string;
  stored: Record<string, number>;
  /** The newsletter issue: its title and summary, a line its PDFs carry, and the public original's sha256 in hex. */
  issue: { title: string; summary: string; plain: string; publicSha256: string };
  /** What the article with the members passage says to everyone (A14). */
  articlePlain: string;
  /** D1: the members article's title and summary, which the public is shown as a teaser. */
  membersTeaser: { title: string; summary: string };
  /** LINKS L4: three links on the marked PDF, in the copies the worker made; the held one's target holds the phone canary (only the members copy holds it); off is turned off once copies held it. */
  links: { plain: string; held: string; off: string };
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
  return { eventIds: [f.ids['games']!, f.ids['potluck']!, f.ids['online']!, `${f.ids['series']}:${today}`], months: [month, next], fileIds: [f.ids['pdf']!], linkIds: [f.links.plain, f.links.held, f.links.off] };
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

test("0022 (SPEC L11): the public is shown a marked member's name on a page and in the PDF copy, and the API gives it the marked byline", async () => {
  expect(fold(fetched.get('/')!.body)).toContain(fold(fixture.shown.name));
  // The copy is still a redacted one: its phone withheld, the name shown.
  const pdf = fetched.get(`/documents/${fixture.ids['pdf']}.pdf`);
  expect(pdf?.status).toBe(200);
  expect(pdf!.pdf?.text).toContain(`Thanks to ${fixture.shown.pdfName}.`);
  expect(fold(pdf!.body)).not.toContain(fold(fixture.canaries['phone']!));
  // The site shows no byline: the API's answer to the public (no token) carries it.
  const items = await grpcReads({ baseUrl: REDACTION.apiUrl, timeoutMs: 5000 }, () => undefined).listPublishedItems(ContentKind.UNSPECIFIED, 100);
  const report = items.find((item) => item.id === fixture.ids['report']);
  expect(report?.live?.onBehalfOf).toBe(`${fixture.shown.byline}, guest writer`);
  expect(fold(JSON.stringify(report, (_, value: unknown) => (typeof value === 'bigint' ? String(value) : value)))).not.toContain(fold(fixture.canaries['reportPhone']!));
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

test("/news lists the issue with its public PDF, served as a copy, and the members file reaches no response, nor the original's hash", () => {
  const news = fetched.get('/news');
  expect(news?.status).toBe(200);
  expect(news!.body).toContain(fixture.issue.title);
  expect(news!.body).toContain(fixture.issue.summary);
  expect(news!.body).not.toContain('Sample entries');
  const url = `/documents/${fixture.ids['issuePublicPdf']}.pdf`;
  expect(news!.body).toContain(`href="${url}"`);
  const pdf = fetched.get(url);
  expect(pdf?.status).toBe(200);
  expect(pdf!.contentType).toBe('application/pdf');
  expect(pdf!.pdf?.text).toContain(fixture.issue.plain);
  const members = fixture.ids['issueMembersPdf']!;
  const sha = fixture.issue.publicSha256;
  const shaBase64 = Buffer.from(sha, 'hex').toString('base64');
  const seen: string[] = [];
  for (const page of fetched.values()) {
    const haystacks = [page.body, ...Object.entries(page.headers).map(([k, v]) => `${k}: ${v}`)];
    if (haystacks.some((h) => h.includes(members))) seen.push(`members file in ${page.url}`);
    if (haystacks.some((h) => h.toLowerCase().includes(sha) || h.includes(shaBase64))) seen.push(`public original's sha256 in ${page.url}`);
  }
  expect(seen).toEqual([]);
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

// A14: /news as a signed-in reader, through the real API.
const MEMBERS_CANARIES = ['membersPassage', 'membersBody'] as const;
const OFFICERS_CANARIES = ['officersTitle', 'officersBody'] as const;

/** Signed in on the site with sign-in on, at the test provider, as one of its people: a context that carries the session. */
async function signedIn(request: APIRequest, login: 'member' | 'pending' | 'officer' | 'officer-only' | 'enrolee' | 'enrolee-pending' | 'turned-down'): Promise<APIRequestContext> {
  const ctx = await request.newContext({ baseURL: REDACTION.memberSiteUrl, ignoreHTTPSErrors: true });
  const form = await ctx.get('/sign-in?return=%2Fnews');
  expect(form.status(), 'the provider asks who it is').toBe(200);
  const action = /<form method="post" action="([^"]+)"/.exec(await form.text())?.[1];
  expect(action, 'the sign-in form').toBeDefined();
  const done = await ctx.post(new URL(action!, form.url()).href, { form: { login, password: 'any' } });
  expect(done.status(), `${login} signed in`).toBe(200);
  expect(new URL(done.url()).pathname).toBe('/news');
  return ctx;
}

const seen = (html: string, names: readonly string[]) => names.filter((name) => fold(html).includes(fold(fixture.canaries[name]!)));

test('LINKS L4: through the real API, the public is shown a link of the copy it is served, and the 404 for one whose target holds a withheld phone', async () => {
  const plain = fetched.get(`/out/${fixture.links.plain}`);
  expect(plain?.status).toBe(200);
  expect(plain!.body).toContain('<p class="out-host">club.example</p>');
  expect(plain!.body).toContain('href="https://club.example/receipts" target="_blank" rel="noopener noreferrer" data-out-continue');
  expect(plain!.body).toContain(`href="/documents/${fixture.ids['pdf']}.pdf#page=1"`);
  expect(plain!.headers['cache-control']).toBe('private, no-store');
  expect(plain!.headers['referrer-policy']).toBe('no-referrer');
  const held = fetched.get(`/out/${fixture.links.held}`);
  const none = fetched.get('/out/aaaaaaaaaaaaaaaaaaaaaaaaaa');
  expect([held?.status, none?.status]).toEqual([404, 404]);
  // The same page as for no link at all, but for its own address.
  const own = (body: string, id: string) => body.replaceAll(`/out/${id}`, '/out/ID').replaceAll(`%2Fout%2F${id}`, '%2Fout%2FID');
  expect(own(held!.body, fixture.links.held)).toBe(own(none!.body, 'aaaaaaaaaaaaaaaaaaaaaaaaaa'));
  expect(fold(held!.body)).not.toContain(fold(fixture.canaries['phone']!));
});

test('LINKS L4: a member, whose policy shows phones, follows the held link from the members copy (the positive control), never stored', async ({ playwright }) => {
  const member = await signedIn(playwright.request, 'member');
  const held = await get(member, `/out/${fixture.links.held}`);
  expect(held.status).toBe(200);
  expect(held.body).toContain(`href="https://club.example/call/${fixture.canaries['phone']}"`);
  expect(held.headers['cache-control']).toBe('private, no-store');
  await member.dispose();
});

test('LINKS L4: a signed-in officer, served the original, is shown the public copy\'s link (the site asks again as the public), and the held one is still the 404', async ({ playwright }) => {
  for (const login of ['officer', 'officer-only'] as const) {
    const officer = await signedIn(playwright.request, login);
    const plain = await get(officer, `/out/${fixture.links.plain}`);
    expect(plain.status, login).toBe(200);
    expect(plain.body, login).toContain('href="https://club.example/receipts" target="_blank" rel="noopener noreferrer" data-out-continue');
    expect(plain.headers['cache-control'], login).toBe('private, no-store');
    const held = await get(officer, `/out/${fixture.links.held}`);
    expect(held.status, login).toBe(404);
    expect(fold(held.body), login).not.toContain(fold(fixture.canaries['phone']!));
    await officer.dispose();
  }
});

test('LINKS L4: a link turned off says so, with no URL, to the public and members, whose copies the worker recorded in the ledger, and to an officer', async ({ playwright }) => {
  const turnedOff = (body: string, who: string) => {
    expect(body, who).toContain('This link was turned off');
    expect(body, who).not.toContain('parked.example');
    expect(body, who).toContain(`href="/documents/${fixture.ids['pdf']}.pdf#page=2"`);
  };
  const pub = fetched.get(`/out/${fixture.links.off}`);
  expect(pub?.status).toBe(200);
  turnedOff(pub!.body, 'public');
  for (const login of ['member', 'officer'] as const) {
    const reader = await signedIn(playwright.request, login);
    const off = await get(reader, `/out/${fixture.links.off}`);
    expect(off.status, login).toBe(200);
    turnedOff(off.body, login);
    await reader.dispose();
  }
});

const stamp = (text: string) => text.replace(/^DTSTAMP:.*$/gm, '');

test("D1: the public's /news, through the real API, lists the members article by title and summary with the members box, and none of its body", async ({ playwright }) => {
  const anonymous = await playwright.request.newContext({ baseURL: REDACTION.memberSiteUrl, ignoreHTTPSErrors: true });
  const news = await get(anonymous, '/news');
  expect(news.status).toBe(200);
  expect(news.body).toContain(`<h3>${fixture.membersTeaser.title}</h3>`);
  expect(news.body).toContain(fixture.membersTeaser.summary);
  expect(news.body).toContain('Members only, <a href="/sign-in?return=%2Fnews&amp;again=1">sign in</a> to read.');
  expect(seen(news.body, [...MEMBERS_CANARIES, ...OFFICERS_CANARIES])).toEqual([]);
  expect(news.body).not.toContain(fixture.ids['issueMembersPdf']);
  expect(news.headers['cache-control']).toBe(PUBLIC_CACHE);
  await anonymous.dispose();
});

test('a member sees the members passage and the members article (the positive control), and gets the members copy, never stored', async ({ playwright }) => {
  const member = await signedIn(playwright.request, 'member');
  const news = await get(member, '/news');
  expect(news.status).toBe(200);
  expect(seen(news.body, MEMBERS_CANARIES)).toEqual([...MEMBERS_CANARIES]);
  expect(seen(news.body, OFFICERS_CANARIES)).toEqual([]);
  expect(news.body).toContain(fixture.articlePlain);
  expect(news.body).toContain(`href="/documents/${fixture.ids['issueMembersPdf']}.pdf"`);
  expect(news.headers['cache-control']).toBe('private, no-store');
  expect(news.headers['cdn-cache-control']).toBe('no-store');
  expect(news.headers['vary']).toBe('Cookie');
  const pdf = await get(member, `/documents/${fixture.ids['issueMembersPdf']}.pdf`);
  expect(pdf.status).toBe(200);
  expect(pdf.contentType).toBe('application/pdf');
  expect(pdf.pdf?.text).toContain('the members edition');
  expect(pdf.headers['cache-control']).toBe('private, no-store');
  expect(pdf.headers['cdn-cache-control']).toBe('no-store');
  await member.dispose();
});

test('an officer with no member account is returned to /news, gets the members view, and /news never shows the officers article the API sends them', async ({ playwright }) => {
  // W-SIGNUP fix 1: the officer has no member_account row here (signedIn checks the return to /news).
  const officer = await signedIn(playwright.request, 'officer');
  const news = await get(officer, '/news');
  expect(seen(news.body, MEMBERS_CANARIES)).toEqual([...MEMBERS_CANARIES]);
  expect(seen(news.body, OFFICERS_CANARIES)).toEqual([]);
  const account = await get(officer, '/account');
  expect(account.status).toBe(200);
  expect(account.body).toContain('You need no member account to use the officer area.');
  expect(account.body).not.toContain('Send my sign-up');
  await officer.dispose();
});

test('W-SIGNUP fix 1: a rejected sign-up, through the real API, is told it was not approved and never that it waits', async ({ playwright }) => {
  const turnedDown = await signedIn(playwright.request, 'turned-down');
  const account = await get(turnedDown, '/account');
  expect(account.status).toBe(200);
  expect(account.body).toContain('Your sign-up was not approved.');
  expect(account.body).toContain('Membership Officer');
  expect(account.body).not.toContain('Your sign-up is waiting for an officer to approve it.');
  expect(account.body).not.toContain('Send my sign-up');
  await turnedDown.dispose();
});

test('a pending account (no member standing) sees no members canary and no members file id; its members copy is a missing file\'s 404', async ({ playwright }) => {
  const pending = await signedIn(playwright.request, 'pending');
  const news = await get(pending, '/news');
  expect(news.status).toBe(200);
  expect(seen(news.body, [...MEMBERS_CANARIES, ...OFFICERS_CANARIES])).toEqual([]);
  expect(news.body).not.toContain(fixture.ids['issueMembersPdf']);
  expect(news.body).toContain('Your account does not have member access yet.');
  expect(news.body).toContain(fixture.articlePlain);
  const withheld = await pending.get(`/documents/${fixture.ids['issueMembersPdf']}.pdf`);
  const random = await pending.get('/documents/00000000-0000-4000-8000-0000000000aa.pdf');
  expect(withheld.status()).toBe(404);
  expect(await withheld.text()).toBe(await random.text());
  await pending.dispose();
});

/** The public's view for a signed-in reader without member access: no members or officers canary, no members file id, the box, never stored. */
async function noMemberAccess(reader: APIRequestContext) {
  const news = await get(reader, '/news');
  expect(news.status).toBe(200);
  expect(seen(news.body, [...MEMBERS_CANARIES, ...OFFICERS_CANARIES])).toEqual([]);
  expect(news.body).not.toContain(fixture.ids['issueMembersPdf']);
  expect(news.body).toContain('Members only. Your account does not have member access yet.');
  expect(news.body).toContain(fixture.articlePlain);
  expect(news.body).toContain(`<h3>${fixture.membersTeaser.title}</h3>`);
  expect(news.body).not.toContain('Your sign-in has expired');
  expect(news.headers['cache-control']).toBe('private, no-store');
  expect(news.headers['cdn-cache-control']).toBe('no-store');
  const withheld = await reader.get(`/documents/${fixture.ids['issueMembersPdf']}.pdf`);
  const random = await reader.get('/documents/00000000-0000-4000-8000-0000000000aa.pdf');
  expect(withheld.status()).toBe(404);
  expect(await withheld.text()).toBe(await random.text());
}

test("D4: an officers-only account (no enrolee group), which the API would answer as an officer's, gets the public's view: its token never goes", async ({ playwright }) => {
  const officer = await signedIn(playwright.request, 'officer-only');
  await noMemberAccess(officer);
  await officer.dispose();
});

test('AC6 b: an account in nwfl-users alone, with member standing in the records, gets the members view and the members copy', async ({ playwright }) => {
  const enrolee = await signedIn(playwright.request, 'enrolee');
  const news = await get(enrolee, '/news');
  expect(news.status).toBe(200);
  expect(seen(news.body, MEMBERS_CANARIES)).toEqual([...MEMBERS_CANARIES]);
  expect(seen(news.body, OFFICERS_CANARIES)).toEqual([]);
  expect(news.body).toContain(`href="/documents/${fixture.ids['issueMembersPdf']}.pdf"`);
  expect(news.body).not.toContain('does not have member access');
  expect(news.headers['cache-control']).toBe('private, no-store');
  const pdf = await get(enrolee, `/documents/${fixture.ids['issueMembersPdf']}.pdf`);
  expect(pdf.status).toBe(200);
  expect(pdf.pdf?.text).toContain('the members edition');
  expect(pdf.headers['cache-control']).toBe('private, no-store');
  await enrolee.dispose();
});

test("AC6 b: an account in nwfl-users alone, with pending standing in the records, gets the public's view and the box", async ({ playwright }) => {
  const pending = await signedIn(playwright.request, 'enrolee-pending');
  await noMemberAccess(pending);
  await pending.dispose();
});

test("N4: with sign-in off, the public's teaser box says \"Members only.\" and nothing about signing in", () => {
  const news = fetched.get('/news')!;
  const start = news.body.indexOf(`<h3>${fixture.membersTeaser.title}</h3>`);
  expect(start).toBeGreaterThan(0);
  const teaser = news.body.slice(start, news.body.indexOf('</article>', start));
  expect(teaser).toContain('<p class="members-note">Members only.</p>');
  expect(teaser.toLowerCase()).not.toContain('sign in');
  expect(news.body).not.toContain('Members only, sign in to read.');
});

test("one reader's answer never reaches another: after a member, and beside one, the public's /news on the same site has none of it", async ({ playwright }) => {
  const member = await signedIn(playwright.request, 'member');
  const anonymous = await playwright.request.newContext({ baseURL: REDACTION.memberSiteUrl, ignoreHTTPSErrors: true });
  await get(member, '/news');
  const after = await get(anonymous, '/news');
  expect(seen(after.body, [...MEMBERS_CANARIES, ...OFFICERS_CANARIES])).toEqual([]);
  expect(after.body).not.toContain(fixture.ids['issueMembersPdf']);
  // Sign-in is on here: the public box offers it.
  expect(after.body).toContain('href="/sign-in?return=%2Fnews&amp;again=1"');
  const together = await Promise.all([get(member, '/news'), get(anonymous, '/news'), get(member, '/news'), get(anonymous, '/news')]);
  for (const n of [1, 3]) {
    expect(seen(together[n]!.body, MEMBERS_CANARIES), String(n)).toEqual([]);
    expect(together[n]!.body, String(n)).not.toContain(fixture.ids['issueMembersPdf']);
  }
  for (const n of [0, 2]) expect(seen(together[n]!.body, MEMBERS_CANARIES), String(n)).toEqual([...MEMBERS_CANARIES]);
  const members = await anonymous.get(`/documents/${fixture.ids['issueMembersPdf']}.pdf`);
  expect(members.status()).toBe(404);
  await Promise.all([member.dispose(), anonymous.dispose()]);
});

test("with a member's session, the calendar files are byte for byte the public's: no feed forwards a token", async ({ playwright }) => {
  const member = await signedIn(playwright.request, 'member');
  const anonymous = await playwright.request.newContext({ baseURL: REDACTION.memberSiteUrl, ignoreHTTPSErrors: true });
  for (const url of ['/calendar.ics', '/events.ics', `/events/${fixture.ids['games']}.ics`]) {
    const signed = await member.get(url);
    const plain = await anonymous.get(url);
    expect(signed.status(), url).toBe(200);
    expect(stamp(await signed.text()), url).toBe(stamp(await plain.text()));
  }
  await Promise.all([member.dispose(), anonymous.dispose()]);
});

test('with sign-in off, a session cookie changes nothing: /news and the PDFs are the public bytes, and the members copy a 404', async ({ request }) => {
  const cookie = { cookie: `${SESSION_COOKIE}=v1.forged` };
  for (const url of ['/news', `/documents/${fixture.ids['issuePublicPdf']}.pdf`, `/documents/${fixture.ids['issueMembersPdf']}.pdf`]) {
    const plain = await request.get(url);
    const withCookie = await request.get(url, { headers: cookie });
    expect(withCookie.status(), url).toBe(plain.status());
    expect((await withCookie.body()).equals(await plain.body()), url).toBe(true);
  }
  expect((await request.get(`/documents/${fixture.ids['issueMembersPdf']}.pdf`, { headers: cookie })).status()).toBe(404);
});
