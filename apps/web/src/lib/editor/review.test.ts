import { describe, expect, it, vi } from 'vitest';
import { ApiNotFound, ApiUnavailable } from '../api/client';
import { EditorRefused, type EditorApi, type EditorItem, type EditorVersion, type HistoryStep, LinksChanged, NotAllowed, type PieceLink, SignInAgain, VersionChanged } from '../api/editor';
import { hashHex } from './form';
import {
  APPROVE_NOTE,
  REVIEW_LINKS,
  SIGN_IN_AGAIN,
  actingChoice,
  answerWords,
  doneText,
  enteredForOffice,
  frozenEditionOf,
  homeCounts,
  homeLines,
  isPublisher,
  linkRows,
  linksSummary,
  parseActing,
  parseAnswers,
  reviewQueue,
  runPublish,
  runReview,
  runTakeDown,
  takenDown,
} from './review';

const ROSTER = [
  { id: '11111111-1111-4111-8111-111111111111', slug: 'president', title: 'President' },
  { id: '33333333-3333-4333-8333-333333333333', slug: 'treasurer', title: 'Treasurer' },
  { id: '55555555-5555-4555-8555-555555555555', slug: 'member-at-large', title: 'Member at Large' },
];
const ID = 'c0e20000-0000-4000-8000-0000000000e4';
const HASH = new Uint8Array(32).fill(7);
const LINKS_HASH = new Uint8Array(32).fill(9);
const reader = { bearer: 'token' };

function version(over: Partial<EditorVersion> = {}): EditorVersion {
  return {
    id: 'v1',
    number: 1,
    status: 'ready',
    title: 'T',
    summary: '',
    visibility: 'public',
    markup: '',
    markupWithheld: false,
    contentHash: HASH,
    targets: { website: true, newsletter: false, email: false },
    editionId: '',
    printAsIs: false,
    onBehalfOf: '',
    sendBackNote: '',
    callerEdited: false,
    callerMayApprove: true,
    callerMayPublish: false,
    approvedAsLabel: '',
    approvalKindSelf: false,
    ...over,
  };
}
const item = (over: Partial<EditorItem> = {}, working: Partial<EditorVersion> | undefined = {}): EditorItem => ({
  id: ID,
  slug: 's',
  kind: 'announcement',
  officeId: ROSTER[0]!.id,
  state: 'ready',
  ...(working === undefined ? {} : { working: version(working) }),
  ...over,
});
const link = (over: Partial<PieceLink> = {}): PieceLink => ({ url: 'https://club.example/a', label: '', where: 'in the text', loginWalled: false, answeredByLabel: '', accepted: false, ...over });
const form = (fields: Record<string, string>) => (name: string) => fields[name];
const fakeApi = (over: Partial<EditorApi> = {}) => over as EditorApi;

describe('who reviews and publishes', () => {
  it('names the Webmaster and the Admin as publishers, no one else', () => {
    expect(isPublisher(['nwfl-webmaster'])).toBe(true);
    expect(isPublisher(['nwfl-admin'])).toBe(true);
    expect(isPublisher(['nwfl-officers', 'nwfl-office-president'])).toBe(false);
  });

  it('offers only the offices a person holds: one as words, two or more as a choice, none as their role', () => {
    expect(actingChoice(['nwfl-officers', 'nwfl-office-treasurer'], ROSTER)).toEqual({ kind: 'one', office: ROSTER[1] });
    expect(actingChoice(['nwfl-officers', 'nwfl-office-treasurer', 'nwfl-office-member-at-large', 'nwfl-office-unknown'], ROSTER)).toEqual({ kind: 'pick', offices: [ROSTER[1], ROSTER[2]] });
    // The Admin acts for every office when writing, but approves only as what they hold.
    expect(actingChoice(['nwfl-admin'], ROSTER)).toEqual({ kind: 'none', label: 'Admin' });
    expect(actingChoice(['nwfl-webmaster'], ROSTER)).toEqual({ kind: 'none', label: 'Webmaster' });
    expect(actingChoice(['nwfl-officers'], ROSTER)).toEqual({ kind: 'none', label: 'Officer' });
  });

  it('reads the acting office from a choice, and refuses one the person does not hold or none at all', () => {
    const pick = actingChoice(['nwfl-office-treasurer', 'nwfl-office-member-at-large'], ROSTER);
    expect(parseActing(form({ acting: ROSTER[2]!.id }), pick)).toEqual({ ok: true, officeId: ROSTER[2]!.id });
    expect(parseActing(form({ acting: ROSTER[0]!.id }), pick)).toEqual({ ok: false, error: 'Choose which of your offices you act for.' });
    expect(parseActing(form({}), pick)).toEqual({ ok: false, error: 'Choose which of your offices you act for.' });
    // One office or none: nothing to choose; whatever was posted is not read.
    expect(parseActing(form({ acting: ROSTER[0]!.id }), actingChoice(['nwfl-office-treasurer'], ROSTER))).toEqual({ ok: true, officeId: ROSTER[1]!.id });
    expect(parseActing(form({ acting: ROSTER[0]!.id }), actingChoice(['nwfl-admin'], ROSTER))).toEqual({ ok: true, officeId: '' });
  });
});

