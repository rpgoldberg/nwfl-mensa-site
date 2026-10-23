// @ts-check
// Old nwflorida.us URLs (R16): newsletters and emails still link the old
// pages and files, so each old URL is redirected to its new home or answered
// 410 Gone. The table is server/old-site.json; its "about" field explains the
// sections. Applied by the server wrapper before anything else.
/**
 * @typedef {{
 *   moved: Record<string, string>, interim: Record<string, string>, gone: string[],
 *   uploads: Record<string, string>, goneUploads: string[], goneDirs: string[],
 * }} OldSite
 * @typedef {{ status: 301 | 302, location: string } | { status: 410 }} Answer
 * @typedef {{ pages: Map<string, Answer>, uploads: Map<string, Answer>, goneDirs: string[] }} Tables
 */

/**
 * @param {OldSite} data
 * @returns {Tables}
 */
export function compileRedirects(data) {
  /** @type {Map<string, Answer>} */
  const pages = new Map();
  for (const [from, to] of Object.entries(data.moved)) pages.set(from, { status: 301, location: to });
  for (const [from, to] of Object.entries(data.interim)) pages.set(from, { status: 302, location: to });
  for (const key of data.gone) pages.set(key, { status: 410 });
  /** @type {Map<string, Answer>} */
  const uploads = new Map();
  for (const [from, to] of Object.entries(data.uploads)) uploads.set(from, { status: 302, location: to });
  for (const from of data.goneUploads) uploads.set(from, { status: 410 });
  return { pages, uploads, goneDirs: data.goneDirs };
}

/**
 * The site's own renamed pages (W-LOOK): the nav says Events and News, so the
 * calendar and the newsletter live at /events and /news, and an event's page
 * at /events/<id>. /calendar.ics stays where it is, as phones subscribed to it
 * must keep their feed; /events.ics is the same feed under the new name.
 */
const RENAMED = /** @type {const} */ ([
  [/^\/calendar\/?$/, '/events'],
  [/^\/calendar\/event\/([^/]+)$/, '/events/$1'],
  [/^\/newsletter\/?$/, '/news'],
  [/^\/newsletter\/(.+)$/, '/news/$1'],
]);

/**
 * The new path of a renamed page, or undefined when `pathname` was not renamed.
 *
 * @param {string} pathname
 * @returns {string | undefined}
 */
export function renamedPath(pathname) {
  for (const [from, to] of RENAMED) if (from.test(pathname)) return pathname.replace(from, to);
  return undefined;
}

/** /slug, /slug.html or /mobile/slug.html: the old site's three forms of one page. */
const OLD_PAGE = /^(?:\/mobile)?\/([a-z0-9][a-z0-9-]*?)(\.html)?$/;

/**
 * What to answer for an old URL, or undefined when the site should handle it.
 *
 * @param {string} pathname
 * @param {Tables} tables
 * @returns {Answer | undefined}
 */
export function resolveOldUrl(pathname, tables) {
  const path = pathname.toLowerCase();
  if (path === '/login.php') return { status: 302, location: '/sign-in' };
  if (path.endsWith('.php') || tables.goneDirs.some((dir) => path.startsWith(dir))) return { status: 410 };
  if (path.startsWith('/uploads/')) return tables.uploads.get(path) ?? { status: 410 };
  const page = OLD_PAGE.exec(path);
  if (!page) return undefined;
  const key = `/${page[1]}`;
  const answer = tables.pages.get(key);
  // A bare path that is already a page of the new site is that page, never a loop.
  if (!answer || ('location' in answer && answer.location === path)) return undefined;
  return answer;
}
