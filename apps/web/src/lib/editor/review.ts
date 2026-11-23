// EDITOR E4: the approver's and the publisher's screens (SPEC-v3 1.2-1.4, 3.3; spec S6, S7, S9), their
// rules and their posts, kept here so the pages stay thin and every branch is tested.
//
//   who        any reviewer (an officer, the Admin, the Webmaster) approves, sends back and checks links;
//              the Webmaster, or the Admin as backup, publishes. Approving publishes nothing.
//   acting as  Approve, Send back and the link answers act for an office the person holds: one office is
//              said in words, two or more are a choice (radio buttons: a native select breaks WebKit's
//              style-src-attr), none is their role. The Admin writes for any office, but approves only as
//              what they hold (the API refuses any other).
//   the queue  (S6) what waits for approval, and what is approved and ready to publish, oldest first; the
//              officer-area home counts what this person may approve, and may publish.
//   links      (S7, M3) each link with its latest answer and who gave it, the link checker's latest
//              verdict and its age (L-ITEM), "N of M links checked" (N: the links the gate accepts); answers
//              save per link, bound to the list's hash. The form posts each answer by its row (the row's
//              place and a 12-digit key of its address and where it is), never the address, so a list of
//              500 links of 2,048 characters still fits: the page reads the list again and maps the rows
//              only when the hash is the one the page showed. A list changed since is shown again with
//              the notes kept (by row key), and the answers asked for again. An answer the API did not
//              keep (not in the piece) is said, never called saved.
//   posts      each answered by a redirect (post/redirect/get) or by the page again, with what was typed
//              and the refusal in plain words. A sign-in that ran out says "Sign in again; your saved
//              answers are kept": answers are saved as they are given, so that is true.
// The API checks every step again: this only decides what the pages offer and say.
import { createHash } from 'node:crypto';
import { ApiNotFound } from '../api/client';
import { EditorRefused, type EditorApi, type EditorItem, type EditorVersion, type HistoryStep, type LinkAnswer, LinksChanged, NotAllowed, type PieceLink, type PieceLinks, SignInAgain, VersionChanged } from '../api/editor';
import type { Reader } from '../api/client';
import { formatSetDate } from '../approval-rules';
import { NOTE_MAX, hashFromHex, parseApprove, parseSendBack } from './form';
import { type StatusKey, statusOf } from './status';
import type { RosterOffice } from './writer';

export const REVIEW_LINKS = {
  queue: '/officer-area/approvals',
  review: (id: string) => `/officer-area/approvals/${id}`,
  publish: (id: string) => `/officer-area/approvals/${id}/publish`,
  takeDown: (id: string) => `/officer-area/approvals/${id}/take-down`,
} as const;

/** Under [Approve], always (Ross 11-12: approving does not publish). */
export const APPROVE_NOTE = 'This does not publish it yet. The Webmaster publishes it.';
/** Any of these steps refused for a sign-in that ran out (SPEC-v3 5.1, E4). */
export const SIGN_IN_AGAIN = 'Sign in again; your saved answers are kept.';
/** A hidden hash that is not one: the page was not this site's, or is very old. */
const OUT_OF_DATE = 'This page is out of date. Open the item again.';
/** At most this many answers are read from one post: the API takes at most 500 (link-gate.ts MAX_ANSWERS). */
export const MAX_ANSWERS = 500;

type Field = (name: string) => string | undefined;

const OFFICE_GROUP = 'nwfl-office-';

/** The Webmaster, or the Admin as backup (A1 requirePublisher). */
export function isPublisher(groups: readonly string[]): boolean {
  return groups.includes('nwfl-webmaster') || groups.includes('nwfl-admin');
}

export type ActingChoice = { kind: 'none'; label: string } | { kind: 'one'; office: RosterOffice } | { kind: 'pick'; offices: RosterOffice[] } | { kind: 'unknown' };

/** The roster could not be read (N1): an office holder's office is not known, so nothing is sent for none. */
export const OFFICES_UNKNOWN = 'We could not load your offices, so nothing was sent. Reload the page, then try again.';

/**
 * The offices a reviewer may act for: those they hold, in roster order. None: their role says who acted.
 * With the roster unread (undefined), an office holder's choice is unknown: never "none", which would act
 * for no office without saying so.
 */
