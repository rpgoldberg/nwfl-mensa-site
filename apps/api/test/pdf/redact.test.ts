// REDACT R3a: the PDF redaction engine, end to end on fixture PDFs. Each
// audience's copy is read back by pdf.js (not PDFium, which redacts) and
// searched byte for byte; no redacted canary may be found anywhere in it.
import { describe, expect, it } from 'vitest';
import { type RedactResult, redactPdf, verifyRedacted } from '../../src/pdf/redact.js';
import { extractAll, leaked, rawText } from './extract.js';
import { CANARIES, type CanaryName, ON_PAGE, leakFixture, linesPdf, pictureUnderTextFixture, scannedFixture, twoMarksFixture, unmappedFixture, untaggedPropertiesFixture } from './fixtures.js';

const ALL = Object.keys(CANARIES) as CanaryName[];
const quotes = (names: readonly CanaryName[]): string[] => names.map((name) => CANARIES[name].quote);

function copyOf(result: RedactResult): Uint8Array {
  if (result.kind !== 'redacted') throw new Error(`expected a redacted copy, got ${JSON.stringify(result)}`);
  return result.pdf;
}

async function readBack(bytes: Uint8Array): Promise<{ extracted: string; raw: string }> {
  return { extracted: await extractAll(bytes), raw: rawText(bytes) };
}

const leakedCanaries = (seen: { extracted: string; raw: string }, names: readonly CanaryName[]): CanaryName[] =>
  names.filter((name) => CANARIES[name].needles.some((needle) => leaked(needle, seen.extracted, seen.raw)));

describe('the leak fixture itself', () => {
  it('carries every canary where a reader or a tool finds it', async () => {
    const seen = await readBack(await leakFixture());
    expect(leakedCanaries(seen, ALL)).toEqual(ALL);
  });
});

describe('redactPdf: the public copy (every canary marked)', () => {
  it('leaves no canary in the text, the annotations, fields, metadata, outline, attachments, JavaScript or raw streams', async () => {
    const result = await redactPdf(await leakFixture(), { quotes: quotes(ALL), redactsAny: true });
    const seen = await readBack(copyOf(result));
    expect(leakedCanaries(seen, ALL)).toEqual([]);
  });

  it('keeps the rest of the page selectable and labels each box', async () => {
    const seen = await readBack(copyOf(await redactPdf(await leakFixture(), { quotes: quotes(ALL), redactsAny: true })));
    expect(seen.extracted).toContain('This closing line stays readable.');
    expect(seen.extracted).toContain('Please call');
    expect(seen.extracted).toContain('withheld');
  });

  it('gives the same bytes every time for the same original and marks', async () => {
    const original = await leakFixture();
    const request = { quotes: quotes(ALL), redactsAny: true };
    const first = copyOf(await redactPdf(original, request));
    const second = copyOf(await redactPdf(original, request));
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
  });

  it('passes its own check, which reads the copy again', async () => {
    const copy = copyOf(await redactPdf(await leakFixture(), { quotes: quotes(ALL), redactsAny: true }));
    expect(await verifyRedacted(copy, quotes(ON_PAGE))).toBeNull();
  });
});

describe('redactPdf: an audience with other settings gets its own copy', () => {
  it('removes only what that audience redacts from the page, and still strips every hidden place', async () => {
    const result = await redactPdf(await leakFixture(), { quotes: quotes(['kerning']), redactsAny: true });
    const seen = await readBack(copyOf(result));
    const hiddenPlaces: CanaryName[] = ['metadata', 'annotation', 'outline', 'attachment', 'javascript', 'actualText'];
    expect(leakedCanaries(seen, ALL)).toEqual(ALL.filter((name) => name !== 'kerning' && !hiddenPlaces.includes(name)));
  });

  it('strips the hidden places from an audience that redacts a category with nothing marked here', async () => {
    const seen = await readBack(copyOf(await redactPdf(await leakFixture(), { quotes: [], redactsAny: true })));
    expect(leakedCanaries(seen, ['metadata', 'annotation', 'outline', 'attachment', 'javascript', 'actualText'])).toEqual([]);
    expect(leakedCanaries(seen, ['body'])).toEqual(['body']);
  });
});

describe('redactPdf: an audience that redacts nothing', () => {
  it('is given the original, where every canary stays', async () => {
    const original = await leakFixture();
    expect(await redactPdf(original, { quotes: [], redactsAny: false })).toEqual({ kind: 'original' });
  });

  it('is given a redacted copy as soon as it has a quote, whatever redactsAny says', async () => {
    const result = await redactPdf(await leakFixture(), { quotes: quotes(['body']), redactsAny: false });
    expect(result.kind).toBe('redacted');
  });
});

