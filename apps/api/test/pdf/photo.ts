// A synthetic page with a photo (LINKS L3 fix round 1, S1): made-up content only.
import { PDFDocument, PDFName, StandardFonts } from '@cantoo/pdf-lib';

/** A page with a 64 x 64 photo at [100, 400, 300, 600] (drawn on the page, or through a form XObject) and a caption under it. */
export async function photoPage(inForm = false, pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const side = 64;
  const samples = Uint8Array.from({ length: side * side * 3 }, (_, i) => (i * 37 + (i >> 3) * 11) % 251);
  const picture = doc.context.register(doc.context.flateStream(samples, { Type: 'XObject', Subtype: 'Image', Width: side, Height: side, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 }));
  for (let n = 0; n < pages; n++) {
    const page = doc.addPage([612, 792]);
    if (inForm) {
      // The form draws the photo in its own unit square; the page scales and places the form.
      const form = doc.context.register(doc.context.stream('q 1 0 0 1 0 0 cm /Im1 Do Q', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1], Resources: { XObject: { Im1: picture } } }));
      page.node.setXObject(PDFName.of('Fm1'), form);
      page.node.addContentStream(doc.context.register(doc.context.stream('q 200 0 0 200 100 400 cm /Fm1 Do Q')));
    } else {
      page.node.setXObject(PDFName.of('Im1'), picture);
      page.node.addContentStream(doc.context.register(doc.context.stream('q 200 0 0 200 100 400 cm /Im1 Do Q')));
    }
    page.drawText('Our members at the picnic.', { x: 72, y: 380, size: 12, font });
  }
  return doc.save({ useObjectStreams: false });
}
