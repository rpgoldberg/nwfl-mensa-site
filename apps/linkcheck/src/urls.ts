// ============================================================================
// A link's URL, read strictly (SPEC D1a, D4): https, http (which the check upgrades) and mailto only;
// at most 2048 characters; no control, bidi or zero-width characters; no credentials; ports 80 and
// 443 only. Hosts come out in ASCII (punycode, lower case, no trailing dot) and IPv4 literals in
// dotted decimal, as the WHATWG URL parser normalizes them, so the address check sees 2130706433 and
// 0177.0.0.1 as the 127.0.0.1 they are.
//
// The host lists:
//   - the NO-FETCH list (Binding additions, 11-04): us.mensa.org and everything under it (its members
//     paths cannot be told apart from the rest from here, so the whole tree is left alone), and the
//     registrable domains named myfigurecollection, suruga-ya, hobby-genki and vndb under any public
//     suffix. A link there gets "not checked: officer review" with no network request of any kind;
//   - the login-walled hosts: DNS only, never fetched; Ross confirms each link himself.
// ============================================================================
import { getDomain, parse } from 'tldts';

export const MAX_URL_LENGTH = 2048;

export type Kind = 'web' | 'mail';

export interface ParsedLink {
  kind: Kind;
  /** The URL as the WHATWG parser writes it. */
  url: string;
  /** ASCII, lower case, no trailing dot; an IPv6 literal without its brackets. For mail, the address's domain. */
  host: string;
  scheme: 'http' | 'https' | 'mailto';
  /** mailto only: the one address, its domain in ASCII. */
  address?: string;
}

export type LinkRefusal = 'too-long' | 'control' | 'malformed' | 'scheme' | 'credentials' | 'port';
export type Parsed = { ok: true; link: ParsedLink } | { ok: false; reason: LinkRefusal };

// C0, DEL, C1, the bidi embeddings, overrides, isolates and marks, and the zero-width characters:
// refused in a URL, and replaced in anything shown. Written as escapes, never as the characters.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
export const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u;
export const CONTROLS = new RegExp(CONTROL.source, 'gu');
const ALLOWED_PORTS = new Set(['', '80', '443']);

const refuse = (reason: LinkRefusal): Parsed => ({ ok: false, reason });

function parseMail(raw: string): Parsed {
  let url: URL;
  let address: string;
  try {
    url = new URL(raw);
    address = decodeURIComponent(url.pathname);
  } catch {
    return refuse('malformed');
  }
  const at = address.split('@');
  if (at.length !== 2) return refuse('malformed');
  const [local, domain] = at as [string, string];
  if (local === '' || /[\s,;<>]/u.test(local) || !/^[^\s/?#:@[\]\\,;<>%]+$/u.test(domain)) return refuse('malformed');
  let host: string;
  try {
    host = new URL(`http://${domain}`).hostname.replace(/\.$/, '');
  } catch {
    return refuse('malformed');
  }
  return { ok: true, link: { kind: 'mail', url: url.href, host, scheme: 'mailto', address: `${local}@${host}` } };
}

/** A link's URL, read as a link may be kept, or why it may not. */
export function parseLink(input: string): Parsed {
  let raw = input.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
  if (raw.length > MAX_URL_LENGTH) return refuse('too-long');
  if (CONTROL.test(raw)) return refuse('control');
  if (/^www\./i.test(raw)) raw = `http://${raw}`;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw)?.[1]?.toLowerCase();
  if (scheme === undefined) return refuse('malformed');
  if (scheme === 'mailto') return parseMail(raw);
  if (scheme !== 'http' && scheme !== 'https') return refuse('scheme');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse('malformed');
  }
  if (url.username !== '' || url.password !== '') return refuse('credentials');
  if (!ALLOWED_PORTS.has(url.port)) return refuse('port');
  if (url.hostname.endsWith('.')) url.hostname = url.hostname.slice(0, -1);
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  return { ok: true, link: { kind: 'web', url: url.href, host, scheme } };
}

/** Whether `host` is `domain` or a name under it. */
export const hostIsUnder = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

/** The no-fetch list's registrable names, under any public suffix. */
const NO_FETCH_NAMES = new Set(['myfigurecollection', 'suruga-ya', 'hobby-genki', 'vndb']);
/** The no-fetch list's trees, whole. */
const NO_FETCH_TREES = ['us.mensa.org'];

/** Whether a host is on the no-fetch list: never requested, never even resolved. */
export function isNoFetch(host: string): boolean {
  if (NO_FETCH_TREES.some((tree) => hostIsUnder(host, tree))) return true;
  const name = parse(host).domainWithoutSuffix;
  return name !== null && NO_FETCH_NAMES.has(name);
}

/** Login-walled hosts (SPEC D4): resolved, never fetched; each link needs Ross's own yes. */
export const LOGIN_WALLED: readonly string[] = [
  'facebook.com',
  'fb.com',
  'fb.me',
  'fb.watch',
  'messenger.com',
  'instagram.com',
  'instagr.am',
  'linkedin.com',
  'lnkd.in',
  'x.com',
  'twitter.com',
  't.co',
  'nextdoor.com',
];

export const isLoginWalled = (host: string): boolean => LOGIN_WALLED.some((domain) => hostIsUnder(host, domain));

/** The registrable domain by the Public Suffix List, private suffixes included (one.github.io is its own); else the host. */
export const registrableDomain = (host: string): string => getDomain(host, { allowPrivateDomains: true }) ?? host;

/** A URL found in text without its trailing sentence punctuation (a closing bracket only when unbalanced). */
export function trimTrailing(url: string): string {
  let out = url;
  for (;;) {
    const last = out.at(-1);
    if (last === undefined) return out;
    if (/[.,;:!?'"]/.test(last)) out = out.slice(0, -1);
    else if (last === ')' && (out.match(/\(/g) ?? []).length < (out.match(/\)/g) ?? []).length) out = out.slice(0, -1);
    else if (last === ']' && (out.match(/\[/g) ?? []).length < (out.match(/\]/g) ?? []).length) out = out.slice(0, -1);
    else return out;
  }
}
