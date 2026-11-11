// DARKPDF (Ross's decision (a)): the issue's pages follow the site's theme, as the reader set it in Aa or
// the device does (src/styles/tokens.css): light shows each page as printed; dark recolours the drawing,
// light text on a dark page; high contrast tints the paper to the theme's own. Pictures are never
// recoloured, so a photo never shows as a negative. pdf.js 6.4.299's pageColors cannot do that (its
// filter covers the whole canvas, pictures too), so each page is drawn as printed, pdf.js records where
// its pictures are (render's recordImages), and those boxes are copied out of the drawing into canvases
// of their own laid over it. site.css recolours the drawing alone, from the viewer's data-tone, which
// public/scripts/viewer.js keeps in step with the theme, live; a theme change redraws nothing.

/** A picture covering this share of the page or more (a scanned page) leaves the whole page as printed. */
export const PICTURE_SHARE = 0.85;

/**
 * How the pages are shown for a theme: the reader's choice (html data-theme), else the device's.
 * The order is the tokens': more contrast wins over dark.
 *
 * @param {string | null | undefined} theme
 * @param {boolean} prefersDark
 * @param {boolean} prefersMore
 * @returns {'light' | 'dark' | 'tint'}
 */
export function pageTone(theme, prefersDark, prefersMore) {
  if (theme === 'dark') return 'dark';
  if (theme === 'contrast-yellow' || theme === 'contrast-white') return 'tint';
  if (theme === 'light') return 'light';
  if (theme !== null && theme !== undefined && theme !== 'system') return 'light';
  if (prefersMore) return 'tint';
  return prefersDark ? 'dark' : 'light';
}

/** @typedef {{ x: number, y: number, w: number, h: number }} Box */

/**
 * pdf.js's picture corners (for each picture three points, top left, bottom left and top right, as
 * fractions of the canvas) as boxes of the whole pixels inside them, held to the canvas; any under two
 * pixels is left out.
 *
 * @param {ArrayLike<number> | undefined | null} coords
 * @param {number} width the canvas's pixels
 * @param {number} height
 * @returns {Box[]}
 */
export function photoBoxes(coords, width, height) {
  /** @type {Box[]} */
  const out = [];
  if (!coords) return out;
  for (let i = 0; i + 5 < coords.length; i += 6) {
    /** @param {number} k */
    const at = (k) => /** @type {number} */ (coords[i + k]);
    const [x0, y0, x1, y1, x2, y2] = [at(0), at(1), at(2), at(3), at(4), at(5)];
    const xs = [x0, x1, x2, x1 + x2 - x0].map((x) => Math.min(Math.max(x * width, 0), width));
    const ys = [y0, y1, y2, y1 + y2 - y0].map((y) => Math.min(Math.max(y * height, 0), height));
    // The whole pixels inside the picture: an edge pixel half paper would show as a pale line unrecoloured.
    const x = Math.max(0, Math.ceil(Math.min(...xs) - 1e-6));
    const y = Math.max(0, Math.ceil(Math.min(...ys) - 1e-6));
    const w = Math.floor(Math.max(...xs) + 1e-6) - x;
    const h = Math.floor(Math.max(...ys) + 1e-6) - y;
    if (w >= 2 && h >= 2) out.push({ x, y, w, h });
  }
  return out;
}

/** @param {number} part @param {number} whole */
const pct = (part, whole) => `${Math.round((part / whole) * 1e4) / 100}%`;

/**
 * The pictures of a drawn page, each copied out of the drawing into a canvas of its own placed over it
 * (in percent, so it follows the page's size); or, when one picture fills the page, none, and the
 * drawing itself is marked as a picture.
 *
 * @param {{ createElement(tag: string): any }} doc
 * @param {any} sheet the page's canvas, drawn
 * @param {Box[]} boxes
 */
export function addPhotos(doc, sheet, boxes) {
  const area = sheet.width * sheet.height;
  if (boxes.some((b) => b.w * b.h >= PICTURE_SHARE * area)) return { picture: true, photos: [] };
  const photos = boxes.map((b) => {
    const photo = doc.createElement('canvas');
    photo.className = 'viewer-photo';
    photo.setAttribute('aria-hidden', 'true');
    photo.width = b.w;
    photo.height = b.h;
    photo.style.left = pct(b.x, sheet.width);
    photo.style.top = pct(b.y, sheet.height);
    photo.style.width = pct(b.w, sheet.width);
    photo.style.height = pct(b.h, sheet.height);
    photo.getContext('2d').drawImage(sheet, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
    return photo;
  });
  return { picture: false, photos };
}