export function actingChoice(groups: readonly string[], roster: readonly RosterOffice[] | undefined): ActingChoice {
  const held = new Set(groups.filter((g) => g.startsWith(OFFICE_GROUP)).map((g) => g.slice(OFFICE_GROUP.length)));
  if (roster === undefined && held.size > 0) return { kind: 'unknown' };
  const offices = (roster ?? []).filter((o) => held.has(o.slug));
  if (offices.length === 1) return { kind: 'one', office: offices[0] as RosterOffice };
  if (offices.length > 1) return { kind: 'pick', offices };
  return { kind: 'none', label: groups.includes('nwfl-admin') ? 'Admin' : groups.includes('nwfl-webmaster') ? 'Webmaster' : 'Officer' };
}

const PICK_OFFICE = 'Choose which of your offices you act for.';

/** The office acted for: the one chosen (it must be one held), the one held, or none. */
export function parseActing(field: Field, choice: ActingChoice): { ok: true; officeId: string } | { ok: false; error: string } {
  if (choice.kind === 'unknown') return { ok: false, error: OFFICES_UNKNOWN };
  if (choice.kind === 'none') return { ok: true, officeId: '' };
  if (choice.kind === 'one') return { ok: true, officeId: choice.office.id };
  const chosen = choice.offices.find((o) => o.id === field('acting'));
  return chosen === undefined ? { ok: false, error: PICK_OFFICE } : { ok: true, officeId: chosen.id };
}

const time = (at: Date | undefined) => at?.getTime() ?? Number.POSITIVE_INFINITY;
const oldestFirst = (when: (item: EditorItem) => Date | undefined) => (a: EditorItem, b: EditorItem) => time(when(a)) - time(when(b));

/** S6: what waits for approval (by when it was sent) and what is approved (by when), oldest first. */
export function reviewQueue(items: readonly EditorItem[]): { waiting: EditorItem[]; toPublish: EditorItem[] } {
  return {
    waiting: items.filter((i) => i.working?.status === 'ready').sort(oldestFirst((i) => i.working?.readyAt)),
    toPublish: items.filter((i) => i.working?.status === 'cleared').sort(oldestFirst((i) => i.working?.approvedAt)),
  };
}

/**
 * Whether the API kept part of this version from the caller (A3b workflow.ts versionMessage: with anything
 * withheld, no hash and no markup). Approve and Publish are bound to the hash, so such a reviewer cannot
 * do either (E4 round 2, P24: you cannot approve what you cannot see whole); Send back needs no hash.
 */
export function seesPartOnly(version: EditorVersion): boolean {
  return version.markupWithheld || version.contentHash.length === 0;
}

/** S7, S6: what a reviewer with part of a piece hidden is told, for a waiting piece and an approved one. */
export const PARTS_HIDDEN = {
  page: 'Parts of this piece are hidden from you, so an officer who can see all of it must approve it. You can still send it back.',
  pagePublish: 'Parts of this piece are hidden from you, so someone who can see all of it must publish it. You can still send it back.',
  queue: 'Parts are hidden from you, so an officer who can see all of it must approve it.',
  queuePublish: 'Parts are hidden from you, so someone who can see all of it must publish it.',
} as const;

/**
 * A step forged from a partial view (round 4): refused by the site before any call to the API, which only
 * now learns to refuse it too (A3B-HARDEN). Send back stays.
 */
/** The piece could not be read again to check the view (fail closed): nothing is sent. */
export const CHECK_FAILED = "We couldn't check this piece just now, so nothing was changed. Reload and try again.";

export const PARTIAL_REFUSED = {
  review: 'Nothing was changed: parts of this piece are hidden from you, so an officer who can see all of it must check its links and approve it.',
  publish: 'It was not published: parts of this piece are hidden from you, so someone who can see all of it must publish it.',
} as const;

/** SPEC-v3 2.4: what this person may approve (never what they edited, nor what they see only part of), and may publish. */
export function homeCounts(items: readonly EditorItem[]): { toApprove: number; toPublish: number } {
  return {
    toApprove: items.filter((i) => i.working?.status === 'ready' && i.working.callerMayApprove && !seesPartOnly(i.working)).length,
    toPublish: items.filter((i) => i.working?.status === 'cleared' && i.working.callerMayPublish && !seesPartOnly(i.working)).length,
  };
}

/** What S7 offers for the working version: answers, Approve, the Admin's break-glass, Publish, Send back. */
export interface Offers {
  /** Part of it is withheld from the caller: only Send back (PARTS_HIDDEN). */
  partial: boolean;
  answer: boolean;
  approve: boolean;
  breakGlass: boolean;
  publish: boolean;
  sendBack: boolean;
}

