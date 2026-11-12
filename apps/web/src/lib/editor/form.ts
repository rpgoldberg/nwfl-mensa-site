// EDITOR E2: the officer editor's forms, read on the server (spec section 2: the pages work with no
// script, post/redirect/get). Each field is checked and capped here, each problem is a plain-words
// error keyed by its field (for the list at the top, each linking to its field), and what was typed is
// handed back so the page can show it again. The API checks everything again.
//
// The text box holds at most 48 KiB, so the whole edit form fits EDIT_FORM_LIMIT, under Astro's 64 KiB
// body cap (astro.config.mjs), when posted as multipart/form-data. URL-encoded, the same text can
// swell threefold: the edit form must post multipart (readForm in src/lib/form.ts reads both).
import type { EditorItem, KindName, Problem, Targets, VisibilityName } from '../api/editor';

/** The most of the text box, in UTF-8 bytes. */
export const MARKUP_MAX_BYTES = 48 * 1024;
/** readForm's cap for the edit form: the fullest form, posted as multipart, fits; under Astro's 64 KiB. */
export const EDIT_FORM_LIMIT = 56 * 1024;
/** content_version.title: 1 to 200 letters. */
export const TITLE_MAX = 200;
/** One line, always public. */
export const SUMMARY_MAX = 300;
/** The API's MAX_NOTE, for a send-back note and a break-glass reason (counted as the API counts it). */
export const NOTE_MAX = 2000;

/** The kinds an officer writes on day 1 (spec 1.5). */
export const DAY_ONE_KINDS: readonly KindName[] = ['announcement', 'article', 'president_report'];
const VISIBILITIES: readonly VisibilityName[] = ['public', 'members', 'officers'];

type Field = (name: string) => string | undefined;
export type Parsed<T, V> = { ok: true; value: T } | { ok: false; errors: Partial<Record<string, string>>; values: V };

