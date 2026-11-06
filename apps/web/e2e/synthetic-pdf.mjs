// @ts-check
// PDFVIEW: made-up PDFs for the stand-in API (e2e/api.mjs), never a real issue. Each page has a filled
// band of colour (so a drawn canvas is never blank), lines of text in Helvetica (so the text layer
// has words to find) and link annotations as the copies carry them: a URI action to
// https://nwflmensa.us/out/<id> with /Contents "Link to <host>", or a link to another page. Written
// by hand, uncompressed, with a correct cross-reference table; this file only writes PDFs.

/** @param {string} text */
const literal = (text) => `(${text.replace(/[\\()]/g, (c) => `\\${c}`)})`;

/**
 * @typedef {{ rect: [number, number, number, number], uri?: string, toPage?: number, contents?: string }} Link
 * @typedef {{ lines: string[], fill: [number, number, number], links?: Link[] }} SyntheticPage
 */

/**
 * @param {{ pages: SyntheticPage[], comment?: string }} spec
 * @returns {Buffer}
 */
export function syntheticPdf({ pages, comment = '' }) {
  /** @type {string[]} */
  const objects = [];
  const add = (/** @type {string} */ body) => objects.push(body);
  // 1 catalog, 2 page tree, 3 font; then each page: its page object, its content, its links.
  const pageRefs = pages.map((_, i) => 4 + pages.slice(0, i).reduce((n, p) => n + 2 + (p.links?.length ?? 0), 0));
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(`<< /Type /Pages /Kids [${pageRefs.map((r) => `${r} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  pages.forEach((page, i) => {
    const ref = /** @type {number} */ (pageRefs[i]);
    const links = page.links ?? [];
    const annots = links.map((_, k) => `${ref + 2 + k} 0 R`).join(' ');
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${ref + 1} 0 R${annots ? ` /Annots [${annots}]` : ''} >>`);
    const [r, g, b] = page.fill;
    const text = page.lines.map((line, k) => `${k === 0 ? '72 700 Td' : '0 -40 Td'} ${literal(line)} Tj`).join('\n');
    // Each link underlined, as a reader sees a link.
    const boxes = links.map(({ rect: [x1, y1, x2] }) => `${x1} ${y1 + 4} ${x2 - x1} 2 re`).join('\n');
    const stream = `q ${r} ${g} ${b} rg 36 560 540 200 re f Q\nq 0 0 0.6 rg ${boxes ? `${boxes}\nf` : ''} Q\nBT /F1 28 Tf 0 0 0 rg\n${text}\nET\n`;
    add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`);
    for (const link of links) {
      const action = link.uri !== undefined ? `/A << /S /URI /URI ${literal(link.uri)} >>` : `/Dest [${pageRefs[/** @type {number} */ (link.toPage)]} 0 R /Fit]`;
      add(`<< /Type /Annot /Subtype /Link /Rect [${link.rect.join(' ')}] /Border [0 0 0] ${action}${link.contents ? ` /Contents ${literal(link.contents)}` : ''} >>`);
    }
  });
  let out = `%PDF-1.7\n${comment ? `${comment}\n` : ''}`;
  /** @type {number[]} */
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** Where the copies' links point: the production origin, as the worker writes them. */
const OUT = 'https://nwflmensa.us/out/';

/**
 * The newest issue's public copy (the stand-in's LINK_FILE): three pages, with the links of
 * e2e/stand-in.ts LINKS where the API says they are (web on page 2, social and mail on page 1, the
 * turned-off one on page 3), and a link on page 1 to page 3.
 */
export const PUBLIC_ISSUE_PDF = syntheticPdf({
  pages: [
    {
      lines: ['Pensa Mensa', 'Public copy, page 1', 'Our group on Facebook', 'Write to the events desk', 'Go to page 3'],
      fill: [0.85, 0.93, 0.95],
      links: [
        { rect: [72, 612, 460, 652], uri: `${OUT}outsocialaaaaaaaaaaaaaaaaa`, contents: 'Link to www.facebook.com' },
        { rect: [72, 572, 460, 612], uri: `${OUT}outmailaaaaaaaaaaaaaaaaaaa`, contents: 'Link to example.org' },
        { rect: [72, 532, 300, 572], toPage: 2 },
      ],
    },
    {
      lines: ['Public copy, page 2', 'The picnic is on Saturday'],
      fill: [0.95, 0.9, 0.8],
      links: [{ rect: [72, 652, 500, 692], uri: `${OUT}outwebaaaaaaaaaaaaaaaaaaaa`, contents: 'Link to club.example' }],
    },
    {
      lines: ['Public copy, page 3', 'A link that was turned off'],
      fill: [0.9, 0.85, 0.95],
      links: [{ rect: [72, 652, 500, 692], uri: `${OUT}outoffaaaaaaaaaaaaaaaaaaaa`, contents: 'Link to parked.example' }],
    },
  ],
});

/**
 * The newest issue's members copy: two pages; `mark` is the stand-in's members-copy comment.
 *
 * @param {string} mark
 */
export const membersIssuePdf = (mark) =>
  syntheticPdf({
    comment: mark,
    pages: [
      { lines: ['Pensa Mensa', 'Members copy, page 1'], fill: [0.93, 0.9, 0.97] },
      { lines: ['Members copy, page 2'], fill: [0.9, 0.95, 0.9] },
    ],
  });
