// ============================================================================
// BOXLABEL: the labels in a copy (labels.ts), as the engine and the output
// gate read them. The gate does not trust the engine that drew them.
//
// PDFium reads each page's objects (pdfium.ts labelReading). A box is a path
// in the boxes' style (one rectangle, drawn round its corners and closed as
// "re" draws it, filled even-odd, not stroked, opaque black, at the
// identity); a label is a text object that reads exactly as "Members Only",
// "Mbrs Only" or "Private" in white non-embedded Helvetica.
// The copy's labels are refused (labelMarks gives the reason) when:
//   - a label is drawn in a form XObject, or directly on the page where no
//     box drawn before it holds it: a label outside a box;
//   - text in the labels' font and colour that a box holds is not exactly a
//     label (any other string, the old "withheld", another case or spelling,
//     text PDFium does not read), or a label is not in the labels' style
//     (its glyphs filled, opaque, moved but not scaled or turned, at least
//     MIN_LABEL_PT), or a box holds more than one label;
//   - any other glyph drawn over a box (after it, on the page or in a form)
//     has its centre in it: text other than its label in a box.
// A glyph drawn before a box lies under it, hidden: the engine leaves one
// there only when PDFium could not remove it (an invisible copy, before as
// now), and the leak checks read it like any other.
//
// GATE-LAYOUT: a newsletter draws rectangles of its own in that very style (a
// calendar's black header cells, a bar behind a heading, a hairline rule), so
// the style alone does not make a box. The check is given the original, opens
// it itself (the gate takes nothing the engine says of it), flattens each
// page as the engine does and reads its rectangles in the boxes' style
// (layoutOf). A rectangle of the copy with exactly the bounds of one the
// original draws on the same page is the layout's, one for one in drawing
// order; every other is a box, under every rule above. So a rectangle the
// copy adds, moves, draws once more than the original or on another page is
// a box, and the engine's box drawn exactly on a rectangle of the original,
// in its place, is not: its label is then outside a box, and refused. An
// original that cannot be opened is refused.
// On a rectangle of the layout the labels' rules do not hold (its white
// heading is the newsletter's), and one does: text nobody can see there is
// refused, as develop refused all text on it. A glyph is judged when half of
// its ink or more lies on rectangles of the original drawn before it (so a
// hairline rule through a glyph does not make it judged). It is seen when its
// text object is painted opaque (no transparency, blend mode or soft mask on
// it or a form that draws it; filled, alone or with a stroke; in a Type 3
// font, PDFium draws its glyphs alone in one opaque colour, which is then its
// paint: pdfium.ts Page.labelReading), no other glyph drawn after it lies
// over half its ink or more, and at least half its ink shows, taking away
// (each by the most it may cover):
//   - what its clips, and its forms' clips, leave out (a clip that does not
//     hold the ink and is not an upright rectangle leaves it all out);
//   - whatever is drawn after it: a box, or a path's fill or stroke (each
//     cut by its clips' bounds);
//   - each piece of what lies under it, back to what holds its ink whole
//     (else the page round the boxes among them), that its paint is under
//     3:1 against by WCAG contrast. A dark glyph (under 0.1, under 3:1 on
//     black) contrasts only with a light fill (0.4 or over) that, with every
//     clip on it, covers its ink and 0.1 pt round it, drawn directly on the
//     page at the identity; more than 32 pieces leave it unseen.
// What the check cannot read (a picture, a form, a shading, a path
// see-through or drawn through a matrix, or longer than it reads, a box a
// clip cuts to another shape) on the ink or under it, or anything but text beside it in its form, is not taken away
// by its bounds (as it is when pageLabels is given no drawing): the glyph is
// then seen only if, besides, PDFium's drawing of the page shows its text
// object there (pdfium.ts Page.shows: 5 % or more of
// the ink box changes by 3:1 without it), for at most 24 text objects a page.
// Fix round 1b: a stroke's mitred corner may reach as far as its angle lets
// (PDFium gives no miter limit); a glyph is seen only when PDFium, drawing
// its text object alone, paints 5 % or more of its ink box (a glyph a font
// draws nothing for is not seen); and on a page that draws text as a clip
// (whose text PDFium does not give) no glyph on a rectangle is seen.
// A glyph not seen where it is drawn passes when the same glyph is drawn
// again where it is (the same text over half its ink or more, before or
// after it) and is seen there, as Publisher draws a heading twice; and a text
// object drawn again as it is (whose glyphs PDFium does not read again) is
// judged where that is drawn (the 8 nearest such).
// A page whose glyphs take more than MAX_WORK steps to judge is refused.
//
// The leak checks (gate.ts checkCopy, drawn.ts's glyphs, the engine's own
// PDFium reading) do not count the labels' text (leakBreak). A check that
// finds withheld text in a copy whose labels pass is run once more on the
// copy with exactly those labels' text taken out (unlabelled): in the page's
// own content, each label's string in the very bytes PDFium writes for a
// label at that label's place, as many as PDFium read there and no more, is
// turned to spaces. Nothing else of the copy changes. It is taken out only
// when that op names its font in letters and digits, as PDFium does (no #XX
// escape, which pdf-lib and the readers decode apart: round 2, R2-1), and the
// font pdf-lib finds under that name in the page's resources is exactly the
// one PDFium writes for a label (/Type /Font /Subtype /Type1 /BaseFont
// /Helvetica /Encoding /WinAnsiEncoding, and no other key: no /Differences,
// /ToUnicode, /Widths or /FontDescriptor, nothing embedded), so its codes draw the glyphs
// they read as (BOXLABEL fix round 1, F1: a font's /Differences drew a quote
// under codes every text layer read as "Private"), and only from a content
// stream written as PDFium writes one (/Filter /FlateDecode alone, no
// /DecodeParms; F5). That font is the one pdf.js and PDFium find only because
// the callers read the labels after refusing any copy whose names pdf-lib
// reads apart from them, or whose names cannot all be read (pdf-structure.ts
// nameBreak, round 3, R3-1: pdf-lib decodes a name's #XX twice, the readers
// once; round 4, B1: it fails closed): the gate in gateVerdict and gateReply,
// the engine in redactPdf; unlabelled itself does not check.
// The glyph check (drawn.ts) takes a label out besides only where pdf.js's
// glyphs and their text both spell it, once per label
// (F1, defence in depth). A copy whose labels fail, or whose label bytes are
// not found so, is judged as it is. So the exemption is exactly those
// strings, drawn as themselves, inside boxes; a label string drawn anywhere
// else, once more than PDFium read labels, or in any other font, is still
// read.
// ============================================================================
import { PDFArray, PDFDict, PDFDocument, PDFName, type PDFObject, PDFRawStream, PDFRef } from '@cantoo/pdf-lib';
import { decodePDFRawStream } from '@cantoo/pdf-lib';
import { type Label, isLabel } from './labels.js';
import type { Box, PageChar } from './match.js';
import { Document, type LabelReading, type Outline, type Shape, type Unread, pdfium } from './pdfium.js';

