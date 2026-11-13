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
//   - a markup problem's link puts the cursor at the start of its line;
//   - round 2: a draft (the form says so with data-autosave, its address) saves itself a minute after the
//     last change, at once when the page is hidden or left (kept alive), and two minutes before the sign-in
//     ends; never with a save already out, never with nothing changed. Each save sends the base the page was
//     opened from (the form's "base"), and takes the new one. A polite status line says what happened; on
//     someone else's change, the end of the sign-in, or an item no longer a draft it stops for good, the
//     text kept. Save draft pressed while one is out waits for it, then sends the form with the new base.
// Loaded as a same-origin module (CSP script-src 'self'), only by the edit page; no inline script.

const SOON_MS = 5 * 60 * 1000;
/** Auto-save: a minute after the last change. */
export const AUTOSAVE_MS = 60_000;
/** ... and two minutes before the sign-in ends; within those two minutes, five seconds after a change. */
const BEFORE_END_MS = 2 * 60_000;
const LAST_MINUTES_MS = 5_000;
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
 * How long after a change to save it: a minute, or less so it is saved two minutes before the sign-in ends.
 * @param {number} now @param {number} expiresMs the sign-in's end (NaN: not known)
 */
export function autosaveDelay(now, expiresMs) {
  if (!Number.isFinite(expiresMs)) return AUTOSAVE_MS;
  const untilDeadline = expiresMs - BEFORE_END_MS - now;
  return untilDeadline <= 0 ? LAST_MINUTES_MS : Math.min(AUTOSAVE_MS, untilDeadline);
}

/**
 * @typedef {{ status: number, body?: any }} Answer
 * @typedef {{ kind: 'saved', base: string, savedAt: string, settled: boolean } | { kind: 'conflict' | 'signed-out' | 'not-draft' | 'retry' }} Outcome
 */

/**
 * The auto-save's rules, apart from the page: when to save, one save at a time, and what each answer means.
 * @param {{ send: (keepalive: boolean) => Promise<Answer>, later: (fn: () => void, ms: number) => any, cancel: (id: any) => void,
 *   now: () => number, expiresMs: number, report: (outcome: Outcome) => void }} io
 */
export function createAutosaver({ send, later, cancel, now, expiresMs, report }) {
  let edits = 0;
  let saved = 0;
  let stopped = false;
  /** @type {Promise<void> | undefined} */
  let flight;
  /** @type {any} */
  let timer;
  const unschedule = () => {
    if (timer !== undefined) cancel(timer);
    timer = undefined;
  };
  /** @param {number} ms */
  const schedule = (ms) => {
    unschedule();
    timer = later(() => {
      timer = undefined;
      void flush(false);
    }, ms);
  };
  /** @param {Answer} answer @param {number} at the edit count the save carried */
  const outcome = (answer, at) => {
    if (answer.status === 200) {
      saved = at;
      report({ kind: 'saved', base: String(answer.body?.base ?? ''), savedAt: String(answer.body?.savedAt ?? ''), settled: edits === at });
      if (edits > at) schedule(autosaveDelay(now(), expiresMs));
      return;
    }
    const kind = answer.status === 409 ? 'conflict' : answer.status === 401 ? 'signed-out' : answer.status === 422 ? 'not-draft' : undefined;
    if (kind) {
      stopped = true;
      unschedule();
      report({ kind });
      return;
    }
    report({ kind: 'retry' });
    schedule(AUTOSAVE_MS);
  };
  /** Saves now, unless stopped, a save is out, or nothing changed. @param {boolean} [keepalive] */
  const flush = (keepalive = false) => {
    if (stopped || flight || edits === saved) return flight ?? Promise.resolve();
    unschedule();
    const at = edits;
    flight = send(keepalive)
      .then(
        (answer) => answer,
        () => ({ status: 0 }),
      )
      .then((answer) => {
        flight = undefined;
        outcome(answer, at);
      });
    return flight;
  };
  if (Number.isFinite(expiresMs) && expiresMs - BEFORE_END_MS > now()) later(() => void flush(false), expiresMs - BEFORE_END_MS - now());
  return {
    changed() {
      edits += 1;
      if (!stopped) schedule(autosaveDelay(now(), expiresMs));
    },
    flush,
    /** Whether a save is out. */
    busy: () => flight !== undefined,
    /** Settles once no save is out. */
    idle: () => flight ?? Promise.resolve(),
    stopped: () => stopped,
  };
}

