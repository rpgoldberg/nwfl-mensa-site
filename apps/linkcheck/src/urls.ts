// ============================================================================
// A link's URL, read strictly (SPEC D1a, D4): https, http (which the check upgrades) and mailto only;
// at most 2048 characters; no control, bidi or zero-width characters; no credentials; ports 80 and
// 443 only. Hosts come out in ASCII (punycode) and IPv4 literals in dotted decimal, as the WHATWG URL
// parser normalizes them, so the address check sees 2130706433 and 0177.0.0.1 as the 127.0.0.1 they are.
//
// THE LINKS CONTRACT with the loader (L2; CONTRACT.md, pinned by test/fixtures/links-contract.json):
//   1. the canonical host: lower case, EVERY trailing dot stripped, an empty label refused, IDN in
//      punycode, for web and mail domains alike. Every hop is read by parseLink, so the no-fetch and
//      login-walled checks see the canonical host on the link and on each redirect; they also
//      normalize what they are given themselves;
//   2. a kept web link (parseKept, keptForm): https (http upgraded by the check), no userinfo (not even
//      an empty "@"), no port written (not even :80 or :443), no IP literal, no dotless host;
//   3. a kept mailto: exactly mailto:<one address>, its query and fragment dropped, the domain in
//      punycode and lower case, the local part plain atext and dots (no '#', '%' or '?': L2's MAILTO),
//      not starting with '/' (CONTRACT 10);
//   6. the kept host, or mail domain, is L2's HOST (DNS_NAME below), refused otherwise ('host-name');
//   7. a kept URL is at most 2048 characters, and is its own kept form (keptForm(kept) === kept).
// parseLink alone, without parseKept, is what a redirect hop may be (ports 80 and 443 allowed).
//
// The host lists:
//   - the NO-FETCH list (Binding additions, 11-04): us.mensa.org and everything under it (its members
//     paths cannot be told apart from the rest from here, so the whole tree is left alone), and the
//     registrable domains named myfigurecollection, suruga-ya, hobby-genki and vndb under any public
//     suffix. A link there gets "not checked: officer review" with no network request of any kind;
//   - the login-walled hosts: DNS only, never fetched; the editor confirms each link.
// ============================================================================
import { isIP } from 'node:net';
import { getDomain, parse } from 'tldts';

export const MAX_URL_LENGTH = 2048;

export type Kind = 'web' | 'mail';

export interface ParsedLink {
  kind: Kind;
  /** The URL as the WHATWG parser writes it. */
  url: string;
  /** The canonical host (ASCII, lower case, no trailing dot); an IPv6 literal without its brackets. For mail, the address's domain. */
  host: string;
  scheme: 'http' | 'https' | 'mailto';
  /** mailto only: the one address, its domain in ASCII. */
  address?: string;
}

export type LinkRefusal = 'too-long' | 'control' | 'malformed' | 'scheme' | 'credentials' | 'port';
/** What parseKept refuses besides: a host that is an IP literal, a dotless (local) name, or not a DNS name. */
export type KeptRefusal = LinkRefusal | 'ip-literal' | 'local-name' | 'host-name';
export type Parsed<R extends KeptRefusal = LinkRefusal> = { ok: true; link: ParsedLink } | { ok: false; reason: R };

// C0, DEL, C1, the bidi embeddings, overrides, isolates and marks, and the zero-width characters:
// refused in a URL, and replaced in anything shown. Written as escapes, never as the characters.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
export const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u;
export const CONTROLS = new RegExp(CONTROL.source, 'gu');
const ALLOWED_PORTS = new Set(['', '80', '443']);

const refuse = <R extends KeptRefusal>(reason: R): Parsed<R> => ({ ok: false, reason });

/** A host lower-cased with every trailing dot stripped, by a linear scan. */
function lowerNoDots(host: string): string {
  let end = host.length;
  while (end > 0 && host.charCodeAt(end - 1) === 0x2e) end -= 1;
  return host.slice(0, end).toLowerCase();
}

/** The canonical host (CONTRACT 1): lower case, every trailing dot stripped; undefined when a label is empty. */
export function canonicalHost(host: string): string | undefined {
  const out = lowerNoDots(host);
  return out === '' || out.split('.').includes('') ? undefined : out;
}

/**
 * atext and dots (RFC 5322) without '%', '#' and '?', which a mail client reads as an escape, a fragment or a
 * query: L2's MAILTO class exactly. Nor a leading '/' (CONTRACT 10): the URL parser reads mailto:// as an
 * authority and dot-segment-normalises a mailto:/ path, so the address kept would not be the one written.
 */
