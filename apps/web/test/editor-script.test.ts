// public/scripts/editor.js is progressive enhancement for the edit page (EDITOR E3, S4). Without it the
// page is a plain form with the "How to format" box, and Save draft posts it. With it: the toolbar shows
// and wraps the selected text in each mark; the word count follows the typing; the unsent text is kept
// in the tab's sessionStorage (never localStorage), offered back when the page opens with other text, and
// dropped once a save has gone through; leaving with unsaved changes asks first; the sign-in line turns
// to "Save now" for its last five minutes; and a problem's line link puts the cursor on that line.
// Here it runs against small stand-ins for the document, the tab's storage and the window.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTOSAVE_MS, applyMark, autosaveDelay, browserAutosave, countWords, createAutosaver, lengthText, lineStart, wireEditor } from '../public/scripts/editor.js';
import { lengthText as serverLengthText, wordCount } from '../src/lib/editor/writer';

describe('applyMark', () => {
  const at = (value: string, start: number, end: number, mark: string) => applyMark(value, start, end, mark);

  it('wraps the selection in bold or italic, and keeps it selected', () => {
    expect(at('Thank you all', 6, 9, 'bold')).toEqual({ value: 'Thank **you** all', start: 8, end: 11 });
    expect(at('Thank you all', 6, 9, 'italic')).toEqual({ value: 'Thank *you* all', start: 7, end: 10 });
  });

  it('puts in words to type over when nothing is selected', () => {
    expect(at('Hi ', 3, 3, 'bold')).toEqual({ value: 'Hi **bold words**', start: 5, end: 15 });
    expect(at('', 0, 0, 'italic')).toEqual({ value: '*slanted words*', start: 1, end: 14 });
  });

  it('makes a link of the selection, with the cursor where the address goes', () => {
    expect(at('See the picnic page.', 4, 19, 'link')).toEqual({ value: 'See [the picnic page](https://).', start: 30, end: 30 });
    expect(at('', 0, 0, 'link')).toEqual({ value: '[words to click](https://)', start: 25, end: 25 });
  });

  it('makes each selected line a list item, or a heading, from the start of its line', () => {
    expect(at('Intro\none\ntwo\nend', 8, 11, 'list')).toEqual({ value: 'Intro\n- one\n- two\nend', start: 6, end: 17 });
    expect(at('Our year', 3, 3, 'heading')).toEqual({ value: '## Our year', start: 0, end: 11 });
    // A line that is already a list item, or a heading, is left as it is.
    expect(at('- one\ntwo', 0, 9, 'list')).toEqual({ value: '- one\n- two', start: 0, end: 11 });
    expect(at('## Our year', 0, 0, 'heading')).toEqual({ value: '## Our year', start: 0, end: 11 });
  });

  it('marks words on one line members-only in line, and whole lines as a members block', () => {
    expect(at('The code is 1234.', 12, 16, 'members')).toEqual({ value: 'The code is :members[1234].', start: 21, end: 25 });
    expect(at('Open.\nGate 1234.\nRoom 5.\nEnd.', 6, 23, 'members')).toEqual({
      value: 'Open.\n::: members\nGate 1234.\nRoom 5.\n:::\nEnd.',
      start: 18,
      end: 36,
    });
    expect(at('', 0, 0, 'members')).toEqual({ value: ':members[words for members only]', start: 9, end: 31 });
  });

  it('leaves the text alone for a mark it does not know', () => {
    expect(at('Hello', 0, 5, 'shout')).toEqual({ value: 'Hello', start: 0, end: 5 });
  });
});

describe('countWords and lengthText', () => {
  const TEXTS = ['', '  \n ', '# Our year\n\n**Thank you** all, for *everything*.', '- one\n- two\n1. three\n> four', 'See [the picnic page](https://club.example/picnic) now.', ':members[The gate code] is shut.\n::: members\nInside.\n:::', '-- * — 2026 !', 'one two three', 'Hello', Array.from({ length: 1234 }, () => 'word').join(' ')];

  it('counts and says the length as the page does without script', () => {
    for (const text of TEXTS) {
      expect(countWords(text), text).toBe(wordCount(text));
      expect(lengthText(text), text).toBe(serverLengthText(text));
    }
  });
});

