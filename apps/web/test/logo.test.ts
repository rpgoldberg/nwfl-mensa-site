// LOGO-UNIT: the Mensa logo in the footer. The maker (scripts/make-logo.mjs), tried on a drawn
// stand-in, then the files the site ships, held to the branding sheet: never stretched, clear
// space of half the mark's width on every side, the registered symbol kept, a solid tile.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOGO, clearSpace, inkColumns, main, makeLogo, placed, whiteOnClear } from '../scripts/make-logo.mjs';

/** A stand-in the size of the approved file: a 112 px mark, three letters and a small symbol at the top right, black on white. */
async function standIn(path: string, width = 600, height = 117): Promise<void> {
  const bar = (w: number, h: number) => ({ create: { width: w, height: h, channels: 3 as const, background: '#000000' } });
  await sharp({ create: { width, height, channels: 3, background: '#ffffff' } })
    .composite([
      { input: bar(112, 116), left: 0, top: 0 },
      { input: bar(120, 90), left: 141, top: 26 },
      { input: bar(200, 90), left: 290, top: 26 },
      { input: bar(60, 90), left: 514, top: 26 },
      { input: bar(8, 8), left: 592, top: 4 },
    ])
    .png()
    .toFile(path);
}

async function pixels(path: string) {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** The box around every pixel that is not clear. */
function inkBox(p: { data: Buffer; width: number; height: number }) {
  let [left, top, right, bottom] = [p.width, p.height, -1, -1];
  for (let y = 0; y < p.height; y++) {
    for (let x = 0; x < p.width; x++) {
      if (p.data[(y * p.width + x) * 4 + 3]! < 32) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  return { left, top, right, bottom };
}

describe('the logo maker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'logo-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('finds the mark: the first run of inked columns', () => {
    //                     x: 0    1  2  3    4    5  6
    const grey = Uint8Array.from([255, 0, 0, 255, 255, 0, 255, 255, 90, 0, 255, 255, 255, 255]);
    expect(inkColumns(grey, 7, 2)).toEqual([[1, 2], [5, 5]]);
    expect(inkColumns(Uint8Array.from([0, 0, 255, 0]), 4, 1)).toEqual([[0, 1], [3, 3]]);
    expect(inkColumns(Uint8Array.from([255, 255]), 2, 1)).toEqual([]);
  });

  it('keeps half the mark’s width clear on every side, rounded up to a whole pixel at every scale', () => {
    expect(clearSpace(112)).toBe(57);
    expect(clearSpace(111)).toBe(57);
    expect(clearSpace(120)).toBe(60);
    expect(placed(600, 117, 112)).toEqual({ pad: 57, width: 714, height: 231 });
    // A height that would not divide by three gets the spare pixels as more clear space, never less.
    expect(placed(600, 118, 112)).toEqual({ pad: 57, width: 714, height: 234 });
  });

  it('turns black on white into white on clear, as dark as the ink was', () => {
    const out = whiteOnClear(Uint8Array.from([0, 255, 64]));
    expect([...out]).toEqual([255, 255, 255, 255, 255, 255, 255, 0, 255, 255, 255, 191]);
  });

  it('draws the three sizes from one file, in proportion', async () => {
    const source = join(dir, 'source.png');
    await standIn(source);
    const made = await makeLogo(source, dir);
    expect(made).toEqual(LOGO.files.map((f) => ({ file: join(dir, f.file), width: LOGO.width * f.scale, height: LOGO.height * f.scale })));
    for (const f of made) {
      const meta = await sharp(f.file).metadata();
      expect([meta.width, meta.height, meta.hasAlpha], f.file).toEqual([f.width, f.height, true]);
    }
  });

  it('as a command, names each file it wrote, and asks for the approved file when given none', async () => {
    const source = join(dir, 'command.png');
    await standIn(source);
    const said: string[] = [];
    await main([source], dir, (line) => said.push(line));
    expect(said).toEqual([`${join(dir, 'mensa-logo.png')} 238x77`, `${join(dir, 'mensa-logo-2x.png')} 476x154`, `${join(dir, 'mensa-logo-3x.png')} 714x231`]);
    await expect(main([], dir)).rejects.toThrow('usage: node scripts/make-logo.mjs');
  });

  it('says so when the file has no mark to measure', async () => {
    const blank = join(dir, 'blank.png');
    await sharp({ create: { width: 60, height: 12, channels: 3, background: '#ffffff' } }).png().toFile(blank);
    await expect(makeLogo(blank, dir)).rejects.toThrow('no mark found');
  });
});

describe('the logo the site ships (public/icons)', () => {
  const shipped = LOGO.files.map((f) => ({ ...f, path: `public/icons/${f.file}` }));
  let full: Awaited<ReturnType<typeof pixels>>;
  beforeAll(async () => {
    full = await pixels(shipped.at(-1)!.path);
  });

  it('is 238 by 77, with a 2x and a 3x file in the same proportion', async () => {
    expect([LOGO.width, LOGO.height]).toEqual([238, 77]);
    expect(shipped.map((f) => [f.file, f.scale])).toEqual([['mensa-logo.png', 1], ['mensa-logo-2x.png', 2], ['mensa-logo-3x.png', 3]]);
    for (const f of shipped) {
      const meta = await sharp(f.path).metadata();
      expect([meta.width, meta.height, meta.hasAlpha], f.file).toEqual([238 * f.scale, 77 * f.scale, true]);
    }
  });

  it('is a white mark on clear, nothing else: the tile behind it is the page’s to colour', () => {
    for (let i = 0; i < full.data.length; i += 4) {
      if (full.data[i + 3] === 0) continue;
      expect([full.data[i], full.data[i + 1], full.data[i + 2]]).toEqual([255, 255, 255]);
    }
    expect(full.data[3]).toBe(0);
  });

  it('is never stretched: the drawing keeps the approved file’s 600 by 117', () => {
    const box = inkBox(full);
    const [w, h] = [box.right - box.left + 1, box.bottom - box.top + 1];
    expect(w).toBeGreaterThanOrEqual(598);
    expect(w).toBeLessThanOrEqual(600);
    expect(h).toBeGreaterThanOrEqual(114);
    expect(h).toBeLessThanOrEqual(117);
  });

  it('has clear space of half the mark’s width on every side, at every size', async () => {
    for (const f of shipped) {
      const p = await pixels(f.path);
      const box = inkBox(p);
      // The mark: the first run of columns with ink in them.
      let markEnd = box.left;
      const inked = (x: number) => Array.from({ length: p.height }, (_, y) => p.data[(y * p.width + x) * 4 + 3]!).some((a) => a >= 32);
      while (inked(markEnd + 1)) markEnd++;
      const half = (markEnd - box.left + 1) / 2;
      expect(half, f.file).toBeGreaterThan(50 * f.scale / 3);
      // Half a pixel's grace at the small sizes, where an edge lands between pixels.
      const least = half - 1;
      expect(box.left, `${f.file} left`).toBeGreaterThanOrEqual(least);
      expect(box.top, `${f.file} top`).toBeGreaterThanOrEqual(least);
      expect(p.width - 1 - box.right, `${f.file} right`).toBeGreaterThanOrEqual(least);
      expect(p.height - 1 - box.bottom, `${f.file} bottom`).toBeGreaterThanOrEqual(least);
    }
  });

  it('keeps the registered symbol: ink at the top right, apart from the last letter', () => {
    const box = inkBox(full);
    const alpha = (x: number, y: number) => full.data[(y * full.width + x) * 4 + 3]!;
    // The last 12 columns of the drawing: the symbol in the upper third, then a clear band, then the letter's foot.
    const rows = Array.from({ length: box.bottom - box.top + 1 }, (_, i) => {
      const y = box.top + i;
      return Array.from({ length: 12 }, (_, j) => alpha(box.right - j, y)).some((a) => a >= 128);
    });
    const first = rows.indexOf(true);
    const gap = rows.indexOf(false, first);
    expect(first).toBeGreaterThan(10);
    expect(first).toBeLessThan(40);
    expect(gap - first).toBeGreaterThanOrEqual(5);
    expect(gap - first).toBeLessThan(20);
    expect(rows.indexOf(true, gap) - gap).toBeGreaterThan(20);
  });

  it('is small: under 32 kB for the three files together', () => {
    expect(shipped.reduce((sum, f) => sum + readFileSync(f.path).length, 0)).toBeLessThan(32_000);
  });
});

describe('the footer’s logo in the stylesheet', () => {
  const css = readFileSync('src/styles/site.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = /\.foot-logo\s*\{([^{}]*)\}/.exec(css)?.[1] ?? '';

  it('sits on a solid tile, upright, in proportion, and never wider than the page', () => {
    expect(rule).toMatch(/background:\s*var\(--logo-tile\);/);
    expect(rule).toMatch(/max-width:\s*100%;/);
    expect(rule).toMatch(/height:\s*auto;/);
    expect(css).not.toMatch(/\.foot-logo[^{]*\{[^}]*(transform|rotate|skew|object-fit|filter|opacity|gradient|background-image)/);
  });

  it('keeps its tile where the system or the printer drops backgrounds, so the white mark still shows', () => {
    expect(rule).toMatch(/forced-color-adjust:\s*none;/);
    expect(rule).toMatch(/print-color-adjust:\s*exact;/);
  });

  it('is used once, never as a pattern: no stylesheet draws it', () => {
    for (const sheet of ['src/styles/site.css', 'src/styles/tokens.css']) expect(readFileSync(sheet, 'utf8')).not.toContain('mensa-logo');
  });
});
