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
