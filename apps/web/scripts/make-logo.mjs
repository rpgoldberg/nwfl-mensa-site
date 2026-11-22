// make-logo.mjs: draws the footer's Mensa logo (LOGO-UNIT) from the approved Primary Logo file,
// black on white, 600 by 117. The branding sheet's rules it keeps: the proportions unchanged, the
// registered symbol kept, and clear space of half the mark's width on every side, here as part of
// the picture so no layout can take it away. The output is a white mark on clear at 1x, 2x and
// 3x (3x is the approved file's own pixels); the page colours the solid tile behind it
// (--logo-tile in tokens.css). The approved file is not in this repository. Run:
//
//   node scripts/make-logo.mjs <the approved Primary Logo PNG>
//
// and commit the PNGs it writes to public/icons/.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

/** The logo as the page shows it, in CSS px, and its files (scale: device pixels per CSS px). */
export const LOGO = {
  width: 238,
  height: 77,
  files: [
    { file: 'mensa-logo.png', scale: 1 },
    { file: 'mensa-logo-2x.png', scale: 2 },
    { file: 'mensa-logo-3x.png', scale: 3 },
  ],
};

/** The largest scale: the picture is laid out in these pixels, so every size is a whole number. */
const FULL = 3;
/** Darker than this (0 black, 255 white) is ink. */
const INK = 128;
const upToFull = (/** @type {number} */ n) => Math.ceil(n / FULL) * FULL;

/**
 * The runs of columns that have ink in them, left to right: the first is the mark.
 *
 * @param {Uint8Array} grey one byte a pixel, row by row
 * @param {number} width
 * @param {number} height
 * @returns {[number, number][]} first and last column of each run
 */
export function inkColumns(grey, width, height) {
  /** @type {[number, number][]} */
  const runs = [];
  let start = -1;
  for (let x = 0; x <= width; x++) {
    let ink = false;
    for (let y = 0; x < width && y < height && !ink; y++) ink = /** @type {number} */ (grey[y * width + x]) < INK;
    if (ink && start < 0) start = x;
    if (!ink && start >= 0) {
      runs.push([start, x - 1]);
      start = -1;
    }
  }
  return runs;
}

/**
 * The clear space on every side: half the mark's width, rounded up so it is whole pixels at 1x too.
 *
 * @param {number} markWidth
 */
export function clearSpace(markWidth) {
  return upToFull(Math.ceil(markWidth / 2));
}

/**
 * The picture with its clear space around it. Spare pixels become more clear space, never less.
 *
 * @param {number} width the approved file's
 * @param {number} height
 * @param {number} markWidth
 */
export function placed(width, height, markWidth) {
  const pad = clearSpace(markWidth);
  return { pad, width: upToFull(width + 2 * pad), height: upToFull(height + 2 * pad) };
}

/**
 * Black on white to white on clear: each pixel white, as solid as the ink was dark.
 *
 * @param {Uint8Array} grey
 * @returns {Buffer} RGBA
 */
export function whiteOnClear(grey) {
  const out = Buffer.alloc(grey.length * 4, 255);
  for (let i = 0; i < grey.length; i++) out[i * 4 + 3] = 255 - /** @type {number} */ (grey[i]);
  return out;
}

/**
 * @param {string} source the approved Primary Logo, black on white
 * @param {string} outDir
 * @returns {Promise<{ file: string, width: number, height: number }[]>}
 */
export async function makeLogo(source, outDir) {
  const { data, info } = await sharp(source).flatten({ background: '#ffffff' }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const mark = inkColumns(data, info.width, info.height)[0];
  if (!mark) throw new Error(`no mark found in ${source}`);
  const box = placed(info.width, info.height, mark[1] - mark[0] + 1);
  const top = Math.floor((box.height - info.height) / 2);
  const left = Math.floor((box.width - info.width) / 2);
  // White all round, by hand: one byte a pixel throughout.
  const full = Buffer.alloc(box.width * box.height, 255);
  for (let y = 0; y < info.height; y++) data.copy(full, (y + top) * box.width + left, y * info.width, (y + 1) * info.width);
  const made = [];
  for (const { file, scale } of LOGO.files) {
    const [width, height] = [(box.width / FULL) * scale, (box.height / FULL) * scale];
    // Both sides at once, by the same factor: never stretched.
    const sized = await sharp(full, { raw: { width: box.width, height: box.height, channels: 1 } }).resize(width, height, { fit: 'fill', kernel: 'lanczos3' }).extractChannel(0).raw().toBuffer();
    const path = join(outDir, file);
    await sharp(whiteOnClear(sized), { raw: { width, height, channels: 4 } }).png({ compressionLevel: 9, palette: true, colours: 256, quality: 100, dither: 0 }).toFile(path);
    made.push({ file: path, width, height });
  }
  return made;
}

/**
 * The command: draws the files into public/icons and names each.
 *
 * @param {string[]} args the approved file's path
 * @param {string} [outDir]
 * @param {(line: string) => void} [say]
 */
export async function main(args, outDir = 'public/icons', say = console.log) {
  const source = args[0];
  if (!source) throw new Error('usage: node scripts/make-logo.mjs <the approved Primary Logo PNG>');
  for (const f of await makeLogo(source, outDir)) say(`${f.file} ${f.width}x${f.height}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