/** A label as read from a copy: its text, and its place (the origin PDFium draws it from). */
export interface PlacedLabel {
  text: Label;
  x: number;
  y: number;
}

/** How far a glyph's centre must be inside a box to count as in it, and a label inside its box, in points. */
const SLACK = 0.01;

/** Whether `outer` holds `inner`, to SLACK. */
const holds = (outer: Box, inner: Box): boolean =>
  inner.left >= outer.left - SLACK && inner.right <= outer.right + SLACK && inner.bottom >= outer.bottom - SLACK && inner.top <= outer.top + SLACK;
const centreIn = (box: Box, { left, right, bottom, top }: Box): boolean => {
  const x = (left + right) / 2;
  const y = (bottom + top) / 2;
  return x > box.left + SLACK && x < box.right - SLACK && y > box.bottom + SLACK && y < box.top - SLACK;
};

/** A glyph's paint under this luminance is under 3:1 against black (WCAG contrast (L + 0.05) / 0.05): unseen on it. */
const DARK = 0.1;
/** A shape's fill at this luminance or over is 3:1 or more against any glyph under DARK: it shows the glyph. */
const LIGHT = 0.4;
/** How far past a glyph's ink a light shape must reach, on every side, to show a dark glyph: more than the chords of a curve miss by. */
const COVER_MARGIN = 0.1;
/** A glyph this share of whose ink or more lies on rectangles of the original drawn before it is judged on them. */
const ON_SHARE = 0.5;
/** A glyph is seen when this share of its ink or more shows: inside its clips, not drawn over, on what it contrasts with. */
const SEEN_SHARE = 0.5;
/** Where a picture, form or shading lies over a glyph or under it, the share of its inner ink box (Page.shows) its text object must change by 3:1 or more, as PDFium draws the page. */
const SHOWN_PIXELS = 0.05;
/** The most text objects a page is drawn without (Page.shows): past them, a glyph that needs it is not seen. */
const MAX_SHOWS = 24;
/** The most pieces of what lies under a glyph's ink it is judged on: past them, it is not seen. */
const MAX_PIECES = 32;
/** The most work (objects, rectangles and edges looked at) judging one page's glyphs may take: past it, the page is refused. */
const MAX_WORK = 10_000_000;

const UNREAD_ORIGINAL = 'the original could not be opened to read its layout';

/** Whether the line from (x1, y1) to (x2, y2) meets the box, its edge included (Liang and Barsky's clip). */
function meetsBox(box: Box, x1: number, y1: number, x2: number, y2: number): boolean {
  let from = 0;
  let to = 1;
  const sides: ReadonlyArray<readonly [number, number]> = [
    [x1 - x2, x1 - box.left],
    [x2 - x1, box.right - x1],
    [y1 - y2, y1 - box.bottom],
    [y2 - y1, box.top - y1],
  ];
  for (const [p, q] of sides) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) from = Math.max(from, t);
    else to = Math.min(to, t);
    if (from > to) return false;
  }
  return true;
}

/** Each edge of an outline, a ring closed back to its first point. */
function* edgesOf(outline: Outline): Generator<readonly [number, number, number, number]> {
  for (const ring of outline) {
    for (const [i, [x1, y1]] of ring.entries()) {
      const [x2, y2] = ring[(i + 1) % ring.length] as [number, number];
      yield [x1, y1, x2, y2];
    }
  }
}

/**
 * Where a box lies against an outline's fill: 'edge' when an edge of the outline meets the box; else 'in' or 'out',
 * the box wholly in the fill or wholly out of it, by its corner. `evenOdd`: by that rule, or by the nonzero winding
 * rule; null: in only by both (a clip, whose rule PDFium does not give).
 */
function against(outline: Outline, evenOdd: boolean | null, box: Box): 'edge' | 'in' | 'out' {
  let winding = 0;
  let crossings = 0;
  for (const [x1, y1, x2, y2] of edgesOf(outline)) {
    if (meetsBox(box, x1, y1, x2, y2)) return 'edge';
    // A ray from the box's corner to the right: each edge it crosses, and which way that edge runs.
    if (y1 <= box.bottom === y2 <= box.bottom || x1 + ((box.bottom - y1) * (x2 - x1)) / (y2 - y1) <= box.left) continue;
    winding += y2 > y1 ? 1 : -1;
    crossings += 1;
  }
  // An odd count of crossings is an odd, so nonzero, winding: in by both rules.
  const odd = crossings % 2 === 1;
  return (evenOdd === false ? winding !== 0 : odd) ? 'in' : 'out';
}

