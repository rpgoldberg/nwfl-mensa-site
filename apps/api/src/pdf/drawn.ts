// ============================================================================
// UNTRUSTED-PDF-GATE M1 (fix round 4): the pictures a viewer draws.
//
// The rules in gate-rules.ts read the copy through pdf-lib, and the round-4
// challenge stored the photo under "hide" seven ways pdf-lib's reading missed
// and pdf.js's did not: a predictor on page content, "qBI", "BI%", "{BI", a
// page with no /Type, a BI split across a /Contents array, and the photo as
// a function-based shading. So under "blur" and "hide" the gate also runs
// pdf.js, the reader behind Firefox's viewer, on its own writing of the copy
// and reads every page's operator list, what pdf.js would draw. It refuses:
//   - an inline picture (paintInlineImageXObject, and the grouped and
//     repeated forms pdf.js's optimizer makes, which getOperatorList does not);
//   - a picture or a stencil larger than the policy draws: 1 x 1 under
//     "hide", BLUR_MAX a side under "blur" (an inline picture past 200 pixels
//     of width and height is drawn as a picture too);
//   - a shading pdf.js draws as a lattice or mesh of colours: function-based
//     (ShadingType 1) and types 4 to 7, filled with sh or through a shading
//     pattern; axial and radial ones are gradients and pass;
//   - a copy whose pages pdf.js counts otherwise than pdf-lib.
// Forms and soft masks are in a page's own list; tiling patterns and Type 3
// glyphs carry lists of their own, read the same way. It also matches the
// withheld quotes against the glyphs drawn (r4 N3: a /ToUnicode can lie to the
// text layer, not to the glyphs). Under "show" it does not run: the pictures
// are the originals then, and decoding every one would cost the child memory
// for nothing the policy forbids.
// ============================================================================
import type { PDFPageProxy } from 'pdfjs-dist/types/src/display/api.js';
import { type PdfJs, loadPdfJs } from './gate.js';
import { BLUR_MAX } from './images.js';
import { textMatches } from './match.js';

export interface DrawnBreak {
  code: 'withheld' | 'rules';
  reason: string;
}

interface OperatorList {
  fnArray: number[];
  argsArray: unknown[];
}

interface Glyph {
  unicode?: unknown;
  fontChar?: unknown;
}

/** How long a picture, pattern or font pdf.js names may take to arrive before the copy is refused. */
const SETTLE_MS = 5_000;

/** One page's walk: the objects pdf.js sent for it, the fonts read already, and the text of the glyphs drawn. */
class PageWalk {
  readonly unicode: string[] = [];
  readonly chars: string[] = [];
  private readonly fonts = new Set<string>();

  constructor(
    private readonly pdfjs: PdfJs,
    private readonly page: PDFPageProxy,
    private readonly side: number,
  ) {}

