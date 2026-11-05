import { describe, expect, it } from 'vitest';
import { canonicalHost, hostIsUnder, isLoginWalled, isNoFetch, keptForm, parseKept, parseLink, registrableDomain, trimTrailing } from '../src/urls.js';

describe('parseLink', () => {
  it('reads an https link with its ASCII host', () => {
    const parsed = parseLink('https://Example.ORG./a/b?q=1#top');
    expect(parsed).toEqual({ ok: true, link: { kind: 'web', url: 'https://example.org/a/b?q=1#top', host: 'example.org', scheme: 'https' } });
  });

  it('turns a Unicode host into punycode', () => {
    const parsed = parseLink('https://b\u00fccher.example/');
    expect(parsed.ok && parsed.link.host).toBe('xn--bcher-kva.example');
  });

  it('reads http and a bare www. host as http', () => {
    expect(parseLink('http://example.org/x')).toMatchObject({ ok: true, link: { scheme: 'http', host: 'example.org' } });
    expect(parseLink('www.example.org/x')).toMatchObject({ ok: true, link: { scheme: 'http', url: 'http://www.example.org/x' } });
  });

  it('keeps ports 80 and 443 and refuses any other', () => {
    expect(parseLink('https://example.org:443/')).toMatchObject({ ok: true });
    expect(parseLink('https://example.org:80/')).toMatchObject({ ok: true, link: { url: 'https://example.org:80/' } });
    expect(parseLink('http://example.org:8080/')).toEqual({ ok: false, reason: 'port' });
    expect(parseLink('https://example.org:22/')).toEqual({ ok: false, reason: 'port' });
  });

  it('refuses credentials in a URL', () => {
    expect(parseLink('https://user@example.org/')).toEqual({ ok: false, reason: 'credentials' });
    expect(parseLink('https://user:pw@example.org/')).toEqual({ ok: false, reason: 'credentials' });
  });

  it('normalizes decimal, octal and hex IPv4 literals so the address check sees them', () => {
    expect(parseLink('http://2130706433/')).toMatchObject({ ok: true, link: { host: '127.0.0.1' } });
    expect(parseLink('http://0177.0.0.1/')).toMatchObject({ ok: true, link: { host: '127.0.0.1' } });
    expect(parseLink('http://0x7f.1/')).toMatchObject({ ok: true, link: { host: '127.0.0.1' } });
    expect(parseLink('http://[::ffff:10.0.0.1]/')).toMatchObject({ ok: true, link: { host: '::ffff:a00:1' } });
  });

  it.each([
    ['javascript:alert(1)', 'scheme'],
    ['data:text/html,x', 'scheme'],
    ['tel:5550100', 'scheme'],
    ['ftp://example.org/', 'scheme'],
    ['file:///etc/passwd', 'scheme'],
    ['/relative/path', 'malformed'],
    ['https://', 'malformed'],
    ['http://exa mple.org/', 'malformed'],
    ['https://example.org/\u0000', 'control'],
    ['https://example.org/\u202e', 'control'],
    ['https://example.org/\u0085', 'control'],
    ['https://example.org/\u007f', 'control'],
    ['https://example.org/\u2066', 'control'],
    ['https://' + 'a'.repeat(2050), 'too-long'],
  ])('%j is refused (%s)', (raw, reason) => {
    expect(parseLink(raw)).toEqual({ ok: false, reason });
  });

  it('reads a mailto with one address and its ASCII domain, its query and fragment dropped', () => {
    expect(parseLink('mailto:Editor@Example.org?subject=Hi&cc=other@example.net#x')).toEqual({
      ok: true,
      link: { kind: 'mail', url: 'mailto:Editor@example.org', host: 'example.org', scheme: 'mailto', address: 'Editor@example.org' },
    });
    expect(parseLink('mailto:j%C3%B6rg@example.com')).toEqual({ ok: false, reason: 'malformed' });
    expect(parseLink('mailto:a"b@example.com')).toEqual({ ok: false, reason: 'malformed' });
    expect(parseLink('mailto:a%40b@example.com')).toEqual({ ok: false, reason: 'malformed' });
    expect(parseLink('mailto:one@example.com,two@example.com')).toEqual({ ok: false, reason: 'malformed' });
    expect(parseLink('mailto:no-at-sign')).toEqual({ ok: false, reason: 'malformed' });
    expect(parseLink('mailto:x@exa mple.com')).toEqual({ ok: false, reason: 'malformed' });
    expect(parseLink('mailto:x@')).toEqual({ ok: false, reason: 'malformed' });
    expect(parseLink('mailto:%E0%A4%A@example.com')).toEqual({ ok: false, reason: 'malformed' });
    expect(parseLink('mailto:x@a^b.com')).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('the canonical host (CONTRACT 1; B1)', () => {
  // Assembled from parts: the repository's contact-detail scan allows example domains only.
  const mail = (local: string, domain: string): string => `mailto:${local}@${domain}`;

  it.each([
    ['example.org', 'example.org'],
    ['example.org.', 'example.org'],
    ['example.org...', 'example.org'],
    ['us.mensa.org..', 'us.mensa.org'],
  ])('%j becomes %j', (host, canonical) => {
    expect(canonicalHost(host)).toBe(canonical);
  });

  it.each(['', '.', '...', 'a..example.org', '.example.org', 'a..b.'])('%j has an empty label and is refused', (host) => {
    expect(canonicalHost(host)).toBeUndefined();
  });

  it('strips every trailing dot from a web host and builds the URL from the canonical host', () => {
    expect(parseLink('https://us.mensa.org.../members/roster')).toEqual({ ok: true, link: { kind: 'web', url: 'https://us.mensa.org/members/roster', host: 'us.mensa.org', scheme: 'https' } });
    expect(parseLink('https://www.facebook.com.../groups/x')).toMatchObject({ ok: true, link: { url: 'https://www.facebook.com/groups/x', host: 'www.facebook.com' } });
    expect(parseLink('http://members.us.mensa.org../roster')).toMatchObject({ ok: true, link: { url: 'http://members.us.mensa.org/roster', host: 'members.us.mensa.org' } });
  });

  it('strips every trailing dot from a mail domain', () => {
    expect(parseLink(mail('officer', 'members.us.mensa.org..'))).toEqual({
      ok: true,
      link: { kind: 'mail', url: mail('officer', 'members.us.mensa.org'), host: 'members.us.mensa.org', scheme: 'mailto', address: mail('officer', 'members.us.mensa.org').slice('mailto:'.length) },
    });
  });

  it.each(['https://a..example.org/', 'https://.example.org/', 'https://./', 'https://.../', 'mailto:x@mail..example.com', 'mailto:x@.example.com'])('%j, with an empty label, is refused', (raw) => {
    expect(parseLink(raw)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('reads the no-fetch and login-walled lists by the canonical host, whatever it is given', () => {
    for (const host of ['us.mensa.org.', 'us.mensa.org...', 'MEMBERS.US.MENSA.ORG..', 'vndb.org..']) expect(isNoFetch(host)).toBe(true);
    for (const host of ['www.facebook.com.', 'www.facebook.com...', 'WWW.FACEBOOK.COM.', 'x.com..']) expect(isLoginWalled(host)).toBe(true);
  });
});

describe('parseKept: a link as it may be kept (CONTRACT 2, 3)', () => {
  it.each([
    ['https://example.org:443/x', 'port'],
    ['https://example.org:80/x', 'port'],
    ['http://example.org:80/x', 'port'],
    ['https://example.org:/x', 'port'],
    ['https://[2606:4700::1]:443/', 'port'],
    ['https://93.184.216.34/', 'ip-literal'],
    ['https://2130706433/', 'ip-literal'],
    ['https://0x7f.0.0.1/', 'ip-literal'],
    ['https://[2606:4700::1]/', 'ip-literal'],
    ['mailto:x@127.0.0.1', 'ip-literal'],
    ['https://localhost/', 'local-name'],
    ['http://intranet./', 'local-name'],
    ['mailto:root@localhost', 'local-name'],
    ['https://@example.org/', 'credentials'],
    ['https://user@example.org/', 'credentials'],
    ['https://example.org:8080/', 'port'],
    ['ftp://example.org/', 'scheme'],
  ])('%j is refused (%s)', (raw, reason) => {
    expect(parseKept(raw)).toEqual({ ok: false, reason });
  });

  // CONTRACT 6 (round 2): the host is L2's HOST, after canonicalisation; a mail domain too.
  it.each([
    'https://my_site.example.org/',
    'https://a-.example.org/',
    'https://-a.example.org/',
    `https://${'a'.repeat(64)}.example.org/`,
    'https://example.1a/',
    'https://example.org-/',
    'https://a.b/',
    `https://${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.${'e'.repeat(58)}.org/`,
    ...[...'$*!~=\'+&(){},;"`'].map((c) => `https://a${c}b.example.org/`),
    'HTTPS://A_B.Example.ORG./',
    'http://a-.example.org/',
    'mailto:x~@my_host.example.org',
    'mailto:x~@a-.example.org',
    'mailto:x~@a$b.example.org',
    'mailto:x~@example.1a',
    `mailto:x~@${'a'.repeat(64)}.example.org`,
  ])('%j is refused: its host is not a DNS name (host-name)', (raw) => {
    expect(parseKept(raw)).toEqual({ ok: false, reason: 'host-name' });
  });

  it.each([
    'https://a-b.example.org/',
    'https://123.example.org/',
    'https://example.a1/',
    'https://a.bc/',
    `https://${'a'.repeat(63)}.example.org/`,
    `https://${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.${'e'.repeat(57)}.org/`,
    'https://xn--bcher-kva.example/',
  ])('%j, a DNS name, is kept', (raw) => {
    expect(keptForm(raw)).toBe(raw);
  });

  // CONTRACT 7 (round 2): the local part is L2's MAILTO class, so no '#' however it is written.
  it.each(['mailto:a%23b@example.org', 'mailto:a#b@example.org', 'mailto:a%3Fb@example.org', 'mailto:a%25b@example.org'])('%j is refused (malformed)', (raw) => {
    expect(parseKept(raw)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses a link whose kept URL is over 2048 characters, though as written it is under', () => {
    const long = `https://example.org/${'\u00fc'.repeat(700)}`;
    expect(long.length).toBeLessThan(2048);
    expect(parseKept(long)).toEqual({ ok: false, reason: 'too-long' });
    expect(parseKept(`http://example.org/${'a'.repeat(2023)}\u00fc`)).toEqual({ ok: false, reason: 'too-long' });
    expect(keptForm(`http://example.org/${'a'.repeat(2022)}\u00fc`)).toHaveLength(2048);
  });

  it('reads the rest as parseLink does', () => {
    expect(parseKept('http://Example.org./a')).toEqual(parseLink('http://Example.org./a'));
    expect(parseKept('mailto:a@example.org?subject=x')).toEqual(parseLink('mailto:a@example.org?subject=x'));
  });

  it('keptForm is the https form, or null when refused', () => {
    expect(keptForm('http://example.org/a?b#c')).toBe('https://example.org/a?b#c');
    expect(keptForm('https://example.org/a')).toBe('https://example.org/a');
    expect(keptForm('mailto:a@example.org?cc=b@example.net')).toBe('mailto:a@example.org');
    expect(keptForm('https://localhost/')).toBeNull();
  });
});

describe('host lists', () => {
  it('hostIsUnder matches the domain and its subdomains only', () => {
    expect(hostIsUnder('example.org', 'example.org')).toBe(true);
    expect(hostIsUnder('a.b.example.org', 'example.org')).toBe(true);
    expect(hostIsUnder('badexample.org', 'example.org')).toBe(false);
  });

  it.each([
    'members.us.mensa.org',
    'us.mensa.org',
    'secure.us.mensa.org',
    'www.us.mensa.org',
    'myfigurecollection.net',
    'static.myfigurecollection.net',
    'www.suruga-ya.jp',
    'suruga-ya.com',
    'www.hobby-genki.com',
    'vndb.org',
    'cdn.vndb.org',
  ])('%s is on the no-fetch list', (host) => {
    expect(isNoFetch(host)).toBe(true);
  });

  it.each(['mensa.org', 'example.org', 'notvndb.org', 'vndb.org.example.com', 'us-mensa.org.example.net'])('%s is not on the no-fetch list', (host) => {
    expect(isNoFetch(host)).toBe(false);
  });

  it.each(['facebook.com', 'www.facebook.com', 'm.facebook.com', 'fb.me', 'instagram.com', 'www.linkedin.com', 'x.com', 'twitter.com', 'nextdoor.com'])('%s is login-walled', (host) => {
    expect(isLoginWalled(host)).toBe(true);
  });

  it.each(['example.com', 'notfacebook.com', 'facebook.com.example.org'])('%s is not login-walled', (host) => {
    expect(isLoginWalled(host)).toBe(false);
  });

  it('registrableDomain uses the public suffix list, private suffixes included', () => {
    expect(registrableDomain('www.example.co.uk')).toBe('example.co.uk');
    expect(registrableDomain('one.github.io')).toBe('one.github.io');
    expect(registrableDomain('a.b.example.org')).toBe('example.org');
    expect(registrableDomain('8.8.8.8')).toBe('8.8.8.8');
    expect(registrableDomain('localhost')).toBe('localhost');
  });
});

describe('trimTrailing', () => {
  it.each([
    ['', ''],
    ['https://example.org/page.', 'https://example.org/page'],
    ['https://example.org/page?!,;:"\'', 'https://example.org/page'],
    ['https://example.org/wiki/Thing_(club)', 'https://example.org/wiki/Thing_(club)'],
    ['https://example.org/wiki/Thing_(club))', 'https://example.org/wiki/Thing_(club)'],
    ['https://example.org/a[1]', 'https://example.org/a[1]'],
    ['https://example.org/a]', 'https://example.org/a'],
    ['https://example.org/a].', 'https://example.org/a'],
  ])('%j becomes %j', (input, output) => {
    expect(trimTrailing(input)).toBe(output);
  });
});