/** Whether an outline's fill holds the whole box: no edge of it meets the box, and its corner lies in. */
const fills = (outline: Outline, evenOdd: boolean | null, box: Box): boolean => against(outline, evenOdd, box) === 'in';

/**
 * Whether an outline's fill may paint on the box: an edge meets it, the box lies in the fill (by either rule), or a
 * point of the outline lies in the box.
 */
function mayPaint(outline: Outline, box: Box): boolean {
  // In by the nonzero rule is in by either: an even-odd fill is inside a nonzero one.
  if (against(outline, false, box) !== 'out') return true;
  return outline.some((ring) => ring.some(([x, y]) => x >= box.left && x <= box.right && y >= box.bottom && y <= box.top));
}

/** The box grown by `by` on every side. */
const grown = (box: Box, by: number): Box => ({ left: box.left - by, right: box.right + by, bottom: box.bottom - by, top: box.top + by });

/** Whether a shape covers a glyph's ink whole, and a margin round it: its fill holds it, and so does every clip on it. */
function covers(shape: Shape, ink: Box): boolean {
  const area = grown(ink, COVER_MARGIN);
  return shape.luminance !== null && fills(shape.outline, shape.evenOdd, area) && shape.clips.every((clip) => fills(clip, null, area));
}

/** Whether a shape's fill holds a glyph's ink whole, and every clip on it does. */
const holdsInk = (shape: Shape, ink: Box): boolean => shape.luminance !== null && fills(shape.outline, shape.evenOdd, ink) && shape.clips.every((clip) => fills(clip, null, ink));

/** Whether a shape's fill may paint on a glyph's ink: it, and every clip on it, may. */
const fillMayPaint = (shape: Shape, ink: Box): boolean => shape.luminance !== null && mayPaint(shape.outline, ink) && shape.clips.every((clip) => mayPaint(clip, ink));

/** How far past its corner, in widths, a mitre may reach that is not taken apart (a miter of the default limit, 10). */
const MITRE_WIDTHS = 5;

/**
 * Each corner of a shape's mitred stroke sharper than a mitre of MITRE_WIDTHS reaches, as the most its mitre may paint
 * (GATE-LAYOUT fix round 1b): PDFium gives no miter limit, and one raised in the file draws a sharp corner's mitre
 * as far as its angle lets, half the width over the sine of half the angle. That is the kite from the corner out
 * to the mitre's tip, through the stroke's two outer edges there. A corner is a point of a subpath between two
 * others (its own repeats left out), and the first of a closed one (unknown: taken as closed); a subpath turned
 * straight back on itself is bevelled (PDFium draws no mitre there).
 */
const mitres = (shape: Shape, width: number): Outline => {
  const out: Outline = [];
  for (const [k, raw] of shape.outline.entries()) {
    const ring = raw.filter(([x, y], i) => i === 0 || x !== raw[i - 1]?.[0] || y !== raw[i - 1]?.[1]);
    const closed = shape.closed?.[k] ?? true;
    if (closed && ring.length > 1 && ring[0]?.[0] === ring.at(-1)?.[0] && ring[0]?.[1] === ring.at(-1)?.[1]) ring.pop();
    for (const [i, [vx, vy]] of ring.entries()) {
      if (!closed && (i === 0 || i === ring.length - 1)) continue;
      const [px, py] = ring[(i + ring.length - 1) % ring.length] as [number, number];
      const [nx, ny] = ring[(i + 1) % ring.length] as [number, number];
      const [l1, l2] = [Math.hypot(vx - px, vy - py), Math.hypot(nx - vx, ny - vy)];
      if (l1 === 0 || l2 === 0) continue;
      const [ux, uy, wx, wy] = [(vx - px) / l1, (vy - py) / l1, (nx - vx) / l2, (ny - vy) / l2];
      // The sine of half the angle between the two lines, and the way the mitre points (out of that angle).
      const sine = Math.sqrt(Math.max(0, (1 + ux * wx + uy * wy) / 2));
      if (sine * MITRE_WIDTHS * 2 >= 1 || sine === 0) continue;
      // Sharper than that, the two lines run nearly back on each other: u - w is nearly 2 long.
      const [dx, dy] = [ux - wx, uy - wy];
      const out_ = Math.hypot(dx, dy);
      const reach = Math.min(width / 2 / sine, 1e7);
      const side = (x: number, y: number): [number, number] => (-y * dx + x * dy >= 0 ? [-y, x] : [y, -x]);
      const [ax, ay] = side(ux, uy);
      const [bx, by] = side(wx, wy);
      out.push([[vx, vy], [vx + (ax * width) / 2, vy + (ay * width) / 2], [vx + (dx / out_) * reach, vy + (dy / out_) * reach], [vx + (bx * width) / 2, vy + (by * width) / 2]]);
    }
  }
  return out;
};

/**
 * Whether a shape's stroke may paint on a glyph's ink: an edge comes within half the line's width of it (a square
 * cap or join reaches √2 times that), or, its corners mitred, a point of it within MITRE_WIDTHS widths, or a sharper
 * corner's mitre meets it (mitres); and every clip on it may paint there.
 */
function strokeMayPaint(shape: Shape, ink: Box): boolean {
  const stroke = shape.stroke;
  if (stroke === undefined || !shape.clips.every((clip) => mayPaint(clip, ink))) return false;
  const near = grown(ink, (stroke.width * Math.SQRT2) / 2);
  for (const [x1, y1, x2, y2] of edgesOf(shape.outline)) if (meetsBox(near, x1, y1, x2, y2)) return true;
  if (!stroke.mitred) return false;
  const mitre = grown(ink, stroke.width * MITRE_WIDTHS);
  if (shape.outline.some((ring) => ring.some(([x, y]) => x >= mitre.left && x <= mitre.right && y >= mitre.bottom && y <= mitre.top))) return true;
  return mitres(shape, stroke.width).some((kite) => mayPaint([kite], ink));
}

