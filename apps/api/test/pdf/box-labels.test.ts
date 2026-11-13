// BOXLABEL (the editor, 11-05): each box in a copy says who may read what it covers. In the public copy, a
// passage members can see is labelled "Members Only", else "Mbrs Only", else nothing; one members
// cannot see either (public or members copy) "Private", else nothing. The gate takes exactly these three
// strings, drawn inside a box in the label style, and nothing else; its leak checks do not count them.
// Every name is made up. These PDFs are adversarial in shape: run this file only in the capped container.
import { readFileSync } from 'node:fs';
import { PDFArray, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/pdf/engine-protocol.js';
import { labelMarks } from '../../src/pdf/gate-labels.js';
import { gateReply, gateVerdict } from '../../src/pdf/gate-rules.js';
import { LABEL_EMS } from '../../src/pdf/labels.js';
import type { Box, PageChar, Region } from '../../src/pdf/match.js';
import { Document, pdfium } from '../../src/pdf/pdfium.js';
import { type RedactRequest, type RedactResult, redactPdf } from '../../src/pdf/redact.js';
import { type RegionRecord, regionCases, regionRecord } from './box-regions.js';
import { askLine, fitPdf } from './fit-fixtures.js';
import { twoMarksFixture } from './fixtures.js';
import { black, inside, render } from './pixels.js';

const copyOf = (result: RedactResult): { pdf: Uint8Array; boxes: Region[] } => {
  if (result.kind !== 'redacted') throw new Error(`expected a redacted copy, got ${JSON.stringify(result)}`);
  return result;
};

async function chars(pdf: Uint8Array, index = 0): Promise<PageChar[]> {
  const doc = Document.open(await pdfium(), pdf);
  if (doc === null) throw new Error('unopenable');
  try {
    return doc.page(index, (page) => page.chars().chars);
  } finally {
    doc.close();
  }
}

const within = (inner: Box, outer: Box): boolean => inner.left >= outer.left - 0.01 && inner.right <= outer.right + 0.01 && inner.bottom >= outer.bottom - 0.01 && inner.top <= outer.top + 0.01;

/** What PDFium reads inside each box: the label's glyphs, whose ink lies wholly inside it. */
async function labelsIn(pdf: Uint8Array, boxes: readonly Box[]): Promise<string[]> {
  const read = (await chars(pdf)).filter((c) => !c.generated && c.ink !== null);
  // A space the passages left between them, under the box, reads at its ends.
  return boxes.map((box) => read.filter((c) => within(c.ink as Box, box)).map((c) => c.text).join('').trim());
}

const QUILLON = (): Promise<Uint8Array> => fitPdf(askLine('(Quillon Brask) Tj'));
/** Two passages on two lines of one page. */
const TWO_LINES = (): Promise<Uint8Array> => fitPdf(`${askLine('(Quillon Brask) Tj', { y: 100 })}\n${askLine('(Ottoline Varga) Tj', { y: 40 })}`);

const passes = async (copy: Uint8Array, original: Uint8Array, quotes: readonly string[]): Promise<void> => {
  const reply = await gateReply({ copy, original, quotes, image: 'show' });
  expect(reply.verdict).toEqual({ pass: true });
  expect(reply.sha256).toBe(sha256Hex(copy));
};

describe('the engine labels each box by who may read it', () => {
  it('labels a public box "Members Only" when members can see the passage, white on the black box', async () => {
    const original = await QUILLON();
    const { pdf, boxes } = copyOf(await redactPdf(original, { quotes: ['Quillon Brask'], membersWithhold: [false], redactsAny: true }));
    expect(boxes).toHaveLength(1);
    expect(await labelsIn(pdf, boxes)).toEqual(['Members Only']);
    const pixels = inside(await render(pdf), boxes[0] as Region);
    expect(pixels.some(([r, g, b]) => r > 200 && g > 200 && b > 200)).toBe(true);
    expect(pixels.some(([r, g, b]) => black(r, g, b))).toBe(true);
    await passes(pdf, original, ['Quillon Brask']);
  });

  it('labels it "Private" when members cannot see it either, as in the members copy', async () => {
    const original = await QUILLON();
    const { pdf, boxes } = copyOf(await redactPdf(original, { quotes: ['Quillon Brask'], membersWithhold: [true], redactsAny: true }));
    expect(await labelsIn(pdf, boxes)).toEqual(['Private']);
    await passes(pdf, original, ['Quillon Brask']);
  });

  it('labels every box "Private" when the request does not say what members withhold', async () => {
    const { pdf, boxes } = copyOf(await redactPdf(await QUILLON(), { quotes: ['Quillon Brask'], redactsAny: true }));
    expect(await labelsIn(pdf, boxes)).toEqual(['Private']);
  });

  it('falls back to "Mbrs Only" where "Members Only" does not fit, and to none where neither does; "Private" where it fits', async () => {
    const original = await twoMarksFixture();
    const members = copyOf(await redactPdf(original, { quotes: ['Bo', 'Quillon'], membersWithhold: [false, false], redactsAny: true }));
    // "Bo" (14.676 pt) takes no label at all; "Quillon" (37.344 pt) is too narrow for "Members Only" at 7.2 pt.
    expect(members.boxes.map((box) => +(box.right - box.left).toFixed(3))).toEqual([14.676, 37.344]);
    expect((37.344 - 2) / LABEL_EMS['Members Only']).toBeLessThan(7.2);
    expect(await labelsIn(members.pdf, members.boxes)).toEqual(['', 'Mbrs Only']);
    const privateCopy = copyOf(await redactPdf(original, { quotes: ['Bo', 'Quillon'], membersWithhold: [true, true], redactsAny: true }));
    expect(await labelsIn(privateCopy.pdf, privateCopy.boxes)).toEqual(['', 'Private']);
    // No box is labelled in a too-small size: the boxes without one are all black.
    const pixels = inside(await render(members.pdf), members.boxes[0] as Region);
    expect(pixels.every(([r, g, b]) => black(r, g, b))).toBe(true);
  });

  it('decides each box by its own passage: one page, one box of each', async () => {
    const original = await TWO_LINES();
    const { pdf, boxes } = copyOf(await redactPdf(original, { quotes: ['Quillon Brask', 'Ottoline Varga'], membersWithhold: [false, true], redactsAny: true }));
    expect(boxes).toHaveLength(2);
    const byLine = [...boxes].sort((a, b) => b.bottom - a.bottom);
    expect(await labelsIn(pdf, byLine)).toEqual(['Members Only', 'Private']);
    await passes(pdf, original, ['Quillon Brask', 'Ottoline Varga']);
  });

  it('labels a box "Private" when any passage it covers is withheld from members (a box holds both)', async () => {
    const original = await QUILLON();
    const { pdf, boxes } = copyOf(await redactPdf(original, { quotes: ['Quillon', 'Brask'], membersWithhold: [false, true], redactsAny: true }));
    expect(await labelsIn(pdf, boxes)).toEqual(boxes.length === 1 ? ['Private'] : ['Mbrs Only', 'Private'].slice(0, boxes.length));
  });

  it('draws no "withheld" anywhere any more', async () => {
    const { pdf } = copyOf(await redactPdf(await QUILLON(), { quotes: ['Quillon Brask'], membersWithhold: [false], redactsAny: true }));
    expect((await chars(pdf)).map((c) => c.text).join('')).not.toContain('withheld');
  });
});

describe('label text is not a leak (exactly the three strings, inside boxes)', () => {
  it.each([
    ['Private', true],
    ['Members Only', false],
  ])('gives a copy of a passage that is itself "%s": its label reads as it, and is no leak', async (quote, private_) => {
    const original = await fitPdf(askLine(`(${quote}) Tj`));
    const { pdf, boxes } = copyOf(await redactPdf(original, { quotes: [quote], membersWithhold: [private_], redactsAny: true }));
    expect(await labelsIn(pdf, boxes)).toEqual([quote]);
    await passes(pdf, original, [quote]);
  });

  it('gives a copy when a short quote ("Only") is in a label of another passage', async () => {
    const original = await QUILLON();
    const { pdf, boxes } = copyOf(await redactPdf(original, { quotes: ['Quillon Brask', 'Only'], membersWithhold: [false, false], redactsAny: true }));
    expect(await labelsIn(pdf, boxes)).toEqual(['Members Only']);
    await passes(pdf, original, ['Quillon Brask', 'Only']);
  });

  it('still refuses the quote drawn again outside the boxes, beside an honest label of it', async () => {
    const original = await fitPdf(askLine('(Private) Tj'));
    const { pdf } = copyOf(await redactPdf(original, { quotes: ['Private'], membersWithhold: [true], redactsAny: true }));
    // A subverted engine adds the word in plain black type elsewhere on the page.
    const again = await patched(pdf, (content) => `${content}\nq 0 0 0 rg BT /FXF1 12 Tf 20 20 Td (Private) Tj ET Q`);
    expect(await gateVerdict({ copy: again, original, quotes: ['Private'], image: 'show' })).toEqual({ pass: false, code: 'withheld' });
    // ... or in a form, where no label can be.
    const inForm = await withForm(pdf, 'BT /F1 12 Tf 20 20 Td (Private) Tj ET');
    expect(await gateVerdict({ copy: inForm, original, quotes: ['Private'], image: 'show' })).toEqual({ pass: false, code: 'withheld' });
  });
});

/** The copy with its page's last content stream changed by `edit` (a subverted engine's). */
async function patched(pdf: Uint8Array, edit: (content: string) => string): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const page = doc.getPage(0);
  const { context } = doc;
  const contents = context.lookup(page.node.get(PDFName.of('Contents')));
  const refs = contents instanceof PDFArray ? contents.asArray() : [page.node.get(PDFName.of('Contents'))];
  const last = refs.at(-1);
  const stream = context.lookup(last) as PDFRawStream;
  const text = edit(Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1'));
  context.assign(last as never, context.flateStream(Buffer.from(text, 'latin1')));
  return doc.save({ useObjectStreams: false });
}

/** The copy with a form XObject drawn by its page, holding this content in Helvetica (F1). */
async function withForm(pdf: Uint8Array, content: string): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const page = doc.getPage(0);
  const { context } = doc;
  const helvetica = context.register(context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }));
  const form = context.register(context.flateStream(content, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 400, 140], Resources: { Font: { F1: helvetica } } }));
  page.node.setXObject(PDFName.of('Fx9'), form);
  page.node.addContentStream(context.register(context.flateStream('/Fx9 Do')));
  return doc.save({ useObjectStreams: false });
}

