// Progressive enhancement for the text size slider in the Aa panel (R30,
// W-LOOK). Without this file the slider sits in the panel's form with a Use
// this size button, and A− and A+ post the form. With it a change shows at
// once, and is saved straight away to the same long-lived cookie, through
// /prefs (the cookie is HttpOnly). Loaded as a same-origin module (CSP
// script-src 'self'); no inline script.

/**
 * Saves notch `step` as Use this size would. /prefs answers with a redirect
 * back to the page; it is not followed, and its cookie is kept all the same.
 *
 * @param {number} step
 * @returns {Promise<void>}
 */
export async function postSize(step) {
  const res = await fetch('/prefs', { method: 'POST', body: new URLSearchParams({ size: 'set', step: String(step) }), redirect: 'manual' });
  if (res.type !== 'opaqueredirect' && !res.ok) throw new Error(`/prefs answered ${res.status}`);
}

/**
 * @param {Pick<Document, 'getElementById' | 'documentElement'>} doc
 * @param {(step: number) => Promise<void>} save
 */
export function wireSize(doc, save) {
  const slider = /** @type {HTMLInputElement | null} */ (doc.getElementById('text-size'));
  const named = slider?.dataset['sizes'];
  if (!slider || !named) return;
  const sizes = named.split(' ');
  const form = slider.form;
  const useThis = /** @type {HTMLButtonElement | null | undefined} */ (form?.querySelector('[data-size-set]'));
  if (useThis) useThis.hidden = true;

  /** @param {number} step */
  const show = (step) => {
    slider.value = String(step);
    slider.setAttribute('aria-valuetext', `${sizes[step]} percent`);
    doc.documentElement.dataset['size'] = sizes[step];
  };
  /** @param {number} step */
  const commit = (step) => {
    show(step);
    save(step).catch(() => {
      // Saving failed (offline, say): post the form as with no script at all.
      if (!form || !useThis) return;
      useThis.hidden = false;
      form.requestSubmit(useThis);
    });
  };

  slider.addEventListener('input', () => show(Number(slider.value)));
  slider.addEventListener('change', () => commit(Number(slider.value)));
  for (const delta of [-1, 1]) {
    const button = /** @type {HTMLElement | null | undefined} */ (form?.querySelector(`[data-size-step="${delta}"]`));
    button?.addEventListener('click', (event) => {
      event.preventDefault();
      commit(Math.min(Math.max(Number(slider.value) + delta, 0), sizes.length - 1));
      // At either end the button gives way to its disabled twin (site.css): focus stays in the panel.
      if (button.getClientRects().length === 0) slider.focus();
    });
  }
}

if (typeof document !== 'undefined') wireSize(document, postSize);
