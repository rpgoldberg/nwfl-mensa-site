import { describe, expect, it } from 'vitest';
import { hostIsUnder, isLoginWalled, isNoFetch, parseLink, registrableDomain, trimTrailing } from '../src/urls.js';

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

  it('reads a mailto with one address and its ASCII domain', () => {
    expect(parseLink('mailto:Editor@Example.org?subject=Hi')).toEqual({
      ok: true,
      link: { kind: 'mail', url: 'mailto:Editor@Example.org?subject=Hi', host: 'example.org', scheme: 'mailto', address: 'Editor@example.org' },
    });
    expect(parseLink('mailto:a%40b@example.com')).toEqual({ ok: false, reason: 'malformed' });
    expect(parseLink('mailto:one@example.com,two@example.com')).toEqual({ ok: false, reason: 'malformed' });
    expect(parseLink('mailto:no-at-sign')).toEqual({ ok: false, reason: 'malformed' });
    expect(parseLink('mailto:x@exa mple.com')).toEqual({ ok: false, reason: 'malformed' });
    expect(parseLink('mailto:x@')).toEqual({ ok: false, reason: 'malformed' });
    expect(parseLink('mailto:%E0%A4%A@example.com')).toEqual({ ok: false, reason: 'malformed' });
    expect(parseLink('mailto:x@a^b.com')).toEqual({ ok: false, reason: 'malformed' });
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
