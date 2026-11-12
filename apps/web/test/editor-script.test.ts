// public/scripts/editor.js is progressive enhancement for the edit page (EDITOR E3, S4). Without it the
// page is a plain form with the "How to format" box, and Save draft posts it. With it: the toolbar shows
// and wraps the selected text in each mark; the word count follows the typing; the unsent text is kept
// in the tab's sessionStorage (never localStorage), offered back when the page opens with other text, and
// dropped once a save has gone through; leaving with unsaved changes asks first; the sign-in line turns
// to "Save now" for its last five minutes; and a problem's line link puts the cursor on that line.
// Here it runs against small stand-ins for the document, the tab's storage and the window.
import { describe, expect, it } from 'vitest';
import { applyMark, countWords, lengthText, lineStart, wireEditor } from '../public/scripts/editor.js';
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
