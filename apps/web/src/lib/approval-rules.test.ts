// SOLO-APPROVE: what the officer pages say about the approval rule, and how the Admin's switch form
// is read. The note is plain text with the date in Central time; the form is checked on the server.
import { describe, expect, it } from 'vitest';
import {
  MAX_REASON,
  NOTE_UNKNOWN,
  RULE_LABEL,
  SCOPE_LABEL,
  confirmText,
  doneFromQuery,
  doneText,
  formatSetDate,
  isAdmin,
  notesFor,
  parseRuleForm,
} from './approval-rules';

const form = (fields: Record<string, string>) => (name: string) => fields[name];
const NOV_3 = new Date('2026-11-03T19:35:00Z');

describe('the one-approver note', () => {
  it('says plainly that a second approval is not needed, set by the Admin on a Central date', () => {
    expect(notesFor([{ scope: 'content', rule: 'one_approver', setAt: NOV_3 }])).toEqual([
      "One approver: a second officer's approval is not required right now (set by the Admin on November 3, 2026).",
    ]);
  });

  it('names the privacy-setting scope in its own words', () => {
    expect(notesFor([{ scope: 'redaction_policy', rule: 'one_approver', setAt: NOV_3 }])).toEqual([
      "One approver for public privacy settings: a second officer's approval is not required right now (set by the Admin on November 3, 2026).",
    ]);
  });

  it('says nothing under two officers, and both notes, content first, when both are one approver', () => {
    expect(notesFor([{ scope: 'content', rule: 'two_person' }, { scope: 'redaction_policy', rule: 'two_person' }])).toEqual([]);
    expect(
      notesFor([
        { scope: 'redaction_policy', rule: 'one_approver', setAt: NOV_3 },
        { scope: 'content', rule: 'one_approver', setAt: NOV_3 },
      ]).map((note) => note.split(':')[0]),
    ).toEqual(['One approver', 'One approver for public privacy settings']);
  });

  it('leaves the date out when the API gave none, rather than make one up', () => {
    expect(notesFor([{ scope: 'content', rule: 'one_approver' }])).toEqual(["One approver: a second officer's approval is not required right now (set by the Admin)."]);
  });

  it('never stays silent when the setting could not be read', () => {
    expect(notesFor(undefined)).toEqual([NOTE_UNKNOWN]);
    expect(NOTE_UNKNOWN).toBe('We could not check the approval setting just now.');
  });

  it('dates by the Central calendar, not UTC', () => {
    // 04:30 UTC on the 4th is still the evening of the 3rd in Central time.
    expect(formatSetDate(new Date('2026-11-04T04:30:00Z'))).toBe('November 3, 2026');
    expect(formatSetDate(new Date('2026-07-04T12:00:00Z'))).toBe('July 4, 2026');
  });
});

describe('who sees the switch', () => {
  it('is the Admin, by the nwfl-admin group in the session, and no one else', () => {
    expect(isAdmin({ groups: ['nwfl-members', 'nwfl-officers', 'nwfl-admin'] })).toBe(true);
    expect(isAdmin({ groups: ['nwfl-members', 'nwfl-officers', 'nwfl-webmaster'] })).toBe(false);
    expect(isAdmin({ groups: ['mensa-nwfl-admin'] })).toBe(false);
    expect(isAdmin(undefined)).toBe(false);
  });
});