/** What the status line says for each outcome but a save. */
const AUTOSAVE_WORDS = {
  conflict: 'Not saved: someone else changed this draft. Your text is kept here.',
  'signed-out': 'Not saved automatically: your sign-in has ended. Your text is kept here: press Save draft.',
  'not-draft': 'Not saved automatically: it is no longer a draft. Your text is kept here: press Save draft.',
  retry: 'Not saved yet: will try again.',
};

/**
 * @typedef {{ value: string, hidden: boolean, textContent: string | null, dataset: DOMStringMap, selectionStart: number, selectionEnd: number,
 *   setSelectionRange(start: number, end: number): void, focus(): void, querySelector(sel: string): any, querySelectorAll(sel: string): Iterable<any>,
 *   addEventListener(type: string, fn: (event: Event) => void): void }} Part
 */

/**
 * @param {Pick<Document, 'querySelector' | 'querySelectorAll'> & Partial<Pick<Document, 'addEventListener' | 'visibilityState'>>} doc
 * @param {{ storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, win: Pick<Window, 'addEventListener' | 'setInterval'> & Partial<Pick<Window, 'setTimeout' | 'clearTimeout'>>, now: () => number,
 *   autosave?: { send: (keepalive: boolean) => Promise<Answer>, later: (fn: () => void, ms: number) => any, cancel: (id: any) => void } }} env
 */
export function wireEditor(doc, { storage, win, now, autosave }) {
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
  // Round 2: auto-save, on a draft only (the form carries data-autosave, its address).
  const signIn = /** @type {Part | null} */ (doc.querySelector('[data-sign-in]'));
  const statusLine = /** @type {Part | null} */ (doc.querySelector('[data-autosave-status]'));
  const conflictNote = /** @type {Part | null} */ (doc.querySelector('[data-autosave-conflict]'));
  const baseField = /** @type {Part | null} */ (form.querySelector('input[name="base"]'));
  const address = form.dataset['autosave'];
  const io = address ? (autosave ?? browserAutosave(address, form, win)) : undefined;
  const saver = io
    ? createAutosaver({
        ...io,
        now,
        expiresMs: signIn ? Number(signIn.dataset['expires']) * 1000 : Number.NaN,
        report: (outcome) => {
          if (outcome.kind === 'saved') {
            if (statusLine) statusLine.textContent = `Saved automatically at ${outcome.savedAt}.`;
            if (baseField) baseField.value = outcome.base;
            if (outcome.settled) {
              dirty = false;
              safely(() => storage.removeItem(key));
            }
            return;
          }
          if (statusLine) statusLine.textContent = AUTOSAVE_WORDS[outcome.kind];
          if (outcome.kind === 'conflict' && conflictNote) conflictNote.hidden = false;
        },
      })
    : undefined;
  // The status line is the script's: with no script, nothing saves itself, so it stays hidden.
  if (saver && statusLine) statusLine.hidden = false;

  const changed = () => {
    dirty = true;
    showLength();
    safely(() => storage.setItem(key, JSON.stringify(copy())));
    saver?.changed();
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
  form.addEventListener('submit', (event) => {
    dirty = false;
    // A Save draft pressed while an automatic save is out waits for it, then goes with the new base.
    if (saver?.busy()) {
      event.preventDefault();
      void saver.idle().then(() => /** @type {any} */ (form).submit());
    }
  });
  doc.addEventListener?.('visibilitychange', () => {
    if (doc.visibilityState === 'hidden') void saver?.flush(true);
  });
  win.addEventListener('pagehide', () => void saver?.flush(true));
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

/**
 * The browser's side of auto-save: the form posted to its address, same-origin (Astro's origin check
 * guards it as it guards the form), kept alive when asked so a hidden or closing page still sends it.
 * @param {string} address @param {any} form @param {any} win
 */
export function browserAutosave(address, form, win) {
  return {
    /** @param {boolean} keepalive */
    send: async (keepalive) => {
      const answer = await fetch(address, { method: 'POST', body: new FormData(form), keepalive, credentials: 'same-origin', headers: { accept: 'application/json' } });
      return { status: answer.status, body: answer.ok ? await answer.json() : undefined };
    },
    /** @param {() => void} fn @param {number} ms */
    later: (fn, ms) => win.setTimeout(fn, ms),
    /** @param {any} id */
    cancel: (id) => win.clearTimeout(id),
  };
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
