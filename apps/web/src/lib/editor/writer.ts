// EDITOR E3: the writer screens' own rules (spec S1-S5, SPEC-v3 3.1 and 3.2). Which offices a person may
// write as (their nwfl-office-<slug> groups; the Admin any office, "for the office"); how long the text
// is, in words and newsletter pages; how long the sign-in lasts, in Central time, with "Save now" for its
// last five minutes; and the fixed words every edit page shows. The API checks every step again: this
// only decides what the pages offer.
//
// public/scripts/editor.js counts words and says the length as wordCount and lengthText do here (it is
// plain script and cannot import this): test/editor-script.test.ts holds the two to the same answers.
import type { EditorItem, VisibilityName } from '../api/editor';
import { formatTime } from '../calendar';
import { readForm } from '../form';
import { EDIT_FORM_LIMIT } from './form';

/** An office on the roster, as an item is posted as it. */
export interface RosterOffice {
  id: string;
  slug: string;
  title: string;
}

/** An office the person may write as: `held` when they hold it, else the Admin writing for it. */
export interface PostingOffice extends RosterOffice {
  held: boolean;
}

const OFFICE_GROUP = 'nwfl-office-';

/** The offices a person may write as, in roster order: the ones they hold, or every one for the Admin. */
export function postingOffices(groups: readonly string[], roster: readonly RosterOffice[]): PostingOffice[] {
  const admin = groups.includes('nwfl-admin');
  const held = new Set(groups.filter((g) => g.startsWith(OFFICE_GROUP)).map((g) => g.slice(OFFICE_GROUP.length)));
  return roster.filter((o) => admin || held.has(o.slug)).map((o) => ({ ...o, held: held.has(o.slug) }));
}

/** Whether the person could write for any office at all (holds one, or is the Admin): no roster needed. */
export function mayHoldAnOffice(groups: readonly string[]): boolean {
  return groups.includes('nwfl-admin') || groups.some((g) => g.startsWith(OFFICE_GROUP));
}

/** The office in words: "Treasurer (for the office)" when the Admin writes for an office they do not hold. */
export function officeName(office: PostingOffice): string {
  return office.held ? office.title : `${office.title} (for the office)`;
}

/** Whether the person may edit, preview and send this item: it is one of their offices'. */
export function mayWriteFor(offices: readonly PostingOffice[], item: Pick<EditorItem, 'officeId'>): boolean {
  return offices.some((o) => o.id === item.officeId);
}

const WHEN = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** The time of day in Central, as the site says it: "2:05 pm", "12:00 noon". */
export function clockText(at: Date): string {
  const part = Object.fromEntries(WHEN.formatToParts(at).map((p) => [p.type, p.value]));
  return formatTime(`${part['hour']}:${part['minute']}`);
}

/** When an item last changed, in Central time: "Thu 12 Nov, 2:05 pm". */
export function lastChangeText(at: Date | undefined): string {
  if (at === undefined) return 'Not known';
  const part = Object.fromEntries(WHEN.formatToParts(at).map((p) => [p.type, p.value]));
  return `${part['weekday']} ${part['day']} ${part['month']}, ${clockText(at)}`;
}

/**
 * "Our news" (S2): the items being written and the published or taken-down ones in one list, each once
 * (a published item with a change being written is in both), newest change first; an item with no time
 * keeps its place after those with one.
 */
export function ourNews(writing: readonly EditorItem[], published: readonly EditorItem[]): EditorItem[] {
  const seen = new Set<string>();
  const all = [...writing, ...published].filter((item) => !seen.has(item.id) && seen.add(item.id));
  const time = (item: EditorItem) => item.lastChangedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  return all.map((item, at) => ({ item, at })).sort((a, b) => time(b.item) - time(a.item) || a.at - b.at).map(({ item }) => item);
}

/** About this many words fill a page of the newsletter. */
export const WORDS_PER_PAGE = 500;

