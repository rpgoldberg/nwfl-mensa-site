// REDACT R3a: fixture PDFs for the leak test, built at test time so every
// canary's place is in the source. Every name here is made up.
import { crc32, deflateSync } from 'node:zlib';
import { PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts } from '@cantoo/pdf-lib';

/**
 * One canary per place a PDF can carry text. `needles` are what must not be found in a redacted
 * copy: the whole canary and, where it is split on the page, its parts.
 */
export const CANARIES = {
  body: { quote: 'Quillon Brask', needles: ['Quillon Brask', 'Quillon', 'Brask'] },
  splitLine: { quote: 'Marvel Ostrander', needles: ['Marvel Ostrander', 'Marvel', 'Ostrander'] },
  hyphenated: { quote: 'Wrenhallow', needles: ['Wrenhallow', 'Wren', 'hallow'] },
  ligature: { quote: 'Snowfield', needles: ['Snowfield', 'Snow'] },
  kerning: { quote: 'Pellingham', needles: ['Pellingham', 'Pell', 'ingham'] },
  letterSpaced: { quote: 'Kestrel', needles: ['Kestrel'] },
  metadata: { quote: 'Halvorsine', needles: ['Halvorsine'] },
  annotation: { quote: 'Ottoline Varga', needles: ['Ottoline', 'Varga'] },
  freeText: { quote: 'Ysolde Pemberton', needles: ['Ysolde', 'Pemberton'] },
  formField: { quote: 'Brannagh Coyle', needles: ['Brannagh', 'Coyle'] },
  outline: { quote: 'Feodora Lusk', needles: ['Feodora', 'Lusk'] },
  attachment: { quote: 'Zebulon Thrace', needles: ['Zebulon', 'Thrace'] },
  javascript: { quote: 'Ignatius Moorcroft', needles: ['Ignatius', 'Moorcroft'] },
  actualText: { quote: 'Perpetua Lindqvist', needles: ['Perpetua', 'Lindqvist'] },
} as const;

export type CanaryName = keyof typeof CANARIES;

/** Canaries a reader sees drawn on the page (so the engine must find and remove them). */
export const ON_PAGE: readonly CanaryName[] = ['body', 'splitLine', 'hyphenated', 'ligature', 'kerning', 'letterSpaced', 'freeText', 'formField'];

const HELVETICA = { Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' };
// No /Encoding: the font's built-in StandardEncoding, where \256 is the "fi" ligature.
const TIMES = { Type: 'Font', Subtype: 'Type1', BaseFont: 'Times-Roman' };

const BODY = [
  'BT /F1 12 Tf 72 740 Td (Please call Quillon Brask about the picnic.) Tj ET',
  'BT /F1 12 Tf 72 720 Td (Then ask Marvel) Tj ET',
  'BT /F1 12 Tf 72 706 Td (Ostrander at the door.) Tj ET',
  'BT /F1 12 Tf 72 686 Td (Tobias Wren-) Tj ET',
  'BT /F1 12 Tf 72 672 Td (hallow hosted it.) Tj ET',
  'BT /F2 12 Tf 72 652 Td (Keep the Snow\\256eld farm in mind.) Tj ET',
  'BT /F1 12 Tf 72 632 Td [(Ask Pell) 120 (ing) -40 (ham today.)] TJ ET',
  'BT /F1 12 Tf 72 612 Td (Phone K e s t r e l now.) Tj ET',
  '/Span <</ActualText (Perpetua Lindqvist)>> BDC BT /F1 12 Tf 72 592 Td (Signed, the host.) Tj ET EMC',
  'BT /F1 12 Tf 72 572 Td (This closing line stays readable.) Tj ET',
].join('\n');

const XMP = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator><rdf:Seq><rdf:li>Halvorsine</rdf:li></rdf:Seq></dc:creator></rdf:Description>
</rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;

/** The leak fixture: every canary in its own place, on one page. */
export async function leakFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([612, 792]);
  const { context, catalog } = doc;
  const helvetica = context.register(context.obj(HELVETICA));
  page.node.setFontDictionary(PDFName.of('F1'), helvetica);
  page.node.setFontDictionary(PDFName.of('F2'), context.register(context.obj(TIMES)));
  page.node.set(PDFName.of('Contents'), context.register(context.flateStream(BODY)));

  // Metadata: the Info dictionary and an XMP stream.
  doc.setTitle('Minutes kept by Halvorsine');
  doc.setAuthor('Halvorsine');
  doc.setSubject('Halvorsine');
  doc.setKeywords(['Halvorsine']);
  catalog.set(PDFName.of('Metadata'), context.register(context.stream(XMP, { Type: 'Metadata', Subtype: 'XML' })));

  // A sticky note: text a viewer shows in a popup, never drawn on the page.
  const note = context.obj({
    Type: 'Annot',
    Subtype: 'Text',
    Rect: [520, 740, 540, 760],
    Contents: PDFString.of('Ottoline Varga'),
    T: PDFString.of('Ottoline Varga'),
  });
  page.node.addAnnot(context.register(note));

  // A FreeText annotation whose appearance draws its text on the page.
  const appearance = context.flateStream('BT /F1 12 Tf 2 5 Td (Ysolde Pemberton) Tj ET', {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: [0, 0, 200, 20],
    Resources: { Font: { F1: helvetica } },
  });
  const freeText = context.obj({
    Type: 'Annot',
    Subtype: 'FreeText',
    Rect: [72, 540, 272, 560],
    F: 4,
    Contents: PDFString.of('Ysolde Pemberton'),
    DA: PDFString.of('/F1 12 Tf 0 g'),
    AP: { N: context.register(appearance) },
  });
  page.node.addAnnot(context.register(freeText));

  // A filled form field, with its appearance.
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const field = doc.getForm().createTextField('guest');
  field.setText('Brannagh Coyle');
  field.addToPage(page, { x: 72, y: 500, width: 200, height: 24, font });

  // A bookmark.
  const outlinesRef = context.nextRef();
  const itemRef = context.register(
    context.obj({ Title: PDFHexString.fromText('Feodora Lusk'), Parent: outlinesRef, Dest: [page.ref, 'Fit'] }),
  );
  context.assign(outlinesRef, context.obj({ Type: 'Outlines', First: itemRef, Last: itemRef, Count: 1 }));
  catalog.set(PDFName.of('Outlines'), outlinesRef);

  // An embedded file and document JavaScript.
  await doc.attach(Buffer.from('Zebulon Thrace, 12 Elm Street'), 'Zebulon-Thrace.txt', {
    mimeType: 'text/plain',
    description: 'Notes from Zebulon Thrace',
  });
  doc.addJavaScript('greet', "app.alert('Ignatius Moorcroft');");

  return doc.save({ useObjectStreams: false });
}

