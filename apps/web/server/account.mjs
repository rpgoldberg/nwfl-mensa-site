// @ts-check
// The header's account area, written once: the layout renders it, and the
// server wrapper puts the signed-in version on prerendered pages (built with
// Sign in). The display name comes from the sign-in provider, so it is escaped.
// Signed in: the name, Your account (the group's enrolees), Officer area (those
// the officer area admits) and Sign out.

/** @typedef {import('./session.mjs').Session} Session */

/** @type {Record<string, string>} */
const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** @param {string} text */
export function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => /** @type {string} */ (ENTITIES[c]));
}

/** Who the officer area admits (W-SIGNUP fix 1), by the internal groups the session carries (groups.mjs). */
const OFFICER_AREA_GROUPS = ['nwfl-officers', 'nwfl-admin', 'nwfl-webmaster', 'nwfl-membership-approvers'];

/**
 * The officer area admits the officers, the Admin, the Webmaster and the membership approvers; each sees
 * only the links for what they may do there (src/pages/officer-area/index.astro).
 *
 * @param {{ groups: readonly string[] } | undefined} session
 */
export function officerAreaFor(session) {
  return session !== undefined && session.groups.some((g) => OFFICER_AREA_GROUPS.includes(g));
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
  const officer = officerAreaFor(session) ? '<a class="hbtn" href="/officer-area">Officer area</a>' : '';
  // W-SIGNUP fix 1: one of the group's enrolees reaches their own account page (/account) from every page.
  const account = session.enrolee ? '<a class="hbtn" href="/account">Your account</a>' : '';
  return (
    '<div class="account" data-account="signed-in">' +
    `<span class="who"><span class="visually-hidden">Signed in as </span>${escapeHtml(session.name)}</span>` +
    account +
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