describe('lineStart', () => {
  it('finds where a line starts, counting from 1; past the end is the end', () => {
    expect(lineStart('a\nbb\nccc', 1)).toBe(0);
    expect(lineStart('a\nbb\nccc', 2)).toBe(2);
    expect(lineStart('a\nbb\nccc', 3)).toBe(5);
    expect(lineStart('a\nbb\nccc', 9)).toBe(8);
    expect(lineStart('a\nbb', 0)).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------------
// The stand-ins.

class FakeElement extends EventTarget {
  hidden = false;
  focused = false;
  textContent = '';
  dataset: Record<string, string> = {};
  value = '';
  selectionStart = 0;
  selectionEnd = 0;
  readonly children: Record<string, FakeElement[]> = {};
  constructor(init: Partial<FakeElement> = {}) {
    super();
    Object.assign(this, init);
  }
  querySelector(sel: string): FakeElement | null {
    return this.children[sel]?.[0] ?? null;
  }
  querySelectorAll(sel: string): FakeElement[] {
    return this.children[sel] ?? [];
  }
  setSelectionRange(start: number, end: number) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
  focus() {
    this.focused = true;
  }
}

class FakeStorage {
  readonly map = new Map<string, string>();
  broken = false;
  getItem(key: string) {
    if (this.broken) throw new Error('SecurityError');
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.broken) throw new Error('QuotaExceededError');
    this.map.set(key, value);
  }
  removeItem(key: string) {
    if (this.broken) throw new Error('SecurityError');
    this.map.delete(key);
  }
}

class FakeWindow extends EventTarget {
  timers: (() => void)[] = [];
  setInterval(fn: () => void) {
    this.timers.push(fn);
    return this.timers.length;
  }
}

const KEY = 'nwfl-draft:c0000000-0000-4000-8000-000000000001';
const EXPIRES = 1_800_000_000;

function page(options: { saved?: boolean; stored?: unknown; markup?: string; withSignIn?: boolean; withToolbar?: boolean; brokenStorage?: boolean; now?: number } = {}) {
  const title = new FakeElement({ value: 'Our year' });
  const summary = new FakeElement({ value: '' });
  const markup = new FakeElement({ value: options.markup ?? 'Thank you all' });
  const marks = ['bold', 'italic', 'link', 'list', 'heading', 'members'].map((mark) => new FakeElement({ dataset: { mark } }));
  const toolbar = new FakeElement({ hidden: true });
  toolbar.children['button[data-mark]'] = marks;
  const form = new FakeElement({ dataset: { draftKey: KEY, ...(options.saved ? { saved: 'yes' } : {}) } });
  form.children['input[name="title"]'] = [title];
  form.children['input[name="summary"]'] = [summary];
  form.children['textarea[name="markup"]'] = [markup];
  const length = new FakeElement({ textContent: 'server words' });
  const restore = new FakeElement({ hidden: true });
  const restoreYes = new FakeElement();
  const restoreNo = new FakeElement();
  restore.children['[data-restore-yes]'] = [restoreYes];
  restore.children['[data-restore-no]'] = [restoreNo];
  const signIn = new FakeElement({ textContent: 'Your sign-in lasts until 2:05 pm Central time. Save before then.', dataset: { expires: String(EXPIRES), soon: 'Your sign-in ends at 2:05 pm Central time. Save now.' } });
  const lineLink = new FakeElement({ dataset: { line: '2' } });
  const one: Record<string, FakeElement | null> = {
    'form[data-editor]': form,
    '[data-toolbar]': options.withToolbar === false ? null : toolbar,
    '[data-length]': length,
    '[data-restore]': restore,
    '[data-sign-in]': options.withSignIn === false ? null : signIn,
  };
  const doc = { querySelector: (sel: string) => one[sel] ?? null, querySelectorAll: (sel: string) => (sel === 'a[data-line]' ? [lineLink] : []) };
  const storage = new FakeStorage();
  if (options.stored !== undefined) storage.map.set(KEY, typeof options.stored === 'string' ? options.stored : JSON.stringify(options.stored));
  storage.broken = options.brokenStorage ?? false;
  const win = new FakeWindow();
  let now = options.now ?? (EXPIRES - 3000) * 1000;
  wireEditor(doc as never, { storage: storage as never, win: win as never, now: () => now });
  const type = (field: FakeElement, value: string) => {
    field.value = value;
    form.dispatchEvent(new Event('input'));
  };
  const leave = () => {
    const event = new Event('beforeunload', { cancelable: true }) as Event & { returnValue?: unknown };
    win.dispatchEvent(event);
    return event.defaultPrevented;
  };
  return { form, title, summary, markup, marks, toolbar, length, restore, restoreYes, restoreNo, signIn, lineLink, storage, win, type, leave, setNow: (ms: number) => (now = ms) };
}

describe('wireEditor', () => {
  it('does nothing on a page with no edit form', () => {
    expect(() => wireEditor({ querySelector: () => null, querySelectorAll: () => [] } as never, { storage: new FakeStorage() as never, win: new FakeWindow() as never, now: () => 0 })).not.toThrow();
  });

  it('shows the toolbar, and each button wraps the selection, then puts the cursor back in the text', () => {
    const p = page();
    expect(p.toolbar.hidden).toBe(false);
    p.markup.setSelectionRange(6, 9);
    p.marks[0]!.dispatchEvent(new Event('click'));
    expect(p.markup.value).toBe('Thank **you** all');
    expect([p.markup.selectionStart, p.markup.selectionEnd]).toEqual([8, 11]);
    expect(p.markup.focused).toBe(true);
    // The change counts as typing: kept in the tab, counted, and asked about on leaving.
    expect(JSON.parse(p.storage.map.get(KEY)!)).toEqual({ title: 'Our year', summary: '', markup: 'Thank **you** all' });
    expect(p.length.textContent).toBe('3 words, about 1 newsletter page.');
    expect(p.leave()).toBe(true);
  });

  it('works with no toolbar on the page', () => {
    const p = page({ withToolbar: false });
    p.type(p.markup, 'One two');
    expect(p.length.textContent).toBe('2 words, about 1 newsletter page.');
  });

  it('counts the words as they are typed, and keeps the unsent text in the tab', () => {
    const p = page();
    expect(p.length.textContent).toBe('3 words, about 1 newsletter page.');
    p.type(p.markup, '');
    expect(p.length.textContent).toBe('No words yet.');
    p.type(p.title, 'A new title');
    expect(JSON.parse(p.storage.map.get(KEY)!)).toEqual({ title: 'A new title', summary: '', markup: '' });
  });

  it('asks before leaving with unsaved changes, and not once the form is being sent', () => {
    const p = page();
    expect(p.leave()).toBe(false);
    p.type(p.markup, 'More words');
    expect(p.leave()).toBe(true);
    p.form.dispatchEvent(new Event('submit'));
    expect(p.leave()).toBe(false);
  });

  it('drops the tab\'s copy once a save has gone through', () => {
    const p = page({ saved: true, stored: { title: 'Old', summary: '', markup: 'Unsent' } });
    expect(p.storage.map.has(KEY)).toBe(false);
    expect(p.restore.hidden).toBe(true);
  });

  it('offers the unsent text back when the page opens with other text, and puts it back when asked', () => {
    const p = page({ stored: { title: 'Kept title', summary: 'Kept summary', markup: 'Kept words' } });
    expect(p.restore.hidden).toBe(false);
    p.restoreYes.dispatchEvent(new Event('click'));
    expect([p.title.value, p.summary.value, p.markup.value]).toEqual(['Kept title', 'Kept summary', 'Kept words']);
    expect(p.restore.hidden).toBe(true);
    expect(p.length.textContent).toBe('2 words, about 1 newsletter page.');
    expect(p.leave()).toBe(true);
  });

  it('forgets the unsent text when the officer says so', () => {
    const p = page({ stored: { title: 'Kept title', summary: '', markup: 'Kept words' } });
    p.restoreNo.dispatchEvent(new Event('click'));
    expect(p.storage.map.has(KEY)).toBe(false);
    expect(p.restore.hidden).toBe(true);
    expect(p.markup.value).toBe('Thank you all');
  });

  it('offers nothing when the tab holds the same text, or something that is not a copy', () => {
    expect(page({ stored: { title: 'Our year', summary: '', markup: 'Thank you all' } }).restore.hidden).toBe(true);
    expect(page({ stored: 'not json' }).restore.hidden).toBe(true);
    expect(page({ stored: { title: 1, markup: null } }).restore.hidden).toBe(true);
    expect(page({ stored: null }).restore.hidden).toBe(true);
  });

  it('carries on without the tab\'s storage when the browser refuses it', () => {
    const p = page({ brokenStorage: true, saved: true });
    p.type(p.markup, 'Still counted');
    expect(p.length.textContent).toBe('2 words, about 1 newsletter page.');
    expect(page({ brokenStorage: true }).restore.hidden).toBe(true);
  });

  it('turns the sign-in line to "Save now" for its last five minutes', () => {
    const p = page();
    expect(p.signIn.textContent).toBe('Your sign-in lasts until 2:05 pm Central time. Save before then.');
    p.setNow((EXPIRES - 301) * 1000);
    p.win.timers[0]!();
    expect(p.signIn.dataset['state']).toBeUndefined();
    p.setNow((EXPIRES - 300) * 1000);
    p.win.timers[0]!();
    expect(p.signIn.textContent).toBe('Your sign-in ends at 2:05 pm Central time. Save now.');
    expect(p.signIn.dataset['state']).toBe('soon');
  });

  it('says "Save now" at once when the page opens in the last five minutes, and works with no sign-in line', () => {
    expect(page({ now: (EXPIRES - 60) * 1000 }).signIn.textContent).toBe('Your sign-in ends at 2:05 pm Central time. Save now.');
    expect(page({ withSignIn: false }).win.timers).toEqual([]);
  });

  it("puts the cursor at the start of a problem's line", () => {
    const p = page({ markup: 'one\ntwo http://x\nthree' });
    const click = new Event('click', { cancelable: true });
    p.lineLink.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect([p.markup.selectionStart, p.markup.selectionEnd]).toEqual([4, 4]);
    expect(p.markup.focused).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------
// Round 2: auto-save.

describe('autosaveDelay', () => {
  const END = 10_000_000;
  it('waits a minute after the last change, sooner when the sign-in ends within that and two minutes', () => {
    expect(AUTOSAVE_MS).toBe(60_000);
    expect(autosaveDelay(END - 10 * 60_000, END)).toBe(60_000);
    expect(autosaveDelay(END - 150_000, END)).toBe(30_000);
    expect(autosaveDelay(END - 120_000, END)).toBe(5_000);
    expect(autosaveDelay(END - 10_000, END)).toBe(5_000);
    expect(autosaveDelay(END, Number.NaN)).toBe(60_000);
  });
});

/** A clock with timers the test runs by hand. */
function clock(start = 0) {
  let now = start;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    later: (fn: () => void, ms: number) => {
      timers.set(next, { at: now + ms, fn });
      return next++;
    },
    cancel: (id: number) => void timers.delete(id),
    /** Moves the clock on, running each timer that falls due. */
    run(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = until;
    },
    pending: () => timers.size,
  };
}

/** An answer the test settles by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

function saver(options: { expiresMs?: number; start?: number } = {}) {
  const c = clock(options.start ?? 0);
  const sent: { keepalive: boolean; answer: ReturnType<typeof deferred<{ status: number; body?: unknown }>> }[] = [];
  const reports: { kind: string; [k: string]: unknown }[] = [];
  const a = createAutosaver({
    send: (keepalive: boolean) => {
      const answer = deferred<{ status: number; body?: unknown }>();
      sent.push({ keepalive, answer });
      return answer.promise;
    },
    later: c.later,
    cancel: c.cancel,
    now: c.now,
    expiresMs: options.expiresMs ?? Number.NaN,
    report: (outcome: { kind: string }) => reports.push(outcome),
  });
  return { a, c, sent, reports };
}
const OK = (base = '9.000000000', savedAt = '2:05 pm') => ({ status: 200, body: { base, savedAt } });

describe('createAutosaver', () => {
  it('saves a minute after the last change, once, and never when nothing changed', async () => {
    const { a, c, sent, reports } = saver();
    c.run(5 * 60_000);
    await a.flush();
    expect(sent).toHaveLength(0);
    a.changed();
    c.run(30_000);
    a.changed();
    c.run(59_000);
    expect(sent).toHaveLength(0);
    c.run(1_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.keepalive).toBe(false);
    sent[0]?.answer.resolve(OK());
    await settle();
    expect(reports).toEqual([{ kind: 'saved', base: '9.000000000', savedAt: '2:05 pm', settled: true }]);
    c.run(5 * 60_000);
    expect(sent).toHaveLength(1);
  });

  it('never sends a second save while one is out; a change made meanwhile is saved after', async () => {
    const { a, c, sent, reports } = saver();
    a.changed();
    c.run(60_000);
    a.changed();
    void a.flush(true);
    expect(sent).toHaveLength(1);
    sent[0]?.answer.resolve(OK('1.000000000'));
    await settle();
    expect(reports.at(-1)).toMatchObject({ kind: 'saved', settled: false });
    c.run(60_000);
    expect(sent).toHaveLength(2);
    sent[1]?.answer.resolve(OK('2.000000000'));
    await a.idle();
    expect(reports.at(-1)).toMatchObject({ kind: 'saved', base: '2.000000000', settled: true });
  });

  it('flushes at once, kept alive, when asked (the page hidden)', async () => {
    const { a, sent } = saver();
    a.changed();
    void a.flush(true);
    expect(sent.map((s) => s.keepalive)).toEqual([true]);
  });

  it.each([
    [409, 'conflict'],
    [401, 'signed-out'],
    [422, 'not-draft'],
  ])('stops for good on %i (%s): later changes send nothing', async (status, kind) => {
    const { a, c, sent, reports } = saver();
    a.changed();
    c.run(60_000);
    sent[0]?.answer.resolve({ status });
    await settle();
    expect(reports).toEqual([{ kind }]);
    expect(a.stopped()).toBe(true);
    a.changed();
    c.run(10 * 60_000);
    await a.flush(true);
    expect(sent).toHaveLength(1);
  });

  it('tries again a minute later when the save fails or the site cannot be reached', async () => {
    const { a, c, sent, reports } = saver();
    a.changed();
    c.run(60_000);
    sent[0]?.answer.resolve({ status: 503 });
    await settle();
    expect(reports).toEqual([{ kind: 'retry' }]);
    c.run(60_000);
    expect(sent).toHaveLength(2);
    sent[1]?.answer.reject(new TypeError('Failed to fetch'));
    await settle();
    expect(reports.at(-1)).toEqual({ kind: 'retry' });
    c.run(60_000);
    expect(sent).toHaveLength(3);
  });

  it('saves two minutes before the sign-in ends, if anything changed', async () => {
    const end = 10 * 60_000;
    const quiet = saver({ expiresMs: end });
    quiet.c.run(9 * 60_000);
    expect(quiet.sent).toHaveLength(0);
    const busy = saver({ expiresMs: end });
    busy.c.run(7 * 60_000);
    busy.a.changed();
    busy.c.run(59_000);
    expect(busy.sent).toHaveLength(0);
    busy.c.run(1_000);
    expect(busy.sent).toHaveLength(1);
  });
});

/** The edit page with auto-save on: the page as wireEditor sees it, and the saves it sends. */
function autoPage(options: { autosave?: boolean } = {}) {
  const status = new FakeElement({ textContent: '', hidden: true });
  const conflict = new FakeElement({ hidden: true });
  const base = new FakeElement({ value: '1.000000000' });
  const title = new FakeElement({ value: 'Our year' });
  const summary = new FakeElement({ value: '' });
  const markup = new FakeElement({ value: 'Thank you all' });
  const form = new FakeElement({ dataset: { draftKey: KEY, ...(options.autosave === false ? {} : { autosave: '/officer-area/news/x/autosave' }) } }) as FakeElement & { submit: () => void; submitted: number };
  form.submitted = 0;
  form.submit = () => void (form.submitted += 1);
  form.children['input[name="title"]'] = [title];
  form.children['input[name="summary"]'] = [summary];
  form.children['textarea[name="markup"]'] = [markup];
  form.children['input[name="base"]'] = [base];
  const one: Record<string, FakeElement | null> = { 'form[data-editor]': form, '[data-autosave-status]': status, '[data-autosave-conflict]': conflict };
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible', querySelector: (sel: string) => one[sel] ?? null, querySelectorAll: () => [] });
  const storage = new FakeStorage();
  const win = new FakeWindow();
  const c = clock(1_000);
  const sent: ReturnType<typeof deferred<{ status: number; body?: unknown }>>[] = [];
  const keepalive: boolean[] = [];
  wireEditor(doc as never, {
    storage: storage as never,
    win: win as never,
    now: c.now,
    autosave: {
      send: (keep: boolean) => {
        keepalive.push(keep);
        const answer = deferred<{ status: number; body?: unknown }>();
        sent.push(answer);
        return answer.promise;
      },
      later: c.later,
      cancel: c.cancel,
    },
  } as never);
  const type = (value: string) => {
    markup.value = value;
    form.dispatchEvent(new Event('input'));
  };
  const leave = () => {
    const event = new Event('beforeunload', { cancelable: true });
    win.dispatchEvent(event);
    return event.defaultPrevented;
  };
  return { form, status, conflict, base, storage, win, doc, c, sent, keepalive, type, leave };
}

describe('wireEditor: auto-save', () => {
  it('saves a minute after typing, says so politely, takes the new base and drops the tab\'s copy', async () => {
    const p = autoPage();
    // Shown by script only: with none, nothing saves itself.
    expect(p.status.hidden).toBe(false);
    p.type('Typed.');
    expect(p.storage.map.has(KEY)).toBe(true);
    expect(p.status.textContent).toBe('');
    p.c.run(60_000);
    expect(p.sent).toHaveLength(1);
    p.sent[0]?.resolve(OK('2.000000500', '2:05 pm'));
    await settle();
    expect(p.status.textContent).toBe('Saved automatically at 2:05 pm.');
    expect(p.base.value).toBe('2.000000500');
    expect(p.storage.map.has(KEY)).toBe(false);
    expect(p.leave()).toBe(false);
  });

  it('saves at once, kept alive, when the page is hidden or left', async () => {
    const p = autoPage();
    p.type('Typed.');
    (p.doc as unknown as { visibilityState: string }).visibilityState = 'hidden';
    p.doc.dispatchEvent(new Event('visibilitychange'));
    expect(p.keepalive).toEqual([true]);
    p.sent[0]?.resolve(OK());
    await settle();
    p.type('More.');
    p.win.dispatchEvent(new Event('pagehide'));
    expect(p.keepalive).toEqual([true, true]);
  });

  it('stops on someone else\'s change, keeps the text and the tab\'s copy, and shows the way to the latest', async () => {
    const p = autoPage();
    p.type('Mine.');
    p.c.run(60_000);
    p.sent[0]?.resolve({ status: 409 });
    await settle();
    expect(p.status.textContent).toBe('Not saved: someone else changed this draft. Your text is kept here.');
    expect(p.conflict.hidden).toBe(false);
    expect(p.storage.map.has(KEY)).toBe(true);
    expect(p.leave()).toBe(true);
  });

  it.each([
    [401, 'Not saved automatically: your sign-in has ended. Your text is kept here: press Save draft.'],
    [422, 'Not saved automatically: it is no longer a draft. Your text is kept here: press Save draft.'],
    [503, 'Not saved yet: will try again.'],
  ])('says what happened on %i', async (status, words) => {
    const p = autoPage();
    p.type('Mine.');
    p.c.run(60_000);
    p.sent[0]?.resolve({ status });
    await settle();
    expect(p.status.textContent).toBe(words);
    expect(p.conflict.hidden).toBe(true);
  });

  it('holds a Save draft pressed while an automatic save is out, then sends the form with the new base', async () => {
    const p = autoPage();
    p.type('Mine.');
    p.c.run(60_000);
    const submit = new Event('submit', { cancelable: true });
    p.form.dispatchEvent(submit);
    expect(submit.defaultPrevented).toBe(true);
    expect(p.form.submitted).toBe(0);
    p.sent[0]?.resolve(OK('3.000000000'));
    await settle();
    await settle();
    expect(p.base.value).toBe('3.000000000');
    expect(p.form.submitted).toBe(1);
    const second = new Event('submit', { cancelable: true });
    p.form.dispatchEvent(second);
    expect(second.defaultPrevented).toBe(false);
  });

  it('does nothing automatic on an item that is no draft (no data-autosave)', () => {
    const p = autoPage({ autosave: false });
    p.type('Mine.');
    p.c.run(10 * 60_000);
    p.doc.dispatchEvent(new Event('visibilitychange'));
    expect(p.sent).toHaveLength(0);
    expect(p.c.pending()).toBe(0);
  });
});

describe('browserAutosave', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts the form as it stands to its address, same-origin, kept alive when asked, and reads the answer', async () => {
    const calls: [string, RequestInit][] = [];
    vi.stubGlobal('FormData', class {
      constructor(readonly form: unknown) {}
    });
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return calls.length === 1 ? new Response(JSON.stringify({ base: '2.000000000', savedAt: '2:05 pm' }), { status: 200 }) : new Response('', { status: 409 });
    });
    const form = { id: 'the form' };
    const timers: [() => void, number][] = [];
    const cleared: number[] = [];
    const io = browserAutosave('/officer-area/news/x/autosave', form, { setTimeout: (fn: () => void, ms: number) => timers.push([fn, ms]), clearTimeout: (id: number) => cleared.push(id) });
    expect(await io.send(true)).toEqual({ status: 200, body: { base: '2.000000000', savedAt: '2:05 pm' } });
    expect(await io.send(false)).toEqual({ status: 409, body: undefined });
    expect(calls.map(([url, init]) => [url, init.method, init.keepalive, init.credentials, (init.body as unknown as { form: unknown }).form])).toEqual([
      ['/officer-area/news/x/autosave', 'POST', true, 'same-origin', form],
      ['/officer-area/news/x/autosave', 'POST', false, 'same-origin', form],
    ]);
    expect(io.later(() => {}, 60_000)).toBe(1);
    io.cancel(1);
    expect(cleared).toEqual([1]);
  });
});

describe('createAutosaver: an answer with no body', () => {
  it('reports an empty base and time rather than failing', async () => {
    const { a, c, sent, reports } = saver();
    a.changed();
    c.run(60_000);
    sent[0]?.answer.resolve({ status: 200 });
    await settle();
    expect(reports).toEqual([{ kind: 'saved', base: '', savedAt: '', settled: true }]);
  });

  it('sets no deadline timer when the sign-in has already passed its last two minutes', () => {
    const { c } = saver({ expiresMs: 60_000, start: 0 });
    expect(c.pending()).toBe(0);
  });
});

describe('wireEditor: auto-save on a page missing its parts', () => {
  it('still saves with no status line, no conflict note and no base field', async () => {
    const form = new FakeElement({ dataset: { draftKey: KEY, autosave: '/x/autosave' } });
    for (const sel of ['input[name="title"]', 'input[name="summary"]', 'textarea[name="markup"]']) form.children[sel] = [new FakeElement()];
    const doc = { querySelector: (sel: string) => (sel === 'form[data-editor]' ? form : null), querySelectorAll: () => [] };
    const c = clock();
    const sent: ReturnType<typeof deferred<{ status: number; body?: unknown }>>[] = [];
    wireEditor(doc as never, {
      storage: new FakeStorage() as never,
      win: new FakeWindow() as never,
      now: c.now,
      autosave: {
        send: () => {
          const d = deferred<{ status: number; body?: unknown }>();
          sent.push(d);
          return d.promise;
        },
        later: c.later,
        cancel: c.cancel,
      },
    } as never);
    form.dispatchEvent(new Event('input'));
    c.run(60_000);
    sent[0]?.resolve(OK());
    await settle();
    form.dispatchEvent(new Event('input'));
    c.run(60_000);
    sent[1]?.resolve({ status: 409 });
    await settle();
    expect(sent).toHaveLength(2);
  });
});
