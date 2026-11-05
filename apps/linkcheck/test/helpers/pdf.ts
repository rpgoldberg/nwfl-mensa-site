// Synthetic PDFs, written by hand: no real issue, no real person. Each page has a MediaBox, text
// drawn in Helvetica (a standard font, so nothing is embedded) and annotations given as raw
// dictionary bodies, so a test can write any annotation a hostile file could hold.
export interface Text {
  x: number;
  y: number;
  size?: number;
  str: string;
}

export interface Page {
  box?: [number, number, number, number];
  crop?: [number, number, number, number];
  text?: Text[];
  /** Raw annotation dictionaries, e.g. `<< /Type /Annot /Subtype /Link ... >>`. */
  annots?: string[];
}

const escape = (s: string): string => s.replace(/[\\()]/g, (c) => `\\${c}`);

/** A literal PDF string holding `s` byte for byte (latin1). */
export const pdfString = (s: string): string => `(${escape(s)})`;

/** A Link annotation with a URI action. */
export const uriLink = (rect: [number, number, number, number], uri: string): string =>
  `<< /Type /Annot /Subtype /Link /Rect [${rect.join(' ')}] /Border [0 0 0] /A << /S /URI /URI ${pdfString(uri)} >> >>`;

export function buildPdf(pages: Page[]): Uint8Array {
  const objects: string[] = [];
  const add = (body: string): number => objects.push(body);
  const catalog = add('');
  const pagesObj = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const kids: number[] = [];
  for (const page of pages) {
    const ops = (page.text ?? []).map((t) => `BT /F1 ${t.size ?? 12} Tf ${t.x} ${t.y} Td ${pdfString(t.str)} Tj ET`).join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(ops, 'latin1')} >>\nstream\n${ops}\nendstream`);
    const annots = (page.annots ?? []).map((a) => add(a));
    const box = page.box ?? [0, 0, 612, 792];
    const crop = page.crop ? ` /CropBox [${page.crop.join(' ')}]` : '';
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [${box.join(' ')}]${crop} /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R` +
          (annots.length > 0 ? ` /Annots [${annots.map((n) => `${n} 0 R`).join(' ')}]` : '') +
          ' >>',
      ),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((n) => `${n} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}
