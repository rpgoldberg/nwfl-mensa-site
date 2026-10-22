import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The fonts are served from our own origin (no Google Fonts at runtime), so the
// SIL Open Font License travels with them, verbatim from each package.
const FONTS = [
  { pkg: '@fontsource/atkinson-hyperlegible', served: 'public/fonts/OFL-Atkinson-Hyperlegible.txt' },
  { pkg: '@fontsource/lexend', served: 'public/fonts/OFL-Lexend.txt' },
];

describe('font licences', () => {
  for (const { pkg, served } of FONTS) {
    it(`serves the ${pkg} licence verbatim, and it is the OFL`, () => {
      const upstream = readFileSync(`node_modules/${pkg}/LICENSE`, 'utf8');
      expect(upstream).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/i);
      expect(readFileSync(served, 'utf8')).toBe(upstream);
    });
  }
});