/** Whether two boxes share some area. */
const overlap = (a: Box, b: Box): boolean => a.left < b.right && b.left < a.right && a.bottom < b.top && b.bottom < a.top;

const areaOf = (box: Box): number => Math.max(0, box.right - box.left) * Math.max(0, box.top - box.bottom);
const cut = (a: Box, b: Box): Box => ({ left: Math.max(a.left, b.left), right: Math.min(a.right, b.right), bottom: Math.max(a.bottom, b.bottom), top: Math.min(a.top, b.top) });
const EVERYWHERE: Box = { left: -Infinity, right: Infinity, bottom: -Infinity, top: Infinity };

/** The share of the ink's area a box covers; of ink with no area, all of it when the box meets it, edge included. */
function shareIn(box: Box, ink: Box): number {
  const whole = areaOf(ink);
  if (whole === 0) return box.left <= ink.right && ink.left <= box.right && box.bottom <= ink.top && ink.bottom <= box.top ? 1 : 0;
  return areaOf(cut(box, ink)) / whole;
}

/** The box round an outline's points (none for an empty one). */
function boundsOf(outline: Outline): Box {
  const points = outline.flat();
  return points.reduce((box, [x, y]) => ({ left: Math.min(box.left, x), right: Math.max(box.right, x), bottom: Math.min(box.bottom, y), top: Math.max(box.top, y) }), { left: Infinity, right: -Infinity, bottom: Infinity, top: -Infinity });
}

/** Whether an outline is one rectangle, upright: one ring of four corners (or five, closed back to the first), each edge level or plumb. */
function upright(outline: Outline): boolean {
  const [ring, ...more] = outline;
  if (ring === undefined || more.length > 0 || ring.length < 4 || ring.length > 5) return false;
  if (ring.length === 5 && (ring[4]?.[0] !== ring[0]?.[0] || ring[4]?.[1] !== ring[0]?.[1])) return false;
  const corners = ring.slice(0, 4);
  return corners.every(([x, y], k) => {
    const [nx, ny] = corners[(k + 1) % 4] as [number, number];
    return (x === nx) !== (y === ny);
  });
}

/** The share of the ink a clip lets show: all when it holds it; an upright rectangle's own share; else none. */
const clipShare = (clip: Outline, ink: Box): number => (fills(clip, null, ink) ? 1 : upright(clip) ? shareIn(boundsOf(clip), ink) : 0);

/**
 * The most of the ink a shape may paint, by its fill and by its stroke: all when its fill holds it, else by bounds
 * (a stroke's grown by its reach, and each sharper mitre's that meets the ink added).
 */
function shapeShare(shape: Shape, ink: Box): { fill: number; stroke: number } {
  const clipped = shape.clips.reduce((box, clip) => cut(box, boundsOf(clip)), EVERYWHERE);
  const fill = !fillMayPaint(shape, ink) ? 0 : holdsInk(shape, ink) ? 1 : shareIn(cut(boundsOf(shape.outline), clipped), ink);
  if (shape.stroke === undefined || !strokeMayPaint(shape, ink)) return { fill, stroke: 0 };
  const { width, mitred } = shape.stroke;
  let stroke = shareIn(cut(grown(boundsOf(shape.outline), mitred ? width * MITRE_WIDTHS : (width * Math.SQRT2) / 2), clipped), ink);
  if (mitred) for (const kite of mitres(shape, width)) if (mayPaint([kite], ink)) stroke += shareIn(cut(boundsOf([kite]), clipped), ink);
  return { fill, stroke: Math.min(1, stroke) };
}

/** The share of a box's area the rectangles cover between them (none past MAX_PIECES distinct ones: all of it). */
function shareOf(box: Box, rects: readonly Box[]): number {
  const area = (b: Box): number => Math.max(0, b.right - b.left) * Math.max(0, b.top - b.bottom);
  const cut = rects.map((r) => ({ left: Math.max(r.left, box.left), right: Math.min(r.right, box.right), bottom: Math.max(r.bottom, box.bottom), top: Math.min(r.top, box.top) })).filter((r) => area(r) > 0);
  if (area(box) === 0) return rects.some((r) => holds(r, box)) ? 1 : 0;
  const distinct = [...new Map(cut.map((r) => [boundsKey(r), r])).values()];
  if (distinct.length > MAX_PIECES) return 1;
  const xs = [...new Set(distinct.flatMap((r) => [r.left, r.right]))].sort((a, b) => a - b);
  const ys = [...new Set(distinct.flatMap((r) => [r.bottom, r.top]))].sort((a, b) => a - b);
  let covered = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    for (let j = 0; j + 1 < ys.length; j++) {
      const [x, y] = [((xs[i] as number) + (xs[i + 1] as number)) / 2, ((ys[j] as number) + (ys[j + 1] as number)) / 2];
      if (distinct.some((r) => x > r.left && x < r.right && y > r.bottom && y < r.top)) covered += ((xs[i + 1] as number) - (xs[i] as number)) * ((ys[j + 1] as number) - (ys[j] as number));
    }
  }
  return covered / area(box);
}

/**
 * Whether a glyph painted at luminance `glyph` shows on a piece of what lies under it at luminance `under`: 3:1 or
 * more between the two (WCAG), and a dark glyph only on a light piece that covers it whole and a margin round it.
 */
function contrasts(glyph: number, under: number, coversIt: boolean): boolean {
  if (glyph < DARK) return coversIt && under >= LIGHT && under >= 3 * glyph + 0.1;
  return glyph >= 3 * under + 0.1 || under >= 3 * glyph + 0.1;
}

