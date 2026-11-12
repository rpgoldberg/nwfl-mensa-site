// Progressive enhancement for /events (EVENTS2). Every link on the page works without this file: a
// day tile or grid day is a link to the same view at that date. It only adds:
//   - on arrival, the list's ribbon scrolled sideways to its selected day (the page itself is left
//     where the URL's #day- anchor put it);
//   - selecting a day in place: its tile marked, its events marked (list, week) or its day panel
//     shown (month), scrolled to, the URL and the view links keeping the date, and the day said once
//     to a screen reader;
//   - a horizontal swipe on the week strip, to the previous or next week (the arrows stay);
//   - Copy beside the feed address;
//   - on Android, the Android steps first in "Add our calendar", and no computer-only Google link;
//   - EV1: the compact toolbar's view picker (a <details>, working with no script) closed on Escape,
//     its button focused again, and on a tap or click anywhere outside it.
// Loaded as a same-origin module (CSP script-src 'self'); no inline script.

/** An Android browser. Chrome's Desktop site mode says Linux instead, and gets the computer's order. */
export const ANDROID = /Android/i;
/** How far a finger must move sideways, in CSS px, to step the week. */
const SWIPE = 60;

/**
 * @param {Window} win
 * @param {Pick<Document, 'querySelector' | 'querySelectorAll' | 'getElementById' | 'addEventListener'>} doc
 */
export function wireEvents(win, doc) {
  const root = doc.querySelector('[data-cal]');
  if (root) wireDays(win, doc, root.getAttribute('data-cal'));
  wirePicker(doc);
  wireCopy(win, doc);
  if (ANDROID.test(win.navigator.userAgent)) androidFirst(doc);
}

/**
 * @param {Window} win
 * @param {Pick<Document, 'querySelector' | 'querySelectorAll' | 'getElementById'>} doc
 * @param {string | null} view
 */
function wireDays(win, doc, view) {
  revealSelected(doc);
  const days = /** @type {HTMLAnchorElement[]} */ ([...doc.querySelectorAll('a[data-day]')]);
  const status = doc.querySelector('[data-cal-status]');
  const behavior = win.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';

  /** @param {HTMLAnchorElement} link */
  const select = (link) => {
    const date = link.getAttribute('data-day');
    for (const day of days) {
      if (day.getAttribute('data-day') === date) day.setAttribute('aria-current', 'true');
      else day.removeAttribute('aria-current');
    }
    for (const panel of /** @type {HTMLElement[]} */ ([...doc.querySelectorAll('[data-panel]')])) panel.hidden = panel.getAttribute('data-panel') !== date;
    for (const card of doc.querySelectorAll('[data-card-day]')) card.classList.toggle('is-sel', view !== 'month' && card.getAttribute('data-card-day') === date);
    doc.getElementById(`day-${date}`)?.scrollIntoView({ block: view === 'month' ? 'nearest' : 'start', behavior });
    const url = new URL(link.href);
    win.history.replaceState(null, '', `${url.pathname}${url.search}`);
    for (const other of doc.querySelectorAll('a[data-view]')) {
      const to = new URL(/** @type {HTMLAnchorElement} */ (other).href);
      to.searchParams.set('d', String(date));
      // List and Week go on to the day's events; Month has no anchor, so its grid stays in view.
      other.setAttribute('href', `${to.pathname}${to.search}${to.hash ? `#day-${date}` : ''}`);
    }
    if (status) status.textContent = link.getAttribute('aria-label') ?? '';
  };

  for (const link of days) {
    link.addEventListener('click', (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      select(link);
    });
  }

  const strip = doc.querySelector('[data-swipe]');
  const steps = /** @type {HTMLAnchorElement[]} */ ([...doc.querySelectorAll('a[data-step]')]);
  /** @type {{ x: number, y: number } | undefined} */
  let start;
  strip?.addEventListener(
    'touchstart',
    (event) => {
      const touch = /** @type {TouchEvent} */ (event).touches[0];
      start = touch && { x: touch.clientX, y: touch.clientY };
    },
    { passive: true },
  );
  strip?.addEventListener('touchend', (event) => {
    const touch = /** @type {TouchEvent} */ (event).changedTouches[0];
    const from = start;
    start = undefined;
    if (!from || !touch) return;
    const [dx, dy] = [touch.clientX - from.x, touch.clientY - from.y];
    if (Math.abs(dx) < SWIPE || Math.abs(dx) < 2 * Math.abs(dy)) return;
    const to = steps.find((s) => s.getAttribute('data-step') === (dx < 0 ? 'next' : 'prev'));
    if (to) win.location.assign(to.href);
  });
}

/**
 * The ribbon shows its selected tile, centred: its own scroll only, so the page stays where it is.
 *
 * @param {Pick<Document, 'querySelector'>} doc
 */
function revealSelected(doc) {
  const ribbon = doc.querySelector('.tiles--ribbon');
  const tile = ribbon?.querySelector('a[aria-current="true"]');
  if (!ribbon || !tile) return;
  const [r, t] = [ribbon.getBoundingClientRect(), tile.getBoundingClientRect()];
  ribbon.scrollLeft += t.left - r.left - (ribbon.clientWidth - t.width) / 2;
}

/**
 * @param {Window} win
 * @param {Pick<Document, 'querySelectorAll' | 'getElementById'>} doc
 */
function wireCopy(win, doc) {
  for (const button of /** @type {HTMLButtonElement[]} */ ([...doc.querySelectorAll('[data-copy]')])) {
    const field = /** @type {HTMLInputElement | null} */ (doc.getElementById(String(button.getAttribute('data-copy'))));
    const status = doc.getElementById(String(button.getAttribute('data-copy-status')));
    if (!field) continue;
    button.hidden = false;
    button.addEventListener('click', () => {
      const say = (/** @type {string} */ text) => {
        if (status) status.textContent = text;
      };
      win.navigator.clipboard.writeText(field.value).then(
        () => say('Copied the calendar address.'),
        () => {
          field.select();
          say('Select the address and copy it.');
        },
      );
    });
  }
}

/**
 * The view picker opens and works as a plain disclosure; this only closes it the ways a menu closes.
 *
 * @param {Pick<Document, 'querySelector' | 'addEventListener'>} doc
 */
function wirePicker(doc) {
  const picker = /** @type {HTMLDetailsElement | null} */ (doc.querySelector('[data-calpick]'));
  if (!picker) return;
  doc.addEventListener('keydown', (event) => {
    if (!picker.open || /** @type {KeyboardEvent} */ (event).key !== 'Escape') return;
    picker.open = false;
    /** @type {HTMLElement | null} */ (picker.querySelector('summary'))?.focus();
  });
  doc.addEventListener('click', (event) => {
    if (picker.open && !picker.contains(/** @type {Node | null} */ (event.target))) picker.open = false;
  });
}

/** @param {Pick<Document, 'querySelector' | 'querySelectorAll'>} doc */
function androidFirst(doc) {
  const panel = doc.querySelector('[data-addcal-panel]');
  const steps = doc.querySelector('[data-android]');
  if (panel && steps) panel.prepend(steps);
  for (const el of /** @type {HTMLElement[]} */ ([...doc.querySelectorAll('[data-not-android]')])) el.hidden = true;
}

if (typeof window !== 'undefined') wireEvents(window, document);