const LABEL_OP = /q 1 1 1 rg 0 G 1 0 0 1 (\S+) (\S+) cm BT 1 0 0 1 0 0 Tm \/(\S+) (\S+) Tf 0 Tr <([0-9A-F]+)> Tj ET Q/;
const hex = (text: string): string => Buffer.from(text, 'latin1').toString('hex').toUpperCase();

describe('the gate takes exactly the three labels, inside boxes, in the label style', () => {
  const honest = async (request: Partial<RedactRequest> = {}): Promise<{ original: Uint8Array; pdf: Uint8Array; boxes: Region[] }> => {
    const original = await QUILLON();
    return { original, ...copyOf(await redactPdf(original, { quotes: ['Quillon Brask'], membersWithhold: [false], redactsAny: true, ...request })) };
  };
  const verdict = (copy: Uint8Array, original: Uint8Array, quotes: readonly string[] = ['Quillon Brask']) => gateVerdict({ copy, original, quotes, image: 'show' });

  it('reads the honest copy\'s one label in its box', async () => {
    const { pdf, boxes } = await honest();
    const marks = await labelMarks(pdf);
    expect(typeof marks).not.toBe('string');
    expect(marks).toEqual([[{ text: 'Members Only', x: expect.any(Number) as unknown, y: expect.any(Number) as unknown }]]);
    expect(LABEL_OP.exec(Buffer.from(await contentOf(pdf)).toString('latin1'))?.[5]).toBe(hex('Members Only'));
    expect(boxes).toHaveLength(1);
  });

  it.each([
    ['other text in the label\'s place', 'Call 555-0142'],
    ['the old label', 'withheld'],
    ['a label in another case', 'members only'],
    ['a label with a period', 'Mbrs. Only'],
  ])('refuses %s, drawn in the label style inside the box', async (_name, text) => {
    const { original, pdf } = await honest();
    const bad = await patched(pdf, (content) => content.replace(hex('Members Only'), hex(text)));
    expect(typeof (await labelMarks(bad))).toBe('string');
    expect(await verdict(bad, original)).toEqual({ pass: false, code: 'rules' });
  });

  it('refuses a label drawn outside any box', async () => {
    const { original, pdf } = await honest();
    const moved = await patched(pdf, (content) => content.replace(LABEL_OP, (op, x: string) => op.replace(` ${x} `, ' 300 ')));
    expect(await labelMarks(moved)).toMatch(/a label is drawn outside a box/);
    expect(await verdict(moved, original)).toEqual({ pass: false, code: 'rules' });
    const extra = await patched(pdf, (content) => `${content}\n${(LABEL_OP.exec(content) as RegExpExecArray)[0].replace(/ 1 0 0 1 \S+ \S+ cm/, ' 1 0 0 1 300 20 cm')}`);
    expect(await labelMarks(extra)).toMatch(/a label is drawn outside a box/);
    expect(await verdict(extra, original)).toEqual({ pass: false, code: 'rules' });
  });

  it('refuses a label in a form, and a label set in another style (black, or rotated)', async () => {
    const { original, pdf } = await honest();
    const inForm = await withForm(pdf, 'q 1 1 1 rg BT /F1 9 Tf 300 20 Td (Private) Tj ET Q');
    expect(await labelMarks(inForm)).toMatch(/a label is drawn outside a box/);
    expect(await verdict(inForm, original)).toEqual({ pass: false, code: 'rules' });
    const turned = await patched(pdf, (content) => content.replace(LABEL_OP, (op) => op.replace(/ 1 0 0 1 (\S+) (\S+) cm BT/, ' 0.9 0 0 0.9 $1 $2 cm BT')));
    expect(await labelMarks(turned)).toMatch(/a label is not in the labels' style/);
    const black = await patched(pdf, (content) => content.replace(LABEL_OP, (op) => op.replace('q 1 1 1 rg', 'q 0.5 0.5 0.5 rg')));
    expect(await labelMarks(black)).toMatch(/text other than its label is in a box/);
    expect(await verdict(turned, original)).toEqual({ pass: false, code: 'rules' });
  });

  it('refuses any other text drawn over a box; text under a box is hidden by it, and the leak checks still read it', async () => {
    const { original, pdf, boxes } = await honest();
    const box = boxes[0] as Region;
    const over = await patched(pdf, (content) => `${content}\nq 1 1 1 rg BT /FXF1 6 Tf ${box.left + 2} ${box.bottom + 2} Td (x) Tj ET Q`);
    expect(await labelMarks(over)).toMatch(/text other than its label is in a box/);
    expect(await verdict(over, original)).toEqual({ pass: false, code: 'rules' });
    const blue = await patched(pdf, (content) => `${content}\nq 0 0 1 rg BT /FXF1 6 Tf ${box.left + 2} ${box.bottom + 2} Td (Kestrel) Tj ET Q`);
    expect(await labelMarks(blue)).toMatch(/text other than its label is in a box/);
    const inForm = await withForm(pdf, `BT /F1 6 Tf ${box.left + 2} ${box.bottom + 2} Td (Kestrel) Tj ET`);
    expect(await labelMarks(inForm)).toMatch(/text other than its label is in a box/);
    expect(await verdict(inForm, original)).toEqual({ pass: false, code: 'rules' });
    const under = await patched(pdf, (content) => content.replace(/q 0 0 0 rg 0 G/, `q 0 0 1 rg BT /FXF1 6 Tf ${box.left + 2} ${box.bottom + 2} Td (Kestrel) Tj ET Q\nq 0 0 0 rg 0 G`));
    expect(await labelMarks(under)).toEqual([[{ text: 'Members Only', x: expect.any(Number) as unknown, y: expect.any(Number) as unknown }]]);
    expect(await verdict(under, original)).toEqual({ pass: true });
    expect(await verdict(under, original, ['Quillon Brask', 'Kestrel'])).toEqual({ pass: false, code: 'withheld' });
  });

  it('refuses two labels in one box', async () => {
    const { original, pdf } = await honest();
    const twice = await patched(pdf, (content) => `${content}\n${(LABEL_OP.exec(content) as RegExpExecArray)[0]}`);
    expect(typeof (await labelMarks(twice))).toBe('string');
    expect(await verdict(twice, original)).toEqual({ pass: false, code: 'rules' });
  });

});

/** The page's content streams, joined, decoded. */
async function contentOf(pdf: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const { context } = doc;
  const value = context.lookup(doc.getPage(0).node.get(PDFName.of('Contents')));
  const streams = value instanceof PDFArray ? value.asArray().map((ref) => context.lookup(ref)) : [value];
  return Buffer.concat(streams.map((stream) => decodePDFRawStream(stream as PDFRawStream).decode()));
}

describe('the labels change nothing but the label: each region and every pixel outside the boxes is main\'s', () => {
  const golden = (JSON.parse(readFileSync(new URL('./box-regions.golden.json', import.meta.url), 'utf8')) as { cases: Record<string, RegionRecord> }).cases;

  it('covers every case main made, the refusals too', () => {
    expect(Object.keys(golden).sort()).toEqual(regionCases().map((c) => c.name).sort());
    expect(Object.values(golden).filter((record) => record.kind === 'redacted')).toHaveLength(83);
  });

  it.each(regionCases().map((c) => [c.name, c] as const))('%s', async (name, c) => {
    // Members can see every passage ("Members Only" labels), then none ("Private"): the same regions and pixels either way.
    for (const flag of [false, true]) expect(await regionRecord(redactPdf, c, { membersWithhold: c.quotes.map(() => flag) }), String(flag)).toEqual(golden[name]);
  }, 120_000);
});
