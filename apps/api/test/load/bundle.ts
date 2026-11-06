// Synthetic issue bundles for the loader's tests (MLOGIN S3). Every person,
// phone, address and email here is made up; no real newsletter is used.
import { createHash } from 'node:crypto';
import { type Mark, marksSha256 } from '../../src/load/load.js';
import { type IssueLinks, type Link, hostOf, linksSha256, targetHolds } from '../../src/load/links.js';
import { linkLabel, roundRect } from '../../src/pdf/link-annots.js';
import { inputHash } from '../../src/pdf/store.js';
import { linesPdf } from '../pdf/fixtures.js';

export const NAME = 'Quillon Brask';
export const PHONE = '850-555-0142';
export const ADDRESS = '12 Example Lane';
export const EMAIL = 'q.brask@example.org';
export const KEPT = 'Everyone is welcome.';
export const MEMBERS_ONLY = 'Members note: the board meets in Destin.';

export const MARKS: Mark[] = [
  { quote: NAME, category: 'member_name' },
  { quote: PHONE, category: 'member_phone' },
  { quote: ADDRESS, category: 'member_address' },
  { quote: EMAIL, category: 'member_email' },
];

const LINES = [`Game night host: ${NAME}`, `Rides: call ${PHONE} by Friday.`, `Potluck at ${ADDRESS} on Sunday.`, `Write to ${EMAIL} to join.`, KEPT];

export const sha256 = (bytes: Uint8Array): Buffer => createHash('sha256').update(bytes).digest();

/** The public PDF of an issue: the lines above, plus a label so each issue's bytes differ. */
export const publicPdf = (label: string): Promise<Uint8Array> => linesPdf([`Pensa Mensa ${label}`, ...LINES]);
/** The full (members) PDF: the same, plus a members-only line. */
export const membersPdf = (label: string): Promise<Uint8Array> => linesPdf([`Pensa Mensa ${label}`, ...LINES, MEMBERS_ONLY]);

/**
 * The categories the public redacts under the default policy (0012, then 0022: the public sees
 * member names and pictures; contacts, home venues and officer contacts stay redacted).
 */
const PUBLIC_REDACTS: ReadonlySet<string> = new Set(['member_address', 'member_phone', 'member_email', 'private_venue', 'officer_contact']);

/** The categories members redact under the default policy (0012): home addresses (BOXLABEL: their boxes say "Private"). */
const MEMBERS_REDACT: ReadonlySet<string> = new Set(['member_address']);

/**
 * The public copy's input hash under the default policy: the marks of the categories the public redacts, which of
 * them members withhold too (BOXLABEL), pictures shown, and (LINKS L3, store.ts inputsFor) the public file's links
 * whose targets hold none of those, at the origin.
 */
export const publicInputHash = (pdf: Uint8Array, marks: readonly Mark[], links: readonly Link[] = []): string => {
  const redacted = marks.filter((mark) => PUBLIC_REDACTS.has(mark.category));
  const quotes = redacted.map((mark) => mark.quote);
  const passing = links.filter((link) => !targetHolds(link.url, quotes));
  const request = {
    quotes,
    membersWithhold: redacted.map((mark) => MEMBERS_REDACT.has(mark.category)),
    redactsAny: true,
    image: 'show' as const,
    links: passing.map((link) => ({ id: link.id, page: link.page, rect: roundRect(link.rect), label: linkLabel(hostOf(link)) })),
  };
  return inputHash(sha256(pdf), request, undefined, Object.fromEntries(passing.map((link) => [link.id, link.url]))).toString('hex');
};

/** A link id as the checker mints it (26 lower-case base32 characters); here from a counter, so tests repeat. */
export const linkId = (n: number): string => {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let out = '';
  for (let rest = n; out.length < 26; rest = Math.floor(rest / 32)) out = alphabet[rest % 32] + out;
  return out;
};

/** A link on page 1 of the synthetic issue; example.org and its kin are reserved names, never a real site. */
export const webLink = (n: number, url = `https://example.org/games/${n}`, confirm = false): Link => ({ id: linkId(n), page: 1, rect: [72, 700 - 20 * n, 300, 714 - 20 * n], url, kind: 'web', confirm });
export const mailLink = (n: number, url = 'mailto:games@example.org'): Link => ({ id: linkId(n), page: 1, rect: [72, 700 - 20 * n, 300, 714 - 20 * n], url, kind: 'mail', confirm: false });