const LOCAL_PART = /^[A-Za-z0-9.!$&'*+=^_`{|}~-][A-Za-z0-9.!$&'*+/=^_`{|}~-]*$/;

/**
 * A host by its DNS name, as L2 and the 0024 pdf_link_host CHECK keep it (CONTRACT 6; the same regex as
 * L2's HOST): two labels or more, each 1 to 63 of [a-z0-9-] with no hyphen at either end, the last
 * starting with a letter, 4 to 253 characters. Tested on the canonical host, so lower case is all it sees.
 */
export const DNS_NAME = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function parseMail(raw: string): Parsed {
  let address: string;
  try {
    address = decodeURIComponent(new URL(raw).pathname);
  } catch {
    return refuse('malformed');
  }
  const at = address.split('@');
  if (at.length !== 2) return refuse('malformed');
  const [local, domain] = at as [string, string];
  if (!LOCAL_PART.test(local) || !/^[^\s/?#:@[\]\\,;<>%]+$/u.test(domain)) return refuse('malformed');
  let host: string | undefined;
  try {
    host = canonicalHost(new URL(`http://${domain}`).hostname);
  } catch {
    return refuse('malformed');
  }
  if (host === undefined) return refuse('malformed');
  // Exactly mailto:<one address>: a query (?subject=, ?cc=, ...) or a fragment is dropped (CONTRACT 3).
  return { ok: true, link: { kind: 'mail', url: `mailto:${local}@${host}`, host, scheme: 'mailto', address: `${local}@${host}` } };
}

/** The input as parseLink reads it: trimmed, and a bare www. host given http. */
function prepared(input: string): string {
  const raw = input.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
  return /^www\./i.test(raw) ? `http://${raw}` : raw;
}

/** A link's or a redirect hop's URL, read strictly, or why it may not be (see parseKept for a link to keep). */
export function parseLink(input: string): Parsed {
  const raw = prepared(input);
  if (raw.length > MAX_URL_LENGTH) return refuse('too-long');
  if (CONTROL.test(raw)) return refuse('control');
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
  if (!url.hostname.startsWith('[')) {
    const canonical = canonicalHost(url.hostname);
    if (canonical === undefined) return refuse('malformed');
    url.hostname = canonical;
  }
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  return { ok: true, link: { kind: 'web', url: url.href, host, scheme } };
}

/** The authority as written (after the scheme and its slashes, up to the path, query or fragment). */
function writtenAuthority(raw: string): string {
  const rest = raw.replace(/^[a-z][a-z0-9+.-]*:[/\\]*/i, '');
  const end = rest.search(/[/\\?#]/);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * A link's URL read as a link may be KEPT (CONTRACT 2, 3, 6, 7): parseLink, then no userinfo or port
 * written, no IP literal, no dotless host, a host that is a DNS name, and a kept URL of at most 2048.
 */
export function parseKept(input: string): Parsed<KeptRefusal> {
  const parsed = parseLink(input);
  if (!parsed.ok) return parsed;
  const { link } = parsed;
  if (link.kind === 'web') {
    const authority = writtenAuthority(prepared(input));
    if (authority.includes('@')) return refuse('credentials');
    if (authority.slice(authority.lastIndexOf(']') + 1).includes(':')) return refuse('port');
  }
  if (isIP(link.host) !== 0) return refuse('ip-literal');
  if (!link.host.includes('.')) return refuse('local-name');
  if (!DNS_NAME.test(link.host)) return refuse('host-name');
  // The URL as written may be under 2048 and its kept form over it, once percent-encoded.
  if (keptUrl(link).length > MAX_URL_LENGTH) return refuse('too-long');
  return parsed;
}

/** The URL a kept link carries: a web link's https form, or the mailto as parsed. */
export function keptUrl(link: ParsedLink): string {
  if (link.kind === 'mail') return link.url;
  const url = new URL(link.url);
  url.protocol = 'https:';
  return url.href;
}

/** The form the checker keeps for a link, or null when it is refused (the contract fixture's "out"). */
export function keptForm(input: string): string | null {
  const parsed = parseKept(input);
  return parsed.ok ? keptUrl(parsed.link) : null;
}

/** Whether `host` is `domain` or a name under it. */
export const hostIsUnder = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

/** The no-fetch list's registrable names, under any public suffix. */
const NO_FETCH_NAMES = new Set(['myfigurecollection', 'suruga-ya', 'hobby-genki', 'vndb']);
/** The no-fetch list's trees, whole. */
const NO_FETCH_TREES = ['us.mensa.org'];

/** Whether a host is on the no-fetch list: never requested, never even resolved. */
export function isNoFetch(given: string): boolean {
  // Normalized here as well (lower case, every trailing dot stripped): whatever a caller hands in.
  const host = lowerNoDots(given);
  if (NO_FETCH_TREES.some((tree) => hostIsUnder(host, tree))) return true;
  const name = parse(host).domainWithoutSuffix;
  return name !== null && NO_FETCH_NAMES.has(name);
}

/** Login-walled hosts (SPEC D4): resolved, never fetched; each link needs the editor's own yes. */
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

export const isLoginWalled = (given: string): boolean => {
  const host = lowerNoDots(given);
  return LOGIN_WALLED.some((domain) => hostIsUnder(host, domain));
};

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
