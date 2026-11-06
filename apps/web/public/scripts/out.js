// The leaving page's countdown (LINKS L4, D3b "countdown"): progressive enhancement only. Without
// this file the countdown box stays hidden and the page waits for a press on Continue, as the guard
// does. With it the box shows, Stop takes the focus, and the countdown is announced once through
// the page's status region (never every second; the seconds on screen are hidden from screen
// readers). When it ends this tab goes on with location.replace, since a browser blocks a new tab
// that no press opened, and the leaving page drops out of the history, so Back returns to the
// newsletter. Stop ends it for good and hands the focus to Continue. Anything else the reader does
// on the page ends it the same way, so no one is sent away mid-choice or mid-read: any key or press,
// Stop included (Stop holds the focus, so an arrow, Page Down, Ctrl and + or Escape all land on it),
// the wheel, a touch scroll, an input, or a focus that is not on Stop (the radio for next time, the
// form, Continue, Back, anywhere), heard on the whole page in the capture phase, passively, so no
// scroll waits on it. The timer ends at once. On a press the box goes only once the press is over,
// and after a key on Stop only once the key's own click (Enter) has run, so the page never moves
// under the pointer mid-click. The focus stays where the reader put it, unless it was on Stop, which
// goes with its box: then it moves to Continue. The stop is said once. Loaded as a same-origin module
// (CSP script-src 'self'); no inline script.

export const SECONDS = 5;

const STOPPED = 'Stopped. You are still on our site. Choose Continue when you are ready.';
/** What the reader does on the page that ends the countdown; a focusin only when it is not on Stop. */
const READER_EVENTS = /** @type {const} */ (['focusin', 'input', 'pointerdown', 'keydown', 'wheel', 'touchmove']);
/** Heard first, and never holding up a scroll: no listener here cancels anything. */
const HEARD = /** @type {const} */ ({ capture: true, passive: true });
/** The end of a press. */
const PRESS_OVER = /** @type {const} */ (['pointerup', 'pointercancel']);

/**
 * @param {Pick<Document, 'querySelector' | 'addEventListener' | 'removeEventListener' | 'activeElement'>} doc
 * @param {{ setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout, setInterval: typeof setInterval, clearInterval: typeof clearInterval, location: Pick<Location, 'replace'> }} win
 */
export function wireCountdown(doc, win) {
  const box = /** @type {HTMLElement | null} */ (doc.querySelector('[data-out-countdown]'));
  const go = /** @type {HTMLAnchorElement | null} */ (doc.querySelector('a[data-out-continue]'));
  const status = /** @type {HTMLElement | null} */ (doc.querySelector('[data-out-status]'));
  const seconds = /** @type {HTMLElement | null} */ (doc.querySelector('[data-out-seconds]'));
  const stop = /** @type {HTMLElement | null} */ (doc.querySelector('[data-out-stop]'));
  if (!box || !go || !status || !seconds || !stop) return;
  let left = SECONDS;
  box.hidden = false;
  seconds.textContent = String(left);
  status.textContent = `Going to ${box.getAttribute('data-host') ?? 'the other site'} in ${SECONDS} seconds. Press Stop to stay on this page.`;
  stop.focus();
  const tick = win.setInterval(() => {
    left -= 1;
    seconds.textContent = String(left);
  }, 1000);
  const timer = win.setTimeout(() => {
    win.clearInterval(tick);
    win.location.replace(go.href);
  }, SECONDS * 1000);
  let running = true;
  let settled = false;
  /** The timer ends, and the page stops listening for the reader. */
  const halt = () => {
    if (!running) return;
    running = false;
    win.clearTimeout(timer);
    win.clearInterval(tick);
    for (const type of READER_EVENTS) doc.removeEventListener(type, reader, true);
  };
  /** The countdown ends for good: its box goes, and the stop is said, once. A focus on Stop goes to Continue. */
  const end = () => {
    halt();
    for (const type of PRESS_OVER) doc.removeEventListener(type, pressOver, true);
    if (settled) return;
    settled = true;
    const lost = box.contains(doc.activeElement);
    box.hidden = true;
    status.textContent = STOPPED;
    // The reader may be scrolling: the focus moves, the page does not.
    if (lost) go.focus({ preventScroll: true });
  };
  // After the press's own click, so what was pressed is still where it was.
  const pressOver = () => {
    for (const type of PRESS_OVER) doc.removeEventListener(type, pressOver, true);
    win.setTimeout(end, 0);
  };
  /** @param {Event} event */
  const reader = (event) => {
    const onStop = stop.contains(/** @type {Node | null} */ (event.target));
    // The focus coming to Stop is not the reader acting; the key or press that brought it is heard.
    if (onStop && event.type === 'focusin') return;
    halt();
    if (event.type === 'pointerdown') for (const type of PRESS_OVER) doc.addEventListener(type, pressOver, HEARD);
    else if (onStop) win.setTimeout(end, 0);
    else end();
  };
  for (const type of READER_EVENTS) doc.addEventListener(type, reader, HEARD);
  stop.addEventListener('click', () => {
    end();
    go.focus();
  });
  go.addEventListener('click', end);
}

if (typeof document !== 'undefined') wireCountdown(document, window);
