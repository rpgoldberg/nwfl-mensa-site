// Progressive enhancement for the review page (EDITOR E4, S7). Without this file the page is a plain form:
// Save my answers, Approve and Send back post it, and the server gives back what was typed when a step
// cannot be made. With it:
//   - each note typed (a link's note, the note for the writer, the break-glass reason: the fields marked
//     data-keep) is kept in this tab's sessionStorage, never localStorage, under the form's data-review-key
//     (the item and the version it was typed on), and put back into an empty field when the page opens
//     again: after a sign-in that ran out, a reload, or a list of links that changed;
//   - each Yes or No chosen (the radio buttons marked data-keep-choice, by row) is kept the same way, and
//     put back as the page opens again: a choice not yet saved wins over the answer shown (N3);
//   - once answers are saved (the form says so with data-saved), the notes of the links now answered
//     (data-answered) are dropped: they were saved with their answers; and every choice kept is dropped,
//     as every one was sent. A list of links that changed (data-relisted) drops the choices too: the
//     page asks for them again;
//   - the sign-in line turns to "Save now" for its last five minutes.
// Loaded as a same-origin module (CSP script-src 'self'), only by the review page; no inline script.

/** The sign-in line says "Save now" this long before the sign-in ends. */
export const SOON_MS = 5 * 60 * 1000;

/** The prefix of a kept choice's name: "answer:<row key>". */
const CHOICE = 'answer:';

/**
 * @typedef {{ getItem(key: string): string | null, setItem(key: string, value: string): void, removeItem(key: string): void }} TabStorage
 * @typedef {{ value: string, dataset: Record<string, string | undefined>, addEventListener(type: string, fn: () => void): void }} Kept
 * @typedef {Kept & { checked: boolean }} Choice
 */

/**
 * @param {{ querySelector(selector: string): any }} doc
 * @param {{ storage: TabStorage, now: () => number, every: (fn: () => void) => void }} env
 */
export function wireReview(doc, { storage, now, every }) {
  const line = doc.querySelector('[data-sign-in]');
  if (line) {
    const expires = Number(line.dataset['expires']) * 1000;
    const check = () => {
      if (now() < expires - SOON_MS || line.dataset['state'] === 'soon') return;
      line.textContent = line.dataset['soon'] ?? '';
      line.dataset['state'] = 'soon';
    };
    check();
    every(check);
  }
  const form = doc.querySelector('form[data-review]');
  if (!form) return;
  const key = form.dataset['reviewKey'] ?? '';
  /** @type {Kept[]} */
  const fields = [...form.querySelectorAll('[data-keep]')];
  /** @type {Choice[]} */
  const choices = [...form.querySelectorAll('[data-keep-choice]')];

  /** @returns {Record<string, string>} */
  const read = () => {
    try {
      const saved = JSON.parse(storage.getItem(key) ?? '{}');
      return saved !== null && typeof saved === 'object' ? saved : {};
    } catch {
      return {};
    }
  };
  /** @param {Record<string, string>} copy */
  const write = (copy) => {
    try {
      if (Object.keys(copy).length === 0) storage.removeItem(key);
      else storage.setItem(key, JSON.stringify(copy));
    } catch {
      // A private window or a full quota: the server still keeps what a post carries.
    }
  };

  const copy = read();
  if (form.dataset['saved']) for (const field of fields) if (field.dataset['answered']) delete copy[field.dataset['keep'] ?? ''];
  if (form.dataset['saved'] || form.dataset['relisted']) {
    for (const name of Object.keys(copy)) if (name.startsWith(CHOICE)) delete copy[name];
    write(copy);
  }
  for (const field of fields) {
    const name = field.dataset['keep'] ?? '';
    const typed = copy[name];
    if (field.value === '' && typeof typed === 'string') field.value = typed;
    field.addEventListener('input', () => {
      const next = read();
      if (field.value === '') delete next[name];
      else next[name] = field.value;
      write(next);
    });
  }
  for (const choice of choices) {
    const name = choice.dataset['keepChoice'] ?? '';
    if (typeof copy[name] === 'string') choice.checked = copy[name] === choice.value;
    choice.addEventListener('change', () => {
      if (!choice.checked) return;
      const next = read();
      next[name] = choice.value;
      write(next);
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

if (typeof document !== 'undefined') wireReview(document, { storage: tabStorage(), now: () => Date.now(), every: (fn) => window.setInterval(fn, 15_000) });
