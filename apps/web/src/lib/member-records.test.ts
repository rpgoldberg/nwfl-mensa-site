// PROFILE-ERASE: the Admin's member-records page, in words. The forms are checked before the API is
// asked: the new number as the sign-up form checks one, and a reason in words with no digit of any
// script, so the record of a correction never holds the old or the new number.
import { describe, expect, it } from 'vitest';
import type { SignupRecord } from './api/membership';
import {
  CORRECT_REFUSED,
  ERASE_REFUSED,
  MAX_REASON,
  RECORDS_LISTED_MAX,
  canCorrect,
  doneFromQuery,
  doneText,
  endsAccess,
  eraseList,
  parseRecordForm,
  recordFacts,
  recordsShownNote,
} from './member-records';

const ID = '6a1f0c8e-1b2c-4d3e-8f40-5a6b7c8d9e0f';
const form = (values: Record<string, string>) => (name: string) => values[name];
const MEMBER: SignupRecord = {
  requestId: ID,
  displayName: 'Jordan Example',
  email: 'jordan@example.org',
  firstName: 'Jordan',
  lastName: 'Example',
  membershipNumber: '000033001',
  decision: 'approved',
  decidedAt: new Date('2026-11-02T18:00:00Z'),
  status: 'member',
};

describe('parseRecordForm: erasing', () => {
  it('reads an erasure, confirmed or not yet', () => {
    expect(parseRecordForm(form({ action: 'erase', request: ID }))).toEqual({ ok: true, value: { action: 'erase', requestId: ID, confirmed: false } });
    expect(parseRecordForm(form({ action: 'erase', request: ID, confirmed: 'yes' }))).toEqual({ ok: true, value: { action: 'erase', requestId: ID, confirmed: true } });
  });

  it.each([
    ['no action', { request: ID }],
    ['an action it does not know', { action: 'delete', request: ID }],
    ['no record', { action: 'erase' }],
    ['a record id that is not one', { action: 'erase', request: '../x' }],
    ['a correction with no step', { action: 'correct', request: ID, membershipNumber: '12', reason: 'A slip' }],
  ])('refuses %s as a form it cannot read', (_what, values) => {
    expect(parseRecordForm(form(values))).toMatchObject({ ok: false, errors: {} });
    expect(parseRecordForm(form(values))).not.toHaveProperty('requestId');
  });
});

describe('parseRecordForm: correcting a number', () => {
  const correct = (values: Record<string, string>) => parseRecordForm(form({ action: 'correct', request: ID, step: 'review', membershipNumber: '000033002', reason: 'Two digits were swapped.', ...values }));

  it('reads a correction for review and to apply, the number as the sign-up form reads one', () => {
    expect(correct({})).toEqual({ ok: true, value: { action: 'correct', requestId: ID, step: 'review', membershipNumber: '000033002', reason: 'Two digits were swapped.' } });
    expect(correct({ step: 'apply', membershipNumber: ' 0000-33 002 ', reason: '  A typing slip.\n' })).toEqual({
      ok: true,
      value: { action: 'correct', requestId: ID, step: 'apply', membershipNumber: '000033002', reason: 'A typing slip.' },
    });
  });

  it.each([
    ['no number', '', 'Enter the new membership number.'],
    ['only spaces', '   ', 'Enter the new membership number.'],
    ['letters', '12a45', 'Enter the number using digits only, up to 12 of them.'],
    ['thirteen digits', '1234567890123', 'Enter the number using digits only, up to 12 of them.'],
    ['a full-width digit', '1234５', 'Enter the number using digits only, up to 12 of them.'],
  ])('says what is wrong with %s, and keeps what was typed', (_what, membershipNumber, problem) => {
    expect(correct({ membershipNumber })).toEqual({ ok: false, requestId: ID, errors: { membershipNumber: problem }, values: { membershipNumber: membershipNumber.trim(), reason: 'Two digits were swapped.' } });
  });

  it.each([
    ['no reason', '', 'Say why, in words.'],
    ['a reason with no word', '?!', 'Say why, in words.'],
    ['a reason over 500 characters', 'a'.repeat(MAX_REASON + 1), 'Keep the reason to 500 characters or fewer.'],
    ['a reason with a hidden character', 'A typing\u0007slip', 'Type the reason again: it has a hidden character that cannot be kept.'],
    ['the number in the reason', 'It was 000033001', 'Write the reason without any digits. The number itself is never put in the record.'],
    ['one digit in the reason', 'The 3rd was wrong', 'Write the reason without any digits. The number itself is never put in the record.'],
    ['spaced digits in the reason', 'It was 0 0 3', 'Write the reason without any digits. The number itself is never put in the record.'],
    ['full-width digits in the reason', 'It was ０３', 'Write the reason without any digits. The number itself is never put in the record.'],
    ['Arabic-Indic digits in the reason', 'It was ٣', 'Write the reason without any digits. The number itself is never put in the record.'],
    ['circled digits in the reason', 'It was ③', 'Write the reason without any digits. The number itself is never put in the record.'],
  ])('says what is wrong with %s', (_what, reason, problem) => {
    expect(correct({ reason })).toMatchObject({ ok: false, requestId: ID, errors: { reason: problem } });
  });

  it('takes a reason of exactly 500 characters, with line breaks and punctuation', () => {
    expect(correct({ reason: 'a'.repeat(MAX_REASON) })).toMatchObject({ ok: true });
    expect(correct({ reason: 'The member’s card says otherwise.\nChecked — twice!' })).toMatchObject({ ok: true });
  });

  it('reports both problems at once', () => {
    expect(correct({ membershipNumber: 'x', reason: '' })).toMatchObject({ ok: false, errors: { membershipNumber: expect.any(String) as string, reason: 'Say why, in words.' } });
  });
});

