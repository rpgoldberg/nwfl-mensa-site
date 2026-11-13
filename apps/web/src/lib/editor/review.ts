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
//   links      (S7, M3) each link with its latest answer and who gave it, "N of M links checked"; answers
//              save per link, bound to the list's hash: a list changed since it was read is shown again
//              with the notes kept (by address), and the answers asked for again.
//   posts      each answered by a redirect (post/redirect/get) or by the page again, with what was typed
//              and the refusal in plain words. A sign-in that ran out says "Sign in again; your saved
//              answers are kept": answers are saved as they are given, so that is true.
// The API checks every step again: this only decides what the pages offer and say.
import { ApiNotFound } from '../api/client';
import { EditorRefused, type EditorApi, type EditorItem, type HistoryStep, type LinkAnswer, LinksChanged, NotAllowed, type PieceLink, SignInAgain, VersionChanged } from '../api/editor';
import type { Reader } from '../api/client';
import { formatSetDate } from '../approval-rules';
import { NOTE_MAX, hashFromHex, parseApprove, parseSendBack } from './form';
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

export type ActingChoice = { kind: 'none'; label: string } | { kind: 'one'; office: RosterOffice } | { kind: 'pick'; offices: RosterOffice[] };

/** The offices a reviewer may act for: those they hold, in roster order. None: their role says who acted. */
export function actingChoice(groups: readonly string[], roster: readonly RosterOffice[]): ActingChoice {
  const held = new Set(groups.filter((g) => g.startsWith(OFFICE_GROUP)).map((g) => g.slice(OFFICE_GROUP.length)));
  const offices = roster.filter((o) => held.has(o.slug));
  if (offices.length === 1) return { kind: 'one', office: offices[0] as RosterOffice };
  if (offices.length > 1) return { kind: 'pick', offices };
  return { kind: 'none', label: groups.includes('nwfl-admin') ? 'Admin' : groups.includes('nwfl-webmaster') ? 'Webmaster' : 'Officer' };
}

const PICK_OFFICE = 'Choose which of your offices you act for.';