describe('redactPdf: the length hint', () => {
  it('gives two passages of different lengths in one width step boxes of the same width, drawn on the page', async () => {
    const result = await redactPdf(await twoMarksFixture(), { quotes: ['Bo', 'Quillon'], redactsAny: true });
    if (result.kind !== 'redacted') throw new Error(JSON.stringify(result));
    const widths = result.boxes.map((box) => Number((box.right - box.left).toFixed(3)));
    expect(widths).toHaveLength(2);
    expect(widths[0]).toBe(48);
    expect(widths[1]).toBe(48);
    // The boxes are really drawn: PDFium writes each as a rectangle path of that width.
    const drawn = [...rawText(result.pdf).matchAll(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) re\b/g)].map((m) => Number(Number(m[3]).toFixed(3)));
    expect(drawn.filter((w) => w === 48)).toHaveLength(2);
    const seen = await readBack(result.pdf);
    expect(leaked('Quillon', seen.extracted, seen.raw)).toBe(false);
    expect(seen.extracted.match(/withheld/g)).toHaveLength(2);
  });
});

describe('redactPdf: fail closed', () => {
  it('gives no copy when a page is drawn but has no text layer, naming the page', async () => {
    expect(await redactPdf(await scannedFixture(), { quotes: quotes(['body']), redactsAny: true })).toEqual({
      kind: 'refused',
      reason: 'page 2 has no text layer',
    });
  });

  it('gives no copy for a scanned page even when nothing is marked, if the audience redacts any category', async () => {
    expect(await redactPdf(await scannedFixture(), { quotes: [], redactsAny: true })).toEqual({ kind: 'refused', reason: 'page 2 has no text layer' });
  });

  it('gives the original of a scanned PDF to an audience that redacts nothing', async () => {
    expect(await redactPdf(await scannedFixture(), { quotes: [], redactsAny: false })).toEqual({ kind: 'original' });
  });

  it('gives no copy when a withheld passage lies over a picture, whose pixels a box would only cover', async () => {
    expect(await redactPdf(await pictureUnderTextFixture(), { quotes: quotes(['body']), redactsAny: true })).toEqual({
      kind: 'refused',
      reason: 'page 1: a withheld passage lies over a picture',
    });
  });

  it('gives a copy when the picture is elsewhere on the page', async () => {
    const result = await redactPdf(await pictureUnderTextFixture(), { quotes: quotes(['kerning']), redactsAny: true });
    expect(result.kind).toBe('redacted');
  });

  it('gives no copy when a page has text with no Unicode value, which cannot be checked', async () => {
    expect(await redactPdf(await unmappedFixture(), { quotes: ['Quillon'], redactsAny: true })).toEqual({
      kind: 'refused',
      reason: 'page 1 has text that cannot be read',
    });
  });

  it('gives no copy when a content stream has marked content it cannot read', async () => {
    expect(await redactPdf(await untaggedPropertiesFixture(), { quotes: [], redactsAny: true })).toEqual({
      kind: 'refused',
      reason: 'the content stream has marked content that cannot be read',
    });
  });

  it('gives no copy of a file that is not a PDF', async () => {
    expect(await redactPdf(Buffer.from('not a pdf'), { quotes: ['x y z'], redactsAny: true })).toEqual({
      kind: 'refused',
      reason: 'the PDF could not be opened',
    });
  });

  it('reports text still readable after removal (the check every copy passes before it is given)', async () => {
    expect(await verifyRedacted(await leakFixture(), quotes(['kerning']))).toBe('page 1: withheld text is still readable after removal');
  });

  it('reports a file the check cannot open', async () => {
    expect(await verifyRedacted(Buffer.from('nope'), ['x'])).toBe('the PDF could not be opened');
  });
});

describe('redactPdf: a mark is a whole word, letter-spaced or not (HARDEN-1)', () => {
  it('leaves "befo" inside "before" alone, plain or letter-spaced, and removes "B e f o" standing alone', async () => {
    const original = await linesPdf(['Come before noon.', 'Come b e f o r e noon.', 'Ask B e f o today.']);
    const seen = await readBack(copyOf(await redactPdf(original, { quotes: ['befo'], redactsAny: true })));
    expect(seen.extracted).toContain('Come before noon.');
    expect(seen.extracted).toContain('Come b e f o r e noon.');
    expect(seen.extracted).not.toMatch(/B\s*e\s*f\s*o/);
    expect(seen.extracted).toContain('Ask');
  });
});
