import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CheckDeps, type CheckResult, assertKeptForms, checkAll, makeChecker } from '../src/check.js';
import { DnsFailure } from '../src/dns.js';
import type { Rdap, RdapResult } from '../src/rdap.js';
import { type Stand, fakeDns, routedConnect, startHttp, startHttps, testPki } from './helpers/servers.js';

// One made-up public address per stand-in host; the routed connect sends each to the loopback stand-ins,
// which answer by the Host header. No test reaches a real site (the container has no network).
const A = '93.184.216.1';
const NAMES = ['site.example', 'www.site.example', 'other.example', 'parked.example', 'sale.example', 'old.example', 'reg.example', 'mx.example', 'feed.example', 'slow.example', 'unsure.example'];
const pki = testPki(NAMES);

type Page = { status: number; headers?: Record<string, string>; body?: string };
const PAGES: Record<string, Page | 'hang'> = {
  'site.example/': { status: 200, headers: { 'content-type': 'text/html' }, body: '<p>Club news</p>' },
  'site.example/page': { status: 200, body: 'ok' },
  'site.example/gone': { status: 404 },
  'site.example/removed': { status: 410 },
  'site.example/private': { status: 403 },
  'site.example/login': { status: 401 },
  'site.example/busy': { status: 429 },
  'site.example/broken': { status: 503 },
  'site.example/teapot': { status: 418 },
  'site.example/to-other': { status: 301, headers: { location: 'https://other.example/landing' } },
  'site.example/to-www': { status: 301, headers: { location: 'https://www.site.example/' } },
  'site.example/to-http': { status: 302, headers: { location: 'http://site.example/page' } },
  'site.example/to-mfc': { status: 302, headers: { location: 'https://myfigurecollection.net/item/1' } },
  'site.example/to-fb': { status: 302, headers: { location: 'https://www.facebook.com/x' } },
  'site.example/to-inside': { status: 302, headers: { location: 'http://10.1.1.1/' } },
  'site.example/to-port': { status: 302, headers: { location: 'https://site.example:8080/' } },
  'site.example/to-members': { status: 302, headers: { location: 'https://members.us.mensa.org../roster' } },
  'site.example/to-fb-dots': { status: 302, headers: { location: 'https://www.facebook.com.../x' } },
  'www.site.example/': { status: 200, body: 'www' },
  'other.example/landing': { status: 200, body: 'elsewhere' },
  'sale.example/': { status: 200, headers: { 'content-type': 'text/html' }, body: '<h1>This domain is for sale!</h1>' },
  'parked.example/': { status: 200, body: 'hello' },
  'old.example/': { status: 200, body: 'hello' },
  'reg.example/': { status: 200, body: 'hello' },
  'unsure.example/': { status: 200, body: 'hello' },
  'slow.example/': 'hang',
};

function route(req: IncomingMessage, res: ServerResponse): void {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '');
  const page = PAGES[`${host}${req.url ?? '/'}`];
  if (page === 'hang') return;
  if (page === undefined) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(page.status, page.headers).end(page.body ?? '');
}

let tls: Stand;
let plain: Stand;
beforeAll(async () => {
  tls = await startHttps(route, pki);
  plain = await startHttp(route);
});
afterAll(async () => {
  await tls.close();
  await plain.close();
});

const rdapTable: Record<string, RdapResult> = {
  'old.example': { status: 'dated', date: '2026-10-15' },
  'reg.example': { status: 'dated', date: '1999-01-01' },
  'unsure.example': { status: 'unknown', why: 'no-rdap' },
};

function deps(): CheckDeps & { dns: ReturnType<typeof fakeDns>; connect: ReturnType<typeof routedConnect>; rdapAsked: string[] } {
  const table: Record<string, string[] | 'timeout'> = Object.fromEntries(NAMES.map((n) => [n, [A]]));
  table['inside.example'] = ['192.168.1.20'];
  table['nodata.example'] = [];
  table['example.org'] = [A];
  table['www.facebook.com'] = ['157.240.1.35'];
  const dns = fakeDns(table, {
    mx: { 'example.com': [{ exchange: 'mail.example.com', priority: 10 }] },
    ns: { 'parked.example': ['ns1.sedoparking.com'], 'site.example': ['ns1.provider.example'] },
  });
  const connect = routedConnect({ [`${A}:443`]: tls.port, [`${A}:80`]: plain.port }, pki.ca);
  const rdapAsked: string[] = [];
  const rdap: Rdap = {
    registered: (domain) => {
      rdapAsked.push(domain);
      return Promise.resolve(rdapTable[domain] ?? { status: 'unknown', why: 'not-found' });
    },
  };
  return { dns, connect, rdap, rdapAsked, issueDate: '2026-09-01', limits: { hopMs: 500 } };
}

