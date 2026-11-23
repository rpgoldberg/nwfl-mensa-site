// PROFILE-ERASE: the Admin's member-records page (/officer-area/member-records), in words. The decided
// sign-ups, each with two things only the Admin may do (the API decides again on every call):
//   - erase the record when the person asks, after a step that names everything to be erased;
//   - correct a wrong membership number on an approved member's profile, with one of three fixed reasons.
// The forms are checked here before the API is asked: the new number as the sign-up form checks one
// (digitsOf), and the reason as one of the three choices (fix 1, F5): no free text, so the record of a
// correction never holds a number or a name. The API and the database check again.
import type { CorrectionCode, SignupRecord, Standing } from './api/membership';
import { MAX_NUMBER_DIGITS, digitsOf, formatMoment, typedFacts } from './signup';

export const RECORDS_PATH = '/officer-area/member-records';
/** The officer area's link to the page, for the Admin alone. */
export const RECORDS_LINK = 'Member records';
/** The three reasons for a correction, by the code the API keeps and the words the Admin reads, in this order. */
export const CORRECTION_REASONS: ReadonlyArray<readonly [CorrectionCode, string]> = [
  ['typed_wrong', 'Typed wrong at sign-up'],
  ['card_differs', 'The member’s card shows a different number'],
  ['new_number', 'Mensa issued a new number'],
];
/**
 * The most records the API lists, newest first, with no paging (its MAX_RECORDS_LISTED, kept equal).
 * A full list says so, so an older one is never hidden without a word.
 */
export const RECORDS_LISTED_MAX = 500;

export type RecordForm =
  | { action: 'erase'; requestId: string; /** Applied only once confirmed. */ confirmed: boolean }
  | { action: 'correct'; requestId: string; step: 'review' | 'apply'; membershipNumber: string; reason: CorrectionCode };

export type CorrectErrors = Partial<Record<'membershipNumber' | 'reason', string>>;

export type ParsedRecordForm =
  | { ok: true; value: RecordForm }
  /** With a record id: a correction to show again with its problems, and the reason chosen if it was one. Without: a form the page cannot read. */
  | { ok: false; requestId?: string; errors: CorrectErrors; values: { membershipNumber: string; reason: CorrectionCode | '' } };

/** The API's request ids, lower-case. */
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One of the three reasons' codes, exactly, or none. */
function reasonCode(value: string | undefined): CorrectionCode | undefined {
  return CORRECTION_REASONS.find(([code]) => code === value)?.[0];
}

export function parseRecordForm(field: (name: string) => string | undefined): ParsedRecordForm {
  const action = field('action');
  const requestId = field('request') ?? '';
  const typed = (field('membershipNumber') ?? '').trim();
  const reason = reasonCode(field('reason'));
  const unreadable: ParsedRecordForm = { ok: false, errors: {}, values: { membershipNumber: typed, reason: reason ?? '' } };
  if (!REQUEST_ID.test(requestId)) return unreadable;
  if (action === 'erase') return { ok: true, value: { action, requestId, confirmed: field('confirmed') === 'yes' } };
  const step = field('step');
  if (action !== 'correct' || (step !== 'review' && step !== 'apply')) return unreadable;
  const errors: CorrectErrors = {};
  const membershipNumber = digitsOf(typed);
  if (typed === '') errors.membershipNumber = 'Enter the new membership number.';
  else if (membershipNumber === undefined) errors.membershipNumber = `Enter the number using digits only, up to ${MAX_NUMBER_DIGITS} of them.`;
  if (reason === undefined) errors.reason = 'Choose why you are correcting it.';
  if (membershipNumber === undefined || reason === undefined) return { ok: false, requestId, errors, values: { membershipNumber: typed, reason: reason ?? '' } };
  return { ok: true, value: { action, requestId, step, membershipNumber, reason } };
}

