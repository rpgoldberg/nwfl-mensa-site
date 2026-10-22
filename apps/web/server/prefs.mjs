// @ts-check
// The reader's text size and theme (R30): two cookies the server reads to
// render <html data-size data-theme>, so pages arrive in the reader's settings
// with no script. Shared by the Astro layout, the /prefs form handler and the
// server wrapper, which stamps them on prerendered pages.
//
// Host-only by the __Host- prefix (Secure, Path=/, no Domain): the staging host
// sits under a parent domain shared with other apps, and a browser refuses a
// __Host- cookie from anywhere but this exact host. A same-named cookie without
// the prefix, which a sibling could set on the parent domain, is never read.

export const SIZE_COOKIE = '__Host-nwfl-size';
export const THEME_COOKIE = '__Host-nwfl-theme';

/** @typedef {1 | 2 | 3 | 4 | 5} Size */
/** @typedef {'light' | 'dark' | 'contrast'} Theme */
/** @typedef {{ size: Size, theme: Theme | undefined }} Prefs */

/** Size 1 is 100 %, each step adds 25, size 5 is 200 % (tokens.css). */
export const SIZES = /** @type {const} */ ([1, 2, 3, 4, 5]);
export const THEMES = /** @type {const} */ (['light', 'dark', 'contrast']);

/** No cookie: 100 % and whatever the device asks for. */
export const DEFAULT_PREFS = Object.freeze(/** @type {Prefs} */ ({ size: 1, theme: undefined }));

const YEAR = 60 * 60 * 24 * 365;

/**
 * @param {string | null | undefined} cookieHeader
 * @param {string} name
 */
function cookieValue(cookieHeader, name) {
  for (const pair of (cookieHeader ?? '').split(';')) {
    const at = pair.indexOf('=');
    if (at !== -1 && pair.slice(0, at).trim() === name) return pair.slice(at + 1).trim();
  }
  return undefined;
}

/**
 * @param {string | undefined} value
 * @returns {Size | undefined}
 */
function toSize(value) {
  return SIZES.find((s) => String(s) === value);
}

/**
 * @param {string | undefined} value
 * @returns {Theme | undefined}
 */
function toTheme(value) {
  return THEMES.find((t) => t === value);
}

/**
 * @param {string | null | undefined} cookieHeader
 * @returns {Prefs}
 */
export function readPrefs(cookieHeader) {
  return {
    size: toSize(cookieValue(cookieHeader, SIZE_COOKIE)) ?? DEFAULT_PREFS.size,
    theme: toTheme(cookieValue(cookieHeader, THEME_COOKIE)),
  };
}

/** The reading bar's Theme button walks this ring; undefined is the device setting. */
const THEME_RING = /** @type {const} */ ([undefined, 'light', 'dark', 'contrast']);

/**
 * One press of a reader control. `size` is "smaller" or "larger"; `theme` is a
 * theme, "system" for the device setting, or "next" for the reading bar's cycle.
 * Anything else changes nothing.
 *
 * @param {Prefs} prefs
 * @param {{ size?: string | undefined, theme?: string | undefined }} change
 * @returns {Prefs}
 */
export function applyChange(prefs, change) {
  let { size, theme } = prefs;
  if (change.size === 'larger') size = /** @type {Size} */ (Math.min(size + 1, 5));
  if (change.size === 'smaller') size = /** @type {Size} */ (Math.max(size - 1, 1));
  if (change.theme === 'system') theme = undefined;
  else if (change.theme === 'next') theme = THEME_RING[(THEME_RING.indexOf(theme) + 1) % THEME_RING.length];
  else theme = toTheme(change.theme) ?? theme;
  return { size, theme };
}

/**
 * The Set-Cookie values for `prefs`. A default is removed rather than stored,
 * so a reader who never changed anything sends no cookie at all. SameSite=Lax,
 * not Strict: a reader who follows a link from the emailed newsletter must
 * arrive at their own text size.
 *
 * @param {Prefs} prefs
 * @returns {string[]}
 */
export function prefsCookies(prefs) {
  const tail = '; Path=/; Max-Age=%s; SameSite=Lax; HttpOnly; Secure';
  /** @param {string} name @param {string | undefined} value */
  const cookie = (name, value) => `${name}=${value ?? ''}${tail.replace('%s', value === undefined ? '0' : String(YEAR))}`;
  return [
    cookie(SIZE_COOKIE, prefs.size === DEFAULT_PREFS.size ? undefined : String(prefs.size)),
    cookie(THEME_COOKIE, prefs.theme),
  ];
}

/**
 * The attributes of the <html> element for `prefs`.
 *
 * @param {Prefs} prefs
 * @returns {Record<string, string>}
 */
export function htmlAttributes(prefs) {
  /** @type {Record<string, string>} */
  const attrs = { lang: 'en', 'data-size': String(prefs.size) };
  if (prefs.theme) attrs['data-theme'] = prefs.theme;
  return attrs;
}

/**
 * A prerendered page with its <html> start tag rewritten for `prefs`. The tag
 * is the first one in Astro's output, so nothing in the body is touched.
 *
 * @param {string} html
 * @param {Prefs} prefs
 */
export function stampHtml(html, prefs) {
  const attrs = Object.entries(htmlAttributes(prefs))
    .map(([name, value]) => ` ${name}="${value}"`)
    .join('');
  return html.replace(/<html\b[^>]*>/i, `<html${attrs}>`);
}

/**
 * Where a reader control sends the reader afterwards: a path on this site, or
 * Home. Never another origin, never a header-splitting character.
 *
 * @param {string | null | undefined} back
 */
export function safeBack(back) {
  if (!back || back.length > 1024 || !/^\/(?![/\\])[^\s\\]*$/.test(back)) return '/';
  return back.replace(/#.*$/, '');
}
