// make-icons.mjs: draws the app icons (R27) from text, with no logo: the
// group's initials, "NWFL", in white Lexend on the teal, over a short sand bar
// from the header stripe. White on #00566b is 8.26:1. Shortcut icons carry the
// bottom bar's line drawings. Run it in the Playwright image, which has
// Chromium, and commit the PNGs it writes to public/icons/:
//
//   docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD":/work -w /work \
//     mcr.microsoft.com/playwright:v1.64.1-noble node scripts/make-icons.mjs
//
// Lexend is under the SIL Open Font License; pictures drawn with it are not.
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import sharp from 'sharp';

const TEAL = '#00566b';
const SAND = '#e9dcc0';
const lexend = readFileSync('node_modules/@fontsource/lexend/files/lexend-latin-600-normal.woff2').toString('base64');

/**
 * @typedef {{ file: string, size: number, text: number, round: boolean, opaque: boolean, glyph?: string }} Icon
 * text: the initials' width as a share of the icon; round: rounded corners
 * with a clear outside; opaque: no alpha channel at all.
 */
/** @type {Icon[]} */
const ICONS = [
  { file: 'icon-512.png', size: 512, text: 0.78, round: true, opaque: false },
  { file: 'icon-192.png', size: 192, text: 0.78, round: true, opaque: false },
  // Maskable: launchers crop to any shape within the central 80 % circle.
  { file: 'icon-maskable-512.png', size: 512, text: 0.6, round: false, opaque: true },
  // iPhone rounds the corners itself and wants no transparency.
  { file: 'apple-touch-icon.png', size: 180, text: 0.72, round: false, opaque: true },
  { file: 'icon-32.png', size: 32, text: 0.9, round: true, opaque: false },
  { file: 'shortcut-newsletter-96.png', size: 96, text: 0, round: true, opaque: false, glyph: '<path d="M5 3h11l3 3v15H5z"/><path d="M8 9h8M8 13h8M8 17h5"/>' },
  { file: 'shortcut-calendar-96.png', size: 96, text: 0, round: true, opaque: false, glyph: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>' },
  { file: 'shortcut-search-96.png', size: 96, text: 0, round: true, opaque: false, glyph: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 5 5"/>' },
];

/** @param {Icon} icon */
function page(icon) {
  const body = icon.glyph
    ? `<svg viewBox="0 0 24 24" width="60%" height="60%" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon.glyph}</svg>`
    : `<div class="mark"><span id="t">NWFL</span><i></i></div>`;
  return `<!doctype html><html><head><style>
    @font-face { font-family: Lexend; font-weight: 600; src: url(data:font/woff2;base64,${lexend}) format('woff2'); }
    html, body { margin: 0; background: transparent; }
    .tile { width: ${icon.size}px; height: ${icon.size}px; background: ${TEAL}; border-radius: ${icon.round ? '18%' : '0'};
      display: grid; place-items: center; }
    .mark { display: grid; justify-items: center; gap: ${icon.size * 0.04}px; }
    #t { font: 600 100px/1 Lexend; color: #fff; letter-spacing: 0.01em; white-space: nowrap; }
    .mark i { display: block; height: ${Math.max(2, icon.size * 0.05)}px; width: 70%; background: ${SAND}; border-radius: 999px; }
  </style></head><body><div class="tile">${body}</div></body></html>`;
}

const browser = await chromium.launch();
for (const icon of ICONS) {
  const tab = await browser.newPage({ viewport: { width: icon.size, height: icon.size }, deviceScaleFactor: 1 });
  await tab.setContent(page(icon));
  await tab.evaluate(async (share) => {
    await document.fonts.ready;
    const t = document.getElementById('t');
    if (t) t.style.fontSize = `${(100 * share * window.innerWidth) / t.getBoundingClientRect().width}px`;
  }, icon.text);
  const shot = await tab.locator('.tile').screenshot({ omitBackground: true });
  const image = sharp(shot);
  await (icon.opaque ? image.flatten({ background: TEAL }) : image).png({ compressionLevel: 9 }).toFile(`public/icons/${icon.file}`);
  await tab.close();
}
await browser.close();