describe('the queue (S6) and the officer-area counts', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 17, 16, minute));
  const waitingNew = item({ id: 'new' }, { readyAt: at(30) });
  const waitingOld = item({ id: 'old' }, { readyAt: at(10), callerEdited: true, callerMayApprove: false });
  const waitingNoTime = item({ id: 'no-time' }, {});
  const clearedOld = item({ id: 'c-old' }, { status: 'cleared', approvedAt: at(5), callerMayApprove: false, callerMayPublish: true });
  const clearedNew = item({ id: 'c-new', state: 'published' }, { status: 'cleared', approvedAt: at(40), callerMayApprove: false });
  const draft = item({ id: 'draft', state: 'draft' }, { status: 'draft', callerMayApprove: false });

  it('lists what waits for approval and what is approved, oldest first, a missing time last', () => {
    const queue = reviewQueue([waitingNew, draft, clearedNew, waitingNoTime, waitingOld, clearedOld]);
    expect(queue.waiting.map((i) => i.id)).toEqual(['old', 'new', 'no-time']);
    expect(queue.toPublish.map((i) => i.id)).toEqual(['c-old', 'c-new']);
  });

  it('counts what this person may approve (not what they edited) and publish, in words', () => {
    const counts = homeCounts([waitingNew, waitingOld, waitingNoTime, clearedOld, clearedNew, draft]);
    expect(counts).toEqual({ toApprove: 2, toPublish: 1 });
    expect(homeLines(counts, true)).toEqual(['2 pieces wait for your approval.', '1 piece is approved and ready to publish.']);
    expect(homeLines({ toApprove: 1, toPublish: 3 }, true)).toEqual(['1 piece waits for your approval.', '3 pieces are approved and ready to publish.']);
    // Not a publisher: no publish line, even with a count.
    expect(homeLines({ toApprove: 0, toPublish: 3 }, false)).toEqual(['No pieces wait for your approval.']);
  });
});

