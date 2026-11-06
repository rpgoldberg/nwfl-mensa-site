// The gate's own checks on a copy (UNTRUSTED-PDF-GATE S3), run in the gate's child: the sanitizer's
// invariants (no active content, no attached files, no forms) and the picture policy's output shape,
// read from the copy alone. The engine's copies must pass them; a subverted engine's must not.
// Every name is made up.
import { deflateSync } from 'node:zlib';
import { type PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFString, StandardFonts } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { leakFixture, linesPdf, pictureUnderTextFixture, twoMarksFixture } from '../../test/pdf/fixtures.js';
import { M1_CASES, M1_DRAWN_CASES, M1_LINEARIZED_CASES, M1_ORIGINAL, M1_QUOTES, Q1, type RawObject, HONEST_ORIGINALS, HONEST_QUOTES, S1_ROWS, S1_STITCHED_ROWS, formChain, linearizedCopy, lyingToUnicode, meshShading, nestedForms, onSplitPage, plainCopy, rawPdf, rawStream, roundFiveWriting } from '../../test/pdf/shadows.js';
import { drawnBreak } from './drawn.js';
import { sha256Hex } from './engine-protocol.js';
import { copyRulesBreak, gateReply, gateVerdict, rewrite } from './gate-rules.js';
import { checkCopy } from './gate.js';
import { BLUR_MAX, FILL_GRAY } from './images.js';
import { structureBreak } from './pdf-structure.js';
import { redactPdf } from './redact.js';
import { sanitize } from './sanitize.js';

type Doc = Awaited<ReturnType<typeof PDFDocument.create>>;

