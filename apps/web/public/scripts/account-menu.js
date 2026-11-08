// Progressive enhancement for the header's Account menu (W-LOOK2). Without this file the menu is a
// plain <details>: its button opens and closes it, by tap, click, Enter or Space, and the browser
// tells a screen reader whether it is open. With it Escape closes the menu and puts the focus back on
// its button, and a tap or the focus anywhere else closes it, so an open menu never stays over the
// page. Loaded as a same-origin module (CSP script-src 'self'); no inline script.

/**
 * @param {Pick<Document, 'querySelector' | 'addEventListener'>} doc
 * @returns {boolean} whether the page has a menu to wire (only a signed-in page does)
 */
export function wireAccountMenu(doc) {
  const menu = /** @type {HTMLDetailsElement | null} */ (doc.querySelector('[data-account-menu]'));
  if (!menu) return false;
  const summary = /** @type {HTMLElement} */ (menu.querySelector('summary'));
  menu.addEventListener('keydown', (event) => {
    if (!menu.open || /** @type {KeyboardEvent} */ (event).key !== 'Escape') return;
    event.preventDefault();
    menu.open = false;
    summary.focus();
  });
  /** @param {Event} event */
  const closeOutside = (event) => {
    if (menu.open && !menu.contains(/** @type {Node} */ (event.target))) menu.open = false;
  };
  doc.addEventListener('click', closeOutside);
  doc.addEventListener('focusin', closeOutside);
  return true;
}

if (typeof document !== 'undefined') wireAccountMenu(document);