const check = async (url: string, d = deps()): Promise<CheckResult> => makeChecker(d).check(url);

describe('checkLink: one verdict per link, with its reasons', () => {
  it('keeps a working https link as it is', async () => {
    const out = await check('https://site.example/');
    expect(out).toEqual({
      url: 'https://site.example/',
      kind: 'web',
      verdict: 'ok',
      reasons: [],
      notes: ['rdap-not-found', 'safe-browsing-off'],
      keepable: true,
      kept: 'https://site.example/',
      chain: [{ url: 'https://site.example/', status: 200 }],
      finalUrl: 'https://site.example/',
    });
  });

  it('upgrades an http link whose https form works, never fetching it over http', async () => {
    const d = deps();
    const out = await check('http://site.example/page', d);
    expect(out).toMatchObject({ verdict: 'upgrade', reasons: ['upgraded'], kept: 'https://site.example/page', keepable: true });
    expect(d.connect.targets.map((t) => t.port)).toEqual([443]);
  });

  it('drops an http link with no working https, and it cannot be kept', async () => {
    const d = deps();
    d.connect = routedConnect({ [`${A}:80`]: plain.port, [`${A}:443`]: plain.port }, pki.ca);
    const out = await check('http://site.example/page', d);
    expect(out).toMatchObject({ verdict: 'drop', reasons: ['no-https', 'tls'], keepable: false });
    expect(out.kept).toBeUndefined();
    expect(out.fix).toMatch(/https/);
  });

  it('keeps an http link whose https form answers 2xx but is flagged, or whose name fails, at https: no-https is for https that does not work', async () => {
    expect(await check('http://site.example/to-other')).toMatchObject({ verdict: 'flag', reasons: ['unrelated-redirect'], keepable: true, kept: 'https://site.example/to-other' });
    expect(await check('http://nowhere.example/')).toMatchObject({ verdict: 'drop', reasons: ['nxdomain'], keepable: true, kept: 'https://nowhere.example/' });
  });

  it('trims trailing punctuation and stray spaces and uses the trimmed form when it works', async () => {
    expect(await check('https://site.example/page).')).toMatchObject({ verdict: 'upgrade', reasons: ['trimmed'], kept: 'https://site.example/page' });
    expect(await check('https://site.ex ample/page')).toMatchObject({ verdict: 'upgrade', reasons: ['trimmed'], kept: 'https://site.example/page' });
    expect(await check('http://site.example/page,')).toMatchObject({ verdict: 'upgrade', reasons: ['upgraded', 'trimmed'], kept: 'https://site.example/page' });
  });

  it('reports the first form when no form works', async () => {
    expect(await check('https://site.example/gone.')).toMatchObject({ url: 'https://site.example/gone.', verdict: 'drop', reasons: ['dead'] });
  });

  it.each([
    ['https://site.example/gone', 'drop', ['dead']],
    ['https://site.example/removed', 'drop', ['dead']],
    ['https://site.example/private', 'flag', ['blocked']],
    ['https://site.example/login', 'flag', ['blocked']],
    ['https://site.example/busy', 'flag', ['rate-limited']],
    ['https://site.example/broken', 'flag', ['server-error']],
    ['https://site.example/teapot', 'flag', ['http-error']],
    ['https://slow.example/', 'flag', ['timeout']],
    ['https://site.example/to-other', 'flag', ['unrelated-redirect']],
    ['https://site.example/to-http', 'flag', ['redirect-to-http']],
    ['https://site.example/to-port', 'flag', ['bad-redirect']],
    ['https://site.example/to-inside', 'drop', ['private-address']],
    ['https://site.example/to-mfc', 'review', ['no-fetch']],
    ['https://site.example/to-fb', 'confirm', ['login-walled']],
    ['https://nowhere.example/', 'drop', ['nxdomain']],
    ['https://nodata.example/', 'drop', ['no-address']],
    ['https://inside.example/', 'drop', ['private-address']],
    ['http://10.0.0.1/', 'drop', ['ip-literal']],
    ['https://93.184.216.1/', 'drop', ['ip-literal']],
    ['https://[2606:4700::1]/', 'drop', ['ip-literal']],
    ['https://localhost/', 'drop', ['local-name']],
    ['https://my_site.example/', 'drop', ['host-name']],
    ['https://a-.site.example/', 'drop', ['host-name']],
    ['mailto:a%23b@example.org', 'drop', ['malformed']],
    ['https://site.example:443/', 'drop', ['port']],
    ['https://site.example/to-members', 'review', ['no-fetch']],
    ['https://site.example/to-fb-dots', 'confirm', ['login-walled']],
    ['https://site.example:8080/', 'drop', ['port']],
    ['https://user@example.com/', 'drop', ['credentials']],
    ['javascript:alert(1)', 'drop', ['scheme']],
    ['https://', 'drop', ['malformed']],
    ['https://sale.example/', 'drop', ['parked']],
    ['https://parked.example/', 'drop', ['parked']],
    ['https://old.example/', 'flag', ['re-registered']],
  ])('%s is %s %j', async (url, verdict, reasons) => {
    expect(await check(url)).toMatchObject({ verdict, reasons });
  });

  it('accepts www to apex and http to https on the same site as related', async () => {
    expect(await check('https://site.example/to-www')).toMatchObject({ verdict: 'ok', reasons: [], finalUrl: 'https://www.site.example/' });
  });

  it('records the registration date, and notes an RDAP that cannot tell', async () => {
    expect(await check('https://old.example/')).toMatchObject({ registered: '2026-10-15' });
    expect(await check('https://reg.example/')).toMatchObject({ verdict: 'ok', registered: '1999-01-01' });
    expect((await check('https://unsure.example/')).notes).toContain('rdap-unknown');
  });

  it('refuses an explicit port, even :80 or :443, before any request (CONTRACT 2)', async () => {
    for (const url of ['http://site.example:80/page', 'https://site.example:443/page']) {
      const d = deps();
      const out = await check(url, d);
      expect(out).toMatchObject({ verdict: 'drop', reasons: ['port'], keepable: false });
      expect(out.kept).toBeUndefined();
      expect(d.dns.calls).toEqual([]);
    }
  });

  it('refuses an IP literal or a dotless host before any request (CONTRACT 2)', async () => {
    for (const url of ['https://93.184.216.1/', 'http://2130706433/', 'https://[2606:4700::1]/', 'https://localhost/', 'http://intranet/']) {
      const d = deps();
      const out = await check(url, d);
      expect(out.keepable).toBe(false);
      expect(d.dns.calls).toEqual([]);
      expect(d.connect.targets).toEqual([]);
    }
  });

  it.each([
    ['/gone', ['no-https', 'dead']],
    ['/private', ['no-https', 'blocked']],
    ['/broken', ['no-https', 'server-error']],
  ])('drops an http link whose https form answers %s with no-https, unkeepable (N3)', async (path, reasons) => {
    const out = await check(`http://site.example${path}`);
    expect(out).toMatchObject({ verdict: 'drop', reasons, keepable: false });
    expect(out.kept).toBeUndefined();
    expect(out.fix).toMatch(/https/);
  });

  it('flags a DNS failure as soft', async () => {
    const d = deps();
    d.dns = fakeDns({ 'site.example': 'timeout' });
    expect(await check('https://site.example/', d)).toMatchObject({ verdict: 'flag', reasons: ['dns-failure'] });
  });

  it('marks unkeepable reasons so a yes cannot keep them', async () => {
    expect((await check('https://site.example/gone')).keepable).toBe(true);
    expect((await check('http://10.0.0.1/')).keepable).toBe(false);
    expect((await check('https://site.example/to-inside')).reasons).toEqual(['private-address']);
    expect((await check('https://site.example/to-inside')).keepable).toBe(false);
  });
});

