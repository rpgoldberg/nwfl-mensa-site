// ============================================================================
// A piece's links, for the link gate (EDITOR A3b, SPEC-v3 3.3). No network.
//
//   the list    every link and printed URL in the working version's text ("in
//               the text"), and the web addresses of its office's upcoming
//               events: an event's own address and those printed in its
//               detail ("event: <title>"), and its venue's ("venue: <name>").
//               Upcoming: from today (Central) to the end of the piece's
//               edition period, or the next 92 days with no edition. One row
//               per (url, where), sorted by url, then where.
//   the hash    SHA-256 of the JSON array [ready_at, pairs]: the version's ready
//               time in RFC 3339 to the microsecond in UTC (null for a draft),
//               then the [url, where] pairs in list order. ConfirmLinks is
//               refused once the list a reviewer read has changed, or the
//               version has been marked ready again since (a new round).
//   an answer   counts for the version and its ready time as they stand, from
//               someone who did not edit the version; the latest per URL wins.
//   a verdict   the link checker's (L-ITEM): OK, CONFIRM or DROP on an
//               address in an item, never a version; the latest per URL wins.
//   the gate    Approve waits until EVERY link in the list is accepted: a
//               reviewer's yes as it stands, or the checker's OK under 7 days
//               old on a link that needs no sign-in (isLoginWalled) and is not
//               on a host the checker never fetches (isNoFetch). A
//               reviewer's no holds whatever the checker says; a DROP holds
//               until a reviewer answers yes with a note after it (linkHold).
//               An answer or verdict on a URL no longer in the list counts for
//               nothing.
//
// A reader sees the list through their lens (marked passages withheld) and
// the hash covers what they see; the gate reads the list as it is. An answer
// is kept only for a URL in both: what a reviewer could not see whole, they
// cannot vouch for. Approve's refusal names or counts only links its caller
// sees whole; any other link holding it up is one sentence, with no URL and
// no count (OFFICERS_ONLY).
// ============================================================================
import { createHash } from 'node:crypto';
import type { TxClient } from '../db/tx.js';
import { type Entry, MAX_RANGE_DAYS, calendarSource } from '../events/service.js';
import { calendarLens, entryFor } from '../events/redact.js';
import { addDays, todayIn } from '../events/zone.js';
import { isLoginWalled, isNoFetch, parseLink } from '../links/urls.js';
import { shownUrl, urlsInText } from '../links/rule.js';
import type { StructuredLogger } from '../platform/logger.js';
import { loadLens } from '../redaction/lens.js';
import { subjectKey } from '../redaction/render.js';
import { actorLabel } from './actor-label.js';
import { itemHidden } from './redact.js';
import type { Block, Inline, Tree } from './tree.js';

export const IN_TEXT = 'in the text';
/** Without an edition, the events of the next 92 days are in the list. */
export const EVENT_DAYS = 92;

export interface PieceLink {
  url: string;
  /** The link's words; empty for a printed URL or an event's address. */
  label: string;
  where: string;
}

/** Whether a URL is on a site that needs a sign-in to check. A mailto or an unreadable address is not. */
export function loginWalled(url: string): boolean {
  const parsed = parseLink(url);
  return parsed.ok && parsed.link.kind === 'web' && isLoginWalled(parsed.link.host);
}

/**
 * Whether a URL (a web or a mail address) is on a host the link checker never requests, not even by name
 * (the no-fetch list, isNoFetch: us.mensa.org and all under it, among others). Its OK on one says nothing.
 */
export function neverFetched(url: string): boolean {
  const parsed = parseLink(url);
  return parsed.ok && isNoFetch(parsed.link.host);
}

const words = (nodes: readonly Inline[]): string =>
  nodes
    .map((node) => (node.type === 'text' ? node.text : node.type === 'link' || node.type === 'members' ? words(node.children) : ''))
    .join('');

function inlineLinks(nodes: readonly Inline[], out: PieceLink[]): void {
  for (const node of nodes) {
    if (node.type === 'text') {
      for (const { url } of urlsInText(node.text)) out.push({ url, label: '', where: IN_TEXT });
    } else if (node.type === 'link') {
      out.push({ url: node.href, label: words(node.children).replace(/\s+/g, ' ').trim(), where: IN_TEXT });
      inlineLinks(node.children, out);
    } else if (node.type === 'members') {
      inlineLinks(node.children, out);
    }
  }
}

function blockLinks(blocks: readonly Block[], out: PieceLink[]): void {
  for (const block of blocks) {
    switch (block.type) {
      case 'paragraph':
      case 'heading':
        inlineLinks(block.children, out);
        break;
      case 'list':
        for (const item of block.items) blockLinks(item, out);
        break;
      case 'quote':
      case 'members':
        blockLinks(block.children, out);
        break;
      default:
        break;
    }
  }
}