/** Boxes found by the area they lie on: a grid of the page's, and the wide ones apart. */
class BoxIndex {
  private readonly cells = new Map<number, number[]>();
  private readonly wide: number[] = [];
  private readonly size: number;

  constructor(private readonly boxes: readonly Box[]) {
    const finite = (box: Box): boolean => [box.left, box.right, box.bottom, box.top].every(Number.isFinite);
    const extent = boxes.reduce((most, box) => (finite(box) ? Math.max(most, Math.abs(box.left), Math.abs(box.right), Math.abs(box.bottom), Math.abs(box.top)) : most), 1);
    this.size = Math.min(extent, 1e6) / 32;
    for (const [n, box] of boxes.entries()) {
      // A box with no place (a glyph with no ink) is found nowhere.
      if (!finite(box)) continue;
      const [x0, x1, y0, y1] = this.span(box);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 64) {
        this.wide.push(n);
        continue;
      }
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const cell = this.cells.get(x * 4096 + y);
          if (cell === undefined) this.cells.set(x * 4096 + y, [n]);
          else cell.push(n);
        }
      }
    }
  }

  private span(box: Box): [number, number, number, number] {
    const at = (v: number): number => Math.max(-2047, Math.min(2047, Math.floor(v / this.size)));
    return [at(box.left), at(box.right), at(box.bottom), at(box.top)];
  }

  /** Each box whose area may meet the box's (by its index), a superset of those that do. */
  around(box: Box): Set<number> {
    const [x0, x1, y0, y1] = this.span(box);
    const found = new Set<number>(this.wide);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) <= 64) for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (const n of this.cells.get(x * 4096 + y) ?? []) found.add(n);
    else this.boxes.forEach((_, n) => found.add(n));
    return found;
  }
}

const boundsKey = ({ left, right, bottom, top }: Box): string => `${left},${right},${bottom},${top}`;

/**
 * One page's labels, or why they are not the engine's (see the header). `layout`: the rectangles the original draws
 * on this page in the boxes' style (layoutOf); `shapeAt`: what the page's object at a place in its drawing order
 * paints (pdfium.ts Page.shape); `budget`: the most work judging its glyphs may take (MAX_WORK); `shows`: how much of a
 * box a text object changes as PDFium draws the page (Page.shows). Without `shows`, whatever the check cannot read is
 * taken to hide what it may cover. `inked`: how much of a glyph's ink box PDFium paints drawing its text object alone
 * (Page.inked); a glyph seen otherwise is seen only when that is SHOWN_PIXELS or more (without it, not asked).
 */