/** The office acted for: the one chosen (it must be one held), the one held, or none. */
export function parseActing(field: Field, choice: ActingChoice): { ok: true; officeId: string } | { ok: false; error: string } {
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

/** SPEC-v3 2.4: what this person may approve (never what they edited), and may publish. */
export function homeCounts(items: readonly EditorItem[]): { toApprove: number; toPublish: number } {
  return {
    toApprove: items.filter((i) => i.working?.status === 'ready' && i.working.callerMayApprove).length,
    toPublish: items.filter((i) => i.working?.status === 'cleared' && i.working.callerMayPublish).length,
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
  /** Its place in the list: the form's fields are url-<index>, answer-<index>, note-<index>. */
  index: number;
  /** The latest answer: yes, no, or none yet. */
  answer: 'yes' | 'no' | 'none';
  /** What the row is headed with: the link's words, else its address. */
  text: string;
}

export function linkRows(links: readonly PieceLink[]): LinkRow[] {
  return links.map((link, index) => ({
    ...link,
    index,
    answer: link.accepted ? 'yes' : link.answeredByLabel !== '' ? 'no' : 'none',
    text: link.label !== '' ? link.label : link.url,
  }));
}

/** The latest answer in words, with who gave it, by role. */
export function answerWords(row: LinkRow): string {
  if (row.answer === 'yes') return `Checked by ${row.answeredByLabel}: it shows the right page.`;
  if (row.answer === 'no') return `${row.answeredByLabel} answered no: it does not show the right page.`;
  return 'Not checked yet.';
}

/** "2 of 3 links checked." */
export function linksSummary(links: readonly PieceLink[]): string {
  if (links.length === 0) return 'This piece has no links.';
  const checked = links.filter((l) => l.answeredByLabel !== '').length;
  return `${checked} of ${links.length} ${links.length === 1 ? 'link' : 'links'} checked.`;
}

/** What the links form held: answers and notes by address. */
export interface KeptAnswers {
  answers: Record<string, 'yes' | 'no'>;
  notes: Record<string, string>;
}

/** The links form: each row answered Yes or No (rows left alone are not sent), its note capped. */
export function parseAnswers(field: Field): { ok: true; value: { answers: LinkAnswer[] } } | { ok: false; errors: Record<string, string>; values: KeptAnswers } {
  const values: KeptAnswers = { answers: {}, notes: {} };
  const errors: Record<string, string> = {};
  const answers: LinkAnswer[] = [];
  for (let i = 0; i < MAX_ANSWERS; i += 1) {
    const url = field(`url-${i}`);
    if (url === undefined) break;
    const answer = field(`answer-${i}`);
    const note = field(`note-${i}`) ?? '';
    if (note !== '') values.notes[url] = note;
    if (answer !== 'yes' && answer !== 'no') continue;
    values.answers[url] = answer;
    if (note.trim().length > NOTE_MAX) errors[`note-${i}`] = 'This note is too long: at most 2,000 characters.';
    answers.push({ url, yes: answer === 'yes', note: note.trim() });
  }
  if (answers.length === 0) errors['answers'] = 'Choose Yes or No for at least one link.';
  return Object.keys(errors).length === 0 ? { ok: true, value: { answers } } : { ok: false, errors, values };
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

const DONE: Record<string, string> = {
  approved: `Approved. ${APPROVE_NOTE}`,
  published: 'Published. It is on the website now.',
  'taken-down': 'Taken down. It is no longer on the website.',
  answers: 'Your answers are saved.',
  'sent-back': 'Sent back to the writer with your note.',
};

/** The words for a step just done, from the redirect's ?done=. */
export function doneText(params: URLSearchParams): string | undefined {
  const done = params.get('done') ?? '';
  return Object.hasOwn(DONE, done) ? DONE[done] : undefined;
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
      kept?: Kept;
    };

/** What was typed, for the page again: the link answers and notes by address, the note, the reason. */
function keptOf(field: Field): Kept {
  const answers: Record<string, 'yes' | 'no'> = {};
  const notes: Record<string, string> = {};
  for (let i = 0; i < MAX_ANSWERS; i += 1) {
    const url = field(`url-${i}`);
    if (url === undefined) break;
    const answer = field(`answer-${i}`);
    const note = field(`note-${i}`) ?? '';
    if (answer === 'yes' || answer === 'no') answers[url] = answer;
    if (note !== '') notes[url] = note;
  }
  return { answers, notes, note: field('note') ?? '', reason: field('reason') ?? '' };
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
  // Break-glass has its own button: its tick is the button.
  const field: Field = (name) => (name === 'break_glass' ? (step === 'break-glass' ? 'yes' : undefined) : given(name));
  const acting = parseActing(field, choice);
  const actingError = acting.ok ? {} : { acting: acting.error };
  const actingAsOfficeId = acting.ok ? acting.officeId : '';

  /** The answers chosen in the form, kept: undefined when they are, else the page again. */
  const saveAnswers = async (answers: LinkAnswer[]): Promise<Outcome | undefined> => {
    const linksSha256 = hashFromHex(field('links_hash'));
    if (linksSha256 === undefined) return { status: 409, notice: OUT_OF_DATE, kept };
    try {
      await api.confirmLinks(reader, { itemId, linksSha256, answers, actingAsOfficeId });
      return undefined;
    } catch (error) {
      if (error instanceof LinksChanged) {
        // The rows may differ now: the notes stay with their addresses, and the answers are asked for again.
        return {
          status: 409,
          notice: 'The links of this piece changed since you opened the page, so nothing was saved. Here is the list again: your notes are kept; choose your answers again.',
          kept: { ...kept, answers: {} },
        };
      }
      return refused(error, 'saved', 'answer', kept);
    }
  };

  if (step === 'links') {
    const parsed = parseAnswers(field);
    if (hashFromHex(field('links_hash')) === undefined) return { status: 409, notice: OUT_OF_DATE, kept };
    if (!parsed.ok || !acting.ok) return { status: 400, errors: { ...actingError, ...(parsed.ok ? {} : parsed.errors) }, kept };
    return (await saveAnswers(parsed.value.answers)) ?? { redirect: `${REVIEW_LINKS.review(itemId)}?done=answers#links` };
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
      const unsaved = await saveAnswers(answered.value.answers);
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
    return { redirect: `${REVIEW_LINKS.queue}?done=sent-back` };
  } catch (error) {
    return refused(error, 'sent back', 'send it back', kept);
  }
}

/** The Publish confirm page's post: the hash seen, and the tick that puts a taken-down item back. */
export async function runPublish(api: EditorApi, reader: Reader | undefined, item: EditorItem, field: Field): Promise<Outcome> {
  if (reader === undefined) return signInAgain(keptOf(field));
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
  if (reader === undefined) return signInAgain({ answers: {}, notes: {}, note: '', reason: '' });
  try {
    await api.withdraw(reader, itemId);
    return { redirect: `${REVIEW_LINKS.review(itemId)}?done=taken-down` };
  } catch (error) {
    return refused(error, 'taken down', 'take it down');
  }
}