/** The words a reader reads: the marks, link addresses and members fences left out. */
export function wordCount(markup: string): number {
  return markup
    .replace(/\]\([^)\s]*\)/g, ' ')
    .replace(/:members\[/g, ' ')
    .replace(/^\s*:::.*$/gm, ' ')
    .replace(/^\s*(?:#{1,6}|[-*]|\d+\.|>)\s+/gm, ' ')
    .split(/\s+/)
    .filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

/** Newsletter pages, rounded up: none for no words. */
export function newsletterPages(words: number): number {
  return Math.ceil(words / WORDS_PER_PAGE);
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** "1,234 words, about 3 newsletter pages." */
export function lengthText(markup: string): string {
  const words = wordCount(markup);
  if (words === 0) return 'No words yet.';
  return `${plural(words, 'word', 'words')}, about ${plural(newsletterPages(words), 'newsletter page', 'newsletter pages')}.`;
}

/** The last minutes of a sign-in, in which the line says "Save now". */
const SOON_SECONDS = 5 * 60;

const CLOCK = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** An instant as a Central wall clock, "2:05 pm". */
function centralClock(at: Date): string {
  const parts = Object.fromEntries(CLOCK.formatToParts(at).map((p) => [p.type, p.value]));
  return formatTime(`${parts['hour']}:${parts['minute']}`);
}

export interface SignInLine {
  text: string;
  /** Five minutes or less to go: the line says "Save now". */
  soon: boolean;
  /** Seconds, for the page's script to turn the line to "Save now" when the time comes. */
  expiresAt: number;
  /** The "Save now" words, for the script to show then. */
  soonText: string;
}

/** The words that say until when the sign-in lasts. */
export const signInWords = (clock: string, soon: boolean): string =>
  soon ? `Your sign-in ends at ${clock} Central time. Save now.` : `Your sign-in lasts until ${clock} Central time. Save before then.`;

/**
 * Until when the sign-in lasts (SPEC-v3 3.1), from the access token's expiry (seconds): none without one,
 * or once it has passed (the page then asks to sign in again).
 */
export function signInLine(expiresAt: number | undefined, now: number): SignInLine | undefined {
  if (expiresAt === undefined || !Number.isFinite(expiresAt) || expiresAt <= now) return undefined;
  const soon = expiresAt - now <= SOON_SECONDS;
  const clock = centralClock(new Date(expiresAt * 1000));
  return { text: signInWords(clock, soon), soon, expiresAt, soonText: signInWords(clock, true) };
}

/** What Send for approval may offer: the newsletter for an item everyone or members can read (an officers-only item cannot go there). */
export function submitTargets(visibility: VisibilityName): { newsletter: boolean } {
  return { newsletter: visibility !== 'officers' };
}

/** R13: shown above the text box, always. */
export const ROSTER_WARNING = "Never paste birthday, new-member or Mensaversary lists, or anything from Mensa's roster.";

/** The tab's unsent copy of an item (sessionStorage, never localStorage): public/scripts/editor.js keeps it. */
export const draftKey = (itemId: string): string => `nwfl-draft:${itemId}`;

/** S1's "Our events": E6's events pages (src/lib/editor/events.ts EVENTS_PATH), linked for whom they admit (mayUseEvents). */
export const OUR_EVENTS: string | undefined = '/officer-area/events';

export const EDIT_LINKS = {
  list: '/officer-area/news',
  create: '/officer-area/news/new',
  edit: (id: string) => `/officer-area/news/${id}`,
  preview: (id: string) => `/officer-area/news/${id}/preview`,
} as const;

/** What the edit form posted, as typed: kept on the page when the save cannot be made. */
export interface KeptDraft {
  title: string;
  summary: string;
  visibility: string;
  markup: string;
}

/**
 * The edit form's text, from the post alone, for a save posted after the session or its token ran out
 * (spec S4): the page gives it back with "Your sign-in timed out", reading nothing else. The edit form's
 * cap applies; anything but a form is refused.
 */
export async function keptText(request: Request): Promise<{ ok: true; values: KeptDraft; base: string } | { ok: false; status: 400 | 413 | 415 }> {
  const read = await readForm(request, EDIT_FORM_LIMIT);
  if (!read.ok) return read;
  const field = (name: string) => read.field(name) ?? '';
  // Round 2: the base the form was opened from goes back with the kept text, so a later save is still checked.
  return { ok: true, values: { title: field('title'), summary: field('summary'), visibility: field('visibility'), markup: field('markup').replace(/\r\n?/g, '\n') }, base: field('base') };
}