export function reviewOffers(version: EditorVersion | undefined, admin: boolean): Offers {
  const ready = version?.status === 'ready';
  const cleared = version?.status === 'cleared';
  const sendBack = ready || cleared;
  if (version === undefined || !sendBack) return { partial: false, answer: false, approve: false, breakGlass: false, publish: false, sendBack: false };
  if (seesPartOnly(version)) return { partial: true, answer: false, approve: false, breakGlass: false, publish: false, sendBack };
  return {
    partial: false,
    answer: ready && !version.callerEdited,
    approve: ready && version.callerMayApprove,
    breakGlass: ready && version.callerEdited && !version.callerMayApprove && admin,
    publish: cleared && version.callerMayPublish,
    sendBack,
  };
}

const pieces = (n: number) => (n === 0 ? 'No pieces' : n === 1 ? '1 piece' : `${n} pieces`);

/** The officer-area home's lines: the publish line for a publisher only. */
export function homeLines(counts: { toApprove: number; toPublish: number }, publisher: boolean): string[] {
  const approve = `${pieces(counts.toApprove)} ${counts.toApprove === 1 ? 'waits' : 'wait'} for your approval.`;
  const publish = `${pieces(counts.toPublish)} ${counts.toPublish === 1 ? 'is' : 'are'} approved and ready to publish.`;
  return publisher ? [approve, publish] : [approve];
}

export interface LinkRow extends PieceLink {
  /** Its place in the list: the form's fields are row-<index>, answer-<index>, note-<index>. */
  index: number;
  /** rowKey: posted in row-<index>, and the key of its note and its choice kept in the tab. */
  key: string;
  /** Its Open button (S5): a web link opens a new tab; a mail link writes an email in this one. */
  open: { newTab: boolean; words: string };
  /** The latest answer: yes, no, or none yet. */
  answer: 'yes' | 'no' | 'none';
  /** What the row is headed with: the link's words, else its address. */
  text: string;
}

/**
 * A row's key: the first 12 hex digits of SHA-256 over JSON [url, where]. Two rows of one address (the
 * text's and an event's) differ by where they are (N4); a list changed since the page was read is matched
 * row by row with it. 12 digits (48 bits) among at most 500 rows: a clash is about 1 in 2 billion.
 */
export function rowKey(link: Pick<PieceLink, 'url' | 'where'>): string {
  return createHash('sha256').update(JSON.stringify([link.url, link.where])).digest('hex').slice(0, 12);
}

const NEW_TAB = { newTab: true, words: 'Open the link (opens a new tab)' };

/** S5 (LINKS Q1): only http(s) opens a new tab; a mail link says whom it writes to; anything else just opens. */
function openOf(url: string): LinkRow['open'] {
  if (/^https?:/i.test(url)) return NEW_TAB;
  if (!/^mailto:/i.test(url)) return { newTab: false, words: 'Open the link' };
  const address = url.slice('mailto:'.length).replace(/\?.*$/s, '');
  let shown = address;
  try {
    shown = decodeURIComponent(address);
  } catch {
    // A broken escape: the address as written.
  }
  return { newTab: false, words: `Write an email to ${shown}` };
}

export function linkRows(links: readonly PieceLink[]): LinkRow[] {
  return links.map((link, index) => ({
    ...link,
    index,
    key: rowKey(link),
    open: openOf(link.url),
    answer: link.reviewerAnswer,
    text: link.label !== '' ? link.label : link.url,
  }));
}

/**
 * The latest answer in words, with who gave it, by role, and worded from what the gate says of the link
 * (`accepted`), so the row never says "checked" while Approve still waits for it:
 *   - a yes the gate accepts is "Checked by";
 *   - a yes it does not accept (the link checker found the link broken, and no yes with a note came
 *     after that) says so, and what it needs;
 *   - with no answer, a link the link checker's OK let through is not "Not checked yet".
 */
export function answerWords(row: LinkRow): string {
  if (row.answer === 'no') return `${row.answeredByLabel} answered no: it does not show the right page.`;
  if (row.answer === 'yes') {
    if (row.accepted) return `Checked by ${row.answeredByLabel}: it shows the right page.`;
    const why = row.machine?.verdict === 'drop' ? ': the link checker found it broken, so it needs a Yes with a note saying why it is right' : '';
    return `${row.answeredByLabel} answered yes, but that does not count yet${why}.`;
  }
  return row.accepted ? 'No person has answered: the link checker found it working, and that counts.' : 'Not checked yet.';
}