describe('the links panel (S7)', () => {
  it('says each link\'s latest answer and who gave it, and how many are checked', () => {
    const links = [
      link({ url: 'https://club.example/a', accepted: true, answeredByLabel: 'Treasurer' }),
      link({ url: 'https://club.example/b', answeredByLabel: 'Webmaster' }),
      link({ url: 'https://www.facebook.com/x', loginWalled: true, label: 'our group' }),
    ];
    expect(linkRows(links).map((r) => [r.index, r.answer, r.text])).toEqual([
      [0, 'yes', 'https://club.example/a'],
      [1, 'no', 'https://club.example/b'],
      [2, 'none', 'our group'],
    ]);
    expect(linkRows(links).map(answerWords)).toEqual([
      'Checked by Treasurer: it shows the right page.',
      'Webmaster answered no: it does not show the right page.',
      'Not checked yet.',
    ]);
    expect(linksSummary(links)).toBe('2 of 3 links checked.');
    expect(linksSummary([link()])).toBe('0 of 1 link checked.');
    expect(linksSummary([])).toBe('This piece has no links.');
  });

  it('reads the answers given, with their notes, and keeps all that was typed', () => {
    const fields = {
      'url-0': 'https://club.example/a',
      'answer-0': 'yes',
      'note-0': '  Fine.  ',
      'url-1': 'https://club.example/b',
      'answer-1': 'no',
      'note-1': '',
      'url-2': 'https://club.example/c',
      'note-2': 'Not opened yet',
      'url-3': 'https://club.example/d',
      'answer-3': 'maybe',
    };
    const parsed = parseAnswers(form(fields));
    expect(parsed).toEqual({
      ok: true,
      value: {
        answers: [
          { url: 'https://club.example/a', yes: true, note: 'Fine.' },
          { url: 'https://club.example/b', yes: false, note: '' },
        ],
      },
    });
  });

  it('asks for one answer at least, and keeps a note under the cap', () => {
    expect(parseAnswers(form({ 'url-0': 'https://club.example/a', 'note-0': 'typed' }))).toEqual({
      ok: false,
      errors: { answers: 'Choose Yes or No for at least one link.' },
      values: { answers: {}, notes: { 'https://club.example/a': 'typed' } },
    });
    const long = parseAnswers(form({ 'url-0': 'https://club.example/a', 'answer-0': 'no', 'note-0': 'x'.repeat(2001) }));
    expect(long).toMatchObject({ ok: false, errors: { 'note-0': 'This note is too long: at most 2,000 characters.' }, values: { answers: { 'https://club.example/a': 'no' } } });
    // At most 500 rows are read, as the API takes at most 500 answers.
    const many = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [[`url-${i}`, `https://club.example/${i}`], [`answer-${i}`, 'yes']]).flat());
    const read = parseAnswers(form(many));
    expect(read.ok && read.value.answers).toHaveLength(500);
  });

  it('finds the frozen edition in the API\'s refusal', () => {
    expect(frozenEditionOf('October–November 2026 is already frozen for print: send it back to pick an open edition')).toBe('October–November 2026');
    expect(frozenEditionOf('only a ready version can be approved')).toBeUndefined();
  });
});

describe('what the history tells the review page', () => {
  const step = (over: Partial<HistoryStep>): HistoryStep => ({ action: 'save', actorSubject: 's', actorLabel: 'President', actingOfficeId: '', versionNumber: 1, fromState: '', toState: '', note: '', ...over });

  it('says when the Admin entered the version for the office', () => {
    expect(enteredForOffice([step({ action: 'create', actorLabel: 'Admin' }), step({ action: 'ready', actorLabel: 'Admin' })], 1)).toBe(true);
    expect(enteredForOffice([step({ action: 'save', actorLabel: 'Admin', versionNumber: 1 }), step({ action: 'save', actorLabel: 'President', versionNumber: 2 })], 2)).toBe(false);
    expect(enteredForOffice([step({ action: 'send_back', actorLabel: 'Admin' })], 1)).toBe(false);
    // A create step tells no version: it started version 1.
    expect(enteredForOffice([step({ action: 'create', actorLabel: 'Admin', versionNumber: 0 })], 1)).toBe(true);
    expect(enteredForOffice([step({ action: 'create', actorLabel: 'Admin', versionNumber: 0 })], 2)).toBe(false);
  });

  it('says when and by whom an item was last taken down', () => {
    const when = new Date('2026-11-12T15:00:00Z');
    expect(takenDown([step({ action: 'withdraw', actorLabel: 'President', at: new Date('2026-11-01T15:00:00Z') }), step({ action: 'withdraw', actorLabel: 'Webmaster', at: when })])).toEqual({ by: 'Webmaster', on: 'November 12, 2026' });
    expect(takenDown([step({ action: 'withdraw', actorLabel: '' })])).toEqual({ by: 'someone' });
    expect(takenDown([step({})])).toBeUndefined();
  });

  it('puts each finished step in words', () => {
    expect(doneText(new URLSearchParams('done=approved'))).toBe(`Approved. ${APPROVE_NOTE}`);
    expect(doneText(new URLSearchParams('done=published'))).toBe('Published. It is on the website now.');
    expect(doneText(new URLSearchParams('done=taken-down'))).toBe('Taken down. It is no longer on the website.');
    expect(doneText(new URLSearchParams('done=answers'))).toBe('Your answers are saved.');
    expect(doneText(new URLSearchParams('done=sent-back'))).toBe('Sent back to the writer with your note.');
    expect(doneText(new URLSearchParams('done=other'))).toBeUndefined();
    expect(doneText(new URLSearchParams(''))).toBeUndefined();
    expect(REVIEW_LINKS.review(ID)).toBe(`/officer-area/approvals/${ID}`);
    expect(REVIEW_LINKS.publish(ID)).toBe(`/officer-area/approvals/${ID}/publish`);
    expect(REVIEW_LINKS.takeDown(ID)).toBe(`/officer-area/approvals/${ID}/take-down`);
  });
});

