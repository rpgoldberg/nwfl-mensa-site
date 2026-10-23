// @ts-check
// The reader's text size and theme (R30): two cookies the server reads to
// render <html data-size data-theme>, so pages arrive in the reader's settings
// with no script. Seven sizes, 75 to 175 %, and four themes besides the device's. Shared by the Astro layout, the /prefs form handler and the
// server wrapper, which stamps them on prerendered pages.
//
// Host-only by the __Host- prefix (Secure, Path=/, no Domain): the staging host
// sits under a parent domain shared with other apps, and a browser refuses a
// __Host- cookie from anywhere but this exact host. A same-named cookie without
// the prefix, which a sibling could set on the parent domain, is never read.
import { readCookie } from './cookies.mjs';

export const SIZE_COOKIE = '__Host-nwfl-size';
export const THEME_COOKIE = '__Host-nwfl-theme';

/** @typedef {(typeof SIZES)[number]} Size */
/** @typedef {'light' | 'dark' | 'contrast-yellow' | 'contrast-white'} Theme */
/** @typedef {{ size: Size, theme: Theme | undefined }} Prefs */

/**
 * The seven text sizes in percent, the slider's notches 0 to 6 (Ross, 2026-10-23).
 * The one list: the code and the tests read it, and test/size-css.test.ts
 * checks the stylesheets' size rules against it.
 */
export const SIZES = /** @type {const} */ ([75, 80, 90, 100, 115, 140, 175]);
/** In menu order; undefined, the device setting, comes first. */
export const THEMES = /** @type {const} */ (['light', 'dark', 'contrast-yellow', 'contrast-white']);

/** No cookie: 100 % and whatever the device asks for. */
export const DEFAULT_PREFS = Object.freeze(/** @type {Prefs} */ ({ size: 100, theme: undefined }));

/** The cookies of the five-step scale (100, 125, 150, 175, 200 %): the default, the next two notches, then the largest. */
const OLD_SIZES = /** @type {Record<string, Size>} */ ({ 1: SIZES[3], 2: SIZES[4], 3: SIZES[5], 4: SIZES[6], 5: SIZES[6] });
/** Yellow on black is gone; warm white is the high contrast theme a device asks for. */
const OLD_THEMES = /** @type {Record<string, Theme>} */ ({ contrast: 'contrast-white' });

const YEAR = 60 * 60 * 24 * 365;

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
  const size = readCookie(cookieHeader, SIZE_COOKIE);
  const theme = readCookie(cookieHeader, THEME_COOKIE);
  return {
    size: toSize(size) ?? (size !== undefined && Object.hasOwn(OLD_SIZES, size) ? OLD_SIZES[size] : undefined) ?? DEFAULT_PREFS.size,
    theme: toTheme(theme) ?? (theme !== undefined && Object.hasOwn(OLD_THEMES, theme) ? OLD_THEMES[theme] : undefined),
  };
}

/** The reading bar's Theme button walks this ring; undefined is the device setting. */
const THEME_RING = /** @type {const} */ ([undefined, ...THEMES]);

/**
 * One press of a reader control. `size` is "smaller" or "larger", or "set" for
 * the slider's Use this size, which takes the notch in `step` (0 to 6); `theme`
 * is a theme, "system" for the device setting, or "next" for the reading bar's
 * cycle. Anything else changes nothing.
 *
 * @param {Prefs} prefs
 * @param {{ size?: string | undefined, step?: string | undefined, theme?: string | undefined }} change
 * @returns {Prefs}
 */
export function applyChange(prefs, change) {
  let { size, theme } = prefs;
  const at = SIZES.indexOf(size);
  if (change.size === 'larger') size = SIZES[Math.min(at + 1, SIZES.length - 1)] ?? size;
  if (change.size === 'smaller') size = SIZES[Math.max(at - 1, 0)] ?? size;
  if (change.size === 'set' && /^[0-6]$/.test(change.step ?? '')) size = SIZES[Number(change.step)] ?? size;
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
 * The text size slider in the Aa panel at `size`: rendered by the layout, and
 * put on a prerendered page by stampHtml, as only its value differs by reader
 * (everything else in the panel follows <html data-size> in CSS).
 *
 * @param {Size} size
 */
export function sizeSlider(size) {
  return (
    `<input id="text-size" class="sl-input" type="range" name="step" min="0" max="${SIZES.length - 1}" step="1"` +
    ` value="${SIZES.indexOf(size)}" aria-valuetext="${size} percent" data-sizes="${SIZES.join(' ')}">`
  );
}

const SLIDER = /<input id="text-size" [^>]*>/;

/**
 * A prerendered page with its <html> start tag and its size slider rewritten
 * for `prefs`. The tag is the first one in Astro's output, and the slider is
 * found by its id, so nothing else in the body is touched.
 *
 * @param {string} html
 * @param {Prefs} prefs
 */
export function stampHtml(html, prefs) {
  const attrs = Object.entries(htmlAttributes(prefs))
    .map(([name, value]) => ` ${name}="${value}"`)
    .join('');
  return html.replace(/<html\b[^>]*>/i, `<html${attrs}>`).replace(SLIDER, () => sizeSlider(prefs.size));
}

/**
 * Where a reader control sends the reader afterwards: a path on this site, in
 * printable ASCII, or Home. Never another origin, never a header-splitting character.
 *
 * @param {string | null | undefined} back
 */
export function safeBack(back) {
  // Printable ASCII bar space and backslash: a page's own path and query are
  // percent-encoded, and anything else is not a legal Location value (a
  // control character or non-ASCII made the redirect throw).
  if (!back || back.length > 1024 || !/^\/(?![/\\])[!-[\]-~]*$/.test(back)) return '/';
  return back.replace(/#.*$/, '');
}