/** A one-page copy reading "Picnic flyer", changed by `edit` before it is saved. */
async function copy(edit: (doc: Doc) => void | Promise<void> = () => {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([612, 792]);
  page.drawText('Picnic flyer', { x: 72, y: 720, size: 12, font: await doc.embedFont(StandardFonts.Helvetica) });
  await edit(doc);
  return doc.save({ useObjectStreams: false });
}

/** A copy whose page draws one picture XObject with this dictionary and these stored bytes. */
const withPicture = (dict: Record<string, unknown>, bytes: Uint8Array): Promise<Uint8Array> =>
  copy((doc) => {
    const page = doc.getPage(0);
    const head = doc.context.obj({ Type: 'XObject', Subtype: 'Image', ...dict } as Parameters<typeof doc.context.obj>[0]) as unknown as PDFDict;
    const ref = doc.context.register(PDFRawStream.of(head, bytes));
    page.node.setXObject(PDFName.of('Im1'), ref);
    page.node.addContentStream(doc.context.register(doc.context.stream('q 100 0 0 100 72 400 cm /Im1 Do Q')));
  });

const flatePicture = (width: number, height: number, channels: 1 | 3): Promise<Uint8Array> =>
  withPicture(
    { Width: width, Height: height, ColorSpace: channels === 1 ? 'DeviceGray' : 'DeviceRGB', BitsPerComponent: 8, Filter: 'FlateDecode' },
    deflateSync(Buffer.alloc(width * height * channels, 0x5a)),
  );
const fill = (): Promise<Uint8Array> => withPicture({ Width: 1, Height: 1, ColorSpace: 'DeviceGray', BitsPerComponent: 8 }, Uint8Array.from([FILL_GRAY]));

describe('copyRulesBreak: the sanitizer\'s invariants, re-checked on the copy', () => {
  it('passes a plain copy under every picture policy, an empty annotation list included', async () => {
    const plain = await copy();
    for (const image of ['show', 'blur', 'hide'] as const) expect(await copyRulesBreak(plain, image), image).toBeNull();
    const emptyList = await copy((doc) => doc.getPage(0).node.set(PDFName.of('Annots'), doc.context.register(doc.context.obj([]))));
    expect(await copyRulesBreak(emptyList, 'show')).toBeNull();
  });

  it('refuses active content and attached files anywhere in the copy, under every policy', async () => {
    const cases: Array<[string, (doc: Doc) => void]> = [
      ['an open action', (doc) => doc.catalog.set(PDFName.of('OpenAction'), doc.context.obj([doc.getPage(0).ref, 'Fit']))],
      ['document JavaScript', (doc) => doc.catalog.set(PDFName.of('Names'), doc.context.obj({ JavaScript: { Names: [PDFString.of('a'), doc.context.obj({ S: 'JavaScript', JS: PDFString.of('app.alert(1)') })] } }))],
      ['a page\'s additional actions', (doc) => doc.getPage(0).node.set(PDFName.of('AA'), doc.context.obj({ O: { S: 'Launch', F: PDFString.of('cmd.exe') } }))],
      ['a Launch action under a resource', (doc) => doc.getPage(0).node.set(PDFName.of('Junk'), doc.context.obj({ Next: { S: 'Launch', F: PDFString.of('x') } }))],
      ['a URI to a file', (doc) => doc.getPage(0).node.set(PDFName.of('Junk'), doc.context.obj({ S: 'URI', URI: PDFString.of('file:///etc/passwd') }))],
      ['an action dictionary by its type', (doc) => doc.getPage(0).node.set(PDFName.of('Junk'), doc.context.obj({ Type: 'Action', S: 'GoTo' }))],
      ['an embedded file', (doc) => doc.catalog.set(PDFName.of('Names'), doc.context.obj({ EmbeddedFiles: { Names: [] } }))],
      ['a file specification', (doc) => doc.getPage(0).node.set(PDFName.of('Junk'), doc.context.obj({ Type: 'Filespec', F: PDFString.of('a.txt'), EF: { F: doc.context.register(doc.context.stream('x', { Type: 'EmbeddedFile' })) } }))],
      ['an XFA form', (doc) => doc.catalog.set(PDFName.of('AcroForm'), doc.context.obj({ Fields: [], XFA: doc.context.register(doc.context.stream('<xdp/>')) }))],
      ['a form', (doc) => doc.catalog.set(PDFName.of('AcroForm'), doc.context.obj({ Fields: [] }))],
      ['annotations', (doc) => doc.getPage(0).node.set(PDFName.of('Annots'), doc.context.obj([doc.context.obj({ Subtype: 'Text', Contents: PDFString.of('x') })]))],
      ['an annotation dictionary by its type', (doc) => doc.getPage(0).node.set(PDFName.of('Junk'), doc.context.obj({ Type: 'Annot', Subtype: 'Link' }))],
      ['JavaScript under a JS key', (doc) => doc.getPage(0).node.set(PDFName.of('Junk'), doc.context.obj({ JS: PDFString.of('x') }))],
    ];
    for (const [name, edit] of cases) {
      const bad = await copy(edit);
      for (const image of ['show', 'blur'] as const) expect(await copyRulesBreak(bad, image), `${name}, ${image}`).toMatch(/^object \d+: |^the trailer: /);
    }
  });

  it('refuses an embedded file attached as a PDF 2.0 associated file: /EF in a file specification with no /Type, under the catalog\'s /AF (S3)', async () => {
    const attached = await copy((doc) => {
      const file = doc.context.register(doc.context.flateStream(Buffer.from('payload: members roster')));
      const spec = doc.context.register(doc.context.obj({ F: 'roster.txt', UF: 'roster.txt', EF: { F: file } }));
      doc.catalog.set(PDFName.of('AF'), doc.context.obj([spec]));
    });
    for (const image of ['show', 'blur', 'hide'] as const) expect(await copyRulesBreak(attached, image), image).toMatch(/^object \d+: it holds \/EF$/);
  });

  it('refuses an encrypted copy, and one it cannot read, by its structure first (M1)', async () => {
    const encrypted = await copy((doc) => {
      doc.context.trailerInfo.Encrypt = doc.context.register(doc.context.obj({ Filter: 'Standard', V: 1, R: 2 }));
    });
    expect(await copyRulesBreak(encrypted, 'show')).toBe('the structure: its trailer has more than /Size and /Root');
    expect(await copyRulesBreak(Uint8Array.from([1, 2, 3]), 'show')).toBe('the structure: it has no xref table where startxref points');
  });

  it('refuses a structural name or number given by reference (/S, /Subtype, /Type, /PatternType, /Filter), which a viewer resolves (M1)', async () => {
    const indirect = (key: string, value: string | number, extra: Record<string, unknown> = {}) =>
      copy((doc) => {
        const target = doc.context.register(typeof value === 'number' ? PDFNumber.of(value) : PDFName.of(value));
        doc.getPage(0).node.set(PDFName.of('Junk'), doc.context.obj({ ...extra, [key]: target } as Parameters<typeof doc.context.obj>[0]));
      });
    const cases: Array<[string, Promise<Uint8Array>]> = [
      ['S', indirect('S', 'Launch', { F: PDFString.of('cmd.exe') })],
      ['Subtype', indirect('Subtype', 'Image')],
      ['Type', indirect('Type', 'Action')],
      ['PatternType', indirect('PatternType', 1)],
      ['Filter', indirect('Filter', 'FlateDecode')],
    ];
    for (const [key, made] of cases) {
      for (const image of ['show', 'blur', 'hide'] as const) expect(await copyRulesBreak(await made, image), `${key}, ${image}`).toBe(`object 3: its /${key} is not direct`);
    }
    const listed = await copy((doc) => doc.getPage(0).node.set(PDFName.of('Junk'), doc.context.obj({ Filter: [doc.context.register(PDFName.of('FlateDecode'))] })));
    expect(await copyRulesBreak(listed, 'show')).toMatch(/^object \d+: its \/Filter is not direct$/);
  });

  it('under "hide", allows only the 1 x 1 grey fill the policy draws', async () => {
    expect(await copyRulesBreak(await fill(), 'hide')).toBeNull();
    expect(await copyRulesBreak(await flatePicture(2, 2, 1), 'hide')).toMatch(/a picture is not what the "hide" policy draws/);
    expect(await copyRulesBreak(await withPicture({ Width: 1, Height: 1, ColorSpace: 'DeviceGray', BitsPerComponent: 8 }, Uint8Array.from([7])), 'hide')).toMatch(/hide/);
  });

  it('under "blur", allows the fill or a small Flate grey or RGB picture of at most BLUR_MAX pixels a side, with nothing else', async () => {
    expect(BLUR_MAX).toBe(24);
    expect(await copyRulesBreak(await fill(), 'blur')).toBeNull();
    expect(await copyRulesBreak(await flatePicture(BLUR_MAX, 16, 3), 'blur')).toBeNull();
    expect(await copyRulesBreak(await flatePicture(1, BLUR_MAX, 1), 'blur')).toBeNull();
    const refused: Array<[string, Promise<Uint8Array>]> = [
      ['too wide', flatePicture(BLUR_MAX + 1, 4, 3)],
      ['too tall', flatePicture(4, BLUR_MAX + 1, 1)],
      ['a JPEG', withPicture({ Width: 8, Height: 8, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode' }, Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]))],
      ['a soft mask', withPicture({ Width: 4, Height: 4, ColorSpace: 'DeviceGray', BitsPerComponent: 8, Filter: 'FlateDecode', SMask: 7 }, deflateSync(Buffer.alloc(16)))],
      ['a CMYK picture', withPicture({ Width: 4, Height: 4, ColorSpace: 'DeviceCMYK', BitsPerComponent: 8, Filter: 'FlateDecode' }, deflateSync(Buffer.alloc(64)))],
      ['a 1-bit picture', withPicture({ Width: 8, Height: 8, ColorSpace: 'DeviceGray', BitsPerComponent: 1, Filter: 'FlateDecode' }, deflateSync(Buffer.alloc(8)))],
      ['samples short of its size', withPicture({ Width: 4, Height: 4, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'FlateDecode' }, deflateSync(Buffer.alloc(10)))],
      ['samples that do not inflate', withPicture({ Width: 4, Height: 4, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'FlateDecode' }, Uint8Array.from([1, 2, 3]))],
      ['a filter chain', withPicture({ Width: 4, Height: 4, ColorSpace: 'DeviceGray', BitsPerComponent: 8, Filter: ['FlateDecode'] }, deflateSync(Buffer.alloc(16)))],
      ['no size', withPicture({ ColorSpace: 'DeviceGray', BitsPerComponent: 8, Filter: 'FlateDecode' }, deflateSync(Buffer.alloc(16)))],
    ];
    for (const [name, made] of refused) expect(await copyRulesBreak(await made, 'blur'), name).toMatch(/a picture is not what the "blur" policy draws/);
    // "show" keeps pictures as they are.
    for (const [name, made] of refused) expect(await copyRulesBreak(await made, 'show'), name).toBeNull();
  });

  it('under "blur" or "hide", refuses an inline picture in any content: a page, a form, a Type 3 glyph', async () => {
    const inline = 'q 50 0 0 50 400 300 cm BI /W 4 /H 4 /CS /RGB /BPC 8 ID ' + 'ZQXJ'.repeat(12) + ' EI Q';
    const onPage = await copy((doc) => doc.getPage(0).node.addContentStream(doc.context.register(doc.context.flateStream(inline))));
    const inForm = await copy((doc) => {
      const form = doc.context.register(doc.context.stream(inline, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 612, 792] }));
      doc.getPage(0).node.setXObject(PDFName.of('Fm'), form);
    });
    const inGlyph = await copy((doc) => {
      const glyph = doc.context.register(doc.context.stream(`10 0 0 0 10 10 d1 ${inline}`));
      doc.getPage(0).node.setFontDictionary(PDFName.of('T3'), doc.context.register(doc.context.obj({ Type: 'Font', Subtype: 'Type3', FontBBox: [0, 0, 10, 10], FontMatrix: [0.1, 0, 0, 0.1, 0, 0], CharProcs: { g: glyph } })));
    });
    const inPattern = await copy((doc) => {
      const pattern = doc.context.register(doc.context.stream(inline, { PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 10, 10], XStep: 10, YStep: 10 }));
      doc.getPage(0).node.set(PDFName.of('Junk'), pattern);
    });
    for (const [name, bad] of [['page', onPage], ['form', inForm], ['glyph', inGlyph], ['pattern', inPattern]] as const) {
      for (const image of ['blur', 'hide'] as const) expect(await copyRulesBreak(bad, image), `${name}, ${image}`).toMatch(/an inline picture/);
      expect(await copyRulesBreak(bad, 'show'), name).toBeNull();
    }
    const undecodable = await copy((doc) => doc.getPage(0).node.addContentStream(doc.context.register(doc.context.stream('x', { Filter: 'JBIG2Decode' }))));
    expect(await copyRulesBreak(undecodable, 'blur')).toMatch(/a content stream cannot be read/);
  });

  it('passes every copy the real engine makes, under each policy (no false refusal)', async () => {
    const files: Array<[string, Uint8Array, string[]]> = [
      ['a picture', await pictureUnderTextFixture(), ['Pellingham']],
      ['every canary', await leakFixture(), ['Quillon Brask']],
      ['two marks', await twoMarksFixture(), []],
      ['lines', await linesPdf(['Picnic flyer', 'Rides: call Kestrel Ambry.']), ['Kestrel Ambry']],
    ];
    let made = 0;
    for (const [name, original, quotes] of files) {
      for (const image of ['show', 'blur', 'hide'] as const) {
        const result = await redactPdf(original, { quotes, redactsAny: true, image });
        if (result.kind !== 'redacted') continue;
        made += 1;
        expect(await copyRulesBreak(result.pdf, image), `${name}, ${image}`).toBeNull();
      }
    }
    expect(made).toBeGreaterThanOrEqual(9);
  }, 60_000);
});

describe('gateVerdict and gateReply (the gate child\'s answer)', () => {
  it('passes a clean copy; refuses withheld text first, then a broken rule; never throws', async () => {
    const clean = await linesPdf(['Picnic flyer']);
    const original = clean;
    expect(await gateVerdict({ copy: clean, original, quotes: ['Kestrel Ambry'], image: 'blur' })).toEqual({ pass: true });
    const leaky = await linesPdf(['Rides: call Kestrel Ambry.']);
    expect(await gateVerdict({ copy: leaky, original, quotes: ['Kestrel Ambry'], image: 'blur' })).toEqual({ pass: false, code: 'withheld' });
    const active = await copy((doc) => doc.catalog.set(PDFName.of('OpenAction'), doc.context.obj({ S: 'JavaScript', JS: PDFString.of('x') })));
    expect(await gateVerdict({ copy: active, original, quotes: [], image: 'show' })).toEqual({ pass: false, code: 'rules' });
    expect(await gateVerdict({ copy: active, original, quotes: ['Kestrel Ambry'], image: 'show' })).toEqual({ pass: false, code: 'rules' });
    expect(await gateVerdict({ copy: Uint8Array.from([1]), original, quotes: ['Kestrel Ambry'], image: 'show' })).toEqual({ pass: false, code: 'withheld' });
    expect(await gateVerdict({ copy: Uint8Array.from([1]), original, quotes: [], image: 'show' })).toEqual({ pass: false, code: 'rules' });
  });

  it('refuses a copy that keeps an original picture where the policy blurs or hides pictures, even one small enough to look blurred', async () => {
    // Both are under BLUR_MAX, so they have the blur's shape: only the comparison with the original
    // catches them kept. 16 x 16 is caught by its runs of samples (keepsPicture) and by its samples;
    // 4 x 4 (16 bytes, under keepsPicture's 64-byte window) by its samples alone.
    for (const side of [16, 4]) {
      const varied = Uint8Array.from({ length: side * side }, (_, i) => (i * 37 + (i >> 2) * 11) % 251);
      const original = await withPicture({ Width: side, Height: side, ColorSpace: 'DeviceGray', BitsPerComponent: 8, Filter: 'FlateDecode' }, deflateSync(varied));
      expect(await copyRulesBreak(original, 'blur'), `${side}: the shape alone passes it`).toBeNull();
      for (const image of ['blur', 'hide'] as const) expect(await gateVerdict({ copy: original, original, quotes: [], image }), `${side}, ${image}`).toEqual({ pass: false, code: 'rules' });
      expect(await gateVerdict({ copy: original, original, quotes: [], image: 'show' })).toEqual({ pass: true });
      // The engine's own blurred copy differs from the original, and passes.
      const made = await redactPdf(original, { quotes: [], redactsAny: true, image: 'blur' });
      expect(made.kind).toBe('redacted');
      expect(await gateVerdict({ copy: (made as { pdf: Uint8Array }).pdf, original, quotes: [], image: 'blur' }), `${side}: the engine's copy`).toEqual({ pass: true });
    }
  });

  it('refuses a copy that keeps a crop of an original picture, rows of its samples, though no picture is a whole original (S3: keepsPicture)', async () => {
    const W = 64;
    const samples = Uint8Array.from({ length: W * W * 3 }, (_, i) => (Math.imul(i + 1, 2654435761) >>> 24) % 251);
    const rgb = (side: number, bytes: Uint8Array) => withPicture({ Width: side, Height: side, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'FlateDecode' }, deflateSync(bytes));
    const original = await rgb(W, samples);
    // A 24 x 24 crop from (10, 10): each 72-byte row is a run of the original's samples.
    const crop = new Uint8Array(24 * 24 * 3);
    for (let y = 0; y < 24; y += 1) crop.set(samples.subarray((10 + y) * W * 3 + 30, (10 + y) * W * 3 + 30 + 72), y * 72);
    const kept = await rgb(24, crop);
    expect(await copyRulesBreak(kept, 'blur')).toBeNull();
    expect(await gateVerdict({ copy: kept, original, quotes: ['Kestrel Ambry'], image: 'blur' })).toEqual({ pass: false, code: 'rules' });
    // The engine's own blur of the original passes.
    const made = await redactPdf(original, { quotes: [], redactsAny: true, image: 'blur' });
    expect(await gateVerdict({ copy: (made as { pdf: Uint8Array }).pdf, original, quotes: [], image: 'blur' })).toEqual({ pass: true });
  });

  it('lets a picture through unchanged only where blurring would not change it (one of a single grey), and reads no windows from an unreadable original', async () => {
    // The fixture's picture is 8 x 8 of one grey: its blur is itself, so the engine's copy keeps its
    // samples and shows no more than the original's blur would.
    const original = await pictureUnderTextFixture();
    const made = await redactPdf(original, { quotes: [], redactsAny: true, image: 'blur' });
    expect(made.kind).toBe('redacted');
    expect(await gateVerdict({ copy: (made as { pdf: Uint8Array }).pdf, original, quotes: [], image: 'blur' })).toEqual({ pass: true });
    expect(await gateVerdict({ copy: original, original, quotes: [], image: 'hide' })).toEqual({ pass: false, code: 'rules' });
    expect(await gateVerdict({ copy: await linesPdf(['Picnic flyer']), original: Uint8Array.from([1]), quotes: [], image: 'blur' })).toEqual({ pass: true });
  });

  it('answers with the sha256 of the copy it was sent, and on a pass the bytes it checked: its own writing of the copy (M1)', async () => {
    // The engine writes with pdf-lib's writer, so its copy written again is the same bytes.
    const made = await redactPdf(await linesPdf(['Picnic flyer', 'Rides: call Kestrel Ambry.']), { quotes: ['Kestrel Ambry'], redactsAny: true, image: 'blur' });
    const engineCopy = (made as { pdf: Uint8Array }).pdf;
    const job = { copy: engineCopy, original: engineCopy, quotes: ['Kestrel Ambry'], image: 'hide' as const };
    expect(await gateReply(job)).toEqual({ verdict: { pass: true }, sha256: sha256Hex(engineCopy), checked: { pdf: engineCopy, sha256: sha256Hex(engineCopy) } });
    // A copy written another way is stored as the gate wrote it, and those bytes are what it checked.
    const plain = plainCopy();
    const reply = await gateReply({ copy: plain, original: plain, quotes: ['Kestrel Ambry'], image: 'blur' });
    expect(reply.verdict).toEqual({ pass: true });
    expect(reply.sha256).toBe(sha256Hex(plain));
    const written = reply.checked?.pdf as Uint8Array;
    expect(Buffer.from(written).equals(Buffer.from(plain))).toBe(false);
    expect(reply.checked?.sha256).toBe(sha256Hex(written));
    expect(await structureBreak(written)).toBeNull();
    expect(await gateVerdict({ copy: written, original: plain, quotes: ['Kestrel Ambry'], image: 'blur' })).toEqual({ pass: true });
    const odd = { copy: engineCopy, original: engineCopy, quotes: null as unknown as string[], image: 'show' as const };
    expect(await gateReply(odd)).toEqual({ verdict: { pass: false, code: 'unfinished' }, sha256: sha256Hex(engineCopy) });
  });

  it('gives no pass, and no bytes, for a copy whose own writing would pass the output cap, or one it cannot read', async () => {
    const plain = plainCopy();
    expect(await gateReply({ copy: plain, original: plain, quotes: [], image: 'show' }, 64)).toEqual({ verdict: { pass: false, code: 'unfinished' }, sha256: sha256Hex(plain) });
    const junk = Uint8Array.from([1, 2, 3]);
    expect(await gateReply({ copy: junk, original: plain, quotes: [], image: 'show' })).toEqual({ verdict: { pass: false, code: 'rules' }, sha256: sha256Hex(junk) });
  });
});

describe('M1: a viewer reads the copy the gate read (fix round 3, the parser differential)', () => {
  it('refuses each of the challenge\'s copies a to h2, as it refuses each written plainly, and passes none of their bytes on', async () => {
    expect(M1_CASES.map((c) => c.id)).toEqual(['a', 'a2', 'b', 'b2', 'c', 'c2', 'd', 'e', 'f', 'g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'h', 'h2']);
    for (const c of M1_CASES) {
      const job = { original: M1_ORIGINAL, quotes: M1_QUOTES, image: c.image };
      expect((await gateVerdict({ ...job, copy: c.control })).pass, `${c.id}: written plainly`).toBe(false);
      // h's quote is in its bytes as written, so the text check finds it before the structure check refuses it.
      const refused = { pass: false, code: c.id === 'h' ? 'withheld' : 'rules' };
      expect(await gateVerdict({ ...job, copy: c.attack }), c.id).toEqual(refused);
      expect(await gateReply({ ...job, copy: c.attack }), c.id).toEqual({ verdict: refused, sha256: sha256Hex(c.attack) });
    }
  });

  it('reads the original\'s pictures through references too: a kept small original whose /Subtype is indirect in the original is caught', async () => {
    const side = 4;
    const varied = Uint8Array.from({ length: side * side }, (_, i) => (i * 37 + (i >> 2) * 11) % 251);
    const dict = { Width: side, Height: side, ColorSpace: 'DeviceGray', BitsPerComponent: 8, Filter: 'FlateDecode' };
    const original = await copy((doc) => {
      const head = doc.context.obj({ Type: 'XObject', ...dict } as Parameters<typeof doc.context.obj>[0]) as unknown as PDFDict;
      head.set(PDFName.of('Subtype'), doc.context.register(PDFName.of('Image')));
      doc.getPage(0).node.setXObject(PDFName.of('Im1'), doc.context.register(PDFRawStream.of(head, deflateSync(varied))));
      doc.getPage(0).node.addContentStream(doc.context.register(doc.context.stream('q 100 0 0 100 72 400 cm /Im1 Do Q')));
    });
    const kept = await withPicture(dict, deflateSync(varied));
    expect(await copyRulesBreak(kept, 'blur')).toBeNull();
    expect(await gateVerdict({ copy: kept, original, quotes: [], image: 'blur' })).toEqual({ pass: false, code: 'rules' });
  });
});

describe('M1, fix round 4: pictures judged by what pdf.js draws from the gate\'s own writing, and the pdf-lib rules read as pdf.js reads', () => {
  const pagesOf = async (pdf: Uint8Array): Promise<Array<{ num: number; gen: number }>> =>
    (await PDFDocument.load(pdf, { updateMetadata: false })).getPages().map((page) => ({ num: page.ref.objectNumber, gen: page.ref.generationNumber }));

  it('refuses each of round 4\'s copies n1 to n5 under "hide", as it refuses each written plainly, by what pdf.js draws from them alone, and passes none of their bytes on', async () => {
    expect(M1_DRAWN_CASES.map((c) => c.id)).toEqual(['n1', 'n2', 'n2b', 'n2c', 'n3', 'n3b', 'n4', 'n5']);
    for (const c of M1_DRAWN_CASES) {
      const job = { original: M1_ORIGINAL, quotes: M1_QUOTES, image: c.image };
      expect((await gateVerdict({ ...job, copy: c.control })).pass, `${c.id}: written plainly`).toBe(false);
      expect(await drawnBreak(c.attack, 'hide', [], await pagesOf(c.attack)), c.id).toMatchObject({ code: 'rules' });
      expect(await gateVerdict({ ...job, copy: c.attack }), c.id).toEqual({ pass: false, code: 'rules' });
      expect(await gateReply({ ...job, copy: c.attack }), c.id).toEqual({ verdict: { pass: false, code: 'rules' }, sha256: sha256Hex(c.attack) });
    }
  });

  it('refuses n1 to n5 by the pdf-lib rules too (defence in depth): /DecodeParms on content, BI as pdf.js lexes it, a page-tree node with no /Type, a /Contents array read joined, and since fix round 6 (M-6) a function-based shading', async () => {
    const reasons: Record<string, string | null> = {};
    for (const c of M1_DRAWN_CASES) reasons[c.id] = await copyRulesBreak(c.attack, 'hide');
    expect(reasons['n1']).toMatch(/^object 4: a stream that is not a picture has \/DecodeParms$/);
    for (const id of ['n2', 'n2b', 'n2c', 'n4']) expect(reasons[id], id).toBe('an inline picture is in a content stream under the "hide" policy');
    for (const id of ['n3', 'n3b']) expect(reasons[id], id).toBe('the page tree: every node must be /Type /Pages with its /Kids and their /Count, every leaf /Type /Page, each once');
    expect(reasons['n5']).toBe('object 16: a shading of type 1');
    // Outside "blur" and "hide" pictures may be shown: only the page tree is a rule there.
    expect(await copyRulesBreak((M1_DRAWN_CASES[0] as { attack: Uint8Array }).attack, 'show')).toBeNull();
    expect(await copyRulesBreak((M1_DRAWN_CASES[4] as { attack: Uint8Array }).attack, 'show')).toMatch(/^the page tree: /);
  });

  it('refuses a page tree a viewer could read otherwise: a /Count that is not its pages, a node twice, a page with /Kids, a kid not by reference', async () => {
    const PAGE = '/Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R';
    const tree = (pages: string, extra: RawObject[] = []): Uint8Array => rawPdf([[1, '<< /Type /Catalog /Pages 2 0 R >>'], [2, pages], [3, `<< ${PAGE} >>`], [4, rawStream('', 'BT ET')], ...extra]);
    expect(await copyRulesBreak(tree('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'), 'show')).toBeNull();
    for (const [name, bad] of [
      ['a /Count of 2 for one page', tree('<< /Type /Pages /Kids [3 0 R] /Count 2 >>')],
      ['the same page twice', tree('<< /Type /Pages /Kids [3 0 R 3 0 R] /Count 2 >>')],
      ['a page with /Kids', tree('<< /Type /Pages /Kids [5 0 R] /Count 1 >>', [[5, `<< ${PAGE} /Kids [3 0 R] >>`]])],
      ['a kid written directly', tree(`<< /Type /Pages /Kids [<< ${PAGE} >>] /Count 1 >>`)],
      ['a root that is a page', rawPdf([[1, '<< /Type /Catalog /Pages 3 0 R >>'], [3, '<< /Type /Page /MediaBox [0 0 612 792] /Contents 4 0 R >>'], [4, rawStream('', 'BT ET')]])],
    ] as const) {
      expect(await copyRulesBreak(bad, 'show'), name).toMatch(/^the page tree: /);
    }
  });

  it('refuses /DecodeParms on any stream that is not a picture under "blur" or "hide" (a font program too), not under "show"', async () => {
    const withParms = await copy((doc) => {
      const font = doc.context.register(doc.context.stream('font program', { Filter: 'FlateDecode', DecodeParms: { Predictor: 2 } }));
      doc.getPage(0).node.set(PDFName.of('Junk'), doc.context.obj({ FontFile2: font }));
    });
    for (const image of ['blur', 'hide'] as const) expect(await copyRulesBreak(withParms, image), image).toMatch(/^object \d+: a stream that is not a picture has \/DecodeParms$/);
    expect(await copyRulesBreak(withParms, 'show')).toBeNull();
  });

  it('judges the gate\'s own writing, not the copy as handed over: a quote only in a comment between objects is gone from it, and it passes (q1, r4 N1)', async () => {
    const job = { copy: Q1, original: plainCopy(), quotes: M1_QUOTES, image: 'show' as const };
    // As handed over the quote is in the file's bytes, and the copy is refused.
    expect(await gateVerdict(job)).toEqual({ pass: false, code: 'withheld' });
    const reply = await gateReply(job);
    expect(reply.verdict).toEqual({ pass: true });
    expect(Buffer.from(reply.checked?.pdf ?? []).toString('latin1')).not.toContain('Kestrel');
  });

  it('judges the bytes its writing gives, whatever they are: a writing that breaks a rule is refused, though the copy as handed over passes (integrity N1)', async () => {
    const clean = plainCopy();
    const job = { copy: clean, original: plainCopy(), quotes: [], image: 'blur' as const };
    expect((await gateReply(job)).verdict).toEqual({ pass: true });
    const active = rawPdf([[1, '<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /JavaScript /JS (app.alert\\(1\\)) >> >>'], [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'], [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>']]);
    expect(await gateReply(job, undefined, () => Promise.resolve(active))).toEqual({ verdict: { pass: false, code: 'rules' }, sha256: sha256Hex(clean) });
  });
});

describe('M1, S1, S3, fix round 5: one page for every reader, no gradient drawn from samples, and nesting pdf.js reads to the end', () => {
  const job = (pdf: Uint8Array, image: 'show' | 'blur' | 'hide') => ({ copy: pdf, original: M1_ORIGINAL, quotes: M1_QUOTES, image });
  const CATALOG: RawObject = [1, '<< /Type /Catalog /Pages 2 0 R >>'];
  const PAGES: RawObject = [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'];
  /** One page drawing `content` with these resources, and these objects. */
  const onPage = (content: string | Buffer, resources = '', extra: RawObject[] = []): Uint8Array =>
    rawPdf([CATALOG, PAGES, [3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << ${resources} >> >>`], [4, rawStream('', content)], ...extra]);

  it('refuses a copy holding a /Linearized dictionary under every policy, so pdf.js cannot take a page from it: l1, l3 and l4, and through gateReply (M1)', async () => {
    for (const c of M1_LINEARIZED_CASES) {
      const linearized = await linearizedCopy(c.build, roundFiveWriting);
      // The attack as round 5 built it: pdf.js read the gate's writing of it as linearized, and judged object 9.
      expect(await drawnBreak(await roundFiveWriting(linearized), c.image, M1_QUOTES, [{ num: 4, gen: 0 }]), c.id).toEqual({ code: 'rules', reason: 'page 1: pdf.js reads object 9 where pdf-lib reads object 4' });
      for (const image of ['show', 'blur', 'hide'] as const) expect(await copyRulesBreak(linearized, image), `${c.id}, ${image}`).toBe('object 1: it holds /Linearized');
      expect(await gateReply(job(linearized, c.image)), c.id).toEqual({ verdict: { pass: false, code: 'rules' }, sha256: sha256Hex(linearized) });
    }
  });

  it('passes the sanitizer\'s copy of a linearized original: it writes no /Linearized, nor does the gate\'s writing of it (M1)', async () => {
    const build = (L: number): Uint8Array =>
      rawPdf(
        [
          [1, `<< /Linearized 1 /L ${L} /H [1000 100] /O 4 /E 1000 /N 1 /T 1000 >>`],
          [2, '<< /Type /Catalog /Pages 3 0 R >>'],
          [3, '<< /Type /Pages /Kids [4 0 R] /Count 1 >>'],
          [4, '<< /Type /Page /Parent 3 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 6 0 R >> >> >>'],
          [5, rawStream('', 'BT /F1 12 Tf 72 720 Td (Picnic flyer) Tj ET')],
          [6, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],
        ],
        { root: 2 },
      );
    let L = 10_000;
    while (build(L).byteLength !== L) L = build(L).byteLength;
    const original = build(L);
    for (const image of ['show', 'hide'] as const) {
      const copied = await sanitize(original, image);
      expect(Buffer.from(copied).toString('latin1'), image).not.toContain('/Linearized');
      const reply = await gateReply({ copy: copied, original, quotes: [], image });
      expect(reply.verdict, image).toEqual({ pass: true });
      expect(Buffer.from(reply.checked?.pdf ?? []).toString('latin1'), image).not.toContain('/Linearized');
      // The original itself, handed over as the copy, is refused (fix round 5b): its page is clean, its /Linearized is not.
      expect(await gateReply({ copy: original, original, quotes: [], image }), image).toEqual({ verdict: { pass: false, code: 'rules' }, sha256: sha256Hex(original) });
    }
  });

  it('writes no /Linearized itself, wherever a copy holds one, so pdf.js reads its writing by the page tree: l1, l3 and l4, and one in the catalog (M1, fix round 5b)', async () => {
    const own = (c: (typeof M1_LINEARIZED_CASES)[number]): Promise<Uint8Array> => linearizedCopy(c.build, (copy) => Promise.resolve(copy));
    const found: Record<string, unknown> = {};
    for (const c of M1_LINEARIZED_CASES) {
      const written = await rewrite(await own(c));
      expect(Buffer.from(written).toString('latin1'), c.id).not.toContain('/Linearized');
      found[c.id] = await drawnBreak(written, c.image, M1_QUOTES, [{ num: 4, gen: 0 }]);
    }
    expect(found).toEqual({
      l1: { code: 'rules', reason: 'page 1: pdf.js draws a shading of type 1' },
      l3: { code: 'withheld', reason: 'page 1: withheld text is in the glyphs pdf.js draws' },
      l4: { code: 'rules', reason: 'page 1: pdf.js draws an inline picture' },
    });
    const inCatalog = rawPdf([[1, '<< /Type /Catalog /Pages 2 0 R /Linearized 1 /O 9 /Extra << /Linearized 1 >> >>'], [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'], [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>']]);
    expect(await copyRulesBreak(inCatalog, 'show')).toBe('object 1: it holds /Linearized');
    const written = Buffer.from(await rewrite(inCatalog)).toString('latin1');
    expect(written).not.toContain('/Linearized');
    expect(written).toContain('/Extra');
  });

  it('refuses an axial or radial shading drawn from a sampled function, or from a list or stitching of functions with one in it, under "blur" and "hide", not "show"; a gradient of linear pieces passes (S1)', async () => {
    for (const image of ['blur', 'hide'] as const) {
      expect(await copyRulesBreak(S1_ROWS, image), image).toBe('object 3: a gradient is drawn from a sampled function');
      expect((await gateReply(job(S1_ROWS, image))).verdict, image).toEqual({ pass: false, code: 'rules' });
    }
    expect(await copyRulesBreak(S1_ROWS, 'show')).toBeNull();
    const sampled: RawObject = [7, rawStream('/FunctionType 0 /Domain [0 1] /Range [0 1 0 1 0 1] /Size [2] /BitsPerSample 8', Buffer.from([255, 0, 0, 0, 0, 255]))];
    const linear = '<< /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >>';
    const shading = (type: string, fn: string, extra: RawObject[] = []): Uint8Array =>
      onPage('q /Sh1 sh Q', '/Shading << /Sh1 6 0 R >>', [[6, `<< /ShadingType ${type} /ColorSpace /DeviceRGB /Coords ${type === '3' ? '[50 50 0 50 50 50]' : '[0 0 100 0]'} /Function ${fn} >>`], sampled, ...extra]);
    const refused: Array<[string, Uint8Array]> = [
      ['a radial one over a sampled function', shading('3', '7 0 R')],
      ['a list with a sampled function in it', shading('2', `[${linear} 7 0 R ${linear}]`)],
      ['a stitching with a sampled piece', shading('2', `<< /FunctionType 3 /Domain [0 1] /Functions [${linear} 7 0 R] /Bounds [0.5] /Encode [0 1 0 1] >>`)],
      ['a stitching within a stitching', shading('2', `<< /FunctionType 3 /Domain [0 1] /Functions [<< /FunctionType 3 /Domain [0 1] /Functions [7 0 R] /Bounds [] /Encode [0 1] >>] /Bounds [] /Encode [0 1] >>`)],
      ['its /ShadingType by reference', shading('10 0 R', '7 0 R', [[10, '2']])],
      ['the function\'s /FunctionType by reference', shading('2', '8 0 R', [[8, rawStream('/FunctionType 11 0 R /Domain [0 1] /Range [0 1 0 1 0 1] /Size [2] /BitsPerSample 8', Buffer.from([255, 0, 0, 0, 0, 255]))], [11, '0']])],
      ['in a shading pattern', onPage('/Pattern cs /P1 scn 0 0 100 100 re f', '/Pattern << /P1 << /PatternType 2 /Shading << /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 100 0] /Function 7 0 R >> >> >>', [sampled])],
    ];
    for (const [name, pdf] of refused) {
      for (const image of ['blur', 'hide'] as const) expect(await copyRulesBreak(pdf, image), `${name}, ${image}`).toMatch(/^object \d+: a gradient is drawn from a sampled function$/);
      expect(await copyRulesBreak(pdf, 'show'), name).toBeNull();
    }
    expect(await copyRulesBreak(shading('2', linear), 'hide')).toBeNull();
    expect(await copyRulesBreak(shading('3', `<< /FunctionType 3 /Domain [0 1] /Functions [${linear} ${linear}] /Bounds [0.5] /Encode [0 1 0 1] >>`), 'hide')).toBeNull();
    // The README's limit (a picture rebuilt from vector shapes): the same rows drawn from 4,095 linear pieces, no sample in them, pass.
    expect((await gateReply(job(S1_STITCHED_ROWS, 'hide'))).verdict).toEqual({ pass: true });
  });

  it('refuses forms, tiling patterns, Type 3 glyphs and soft masks nested more than 32 deep, or in a loop, under every policy, before pdf.js reads them (S3)', async () => {
    const deep = 'forms, patterns, Type 3 glyphs or soft masks nest more than 32 deep, or in a loop';
    const patterns = (depth: number): Uint8Array => {
      const cells: RawObject[] = [];
      for (let k = 0; k < depth; k++) {
        const next = k + 1 < depth;
        cells.push([k + 10, rawStream(`/PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10 /Resources << ${next ? `/Pattern << /P ${k + 11} 0 R >>` : ''} >>`, next ? '/Pattern cs /P scn 0 0 10 10 re f' : '0 0 10 10 re f')]);
      }
      return onPage('/Pattern cs /P scn 0 0 100 100 re f', '/Pattern << /P 10 0 R >>', cells);
    };
    for (const image of ['show', 'blur', 'hide'] as const) {
      expect(await copyRulesBreak(nestedForms(32), image), image).toBeNull();
      expect(await copyRulesBreak(nestedForms(33), image), image).toBe(deep);
      expect(await copyRulesBreak(nestedForms(2_000), image), image).toBe(deep);
      expect(await copyRulesBreak(patterns(32), image), image).toBeNull();
      expect(await copyRulesBreak(patterns(33), image), image).toBe(deep);
    }
    const loops: Array<[string, Uint8Array]> = [
      ['a form that draws itself', onPage('q /X Do Q', '/XObject << /X 10 0 R >>', [[10, rawStream('/Type /XObject /Subtype /Form /BBox [0 0 10 10] /Resources << /XObject << /X 10 0 R >> >>', 'q /X Do Q')]])],
      ['a Type 3 glyph drawn with its own font', onPage('BT /T3 12 Tf (A) Tj ET', '/Font << /T3 10 0 R >>', [[10, '<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << /g 11 0 R >> /Encoding << /Differences [65 /g] >> /FirstChar 65 /LastChar 65 /Widths [1000] /Resources << /Font << /T3 10 0 R >> >> >>'], [11, rawStream('', '1000 0 0 0 1000 1000 d1 BT /T3 12 Tf (A) Tj ET')]])],
      ['a soft mask whose group sets it again', onPage('/GS1 gs 0 0 10 10 re f', '/ExtGState << /GS1 10 0 R >>', [[10, '<< /SMask << /S /Luminosity /G 11 0 R >> >>'], [11, rawStream('/BBox [0 0 10 10] /Group << /S /Transparency >> /Resources << /ExtGState << /GS1 10 0 R >> >>', '/GS1 gs 0 0 10 10 re f')]])],
    ];
    for (const [name, pdf] of loops) expect(await copyRulesBreak(pdf, 'show'), name).toBe(deep);
    expect((await gateReply(job(nestedForms(2_000), 'hide'))).verdict).toEqual({ pass: false, code: 'rules' });
  });

  it('counts the depth of a form or pattern reached more than once by its deepest way in, reads each once (patterns 20 deep, each drawn twice), and follows a Type 3 font set through an ExtGState (S3)', async () => {
    const deep = 'forms, patterns, Type 3 glyphs or soft masks nest more than 32 deep, or in a loop';
    // Patterns 20 and 33 deep, each cell drawing the next under two names (2^20 ways in, read once each).
    const twice = (depth: number): Uint8Array => {
      const cells: RawObject[] = [];
      for (let k = 0; k < depth; k++) {
        const next = k + 1 < depth;
        cells.push([k + 10, rawStream(`/PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10 /Resources << ${next ? `/Pattern << /A ${k + 11} 0 R /B ${k + 11} 0 R >>` : ''} >>`, next ? '/Pattern cs /A scn 0 0 5 5 re f /B scn 5 5 5 5 re f' : '0 0 10 10 re f')]);
      }
      return onPage('/Pattern cs /P scn 0 0 100 100 re f', '/Pattern << /P 10 0 R >>', cells);
    };
    expect(await copyRulesBreak(twice(20), 'hide')).toBeNull();
    expect(await copyRulesBreak(twice(33), 'hide')).toBe(deep);
    // Form 10 heads a chain of 30, drawn first from the page, then again at the end of a chain of 5: 35 deep there.
    const chain: RawObject[] = [];
    for (let k = 0; k < 30; k++) chain.push([k + 10, rawStream(`/Type /XObject /Subtype /Form /BBox [0 0 10 10] /Resources << ${k < 29 ? `/XObject << /X ${k + 11} 0 R >>` : ''} >>`, k < 29 ? '/X Do' : '0 0 1 1 re f')]);
    for (let k = 0; k < 5; k++) chain.push([k + 50, rawStream(`/Type /XObject /Subtype /Form /BBox [0 0 10 10] /Resources << /XObject << /X ${k < 4 ? k + 51 : 10} 0 R >> >>`, '/X Do')]);
    expect(await copyRulesBreak(onPage('/F Do /A Do', '/XObject << /F 10 0 R /A 50 0 R >>', chain), 'show')).toBe(deep);
    expect(await copyRulesBreak(onPage('/F Do', '/XObject << /F 10 0 R /A 50 0 R >>', chain), 'show')).toBeNull();
    // A Type 3 font set by an ExtGState's /Font, its glyph setting it again.
    const viaState = onPage('BT /GS1 gs (A) Tj ET', '/ExtGState << /GS1 10 0 R >>', [
      [10, '<< /Type /ExtGState /Font [11 0 R 12] >>'],
      [11, '<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << /g 12 0 R >> /Encoding << /Differences [65 /g] >> /FirstChar 65 /LastChar 65 /Widths [1000] /Resources << /ExtGState << /GS1 10 0 R >> >> >>'],
      [12, rawStream('', '1000 0 0 0 1000 1000 d1 /GS1 gs (A) Tj')],
    ]);
    expect(await copyRulesBreak(viaState, 'show')).toBe(deep);
  });

  it('reads a soft mask\'s group as content under "blur" and "hide": an inline picture drawn in one is refused by the pdf-lib rules too (l4, defence in depth)', async () => {
    const inline = `q 64 0 0 64 0 0 cm BI /W 2 /H 2 /CS /G /BPC 8 /F /AHx ID 00ff00ff> EI Q`;
    for (const group of ['/BBox [0 0 612 792] /Group << /S /Transparency >>', '/Group << /S /Transparency >>']) {
      const pdf = onPage('q /GS1 gs 0 0 100 100 re f Q', `/ExtGState << /GS1 << /SMask << /S /Luminosity /G 6 0 R >> >> >>`, [[6, rawStream(group, inline)]]);
      for (const image of ['blur', 'hide'] as const) expect(await copyRulesBreak(pdf, image), `${group}, ${image}`).toBe(`an inline picture is in a content stream under the "${image}" policy`);
    }
  });
});

describe('fix round 6: refused by class under "blur" and "hide" (M-6, S1-6), and the nesting cap read as pdf.js reads (S3-6)', () => {
  const job = (pdf: Uint8Array, image: 'show' | 'blur' | 'hide') => ({ copy: pdf, original: M1_ORIGINAL, quotes: M1_QUOTES, image });
  const both = ['blur', 'hide'] as const;
  const LINEAR = '<< /FunctionType 2 /Domain [0 1] /C0 [1 1 1] /C1 [0.9 0.9 0.9] /N 1 >>';
  const AXIAL = (space = '/DeviceRGB', key = 'ColorSpace', fn = LINEAR): string => `<< /ShadingType 2 /${key} ${space} /Coords [72 0 272 0] /Function ${fn} >>`;
  const SAMPLED_ROW: RawObject = [40, rawStream('/FunctionType 0 /Domain [0 1] /Range [0 1 0 1 0 1] /Size [4] /BitsPerSample 8', Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9]))];
  const FORM = (content: string, resources = ''): Buffer => rawStream(`/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << ${resources} >>`, content);
  const TYPE3 = (proc: string, resources: string): RawObject[] => [
    [30, `<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << /g 31 0 R >> /Encoding << /Differences [65 /g] >> /FirstChar 65 /LastChar 65 /Widths [1000] /Resources << ${resources} >> >>`],
    [31, rawStream('', `1000 0 0 0 1000 1000 d1 ${proc}`)],
  ];
  const expectRefused = async (pdf: Uint8Array, reason: string | RegExp, name: string): Promise<void> => {
    for (const image of both) {
      const found = await copyRulesBreak(pdf, image);
      if (typeof reason === 'string') expect(found, `${name}, ${image}`).toBe(reason);
      else expect(found, `${name}, ${image}`).toEqual(expect.stringMatching(reason));
    }
    expect(await copyRulesBreak(pdf, 'show'), `${name}, show`).toBeNull();
  };

  it('refuses a shading of type 1 or 4 to 7 wherever it is (sh, a shading pattern, a form, a soft mask, a Type 3 glyph, or no use at all), under "blur" and "hide", not "show" (M-6)', async () => {
    const fnBased = '<< /ShadingType 1 /ColorSpace /DeviceRGB /Domain [0 1 0 1] /Function << /FunctionType 2 /Domain [0 1] /C0 [0 0 0] /C1 [1 1 1] /N 1 >> >>';
    for (const type of [4, 5, 6, 7] as const) {
      await expectRefused(onSplitPage(['q /M sh Q'], '/Shading << /M 20 0 R >>', [[20, meshShading(type)]]), `object 20: a shading of type ${type}`, `type ${type} by sh`);
    }
    const places: Array<[string, Uint8Array]> = [
      ['type 1 by sh', onSplitPage(['/M sh'], `/Shading << /M ${fnBased} >>`)],
      ['in a shading pattern', onSplitPage(['/Pattern cs /P scn 0 0 9 9 re f'], '/Pattern << /P << /PatternType 2 /Shading 20 0 R >> >>', [[20, meshShading(4)]])],
      ['in a form', onSplitPage(['/Fm1 Do'], '/XObject << /Fm1 21 0 R >>', [[21, FORM('/M sh', '/Shading << /M 20 0 R >>')], [20, meshShading(4)]])],
      ['in a soft mask\'s group', onSplitPage(['/GS1 gs 0 0 9 9 re f'], '/ExtGState << /GS1 << /SMask << /S /Luminosity /G 21 0 R >> >> >>', [[21, FORM('/M sh', '/Shading << /M 20 0 R >>')], [20, meshShading(6)]])],
      ['in a Type 3 glyph', onSplitPage(['BT /T 12 Tf (A) Tj ET'], '/Font << /T 30 0 R >>', [...TYPE3('/M sh', '/Shading << /M 20 0 R >>'), [20, meshShading(7)]])],
      ['drawn by no one', onSplitPage([''], '', [[20, meshShading(5)]])],
      ['a type by reference', onSplitPage(['/M sh'], '/Shading << /M << /ShadingType 22 0 R /ColorSpace /DeviceRGB /Function 23 0 R >> >>', [[22, '4'], [23, LINEAR]])],
      ['a type no reader agrees on (4.5)', onSplitPage(['/M sh'], '/Shading << /M << /ShadingType 4.5 /ColorSpace /DeviceRGB >> >>')],
    ];
    for (const [name, pdf] of places) await expectRefused(pdf, /^object \d+: a shading of type /, name);
    // w1m and w2m (r6): the mesh behind a second operand, and w2mc, the differential pdf.js draws; all by the shading.
    const mesh: RawObject = [20, meshShading(4)];
    const w1m = onSplitPage(['/Fm1 /Fm2 Do'], '/XObject << /Fm1 21 0 R /Fm2 22 0 R >>', [[21, FORM('/M sh', '/Shading << /M 20 0 R >>')], [22, FORM('BT /F1 10 Tf 72 380 Td (caption) Tj ET', '/Font << /F1 5 0 R >>')], mesh]);
    for (const [name, pdf] of [['w1m', w1m], ['w2m', onSplitPage(['/M /Sh2 sh'], `/Shading << /M 20 0 R /Sh2 ${AXIAL()} >>`, [mesh])], ['w2mc', onSplitPage(['/Sh2 /M sh'], `/Shading << /M 20 0 R /Sh2 ${AXIAL()} >>`, [mesh])]] as const) {
      await expectRefused(pdf, 'object 20: a shading of type 4', name);
      for (const image of both) expect((await gateReply(job(pdf, image))).verdict, `${name}, ${image}`).toEqual({ pass: false, code: 'rules' });
    }
    // Gradients (types 2 and 3) pass, as before.
    expect(await copyRulesBreak(onSplitPage(['/Sh2 sh'], `/Shading << /Sh2 ${AXIAL()} >>`), 'hide')).toBeNull();
  });

  it('refuses a content operator given more operands than it takes, an unknown one given any, operands no operator takes, and a number readers split otherwise, in every content stream, under "blur" and "hide", not "show" (M-6)', async () => {
    const res = `/XObject << /Fm1 21 0 R /Fm2 22 0 R >> /Shading << /Sh1 ${AXIAL()} /Sh2 ${AXIAL()} >> /ExtGState << /A << /CA 1 >> /B << /CA 0.5 >> >> /Pattern << /P1 23 0 R /P2 23 0 R >>`;
    const forms: RawObject[] = [[21, FORM('0 0 1 1 re f')], [22, FORM('0 0 1 1 re f')], [23, rawStream('/PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 9 9] /XStep 9 /YStep 9 /Resources << >>', '0 0 9 9 re f')]];
    const more = (op: string): RegExp => new RegExp(`^a content stream gives ${op.replace(/[*'"]/g, '\\$&')} more operands than it takes$`);
    const surplus: Array<[string, string, RegExp]> = [
      ['two forms', '/Fm1 /Fm2 Do', more('Do')],
      ['two shadings', '/Sh1 /Sh2 sh', more('sh')],
      ['two graphics states', '/A /B gs', more('gs')],
      ['a width too many', '1 2 w', more('w')],
      ['a font too many', '/F1 /F1 12 Tf', more('Tf')],
      ['seven for cm', '1 0 0 1 0 0 0 cm', more('cm')],
      ['null counted', '/Sh1 null sh', more('sh')],
      ['two pattern names', '/Pattern cs /P1 /P2 scn 0 0 9 9 re f', more('scn')],
      ['a pattern name not last', '/Pattern cs /P1 0.5 scn 0 0 9 9 re f', more('scn')],
      ['a name in sc', '0.5 /P1 sc', more('sc')],
      ['five for sc', '1 2 3 4 5 sc', more('sc')],
      ['34 for scn', `${Array(34).fill('0').join(' ')} scn`, more('scn')],
      ['operands q takes none of, pdf.js reading "qq" as q q', '/Sh1 qq', /^a content stream gives (q|the unknown operator qq) more operands than it takes$/],
      ['an unknown operator', '/Sh1 foo /Sh2 sh', /^a content stream gives (f|the unknown operator foo) more operands than it takes$/],
      ['a word MuPDF reads whole', '/Sh1 shq', /^a content stream gives the unknown operator shq more operands than it takes$/],
      ['a number pdf.js reads after an operator ("q1" as q 1, which Q is then given)', 'q1 Q', /^a content stream holds a number readers split otherwise \(q1\)$/],
      ['a word pdf.js reads as two operands ("truetrue" as true true, which w is then given)', 'truetrue w', more('w')],
    ];
    for (const [name, content, reason] of surplus) await expectRefused(onSplitPage([content], res, forms), reason, name);
    await expectRefused(onSplitPage(['q /Sh1'], res, forms), 'a content stream ends with operands no operator takes', 'trailing operands');
    await expectRefused(onSplitPage(['q /Sh1', 'sh Q'], res, forms), 'a content stream ends with operands no operator takes', 'an operand in one stream, its operator in the next');
    for (const word of ['1.5.3', '--1', '1-2', '.']) await expectRefused(onSplitPage([`${word} w`], res, forms), `a content stream holds a number readers split otherwise (${word})`, word);
    // In a form, a tiling pattern, a Type 3 glyph and a soft mask's group too.
    const inForm = onSplitPage(['/Fm1 Do'], '/XObject << /Fm1 21 0 R >>', [[21, FORM('/Sh1 /Sh2 sh', `/Shading << /Sh1 ${AXIAL()} /Sh2 ${AXIAL()} >>`)]]);
    const inPattern = onSplitPage(['/Pattern cs /P1 scn 0 0 9 9 re f'], '/Pattern << /P1 23 0 R >>', [[23, rawStream('/PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 9 9] /XStep 9 /YStep 9 /Resources << /ExtGState << /A << /CA 1 >> >> >>', '/A /A gs 0 0 9 9 re f')]]);
    const inGlyph = onSplitPage(['BT /T 12 Tf (A) Tj ET'], '/Font << /T 30 0 R >>', TYPE3('1 2 w', ''));
    const inMask = onSplitPage(['/GS1 gs 0 0 9 9 re f'], '/ExtGState << /GS1 << /SMask << /S /Luminosity /G 21 0 R >> >> >>', [[21, FORM('0 0 0 0 0 9 9 re f')]]);
    for (const [name, pdf, op] of [['a form', inForm, 'sh'], ['a tiling pattern', inPattern, 'gs'], ['a Type 3 glyph', inGlyph, 'w'], ['a soft mask', inMask, 're']] as const) await expectRefused(pdf, more(op), name);
    // What an honest copy writes passes, an unknown operator with no operands and one short of operands among it (h8).
    const honest = [
      'BT /F1 12 Tf 72 720 Td 14 TL (Picnic) Tj T* [(A) 120 (B)] TJ (a) \' 1 2 (b) " ET',
      'q 1 0 0 1 0 0 cm 0.2 0.3 0.5 RG 2 w [3 2] 0 d 72 728 m 540 728 l S Q /Sh1 sh /Fm1 Do /A gs',
      '/Pattern cs /P1 scn 0 0 9 9 re f 0.2 0.3 0.4 /P2 scn /Span << /MCID 0 >> BDC EMC /Tag BMC EMC /OC /L1 DP /M MP',
      'foo 1 0 0 cm 5 w 0.1 0.2 0.3 0.4 k 1 g 0.5 sc 0.1 0.2 0.3 0.4 SC % a comment /Sh1 /Sh2 sh',
    ];
    for (const content of honest) expect(await copyRulesBreak(onSplitPage([content], res, forms), 'hide'), content).toBeNull();
    expect(await copyRulesBreak(onSplitPage(['q 72 720', 'Td Q'], res, forms), 'hide')).toBe('a content stream ends with operands no operator takes');
    expect(await copyRulesBreak(onSplitPage(['q /Sh1 sh', 'Q'], res, forms), 'hide')).toBeNull();
  });

  it('refuses a gradient whose colour space reads a table or program of its own, a PostScript function anywhere, and transfer, black-generation and undercolour-removal functions, under "blur" and "hide", not "show"; the honest kinds pass (S1-6)', async () => {
    const space = 'a gradient is drawn in a colour space with a table or program of its own';
    const palette = (colours: number): string => `<${'ff0000'.repeat(colours)}>`;
    const gradient = (cs: string, extra: RawObject[] = [], key = 'ColorSpace', resources = ''): Uint8Array => onSplitPage(['/Sh sh'], `/Shading << /Sh 20 0 R >> ${resources}`, [[20, AXIAL(cs, key)], ...extra]);
    const refused: Array<[string, Uint8Array]> = [
      ['Separation, a sampled tint (s6sep)', gradient('[/Separation /Row /DeviceRGB 40 0 R]', [SAMPLED_ROW])],
      ['DeviceN, a sampled tint', gradient('[/DeviceN [/A] /DeviceRGB 40 0 R]', [SAMPLED_ROW])],
      ['Separation, a stitched tint', gradient(`[/Separation /Row /DeviceRGB << /FunctionType 3 /Domain [0 1] /Functions [${LINEAR}] /Bounds [] /Encode [0 1] >>]`)],
      ['DeviceN with attributes', gradient(`[/DeviceN [/A] /DeviceRGB ${LINEAR.replace('[1 1 1]', '[1]').replace('[0.9 0.9 0.9]', '[0]')} << /Colorants << >> >>]`)],
      ['Separation over a sampled Separation', gradient(`[/Separation /A [/Separation /Row /DeviceRGB 40 0 R] ${LINEAR}]`, [SAMPLED_ROW])],
      ['Indexed of 64 colours (s6idx)', gradient(`[/Indexed /DeviceRGB 63 ${palette(64)}]`)],
      ['Indexed of 5 colours', gradient(`[/Indexed /DeviceRGB 4 ${palette(5)}]`)],
      ['Indexed from a stream', gradient('[/Indexed /DeviceRGB 1 41 0 R]', [[41, rawStream('', Buffer.from([255, 0, 0, 0, 0, 255]))]])],
      ['Indexed over a sampled Separation', gradient(`[/Indexed [/Separation /Row /DeviceRGB 40 0 R] 1 <00ff>]`, [SAMPLED_ROW])],
      ['ICCBased, its /Alternate a palette', gradient('[/ICCBased 42 0 R]', [[42, rawStream(`/N 1 /Alternate [/Indexed /DeviceRGB 63 ${palette(64)}]`, 'icc')]])],
      ['a name the page\'s resources define', gradient('/CS0', [], 'ColorSpace', `/ColorSpace << /CS0 [/Indexed /DeviceRGB 63 ${palette(64)}] >>`)],
      ['/CS, as pdf.js also reads it', gradient(`[/Indexed /DeviceRGB 63 ${palette(64)}]`, [], 'CS')],
      ['Pattern', gradient('/Pattern')],
      ['by reference', gradient('43 0 R', [[43, `[/Indexed /DeviceRGB 63 ${palette(64)}]`]])],
      ['none given', onSplitPage(['/Sh sh'], '/Shading << /Sh 20 0 R >>', [[20, `<< /ShadingType 2 /Coords [72 0 272 0] /Function ${LINEAR} >>`]])],
    ];
    for (const [name, pdf] of refused) await expectRefused(pdf, `object 20: ${space}`, name);
    const passed: Array<[string, Uint8Array]> = [
      ['DeviceRGB', gradient('/DeviceRGB')],
      ['DeviceCMYK', gradient('/DeviceCMYK')],
      ['CalRGB', gradient('[/CalRGB << /WhitePoint [0.95 1 1.09] >>]')],
      ['ICCBased', gradient('[/ICCBased 42 0 R]', [[42, rawStream('/N 3 /Alternate /DeviceRGB', 'icc')]])],
      ['a spot colour, a type 2 tint (h3)', gradient(`[/Separation /PMS286 /DeviceCMYK << /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [1 0.66 0 0.02] /N 1 >>]`)],
      ['Indexed of 4 colours', gradient(`[/Indexed /DeviceRGB 3 ${palette(4)}]`)],
      // A flat fill in a spot colour with a sampled tint (h6): one colour per fill, no gradient.
      ['a sampled tint on a flat fill (h6)', onSplitPage(['/Spot cs 1 scn 72 300 468 20 re f'], '/ColorSpace << /Spot [/Separation /PMS286 /DeviceRGB 40 0 R] >>', [SAMPLED_ROW])],
    ];
    for (const [name, pdf] of passed) for (const image of both) expect(await copyRulesBreak(pdf, image), `${name}, ${image}`).toBeNull();
    // A PostScript (type 4) function anywhere: a gradient's, a flat fill's tint, one no one uses; and a type no reader agrees on.
    const PS = rawStream('/FunctionType 4 /Domain [0 1] /Range [0 1 0 1 0 1]', '{ dup dup }');
    const functions: Array<[string, Uint8Array, number]> = [
      ['a gradient\'s (s6ps)', onSplitPage(['/Sh sh'], '/Shading << /Sh << /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 9 0] /Function 44 0 R >> >>', [[44, PS]]), 44],
      ['a flat fill\'s tint', onSplitPage(['/Spot cs 1 scn 0 0 9 9 re f'], '/ColorSpace << /Spot [/Separation /A /DeviceRGB 44 0 R] >>', [[44, PS]]), 44],
      ['no one\'s', onSplitPage([''], '', [[44, PS]]), 44],
      ['FunctionType 4 by reference', onSplitPage([''], '', [[44, '<< /FunctionType 45 0 R /Domain [0 1] >>'], [45, '4']]), 44],
      ['FunctionType 2.5', onSplitPage([''], '', [[44, '<< /FunctionType 2.5 /Domain [0 1] /C0 [0] /C1 [1] /N 1 >>']]), 44],
    ];
    for (const [name, pdf, object] of functions) await expectRefused(pdf, new RegExp(`^object ${object}: a function of type (4|2\\.5)$`), name);
    // Transfer, black-generation and undercolour-removal functions, in a graphics state or a soft mask (s6trg, s6trm).
    const transfer = (dict: string, extra: RawObject[] = []): Uint8Array => onSplitPage(['/T gs 0 0 9 9 re f'], `/ExtGState << /T 46 0 R >>`, [[46, dict], ...extra]);
    for (const key of ['TR', 'TR2', 'BG', 'BG2', 'UCR', 'UCR2']) {
      await expectRefused(transfer(`<< /${key} 40 0 R >>`, [SAMPLED_ROW]), `object 46: a transfer, black-generation or undercolour-removal function (/${key})`, key);
    }
    await expectRefused(transfer('<< /TR [40 0 R 40 0 R 40 0 R 40 0 R] >>', [SAMPLED_ROW]), 'object 46: a transfer, black-generation or undercolour-removal function (/TR)', 'four transfer functions');
    await expectRefused(transfer('<< /SMask << /S /Luminosity /G 47 0 R /TR 40 0 R >> >>', [SAMPLED_ROW, [47, FORM('0 0 9 9 re f')]]), 'object 46: a transfer, black-generation or undercolour-removal function (/TR)', 'a soft mask\'s (s6trm)');
    await expectRefused(transfer('<< /TR /Inverse >>'), 'object 46: a transfer, black-generation or undercolour-removal function (/TR)', 'a name other than /Identity or /Default');
    for (const image of both) expect(await copyRulesBreak(transfer('<< /TR /Identity /TR2 /Default /BG2 /Default /UCR2 /Default /SA false >>'), image), image).toBeNull();
    // Through gateReply too.
    for (const image of both) expect((await gateReply(job(refused[0]![1], image))).verdict, image).toEqual({ pass: false, code: 'rules' });
  });

  it('reads the names a page draws over its /Contents joined, as pdf.js joins them, and a tiling pattern\'s in its own resources, then its parent\'s, under every policy (S3-6: n1s, n1h, n2s, n2h, n1d)', async () => {
    const deep = 'forms, patterns, Type 3 glyphs or soft masks nest more than 32 deep, or in a loop';
    // n1s: forms 40 deep behind a page edge split across two streams ("q /F" and "m0 Do Q").
    const split = onSplitPage(['q /F', 'm0 Do Q\n'], '/XObject << /Fm0 20 0 R >>', formChain(40, 20));
    // n2s: a tiling pattern with /Resources of its own but no /XObject draws /Fm0, the page's: 40 forms deep.
    const merged = onSplitPage(['/Pattern cs /P scn 0 0 100 100 re f'], '/XObject << /Fm0 20 0 R >> /Pattern << /P 19 0 R >>', [[19, rawStream('/PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 9 9] /XStep 9 /YStep 9 /Resources << /ExtGState << >> >>', '/Fm0 Do')], ...formChain(40, 20)]);
    // n1d: patterns 34 deep, each drawing the next twice, behind a split edge: refused at once, not after 2^34 reads.
    const cells: RawObject[] = [];
    for (let k = 0; k < 34; k++) {
      const next = k + 1 < 34;
      cells.push([k + 20, rawStream(`/PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10 /Resources << ${next ? `/Pattern << /A ${k + 21} 0 R /B ${k + 21} 0 R >>` : ''} >>`, next ? '/Pattern cs /A scn 0 0 5 5 re f /B scn 5 5 5 5 re f' : '0 0 10 10 re f')]);
    }
    const fanned = onSplitPage(['q /Pattern cs /P', '0 scn 72 400 200 200 re f Q\n'], '/Pattern << /P0 20 0 R >>', cells);
    for (const image of ['show', 'blur', 'hide'] as const) {
      for (const [name, pdf] of [['split', split], ['merged', merged]] as const) expect(await copyRulesBreak(pdf, image), `${name}, ${image}`).toBe(deep);
      const t0 = Date.now();
      expect(await copyRulesBreak(fanned, image), `fanned, ${image}`).toBe(deep);
      expect(Date.now() - t0, `fanned, ${image}`).toBeLessThan(10_000);
    }
    expect((await gateReply(job(split, 'show'))).verdict).toEqual({ pass: false, code: 'rules' });
    // Controls: 32 deep behind the same split, and a pattern whose own /XObject holds the name, pass under "show".
    expect(await copyRulesBreak(onSplitPage(['q /F', 'm0 Do Q\n'], '/XObject << /Fm0 20 0 R >>', formChain(32, 20)), 'show')).toBeNull();
    expect(await copyRulesBreak(onSplitPage(['/Pattern cs /P scn 0 0 100 100 re f'], '/XObject << /Fm0 20 0 R >> /Pattern << /P 19 0 R >>', [[19, rawStream('/PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 9 9] /XStep 9 /YStep 9 /Resources << /XObject << /Fm0 60 0 R >> >>', '/Fm0 Do')], [60, FORM('0 0 1 1 re f')], ...formChain(40, 20)]), 'show')).toBeNull();
  });

  it('follows a name only into the kinds its drawer\'s content can draw (Do, scn or SCN, Tf, gs), so a name reused across kinds is no loop (n5b: a form, pattern, Type 3 glyph and soft mask chain, every name /X), while a pattern drawing itself through its parent\'s resources is one (S3-6)', async () => {
    const deep = 'forms, patterns, Type 3 glyphs or soft masks nest more than 32 deep, or in a loop';
    const chain = (depth: number): Uint8Array => {
      const objects: RawObject[] = [];
      for (let i = 0; i < depth; i++) {
        const next = i + 1 < depth;
        const to = `${21 + i} 0 R`;
        const kind = i % 4;
        if (kind === 0) objects.push([20 + i, FORM(next ? '/Pattern cs /X scn 0 0 1 1 re f' : '0 0 1 1 re f', next ? `/Pattern << /X ${to} >>` : '')]);
        if (kind === 1) objects.push([20 + i, rawStream(`/PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 1 1] /XStep 1 /YStep 1 /Resources << ${next ? `/Font << /X ${to} >>` : ''} >>`, next ? 'BT /X 1 Tf (a) Tj ET' : '0 0 1 1 re f')]);
        if (kind === 2) {
          objects.push([20 + i, `<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1 1] /FontMatrix [1 0 0 1 0 0] /CharProcs << /a ${1_000 + i} 0 R >> /Encoding << /Differences [97 /a] >> /FirstChar 97 /LastChar 97 /Widths [1] /Resources << ${next ? `/ExtGState << /X << /SMask << /S /Luminosity /G ${to} >> >> >>` : ''} >> >>`]);
          objects.push([1_000 + i, rawStream('', next ? '1 0 d0 /X gs 0 0 1 1 re f' : '1 0 d0 0 0 1 1 re f')]);
        }
        if (kind === 3) objects.push([20 + i, rawStream(`/Type /XObject /Subtype /Form /BBox [0 0 1 1] /Group << /S /Transparency /CS /DeviceGray >> /Resources << ${next ? `/XObject << /X ${to} >>` : ''} >>`, next ? '/X Do' : '0 0 1 1 re f')]);
      }
      return onSplitPage(['/Fm0 Do'], '/XObject << /Fm0 20 0 R >>', objects);
    };
    // The chain's patterns show text with their Type 3 font, which is refused since GLYPHMAP fix round 2 (B1), but
    // only once the walk has read it all without finding it too deep or a loop: 33 deep is still named as too deep.
    const tiled = 'a tiling pattern shows text, or draws content that cannot be read';
    for (const image of ['show', 'hide'] as const) expect(await copyRulesBreak(chain(30), image), `30 deep, ${image}`).toBe(tiled);
    expect(await copyRulesBreak(chain(32), 'show')).toBe(tiled);
    expect(await copyRulesBreak(chain(33), 'show')).toBe(deep);
    const drawsItself = onSplitPage(['/Fm0 Do'], '/XObject << /Fm0 20 0 R >>', [
      [20, FORM('/Pattern cs /X scn 0 0 1 1 re f', '/Pattern << /X 21 0 R >>')],
      [21, rawStream('/PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 1 1] /XStep 1 /YStep 1 /Resources << /Font << /F1 5 0 R >> >>', '/Pattern cs /X scn 0 0 1 1 re f')],
    ]);
    expect(await copyRulesBreak(drawsItself, 'show')).toBe(deep);
    // Patterns stroked with SCN count as those filled with scn: 33 deep is refused, 32 passes.
    const stroked = (depth: number): Uint8Array =>
      onSplitPage(['/Pattern CS /P0 SCN 0 0 9 9 re S'], '/Pattern << /P0 20 0 R >>', Array.from({ length: depth }, (_, k): RawObject => [20 + k, rawStream(`/PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 9 9] /XStep 9 /YStep 9 /Resources << ${k + 1 < depth ? `/Pattern << /P0 ${21 + k} 0 R >>` : ''} >>`, k + 1 < depth ? '/Pattern CS /P0 SCN 0 0 9 9 re S' : '0 0 9 9 re f')]));
    expect(await copyRulesBreak(stroked(33), 'show')).toBe(deep);
    expect(await copyRulesBreak(stroked(32), 'show')).toBeNull();
  });

  it('passes the real engine\'s copy of each honest original (h1 to h4, h6 to h9) under "show", "blur" and "hide", with and without a withheld quote (round 6, no false refusal)', async () => {
    for (const [id, build] of HONEST_ORIGINALS) {
      const original = build();
      for (const image of ['show', 'blur', 'hide'] as const) {
        for (const quotes of [[], HONEST_QUOTES]) {
          const made = await redactPdf(original, { quotes, redactsAny: true, image });
          expect(made.kind, `${id}, ${image}, ${quotes.length}`).toBe('redacted');
          if (made.kind !== 'redacted') continue;
          expect((await gateReply({ copy: made.pdf, original, quotes, image })).verdict, `${id}, ${image}, ${quotes.length}`).toEqual({ pass: true });
        }
      }
    }
  }, 240_000);

  it('reads #xx in a name as a reader does (C6e: forms 40 deep named /X#30 for /X0), and reads a form reached many ways once (C6d: forms 30 deep, each drawing the next as /A and /B, answered at once) (S3-6)', async () => {
    const deep = 'forms, patterns, Type 3 glyphs or soft masks nest more than 32 deep, or in a loop';
    const escaped = onSplitPage(['q /Fm#30 Do Q'], '/XObject << /Fm0 20 0 R >>', formChain(40, 20, { name: 'X0', written: 'X#30' }));
    for (const image of ['show', 'hide'] as const) expect(await copyRulesBreak(escaped, image), image).toBe(deep);
    const fan: RawObject[] = [];
    for (let k = 0; k < 30; k++) {
      const next = k + 1 < 30;
      fan.push([k + 20, rawStream(`/Type /XObject /Subtype /Form /BBox [0 0 1 1] /Resources << ${next ? `/XObject << /A ${k + 21} 0 R /B ${k + 21} 0 R >>` : ''} >>`, next ? '/A Do /B Do' : '0 0 1 1 re f')]);
    }
    const t0 = Date.now();
    expect(await copyRulesBreak(onSplitPage(['/Fm0 Do'], '/XObject << /Fm0 20 0 R >>', fan), 'show')).toBeNull();
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('refuses drawers reached in more than 100,000 ways, each with resources of its own (patterns with a /Font each, all drawing forms 30 deep they find in the page\'s /XObject), and passes 100 such patterns (S3-6)', async () => {
    const forms: RawObject[] = Array.from({ length: 30 }, (_, k): RawObject => [20 + k, rawStream('/Type /XObject /Subtype /Form /BBox [0 0 1 1]', k + 1 < 30 ? `/X${k + 1} Do` : '0 0 1 1 re f')]);
    const xobjects = `/XObject << ${forms.map(([n], k) => `/X${k} ${n} 0 R`).join(' ')} >>`;
    const fanned = (count: number): Uint8Array => {
      const patterns: RawObject[] = Array.from({ length: count }, (_, i): RawObject => [1_000 + i, rawStream(`/PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 1 1] /XStep 1 /YStep 1 /Resources << /Font << /F 5 0 R >> >>`, '/X0 Do')]);
      return onSplitPage([patterns.map((_, i) => `/Pattern cs /P${i} scn 0 0 1 1 re f`).join('\n')], `${xobjects} /Pattern << ${patterns.map(([n], i) => `/P${i} ${n} 0 R`).join(' ')} >>`, [...forms, ...patterns]);
    };
    const t0 = Date.now();
    expect(await copyRulesBreak(fanned(3_300), 'show')).toBe('forms, patterns, Type 3 glyphs or soft masks are drawn in more than 100000 ways');
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(await copyRulesBreak(fanned(100), 'show')).toBeNull();
  }, 60_000);
});

describe('fix round 6b (REDACT-LOOK L10/N8): the glyphs pdf.js draws are matched under "show" too, for the quotes alone', () => {
  const quote = 'Kestrel Ambry';

  it('refuses, under every policy, a copy whose glyphs draw a withheld quote its /ToUnicode hides from the text layer (the challenger\'s ship-order-0022 test)', async () => {
    const copy = lyingToUnicode(quote);
    expect(await checkCopy(copy, [quote])).toBeNull();
    const verdicts: Record<string, unknown> = {};
    for (const image of ['hide', 'blur', 'show'] as const) verdicts[image] = await gateVerdict({ copy, original: copy, quotes: [quote], image });
    expect(verdicts).toEqual({ hide: { pass: false, code: 'withheld' }, blur: { pass: false, code: 'withheld' }, show: { pass: false, code: 'withheld' } });
    expect((await gateReply({ copy, original: copy, quotes: [quote], image: 'show' })).verdict).toEqual({ pass: false, code: 'withheld' });
  });

  it('leaves "show" with no quotes as it was: pdf.js does not walk the copy (a Type 3 glyph it cannot read passes), and the bytes given are the gate\'s writing', async () => {
    const unreadGlyph = onSplitPage(['BT /T3 12 Tf 72 400 Td (A) Tj ET'], '/Font << /F1 5 0 R /T3 30 0 R >>', [[30, '<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << /g 31 0 R >> /Encoding << /Differences [65 /g] >> /FirstChar 65 /LastChar 65 /Widths [1000] /Resources << >> >>'], [31, rawStream('', '')]]);
    expect(await gateVerdict({ copy: unreadGlyph, original: unreadGlyph, quotes: [], image: 'show' })).toEqual({ pass: true });
    expect(await gateVerdict({ copy: unreadGlyph, original: unreadGlyph, quotes: [quote], image: 'show' })).toEqual({ pass: false, code: 'rules' });
    // Under "blur" and "hide" the walk runs with or without quotes, as before.
    for (const image of ['blur', 'hide'] as const) expect(await gateVerdict({ copy: unreadGlyph, original: unreadGlyph, quotes: [], image }), image).toEqual({ pass: false, code: 'rules' });
    const copy = lyingToUnicode(quote);
    const reply = await gateReply({ copy, original: copy, quotes: [], image: 'show' });
    expect(reply.verdict).toEqual({ pass: true });
    expect(Buffer.from(reply.checked?.pdf ?? []).equals(Buffer.from(await rewrite(copy)))).toBe(true);
  });
});

describe('GLYPHMAP fix round 2 (B1): a tiling pattern that shows text is refused under every policy', () => {
  // PDFium reads no text inside a tiling pattern, so neither the engine nor the glyph-name reading sees what one shows.
  const TILED = 'a tiling pattern shows text, or draws content that cannot be read';
  const policies = ['show', 'blur', 'hide'] as const;
  const tile = (content: string, resources = '/Font << /F1 5 0 R >>'): Buffer => rawStream(`/PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 100 100] /XStep 100 /YStep 100${resources === '' ? '' : ` /Resources << ${resources} >>`}`, content);
  const form = (content: string, resources = '/Font << /F1 5 0 R >>'): Buffer => rawStream(`/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Resources << ${resources} >>`, content);
  const FILLED = '/Pattern cs /P scn 72 400 200 200 re f';
  const filled = (extra: RawObject[], resources = '/Pattern << /P 20 0 R >>', content = FILLED): Uint8Array => onSplitPage([content], resources, extra);
  const SHOWN = 'BT /F1 12 Tf 0 10 Td (Ab) Tj ET';

  it("refuses a pattern that shows text with Tj, TJ, ' or \", filled or stroked, held in the page's resources or reached from a form, or drawn by no page, and one whose content cannot be read", async () => {
    const copies: Array<[string, Uint8Array]> = [
      ['Tj', filled([[20, tile(SHOWN)]])],
      ['TJ', filled([[20, tile('BT /F1 12 Tf 0 10 Td [(A) 120 (b)] TJ ET')]])],
      ["'", filled([[20, tile("BT /F1 12 Tf 14 TL (Ab) ' ET")]])],
      ['"', filled([[20, tile('BT /F1 12 Tf 1 2 (Ab) " ET')]])],
      ['stroked with SCN', filled([[20, tile(SHOWN)]], '/Pattern << /P 20 0 R >>', '/Pattern CS /P SCN 72 400 200 200 re S')],
      ['reached from a form', filled([[21, form(FILLED, '/Pattern << /P 20 0 R >>')], [20, tile(SHOWN)]], '/XObject << /Fm 21 0 R >>', '/Fm Do')],
      ['drawn by no page', onSplitPage(['0 0 1 1 re f'], '', [[20, tile(SHOWN)]])],
      ['content that cannot be read (a Flate stream that is not one), drawn by no page', onSplitPage(['0 0 1 1 re f'], '', [[20, rawStream('/PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 100 100] /XStep 100 /YStep 100 /Filter /FlateDecode', 'BT (Ab) Tj ET')]])],
    ];
    for (const [name, pdf] of copies) for (const image of policies) expect(await copyRulesBreak(pdf, image), `${name}, ${image}`).toBe(TILED);
  });

  it('refuses a pattern that shows text through what it draws: a form, a pattern, a soft mask\'s group, a form found in its parent\'s resources, a form whose content cannot be read', async () => {
    const copies: Array<[string, Uint8Array]> = [
      ['a form', filled([[20, tile('/Fm Do', '/XObject << /Fm 21 0 R >>')], [21, form(SHOWN)]])],
      ['a pattern drawing a form', filled([[20, tile('/Pattern cs /Q scn 0 0 10 10 re f', '/Pattern << /Q 21 0 R >>')], [21, tile('/Fm Do', '/XObject << /Fm 22 0 R >>')], [22, form(SHOWN)]])],
      ['a soft mask\'s group', filled([[20, tile('/GS1 gs 0 0 10 10 re f', '/ExtGState << /GS1 << /SMask << /S /Luminosity /G 21 0 R >> >> >>')], [21, rawStream('/BBox [0 0 10 10] /Group << /S /Transparency >> /Resources << /Font << /F1 5 0 R >> >>', SHOWN)]])],
      ['a form in its parent\'s resources (no /Resources of its own)', filled([[20, tile('/Fm Do', '')], [21, form(SHOWN)]], '/Pattern << /P 20 0 R >> /XObject << /Fm 21 0 R >>')],
      ['a form whose content cannot be read', filled([[20, tile('/Fm Do', '/XObject << /Fm 21 0 R >>')], [21, rawStream('/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Filter /FlateDecode', 'BT (Ab) Tj ET')]])],
    ];
    for (const [name, pdf] of copies) for (const image of policies) expect(await copyRulesBreak(pdf, image), `${name}, ${image}`).toBe(TILED);
  });

  it('passes a pattern that draws no text, though "Tj" and "\'" are in its names and comments; a form that shows text outside any pattern; and a page\'s own text', async () => {
    const copies: Array<[string, Uint8Array]> = [
      ['paths only', filled([[20, tile('0 0 0 rg 0 0 10 10 re f')]])],
      ['"Tj" in a name and a comment', filled([[20, tile("% (Ab) Tj ' \"\n/Tj0 gs 0 0 10 10 re f", '/ExtGState << /Tj0 << /CA 1 >> >>')]])],
      ['a form drawing paths', filled([[20, tile('/Fm Do', '/XObject << /Fm 21 0 R >>')], [21, form('0 0 10 10 re f')]])],
      ['text in a form on the page', onSplitPage(['/Fm Do'], '/XObject << /Fm 21 0 R >>', [[21, form(SHOWN)]])],
      ['the page\'s own text', onSplitPage(['BT /F1 12 Tf 72 700 Td (Ab) Tj ET'])],
    ];
    for (const [name, pdf] of copies) for (const image of policies) expect(await copyRulesBreak(pdf, image), `${name}, ${image}`).toBeNull();
  });

  it('refuses it as "rules" in the verdict, with or without quotes (the engine\'s refusal: test/pdf/glyph-names.test.ts); a copy nested past the cap is named so first', async () => {
    const pdf = filled([[20, tile(SHOWN)]]);
    for (const image of policies) {
      for (const quotes of [M1_QUOTES, []]) expect(await gateVerdict({ copy: pdf, original: pdf, quotes, image }), `${image}, ${quotes.length}`).toEqual({ pass: false, code: 'rules' });
    }
    expect((await gateReply({ copy: pdf, original: pdf, quotes: [], image: 'show' })).verdict).toEqual({ pass: false, code: 'rules' });
    // Nesting past the cap is still named first.
    const deep = filled([[20, tile('/Fm Do', '/XObject << /Fm 21 0 R >>')], ...formChain(40, 21, { last: SHOWN, resources: '/Font << /F1 5 0 R >>' })]);
    expect(await copyRulesBreak(deep, 'show')).toBe('forms, patterns, Type 3 glyphs or soft masks nest more than 32 deep, or in a loop');
  });
});
