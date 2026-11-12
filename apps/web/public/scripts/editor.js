// Progressive enhancement for the officer editor's edit page (EDITOR E3, spec S4, SPEC-v3 3.1). Without
// this file the page is a plain form: the "How to format" box shows each mark, the length line is the
// server's, and Save draft posts the form (post/redirect/get). With it:
//   - the toolbar shows, and each button (with its word on it) wraps the selected text in its mark;
//   - the length line follows the typing (src/lib/editor/writer.ts counts the same way);
//   - the unsent text is kept in this tab's sessionStorage, keyed by item (never localStorage, so a shared
//     computer keeps nothing once the tab is closed); when the page opens with other text, it is offered
//     back; once a save has gone through (the page says so with data-saved) the copy is dropped;
//   - leaving with unsaved changes asks first;
//   - the sign-in line turns to "Save now" for its last five minutes;
//   - a markup problem's link puts the cursor at the start of its line.
// Loaded as a same-origin module (CSP script-src 'self'), only by the edit page; no inline script.

const SOON_MS = 5 * 60 * 1000;
const WORDS_PER_PAGE = 500;

/** What each mark puts in when nothing is selected, for the officer to type over. */
const FILL = { bold: 'bold words', italic: 'slanted words', link: 'words to click', members: 'words for members only' };

/**
 * The text with `mark` applied to the selection from `start` to `end`, and what to select after.
 * @param {string} value @param {number} start @param {number} end @param {string} mark
 * @returns {{ value: string, start: number, end: number }}
 */