describe('a record, in words', () => {
  it('lists what was typed, the decision with its day, and the account', () => {
    expect(recordFacts(MEMBER)).toEqual([
      ['First name', 'Jordan'],
      ['Last name', 'Example'],
      ['Membership number', '000033001'],
      ['Decision', 'Approved on November 2, 2026'],
      ['Account', 'Member'],
    ]);
    expect(recordFacts({ requestId: ID, displayName: 'Kai Example', email: 'kai@example.org', decision: 'rejected', decidedAt: new Date('2026-11-05T16:00:00Z'), status: 'removed' })).toEqual([
      ['Decision', 'Rejected on November 5, 2026'],
      ['Account', 'Removed'],
    ]);
    expect(recordFacts({ requestId: ID, displayName: 'Kai Example', email: 'kai@example.org', decision: 'reopened', decidedAt: new Date('2026-11-05T16:00:00Z') })).toEqual([
      ['Decision', 'Rejected on November 5, 2026, then reopened'],
      ['Account', 'None'],
    ]);
    expect(recordFacts({ requestId: ID, displayName: 'Kai Example', email: 'kai@example.org', decision: 'approved', status: 'lapsed' })).toEqual([
      ['Decision', 'Approved'],
      ['Account', 'Lapsed'],
    ]);
  });

  it('offers a correction only for an approved member with a number on file', () => {
    expect(canCorrect(MEMBER)).toBe(true);
    expect(canCorrect({ ...MEMBER, status: 'affiliate' })).toBe(true);
    expect(canCorrect({ ...MEMBER, status: 'lapsed' })).toBe(true);
    expect(canCorrect({ ...MEMBER, status: 'removed' })).toBe(false);
    expect(canCorrect({ requestId: ID, displayName: 'Kai Example', email: 'kai@example.org', decision: 'approved', membershipNumber: '000033001' })).toBe(false);
    expect(canCorrect({ ...MEMBER, decision: 'rejected' })).toBe(false);
    expect(canCorrect({ requestId: ID, displayName: 'Kai Example', email: 'kai@example.org', decision: 'approved', status: 'member' })).toBe(false);
  });

  it('names everything an erasure erases, and whether member access ends with it', () => {
    expect(eraseList(MEMBER)).toEqual([
      'The name and email address from their sign-in: Jordan Example, jordan@example.org.',
      'Their first name and last name: Jordan Example.',
      'Their membership number: 000033001.',
    ]);
    expect(endsAccess(MEMBER)).toBe(true);
    const removed: SignupRecord = { requestId: ID, displayName: 'Kai Example', email: 'kai@example.org', decision: 'approved', status: 'removed' };
    expect(eraseList(removed)).toEqual(['The name and email address from their sign-in: Kai Example, kai@example.org.']);
    expect(endsAccess(removed)).toBe(false);
    expect(eraseList({ ...removed, lastName: 'Example' })).toEqual(['The name and email address from their sign-in: Kai Example, kai@example.org.', 'Their last name: Example.']);
    expect(eraseList({ ...removed, firstName: 'Kai' })).toContain('Their first name: Kai.');
    expect(endsAccess({ ...MEMBER, decision: 'rejected' })).toBe(false);
  });

  it('says when the list is full, so an older record is never hidden without a word', () => {
    expect(recordsShownNote(RECORDS_LISTED_MAX - 1)).toBeUndefined();
    expect(recordsShownNote(RECORDS_LISTED_MAX)).toBe('Showing the latest 500 records. Any older ones are not shown here.');
  });
});

describe('what happened, in words', () => {
  it('reads the outcome from the address', () => {
    for (const done of ['erased', 'erased-access', 'already', 'corrected'] as const) expect(doneFromQuery(new URLSearchParams({ done }))).toBe(done);
    expect(doneFromQuery(new URLSearchParams({ done: 'deleted' }))).toBeUndefined();
    expect(doneFromQuery(new URLSearchParams())).toBeUndefined();
  });

  it('says each outcome plainly', () => {
    expect(doneText('erased')).toBe('Erased. Only the date and the decision are kept.');
    expect(doneText('erased-access')).toBe('Erased. Only the date and the decision are kept, and the person’s member access has ended.');
    expect(doneText('already')).toBe('Nothing was changed: this record was already erased.');
    expect(doneText('corrected')).toBe('Corrected. The member’s account page now shows the new number.');
  });

  it('says each refusal plainly, and that nothing changed', () => {
    for (const text of [...Object.values(ERASE_REFUSED), ...Object.values(CORRECT_REFUSED)]) expect(text).toMatch(/^Nothing was changed: /);
    expect(Object.keys(ERASE_REFUSED)).toEqual(['own', 'closed']);
    expect(Object.keys(CORRECT_REFUSED)).toEqual(['own', 'closed', 'invalid']);
  });
});