describe('runReview: the review page\'s posts', () => {
  const one = actingChoice(['nwfl-officers', 'nwfl-office-treasurer'], ROSTER);
  const pick = actingChoice(['nwfl-office-treasurer', 'nwfl-office-member-at-large'], ROSTER);
  const answers = { step: 'links', links_hash: hashHex(LINKS_HASH), 'url-0': 'https://club.example/a', 'answer-0': 'yes', 'note-0': 'ok', 'url-1': 'https://club.example/b', 'note-1': 'later' };

  it('saves the answers for the office acted for, bound to the list read, and goes back to the page', async () => {
    const confirmLinks = vi.fn().mockResolvedValue({ links: [], notInPiece: [] });
    const out = await runReview(fakeApi({ confirmLinks }), reader, ID, form(answers), one);
    expect(confirmLinks).toHaveBeenCalledWith(reader, { itemId: ID, linksSha256: LINKS_HASH, answers: [{ url: 'https://club.example/a', yes: true, note: 'ok' }], actingAsOfficeId: ROSTER[1]!.id });
    expect(out).toEqual({ redirect: `${REVIEW_LINKS.review(ID)}?done=answers#links` });
  });

  it('reloads the list with a plain message when it changed, keeping what was typed', async () => {
    const out = await runReview(fakeApi({ confirmLinks: vi.fn().mockRejectedValue(new LinksChanged('ConfirmLinks')) }), reader, ID, form(answers), one);
    expect(out).toMatchObject({
      status: 409,
      notice: 'The links of this piece changed since you opened the page, so nothing was saved. Here is the list again: your notes are kept; choose your answers again.',
      kept: { notes: { 'https://club.example/a': 'ok', 'https://club.example/b': 'later' } },
    });
    expect('kept' in out ? out.kept?.answers : undefined).toEqual({});
  });

  it('refuses a stale page, a missing answer, or no office chosen, before asking the API', async () => {
    const confirmLinks = vi.fn();
    expect(await runReview(fakeApi({ confirmLinks }), reader, ID, form({ ...answers, links_hash: 'zz' }), one)).toMatchObject({ status: 409, notice: 'This page is out of date. Open the item again.' });
    expect(await runReview(fakeApi({ confirmLinks }), reader, ID, form({ step: 'links', links_hash: hashHex(LINKS_HASH), 'url-0': 'https://club.example/a' }), one)).toMatchObject({
      status: 400,
      errors: { answers: 'Choose Yes or No for at least one link.' },
    });
    expect(await runReview(fakeApi({ confirmLinks }), reader, ID, form(answers), pick)).toMatchObject({ status: 400, errors: { acting: 'Choose which of your offices you act for.' }, kept: { answers: { 'https://club.example/a': 'yes' } } });
    expect(await runReview(fakeApi({ confirmLinks }), reader, ID, form({ step: 'nonsense' }), one)).toMatchObject({ status: 400, notice: 'This page is out of date. Open the item again.' });
    expect(confirmLinks).not.toHaveBeenCalled();
  });

  it('approves by the hash seen, for the office chosen; break-glass with its reason', async () => {
    const approve = vi.fn().mockResolvedValue(item());
    expect(await runReview(fakeApi({ approve }), reader, ID, form({ step: 'approve', hash: hashHex(HASH), acting: ROSTER[2]!.id }), pick)).toEqual({ redirect: `${REVIEW_LINKS.review(ID)}?done=approved` });
    expect(approve).toHaveBeenLastCalledWith(reader, { itemId: ID, contentHash: HASH, actingAsOfficeId: ROSTER[2]!.id });
    await runReview(fakeApi({ approve }), reader, ID, form({ step: 'break-glass', hash: hashHex(HASH), reason: ' Away ' }), one);
    expect(approve).toHaveBeenLastCalledWith(reader, { itemId: ID, contentHash: HASH, breakGlass: { reason: 'Away' }, actingAsOfficeId: ROSTER[1]!.id });
    await runReview(fakeApi({ approve }), reader, ID, form({ step: 'approve', hash: hashHex(HASH), break_glass: 'yes', reason: 'Not by this button' }), one);
    expect(approve).toHaveBeenLastCalledWith(reader, { itemId: ID, contentHash: HASH, actingAsOfficeId: ROSTER[1]!.id });
    expect(await runReview(fakeApi({ approve }), reader, ID, form({ step: 'break-glass', hash: hashHex(HASH), reason: '' }), one)).toMatchObject({
      status: 400,
      errors: { reason: 'Write why you are approving your own change.' },
    });
  });

  it('says why answers or a note were not saved, and refuses a stale page or a problem in the form before asking the API', async () => {
    const editor = new NotAllowed('ConfirmLinks', 'you edited this version; a second officer must check its links');
    expect(await runReview(fakeApi({ confirmLinks: vi.fn().mockRejectedValue(editor) }), reader, ID, form(answers), one)).toMatchObject({
      status: 403,
      notice: 'Your answers were not saved: you edited this version; a second officer must check its links.',
    });
    const approve = vi.fn();
    // Approve with an answer chosen but no list hash; with no content hash; with a note too long; with no office chosen.
    expect(await runReview(fakeApi({ approve }), reader, ID, form({ ...answers, step: 'approve', hash: hashHex(HASH), links_hash: '' }), one)).toMatchObject({ status: 409, notice: 'This page is out of date. Open the item again.' });
    expect(await runReview(fakeApi({ approve }), reader, ID, form({ step: 'approve', hash: 'old' }), one)).toMatchObject({ status: 409, notice: 'This page is out of date. Open the item again.' });
    expect(await runReview(fakeApi({ approve }), reader, ID, form({ ...answers, step: 'approve', hash: hashHex(HASH), 'note-0': 'x'.repeat(2001) }), one)).toMatchObject({
      status: 400,
      errors: { 'note-0': 'This note is too long: at most 2,000 characters.' },
    });
    expect(await runReview(fakeApi({ approve }), reader, ID, form({ step: 'approve', hash: hashHex(HASH) }), pick)).toMatchObject({ status: 400, errors: { acting: 'Choose which of your offices you act for.' } });
    expect(approve).not.toHaveBeenCalled();
    const sendBack = vi.fn().mockRejectedValue(new EditorRefused('SendBack', 'only a version waiting for approval, or approved and not yet published, can be sent back.'));
    expect(await runReview(fakeApi({ sendBack }), reader, ID, form({ step: 'send-back', note: 'Fix it' }), pick)).toMatchObject({ status: 400, errors: { acting: 'Choose which of your offices you act for.' } });
    expect(await runReview(fakeApi({ sendBack }), reader, ID, form({ step: 'send-back', note: 'Fix it' }), one)).toMatchObject({
      status: 409,
      notice: 'It was not sent back: only a version waiting for approval, or approved and not yet published, can be sent back.',
    });
  });

  it('approves by break-glass from its own button, and saves answers chosen in the same form first', async () => {
    const approve = vi.fn().mockResolvedValue(item());
    const confirmLinks = vi.fn().mockResolvedValue({ links: [], notInPiece: [] });
    await runReview(fakeApi({ approve, confirmLinks }), reader, ID, form({ step: 'break-glass', hash: hashHex(HASH), reason: 'The Webmaster is away' }), one);
    expect(approve).toHaveBeenLastCalledWith(reader, { itemId: ID, contentHash: HASH, breakGlass: { reason: 'The Webmaster is away' }, actingAsOfficeId: ROSTER[1]!.id });
    expect(confirmLinks).not.toHaveBeenCalled();
    // Approve pressed with a link answered in the form: the answer is saved, then it is approved.
    expect(await runReview(fakeApi({ approve, confirmLinks }), reader, ID, form({ ...answers, step: 'approve', hash: hashHex(HASH) }), one)).toEqual({ redirect: `${REVIEW_LINKS.review(ID)}?done=approved` });
    expect(confirmLinks).toHaveBeenCalledWith(reader, { itemId: ID, linksSha256: LINKS_HASH, answers: [{ url: 'https://club.example/a', yes: true, note: 'ok' }], actingAsOfficeId: ROSTER[1]!.id });
    expect(confirmLinks.mock.invocationCallOrder[0]).toBeLessThan(approve.mock.invocationCallOrder.at(-1)!);
    // Saving them failed: nothing is approved.
    const stale = vi.fn().mockRejectedValue(new LinksChanged('ConfirmLinks'));
    const before = approve.mock.calls.length;
    expect(await runReview(fakeApi({ approve, confirmLinks: stale }), reader, ID, form({ ...answers, step: 'approve', hash: hashHex(HASH) }), one)).toMatchObject({ status: 409 });
    expect(approve.mock.calls.length).toBe(before);
    // A note on a link with no answer is not an answer: Approve alone.
    await runReview(fakeApi({ approve, confirmLinks }), reader, ID, form({ step: 'approve', hash: hashHex(HASH), 'url-0': 'https://club.example/a', 'note-0': 'later' }), one);
    expect(confirmLinks).toHaveBeenCalledTimes(1);
  });

  it('says why Approve was refused, in plain words: a link answered no, the version changed, a frozen edition, a person not allowed', async () => {
    const refuse = (error: Error) => runReview(fakeApi({ approve: vi.fn().mockRejectedValue(error) }), reader, ID, form({ step: 'approve', hash: hashHex(HASH) }), one);
    expect(await refuse(new EditorRefused('Approve', '1 link needs a sign-in to check (such as Facebook)'))).toMatchObject({ status: 409, notice: 'It was not approved: 1 link needs a sign-in to check (such as Facebook).' });
    expect(await refuse(new VersionChanged('Approve'))).toMatchObject({ status: 409, notice: 'It was not approved: it changed since you opened it. Here it is again: read it, then approve.' });
    expect(await refuse(new EditorRefused('Approve', 'Fall 2026 is already frozen for print: pick an open edition, then approve'))).toMatchObject({ status: 409, frozen: 'Fall 2026' });
    expect(await refuse(new NotAllowed('Approve', 'you edited this version; a second officer must approve it'))).toMatchObject({ status: 403, notice: 'It was not approved: you edited this version; a second officer must approve it.' });
    expect(await refuse(new NotAllowed('Approve'))).toMatchObject({ status: 403, notice: 'It was not approved: you cannot do this. Ask the Webmaster or the Admin.' });
    expect(await refuse(new SignInAgain('Approve'))).toMatchObject({ status: 401, signIn: true, notice: SIGN_IN_AGAIN });
    expect(await refuse(new ApiNotFound('Approve'))).toMatchObject({ status: 404, gone: true });
    expect(await refuse(new ApiUnavailable('Approve'))).toMatchObject({ status: 503, unavailable: true });
  });

  it('sends back with a note, and goes to the queue', async () => {
    const sendBack = vi.fn().mockResolvedValue(item());
    expect(await runReview(fakeApi({ sendBack }), reader, ID, form({ step: 'send-back', note: ' Add the time. ' }), one)).toEqual({ redirect: `${REVIEW_LINKS.queue}?done=sent-back` });
    expect(sendBack).toHaveBeenCalledWith(reader, { itemId: ID, note: 'Add the time.', actingAsOfficeId: ROSTER[1]!.id });
    expect(await runReview(fakeApi({ sendBack }), reader, ID, form({ step: 'send-back', note: ' ' }), one)).toMatchObject({ status: 400, errors: { note: 'Write a note for the author.' } });
  });

  it('asks to sign in again with no token, calling nothing, the typed text kept', async () => {
    const out = await runReview(fakeApi({}), undefined, ID, form({ step: 'send-back', note: 'Keep me', 'url-0': 'https://club.example/a', 'note-0': 'and me', reason: 'mine' }), one);
    expect(out).toEqual({ status: 401, signIn: true, notice: SIGN_IN_AGAIN, kept: { notes: { 'https://club.example/a': 'and me' }, answers: {}, note: 'Keep me', reason: 'mine' } });
  });
});

