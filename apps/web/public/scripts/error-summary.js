// Progressive enhancement for a form's error summary (W-SIGNUP fix 1, NOTE-6). Without this file a
// form sent with problems still opens with the summary at the top, each problem a link to its field.
// With it the summary takes focus as the page opens, so a screen reader reads the problems first,
// and each link puts the cursor in its field rather than only scrolling to it. Loaded as a
// same-origin module (CSP script-src 'self'), only by a page showing a summary; no inline script.

/**
 * @param {Pick<Document, 'querySelector' | 'getElementById'>} doc
 */
export function wireErrorSummary(doc) {
  const summary = /** @type {HTMLElement | null} */ (doc.querySelector('[data-error-summary]'));
  if (!summary) return;
  for (const link of summary.querySelectorAll('a[href^="#"]')) {
    link.addEventListener('click', (event) => {
      const field = doc.getElementById((link.getAttribute('href') ?? '').slice(1));
      if (!field) return;
      event.preventDefault();
      field.scrollIntoView();
      field.focus();
    });
  }
  summary.focus();
}

if (typeof document !== 'undefined') wireErrorSummary(document);