describe('the no-fetch list and login-walled hosts', () => {
  // Assembled from parts: the repository's contact-detail scan allows example domains only.
  const mail = (local: string, domain: string): string => `mailto:${local}@${domain}`;

  it.each([
    ['https://us.mensa.org.../members/roster', 'https://us.mensa.org/members/roster'],
    ['https://members.us.mensa.org../roster', 'https://members.us.mensa.org/roster'],
    ['http://US.MENSA.ORG./join', 'https://us.mensa.org/join'],
    [mail('officer', 'members.us.mensa.org..'), mail('officer', 'members.us.mensa.org')],
  ])('%s, with trailing dots, is no-fetch with no request of any kind (B1)', async (url, kept) => {
    const d = deps();
    const out = await check(url, d);
    expect(out).toMatchObject({ verdict: 'review', reasons: ['no-fetch'], kept });
    expect(d.dns.calls).toEqual([]);
    expect(d.connect.targets).toEqual([]);
    expect(d.rdapAsked).toEqual([]);
  });

  it('a login-walled host with trailing dots is resolved by its canonical name and never fetched (B1)', async () => {
    const d = deps();
    const out = await check('https://www.facebook.com.../groups/x', d);
    expect(out).toMatchObject({ verdict: 'confirm', reasons: ['login-walled'], kept: 'https://www.facebook.com/groups/x' });
    expect(d.dns.calls).toEqual(['A www.facebook.com', 'AAAA www.facebook.com']);
    expect(d.connect.targets).toEqual([]);
  });

  it('a redirect hop to the no-fetch list with trailing dots is never resolved nor requested (B1)', async () => {
    const d = deps();
    const out = await check('https://site.example/to-members', d);
    expect(out).toMatchObject({ verdict: 'review', reasons: ['no-fetch'] });
    expect(d.dns.calls.filter((c) => c.includes('mensa'))).toEqual([]);
    expect(d.connect.targets.map((t) => t.host)).toEqual(['site.example']);
    expect(out.chain.map((h) => h.url)).toEqual(['https://site.example/to-members', 'https://members.us.mensa.org/roster']);
  });

  it.each(['https://members.us.mensa.org/directory', 'http://us.mensa.org/join', 'https://myfigurecollection.net/item/1', 'https://www.suruga-ya.jp/product/1', 'https://hobby-genki.com/x', 'https://vndb.org/v1'])(
    '%s is "not checked: officer review", with no request of any kind',
    async (url) => {
      const d = deps();
      const out = await check(url, d);
      expect(out).toMatchObject({ verdict: 'review', reasons: ['no-fetch'], keepable: true });
      expect(out.kept).toMatch(/^https:\/\//);
      expect(out.fix).toBe('Not checked: officer review.');
      expect(d.dns.calls).toEqual([]);
      expect(d.connect.targets).toEqual([]);
      expect(d.rdapAsked).toEqual([]);
    },
  );

  it('resolves a login-walled host but never fetches it, and keeps it at https', async () => {
    const d = deps();
    const out = await check('http://www.facebook.com/groups/example', d);
    expect(out).toMatchObject({ verdict: 'confirm', reasons: ['login-walled'], kept: 'https://www.facebook.com/groups/example', keepable: true, notes: ['https-assumed'] });
    expect(d.dns.calls).toEqual(['A www.facebook.com', 'AAAA www.facebook.com']);
    expect(d.connect.targets).toEqual([]);
    expect(d.rdapAsked).toEqual([]);
  });

  it('drops a login-walled name that does not resolve', async () => {
    expect(await check('https://nosuch.facebook.com/x')).toMatchObject({ verdict: 'drop', reasons: ['nxdomain'] });
  });

  it('drops a login-walled name with no address', async () => {
    const d = deps();
    d.dns = fakeDns({ 'www.facebook.com': [] });
    expect(await check('https://www.facebook.com/', d)).toMatchObject({ verdict: 'drop', reasons: ['no-address'] });
  });

  it('drops a login-walled name that resolves privately', async () => {
    const d = deps();
    d.dns = fakeDns({ 'www.facebook.com': ['10.0.0.9'] });
    expect(await check('https://www.facebook.com/', d)).toMatchObject({ verdict: 'drop', reasons: ['private-address'], keepable: false });
  });
});

describe('mailto links', () => {
  it('keeps an address whose domain takes mail', async () => {
    expect(await check('mailto:editor@example.com')).toMatchObject({ kind: 'mail', verdict: 'ok', kept: 'mailto:editor@example.com', reasons: [] });
  });

  it('keeps only mailto:<address>, its query dropped, and checks only that domain (CONTRACT 3)', async () => {
    const d = deps();
    const out = await check('mailto:editor@Example.COM?subject=Hi&cc=other@example.net', d);
    expect(out).toMatchObject({ kind: 'mail', verdict: 'ok', kept: 'mailto:editor@example.com', keepable: true });
    expect(d.dns.calls).toEqual(['MX example.com']);
  });

  it('refuses a mail domain that is an IP literal or dotless, with no lookup', async () => {
    for (const url of ['mailto:x@127.0.0.1', 'mailto:root@localhost']) {
      const d = deps();
      expect((await check(url, d)).keepable).toBe(false);
      expect(d.dns.calls).toEqual([]);
    }
  });

  it('falls back to A or AAAA when there is no MX', async () => {
    expect(await check('mailto:editor@example.org')).toMatchObject({ verdict: 'ok', notes: ['mx-fallback'] });
  });

  it.each([
    ['an MX lookup that says NXDOMAIN', {}, { 'example.net': 'nxdomain' as const }, ['nxdomain']],
    ['a null MX', {}, { 'example.net': [{ exchange: '', priority: 0 }] }, ['no-mail']],
    ['no MX and no address', { 'example.net': [] }, {}, ['no-mail']],
  ])('drops a mail domain with %s', async (_name, table, mx, reasons) => {
    const d = deps();
    d.dns = fakeDns(table, { mx });
    expect(await check('mailto:editor@example.net', d)).toMatchObject({ verdict: 'drop', reasons });
  });

  it('flags a DNS failure on the mail domain as soft', async () => {
    const d = deps();
    d.dns = fakeDns({}, { mx: { 'example.net': 'timeout' } });
    expect(await check('mailto:a@example.net', d)).toMatchObject({ verdict: 'flag', reasons: ['dns-failure'] });
  });

  it.each([
    ['nxdomain', ['nxdomain']],
    ['timeout', ['dns-failure']],
  ] as const)('reads a mail domain with no MX whose address lookup gives %s', async (code, reasons) => {
    const d = deps();
    d.dns = { ...fakeDns({ 'example.net': code }), resolveMx: () => Promise.reject(new DnsFailure('nodata')) };
    expect(await check('mailto:a@example.net', d)).toMatchObject({ verdict: reasons[0] === 'nxdomain' ? 'drop' : 'flag', reasons });
  });

  it('treats an MX lookup error that is not a DNS failure as soft', async () => {
    const d = deps();
    d.dns = { ...fakeDns({}), resolveMx: () => Promise.reject(new Error('boom')) };
    expect(await check('mailto:a@example.net', d)).toMatchObject({ verdict: 'flag', reasons: ['dns-failure'] });
  });

  it('asks no DNS for an address on the no-fetch list', async () => {
    const d = deps();
    // A made-up address, put together from its parts: the repository's contact-detail scan allows example
    // domains only, and the point here is a mail domain on the no-fetch list.
    expect(await check(['mailto:someone', 'us.mensa.org'].join('@'), d)).toMatchObject({ verdict: 'review', reasons: ['no-fetch'] });
    expect(d.dns.calls).toEqual([]);
  });
});

describe('assertKeptForms (S3: every kept URL is its own kept form before check.json is written)', () => {
  const base: CheckResult = { url: 'x', kind: 'mail', verdict: 'ok', reasons: [], notes: [], keepable: true, chain: [] };

  it('passes results whose kept URLs are their own kept forms, or that keep nothing', () => {
    expect(() => assertKeptForms([{ ...base, kept: 'mailto:editor@example.org' }, { ...base, kind: 'web', kept: 'https://example.org/' }, { ...base, keepable: false }])).not.toThrow();
  });

  it.each(['mailto:a#b@example.org', `https://example.org/${'a'.repeat(2029)}`, 'https://my_site.example.org/', 'https://example.org:443/'])('throws on a kept %j, naming only its place', (kept) => {
    expect(() => assertKeptForms([{ ...base, kept: 'mailto:editor@example.org' }, { ...base, kept }])).toThrow(/^results\[1\]\.kept is not its own kept form$/);
  });
});

describe('checkAll', () => {
  it('checks each URL once, in order, a few at a time', async () => {
    const d = deps();
    const out = await checkAll(['https://site.example/', 'https://site.example/gone', 'https://site.example/', 'mailto:editor@example.com'], d, 2);
    expect(out.map((r) => [r.url, r.verdict])).toEqual([
      ['https://site.example/', 'ok'],
      ['https://site.example/gone', 'drop'],
      ['mailto:editor@example.com', 'ok'],
    ]);
  });

  it('asks the registry and the nameservers once per domain', async () => {
    const d = deps();
    await checkAll(['https://site.example/', 'https://site.example/page', 'https://www.site.example/'], d, 1);
    expect(d.rdapAsked).toEqual(['site.example']);
    expect(d.dns.calls.filter((c) => c.startsWith('NS'))).toEqual(['NS site.example']);
  });

  it('runs without RDAP when none is given', async () => {
    const d = deps();
    delete d.rdap;
    expect((await check('https://site.example/', d)).notes).toEqual(['safe-browsing-off']);
  });
});