/** How long ago, in plain words: under an hour, then hours, then days. */
function ago(at: Date, now: Date): string {
  const hours = Math.floor(Math.max(0, now.getTime() - at.getTime()) / 3_600_000);
  if (hours < 1) return 'less than an hour ago';
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

/**
 * L-ITEM: the link checker's latest verdict on the row, and its age, in plain words. Whether an OK still
 * counts is the gate's word (`accepted`, by the API's database clock), never this server's clock: `now`
 * only words the age.
 */
export function machineWords(row: LinkRow, now: Date): string {
  const machine = row.machine;
  if (machine === undefined) return row.loginWalled ? 'The link checker does not open links that need a sign-in: a person checks it.' : 'The link checker has not checked it yet.';
  const when = ago(machine.checkedAt, now);
  const reasons = machine.reasons.length > 0 ? ` (${machine.reasons.join(', ')})` : '';
  // A DROP the gate accepts was lifted by a yes with a note: said as done, never asked for again.
  if (machine.verdict === 'drop') {
    return row.accepted
      ? `The link checker found it broken ${when}${reasons}; a person's yes with a note lets it through.`
      : `The link checker found it broken ${when}${reasons}. Answer Yes only with a note saying why it is right.`;
  }
  if (machine.verdict === 'confirm') return `The link checker could not tell ${when}${reasons}: a person checks it.`;
  // An OK on a site the checker never requests was not given by looking (the gate never counts it): never "found it working", never aged out.
  if (row.neverFetched && !row.loginWalled) return row.answer === 'none' ? 'The link checker does not check this site: a person opens it and answers.' : 'The link checker does not check this site.';
  // An OK with no person's answer and no acceptance does not count: on a sign-in link it never does; on any other it has aged out.
  const lapsed =
    row.answer !== 'none' || row.accepted
      ? ''
      : row.loginWalled
        ? ' That does not count for a link that needs a sign-in: a person checks it.'
        : ' That no longer counts (an OK counts for 7 days): it checks the link again, or a person answers.';
  return `The link checker found it working ${when}.${lapsed}`;
}

/** "2 of 3 links checked.": the links the gate accepts (a yes, or the link checker's recent OK). */
export function linksSummary(links: readonly PieceLink[]): string {
  if (links.length === 0) return 'This piece has no links.';
  const checked = links.filter((l) => l.accepted).length;
  return `${checked} of ${links.length} ${links.length === 1 ? 'link' : 'links'} checked.`;
}

/**
 * The links panel's words: its summary, and what to do. To a reviewer who sees only part of the piece the
 * hidden part may hold links, so they get neither a count nor "no links" (round 3), whatever their list holds.
 */
export function linksPanel(links: readonly PieceLink[], offers: Offers, ready: boolean): { summary: string; lead?: string } {
  if (offers.partial) return { summary: 'An officer who can see all of this piece checks its links.' };
  const summary = linksSummary(links);
  if (links.length === 0) return { summary };
  if (offers.answer) return { summary, lead: 'Open each link, then say whether it shows the right page. Each answer is saved when you press Save my answers.' };
  return { summary, lead: ready ? 'You changed this version, so someone else must check its links.' : 'The answers given before it was approved.' };
}

/** What the links form held, by row key: the answers chosen, the notes, and each row's place (from 1). */
export interface KeptAnswers {
  answers: Record<string, 'yes' | 'no'>;
  notes: Record<string, string>;
  places: Record<string, number>;
}

/** An answer as the form posts it: by row, not by address (S1). */
export interface RowAnswer {
  index: number;
  key: string;
  yes: boolean;
  note: string;
}

/** The rows posted, each with its key, its choice and its note; at most MAX_ANSWERS rows are read. */
function readRows(field: Field): { index: number; key: string; answer: string | undefined; note: string }[] {
  const rows = [];
  for (let index = 0; index < MAX_ANSWERS; index += 1) {
    const key = field(`row-${index}`);
    if (key === undefined) break;
    rows.push({ index, key, answer: field(`answer-${index}`), note: field(`note-${index}`) ?? '' });
  }
  return rows;
}

function keptAnswers(rows: ReturnType<typeof readRows>): KeptAnswers {
  const kept: KeptAnswers = { answers: {}, notes: {}, places: {} };
  for (const row of rows) {
    kept.places[row.key] = row.index + 1;
    if (row.note !== '') kept.notes[row.key] = row.note;
    if (row.answer === 'yes' || row.answer === 'no') kept.answers[row.key] = row.answer;
  }
  return kept;
}

/** The links form: each row answered Yes or No (rows left alone are not sent), its note capped. */
export function parseAnswers(field: Field): { ok: true; value: { answers: RowAnswer[] } } | { ok: false; errors: Record<string, string>; values: KeptAnswers } {
  const rows = readRows(field);
  const errors: Record<string, string> = {};
  const answers: RowAnswer[] = [];
  for (const row of rows) {
    if (row.answer !== 'yes' && row.answer !== 'no') continue;
    if (row.note.trim().length > NOTE_MAX) errors[`note-${row.index}`] = 'This note is too long: at most 2,000 characters.';
    answers.push({ index: row.index, key: row.key, yes: row.answer === 'yes', note: row.note.trim() });
  }
  if (answers.length === 0) errors['answers'] = 'Choose Yes or No for at least one link.';
  return Object.keys(errors).length === 0 ? { ok: true, value: { answers } } : { ok: false, errors, values: keptAnswers(rows) };
}

/** The rows' answers as the API takes them, by address from the list read now, or undefined when a row is not that list's. */
function mapRows(answers: readonly RowAnswer[], list: PieceLinks): LinkAnswer[] | undefined {
  const mapped: LinkAnswer[] = [];
  for (const answer of answers) {
    const link = list.links[answer.index];
    if (link === undefined || rowKey(link) !== answer.key) return undefined;
    mapped.push({ url: link.url, yes: answer.yes, note: answer.note });
  }
  return mapped;
}

/**
 * The list of problems at the top (N2): each a link to its field, but only to a field the page shows (a
 * forged step can name one it does not): `present` holds the ids shown. "answers" is the links panel.
 */
export function errorList(errors: Record<string, string>, present: ReadonlySet<string>): { href?: string; text: string }[] {
  return Object.entries(errors).map(([field, text]) => {
    const id = field === 'answers' ? 'links' : field;
    return present.has(id) ? { href: `#${id}`, text } : { text };
  });
}

/** The edition named in the API's refusal for an edition frozen for print, if that is the refusal. */
export function frozenEditionOf(reason: string): string | undefined {
  return /^(.+) is already frozen for print:/.exec(reason)?.[1];
}

/** The steps that write a version's text. */
const WRITING = new Set(['create', 'save', 'autosave']);

/** Whether the Admin wrote this version for the office (SPEC-v3 4: "Entered for <office> by the Admin"). */
export function enteredForOffice(steps: readonly HistoryStep[], versionNumber: number): boolean {
  return steps.some((s) => WRITING.has(s.action) && s.actorLabel === 'Admin' && (s.versionNumber === versionNumber || (s.action === 'create' && versionNumber === 1)));
}

/** When and by whom (by role) the item was last taken down. */
export function takenDown(steps: readonly HistoryStep[]): { by: string; on?: string } | undefined {
  const last = steps.filter((s) => s.action === 'withdraw').at(-1);
  if (last === undefined) return undefined;
  return { by: last.actorLabel.trim() || 'someone', ...(last.at === undefined ? {} : { on: formatSetDate(last.at) }) };
}

const SENT_BACK = 'Sent back to the writer with your note.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The roles an answer by this viewer is given under, as the API names who answered (by role, never by name):
 * the office acted for, or with none held, the Admin, the Webmaster or an officer. Offices unread: none known.
 */
export function answerLabels(choice: ActingChoice): string[] {
  if (choice.kind === 'one') return [choice.office.title];
  if (choice.kind === 'pick') return choice.offices.map((o) => o.title);
  return choice.kind === 'none' ? [choice.label] : [];
}

/**
 * A step just done on a piece: its words, and how the piece read from the API shows that it happened
 * (E7B-N5). The redirect's ?done= only names the step; the address alone never says it. "Your answers"
 * needs an answer on the piece given under one of this viewer's roles (WEB-SMALL-1 fix round 1, S2).
 */
const DONE: Record<string, { text: string; shown: (status: StatusKey, links: readonly PieceLink[], mine: readonly string[]) => boolean }> = {
  approved: { text: `Approved. ${APPROVE_NOTE}`, shown: (status) => status === 'cleared' || status === 'published_change_cleared' },
  published: { text: 'Published. It is on the website now.', shown: (status) => status === 'published' },
  'taken-down': { text: 'Taken down. It is no longer on the website.', shown: (status) => status === 'taken_down' },
  answers: { text: 'Your answers are saved.', shown: (_status, links, mine) => links.some((l) => l.reviewerAnswer !== 'none' && l.answeredByLabel !== '' && mine.includes(l.answeredByLabel)) },
};

/**
 * The words for a step just done on this piece, from the redirect's ?done=: only when the piece as read
 * from the API (its status, and its links' answers) shows the step. A piece that was not read says nothing.
 * `mine`: the viewer's roles (answerLabels).
 */
export function doneText(params: URLSearchParams, item: EditorItem | undefined, links: readonly PieceLink[], mine: readonly string[]): string | undefined {
  const done = params.get('done') ?? '';
  if (item === undefined || !Object.hasOwn(DONE, done)) return undefined;
  const step = DONE[done]!;
  return step.shown(statusOf(item).key, links, mine) ? step.text : undefined;
}

/**
 * The queue's words for a step just done: only "sent back", the one step that lands on the queue, and only
 * when the piece the address names (?done=sent-back&id=<id>) reads from the API as sent back (WEB-SMALL-1
 * fix round 1, B1). No id, a malformed one, a piece that cannot be read, or nothing to read with: nothing.
 */
export async function queueDoneText(params: URLSearchParams, read: ((id: string) => Promise<EditorItem>) | undefined): Promise<string | undefined> {
  const id = params.get('id') ?? '';
  if (params.get('done') !== 'sent-back' || !UUID.test(id) || read === undefined) return undefined;
  try {
    return statusOf(await read(id)).key === 'sent_back' ? SENT_BACK : undefined;
  } catch {
    return undefined;
  }
}

/** What the review page and the confirm pages keep of what was typed, for the page again. */
export interface Kept extends KeptAnswers {
  /** The send-back note. */
  note: string;
  /** The break-glass reason. */
  reason: string;
}

export type Outcome =
  | { redirect: string }
  | {
      status: number;
      /** Form problems, by field, for the list at the top. */
      errors?: Record<string, string>;
      /** A refusal or a plain message, in words. */
      notice?: string;
      /** The sign-in ran out: Sign in again (nothing typed is lost). */
      signIn?: true;
      /** The edition this piece is for is frozen for print: send it back. */
      frozen?: string;
      /** The item is no longer there. */
      gone?: true;
      /** The site could not reach its records. */
      unavailable?: true;
      /** Answers were sent and some kept: the tab drops the choices it held (N3). */
      saved?: true;
      /** The list of links changed: shown again, its choices asked for again (the tab drops its own). */
      relisted?: true;
      kept?: Kept;
    };

/** What was typed, for the page again: the link answers and notes by row key, the note, the reason. */
function keptOf(field: Field): Kept {
  return { ...keptAnswers(readRows(field)), note: field('note') ?? '', reason: field('reason') ?? '' };
}

/** The tab's posts are capped (the review page's FORM_LIMIT): what a person sees when theirs is over it. */
export const TOO_LARGE =
  'Too much was sent at once, so nothing was saved. This happens with many long notes. What you typed is shown again below; if it is not, use your browser’s Back button to find it. Then shorten the longest notes, or save your answers a few at a time.';

const LIST_AGAIN = 'The links of this piece changed since you opened the page, so nothing was saved. Here is the list again: your notes are kept; choose your answers again.';

/** S2: answers the API did not keep (ConfirmLinksResponse.not_in_piece), in words; `others` were kept. */
function notKept(count: number, others: number, approving: boolean): string {
  const lead = count === 1 ? '1 answer was not saved: that link is' : `${count} answers were not saved: those links are`;
  const rest = others === 0 ? '' : others === 1 ? ' Your other answer is saved.' : ' Your other answers are saved.';
  return `${lead} no longer in this piece. The list below is the current one.${rest}${approving ? ' It was not approved.' : ''}`;
}

/**
 * What a review page does when it cannot read the piece (A3b fix round): "not found" and "not yours"
 * (PERMISSION_DENIED, which the API gives a holder who reviews nothing for a missing item too) are the
 * same plain not-found page, so no answer tells which ids exist; else sign in again, or unavailable.
 */
export function loadFailure(error: unknown): 'not-found' | 'sign-in' | 'unavailable' {
  if (error instanceof ApiNotFound || error instanceof NotAllowed) return 'not-found';
  return error instanceof SignInAgain ? 'sign-in' : 'unavailable';
}

const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

/** A refused step in words: "It was not approved: <why>." */
function refused(error: unknown, what: 'approved' | 'published' | 'sent back' | 'saved' | 'taken down', again: string, kept?: Kept): Outcome {
  const lead = what === 'saved' ? 'Your answers were not saved' : `It was not ${what}`;
  const keep = kept === undefined ? {} : { kept };
  if (error instanceof SignInAgain) return { status: 401, signIn: true, notice: SIGN_IN_AGAIN, ...keep };
  if (error instanceof ApiNotFound) return { status: 404, gone: true };
  if (error instanceof VersionChanged) return { status: 409, notice: `${lead}: it changed since you opened it. Here it is again: read it, then ${again}.`, ...keep };
  if (error instanceof NotAllowed) return { status: 403, notice: `${lead}: ${sentence(error.reason || 'you cannot do this. Ask the Webmaster or the Admin')}`, ...keep };
  if (error instanceof EditorRefused) {
    const frozen = frozenEditionOf(error.reason);
    if (frozen !== undefined) return { status: 409, frozen, notice: `${lead}: ${sentence(error.reason)}`, ...keep };
    return { status: 409, notice: `${lead}: ${sentence(error.reason)}`, ...keep };
  }
  return { status: 503, unavailable: true, notice: `${lead}: the site could not reach its records just now. Try again in a few minutes.`, ...keep };
}

const signInAgain = (kept: Kept): Outcome => ({ status: 401, signIn: true, notice: SIGN_IN_AGAIN, kept });

/**
 * S7's one form, its buttons told apart by `step`: Save my answers, Approve, the Admin's break-glass
 * (Approve my own change, with the reason), Send back. Approve pressed with links answered in the form
 * saves those answers first, as the reviewer means them, and approves only once they are kept.
 */
export async function runReview(api: EditorApi, reader: Reader | undefined, itemId: string, given: Field, choice: ActingChoice): Promise<Outcome> {
  const kept = keptOf(given);
  if (reader === undefined) return signInAgain(kept);
  const step = given('step');
  if (step !== 'links' && step !== 'approve' && step !== 'break-glass' && step !== 'send-back') return { status: 400, notice: OUT_OF_DATE, kept };
  // Round 4: the piece read again as the post came; from a view with part of it hidden, only Send back.
  // Fail closed: a piece that cannot be read sends nothing (a sign-in that ran out, or one gone, says so).
  if (step !== 'send-back') {
    let current: EditorItem;
    try {
      current = await api.getWorkingItem(reader, itemId);
    } catch (error) {
      if (error instanceof SignInAgain) return signInAgain(kept);
      if (error instanceof ApiNotFound) return { status: 404, gone: true };
      return { status: 503, notice: CHECK_FAILED, kept };
    }
    if (current.working !== undefined && seesPartOnly(current.working)) return { status: 409, notice: PARTIAL_REFUSED.review, kept };
  }
  // Break-glass has its own button: its tick is the button.
  const field: Field = (name) => (name === 'break_glass' ? (step === 'break-glass' ? 'yes' : undefined) : given(name));
  const acting = parseActing(field, choice);
  const actingError = acting.ok ? {} : { acting: acting.error };
  const actingAsOfficeId = acting.ok ? acting.officeId : '';

  // The rows may differ now: the notes stay with their rows (by key), and the answers are asked for again.
  const listAgain: Outcome = { status: 409, relisted: true, notice: LIST_AGAIN, kept: { ...kept, answers: {} } };

  /**
   * The answers chosen in the form, kept: undefined when they all are, else the page again. The rows are
   * mapped to addresses from the list read now, only when it is the list the page showed (its hash).
   */
  const saveAnswers = async (answers: RowAnswer[], approving: boolean): Promise<Outcome | undefined> => {
    const linksSha256 = hashFromHex(field('links_hash'));
    if (linksSha256 === undefined) return { status: 409, notice: OUT_OF_DATE, kept };
    try {
      const list = await api.getItemLinks(reader, itemId);
      const mapped = Buffer.from(list.linksSha256).equals(Buffer.from(linksSha256)) ? mapRows(answers, list) : undefined;
      if (mapped === undefined) return listAgain;
      const { notInPiece } = await api.confirmLinks(reader, { itemId, linksSha256, answers: mapped, actingAsOfficeId });
      if (notInPiece.length === 0) return undefined;
      const others = new Set(mapped.map((a) => a.url)).size - notInPiece.length;
      return { status: 409, saved: true, notice: notKept(notInPiece.length, others, approving), kept: { ...kept, answers: {} } };
    } catch (error) {
      if (error instanceof LinksChanged) return listAgain;
      return refused(error, 'saved', 'answer', kept);
    }
  };

  if (step === 'links') {
    const parsed = parseAnswers(field);
    if (hashFromHex(field('links_hash')) === undefined) return { status: 409, notice: OUT_OF_DATE, kept };
    if (!parsed.ok || !acting.ok) return { status: 400, errors: { ...actingError, ...(parsed.ok ? {} : parsed.errors) }, kept };
    return (await saveAnswers(parsed.value.answers, false)) ?? { redirect: `${REVIEW_LINKS.review(itemId)}?done=answers#links` };
  }

  if (step === 'approve' || step === 'break-glass') {
    const parsed = parseApprove(field);
    if (!parsed.ok && parsed.errors['hash'] !== undefined) return { status: 409, notice: OUT_OF_DATE, kept };
    const answered = parseAnswers(field);
    if (!parsed.ok || !acting.ok || (!answered.ok && answered.errors['answers'] === undefined)) {
      const answerErrors = answered.ok ? {} : Object.fromEntries(Object.entries(answered.errors).filter(([key]) => key !== 'answers'));
      return { status: 400, errors: { ...actingError, ...answerErrors, ...(parsed.ok ? {} : (parsed.errors as Record<string, string>)) }, kept };
    }
    if (answered.ok) {
      const unsaved = await saveAnswers(answered.value.answers, true);
      if (unsaved !== undefined) return unsaved;
    }
    try {
      await api.approve(reader, { itemId, ...parsed.value, actingAsOfficeId });
      return { redirect: `${REVIEW_LINKS.review(itemId)}?done=approved` };
    } catch (error) {
      return refused(error, 'approved', 'approve', kept);
    }
  }

  const parsed = parseSendBack(field);
  if (!parsed.ok || !acting.ok) return { status: 400, errors: { ...actingError, ...(parsed.ok ? {} : (parsed.errors as Record<string, string>)) }, kept };
  try {
    await api.sendBack(reader, { itemId, note: parsed.value.note, actingAsOfficeId });
    return { redirect: `${REVIEW_LINKS.queue}?done=sent-back&id=${encodeURIComponent(itemId)}` };
  } catch (error) {
    return refused(error, 'sent back', 'send it back', kept);
  }
}

/**
 * The Publish confirm page's post: the hash seen, and the tick that puts a taken-down item back. `item` is
 * the piece as the page read it for this post; not read, nothing is sent (fail closed).
 */
export async function runPublish(api: EditorApi, reader: Reader | undefined, item: EditorItem | undefined, field: Field): Promise<Outcome> {
  if (reader === undefined) return signInAgain(keptOf(field));
  if (item === undefined) return { status: 503, notice: CHECK_FAILED };
  if (item.working !== undefined && seesPartOnly(item.working)) return { status: 409, notice: PARTIAL_REFUSED.publish };
  const contentHash = hashFromHex(field('hash'));
  if (contentHash === undefined) return { status: 409, notice: OUT_OF_DATE };
  const republishWithdrawn = field('republish') === 'yes';
  if (item.state === 'withdrawn' && !republishWithdrawn) return { status: 400, errors: { republish: 'Tick the box to put it back on the website.' } };
  try {
    await api.publish(reader, { itemId: item.id, contentHash, republishWithdrawn });
    return { redirect: `${REVIEW_LINKS.review(item.id)}?done=published` };
  } catch (error) {
    return refused(error, 'published', 'publish');
  }
}

/** The Take down confirm page's post (S9). */
export async function runTakeDown(api: EditorApi, reader: Reader | undefined, itemId: string): Promise<Outcome> {
  if (reader === undefined) return signInAgain({ answers: {}, notes: {}, places: {}, note: '', reason: '' });
  try {
    await api.withdraw(reader, itemId);
    return { redirect: `${REVIEW_LINKS.review(itemId)}?done=taken-down` };
  } catch (error) {
    return refused(error, 'taken down', 'take it down');
  }
}
