// ============================================================================
// links.json, the approved link list (SPEC D2, D4), and its hash, linksSha256.
//
// THE CONTRACT with the loader (L2, apps/api src/load/links.ts; CONTRACT.md), pinned by test/list.test.ts
// and test/contract.test.ts:
//   links.json = {
//     "format": "nwfl-link-list/1",
//     "sha256": { "public": <hex>, "members": <hex> },          the sha256 of each original PDF
//     "links": { "public": [Link...], "members": [Link...] },    in page order; the hash sorts by id
//     "linksSha256": <hex>
//   }
//   Link = { "id": 26 lower-case base32 chars (128 random bits, minted here, never derived),
//            "page": 1-based page number, "rect": [x1, y1, x2, y2] in PDF points, rounded to 0.01,
//            x1 < x2 and y1 < y2, "url": its own kept form (urls.ts keptForm: https, or mailto:<one
//            address>), "kind": "web" | "mail", "confirm": true for a login-walled host the editor confirmed }
//   linksSha256 = sha256 hex of canonicalJson({ v: 2, sha256: { public, members }, links: { public: [...],
//   members: [...] } }), so the links approved for one issue's files cannot attach to another's; computed
//   as the loader computes marksSha256 (apps/api src/load/load.ts marksSha256), with canonicalJson
//   exactly apps/api src/content/hash.ts's.
// At most 500 links per file. Every refusal names the place, never the URL.
// ============================================================================
import { createHash, randomBytes } from 'node:crypto';
import { type Kind, keptForm } from './urls.js';

export const LIST_FORMAT = 'nwfl-link-list/1';
export const MAX_LINKS_PER_FILE = 500;
export const AUDIENCES = ['public', 'members'] as const;
export type Audience = (typeof AUDIENCES)[number];

export type Rect = [number, number, number, number];

export interface ListedLink {
  id: string;
  page: number;
  rect: Rect;
  url: string;
  kind: Kind;
  confirm: boolean;
}

export type LinksByAudience = Record<Audience, ListedLink[]>;

export interface LinkList {
  format: typeof LIST_FORMAT;
  sha256: Record<Audience, string>;
  links: LinksByAudience;
  linksSha256: string;
}

export class ListError extends Error {
  override name = 'ListError';
}

/** JSON with object keys sorted at every depth; arrays keep their order (apps/api src/content/hash.ts). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
export const ID = /^[a-z2-7]{26}$/;

/** A link id: 128 random bits as 26 lower-case base32 characters (RFC 4648 alphabet, no padding). */
export function mintId(random: (size: number) => Uint8Array = randomBytes): string {
  const bytes = random(16);
  if (bytes.length !== 16) throw new ListError('a link id needs 16 random bytes');
  let bits = 0n;
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte);
  bits <<= 2n; // 128 bits padded to 130, 26 groups of five
  let out = '';
  for (let i = 25; i >= 0; i -= 1) out += BASE32[Number((bits >> BigInt(i * 5)) & 31n)] as string;
  return out;
}

const byId = (a: ListedLink, b: ListedLink): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const shape = (link: ListedLink): ListedLink => ({ id: link.id, page: link.page, rect: link.rect, url: link.url, kind: link.kind, confirm: link.confirm });

/** The approved list's hash, as the editor approves it ("LINKS: ok <prefix>"): over the links and the two files' sha256s. */
export function linksSha256(links: LinksByAudience, sha256: Record<Audience, string>): string {
  const sorted = { public: links.public.map(shape).sort(byId), members: links.members.map(shape).sort(byId) };
  return createHash('sha256')
    .update(canonicalJson({ v: 2, sha256: { public: sha256.public, members: sha256.members }, links: sorted }))
    .digest('hex');
}

// --- strict reading ---------------------------------------------------------

type Json = Record<string, unknown>;
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_COORD = 14400;

function object(value: unknown, where: string): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ListError(`${where} must be a JSON object`);
  return value as Json;
}

