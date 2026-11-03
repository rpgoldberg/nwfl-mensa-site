// The gate's own checks on a copy (UNTRUSTED-PDF-GATE S3), run in the gate's child: the sanitizer's
// invariants (no active content, no attached files, no forms) and the picture policy's output shape,
// read from the copy alone. The engine's copies must pass them; a subverted engine's must not.
// Every name is made up.
import { deflateSync } from 'node:zlib';
import { type PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFString, StandardFonts } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { leakFixture, linesPdf, pictureUnderTextFixture, twoMarksFixture } from '../../test/pdf/fixtures.js';
import { M1_CASES, M1_ORIGINAL, M1_QUOTES, plainCopy } from '../../test/pdf/shadows.js';
import { sha256Hex } from './engine-protocol.js';
import { copyRulesBreak, gateReply, gateVerdict } from './gate-rules.js';
import { BLUR_MAX, FILL_GRAY } from './images.js';
import { structureBreak } from './pdf-structure.js';
import { redactPdf } from './redact.js';

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
