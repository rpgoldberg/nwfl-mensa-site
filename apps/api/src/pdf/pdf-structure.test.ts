// The gate's structure check (UNTRUSTED-PDF-GATE M1, fix round 3): a copy whose bytes pdf-lib and a
// viewer could read differently is refused before any rule is read. The engine's sanitizer writes
// one xref table, one definition per object and no object streams (sanitize.ts), so anything else
// is a subverted engine's. Fixtures: test/pdf/shadows.ts.
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { linesPdf } from '../../test/pdf/fixtures.js';
import { M1_CASES, plainCopy, rawPdf, rawStream } from '../../test/pdf/shadows.js';
import { structureBreak } from './pdf-structure.js';
import { redactPdf } from './redact.js';

/** The bytes with `needle` replaced, every xref offset and startxref at or after it moved: the one xref table still lands on each object. */
function spliced(bytes: Uint8Array, needle: string, replacement: string): Uint8Array {
  const text = Buffer.from(bytes).toString('latin1');
  const at = text.indexOf(needle);
  const by = replacement.length - needle.length;
  const moved = (offset: string): string => (Number(offset) >= at ? String(Number(offset) + by).padStart(offset.length, '0') : offset);
  const out = (text.slice(0, at) + replacement + text.slice(at + needle.length))
    .replace(/^(\d{10}) 00000 n $/gm, (_, offset: string) => `${moved(offset)} 00000 n `)
    .replace(/startxref\n(\d+)/, (_, offset: string) => `startxref\n${moved(offset)}`);
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

const ONE_PAGE: Parameters<typeof rawPdf>[0] = [
  [1, '<< /Type /Catalog /Pages 2 0 R >>'],
  [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
  [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>'],
  [4, rawStream('', 'BT /F1 12 Tf 72 720 Td (Picnic flyer) Tj ET\n')],
  [5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],
];

describe('structureBreak', () => {
  it('passes what the sanitizer writes: one xref table, one definition per object, no object streams', async () => {
    expect(await structureBreak(plainCopy())).toBeNull();
    expect(await structureBreak(rawPdf(ONE_PAGE))).toBeNull();
    expect(await structureBreak(await linesPdf(['Picnic flyer', 'Rides: ask at the desk.']))).toBeNull();
    const made = await redactPdf(await linesPdf(['Picnic flyer', 'Rides: call Kestrel Ambry.']), { quotes: ['Kestrel Ambry'], redactsAny: true, image: 'blur' });
    expect(made.kind).toBe('redacted');
    expect(await structureBreak((made as { pdf: Uint8Array }).pdf)).toBeNull();
  });

  it('refuses an object defined twice (a shadow), wherever the xref points', async () => {
    expect(await structureBreak(rawPdf([...ONE_PAGE, [5, '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>']]))).toBe('object 5 is defined more than once');
    for (const shadowed of M1_CASES.filter((c) => !['b', 'b2', 'c', 'c2', 'e', 'f'].includes(c.id))) {
      expect(await structureBreak(shadowed.attack), shadowed.id).toMatch(/^object \d+ is defined more than once$/);
      expect(await structureBreak(shadowed.control), `${shadowed.id}, control`).toBeNull();
    }
  });

  it('refuses a second xref section, a /Prev, and an xref entry that does not land on its object', async () => {
    expect(await structureBreak(rawPdf(ONE_PAGE, { update: [5, '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>'] }))).toBe('it has more than one xref section');
    expect(await structureBreak(rawPdf(ONE_PAGE, { prev: true }))).toBe('its trailer has more than /Size and /Root');
    expect(await structureBreak(rawPdf(ONE_PAGE, { shift: { object: 4, by: 3 } }))).toBe('the xref entry for object 4 does not land on it');
    expect(await structureBreak(rawPdf(ONE_PAGE, { omit: 5 }))).toBe('object 5 is not in the xref');
  });

  it('refuses a trailer between the objects, whose /Info, /Encrypt or /ID pdf-lib keeps and a viewer never reads', async () => {
    const between = (trailer: string): Uint8Array => spliced(rawPdf(ONE_PAGE), '4 0 obj', `${trailer}4 0 obj`);
    expect(await structureBreak(between('\n'))).toBeNull();
    for (const key of ['/Info 5 0 R', '/Encrypt 5 0 R', '/ID [<00> <00>]']) {
      expect(await structureBreak(between(`trailer\n<< ${key} >>\n`)), key).toBe('pdf-lib takes another trailer');
    }
  });

  it('refuses an object only pdf-lib reads (its header split by a comment), even when the count matches one only a viewer reads (in stream data, which the xref names)', async () => {
    const hidden = '7 0 obj\n<< /S /JavaScript /JS (app.alert(1)) >>\nendobj\n';
    const made = rawPdf([...ONE_PAGE, [6, '<< /S /JavaScript /JS (app.alert(2)) >>'], [8, rawStream('', `pad\n${hidden}`)]], { omit: 6 });
    const text = Buffer.from(made).toString('latin1');
    const listed = text.replace(/(xref\n0 9\n(?:.{19}\n){7})0000000000 65535 f \n/, (_, head: string) => `${head}${String(text.indexOf(hidden)).padStart(10, '0')} 00000 n \n`);
    const both = spliced(new Uint8Array(Buffer.from(listed, 'latin1')), '6 0 obj', '6 %\n0 obj');
    expect(await structureBreak(both)).toBe('object 6 is not defined at the top level');
    // Each alone: only pdf-lib's object 6, or only the viewer's object 7 (and 6 plainly, which the xref omits).
    expect(await structureBreak(spliced(rawPdf([...ONE_PAGE, [6, '<< /S /JavaScript /JS (app.alert(2)) >>']], { omit: 6 }), '6 0 obj', '6 %\n0 obj'))).toBe('object 6 is not defined at the top level');
    const viewers = rawPdf([...ONE_PAGE, [8, rawStream('', `pad\n${hidden}`)]]);
    const shown = Buffer.from(viewers).toString('latin1');
    const named = shown.replace(/(xref\n0 9\n(?:.{19}\n){7})0000000000 65535 f \n/, (_, head: string) => `${head}${String(shown.indexOf(hidden)).padStart(10, '0')} 00000 n \n`);
    expect(await structureBreak(new Uint8Array(Buffer.from(named, 'latin1')))).toBe('pdf-lib does not read every definition');
    expect(await structureBreak(new Uint8Array(Buffer.from(listed, 'latin1')))).toBe('object 6 is not in the xref');
  });

  it('refuses object streams and xref streams, which the sanitizer never writes, and bytes it cannot read', async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.addPage([612, 792]).drawText('Picnic flyer', { x: 72, y: 720, size: 12, font: await doc.embedFont(StandardFonts.Helvetica) });
    expect(await structureBreak(await doc.save())).toBe('it has no xref table where startxref points');
    // Object 6 lives only in an object stream, which a classic xref table cannot name.
    const packed = rawPdf([...ONE_PAGE, [7, rawStream('/Type /ObjStm /N 1 /First 4', '6 0 << /S /JavaScript /JS (x) >>')]]);
    expect(await structureBreak(packed)).toBe('it has an object stream or an xref stream');
    expect(await structureBreak(Uint8Array.from([1, 2, 3]))).toBe('it has no xref table where startxref points');
    const text = Buffer.from(rawPdf(ONE_PAGE)).toString('latin1');
    const broken = text.replace(/startxref\n\d+/, 'startxref\n12');
    expect(await structureBreak(new Uint8Array(Buffer.from(broken, 'latin1')))).toBe('it has no xref table where startxref points');
    expect(await structureBreak(new Uint8Array(Buffer.from(text.replace('xref\n0 6', 'xref\n0 x'), 'latin1')))).toBe('its xref table cannot be read');
  });
});
