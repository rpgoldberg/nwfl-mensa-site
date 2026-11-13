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
//   the hash    SHA-256 of the JSON array of [url, where] pairs, in that order.
//               ConfirmLinks is refused once the list a reviewer read has
//               changed.
//   an answer   counts for the version and its ready time as they stand, from
//               someone who did not edit the version; the latest per URL wins.
//   the gate    Approve waits while any link in the list has a reviewer's no
//               as it stands (the writer fixes it, or a reviewer changes the
//               answer to yes), and while a login-walled link (isLoginWalled: a
//               site that needs a sign-in to check) has no yes. An ordinary link
//               with no answer does not hold Approve up: the machine checks are
//               L-ITEM's. A no on a URL no longer in the list counts for nothing.
//
// A reader sees the list through their lens (marked passages withheld) and
// the hash covers what they see; the gate reads the list as it is. An answer
// is kept only for a URL in both: what a reviewer could not see whole, they
// cannot vouch for.
// ============================================================================
import { createHash } from 'node:crypto';
import type { TxClient } from '../db/tx.js';
import { type Entry, MAX_RANGE_DAYS, calendarSource } from '../events/service.js';
import { calendarLens, entryFor } from '../events/redact.js';
import { addDays, todayIn } from '../events/zone.js';
import { isLoginWalled, parseLink } from '../links/urls.js';
import { shownUrl, urlsInText } from '../links/rule.js';
import type { StructuredLogger } from '../platform/logger.js';
import { actorLabel } from './actor-label.js';
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

/** SHA-256 of the JSON array of [url, where] pairs, in the list's order. */
export function linksSha256(links: readonly PieceLink[]): Buffer {
  return createHash('sha256')
    .update(JSON.stringify(links.map((link) => [link.url, link.where])))
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
}

/**
 * The answers that count on a version, by URL: the latest human answer at the version's ready time as
 * it stands, from someone who did not edit it, with who gave it in words (actor-label.ts).
 */
export async function currentAnswers(client: TxClient, versionId: string, itemOffice: { slug: string; title: string }): Promise<Map<string, Answer>> {
  const { rows } = await client.query<{ url: string; answer: 'yes' | 'no'; by_groups: string[]; slug: string | null; title: string | null }>(
    `SELECT DISTINCT ON (c.url) c.url, c.answer, c.by_groups, o.slug, o.title
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
      },
    ]),
  );
}

export interface GateFindings {
  /** URLs of the list whose answer as it stands is a reviewer's no, in list order. */
  refused: string[];
  /** Login-walled URLs of the list with no yes as it stands, in list order. */
  unchecked: string[];
}

/**
 * The gate, on a version's list as it is (no lens): the links answered no, and the login-walled links
 * not answered yes. `editionId` is the edition the version is about to be approved for.
 */
export async function linkGate(
  client: TxClient,
  deps: { logger: StructuredLogger; now: () => Date },
  version: { id: string; body: Tree; officeId: string; office: { slug: string; title: string }; editionId: string | null },
): Promise<GateFindings> {
  const links = canonicalLinks([...textLinks(version.body), ...eventLinks(await officeEvents(client, deps, version.officeId, version.editionId))]);
  const urls = [...new Set(links.map((link) => link.url))];
  const answers = await currentAnswers(client, version.id, version.office);
  return {
    refused: urls.filter((url) => answers.get(url)?.answer === 'no'),
    unchecked: urls.filter((url) => loginWalled(url) && answers.get(url)?.answer !== 'yes'),
  };
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