  /** An object pdf.js sent for the page (a shading's IR, a font), as its renderer looks it up; undefined if it never comes. */
  private object(id: string): Promise<unknown> {
    const pool = id.startsWith('g_') ? this.page.commonObjs : this.page.objs;
    if (pool.has(id)) return Promise.resolve(pool.get(id));
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), SETTLE_MS);
      pool.get(id, (data: unknown) => {
        clearTimeout(timer);
        resolve(data);
      });
    });
  }

  /** Why a shading's IR is not a gradient, or null. */
  private async shading(id: unknown): Promise<string | null> {
    const ir = typeof id === 'string' ? await this.object(id) : undefined;
    if (!Array.isArray(ir)) return 'pdf.js draws a shading it could not read';
    return ir[0] === 'Mesh' ? `pdf.js draws a shading of type ${String(ir[1])}` : null;
  }

  private sized(what: string, width: unknown, height: unknown): string | null {
    return typeof width === 'number' && typeof height === 'number' && width <= this.side && height <= this.side ? null : `pdf.js draws ${what} of ${String(width)} x ${String(height)}`;
  }

  /** Why the list draws a picture the policy forbids, or null; collects the glyphs it draws. */
  async read(list: OperatorList): Promise<string | null> {
    const { OPS } = this.pdfjs;
    const inline = new Set<number>([OPS.paintInlineImageXObject, OPS.paintInlineImageXObjectGroup, OPS.paintImageXObjectRepeat, OPS.paintImageMaskXObjectGroup, OPS.paintImageMaskXObjectRepeat]);
    for (let i = 0; i < list.fnArray.length; i++) {
      const op = list.fnArray[i] as number;
      const args = (list.argsArray[i] ?? []) as unknown[];
      let found: string | null = null;
      if (inline.has(op)) found = 'pdf.js draws an inline picture';
      else if (op === OPS.paintImageXObject) found = this.sized('a picture', args[1], args[2]);
      else if (op === OPS.paintImageMaskXObject) {
        const mask = args[0] as { width?: unknown; height?: unknown } | undefined;
        found = this.sized('a stencil', mask?.width, mask?.height);
      } else if (op === OPS.shadingFill) found = await this.shading(args[0]);
      else if (op === OPS.setFillColorN || op === OPS.setStrokeColorN) {
        if (args[0] === 'TilingPattern') found = await this.read(args[2] as OperatorList);
        else if (args[0] === 'Shading') found = await this.shading(args[1]);
      } else if (op === OPS.setFont) found = await this.font(args[0]);
      else if (op === OPS.showText) this.glyphs(args[0]);
      if (found !== null) return found;
    }
    return null;
  }

  /** A Type 3 font's glyphs are operator lists of their own: each is read once. */
  private async font(name: unknown): Promise<string | null> {
    if (typeof name !== 'string' || this.fonts.has(name)) return null;
    this.fonts.add(name);
    const font = (await this.object(name)) as { charProcOperatorList?: Map<string, OperatorList> | Record<string, OperatorList> } | undefined;
    const lists = font?.charProcOperatorList;
    for (const list of lists instanceof Map ? lists.values() : Object.values(lists ?? {})) {
      const found = await this.read(list);
      if (found !== null) return found;
    }
    return null;
  }

  private glyphs(drawn: unknown): void {
    let unicode = '';
    let chars = '';
    for (const glyph of Array.isArray(drawn) ? (drawn as unknown[]) : []) {
      if (typeof glyph !== 'object' || glyph === null) continue;
      const { unicode: u, fontChar: c } = glyph as Glyph;
      if (typeof u === 'string') unicode += u;
      if (typeof c === 'string') chars += c;
    }
    this.unicode.push(unicode);
    this.chars.push(chars);
  }

  /** Whether the glyphs drawn spell a quote: each read as one run, and with a space between the strings shown. */
  spells(quotes: readonly string[]): boolean {
    return [this.unicode, this.chars].some((shown) => textMatches(shown.join(''), quotes) || textMatches(shown.join(' '), quotes));
  }
}

/**
 * Why pdf.js would draw a picture `image` forbids in `pdf`, or would draw withheld text, or reads another number
 * of pages than `pages` (pdf-lib's count), or null. Throws when pdf.js cannot open the copy.
 */
export async function drawnBreak(pdf: Uint8Array, image: 'blur' | 'hide', quotes: readonly string[], pages: number): Promise<DrawnBreak | null> {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({ data: new Uint8Array(pdf), verbosity: 0, disableFontFace: true });
  try {
    const doc = await task.promise;
    if (doc.numPages !== pages) return { code: 'rules', reason: `pdf.js reads ${doc.numPages} pages where pdf-lib reads ${pages}` };
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const walk = new PageWalk(pdfjs, page, image === 'hide' ? 1 : BLUR_MAX);
      const found = await walk.read(await page.getOperatorList());
      if (found !== null) return { code: 'rules', reason: `page ${n}: ${found}` };
      if (quotes.length > 0 && walk.spells(quotes)) return { code: 'withheld', reason: `page ${n}: withheld text is in the glyphs pdf.js draws` };
      page.cleanup();
    }
    return null;
  } finally {
    await task.destroy();
  }
}
