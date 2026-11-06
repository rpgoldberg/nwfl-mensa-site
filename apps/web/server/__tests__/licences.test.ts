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

// PDFVIEW: the issue reader ships pdf.js (Apache-2.0) from our own origin: its licence travels with it,
// verbatim from the package, and the build's own licence header stays in the file.
describe('the pdf.js licence', () => {
  it('serves the pdfjs-dist licence verbatim, and it is Apache 2.0', () => {
    const upstream = readFileSync('node_modules/pdfjs-dist/LICENSE', 'utf8');
    expect(upstream).toMatch(/Apache License\s+Version 2\.0, January 2004/);
    expect(readFileSync('public/licences/pdfjs-LICENSE.txt', 'utf8')).toBe(upstream);
  });

  it('keeps the licence header in the library the reader loads', () => {
    for (const file of ['legacy/build/pdf.min.mjs', 'legacy/build/pdf.worker.min.mjs']) {
      expect(readFileSync(`node_modules/pdfjs-dist/${file}`, 'utf8').slice(0, 800), file).toMatch(/@licstart[\s\S]*Apache License, Version 2\.0[\s\S]*@licend/);
    }
  });
});
