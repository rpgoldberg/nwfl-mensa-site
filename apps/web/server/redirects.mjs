// @ts-check
// Old nwflorida.us URLs (R16): newsletters and emails still link the old
// pages and files, so each old URL is redirected to its new home or answered
// 410 Gone. The table is server/old-site.json; its "about" field explains the
// sections. Applied by the server wrapper before anything else.
import { createHash } from 'node:crypto';

/**
 * @typedef {{
 *   moved: Record<string, string>, interim: Record<string, string>,
 *   movedHashed: Record<string, string>, interimHashed: Record<string, string>,
 *   gone: string[], goneHashed: string[],
 *   uploads: Record<string, string>, goneUploads: string[], goneDirs: string[],
 * }} OldSite
 * @typedef {{ status: 301 | 302, location: string } | { status: 410 }} Answer
 * @typedef {{ pages: Map<string, Answer>, uploads: Map<string, Answer>, goneDirs: string[] }} Tables
 */

/** @param {string} key */
const sha = (key) => createHash('sha256').update(key).digest('hex');

/**
 * @param {OldSite} data
 * @returns {Tables}
 */
export function compileRedirects(data) {
  /** @type {Map<string, Answer>} */
  const pages = new Map();
  for (const [from, to] of Object.entries(data.moved)) pages.set(from, { status: 301, location: to });
  for (const [from, to] of Object.entries(data.interim)) pages.set(from, { status: 302, location: to });
  for (const [hash, to] of Object.entries(data.movedHashed)) pages.set(hash, { status: 301, location: to });
  for (const [hash, to] of Object.entries(data.interimHashed)) pages.set(hash, { status: 302, location: to });
  for (const key of [...data.gone, ...data.goneHashed]) pages.set(key, { status: 410 });
  /** @type {Map<string, Answer>} */
  const uploads = new Map();
  for (const [from, to] of Object.entries(data.uploads)) uploads.set(from, { status: 302, location: to });
  for (const from of data.goneUploads) uploads.set(from, { status: 410 });
  return { pages, uploads, goneDirs: data.goneDirs };
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
  const answer = tables.pages.get(key) ?? tables.pages.get(sha(key));
  // A bare path that is already a page of the new site is that page, never a loop.
  if (!answer || ('location' in answer && answer.location === path)) return undefined;
  return answer;
}