export function pageLabels(
  reading: LabelReading,
  chars: readonly PageChar[],
  index: number,
  layout: readonly Box[],
  shapeAt: (at: number) => Shape | Unread | null,
  { budget = MAX_WORK, shows, inked }: { budget?: number; shows?: (object: number, ink: Box) => number | null; inked?: (object: number, ink: Box) => number | null } = {},
): PlacedLabel[] | string {
  const where = `page ${index + 1}`;
  const outside = `${where}: a label is drawn outside a box`;
  const other = `${where}: text other than its label is in a box`;
  if (reading.nested > 0) return outside;
  // The original's rectangles not yet found in the copy, by their bounds: each excuses one rectangle of the copy.
  const spare = new Map<string, number>();
  for (const box of layout) spare.set(boundsKey(box), (spare.get(boundsKey(box)) ?? 0) + 1);
  const boxes: Array<{ at: number; bounds: Box; held: number }> = [];
  const ruled: Array<{ at: number; bounds: Box }> = [];
  const labels = new Set<number>();
  const out: PlacedLabel[] = [];
  for (const [at, mark] of reading.top.entries()) {
    if (mark.kind === 'box') {
      const left = spare.get(boundsKey(mark.bounds)) ?? 0;
      if (left > 0) {
        spare.set(boundsKey(mark.bounds), left - 1);
        ruled.push({ at, bounds: mark.bounds });
      } else boxes.push({ at, bounds: mark.bounds, held: 0 });
    }
    if (mark.kind !== 'lettering') continue;
    // Held by a box drawn before it: a label, and nothing else, in the labels' style, one to a box.
    const box = boxes.find((b) => holds(b.bounds, mark.bounds));
    if (box === undefined) {
      if (isLabel(mark.text)) return outside;
      continue;
    }
    if (!isLabel(mark.text)) return other;
    if (!mark.styled) return `${where}: a label is not in the labels' style`;
    if (++box.held > 1) return `${where}: a box holds more than one label`;
    labels.add(mark.object);
    out.push({ text: mark.text, x: mark.x, y: mark.y });
  }
  // The original's rectangles, each bounds once at the first place it is drawn, found by the area they lie on.
  let work = 0;
  const first = new Map<string, { at: number; bounds: Box }>();
  for (const rule of ruled) if (!first.has(boundsKey(rule.bounds))) first.set(boundsKey(rule.bounds), rule);
  const rules = [...first.values()];
  const index_ = new BoxIndex(rules.map((rule) => rule.bounds));
  /** The rectangles of the original drawn before `end` whose area meets the ink's. */
  const under = (ink: Box, end: number): Box[] => {
    const near = index_.around(ink);
    work += near.size;
    return [...near].flatMap((n) => {
      const rule = rules[n] as { at: number; bounds: Box };
      return rule.at < end && overlap(rule.bounds, ink) ? [rule.bounds] : [];
    });
  };
  const shapes = new Map<number, Shape | Unread | null>();
  const shape = (at: number): Shape | Unread | null => {
    if (!shapes.has(at)) shapes.set(at, shapeAt(at));
    return shapes.get(at) ?? null;
  };
  const edges = (found: Shape): number => found.outline.reduce((n, ring) => n + ring.length, 0) + found.clips.reduce((n, clip) => n + clip.reduce((k, ring) => k + ring.length, 0), 0);
  /**
   * Where the box at `at` may paint: its bounds cut by its clips' bounds; `exact` when that is all it paints (each clip
   * an upright rectangle), not when a clip is another shape or the box's path cannot be read (null: no path to read,
   * its bounds as they are).
   */
  const boxPaint = (at: number, bounds: Box): { region: Box; exact: boolean } => {
    const found = shape(at);
    if (found === null) return { region: bounds, exact: true };
    if ('unread' in found) return { region: bounds, exact: false };
    return { region: found.clips.reduce((box, clip) => cut(box, boundsOf(clip)), bounds), exact: found.clips.every(upright) };
  };
  /** The most of the ink the page's object at `at` may paint. */
  const paintShare = (at: number, ink: Box): number => {
    work += 1;
    const mark = reading.top[at];
    if (mark?.kind === 'box') return shareIn(boxPaint(at, mark.bounds).region, ink);
    const found = shape(at);
    if (found === null) return 0;
    if ('unread' in found) return shareIn(found.unread, ink);
    work += 2 * edges(found);
    const { fill, stroke } = shapeShare(found, ink);
    return Math.min(1, fill + stroke);
  };
  // The glyphs' ink, found by the area it lies on (none for a glyph with no ink).
  const inks = new BoxIndex(chars.map((c) => c.ink ?? { left: NaN, right: NaN, bottom: NaN, top: NaN }));
  /** Whether glyph `j` is drawn after glyph `i`, drawn by the object at `drawnAt`: by a later object, or later by the same one. */
  const after = (j: number, i: number, drawnAt: number): boolean => {
    const later = reading.places[j] ?? -1;
    return later > drawnAt || (later === drawnAt && j > i);
  };
  /** Whether glyph `j` is glyph `i` drawn again: the same text, its ink over half of glyph `i`'s or more. */
  const again = (j: number, i: number, ink: Box): boolean => {
    const other = chars[j] as PageChar;
    return j !== i && other.text === (chars[i] as PageChar).text && other.ink !== null && shareIn(other.ink, ink) >= 0.5 && areaOf(cut(other.ink, ink)) > 0;
  };
  /** Whether another glyph drawn after glyph `i` (drawn by the object at `drawnAt`) lies over half its ink or more. */
  const textOver = (i: number, ink: Box, drawnAt: number): boolean => {
    const near = inks.around(ink);
    work += near.size;
    return [...near].some((j) => {
      const other = chars[j] as PageChar;
      if (j === i || other.generated || other.ink === null || /^\s*$/u.test(other.text) || !after(j, i, drawnAt) || again(j, i, ink)) return false;
      return shareIn(other.ink, ink) >= 0.5 && areaOf(cut(other.ink, ink)) > 0;
    });
  };
  // Each glyph's places in the reading, by its text: a glyph not seen may be drawn again where it was.
  const byText = new Map<string, number[]>();
  for (const [i, c] of chars.entries()) {
    const list = byText.get(c.text);
    if (c.generated) continue;
    if (list === undefined) byText.set(c.text, [i]);
    else list.push(i);
  }
  /** Whether glyph `i` is drawn again where it is, before or after it, and seen there (as Publisher draws a heading twice). */
  const redrawn = (i: number, ink: Box): boolean => {
    const same = byText.get((chars[i] as PageChar).text) ?? [];
    work += same.length;
    return same.some((j) => {
      const drawnAt = reading.places[j] ?? -1;
      return again(j, i, ink) && seen(j, (chars[j] as PageChar).ink as Box, drawnAt, drawnAt < 0 ? reading.top.length : drawnAt, reading.owners[j] ?? 0);
    });
  };
  let drawings = 0;
  /**
   * Whether glyph `i`, drawn as the page's object at `end` draws it (`drawnAt` that object, or -1), is seen there: it is
   * painted opaque, no other glyph after it lies over half its ink, and of its ink at least SEEN_SHARE shows, taking
   * away what its clips leave out, what is drawn after it (and anything but text in its form), and what lies under it
   * that its paint is under 3:1 against, or that cannot be read (each piece by the most it may cover). `object`: the text
   * object PDFium's drawing of the page is asked about (Page.shows) where a picture, form or shading lies there.
   */
  const seen = (i: number, ink: Box, drawnAt: number, end: number, object: number, paint = reading.paints[i]): boolean => {
    if (reading.clipText === true || paint === undefined || !paint.opaque || textOver(i, ink, drawnAt)) return false;
    let left = (paint.clips ?? []).reduce((least, clip) => Math.min(least, clipShare(clip, ink)), 1);
    // What the check cannot read on the ink: taken away, or, with PDFium's drawing of the page, asked of that at the end.
    let unread = false;
    const unknown = (share: number): void => {
      if (shows === undefined) left -= share;
      else if (share > 0) unread = true;
    };
    for (const box of paint.beside ?? []) unknown(shareIn(box, ink));
    for (let at = end + 1; at < reading.top.length && left >= SEEN_SHARE; at++) {
      const found = reading.top[at]?.kind === 'box' ? null : shape(at);
      if (found !== null && 'unread' in found) unknown(paintShare(at, ink));
      else left -= paintShare(at, ink);
    }
    if (left < SEEN_SHARE) return false;
    // What lies under it, piece by piece, back to what holds it whole, else the page round the boxes among them.
    const rects: Box[] = [];
    let pieces = 0;
    let whole = false;
    for (let at = end - 1; at >= 0 && !whole && left >= SEEN_SHARE && pieces <= MAX_PIECES; at--) {
      const share = paintShare(at, ink);
      if (share === 0) continue;
      pieces += 1;
      const mark = reading.top[at];
      if (mark?.kind === 'box') {
        // A box its clips may cut to some other shape: what lies under the glyph there is not known.
        const { region, exact } = boxPaint(at, mark.bounds);
        if (!exact) {
          unknown(share);
          continue;
        }
        rects.push(region);
        if (!contrasts(paint.luminance, 0, false)) left -= share;
        whole = shareOf(ink, rects) >= 1;
        continue;
      }
      const found = shape(at);
      if (found === null || 'unread' in found) unknown(share);
      else {
        const { fill, stroke } = shapeShare(found, ink);
        if (stroke > 0 && !contrasts(paint.luminance, found.stroke?.luminance ?? 0, false)) left -= stroke;
        if (fill > 0 && !contrasts(paint.luminance, found.luminance ?? 0, covers(found, ink))) left -= fill;
        whole = holdsInk(found, ink);
      }
    }
    if (pieces > MAX_PIECES) return false;
    if (!whole && !contrasts(paint.luminance, 1, false)) left -= 1 - shareOf(ink, rects);
    if (left < SEEN_SHARE) return false;
    // A glyph its font draws nothing for, or a speck: PDFium paints too little of its ink drawing its object alone.
    if (inked !== undefined && (inked(object, ink) ?? 0) < SHOWN_PIXELS) return false;
    if (!unread || shows === undefined) return true;
    // A picture, form or shading lies on the ink or under it: seen only where PDFium's drawing of the page shows the
    // glyph's text object there, 3:1 against the page drawn without it.
    if (++drawings > MAX_SHOWS) return false;
    return (shows(object, ink) ?? 0) >= SHOWN_PIXELS;
  };
  const unseen = `${where}: text nobody can see lies on a black rectangle of the original`;
  for (const [i, c] of chars.entries()) {
    const place = c.box ?? c.ink;
    if (c.generated || place === null || /^\s*$/u.test(c.text) || labels.has(reading.owners[i] ?? 0)) continue;
    const drawnAt = reading.places[i] ?? -1;
    // Any other glyph drawn over a box (after it), with its centre in the box. One drawn before it, under the opaque box,
    // is hidden by it: as before the labels, the leak checks read it.
    if (boxes.some((box) => (drawnAt < 0 || box.at < drawnAt) && centreIn(box.bounds, place))) return other;
    // A glyph on rectangles of the original drawn before it (GATE-LAYOUT), ON_SHARE of its ink or more: it must be seen,
    // where it is drawn, or drawn again where it was (a glyph PDFium reads there, judged in its turn, or its text object
    // drawn again as it is, whose glyphs PDFium does not read again, judged where that is drawn).
    const ink = c.ink ?? place;
    const end = drawnAt < 0 ? reading.top.length : drawnAt;
    const found = under(ink, end);
    if (found.length > 0 && shareOf(ink, found) >= ON_SHARE) {
      if (!seen(i, ink, drawnAt, end, reading.owners[i] ?? 0) && !redrawn(i, ink) && !(reading.twins?.[i] ?? []).some((twin) => twin.at > end && seen(i, ink, twin.at, twin.at, twin.object, twin.paint))) return unseen;
    }
    if (work > budget) return `${where}: too much is drawn on the black rectangles of the original to check`;
  }
  return out;
}

