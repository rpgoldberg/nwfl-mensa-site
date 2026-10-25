// REDACT R3b: what keys a redacted copy. Two audiences share a copy exactly
// when the engine would be given the same inputs for the same original.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ENGINE_VERSION, inputHash } from '../../src/pdf/store.js';

const version = (name: string): string => (JSON.parse(readFileSync(new URL(`../../node_modules/${name}/package.json`, import.meta.url), 'utf8')) as { version: string }).version;
const SHA = Buffer.alloc(32, 1);

describe('ENGINE_VERSION', () => {
  it('names each installed engine library at its version, so an upgrade remakes every copy', () => {
    expect(ENGINE_VERSION).toContain(`pdfium-${version('@embedpdf/pdfium')}`);
    expect(ENGINE_VERSION).toContain(`pdf-lib-${version('@cantoo/pdf-lib')}`);
    expect(ENGINE_VERSION).toContain(`pdfjs-${version('pdfjs-dist')}`);
  });
});

describe('inputHash', () => {
  it('is 32 bytes and ignores the order, repeats and spacing of the quotes', () => {
    const a = inputHash(SHA, { quotes: ['Bo', ' Quillon Brask '], redactsAny: true });
    expect(a).toHaveLength(32);
    expect(inputHash(SHA, { quotes: ['Quillon Brask', 'Bo', 'Bo', ''], redactsAny: true }).equals(a)).toBe(true);
  });

  it('changes with the original, the quotes, redactsAny, the image action and the engine', () => {
    const base = inputHash(SHA, { quotes: ['Bo'], redactsAny: true });
    expect(inputHash(Buffer.alloc(32, 2), { quotes: ['Bo'], redactsAny: true }).equals(base)).toBe(false);
    expect(inputHash(SHA, { quotes: ['Bob'], redactsAny: true }).equals(base)).toBe(false);
    expect(inputHash(SHA, { quotes: ['Bo'], redactsAny: false }).equals(base)).toBe(false);
    expect(inputHash(SHA, { quotes: ['Bo'], redactsAny: true }, 'another-engine').equals(base)).toBe(false);
    expect(inputHash(SHA, { quotes: ['Bo'], redactsAny: true, image: 'show' }).equals(base)).toBe(true);
    expect(inputHash(SHA, { quotes: ['Bo'], redactsAny: true, image: 'blur' }).equals(base)).toBe(false);
    expect(inputHash(SHA, { quotes: ['Bo'], redactsAny: true, image: 'hide' }).equals(inputHash(SHA, { quotes: ['Bo'], redactsAny: true, image: 'blur' }))).toBe(false);
  });
});
