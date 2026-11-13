// LINKS L4 (SPEC D3): the leaving page /out/<id>. A link in our PDF copies points here by an opaque
// id, never by its URL, so no URL ever travels in a query (no open redirect). The API answers only
// for an approved link in the copy the reader is served now (ContentService.GetLinkTarget); this
// module checks that answer's shape once more before a byte of it is rendered (SPEC section 7:
// refused at load and again at render), then decides what the page does with the reader's
// "next time" choice (server/prefs.mjs, the __Host-nwfl-links cookie):
//   guard      the default: the page, waiting for a press on Continue (a new tab);
//   countdown  the page, which continues in this tab after 5 seconds unless Stop is pressed
//              (public/scripts/out.js; with no script it is the guard);
//   direct     a 303 to the URL (no referrer, never stored).
// A mail link always shows the page, as does the page just after the reader saved a choice. A
// link turned off shows that it was, with its date and the way back, never its URL.
import type { LinkMode } from '../../server/prefs.mjs';
import type { LinkRead } from './api/client';

export type { LinkRead } from './api/client';

/** A link id as the copies carry it: 26 lower-case base32 characters (0024 pdf_link.id). */
export const LINK_ID = /^[a-z2-7]{26}$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** CONTRACT items 1, 2 and 6: a DNS name in lower-case ASCII, two labels or more, the last starting with a letter. */
const HOST = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** CONTRACT items 3, 7 and 10: one address, no query, its local part not starting with '/'. */
const MAILTO = /^mailto:[A-Za-z0-9.!$&'*+=^_`{|}~-][A-Za-z0-9.!$&'*+/=^_`{|}~-]*@([^@]+)$/;
const PRINTABLE = /^[!-~]+$/;
const MAX_URL = 2048;
const MAX_PAGE = 10_000;

/** The login-walled sites the checker knows (SPEC D4), by registrable domain, as a reader knows them. */
const LOGIN_WALLED: ReadonlyArray<readonly [string, string]> = [
  ['facebook.com', 'Facebook'],
  ['instagram.com', 'Instagram'],
  ['linkedin.com', 'LinkedIn'],
  ['x.com', 'X'],
  ['twitter.com', 'X'],
  ['nextdoor.com', 'Nextdoor'],
];

/** The site's name for a login-walled host, on the domain itself or a host under it; undefined otherwise. */
export function loginWalledSite(host: string): string | undefined {
  return LOGIN_WALLED.find(([domain]) => host === domain || host.endsWith(`.${domain}`))?.[1];
}

const placeOk = (fileId: string, page: number): boolean => UUID.test(fileId) && Number.isInteger(page) && page >= 1 && page <= MAX_PAGE;

function webOk(url: string, host: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' && parsed.port === '' && parsed.hostname === host && parsed.href === url;
}

/** The API's answer as the page may render it; anything off its shape is not found. */
export function safeLink(read: LinkRead): LinkRead {
  if (read.kind === 'not_found') return read;
  if (!placeOk(read.fileId, read.page)) return { kind: 'not_found' };
  if (read.kind === 'disabled') return read;
  const { url, host } = read;
  if (url.length > MAX_URL || !PRINTABLE.test(url) || !HOST.test(host)) return { kind: 'not_found' };
  const ok = read.mail ? MAILTO.exec(url)?.[1] === host : webOk(url, host);
  return ok ? read : { kind: 'not_found' };
}

/** Back to the newsletter: the issue read in the site (PDFVIEW, /read/<id>), at the page the link was on. */
export function backHref(fileId: string, page: number): string {
  return `/read/${fileId}#page=${page}`;
}

const DATE = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: 'long', day: 'numeric' });
const dateText = (at: Date | undefined): string | undefined => (at === undefined ? undefined : DATE.format(at));

export type OutView =
  | { kind: 'redirect'; location: string }
  | { kind: 'not_found' }
  | { kind: 'disabled'; date: string | undefined; back: string; mode: LinkMode }
  | {
      kind: 'leave';
      url: string;
      /** In ASCII (punycode), so a look-alike name cannot pose as another. */
      host: string;
      mail: boolean;
      /** A mail link's address. */
      address?: string;
      /** A login-walled site's name (or its host), for a link the editor confirmed by hand. */
      loginWalled?: string;
      checked: string | undefined;
      back: string;
      countdown: boolean;
      mode: LinkMode;
      /** The reader has just saved a choice for next time. */
      saved?: true;
    };

/** What the page does for this answer and this choice. */
export function outView(given: LinkRead, mode: LinkMode, { saved = false }: { saved?: boolean } = {}): OutView {
  const read = safeLink(given);
  if (read.kind === 'not_found') return read;
  if (read.kind === 'disabled') return { kind: 'disabled', date: dateText(read.at), back: backHref(read.fileId, read.page), mode };
  if (!read.mail && !saved && mode === 'direct') return { kind: 'redirect', location: read.url };
  return {
    kind: 'leave',
    url: read.url,
    host: read.host,
    mail: read.mail,
    ...(read.mail ? { address: read.url.slice('mailto:'.length) } : {}),
    ...(read.confirm ? { loginWalled: loginWalledSite(read.host) ?? read.host } : {}),
    checked: dateText(read.checkedAt),
    back: backHref(read.fileId, read.page),
    countdown: !read.mail && !saved && mode === 'countdown',
    mode,
    ...(saved ? { saved: true as const } : {}),
  };
}
