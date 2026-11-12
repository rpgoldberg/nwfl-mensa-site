// EDITOR E2: an item's history in sentences (spec S8), newest first: "Tue 17 Nov, 10:42 – Publications
// Officer (you) sent it for approval (version 2)." Who acted is the API's label for their role at the
// time, never a name; "(you)" is added for the signed-in officer's own steps. Notes are quoted.
import { describe, expect, it } from 'vitest';
import type { HistoryStep } from '../api/editor';
import { historySentences, whenText } from './history';

const ME = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000eb';
// 16:42 UTC on November 17 is 10:42 in Central (CST).
const AT = new Date('2026-11-17T16:42:00Z');

const step = (patch: Partial<HistoryStep>): HistoryStep => ({
  at: AT,
  action: 'save',
  actorSubject: OTHER,
  actorLabel: 'Publications Officer',
  actingOfficeId: '',
  versionNumber: 2,
  fromState: '',
  toState: '',
  note: '',
  ...patch,
});

const one = (patch: Partial<HistoryStep>, you = ME) => historySentences([step(patch)], { you })[0]?.sentence;

describe('historySentences: every action the API records', () => {
  it.each([
    ['create', 'Tue 17 Nov, 10:42 – Publications Officer started it as a draft (version 2).'],
    ['save', 'Tue 17 Nov, 10:42 – Publications Officer saved a draft (version 2).'],
    ['ready', 'Tue 17 Nov, 10:42 – Publications Officer sent it for approval (version 2).'],
    ['send_back', 'Tue 17 Nov, 10:42 – Publications Officer sent it back (version 2).'],
    ['approve', 'Tue 17 Nov, 10:42 – Publications Officer approved it (version 2).'],
    ['approve_single', 'Tue 17 Nov, 10:42 – Publications Officer approved their own change, as the one-approver setting allows (version 2).'],
    ['approve_self', 'Tue 17 Nov, 10:42 – Publications Officer approved their own change by break-glass (version 2).'],
    ['withdraw', 'Tue 17 Nov, 10:42 – Publications Officer took it down from the website (version 2).'],
    ['restore', 'Tue 17 Nov, 10:42 – Publications Officer brought it back as a new draft (version 2).'],
    ['targets_changed', 'Tue 17 Nov, 10:42 – Publications Officer changed where it will appear (version 2).'],
    ['edition_changed', 'Tue 17 Nov, 10:42 – Publications Officer changed the newsletter edition (version 2).'],
  ])('%s', (action, sentence) => {
    expect(one({ action })).toBe(sentence);
  });

  it('puts an action it has no words for in plain words, and nothing of one that is not a plain name', () => {
    expect(one({ action: 'pin_edition' })).toBe('Tue 17 Nov, 10:42 – Publications Officer made a change (pin edition) (version 2).');
    expect(one({ action: '<script>' })).toBe('Tue 17 Nov, 10:42 – Publications Officer made a change (version 2).');
    expect(one({ action: '' })).toBe('Tue 17 Nov, 10:42 – Publications Officer made a change (version 2).');
    expect(one({ action: `a_${'b'.repeat(80)}` })).toBe('Tue 17 Nov, 10:42 – Publications Officer made a change (version 2).');
  });
});

describe('historySentences: who, when, notes and order', () => {
  it('adds "(you)" to the signed-in officer\'s own steps only', () => {
    expect(one({ action: 'ready', actorSubject: ME })).toBe('Tue 17 Nov, 10:42 – Publications Officer (you) sent it for approval (version 2).');
    expect(one({ action: 'ready', actorSubject: OTHER })).not.toContain('(you)');
    expect(one({ action: 'ready', actorSubject: '' }, '')).not.toContain('(you)');
    expect(historySentences([step({ action: 'ready', actorSubject: ME })], { you: undefined })[0]?.sentence).not.toContain('(you)');
  });

  it('says "Someone" when the API gave no label, and leaves out a version it did not give', () => {
    expect(one({ actorLabel: '', versionNumber: 0, action: 'withdraw' })).toBe('Tue 17 Nov, 10:42 – Someone took it down from the website.');
  });

  it('quotes a send-back note and a break-glass reason, kept to one line', () => {
    expect(one({ action: 'send_back', actorLabel: 'Webmaster', note: 'Please add\nthe time.' })).toBe(
      'Tue 17 Nov, 10:42 – Webmaster sent it back (version 2). The note: “Please add the time.”',
    );
    expect(one({ action: 'approve_self', actorLabel: 'Admin', actorSubject: ME, note: 'The Webmaster is away' })).toBe(
      'Tue 17 Nov, 10:42 – Admin (you) approved their own change by break-glass (version 2). The reason: “The Webmaster is away”',
    );
    expect(one({ action: 'save', note: 'odd' })).toBe('Tue 17 Nov, 10:42 – Publications Officer saved a draft (version 2). The note: “odd”');
  });

  it('starts with the Central time, in daylight saving too, and leaves it out when there is none', () => {
    expect(whenText(new Date('2026-07-04T15:05:00Z'))).toBe('Sat 4 Jul, 10:05');
    expect(whenText(new Date('2026-11-01T06:30:00Z'))).toBe('Sun 1 Nov, 01:30');
    expect(whenText(new Date('2026-11-01T07:30:00Z'))).toBe('Sun 1 Nov, 01:30');
    expect(whenText(new Date('2027-01-01T05:59:00Z'))).toBe('Thu 31 Dec, 23:59');
    const undated: HistoryStep = { ...step({ action: 'save' }) };
    delete undated.at;
    expect(historySentences([undated], { you: ME })[0]).toEqual({ sentence: 'Publications Officer saved a draft (version 2).' });
  });

  it('lists newest first: the API gives oldest first', () => {
    const steps = ['create', 'save', 'ready'].map((action, i) => step({ action, at: new Date(AT.getTime() + i * 60_000) }));
    const sentences = historySentences(steps, { you: ME });
    expect(sentences.map((s) => s.sentence.split(' – ')[0])).toEqual(['Tue 17 Nov, 10:44', 'Tue 17 Nov, 10:43', 'Tue 17 Nov, 10:42']);
    expect(sentences[0]?.at).toEqual(new Date(AT.getTime() + 120_000));
    expect(steps.map((s) => s.action)).toEqual(['create', 'save', 'ready']);
  });
});
