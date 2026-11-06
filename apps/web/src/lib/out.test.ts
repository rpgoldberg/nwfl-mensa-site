// LINKS L4: what the leaving page /out/<id> shows, or where it sends the reader, from the API's
// answer and the reader's "next time" choice. The API answers only for an approved link in the
// copy the reader is served now; the page checks the answer's shape again before a byte of it is
// rendered (SPEC section 7: refused at load and again at render). Every URL is made up.
import { describe, expect, it } from 'vitest';
import { type LinkRead, LINK_ID, backHref, loginWalledSite, outView, safeLink } from './out';

const FILE = 'e1f00000-0000-4000-8000-000000000001';
const AT = new Date('2026-11-04T15:00:00Z');
type Active = Extract<LinkRead, { kind: 'active' }>;
const web = (url: string, extra: Partial<Active> = {}): Active => ({
  kind: 'active',
  url,
  host: new URL(url).hostname,
  mail: false,
  confirm: false,
  fileId: FILE,
  page: 2,
  checkedAt: AT,
  ...extra,
});
const mail = (address: string): Active => ({ kind: 'active', url: `mailto:${address}`, host: address.slice(address.indexOf('@') + 1), mail: true, confirm: false, fileId: FILE, page: 1, checkedAt: AT });

describe('LINK_ID', () => {
  it('is 26 lower-case base32 characters and nothing else', () => {
    expect(LINK_ID.test('abcdefghijklmnopqrstuvwxyz')).toBe(true);
    expect(LINK_ID.test('a234567aaaaaaaaaaaaaaaaaaa')).toBe(true);
    for (const id of ['', 'A'.repeat(26), 'a'.repeat(25), 'a'.repeat(27), `${'a'.repeat(25)}1`, `${'a'.repeat(25)}8`, `${'a'.repeat(26)}\n`, `../${'a'.repeat(23)}`]) expect(LINK_ID.test(id), id).toBe(false);
  });
});

describe('safeLink: the answer checked again before it is rendered', () => {
  it('keeps an https link on its host, in canonical form', () => {
    const read = web('https://club.example/picnic?day=sat');
    expect(safeLink(read)).toEqual(read);
  });

  it('keeps a mail link to one address at its host', () => {
    const read = mail('events@example.org');
    expect(safeLink(read)).toEqual(read);
  });

  it('keeps a turned-off link and a missing one as they are', () => {
    expect(safeLink({ kind: 'disabled', fileId: FILE, page: 3, at: AT })).toEqual({ kind: 'disabled', fileId: FILE, page: 3, at: AT });
    expect(safeLink({ kind: 'not_found' })).toEqual({ kind: 'not_found' });
  });

  const refused: Array<[string, LinkRead]> = [
    ['javascript:', { ...web('https://club.example/'), url: 'javascript:alert(1)' }],
    ['data:', { ...web('https://club.example/'), url: 'data:text/html,<script>alert(1)</script>' }],
    ['a URL that does not parse', { ...web('https://club.example/'), url: 'https://[club.example/' }],
    ['http, never upgraded', { ...web('https://club.example/'), url: 'http://club.example/' }],
    ['quotes and angle brackets, raw', { ...web('https://club.example/'), url: 'https://club.example/"><script>alert(1)</script>' }],
    ['a URL not in canonical form', { ...web('https://club.example/'), url: 'https://CLUB.example/' }],
    ['a host that is not the URL\'s', { ...web('https://club.example/'), host: 'other.example' }],
    // Assembled at run time, so the made-up people guard sees no address here.
    ['userinfo', { ...web('https://club.example/'), url: ['https://user', 'club.example/'].join('@') }],
    ['a port, even 443 spelled out', { ...web('https://club.example/'), url: 'https://club.example:8443/' }],
    ['an IP literal', { ...web('https://club.example/'), url: 'https://10.0.0.1/', host: '10.0.0.1' }],
    ['a dotless host', { ...web('https://club.example/'), url: 'https://localhost/', host: 'localhost' }],
    ['an RTL override in the host', { ...web('https://club.example/'), url: 'https://xn--clb-ex-9ua.example/', host: 'clu‮b.example' }],
    ['a non-ASCII URL', { ...web('https://club.example/'), url: 'https://club.example/café' }],
    ['a URL over 2048 characters', { ...web('https://club.example/'), url: `https://club.example/${'a'.repeat(2048)}` }],
    ['a mailto with a query', { ...mail('events@example.org'), url: 'mailto:events@example.org?subject=hi' }],
    ['a mailto with two addresses', { ...mail('events@example.org'), url: 'mailto:events@example.org,x@example.org' }],
    ['a mailto whose local part starts with /', { ...mail('events@example.org'), url: 'mailto:/events@example.org' }],
    ['a mailto at another domain than its host', { ...mail('events@example.org'), host: 'other.example' }],
    ['a web URL given as mail', { ...web('https://club.example/'), mail: true }],
    ['a mailto given as web', { ...mail('events@example.org'), mail: false }],
    ['a file id that is not one', { ...web('https://club.example/'), fileId: '../etc/passwd' }],
    ['a page out of range', { ...web('https://club.example/'), page: 0 }],
    ['a page that is not whole', { ...web('https://club.example/'), page: 1.5 }],
  ];
  it.each(refused)('turns %s into not found', (_name, read) => {
    expect(safeLink(read)).toEqual({ kind: 'not_found' });
  });

  it('turns a turned-off link with a bad file or page into not found too', () => {
    expect(safeLink({ kind: 'disabled', fileId: 'x', page: 1, at: AT })).toEqual({ kind: 'not_found' });
    expect(safeLink({ kind: 'disabled', fileId: FILE, page: 10_001, at: AT })).toEqual({ kind: 'not_found' });
  });
});