function known(json: Json, where: string, keys: readonly string[]): void {
  for (const key of Object.keys(json)) if (!keys.includes(key)) throw new ListError(`${where}: unknown field ${key}`);
}

const own = (json: Json, key: string): unknown => (Object.hasOwn(json, key) ? json[key] : undefined);

/** A rect as a link may carry it: four finite numbers rounded to 0.01, x1 < x2, y1 < y2. */
export function isRect(value: unknown): value is Rect {
  if (!Array.isArray(value) || value.length !== 4) return false;
  if (!value.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= MAX_COORD && Math.round(n * 100) / 100 === n)) return false;
  const [x1, y1, x2, y2] = value as Rect;
  return x1 < x2 && y1 < y2;
}

function listedLink(value: unknown, where: string): ListedLink {
  const json = object(value, where);
  known(json, where, ['id', 'page', 'rect', 'url', 'kind', 'confirm']);
  const id = own(json, 'id');
  if (typeof id !== 'string' || !ID.test(id)) throw new ListError(`${where}.id must be 26 lower-case base32 characters`);
  const page = own(json, 'page');
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > 10000) throw new ListError(`${where}.page must be a whole number from 1 to 10000`);
  const rect = own(json, 'rect');
  if (!isRect(rect)) throw new ListError(`${where}.rect must be four finite numbers rounded to 0.01, x1 < x2 and y1 < y2`);
  const kind = own(json, 'kind');
  if (kind !== 'web' && kind !== 'mail') throw new ListError(`${where}.kind must be web or mail`);
  const url = own(json, 'url');
  if (typeof url !== 'string' || keptForm(url) !== url) throw new ListError(`${where}.url must be an https or mailto URL in its kept form`);
  if ((url.startsWith('mailto:') ? 'mail' : 'web') !== kind) throw new ListError(`${where}.kind does not match its url`);
  const confirm = own(json, 'confirm');
  if (typeof confirm !== 'boolean') throw new ListError(`${where}.confirm must be true or false`);
  return { id, page, rect, url, kind, confirm };
}

/** links.json, checked whole: known fields only, every link well-formed, ids unique, the hash recomputed. */
export function parseLinkList(input: unknown): LinkList {
  const json = object(input, 'the link list');
  known(json, 'the link list', ['format', 'sha256', 'links', 'linksSha256']);
  if (own(json, 'format') !== LIST_FORMAT) throw new ListError(`the link list's format must be ${LIST_FORMAT}`);
  const shaJson = object(own(json, 'sha256'), 'sha256');
  known(shaJson, 'sha256', AUDIENCES);
  const linksJson = object(own(json, 'links'), 'links');
  known(linksJson, 'links', AUDIENCES);
  const sha256 = {} as Record<Audience, string>;
  const links = {} as LinksByAudience;
  const seen = new Set<string>();
  for (const audience of AUDIENCES) {
    const sha = own(shaJson, audience);
    if (typeof sha !== 'string' || !HEX64.test(sha)) throw new ListError(`sha256.${audience} must be 64 lower-case hex digits`);
    sha256[audience] = sha;
    const list = own(linksJson, audience);
    if (!Array.isArray(list)) throw new ListError(`links.${audience} must be a list`);
    if (list.length > MAX_LINKS_PER_FILE) throw new ListError(`links.${audience} holds at most ${MAX_LINKS_PER_FILE} links`);
    links[audience] = list.map((entry, n) => {
      const link = listedLink(entry, `links.${audience}[${n}]`);
      if (seen.has(link.id)) throw new ListError(`links.${audience}[${n}]: the same id is listed twice`);
      seen.add(link.id);
      return link;
    });
  }
  const hash = own(json, 'linksSha256');
  if (hash !== linksSha256(links, sha256)) throw new ListError('linksSha256 does not match the links');
  return { format: LIST_FORMAT, sha256, links, linksSha256: hash };
}