/**
 * Each page of the original's rectangles in the boxes' style (0-based), or why they cannot be read. Each page is
 * flattened first, as the engine flattens it (redact.ts redactPage), so what an annotation draws is read as the
 * copy holds it.
 */
export async function layoutOf(original: Uint8Array): Promise<Box[][] | string> {
  const doc = Document.open(await pdfium(), original);
  if (doc === null) return UNREAD_ORIGINAL;
  try {
    const out: Box[][] = [];
    for (let index = 0; index < doc.pageCount; index++) {
      doc.flatten(index);
      out.push(doc.page(index, (page) => page.boxes()));
    }
    return out;
  } finally {
    doc.close();
  }
}

/**
 * Each page's labels (0-based), or why the copy's labels are not the engine's: see the header. `original`: the file
 * the copy was made from, whose own rectangles in the boxes' style are not boxes (layoutOf); a page the original has
 * not has none.
 */
export async function labelMarks(pdf: Uint8Array, original: Uint8Array): Promise<PlacedLabel[][] | string> {
  const layout = await layoutOf(original);
  if (typeof layout === 'string') return layout;
  const doc = Document.open(await pdfium(), pdf);
  if (doc === null) return 'the copy could not be opened to read its labels';
  try {
    const out: PlacedLabel[][] = [];
    for (let index = 0; index < doc.pageCount; index++) {
      const found = doc.page(index, (page) => pageLabels(page.labelReading(), page.chars().chars, index, layout[index] ?? [], (at) => page.shape(at), { shows: (object, ink) => page.shows(object, ink), inked: (object, ink) => page.inked(object, ink) }));
      if (typeof found === 'string') return found;
      out.push(found);
    }
    return out;
  } finally {
    doc.close();
  }
}

/**
 * A label as PDFium writes it (pdfium.ts drawBoxes, then GenerateContent): its place, its font's name and its size,
 * and its text in hex. PDFium names the font FXF<n>, so the name is letters and digits only: an op whose name has a
 * #XX escape, which the readers and pdf-lib decode apart (round 2, R2-1), is not a label's.
 */
const LABEL_OP = /q 1 1 1 rg 0 G 1 0 0 1 (-?\d*\.?\d+) (-?\d*\.?\d+) cm BT 1 0 0 1 0 0 Tm \/([A-Za-z0-9]+) \d*\.?\d+ Tf 0 Tr <([0-9A-F]+)> Tj ET Q/g;
const hexOf = (text: string): string => Buffer.from(text, 'latin1').toString('hex').toUpperCase();

