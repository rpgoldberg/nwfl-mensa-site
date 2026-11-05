// ============================================================================
// LINKS: an issue's approved links, as both loaders read and store them (the
// issue loader's nwfl-issue/2, load.ts, and the links command's nwfl-links/1,
// attach.ts). The checker (apps/linkcheck) writes the list off-cluster and
// Ross approves it by its hash; the server never reads a link from a PDF.
//
// A list is per file: { public: [...], members: [...] }. Each link is
//   id       26 lower-case base32 characters, minted at random by the checker
//            (N10: never derived). It is the only thing a copy will carry: its
//            annotation points to https://<origin>/out/<id> (L3), never to the
//            URL.
//   page     1-based, 1 to 10000.
//   rect     [x1, y1, x2, y2] in PDF user space, finite, within +-14400 (the
//            largest page a PDF allows), x1 < x2 and y1 < y2.
//   url      an https URL in its canonical form (WHATWG href: ASCII, the host
//            in punycode and lower case, a path, no credentials, no port), or
//            mailto:<address> with no query, its domain in lower-case
//            punycode. At most 2048 characters. A host (or a mail domain) is
//            a DNS name of two labels or more, each 1 to 63 letters, digits
//            and inner hyphens, the last starting with a letter: no IP
//            literal (v4, v6, decimal, octal or hex), no dotless name such as
//            localhost, no trailing dot, no empty label (CONTRACT items 1-3).
//            The checker writes exactly these forms (the shared fixture
//            test/load/fixtures/links-contract.json pins both parts); the
//            loader keeps nothing else, and rewrites nothing.
//   kind     web (https) or mail (mailto).
//   confirm  a login-walled host Ross confirmed by hand (Facebook and the
//            like); the leaving page says so.
// The host is never taken from the bundle: it is the url's (hostOf), and the
// database checks it against the url again (0024).
//
// linksSha256, the hash Ross approves: SHA-256 of canonicalJson (content/
// hash.ts: keys sorted at every depth, arrays in order) of
//   { v: 2, sha256: { public, members }, links: { public: [...], members: [...] } }
// with both files' sha256 (lower-case hex), each list sorted by id and each
// link exactly { confirm, id, kind, page, rect, url }. The checker computes
// the same hash over the same JSON. The file hashes bind the links to the
// issue they were approved for: both loaders take them from the stored
// originals, so links approved for one issue never attach to another
// (CONTRACT item 4).
//
// A link whose URL holds one of the issue's own withheld quotes (a mark in a
// category the public policy does not show) is refused, before anything is
// attached (CONTRACT item 5; targetHolds names the forms). L3 and L4 check
// targets again when a copy is made and when a link is followed.
// ============================================================================
import { createHash } from 'node:crypto';
import { domainToUnicode } from 'node:url';
import { canonicalJson } from '../content/hash.js';
import type { Db } from '../db/pool.js';
import { TENANT, cellKey, resolveAction } from '../redaction/policy.js';
import { policyCells } from '../redaction/lens.js';
import { type Json, LoadError, known, object, own, wholeNumber } from './input.js';

export const MAX_LINKS_PER_FILE = 500;
export const MAX_URL_LENGTH = 2048;
export const MAX_PAGE = 10_000;
/** PDF's largest page, in points (ISO 32000 Annex C); a rect is never farther from the origin. */
export const MAX_COORDINATE = 14_400;
export const LINK_ID = /^[a-z2-7]{26}$/;

export type LinkKind = 'web' | 'mail';
export type Rect = readonly [number, number, number, number];

export interface Link {
  id: string;
  page: number;
  rect: Rect;
  url: string;
  kind: LinkKind;
  confirm: boolean;
}

export interface IssueLinks {
  public: Link[];
  members: Link[];
}

export const LINK_FILES = ['public', 'members'] as const;

type Query = Pick<Db, 'query'>;

/** Printable ASCII, no space: what a canonical href or a plain mailto holds. */
const PRINTABLE = /^[!-~]+$/;
/**
 * A host as both loaders and the database keep it (0024 pdf_link_host): two labels or more, each 1 to
 * 63 lower-case letters, digits and inner hyphens, the last starting with a letter, so never an IP
 * literal in any form, a dotless name, a trailing dot or an empty label. At most 253 characters.
 */
