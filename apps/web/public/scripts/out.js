// The leaving page's countdown (LINKS L4, D3b "countdown"): progressive enhancement only. Without
// this file the countdown box stays hidden and the page waits for a press on Continue, as the guard
// does. With it the box shows, Stop takes the focus, and the countdown is announced once through
// the page's status region (never every second; the seconds on screen are hidden from screen
// readers). When it ends this tab goes on with location.replace, since a browser blocks a new tab
// that no press opened, and the leaving page drops out of the history, so Back returns to the
// newsletter. Stop ends it for good and hands the focus to Continue; pressing Continue (its own
// new tab) ends it too. Loaded as a same-origin module (CSP script-src 'self'); no inline script.

export const SECONDS = 5;

/**
 * @param {Pick<Document, 'querySelector'>} doc
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
  const end = () => {
    win.clearTimeout(timer);
    win.clearInterval(tick);
    box.hidden = true;
  };
  stop.addEventListener('click', () => {
    end();
    status.textContent = 'Stopped. You are still on our site. Choose Continue when you are ready.';
    go.focus();
  });
  go.addEventListener('click', end);
}

if (typeof document !== 'undefined') wireCountdown(document, window);