/** Two lines with one short passage each; both passages fit in one width step. */
export async function twoMarksFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([612, 792]);
  const { context } = doc;
  page.node.setFontDictionary(PDFName.of('F1'), context.register(context.obj(HELVETICA)));
  const lines = ['BT /F1 12 Tf 72 700 Td (Phone Bo now about the picnic and the rest.) Tj ET', 'BT /F1 12 Tf 72 680 Td (Phone Quillon now about the picnic and the rest.) Tj ET'];
  page.node.set(PDFName.of('Contents'), context.register(context.flateStream(lines.join('\n'))));
  return doc.save({ useObjectStreams: false });
}

/** An 8 by 8 grey PNG: a stand-in for a scanned page. */
function png(): Uint8Array {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(8, 0);
  header.writeUInt32BE(8, 4);
  header.set([8, 0, 0, 0, 0], 8);
  const rows = Buffer.concat(Array.from({ length: 8 }, () => Buffer.from([0, ...new Array<number>(8).fill(128)])));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

/** A text page, then a page that is only a picture: a scan with no text layer. */
export async function scannedFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([612, 792]);
  const { context } = doc;
  page.node.setFontDictionary(PDFName.of('F1'), context.register(context.obj(HELVETICA)));
  page.node.set(PDFName.of('Contents'), context.register(context.flateStream('BT /F1 12 Tf 72 700 Td (Please call Quillon Brask.) Tj ET')));
  const scan = doc.addPage([612, 792]);
  const image = await doc.embedPng(png());
  scan.drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
  doc.addPage([612, 792]); // A blank page has nothing drawn, so it needs no text.
  return doc.save({ useObjectStreams: false });
}

/** A passage drawn over a picture (an OCR'd scan looks like this): removing the text would leave the picture's pixels. */
export async function pictureUnderTextFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([612, 792]);
  page.drawImage(await doc.embedPng(png()), { x: 60, y: 690, width: 300, height: 30 });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Please call Quillon Brask.', { x: 72, y: 700, size: 12, font });
  page.drawText('Ask Pellingham today.', { x: 72, y: 600, size: 12, font });
  return doc.save({ useObjectStreams: false });
}

/** Text in a Type 3 font whose glyphs have no Unicode value: PDFium cannot say what it reads. */
export async function unmappedFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([612, 792]);
  const { context } = doc;
  const glyph = context.register(context.flateStream('500 0 0 0 500 700 d1 0 0 500 700 re f'));
  const font = context.obj({
    Type: 'Font',
    Subtype: 'Type3',
    FontBBox: [0, 0, 500, 700],
    FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
    CharProcs: { g1: glyph },
    Encoding: { Type: 'Encoding', Differences: [65, 'g1'] },
    FirstChar: 65,
    LastChar: 65,
    Widths: [500],
    Resources: {},
  });
  page.node.setFontDictionary(PDFName.of('F3'), context.register(font));
  page.node.set(PDFName.of('Contents'), context.register(context.flateStream('BT /F3 12 Tf 72 700 Td (AAAA) Tj ET')));
  return doc.save({ useObjectStreams: false });
}

/** Marked content with a property list but no tag: the lexer cannot say what it is, so the copy is refused. */
export async function untaggedPropertiesFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([612, 792]);
  const { context } = doc;
  page.node.setFontDictionary(PDFName.of('F1'), context.register(context.obj(HELVETICA)));
  page.node.set(PDFName.of('Contents'), context.register(context.flateStream('<</ActualText (Quillon Brask)>> BDC BT /F1 12 Tf 72 700 Td (Hello there.) Tj ET EMC')));
  return doc.save({ useObjectStreams: false });
}