const HOST = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** mailto:local@domain: one address, no query or fragment, the domain a HOST; no # or % in the local part, which a mail client would read as a fragment or an escape. */
const MAILTO = /^mailto:[A-Za-z0-9.!$&'*+/=^_`{|}~-]+@([^@]+)$/;

function rectOf(value: unknown, where: string): Rect {
  const bad = (): LoadError => new LoadError(`${where} must be [x1, y1, x2, y2]: four finite numbers within ${MAX_COORDINATE} of 0, with x1 < x2 and y1 < y2`);
  if (!Array.isArray(value) || value.length !== 4) throw bad();
  if (!value.every((n): n is number => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= MAX_COORDINATE)) throw bad();
  const [x1, y1, x2, y2] = value as [number, number, number, number];
  if (!(x1 < x2 && y1 < y2)) throw bad();
  return [x1, y1, x2, y2];
}

function webUrl(url: string, where: string): string {
  const bad = (): LoadError => new LoadError(`${where} must be an https URL in its canonical form, with no credentials or port`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw bad();
  }
  if (parsed.href !== url || parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || parsed.port !== '') throw bad();
  if (!HOST.test(parsed.hostname)) throw new LoadError(`${where} must name a host by its DNS name, in lower case: no IP address, dotless name, trailing dot or empty label`);
  return url;
}

function urlOf(value: unknown, kind: LinkKind, where: string): string {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH || !PRINTABLE.test(value)) {
    throw new LoadError(`${where} must be at most ${MAX_URL_LENGTH} printable ASCII characters`);
  }
  if (kind === 'web') return webUrl(value, where);
  const domain = MAILTO.exec(value)?.[1];
  if (domain === undefined || !HOST.test(domain)) throw new LoadError(`${where} must be mailto: and one address, with no query, at a DNS name in lower case`);
  return value;
}

function linkOf(value: unknown, where: string): Link {
  const json = object(value, where);
  known(json, where, ['id', 'page', 'rect', 'url', 'kind', 'confirm']);
  const id = own(json, 'id');
  if (typeof id !== 'string' || !LINK_ID.test(id)) throw new LoadError(`${where}.id must be 26 lower-case base32 characters`);
  const page = wholeNumber(own(json, 'page'), `${where}.page`, MAX_PAGE);
  const rect = rectOf(own(json, 'rect'), `${where}.rect`);
  const kind = own(json, 'kind');
  if (kind !== 'web' && kind !== 'mail') throw new LoadError(`${where}.kind must be web or mail`);
  const url = urlOf(own(json, 'url'), kind, `${where}.url`);
  const confirm = own(json, 'confirm');
  if (typeof confirm !== 'boolean') throw new LoadError(`${where}.confirm must be true or false`);
  return { id, page, rect, url, kind, confirm };
}

/** The approved links of both files, checked whole: every id once across both. */
export function parseLinks(value: unknown, where = 'links'): IssueLinks {
  const json: Json = object(value, where);
  known(json, where, LINK_FILES);
  const seen = new Set<string>();
  const list = (file: (typeof LINK_FILES)[number]): Link[] => {
    const entries = own(json, file);
    if (!Array.isArray(entries)) throw new LoadError(`${where}.${file} must be a list`);
    if (entries.length > MAX_LINKS_PER_FILE) throw new LoadError(`${where}.${file} holds at most ${MAX_LINKS_PER_FILE} links`);
    return entries.map((entry, n) => {
      const link = linkOf(entry, `${where}.${file}[${n}]`);
      if (seen.has(link.id)) throw new LoadError(`${where}.${file}[${n}]: the id is used twice`);
      seen.add(link.id);
      return link;
    });
  };
  return { public: list('public'), members: list('members') };
}

/** The host the leaving page names: a web link's, in ASCII (punycode); a mail link's domain, in lower case. */
export function hostOf(link: Pick<Link, 'url' | 'kind'>): string {
  return link.kind === 'web' ? new URL(link.url).hostname : (link.url.slice(link.url.lastIndexOf('@') + 1)).toLowerCase();
}

const canonicalLink = (link: Link) => ({ confirm: link.confirm, id: link.id, kind: link.kind, page: link.page, rect: [...link.rect], url: link.url });
// Ids are unique across both lists (parseLinks; pdf_link's key), so no two compare equal.
const byId = (list: readonly Link[]) => [...list].sort((a, b) => (a.id < b.id ? -1 : 1)).map(canonicalLink);

/** Both files' sha256, lower-case hex: what the links hash binds the links to. */
export interface FileHashes {
  public: string;
  members: string;
}

/** The links' hash, as Ross approves it (see the header): over the links and the two files they were approved for. */
export function linksSha256(files: FileHashes, links: IssueLinks): string {
  return createHash('sha256')
    .update(canonicalJson({ v: 2, sha256: { public: files.public, members: files.members }, links: { public: byId(links.public), members: byId(links.members) } }))
    .digest('hex');
}

/** Every %XX escape decoded, as UTF-8 where it is (a stray % is kept as it is). */
function percentDecoded(text: string): string {
  return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => Buffer.from(run.replace(/%/g, ''), 'hex').toString('utf8'));
}