/** A page's content streams, each by its reference. */
function contentRefs(doc: PDFDocument, value: PDFObject | undefined): PDFRef[] {
  const found = value instanceof PDFRef ? doc.context.lookup(value) : value;
  if (found instanceof PDFArray) return found.asArray().flatMap((item) => contentRefs(doc, item));
  return value instanceof PDFRef && found instanceof PDFRawStream ? [value] : [];
}

/** The font PDFium writes for a label, every key and value of it (F1). */
const LABEL_FONT: ReadonlyArray<[string, string]> = [
  ['Type', 'Font'],
  ['Subtype', 'Type1'],
  ['BaseFont', 'Helvetica'],
  ['Encoding', 'WinAnsiEncoding'],
];

/**
 * A content op's name operand as pdf-lib's parser reads the same name in a dictionary: each #XX decoded in either case
 * (R2-1: PDFName.of alone decodes only upper-case #XX), then PDFName.of, which decodes upper-case #XX a second time.
 * pdf.js and PDFium decode once, so for a name that still holds '#' after the first pass this is not what they read
 * (R3-1); no copy holding one reaches the label check (pdf-structure.ts nameBreak). LABEL_OP admits no '#', so for a
 * label this changes nothing.
 */
export function opFontName(name: string): PDFName {
  return PDFName.of(name.replace(/#([0-9A-Fa-f]{2})/g, (_escape, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))));
}

/** Whether `name` in these fonts is exactly the font PDFium writes for a label (LABEL_FONT, each value a direct name, and no other key). */
function labelFont(doc: PDFDocument, fonts: PDFObject | undefined, name: string): boolean {
  const list = doc.context.lookup(fonts);
  const font = list instanceof PDFDict ? doc.context.lookup(list.get(opFontName(name))) : undefined;
  if (!(font instanceof PDFDict) || font.keys().length !== LABEL_FONT.length) return false;
  return LABEL_FONT.every(([key, value]) => {
    const found = font.get(PDFName.of(key));
    return found instanceof PDFName && found.decodeText() === value;
  });
}

/** Whether a content stream is written as PDFium writes one: /Filter /FlateDecode alone, and no /DecodeParms (F5). */
function plainFlate(stream: PDFRawStream): boolean {
  const filter = stream.dict.get(PDFName.of('Filter'));
  return filter instanceof PDFName && filter.decodeText() === 'FlateDecode' && !stream.dict.has(PDFName.of('DecodeParms'));
}

/**
 * The copy with exactly these labels' text turned to spaces (see the header), or null when there are none, or one of
 * them is not found in its page's own content, written as PDFium writes a label, at its place, in PDFium's own label
 * font (F1), in a content stream PDFium would write (F5).
 */
export async function unlabelled(pdf: Uint8Array, labels: readonly PlacedLabel[][]): Promise<Uint8Array | null> {
  if (labels.every((page) => page.length === 0)) return null;
  const doc = await PDFDocument.load(pdf, { updateMetadata: false, throwOnInvalidObject: true });
  const pages = doc.getPages();
  if (pages.length !== labels.length) return null;
  for (const [index, placed] of labels.entries()) {
    if (placed.length === 0) continue;
    const page = pages[index] as (typeof pages)[number];
    // The page's resources as PDFium and pdf.js read them: its own, or the nearest ancestor's.
    const resources = doc.context.lookup(page.node.getInheritableAttribute(PDFName.of('Resources')));
    const fonts = resources instanceof PDFDict ? resources.get(PDFName.of('Font')) : undefined;
    const streams = contentRefs(doc, page.node.get(PDFName.of('Contents'))).map((ref) => {
      const raw = doc.context.lookup(ref) as PDFRawStream;
      // Only a stream PDFium would write is read for labels: in any other, none is found.
      return { ref, text: plainFlate(raw) ? Buffer.from(decodePDFRawStream(raw).decode()).toString('latin1') : '', changed: false };
    });
    for (const label of placed) {
      const hex = hexOf(label.text);
      let done = false;
      for (const stream of streams) {
        for (const op of stream.text.matchAll(LABEL_OP)) {
          if (op[4] !== hex || Math.abs(Number(op[1]) - label.x) > SLACK || Math.abs(Number(op[2]) - label.y) > SLACK) continue;
          if (!labelFont(doc, fonts, op[3] as string)) return null;
          const at = op.index + op[0].lastIndexOf(`<${hex}>`) + 1;
          stream.text = stream.text.slice(0, at) + '20'.repeat(hex.length / 2) + stream.text.slice(at + hex.length);
          stream.changed = true;
          done = true;
          break;
        }
        if (done) break;
      }
      if (!done) return null;
    }
    for (const stream of streams) if (stream.changed) doc.context.assign(stream.ref, doc.context.flateStream(Buffer.from(stream.text, 'latin1')));
  }
  return doc.save({ useObjectStreams: false });
}

/**
 * What `check` finds in the copy, not counting its labels' text (see the header): null when it finds nothing, or
 * finds something only in labels that pass (`labels`, from labelMarks). Else what it found in the copy as it is. The
 * second run is handed the labels as well, so a check that reads glyphs (drawn.ts) can take out only those whose
 * glyphs spell them (F1).
 */
export async function leakBreak<T>(
  pdf: Uint8Array,
  labels: PlacedLabel[][] | string,
  check: (bytes: Uint8Array, labels?: readonly PlacedLabel[][]) => Promise<T | null>,
): Promise<T | null> {
  const found = await check(pdf);
  if (found === null || typeof labels === 'string') return found;
  const masked = await unlabelled(pdf, labels);
  return masked === null ? found : check(masked, labels);
}