/** Members-only markup, which the API refuses in a title or summary (both are always public). */
const MARKER = /:members\[|^\s*:::/m;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const letters = (text: string) => [...text].length;
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const ticked = (value: string | undefined) => value === 'yes' || value === 'on';
const result = <T, V>(errors: Partial<Record<string, string>>, value: T, values: V): Parsed<T, V> => (Object.keys(errors).length === 0 ? { ok: true, value } : { ok: false, errors, values });

function titleError(title: string): string | undefined {
  if (title === '') return 'Give it a title.';
  if (letters(title) > TITLE_MAX) return `The title is too long: at most ${TITLE_MAX} letters.`;
  if (MARKER.test(title)) return 'A title is always public: put members-only words in the text.';
  return undefined;
}

export interface NewItem {
  kind: KindName;
  officeId: string;
  title: string;
}

/** S3, a new item. `offices`: those the officer may post as; one is taken whatever was posted. */
export function parseNewItem(field: Field, offices: readonly { id: string }[]): Parsed<NewItem, { kind: string; office: string; title: string }> {
  const values = { kind: field('kind') ?? '', office: field('office') ?? '', title: field('title') ?? '' };
  const errors: Partial<Record<string, string>> = {};
  const kind = DAY_ONE_KINDS.find((k) => k === values.kind);
  if (kind === undefined) errors['kind'] = 'Choose what it is.';
  const office = offices.length === 1 ? offices[0] : offices.find((o) => o.id === values.office);
  if (offices.length === 0) errors['office'] = 'You hold no office that can post news.';
  else if (office === undefined) errors['office'] = 'Choose the office you are posting as.';
  const title = oneLine(values.title);
  const titleProblem = titleError(title);
  if (titleProblem) errors['title'] = titleProblem;
  return result(errors, { kind: kind as KindName, officeId: office?.id as string, title }, values);
}

export interface Draft {
  title: string;
  summary: string;
  visibility: VisibilityName;
  markup: string;
}

/** S4, the edit form. A form whose text never arrived is refused: saving it would empty the body. */
export function parseDraft(field: Field): Parsed<Draft, { title: string; summary: string; visibility: string; markup: string }> {
  const posted = field('markup');
  const values = { title: field('title') ?? '', summary: field('summary') ?? '', visibility: field('visibility') ?? '', markup: posted ?? '' };
  const errors: Partial<Record<string, string>> = {};
  const title = oneLine(values.title);
  const titleProblem = titleError(title);
  if (titleProblem) errors['title'] = titleProblem;
  const summary = oneLine(values.summary);
  if (letters(summary) > SUMMARY_MAX) errors['summary'] = `The summary is too long: at most ${SUMMARY_MAX} letters.`;
  else if (MARKER.test(summary)) errors['summary'] = 'A summary is always public: put members-only words in the text.';
  const visibility = VISIBILITIES.find((v) => v === values.visibility);
  if (visibility === undefined) errors['visibility'] = 'Choose who can read it.';
  const markup = values.markup.replace(/\r\n?/g, '\n');
  if (posted === undefined) errors['markup'] = 'The text did not reach us. Nothing was saved: please press Save draft again.';
  else if (new TextEncoder().encode(markup).byteLength > MARKUP_MAX_BYTES) {
    errors['markup'] = 'The text is too long: at most 48 KiB (about 49,000 letters). Shorten it, or split it into two items.';
  }
  return result(errors, { title, summary, visibility: visibility as VisibilityName, markup }, values);
}

/** S7, send back: a note of 1 to NOTE_MAX characters. */
export function parseSendBack(field: Field): Parsed<{ note: string }, { note: string }> {
  const values = { note: field('note') ?? '' };
  const note = values.note.trim();
  const errors: Partial<Record<string, string>> = {};
  if (note === '') errors['note'] = 'Write a note for the author.';
  else if (note.length > NOTE_MAX) errors['note'] = 'The note is too long: at most 2,000 characters.';
  return result(errors, { note }, values);
}

/** A content hash for a hidden field: 64 lower-case hex digits ('' for none). */
export function hashHex(hash: Uint8Array): string {
  return [...hash].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A hidden field's hash, or undefined when it is not 64 lower-case hex digits. */
export function hashFromHex(hex: string | undefined): Uint8Array | undefined {
  if (hex === undefined || !/^[0-9a-f]{64}$/.test(hex)) return undefined;
  return Uint8Array.from(hex.match(/../g) as string[], (pair) => parseInt(pair, 16));
}

export interface Approval {
  contentHash: Uint8Array;
  breakGlass?: { reason: string };
}

/** S7, the confirm step: the hash the approver saw, and the Admin's break-glass with its reason. */
export function parseApprove(field: Field): Parsed<Approval, { reason: string; breakGlass: boolean }> {
  const breakGlass = ticked(field('break_glass'));
  const values = { reason: field('reason') ?? '', breakGlass };
  const errors: Partial<Record<string, string>> = {};
  const contentHash = hashFromHex(field('hash'));
  if (contentHash === undefined) errors['hash'] = 'This page is out of date. Open the item again, then approve.';
  const reason = values.reason.trim();
  if (breakGlass && reason === '') errors['reason'] = 'Write why you are approving your own change.';
  else if (breakGlass && reason.length > NOTE_MAX) errors['reason'] = 'The reason is too long: at most 2,000 characters.';
  return result(errors, { contentHash: contentHash as Uint8Array, ...(breakGlass ? { breakGlass: { reason } } : {}) }, values);
}

/** S5, send for approval: where it shows (at least one), and the newsletter edition, if any. */
export function parseSubmit(field: Field): Parsed<{ targets: Targets; editionId: string }, { website: boolean; newsletter: boolean; edition: string }> {
  const values = { website: ticked(field('website')), newsletter: ticked(field('newsletter')), edition: field('edition') ?? '' };
  const errors: Partial<Record<string, string>> = {};
  if (!values.website && !values.newsletter) errors['targets'] = 'Tick at least one place to show it.';
  if (values.edition !== '' && !UUID.test(values.edition)) errors['edition'] = 'Choose an edition from the list.';
  return result(errors, { targets: { website: values.website, newsletter: values.newsletter, email: false }, editionId: values.edition }, values);
}

/** The markup problems as the page lists them: "Line 4: the link must start with https://". */
export function problemLines(problems: readonly Problem[]): string[] {
  return problems.map((p) => (p.line > 0 ? `Line ${p.line}: ${p.message}` : `${p.message.charAt(0).toUpperCase()}${p.message.slice(1)}`));
}

export type EditForm = { ok: true; values: Draft } | { ok: false; reason: 'withheld' | 'print_as_is' | 'nothing'; message: string };

/**
 * What the edit form opens with: the working version, else the live one. Never a version whose markup the
 * officer's lens withholds (the markup arrives empty, and saving it would wipe the body), nor a ready one
 * marked "print as is" (the API refuses the edit).
 */
export function editFormFor(item: EditorItem): EditForm {
  const version = item.working ?? item.live;
  if (version === undefined) return { ok: false, reason: 'nothing', message: 'There is nothing to edit in this item.' };
  if (version.markupWithheld) return { ok: false, reason: 'withheld', message: 'Part of this item is held back from you, so it cannot be edited here. Ask the Webmaster or the Admin.' };
  if (version.printAsIs && version.status === 'ready') {
    return { ok: false, reason: 'print_as_is', message: 'This version is marked "print as is": it can be approved or sent back, but no longer edited.' };
  }
  return { ok: true, values: { title: version.title, summary: version.summary, visibility: version.visibility, markup: version.markup } };
}