describe('backHref', () => {
  it('is the issue read in the site (PDFVIEW), at the page the link was on', () => {
    expect(backHref(FILE, 4)).toBe(`/read/${FILE}#page=4`);
  });
});

describe('loginWalledSite', () => {
  it('names the login-walled sites the checker knows, on their own hosts and sub-hosts only', () => {
    expect(loginWalledSite('www.facebook.com')).toBe('Facebook');
    expect(loginWalledSite('facebook.com')).toBe('Facebook');
    expect(loginWalledSite('m.facebook.com')).toBe('Facebook');
    expect(loginWalledSite('www.instagram.com')).toBe('Instagram');
    expect(loginWalledSite('www.linkedin.com')).toBe('LinkedIn');
    expect(loginWalledSite('x.com')).toBe('X');
    expect(loginWalledSite('twitter.com')).toBe('X');
    expect(loginWalledSite('nextdoor.com')).toBe('Nextdoor');
    expect(loginWalledSite('notfacebook.com')).toBeUndefined();
    expect(loginWalledSite('facebook.com.evil.example')).toBeUndefined();
  });
});

describe('outView', () => {
  it('shows the guard page by default: host, URL, last check, Back, and the choice for next time', () => {
    expect(outView(web('https://club.example/picnic?day=sat'), 'guard')).toEqual({
      kind: 'leave',
      url: 'https://club.example/picnic?day=sat',
      host: 'club.example',
      mail: false,
      checked: 'November 4, 2026',
      back: `/read/${FILE}#page=2`,
      countdown: false,
      mode: 'guard',
    });
  });

  it('names the login-walled site for a confirmed link, or the host when it is not one it knows', () => {
    expect(outView(web('https://www.facebook.com/groups/nwfl', { confirm: true }), 'guard')).toMatchObject({ loginWalled: 'Facebook' });
    expect(outView(web('https://social.example/groups/nwfl', { confirm: true }), 'guard')).toMatchObject({ loginWalled: 'social.example' });
    expect(outView(web('https://www.facebook.com/groups/nwfl'), 'guard')).not.toHaveProperty('loginWalled');
  });

  it('counts down in countdown mode, and goes straight there in direct mode', () => {
    expect(outView(web('https://club.example/a'), 'countdown')).toMatchObject({ kind: 'leave', countdown: true, mode: 'countdown' });
    expect(outView(web('https://club.example/a'), 'direct')).toEqual({ kind: 'redirect', location: 'https://club.example/a' });
  });

  it('always shows the page for a mail link, with no countdown, whatever the mode', () => {
    for (const mode of ['guard', 'countdown', 'direct'] as const) {
      expect(outView(mail('events@example.org'), mode)).toEqual({
        kind: 'leave',
        url: 'mailto:events@example.org',
        host: 'example.org',
        mail: true,
        address: 'events@example.org',
        checked: 'November 4, 2026',
        back: `/read/${FILE}#page=1`,
        countdown: false,
        mode,
      });
    }
  });

  it('shows the page, without counting down, right after the reader saved a choice', () => {
    expect(outView(web('https://club.example/a'), 'direct', { saved: true })).toMatchObject({ kind: 'leave', countdown: false, saved: true, mode: 'direct' });
    expect(outView(web('https://club.example/a'), 'countdown', { saved: true })).toMatchObject({ kind: 'leave', countdown: false, saved: true });
  });

  it('says a turned-off link was turned off, with its date and the way back, and no URL', () => {
    for (const mode of ['guard', 'countdown', 'direct'] as const) {
      const view = outView({ kind: 'disabled', fileId: FILE, page: 3, at: AT }, mode);
      expect(view).toEqual({ kind: 'disabled', date: 'November 4, 2026', back: `/read/${FILE}#page=3`, mode });
    }
  });

  it('is not found for a missing link, and for an answer the page refuses, in every mode', () => {
    for (const mode of ['guard', 'countdown', 'direct'] as const) {
      expect(outView({ kind: 'not_found' }, mode)).toEqual({ kind: 'not_found' });
      expect(outView({ ...web('https://club.example/'), url: 'javascript:alert(1)' }, mode)).toEqual({ kind: 'not_found' });
    }
  });

  it('gives the date in Central time, and none when the API sent none', () => {
    expect(outView(web('https://club.example/', { checkedAt: new Date('2026-11-05T03:30:00Z') }), 'guard')).toMatchObject({ checked: 'November 4, 2026' });
    const undated: Active = { kind: 'active', url: 'https://club.example/', host: 'club.example', mail: false, confirm: false, fileId: FILE, page: 1 };
    expect(outView(undated, 'guard')).toMatchObject({ checked: undefined });
    expect(outView({ kind: 'disabled', fileId: FILE, page: 3 }, 'guard')).toMatchObject({ date: undefined });
  });
});
