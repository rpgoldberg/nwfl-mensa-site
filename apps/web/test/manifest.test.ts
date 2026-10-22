import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sectionFor } from '../src/lib/site';

interface Icon { src: string; sizes: string; type: string; purpose?: string }
interface Manifest {
  id: string; name: string; short_name: string; start_url: string; scope: string; display: string; lang: string;
  theme_color: string; background_color: string; icons: Icon[];
  shortcuts: { name: string; url: string; icons?: Icon[] }[];
}

const manifest = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8')) as Manifest;

/** Width, height and colour type from a PNG's IHDR chunk. */
function png(path: string): { width: number; height: number; alpha: boolean } {
  const bytes = readFileSync(path);
  expect(bytes.subarray(0, 8).toString('hex'), path).toBe('89504e470d0a1a0a');
  expect(bytes.subarray(12, 16).toString('ascii'), path).toBe('IHDR');
  const colourType = bytes[25] ?? -1;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), alpha: colourType === 4 || colourType === 6 };
}

describe('web manifest (R27)', () => {
  it('names the app and opens it standalone at Home', () => {
    expect(manifest).toMatchObject({
      id: '/',
      name: 'NW Florida Mensa',
      short_name: 'NWFL Mensa',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      lang: 'en',
    });
  });

  it('takes its colours from the design tokens', () => {
    const tokens = readFileSync('src/styles/tokens.css', 'utf8');
    expect(tokens).toContain(`--accent: ${manifest.theme_color};`);
    expect(tokens).toContain(`--bg: ${manifest.background_color};`);
  });

  it('has a 192 and a 512 icon, and a 512 maskable one, each a real PNG of that size', () => {
    const bySize = manifest.icons.map((i) => `${i.sizes} ${i.purpose ?? 'any'}`).sort();
    expect(bySize).toEqual(['192x192 any', '512x512 any', '512x512 maskable']);
    for (const icon of manifest.icons) {
      expect(icon.type).toBe('image/png');
      const [w, h] = icon.sizes.split('x').map(Number);
      expect(png(`public${icon.src}`), icon.src).toMatchObject({ width: w, height: h });
    }
  });

  it('has shortcuts to the current newsletter, the calendar and search, each to a real page with a 96 px icon', () => {
    expect(manifest.shortcuts.map((s) => [s.name, s.url])).toEqual([
      ['Current newsletter', '/newsletter'],
      ['Calendar', '/calendar'],
      ['Search', '/search'],
    ]);
    for (const shortcut of manifest.shortcuts) {
      expect(sectionFor(shortcut.url), shortcut.url).toBeDefined();
      const icon = shortcut.icons?.[0];
      expect(icon?.sizes, shortcut.name).toBe('96x96');
      expect(png(`public${icon!.src}`)).toMatchObject({ width: 96, height: 96 });
    }
  });

  it('gives iPhone an opaque 180 px home-screen icon and the browser a 32 px tab icon', () => {
    expect(png('public/icons/apple-touch-icon.png')).toEqual({ width: 180, height: 180, alpha: false });
    expect(png('public/icons/icon-32.png')).toMatchObject({ width: 32, height: 32 });
  });

  it('keeps the icon maker beside the icons, so they can be drawn again', () => {
    expect(existsSync('scripts/make-icons.mjs')).toBe(true);
  });
});
