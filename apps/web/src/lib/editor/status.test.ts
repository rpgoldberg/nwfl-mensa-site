// EDITOR E2: an item's status in the words of the officer editor's list (spec S2), each with the chip
// tone it is shown in (StatusChip's tones), never by colour alone. Every state the API gives, with and
// without a working version in each of its states, a send-back note, and a date taken down.
import { describe, expect, it } from 'vitest';
import type { EditorItem, EditorVersion, StateName } from '../api/editor';
import { STATUS_WORDS, statusOf } from './status';

const version = (patch: Partial<EditorVersion>): EditorVersion => ({
  id: 'v',
  number: 1,
  status: 'draft',
  title: 'T',
  summary: '',
  visibility: 'public',
  markup: '',
  markupWithheld: false,
  contentHash: new Uint8Array(0),
  targets: { website: true, newsletter: false, email: false },
  editionId: '',
  printAsIs: false,
  onBehalfOf: '',
  sendBackNote: '',
  callerEdited: false,
  ...patch,
});

const WORKING: Record<string, EditorVersion | undefined> = {
  none: undefined,
  draft: version({ status: 'draft' }),
  'sent back': version({ status: 'draft', sendBackNote: 'Please add the time.' }),
  ready: version({ status: 'ready' }),
};

const item = (state: StateName, working: EditorVersion | undefined, withdrawnAt?: Date): EditorItem => ({
  id: 'i',
  slug: 's',
  kind: 'announcement',
  officeId: 'o',
  state,
  ...(state === 'published' || state === 'withdrawn' ? { live: version({ status: 'approved' }) } : {}),
  ...(working ? { working } : {}),
  ...(withdrawnAt ? { withdrawnAt } : {}),
});

// 23:30 Central on November 11 is already November 12 in UTC: the date is Central's.
const TAKEN_DOWN = new Date('2026-11-12T05:30:00Z');

/** Every state, by each working version: the words and the tone. */
const TABLE: [StateName, string, string, string][] = [
  ['draft', 'none', 'Draft – only officers can see it', 'past'],
  ['draft', 'draft', 'Draft – only officers can see it', 'past'],
  ['draft', 'sent back', 'Sent back – please read the note', 'stop'],
  ['draft', 'ready', 'Draft – only officers can see it', 'past'],
  ['ready', 'none', 'Waiting for approval', 'warn'],
  ['ready', 'draft', 'Waiting for approval', 'warn'],
  ['ready', 'sent back', 'Waiting for approval', 'warn'],
  ['ready', 'ready', 'Waiting for approval', 'warn'],
  ['published', 'none', 'Published', 'ok'],
  ['published', 'draft', 'Published', 'ok'],
  ['published', 'sent back', 'Sent back – please read the note', 'stop'],
  ['published', 'ready', 'Published – a change is waiting for approval', 'warn'],
  ['withdrawn', 'none', 'Taken down on November 11, 2026', 'stop'],
  ['withdrawn', 'draft', 'Taken down on November 11, 2026', 'stop'],
  ['withdrawn', 'sent back', 'Taken down on November 11, 2026', 'stop'],
  ['withdrawn', 'ready', 'Taken down on November 11, 2026', 'stop'],
];

describe('statusOf', () => {
  it.each(TABLE)('%s, working %s: "%s" (%s)', (state, working, label, tone) => {
    expect(statusOf(item(state, WORKING[working], TAKEN_DOWN))).toMatchObject({ label, tone });
  });

  it('covers every state and working version', () => {
    const states: StateName[] = ['draft', 'ready', 'published', 'withdrawn'];
    expect(TABLE.map(([s, w]) => `${s}/${w}`)).toEqual(states.flatMap((s) => Object.keys(WORKING).map((w) => `${s}/${w}`)));
  });

  it('says only "Taken down" when the API gave no date', () => {
    expect(statusOf(item('withdrawn', undefined))).toEqual({ key: 'taken_down', label: 'Taken down', tone: 'stop' });
  });

  it('names each status by a key the pages can test, and uses only the words of the list', () => {
    const keys = new Set(TABLE.map(([s, w]) => statusOf(item(s, WORKING[w], TAKEN_DOWN)).key));
    expect([...keys].sort()).toEqual(['draft', 'published', 'published_change_waiting', 'ready', 'sent_back', 'taken_down']);
    expect(STATUS_WORDS).toEqual({
      draft: 'Draft – only officers can see it',
      ready: 'Waiting for approval',
      sent_back: 'Sent back – please read the note',
      published: 'Published',
      published_change_waiting: 'Published – a change is waiting for approval',
      taken_down: 'Taken down',
    });
  });
});