const DECISION_TEXT: Record<SignupRecord['decision'], [string, string]> = {
  approved: ['Approved', ''],
  rejected: ['Rejected', ''],
  reopened: ['Rejected', ', then reopened'],
};
const ACCOUNT_TEXT: Record<Standing, string> = { pending: 'Waiting', member: 'Member', affiliate: 'Affiliate', lapsed: 'Lapsed', removed: 'Removed' };
/** An account that still gives member access, or could again. */
const STANDS: readonly (Standing | undefined)[] = ['member', 'affiliate', 'lapsed'];

/** A record's label and value pairs for its card: what was typed (if still held), the decision and its day, the account. */
export function recordFacts(record: SignupRecord): Array<[string, string]> {
  const [decided, after] = DECISION_TEXT[record.decision];
  return [
    ...typedFacts(record),
    ['Decision', `${decided}${record.decidedAt ? ` on ${formatMoment(record.decidedAt)}` : ''}${after}`],
    ['Account', record.status === undefined ? 'None' : ACCOUNT_TEXT[record.status]],
  ];
}

/** A number is corrected only on an approved member's profile that holds one, as the API's rule. */
export function canCorrect(record: SignupRecord): boolean {
  return record.decision === 'approved' && record.membershipNumber !== undefined && STANDS.includes(record.status);
}

/** Erasing an approved member's record ends their member access too. */
export function endsAccess(record: SignupRecord): boolean {
  return record.decision === 'approved' && STANDS.includes(record.status);
}

/** Everything an erasure erases, by name and value, for the confirmation step. */
export function eraseList(record: SignupRecord): string[] {
  const names = [record.firstName, record.lastName].filter((name) => name !== undefined);
  const which = record.firstName !== undefined && record.lastName !== undefined ? 'first name and last name' : record.firstName !== undefined ? 'first name' : 'last name';
  return [
    `The name and email address from their sign-in: ${record.displayName}, ${record.email}.`,
    ...(names.length > 0 ? [`Their ${which}: ${names.join(' ')}.`] : []),
    ...(record.membershipNumber !== undefined ? [`Their membership number: ${record.membershipNumber}.`] : []),
  ];
}

export function recordsShownNote(count: number): string | undefined {
  return count >= RECORDS_LISTED_MAX ? `Showing the latest ${RECORDS_LISTED_MAX} records. Any older ones are not shown here.` : undefined;
}

export type Done = 'erased' | 'erased-access' | 'already' | 'corrected';

const DONE_TEXT: Record<Done, string> = {
  erased: 'Erased. Only the date and the decision are kept.',
  'erased-access': 'Erased. Only the date and the decision are kept, and the person’s member access has ended.',
  already: 'Nothing was changed: this record was already erased.',
  corrected: 'Corrected. The member’s account page now shows the new number.',
};

/** The outcome named by the address the page lands on after a change (?done=...). */
export function doneFromQuery(params: URLSearchParams): Done | undefined {
  const done = params.get('done');
  return done === 'erased' || done === 'erased-access' || done === 'already' || done === 'corrected' ? done : undefined;
}

export function doneText(done: Done): string {
  return DONE_TEXT[done];
}

/** An erasure the API refused. */
export const ERASE_REFUSED: Record<'own' | 'closed', string> = {
  own: 'Nothing was changed: only the Admin erases a record, and never their own.',
  closed: 'Nothing was changed: this record is no longer in the list, or the person has a sign-up still waiting, which is decided first. The list below is as it is now.',
};

/** A correction the API refused. */
export const CORRECT_REFUSED: Record<'own' | 'closed' | 'invalid' | 'taken', string> = {
  own: 'Nothing was changed: only the Admin corrects a number, and never their own.',
  closed: 'Nothing was changed: only an approved member’s number is corrected, and the new number must differ from the one on file. The list below is as it is now.',
  invalid: 'Nothing was changed: the number or the reason was not accepted. Use digits only in the number, and choose one of the reasons.',
  taken: 'Nothing was changed: that number is already on another person’s sign-up.',
};

/** A reason's words, by its code. */
export function reasonText(code: CorrectionCode): string {
  return CORRECTION_REASONS.find(([c]) => c === code)?.[1] ?? '';
}