describe('runPublish and runTakeDown: the confirm pages\' posts', () => {
  it('publishes by the hash seen; a taken-down item only with the tick', async () => {
    const publish = vi.fn().mockResolvedValue(item());
    expect(await runPublish(fakeApi({ publish }), reader, item(), form({ hash: hashHex(HASH) }))).toEqual({ redirect: `${REVIEW_LINKS.review(ID)}?done=published` });
    expect(publish).toHaveBeenLastCalledWith(reader, { itemId: ID, contentHash: HASH, republishWithdrawn: false });
    const down = item({ state: 'withdrawn' });
    expect(await runPublish(fakeApi({ publish }), reader, down, form({ hash: hashHex(HASH) }))).toMatchObject({ status: 400, errors: { republish: 'Tick the box to put it back on the website.' } });
    await runPublish(fakeApi({ publish }), reader, down, form({ hash: hashHex(HASH), republish: 'yes' }));
    expect(publish).toHaveBeenLastCalledWith(reader, { itemId: ID, contentHash: HASH, republishWithdrawn: true });
    expect(await runPublish(fakeApi({ publish }), reader, item(), form({ hash: 'nope' }))).toMatchObject({ status: 409, notice: 'This page is out of date. Open the item again.' });
  });

  it('says why Publish was refused: its own approver, a rule changed, a frozen edition, a change', async () => {
    const refuse = (error: Error) => runPublish(fakeApi({ publish: vi.fn().mockRejectedValue(error) }), reader, item(), form({ hash: hashHex(HASH) }));
    expect(await refuse(new NotAllowed('Publish', 'you approved your own change; someone else must publish it'))).toMatchObject({ status: 403, notice: 'It was not published: you approved your own change; someone else must publish it.' });
    expect(await refuse(new EditorRefused('Publish', 'the approval rule changed; send it back'))).toMatchObject({ status: 409, notice: 'It was not published: the approval rule changed; send it back.' });
    expect(await refuse(new EditorRefused('Publish', 'Fall 2026 is already frozen for print: send it back to pick an open edition'))).toMatchObject({ frozen: 'Fall 2026' });
    expect(await refuse(new VersionChanged('Publish'))).toMatchObject({ notice: 'It was not published: it changed since you opened it. Here it is again: read it, then publish.' });
    expect(await runPublish(fakeApi({}), undefined, item(), form({ hash: hashHex(HASH) }))).toMatchObject({ status: 401, signIn: true });
  });

  it('takes an item down, and says why not', async () => {
    const withdraw = vi.fn().mockResolvedValue(item());
    expect(await runTakeDown(fakeApi({ withdraw }), reader, ID)).toEqual({ redirect: `${REVIEW_LINKS.review(ID)}?done=taken-down` });
    expect(withdraw).toHaveBeenCalledWith(reader, ID);
    expect(await runTakeDown(fakeApi({ withdraw: vi.fn().mockRejectedValue(new EditorRefused('Withdraw', 'only a published item can be withdrawn')) }), reader, ID)).toMatchObject({
      status: 409,
      notice: 'It was not taken down: only a published item can be withdrawn.',
    });
    expect(await runTakeDown(fakeApi({}), undefined, ID)).toMatchObject({ status: 401, signIn: true });
  });
});
