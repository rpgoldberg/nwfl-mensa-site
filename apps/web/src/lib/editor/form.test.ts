// EDITOR E2: the editor's forms, read on the server (the pages work with no script): each field
// checked and capped, a plain-words error per field for the list at the top, and what was typed kept.
// The text box is capped at 48 KiB, so the whole form, posted as multipart/form-data, stays under
// Astro's 64 KiB body cap. An item whose markup the officer's lens withholds never opens in the form.
import { describe, expect, it } from 'vitest';
import type { EditorItem, EditorVersion } from '../api/editor';
import { readForm } from '../form';
import {
  EDIT_FORM_LIMIT,
  MARKUP_MAX_BYTES,
  NOTE_MAX,
  editFormFor,
  hashFromHex,
  hashHex,
  parseApprove,
  parseDraft,
  parseNewItem,
  parseSendBack,
  parseSubmit,
  problemLines,
} from './form';

const fields = (values: Record<string, string>) => (name: string) => (Object.hasOwn(values, name) ? values[name] : undefined);
const OFFICES = [{ id: '11111111-1111-4111-8111-111111111111' }, { id: '22222222-2222-4222-8222-222222222222' }];

describe('parseNewItem', () => {
  it('reads what it is, the office and the title', () => {
    expect(parseNewItem(fields({ kind: 'president_report', office: OFFICES[1]!.id, title: '  A note   from me ' }), OFFICES)).toEqual({
      ok: true,
      value: { kind: 'president_report', officeId: OFFICES[1]!.id, title: 'A note from me' },
    });
  });

  it('takes the one office of someone who holds one, whatever was posted', () => {
    expect(parseNewItem(fields({ kind: 'article', office: 'other', title: 'T' }), [OFFICES[0]!])).toMatchObject({ ok: true, value: { officeId: OFFICES[0]!.id } });
  });

  it('names each field to fix, keeping what was typed', () => {
    expect(parseNewItem(fields({ kind: 'minutes', office: 'nope', title: '' }), OFFICES)).toEqual({
      ok: false,
      errors: { kind: 'Choose what it is.', office: 'Choose the office you are posting as.', title: 'Give it a title.' },
      values: { kind: 'minutes', office: 'nope', title: '' },
    });
    expect(parseNewItem(fields({}), [])).toEqual({
      ok: false,
      errors: { kind: 'Choose what it is.', office: 'You hold no office that can post news.', title: 'Give it a title.' },
      values: { kind: '', office: '', title: '' },
    });
  });

  it('caps the title at 200 letters and keeps members-only words out of it', () => {
    expect(parseNewItem(fields({ kind: 'article', title: 'é'.repeat(200) }), [OFFICES[0]!]).ok).toBe(true);
    expect(parseNewItem(fields({ kind: 'article', title: 'é'.repeat(201) }), [OFFICES[0]!])).toMatchObject({ ok: false, errors: { title: 'The title is too long: at most 200 letters.' } });
    expect(parseNewItem(fields({ kind: 'article', title: 'See :members[the code]' }), [OFFICES[0]!])).toMatchObject({
      ok: false,
      errors: { title: 'A title is always public: put members-only words in the text.' },
    });
  });
});