/** The separators a URL (or a reader) puts between the words of a quote. */
const SEPARATORS = /[\s._\-+/@?=&:#,;~!*'()[\]%]+/gu;
const spaced = (text: string): string => text.replace(SEPARATORS, ' ').trim();
const joined = (text: string): string => text.replace(SEPARATORS, '');
const folded = (text: string): string => text.normalize('NFKC').toLowerCase();

/**
 * Whether a URL holds any of the quotes, in any form a reader or a server could decode it to: the URL
 * as written, percent-decoded (up to three times, for %25-escaped escapes), with its host or mail
 * domain in Unicode (from punycode), all lower-cased; then each form with the separators
 * (. _ - + / @ ? = & and the like) turned into spaces, and with them taken out, against the quote
 * treated the same way, so "Quillon Brask" is found in quillon.brask and quillonbrask.
 */
export function targetHolds(url: string, quotes: readonly string[]): boolean {
  const forms = new Set<string>([url]);
  let decoded = url;
  for (let n = 0; n < 3; n++) forms.add((decoded = percentDecoded(decoded)));
  for (const form of [...forms]) {
    // The host of a web form, or the domain of a mail form: whatever follows // or the last @, up to the path.
    const host = /^[a-z]+:(?:\/\/)?(?:[^/?#]*@)?([^/?#@]+)/i.exec(form)?.[1] ?? '';
    forms.add(form.replace(host, domainToUnicode(host.toLowerCase()) || host));
  }
  const haystacks = [...forms].map(folded).flatMap((form) => [form, spaced(form), joined(form)]);
  return quotes.some((quote) => {
    const needle = folded(quote);
    const needles = [needle, spaced(needle), joined(needle)].filter((form) => form !== '');
    return haystacks.some((haystack) => needles.some((form) => haystack.includes(form)));
  });
}

/** Refuses the first link whose URL holds one of the quotes, by its place: never its URL or the quote. */
export function refuseWithheldTargets(links: IssueLinks, quotes: readonly string[], where = 'links'): void {
  for (const file of LINK_FILES) {
    const at = links[file].findIndex((link) => targetHolds(link.url, quotes));
    if (at >= 0) throw new LoadError(`${where}.${file}[${at}]: its target holds a passage the public policy withholds`);
  }
}

/** The quotes of an item's active marks whose category the public policy does not show, as they stand in this transaction. */
export async function withheldQuotes(db: Query, itemId: string): Promise<string[]> {
  const [cells, marks] = await Promise.all([
    policyCells(db, 'public'),
    db.query<{ quote: string; category: string }>(`SELECT quote, category FROM redaction_mark WHERE tenant_id = $1 AND content_item_id = $2 AND status = 'active' AND quote IS NOT NULL`, [TENANT, itemId]),
  ]);
  const policy = new Map(cells.map((cell) => [cellKey('public', cell.category), cell.action]));
  return marks.rows.filter((mark) => resolveAction(policy, 'public', mark.category) !== 'show').map((mark) => mark.quote);
}


/** Attaches one file's links through pdf_links_attach (0024), as the loader; the database checks the rest. */
export async function attachLinks(db: Query, input: { fileId: string; links: readonly Link[]; reference: string; linksSha256: string; sub: string }): Promise<number> {
  const rows = input.links.map((link) => ({ ...canonicalLink(link), host: hostOf(link) }));
  const result = await db.query<{ n: number }>(`SELECT pdf_links_attach($1, $2::jsonb, $3, $4, $5, NULL) AS n`, [
    input.fileId,
    JSON.stringify(rows),
    input.reference,
    Buffer.from(input.linksSha256, 'hex'),
    input.sub,
  ]);
  return (result.rows[0] as { n: number }).n;
}

export interface StoredLinks {
  links: IssueLinks;
  /** Each distinct approval the stored links were attached under: reference and links sha256 (hex). */
  approvals: Array<{ reference: string; linksSha256: string }>;
}

/** The links attached to an issue's two files, in any status: what was approved, never what is active now. */
export async function storedLinks(db: Query, files: { public: string; members: string }): Promise<StoredLinks> {
  const { rows } = await db.query<{ file_id: string; id: string; page: number; rect: number[]; url: string; kind: LinkKind; confirm: boolean; approval_reference: string; links_sha256: Buffer }>(
    `SELECT file_id, id, page, rect, url, kind, confirm, approval_reference, links_sha256 FROM pdf_link WHERE file_id = ANY($1::uuid[]) ORDER BY id`,
    [[files.public, files.members]],
  );
  const of = (fileId: string): Link[] =>
    rows.filter((row) => row.file_id === fileId).map((row) => ({ id: row.id, page: row.page, rect: row.rect as unknown as Rect, url: row.url, kind: row.kind, confirm: row.confirm }));
  const approvals = new Map(rows.map((row) => [`${row.approval_reference}:${row.links_sha256.toString('hex')}`, { reference: row.approval_reference, linksSha256: row.links_sha256.toString('hex') }]));
  return { links: { public: of(files.public), members: of(files.members) }, approvals: [...approvals.values()] };
}

/** Whether any link was ever attached to either file. */
export const hasLinks = (stored: StoredLinks): boolean => stored.links.public.length + stored.links.members.length > 0;