/** Every link and printed URL in a body tree, in order, repeats included. */
export function textLinks(tree: Tree): PieceLink[] {
  const out: PieceLink[] = [];
  blockLinks(tree.blocks, out);
  return out;
}

/** The web addresses of these events: each one's own, those printed in its detail, and its venue's. */
export function eventLinks(entries: readonly Entry[]): PieceLink[] {
  return entries.flatMap((entry) => {
    const where = `event: ${entry.title}`;
    return [
      ...(entry.url !== '' ? [{ url: entry.url, label: '', where }] : []),
      ...urlsInText(entry.detail).map(({ url }) => ({ url, label: '', where })),
      ...(entry.venue?.url ? [{ url: entry.venue.url, label: '', where: `venue: ${entry.venue.name}` }] : []),
    ];
  });
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** One row per (url, where), the first words found kept, sorted by url, then where. */
export function canonicalLinks(links: readonly PieceLink[]): PieceLink[] {
  const rows = new Map<string, PieceLink>();
  for (const link of links) {
    const key = JSON.stringify([link.url, link.where]);
    const known = rows.get(key);
    if (known === undefined) rows.set(key, { ...link });
    else if (known.label === '') known.label = link.label;
  }
  return [...rows.values()].sort((a, b) => compare(a.url, b.url) || compare(a.where, b.where));
}

/** Microseconds since the epoch (as Postgres keeps a time) in RFC 3339, in UTC, to the microsecond; null stays null. */
export function rfc3339Micros(us: string | null): string | null {
  if (us === null) return null;
  const total = BigInt(us);
  const seconds = total / 1000000n - (total % 1000000n < 0n ? 1n : 0n);
  const micros = total - seconds * 1000000n;
  return `${new Date(Number(seconds) * 1000).toISOString().slice(0, 19)}.${micros.toString().padStart(6, '0')}Z`;
}

/** SHA-256 of the JSON array [readyAt, [url, where] pairs in the list's order]. */
export function linksSha256(readyAt: string | null, links: readonly PieceLink[]): Buffer {
  return createHash('sha256')
    .update(JSON.stringify([readyAt, links.map((link) => [link.url, link.where])]))
    .digest();
}

/**
 * The calendar entries of an office from today to `to` (Central): the end of the edition period, or
 * EVENT_DAYS ahead with no edition; never past the calendar's own longest range.
 */
export async function officeEvents(
  client: TxClient,
  deps: { logger: StructuredLogger; now: () => Date },
  officeId: string,
  editionId: string | null,
): Promise<Entry[]> {
  const today = todayIn(deps.now());
  let to = addDays(today, EVENT_DAYS);
  // A version's edition always exists (a foreign key).
  if (editionId !== null) to = ((await client.query<{ end: string }>(`SELECT period_end::text AS end FROM edition WHERE id = $1`, [editionId])).rows[0] as { end: string }).end;
  const furthest = addDays(today, MAX_RANGE_DAYS);
  if (to > furthest) to = furthest;
  if (to < today) return [];
  const entries = await calendarSource(client, deps.logger).calendar(today, to);
  // Cancelled ones included: the site reads the calendar with them (web lib/api/client.ts, includeCancelled), and an
  // event's page and its calendar file still give their links and detail (web pages/events/[id].astro, lib/calendar.ts).
  return entries.filter((entry) => (entry.series?.host_office_id ?? entry.ownerOfficeId) === officeId);
}

/**
 * The events as an audience may see them, as the calendar shows them: a members event withheld from
 * the public's audience (the Admin or the Webmaster without the officers group reads there), then
 * marked text withheld and what the lens hides dropped (REDACT R2a).
 */
export async function eventsAsSeen(client: TxClient, audience: string, entries: readonly Entry[]): Promise<Entry[]> {
  const shown = entries.filter((entry) => !(audience === 'public' && entry.visibility === 'members'));
  if (shown.length === 0) return [];
  const lens = await calendarLens(client, audience, shown);
  return shown.flatMap((entry) => entryFor(entry, lens) ?? []);
}

export interface Answer {
  answer: 'yes' | 'no';
  label: string;
  /** The reviewer's note, trimmed; null for none. */
  note: string | null;
  /** The row's number: answers and verdicts are ordered by it (latest wins). */
  id: bigint;
}

/**
 * The answers that count on a version, by URL: the latest human answer at the version's ready time as
 * it stands, from someone who did not edit it, with who gave it in words (actor-label.ts).
 */
export async function currentAnswers(client: TxClient, versionId: string, itemOffice: { slug: string; title: string }): Promise<Map<string, Answer>> {
  const { rows } = await client.query<{ url: string; answer: 'yes' | 'no'; note: string | null; id: string; by_groups: string[]; slug: string | null; title: string | null }>(
    `SELECT DISTINCT ON (c.url) c.url, c.answer, c.note, c.id::text AS id, c.by_groups, o.slug, o.title
     FROM content_link_check c JOIN content_version v ON v.id = c.version_id LEFT JOIN office o ON o.id = c.acting_office_id
     WHERE c.version_id = $1 AND c.source = 'human' AND c.ready_at_seen = v.ready_at
       AND NOT EXISTS (SELECT 1 FROM content_version_editor e WHERE e.version_id = c.version_id AND e.subject = c.by_sub)
     ORDER BY c.url, c.id DESC`,
    [versionId],
  );
  return new Map(
    rows.map((row) => [
      row.url,
      {
        answer: row.answer,
        label: actorLabel({ kind: 'user', groups: row.by_groups, actingOffice: row.slug === null ? null : { slug: row.slug, title: row.title as string } }, itemOffice),
        note: row.note,
        id: BigInt(row.id),
      },
    ]),
  );
}

/** How long the link checker's OK lets a link through Approve (SPEC-v3 3.3). */
export const MACHINE_OK_DAYS = 7;

export interface Verdict {
  verdict: 'ok' | 'confirm' | 'drop';
  reasons: string[];
  /** When the checker gave it, by the database clock. */
  at: Date;
  /** Under MACHINE_OK_DAYS old, by the database clock. */
  fresh: boolean;
  id: bigint;
}

/**
 * The link checker's latest verdict on each of an item's URLs (L-ITEM). A verdict names the address, not a
 * version. Latest is by the row's number as a number (c.id): a bare `id` in ORDER BY is the text column
 * of the result, in which row 99 sorts after row 100.
 */
export async function machineVerdicts(client: TxClient, itemId: string): Promise<Map<string, Verdict>> {
  const { rows } = await client.query<{ url: string; answer: Verdict['verdict']; reasons: string[]; at: Date; fresh: boolean; id: string }>(
    `SELECT DISTINCT ON (url) url, answer, reasons, at, now() - at < make_interval(days => $2) AS fresh, id::text AS id
     FROM content_link_check c WHERE item_id = $1 AND source = 'machine' ORDER BY url, c.id DESC`,
    [itemId, MACHINE_OK_DAYS],
  );
  return new Map(rows.map((row) => [row.url, { verdict: row.answer, reasons: row.reasons, at: row.at, fresh: row.fresh, id: BigInt(row.id) }]));
}

/**
 * Why a link holds Approve up, worst first: a reviewer's no; a checker's DROP with no later yes that
 * carries a note; a link that needs a sign-in with no yes; any other link with neither a yes nor a
 * fresh OK.
 */
export type Hold = 'no' | 'drop' | 'walled' | 'unchecked';
const HOLDS: readonly Hold[] = ['no', 'drop', 'walled', 'unchecked'];

/**
 * Whether one link is accepted (SPEC-v3 3.3, item 3), from the latest reviewer answer on the version as
 * it stands and the checker's latest verdict on the address. Within each, the latest wins. Between them:
 *   - a reviewer's no holds, whatever the checker says: it checks that a page answers, a reviewer that
 *     it is the right page;
 *   - a DROP holds until a reviewer answers yes with a note AFTER it (a later DROP holds again);
 *   - a reviewer's yes accepts;
 *   - an OK under MACHINE_OK_DAYS old accepts a link that needs no sign-in and whose host the checker
 *     fetches (neverFetched): an OK on any other was not given by looking;
 *   - CONFIRM, a stale OK, or nothing accepts nothing.
 */
export function linkHold(url: string, human: Answer | undefined, machine: Verdict | undefined): Hold | undefined {
  if (human?.answer === 'no') return 'no';
  if (machine?.verdict === 'drop' && !(human !== undefined && human.note !== null && human.id > machine.id)) return 'drop';
  if (human?.answer === 'yes') return undefined;
  const walled = loginWalled(url);
  if (machine?.verdict === 'ok' && machine.fresh && !walled && !neverFetched(url)) return undefined;
  return walled ? 'walled' : 'unchecked';
}

/** A version whose links are read: its item and office, its body, and the edition its events run to. */
export interface LinkedVersion {
  id: string;
  itemId: string;
  onBehalfOf: string | null;
  body: Tree;
  officeId: string;
  editionId: string | null;
}

/** The list as it is (no lens), and the office events it was read from. */
export async function actualLinks(client: TxClient, deps: { logger: StructuredLogger; now: () => Date }, version: LinkedVersion): Promise<{ links: PieceLink[]; events: Entry[] }> {
  const events = await officeEvents(client, deps, version.officeId, version.editionId);
  return { links: canonicalLinks([...textLinks(version.body), ...eventLinks(events)]), events };
}

/** The list as an audience sees it, through its lens (REDACT R2a); undefined when the lens hides the item. */
export async function linksAsSeen(client: TxClient, audience: string, version: LinkedVersion, events: readonly Entry[]): Promise<PieceLink[] | undefined> {
  const lens = await loadLens(client, audience, { items: [version.itemId], versions: [version.id] });
  if (itemHidden({ id: version.itemId, on_behalf_of: version.onBehalfOf }, version.id, lens)) return undefined;
  return canonicalLinks([...textLinks(lens.tree(version.body, [subjectKey('content_item', version.itemId)])), ...eventLinks(await eventsAsSeen(client, audience, events))]);
}

/** Approve's refusal for links its caller may not see whole: no URL and no count. */
export const OFFICERS_ONLY = "Some links that only officers can see need an officer's answer before this is approved.";

/**
 * The gate, on a version's list as it is: Approve's refusal in plain words, or undefined when nothing
 * holds it up: every link accepted (linkHold). Only links the caller (`audience`) sees whole are named
 * or counted, the worst hold first; the rest are OFFICERS_ONLY, said once. `editionId` is the edition
 * the version is about to be approved for.
 */
export async function linkGate(
  client: TxClient,
  deps: { logger: StructuredLogger; now: () => Date },
  version: LinkedVersion & { office: { slug: string; title: string } },
  audience: string,
): Promise<string | undefined> {
  const { links, events } = await actualLinks(client, deps, version);
  const urls = [...new Set(links.map((link) => link.url))];
  const answers = await currentAnswers(client, version.id, version.office);
  const verdicts = await machineVerdicts(client, version.itemId);
  const held = urls.flatMap((url) => {
    const hold = linkHold(url, answers.get(url), verdicts.get(url));
    return hold === undefined ? [] : [{ url, hold }];
  });
  if (held.length === 0) return undefined;
  const seen = new Set((await linksAsSeen(client, audience, version, events))?.map((link) => link.url));
  const shown = held.filter((link) => seen.has(link.url));
  const worst = HOLDS.find((hold) => shown.some((link) => link.hold === hold));
  if (worst === undefined) return OFFICERS_ONLY;
  const of = shown.filter((link) => link.hold === worst).map((link) => link.url);
  const named = worst === 'no' ? refusedMessage(of) : worst === 'drop' ? droppedMessage(of) : worst === 'walled' ? uncheckedMessage(of.length) : waitingMessage(of.length);
  return shown.length < held.length ? `${named}. ${OFFICERS_ONLY}` : named;
}

/** Approve's refusal while reviewers answered no on these links, in plain words: the first named, the rest counted. */
export function refusedMessage(urls: readonly string[]): string {
  const more = urls.length > 1 ? ` and ${urls.length - 1} more` : '';
  return `a reviewer answered no for the link "${shownUrl(urls[0] as string)}"${more} (it does not show the right page): the writer fixes it, or a reviewer changes the answer to yes, before this is approved`;
}

/** Approve's refusal while `count` login-walled links wait, in plain words. */
export function uncheckedMessage(count: number): string {
  const them = count === 1 ? '1 link needs' : `${count} links need`;
  const it = count === 1 ? 'it' : 'them';
  return `${them} a sign-in to check (such as Facebook): someone other than the writer must open ${it} and answer yes before this is approved`;
}

/** Approve's refusal while the link checker found these links broken, in plain words: the first named, the rest counted. */
export function droppedMessage(urls: readonly string[]): string {
  const more = urls.length > 1 ? ` and ${urls.length - 1} more` : '';
  return `the link checker found the link "${shownUrl(urls[0] as string)}"${more} broken: the writer fixes it, or someone other than the writer opens it and answers yes with a note saying why it is right, before this is approved`;
}

/** Approve's refusal while `count` ordinary links have neither a yes nor a recent OK from the link checker, in plain words. */
export function waitingMessage(count: number): string {
  const them = count === 1 ? '1 link has' : `${count} links have`;
  const it = count === 1 ? 'it' : 'them';
  return `${them} not been checked yet: the link checker checks ${it}, or someone other than the writer opens ${it} and answers yes, before this is approved`;
}
