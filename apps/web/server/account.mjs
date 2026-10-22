// @ts-check
// The header's account area, written once: the layout renders it, and the
// server wrapper puts the signed-in version on prerendered pages (built with
// Sign in). The display name comes from the sign-in provider, so it is escaped.

/** @typedef {import('./session.mjs').Session} Session */

/** @type {Record<string, string>} */
const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** @param {string} text */
export function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => /** @type {string} */ (ENTITIES[c]));
}

/**
 * @param {Session | undefined} session
 * @param {{ back: string, signIn: boolean }} opts back: where Sign in returns to;
 *   signIn: false in a build with sign-in off (MT-50), which offers none
 */
export function accountHtml(session, { back, signIn }) {
  if (!session) {
    const link = signIn ? `<a class="hbtn hbtn--primary" href="/sign-in?return=${encodeURIComponent(back)}">Sign in</a>` : '';
    return `<div class="account" data-account="anon">${link}</div>`;
  }
  const officer = session.officer ? '<a class="hbtn" href="/officer-area">Officer area</a>' : '';
  return (
    '<div class="account" data-account="signed-in">' +
    `<span class="who"><span class="visually-hidden">Signed in as </span>${escapeHtml(session.name)}</span>` +
    officer +
    '<form class="sign-out" method="post" action="/sign-out"><button class="hbtn" type="submit">Sign out</button></form>' +
    '</div>'
  );
}

/** The anonymous area with its Sign in link: absent from a build with sign-in off. */
const ANON_WITH_SIGN_IN = /<div class="account" data-account="anon"><a [^>]*>Sign in<\/a><\/div>/;

/**
 * A prerendered page for a signed-in reader: their account area in place of Sign in.
 *
 * @param {string} html
 * @param {Session | undefined} session
 */
export function stampAccount(html, session) {
  if (!session) return html;
  return html.replace(ANON_WITH_SIGN_IN, () => accountHtml(session, { back: '/', signIn: true }));
}