export function applyMark(value, start, end, mark) {
  const before = value.slice(0, start);
  const after = value.slice(end);
  const chosen = value.slice(start, end);
  /** Wraps the selection (or the fill words) in `open` and `close`, and selects what is inside. @param {string} open @param {string} close @param {string} fill */
  const wrap = (open, close, fill) => {
    const inner = chosen === '' ? fill : chosen;
    return { value: `${before}${open}${inner}${close}${after}`, start: start + open.length, end: start + open.length + inner.length };
  };
  // The whole lines the selection touches.
  const from = value.lastIndexOf('\n', start - 1) + 1;
  const lineEnd = value.indexOf('\n', end);
  const to = lineEnd === -1 ? value.length : lineEnd;
  /** Each whole line, changed by `change`, all selected after. @param {(line: string) => string} change */
  const lines = (change) => {
    const changed = value.slice(from, to).split('\n').map(change).join('\n');
    return { value: `${value.slice(0, from)}${changed}${value.slice(to)}`, start: from, end: from + changed.length };
  };
  switch (mark) {
    case 'bold':
      return wrap('**', '**', FILL.bold);
    case 'italic':
      return wrap('*', '*', FILL.italic);
    case 'link': {
      const label = chosen === '' ? FILL.link : chosen;
      const text = `[${label}](https://)`;
      const caret = start + text.length - 1;
      return { value: `${before}${text}${after}`, start: caret, end: caret };
    }
    case 'list':
      return lines((line) => (/^\s*[-*]\s/.test(line) ? line : `- ${line}`));
    case 'heading':
      return lines((line) => (/^#{1,6}\s/.test(line) ? line : `## ${line}`));
    case 'members': {
      if (!chosen.includes('\n')) return wrap(':members[', ']', FILL.members);
      const block = value.slice(from, to);
      const open = '::: members\n';
      return { value: `${value.slice(0, from)}${open}${block}\n:::${value.slice(to)}`, start: from + open.length, end: from + open.length + block.length };
    }
    default:
      return { value, start, end };
  }
}

/** The words a reader reads: as wordCount in src/lib/editor/writer.ts. @param {string} markup */
export function countWords(markup) {
  return markup
    .replace(/\]\([^)\s]*\)/g, ' ')
    .replace(/:members\[/g, ' ')
    .replace(/^\s*:::.*$/gm, ' ')
    .replace(/^\s*(?:#{1,6}|[-*]|\d+\.|>)\s+/gm, ' ')
    .split(/\s+/)
    .filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

/** @param {number} n @param {string} one @param {string} many */
const plural = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** As lengthText in src/lib/editor/writer.ts. @param {string} markup */
export function lengthText(markup) {
  const words = countWords(markup);
  if (words === 0) return 'No words yet.';
  return `${plural(words, 'word', 'words')}, about ${plural(Math.ceil(words / WORDS_PER_PAGE), 'newsletter page', 'newsletter pages')}.`;
}

/** Where line `line` (from 1) starts in `value`; past the last line, the end. @param {string} value @param {number} line */
export function lineStart(value, line) {
  let at = 0;
  for (let n = 1; n < line; n++) {
    const next = value.indexOf('\n', at);
    if (next === -1) return value.length;
    at = next + 1;
  }
  return at;
}

/**
 * @typedef {{ value: string, hidden: boolean, textContent: string | null, dataset: DOMStringMap, selectionStart: number, selectionEnd: number,
 *   setSelectionRange(start: number, end: number): void, focus(): void, querySelector(sel: string): any, querySelectorAll(sel: string): Iterable<any>,
 *   addEventListener(type: string, fn: (event: Event) => void): void }} Part
 */

/**
 * @param {Pick<Document, 'querySelector' | 'querySelectorAll'>} doc
 * @param {{ storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, win: Pick<Window, 'addEventListener' | 'setInterval'>, now: () => number }} env
 */
export function wireEditor(doc, { storage, win, now }) {
  const form = /** @type {Part | null} */ (doc.querySelector('form[data-editor]'));
  if (!form) return;
  const title = /** @type {Part} */ (form.querySelector('input[name="title"]'));
  const summary = /** @type {Part} */ (form.querySelector('input[name="summary"]'));
  const markup = /** @type {Part} */ (form.querySelector('textarea[name="markup"]'));
  const length = /** @type {Part | null} */ (doc.querySelector('[data-length]'));
  const key = form.dataset['draftKey'] ?? '';
  let dirty = false;

  /** The tab's storage, or nothing when the browser refuses it (a private window, a full quota). @param {() => unknown} use */
  const safely = (use) => {
    try {
      return use();
    } catch {
      return undefined;
    }
  };
  const copy = () => ({ title: title.value, summary: summary.value, markup: markup.value });
  const showLength = () => {
    if (length) length.textContent = lengthText(markup.value);
  };
  const changed = () => {
    dirty = true;
    showLength();
    safely(() => storage.setItem(key, JSON.stringify(copy())));
  };

  const toolbar = /** @type {Part | null} */ (doc.querySelector('[data-toolbar]'));
  if (toolbar) {
    toolbar.hidden = false;
    for (const button of /** @type {Iterable<Part>} */ (toolbar.querySelectorAll('button[data-mark]'))) {
      button.addEventListener('click', () => {
        const next = applyMark(markup.value, markup.selectionStart, markup.selectionEnd, button.dataset['mark'] ?? '');
        markup.value = next.value;
        markup.setSelectionRange(next.start, next.end);
        markup.focus();
        changed();
      });
    }
  }

  showLength();
  form.addEventListener('input', changed);
  form.addEventListener('submit', () => {
    dirty = false;
  });
  win.addEventListener('beforeunload', (event) => {
    if (!dirty) return;
    event.preventDefault();
    /** @type {any} */ (event).returnValue = '';
  });

  // The tab's copy: dropped once saved; offered back when the page opens with other text.
  if (form.dataset['saved'] === 'yes') safely(() => storage.removeItem(key));
  else {
    const kept = /** @type {any} */ (safely(() => JSON.parse(storage.getItem(key) ?? 'null')));
    const restore = /** @type {Part | null} */ (doc.querySelector('[data-restore]'));
    const usable = kept !== null && typeof kept === 'object' && typeof kept.title === 'string' && typeof kept.summary === 'string' && typeof kept.markup === 'string';
    if (restore && usable && JSON.stringify(kept) !== JSON.stringify(copy())) {
      restore.hidden = false;
      restore.querySelector('[data-restore-yes]').addEventListener('click', () => {
        title.value = kept.title;
        summary.value = kept.summary;
        markup.value = kept.markup;
        restore.hidden = true;
        changed();
      });
      restore.querySelector('[data-restore-no]').addEventListener('click', () => {
        safely(() => storage.removeItem(key));
        restore.hidden = true;
      });
    }
  }

  // The sign-in line: "Save now" for its last five minutes.
  const signIn = /** @type {Part | null} */ (doc.querySelector('[data-sign-in]'));
  if (signIn) {
    const expires = Number(signIn.dataset['expires']) * 1000;
    const tick = () => {
      if (now() < expires - SOON_MS || signIn.dataset['state'] === 'soon') return;
      signIn.textContent = signIn.dataset['soon'] ?? '';
      signIn.dataset['state'] = 'soon';
    };
    tick();
    win.setInterval(tick, 30_000);
  }

  // A problem's link: the cursor at the start of its line.
  for (const link of /** @type {Iterable<Part>} */ (doc.querySelectorAll('a[data-line]'))) {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      const at = lineStart(markup.value, Number(link.dataset['line']));
      markup.setSelectionRange(at, at);
      markup.focus();
    });
  }
}

/** The tab's sessionStorage, or a stand-in that keeps nothing when the browser will not give it. */
function tabStorage() {
  try {
    return window.sessionStorage;
  } catch {
    return { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  }
}

if (typeof document !== 'undefined') wireEditor(document, { storage: tabStorage(), win: window, now: () => Date.now() });
