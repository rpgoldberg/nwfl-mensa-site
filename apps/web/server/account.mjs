// @ts-check
// The header's account area, written once: the layout renders it, and the
// server wrapper puts the signed-in version on prerendered pages (built with
// Sign in). The display name comes from the sign-in provider, so it is escaped.
// Signed in: the name, Your account (the group's enrolees), Officer area (those
// the officer area admits) and Sign out; below 1200 px wide, in an Account menu (W-LOOK2).

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
 * The reader's role in words, by the highest group they hold (W-LOOK2); none for an enrolee alone,
 * whose standing only the API's records know (groups.mjs).
 *
 * @param {{ groups: readonly string[] }} session
 * @returns {string | undefined}
 */
export function roleFor(session) {
  const has = (/** @type {string} */ g) => session.groups.includes(g);
  if (has('nwfl-admin')) return 'Administrator';
  if (has('nwfl-webmaster')) return 'Webmaster';
  if (has('nwfl-officers')) return 'Officer';
  if (has('nwfl-membership-approvers')) return 'Membership approver';
  if (has('nwfl-members')) return 'Member';
  return undefined;
}

/** A person: the icon of Sign in and Account (decorative: the word is beside it). */
const PERSON_ICON =
  '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c.9-4.2 4-6.5 8-6.5s7.1 2.3 8 6.5"/></svg>';

/**
 * W-LOOK2: signed in, the area holds the wide screen's row (the name, Your account, the Officer area and
 * Sign out, as before) and the narrower screen's Account menu: a native <details>, so it opens with no
 * script, holding the same, the role too. CSS shows one; the other is display: none, so a reader and a
 * screen reader only ever meet one. account-menu.js adds Escape and closing on a tap elsewhere.
 *
 * @param {Session | undefined} session
 * @param {{ back: string, signIn: boolean }} opts back: where Sign in returns to;
 *   signIn: false in a build with sign-in off (MT-50), which offers none
 */
export function accountHtml(session, { back, signIn }) {
  if (!session) {
    const link = signIn ? `<a class="hbtn hbtn--primary hbtn--stack" href="/sign-in?return=${encodeURIComponent(back)}">${PERSON_ICON}<span class="hbtn__word">Sign in</span></a>` : '';
    return `<div class="account" data-account="anon">${link}</div>`;
  }
  const name = escapeHtml(session.name);
  const officer = officerAreaFor(session) ? '<a class="hbtn" href="/officer-area">Officer area</a>' : '';
  // W-SIGNUP fix 1: one of the group's enrolees reaches their own account page (/account) from every page.
  const account = session.enrolee ? '<a class="hbtn" href="/account">Your account</a>' : '';
  const signOut = '<form class="sign-out" method="post" action="/sign-out"><button class="hbtn" type="submit">Sign out</button></form>';
  const role = roleFor(session);
  const items = [account, officer, signOut].filter(Boolean).map((item) => `<li>${item}</li>`).join('');
  return (
    '<div class="account" data-account="signed-in">' +
    `<div class="account__inline"><span class="who"><span class="visually-hidden">Signed in as </span>${name}</span>${account}${officer}${signOut}</div>` +
    `<details class="account__menu" data-account-menu><summary class="hbtn hbtn--stack">${PERSON_ICON}<span class="hbtn__word">Account</span></summary>` +
    '<div class="account__panel">' +
    `<p class="account__who"><span class="visually-hidden">Signed in as </span><b>${name}</b>${role ? ` <span class="account__role">${role}</span>` : ''}</p>` +
    `<ul class="account__items">${items}</ul>` +
    '</div></details>' +
    '</div>'
  );
}

/** The anonymous area with its Sign in link: absent from a build with sign-in off. */
const ANON_WITH_SIGN_IN = /<div class="account" data-account="anon"><a [^>]*>(?:(?!<\/a>)[\s\S])*<span class="hbtn__word">Sign in<\/span><\/a><\/div>/;

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