/** The approved links of the synthetic issue: two on the public file, three on the members file. */
export const LINKS: IssueLinks = {
  public: [webLink(1), mailLink(2)],
  members: [webLink(3), mailLink(4), webLink(5, 'https://social.example.net/groups/nwfl', true)],
};

/** The links as JSON, as the checker writes them into a bundle. */
export const linksJson = (links: IssueLinks): Record<string, unknown> => JSON.parse(JSON.stringify(links)) as Record<string, unknown>;

export interface BundleOptions {
  /** nwfl-issue/2 carries links and approval.linksSha256. */
  format?: 'nwfl-issue/1' | 'nwfl-issue/2';
  links?: IssueLinks;
  linksSha256?: string;
  period?: string;
  volume?: number;
  number?: number;
  office?: string;
  reference?: string;
  marks?: Mark[];
  publicPdf?: Uint8Array;
  membersPdf?: Uint8Array;
  /** Overrides the approved hashes (by default they are the bundle's own). */
  marksSha256?: string;
  publicInputHash?: string;
  membersSha256?: string;
}

/** A bundle as the loader reads it from stdin (JSON, PDFs in base64), approved for its own marks and public copy. */
export async function bundleJson(options: BundleOptions = {}): Promise<Record<string, unknown>> {
  const period = options.period ?? '2026-10';
  const pub = options.publicPdf ?? (await publicPdf(period));
  const members = options.membersPdf ?? (await membersPdf(period));
  const marks = options.marks ?? MARKS;
  const v2 = options.format === 'nwfl-issue/2';
  const links = options.links ?? LINKS;
  return {
    format: options.format ?? 'nwfl-issue/1',
    issue: { period, volume: options.volume ?? 30, number: options.number ?? 5 },
    office: options.office ?? 'editor',
    approval: {
      reference: options.reference ?? 'PUBCOPY',
      marksSha256: options.marksSha256 ?? marksSha256(marks),
      publicInputHash: options.publicInputHash ?? publicInputHash(pub, marks, v2 ? links.public : []),
      membersSha256: options.membersSha256 ?? sha256(members).toString('hex'),
      ...(v2 ? { linksSha256: options.linksSha256 ?? linksSha256({ public: sha256(pub).toString('hex'), members: sha256(members).toString('hex') }, links) } : {}),
    },
    pdfs: { public: Buffer.from(pub).toString('base64'), members: Buffer.from(members).toString('base64') },
    marks: marks.map((mark) => ({ ...mark })),
    ...(v2 ? { links: linksJson(links) } : {}),
  };
}

export interface LinksBundleOptions {
  slug?: string;
  publicSha256: string;
  membersSha256: string;
  links?: IssueLinks;
  reference?: string;
  linksSha256?: string;
  publicInputHash: string;
}

/** A links bundle (nwfl-links/1) for an issue already loaded, approved for its own links on its own two files. */
export function linksBundleJson(options: LinksBundleOptions): Record<string, unknown> {
  const links = options.links ?? LINKS;
  return {
    format: 'nwfl-links/1',
    issue: options.slug ?? 'pensa-mensa-2026-10',
    sha256: { public: options.publicSha256, members: options.membersSha256 },
    links: linksJson(links),
    approval: {
      reference: options.reference ?? 'LINKS',
      linksSha256: options.linksSha256 ?? linksSha256({ public: options.publicSha256, members: options.membersSha256 }, links),
      publicInputHash: options.publicInputHash,
    },
  };
}

/** stdin as the loader sees it: its kind and its chunks. */
export function stdinOf(text: string | Buffer, kind: 'pipe' | 'socket' | 'file' | 'device' | 'other' = 'pipe') {
  const bytes = typeof text === 'string' ? Buffer.from(text, 'utf8') : text;
  return {
    kind,
    chunks: (function* () {
      // Two chunks, so a split read is exercised.
      yield bytes.subarray(0, Math.floor(bytes.length / 2));
      yield bytes.subarray(Math.floor(bytes.length / 2));
    })(),
  };
}