describe('the switch form', () => {
  it('reads a review and an apply, trimming the reason, with the revision the Admin read', () => {
    expect(parseRuleForm(form({ step: 'review', scope: 'content', rule: 'one_approver', reason: '  Webmaster away  ', revision: '' }))).toEqual({
      ok: true,
      value: { step: 'review', scope: 'content', rule: 'one_approver', reason: 'Webmaster away', revision: '' },
    });
    expect(parseRuleForm(form({ step: 'apply', scope: 'redaction_policy', rule: 'two_person', reason: 'back', revision: '0b0e7a52-6d5c-4c43-9d55-3f0a3a1c2b10' }))).toMatchObject({
      ok: true,
      value: { step: 'apply', scope: 'redaction_policy', revision: '0b0e7a52-6d5c-4c43-9d55-3f0a3a1c2b10' },
    });
  });

  it('asks for the form again when it carries no revision, or one the site never gave out', () => {
    for (const revision of [undefined, 'not-a-revision', '0b0e7a52-6d5c-4c43-9d55-3f0a3a1c2b10x', '0B0E7A52-6D5C-4C43-9D55-3F0A3A1C2B10']) {
      expect(parseRuleForm(form({ step: 'apply', scope: 'content', rule: 'one_approver', reason: 'away', ...(revision === undefined ? {} : { revision }) })), String(revision)).toMatchObject({
        ok: false,
        scope: 'content',
        errors: { step: 'Send the form again.' },
      });
    }
  });

  it('takes as a reason only words: a letter in any alphabet, or a digit, not spaces, dots or invisible characters', () => {
    for (const reason of ['\t\n', '\u200b', '\u00a0\ufeff', '...', '-- !']) {
      expect(parseRuleForm(form({ step: 'review', scope: 'content', rule: 'one_approver', reason, revision: '' })), JSON.stringify(reason)).toMatchObject({
        ok: false,
        errors: { reason: 'Write why you are making this change.' },
      });
    }
    for (const reason of ['\u00c9t\u00e9', '\u0395\u03bb\u03bb\u03ac\u03b4\u03b1', '2', 'away\r\nback\tFriday']) {
      expect(parseRuleForm(form({ step: 'review', scope: 'content', rule: 'one_approver', reason, revision: '' })), reason).toMatchObject({ ok: true });
    }
  });

  it('refuses a reason with a hidden control character in it (a NUL, an escape code), as the API does, in plain words', () => {
    for (const reason of ['a\u0000b', 'away\u001b[2J', 'away\u007f', 'away\u0085', '\u0007away']) {
      expect(parseRuleForm(form({ step: 'review', scope: 'content', rule: 'one_approver', reason, revision: '' })), JSON.stringify(reason)).toMatchObject({
        ok: false,
        errors: { reason: 'Type the reason again: it has a hidden character that cannot be kept.' },
      });
    }
  });

  it('says what is missing, by field, in words', () => {
    const result = parseRuleForm(form({ step: 'review', scope: 'content', revision: '' }));
    expect(result).toEqual({
      ok: false,
      scope: 'content',
      errors: { rule: 'Choose two officers or one officer.', reason: 'Write why you are making this change.' },
      values: { rule: '', reason: '' },
    });
  });

  it('refuses a reason over the limit, an unknown scope, rule or step', () => {
    expect(parseRuleForm(form({ step: 'review', scope: 'content', rule: 'one_approver', reason: 'x'.repeat(MAX_REASON + 1), revision: '' }))).toMatchObject({
      ok: false,
      errors: { reason: `Keep the reason to ${MAX_REASON} characters or fewer.` },
    });
    expect(parseRuleForm(form({ step: 'review', scope: 'members', rule: 'one_approver', reason: 'why', revision: '' }))).toMatchObject({ ok: false, scope: undefined, errors: { scope: 'Choose what this is for.' } });
    expect(parseRuleForm(form({ step: 'review', scope: 'content', rule: 'three', reason: 'why', revision: '' }))).toMatchObject({ ok: false, errors: { rule: 'Choose two officers or one officer.' } });
    expect(parseRuleForm(form({ step: 'publish', scope: 'content', rule: 'one_approver', reason: 'why', revision: '' }))).toMatchObject({ ok: false, errors: { step: 'Send the form again.' } });
    expect(parseRuleForm(form({}))).toMatchObject({ ok: false, errors: { step: 'Send the form again.', scope: 'Choose what this is for.' } });
  });

  it('labels each scope and rule in plain words', () => {
    expect(SCOPE_LABEL).toEqual({ content: 'Publishing content', redaction_policy: 'Loosening a public privacy setting' });
    expect(RULE_LABEL).toEqual({ two_person: 'Two officers (a second officer approves)', one_approver: 'One officer' });
  });

  it('asks for a plain confirmation of what the change does', () => {
    expect(confirmText('content', 'one_approver')).toBe('You are about to let one officer publish without a second approval.');
    expect(confirmText('content', 'two_person')).toBe("You are about to require a second officer's approval again before anything is published.");
    expect(confirmText('redaction_policy', 'one_approver')).toBe('You are about to let one officer loosen a public privacy setting without a second approval.');
    expect(confirmText('redaction_policy', 'two_person')).toBe("You are about to require a second officer's approval again before a public privacy setting is loosened.");
  });

  it('reports the outcome from the address it lands on after saving', () => {
    expect(doneFromQuery(new URLSearchParams('done=content&changed=1'))).toEqual({ scope: 'content', changed: true });
    expect(doneFromQuery(new URLSearchParams('done=redaction_policy&changed=0'))).toEqual({ scope: 'redaction_policy', changed: false });
    expect(doneFromQuery(new URLSearchParams('done=members&changed=1'))).toBeUndefined();
    expect(doneFromQuery(new URLSearchParams('done=content&changed=yes'))).toBeUndefined();
    expect(doneFromQuery(new URLSearchParams(''))).toBeUndefined();
    expect(doneText(true)).toBe('Saved.');
    expect(doneText(false)).toBe('No change: it was already set that way.');
  });
});