describe('parseDraft', () => {
  const draft = { title: 'Lunch', summary: 'Thursdays now', visibility: 'members', markup: '# Hi\r\n\r\nText' };

  it('reads the title, summary, who can read it and the text, with line ends made plain', () => {
    expect(parseDraft(fields(draft))).toEqual({ ok: true, value: { title: 'Lunch', summary: 'Thursdays now', visibility: 'members', markup: '# Hi\n\nText' } });
    expect(parseDraft(fields({ ...draft, summary: '' }))).toMatchObject({ ok: true, value: { summary: '' } });
  });

  it('caps the text at 48 KiB, counted in bytes, and keeps it when too long', () => {
    const fits = 'é'.repeat(MARKUP_MAX_BYTES / 2);
    expect(parseDraft(fields({ ...draft, markup: fits })).ok).toBe(true);
    const over = `${fits}x`;
    expect(parseDraft(fields({ ...draft, markup: over }))).toEqual({
      ok: false,
      errors: { markup: 'The text is too long: at most 48 KiB (about 49,000 letters). Shorten it, or split it into two items.' },
      values: { ...draft, markup: over },
    });
  });

  it('refuses a form whose text did not arrive, rather than save an empty one over it', () => {
    expect(parseDraft(fields({ title: draft.title, summary: draft.summary, visibility: draft.visibility }))).toMatchObject({ ok: false, errors: { markup: 'The text did not reach us. Nothing was saved: please press Save draft again.' } });
  });

  it('names each other field to fix', () => {
    expect(parseDraft(fields({ title: ' ', summary: 'x'.repeat(301), visibility: 'everyone', markup: '' }))).toEqual({
      ok: false,
      errors: { title: 'Give it a title.', summary: 'The summary is too long: at most 300 letters.', visibility: 'Choose who can read it.' },
      values: { title: ' ', summary: 'x'.repeat(301), visibility: 'everyone', markup: '' },
    });
    expect(parseDraft(fields({ ...draft, summary: '::: members' }))).toMatchObject({ ok: false, errors: { summary: 'A summary is always public: put members-only words in the text.' } });
    expect(parseDraft(fields({}))).toMatchObject({ ok: false, values: { title: '', summary: '', visibility: '', markup: '' } });
  });

  it('fits the fullest form, posted as multipart, under the cap, and under Astro\'s 64 KiB', async () => {
    expect(EDIT_FORM_LIMIT).toBeLessThan(64 * 1024);
    const form = new FormData();
    form.set('title', 'é'.repeat(200));
    form.set('summary', 'é'.repeat(300));
    form.set('visibility', 'officers');
    form.set('markup', '€'.repeat(Math.floor(MARKUP_MAX_BYTES / 3)));
    form.set('hash', 'a'.repeat(64));
    const request = new Request('https://localhost/x', { method: 'POST', body: form });
    const read = await readForm(request, EDIT_FORM_LIMIT);
    expect(read.ok).toBe(true);
    if (read.ok) expect(parseDraft(read.field).ok).toBe(true);
  });

  it('would not fit as a URL-encoded post: the edit form must post multipart', async () => {
    const body = new URLSearchParams({ title: 'T', visibility: 'public', markup: '€'.repeat(Math.floor(MARKUP_MAX_BYTES / 3)) });
    const request = new Request('https://localhost/x', { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(await readForm(request, EDIT_FORM_LIMIT)).toEqual({ ok: false, status: 413 });
  });
});

describe('parseSendBack', () => {
  it('needs a note of 1 to 2000 characters', () => {
    expect(parseSendBack(fields({ note: '  Please add the time.  ' }))).toEqual({ ok: true, value: { note: 'Please add the time.' } });
    expect(parseSendBack(fields({ note: 'x'.repeat(NOTE_MAX) })).ok).toBe(true);
    expect(parseSendBack(fields({ note: ' ' }))).toEqual({ ok: false, errors: { note: 'Write a note for the author.' }, values: { note: ' ' } });
    expect(parseSendBack(fields({}))).toMatchObject({ ok: false, errors: { note: 'Write a note for the author.' } });
    expect(parseSendBack(fields({ note: 'x'.repeat(NOTE_MAX + 1) }))).toMatchObject({ ok: false, errors: { note: 'The note is too long: at most 2,000 characters.' } });
  });
});

describe('parseApprove', () => {
  const HEX = 'ab'.repeat(32);

  it('carries the hash the approver saw', () => {
    expect(parseApprove(fields({ hash: HEX }))).toEqual({ ok: true, value: { contentHash: new Uint8Array(32).fill(0xab) } });
  });

  it('takes the Admin\'s break-glass only with a reason', () => {
    expect(parseApprove(fields({ hash: HEX, break_glass: 'yes', reason: ' The Webmaster is away ' }))).toEqual({
      ok: true,
      value: { contentHash: new Uint8Array(32).fill(0xab), breakGlass: { reason: 'The Webmaster is away' } },
    });
    expect(parseApprove(fields({ hash: HEX, break_glass: 'yes', reason: '' }))).toMatchObject({ ok: false, errors: { reason: 'Write why you are approving your own change.' } });
    expect(parseApprove(fields({ hash: HEX, break_glass: 'yes', reason: 'x'.repeat(NOTE_MAX + 1) }))).toMatchObject({ ok: false, errors: { reason: 'The reason is too long: at most 2,000 characters.' } });
  });

  it('refuses a hash that is not one: the page is out of date', () => {
    for (const hash of [undefined, '', 'AB'.repeat(32), 'ab'.repeat(31), 'zz'.repeat(32)]) {
      expect(parseApprove(fields(hash === undefined ? {} : { hash })), String(hash)).toMatchObject({ ok: false, errors: { hash: 'This page is out of date. Open the item again, then approve.' } });
    }
  });
});

describe('parseSubmit', () => {
  it('reads the places to show it, website first, and the edition', () => {
    expect(parseSubmit(fields({ website: 'yes' }))).toEqual({ ok: true, value: { targets: { website: true, newsletter: false, email: false }, editionId: '' } });
    expect(parseSubmit(fields({ website: 'on', newsletter: 'yes', edition: 'e0000000-0000-4000-8000-000000000001' }))).toEqual({
      ok: true,
      value: { targets: { website: true, newsletter: true, email: false }, editionId: 'e0000000-0000-4000-8000-000000000001' },
    });
  });

  it('needs at least one place, and an edition that is one', () => {
    expect(parseSubmit(fields({}))).toEqual({ ok: false, errors: { targets: 'Tick at least one place to show it.' }, values: { website: false, newsletter: false, edition: '' } });
    expect(parseSubmit(fields({ newsletter: 'yes', edition: 'next' }))).toMatchObject({ ok: false, errors: { edition: 'Choose an edition from the list.' } });
  });
});

describe('hashHex', () => {
  it('writes a hash for the hidden field and reads it back', () => {
    const hash = Uint8Array.from({ length: 32 }, (_, i) => i * 7);
    expect(hashFromHex(hashHex(hash))).toEqual(hash);
    expect(hashHex(new Uint8Array(0))).toBe('');
  });
});

describe('problemLines', () => {
  it('puts each markup problem as "Line 4: …"', () => {
    expect(problemLines([{ line: 4, message: 'the link must start with https://' }, { line: 0, message: 'the text is too deep' }])).toEqual([
      'Line 4: the link must start with https://',
      'The text is too deep',
    ]);
  });
});

const version = (patch: Partial<EditorVersion>): EditorVersion => ({
  id: 'v',
  number: 1,
  status: 'draft',
  title: 'T',
  summary: 'S',
  visibility: 'members',
  markup: '# Body',
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
const item = (patch: Partial<EditorItem>): EditorItem => ({ id: 'i', slug: 's', kind: 'article', officeId: 'o', state: 'draft', ...patch });

describe('editFormFor: the withheld guard', () => {
  it('fills the form from the working version, else the live one', () => {
    expect(editFormFor(item({ working: version({}) }))).toEqual({ ok: true, values: { title: 'T', summary: 'S', visibility: 'members', markup: '# Body' } });
    expect(editFormFor(item({ state: 'published', live: version({ status: 'approved', markup: 'live' }) }))).toMatchObject({ ok: true, values: { markup: 'live' } });
  });

  it('refuses to open when the markup is withheld from this officer, so a save cannot wipe it', () => {
    for (const it_ of [item({ working: version({ markupWithheld: true, markup: '' }) }), item({ state: 'published', live: version({ markupWithheld: true, markup: '' }) })]) {
      expect(editFormFor(it_)).toEqual({ ok: false, reason: 'withheld', message: 'Part of this item is held back from you, so it cannot be edited here. Ask the Webmaster or the Admin.' });
    }
  });

  it('refuses a ready version marked "print as is", and an item with nothing to edit', () => {
    expect(editFormFor(item({ state: 'ready', working: version({ status: 'ready', printAsIs: true }) }))).toEqual({
      ok: false,
      reason: 'print_as_is',
      message: 'This version is marked "print as is": it can be approved or sent back, but no longer edited.',
    });
    expect(editFormFor(item({ working: version({ status: 'draft', printAsIs: true }) })).ok).toBe(true);
    expect(editFormFor(item({}))).toEqual({ ok: false, reason: 'nothing', message: 'There is nothing to edit in this item.' });
  });
});
