// Progressive enhancement for putting the club on the home screen (R27). Every
// page works without this file; it only adds:
//   - the Android install button, shown once the browser offers installation;
//   - a hint inside Facebook's, Messenger's or Instagram's own browser, which
//     cannot install the site, to open the page in Chrome or Safari instead.
// Loaded as a same-origin module (CSP script-src 'self'); no inline script.

/** The in-app browsers' user-agent marks: Facebook (FBAN, FBAV, FB_IAB) and Instagram. */
export const IN_APP_BROWSER = /FBAN|FBAV|FB_IAB|Instagram/;

/**
 * @param {Window} win
 * @param {Pick<Document, 'querySelectorAll' | 'querySelector'>} doc
 */
export function wire(win, doc) {
  /** @type {(Event & { prompt(): Promise<void>, userChoice: Promise<unknown> }) | undefined} */
  let offer;
  const buttons = () => [...doc.querySelectorAll('[data-install]')];
  /** @param {boolean} hidden */
  const show = (hidden) => buttons().forEach((b) => ((/** @type {HTMLElement} */ (b)).hidden = hidden));

  win.addEventListener('beforeinstallprompt', (event) => {
    // Our button replaces the browser's own mini-banner.
    event.preventDefault();
    offer = /** @type {typeof offer} */ (event);
    show(false);
  });
  win.addEventListener('appinstalled', () => show(true));
  for (const button of buttons()) {
    button.addEventListener('click', async () => {
      const pending = offer;
      if (!pending) return;
      offer = undefined;
      await pending.prompt();
      await pending.userChoice;
      show(true);
    });
  }

  const hint = /** @type {HTMLElement | null} */ (doc.querySelector('[data-in-app-hint]'));
  if (hint && IN_APP_BROWSER.test(win.navigator.userAgent)) {
    hint.hidden = false;
    doc.querySelector('[data-in-app-hint-close]')?.addEventListener('click', () => (hint.hidden = true));
  }
}

if (typeof window !== 'undefined') wire(window, document);
