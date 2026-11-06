// The gate's second reading of a copy, with stopAtErrors (gate.ts readerFinds): where only it finds a quote, plain or
// through a glyph with no text, the copy is refused (LIGATURE fix 1, F3: mutant X11). pdf.js reads less there, never
// more, so no real copy reaches it: pdf.js is stood in for, reading the quote only when told to stop at errors.
import { PDFDocument } from '@cantoo/pdf-lib';
import { describe, expect, it, vi } from 'vitest';

const reading = vi.hoisted(() => ({ text: '' }));

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => {
  const page = (text: string) => ({ getTextContent: () => Promise.resolve({ items: [{ str: text, transform: [1, 0, 0, 1, 72, 700], width: 100, height: 12, hasEOL: false }] }) });
  return {
    getDocument: ({ stopAtErrors }: { stopAtErrors?: boolean }) => ({
      promise: Promise.resolve({ numPages: 1, getPage: () => Promise.resolve(page(stopAtErrors === true ? reading.text : 'Corwin Vellacott led it.')) }),
      destroy: () => Promise.resolve(),
    }),
    PDFWorker: class {
      promise = Promise.resolve();
      port = { addEventListener: () => undefined };
      destroy = () => undefined;
    },
  };
});

const { checkCopy } = await import('../../src/pdf/gate.js');

describe('the gate\'s second reading, with stopAtErrors (X11)', () => {
  it('refuses a copy only it reads a quote in, plain or through U+FFFD', async () => {
    const pdf = await (await PDFDocument.create({ updateMetadata: false })).save();
    reading.text = 'Fifi Amberwick kept score.';
    expect(await checkCopy(pdf, ['Fifi Amberwick'])).toBe('page 1: withheld text can still be read by another reader');
    reading.text = 'Fi� Amberwick kept score.';
    expect(await checkCopy(pdf, ['Fifi Amberwick'])).toBe('page 1: text another reader cannot read may hold withheld text');
    reading.text = 'Corwin Vellacott led it.';
    expect(await checkCopy(pdf, ['Fifi Amberwick'])).toBeNull();
  });
});
