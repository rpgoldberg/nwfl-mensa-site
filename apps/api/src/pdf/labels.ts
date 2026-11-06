// ============================================================================
// BOXLABEL (Ross, 11-05): what each redaction box says, replacing "withheld".
//
//   in the public copy, text members can see   "Members Only" where it fits
//                                              at a readable size, else
//                                              "Mbrs Only", else no label;
//   text members cannot see either, in the     "Private" where it fits, else
//   public copy or in the members copy         no label.
//
// Title case exactly as written, no period after "Mbrs". "Fits" is
// REDACT-LOOK's readable-size rule (labelSize), for each string at its own
// width, measured from Helvetica's own widths (its AFM metrics). A box too
// narrow for a readable label is an opaque box alone; a label is never shrunk
// below that size to fit. Which kind a box is the engine decides per box
// (redact.ts), from whether a passage it covers is one members withhold too.
// The output gate takes exactly these three strings, drawn inside a box in
// the label style, and nothing else (gate-labels.ts).
// ============================================================================
import type { Region } from './match.js';

/** The labels, exactly as drawn. */
export const LABELS = ['Members Only', 'Mbrs Only', 'Private'] as const;
export type Label = (typeof LABELS)[number];

/** Whether a string is exactly one of the labels. */
export const isLabel = (text: string): text is Label => (LABELS as readonly string[]).includes(text);

/** Helvetica's advance widths (its AFM metrics, in thousandths of an em) for the labels' glyphs. */
const HELVETICA: Readonly<Record<string, number>> = { ' ': 278, M: 833, O: 778, P: 667, a: 556, b: 556, e: 556, i: 222, l: 222, m: 833, n: 556, r: 333, s: 500, t: 278, v: 500, y: 500 };

/** Each label's advance in Helvetica, in ems. */
export const LABEL_EMS: Readonly<Record<Label, number>> = Object.fromEntries(LABELS.map((label) => [label, [...label].reduce((sum, glyph) => sum + (HELVETICA[glyph] as number), 0) / 1000])) as Record<Label, number>;

/** The smallest label drawn, in points: below it a box has no label (REDACT-LOOK: legible to older readers at 100 %). */
export const MIN_LABEL_PT = 7;
/** The space kept clear between the label and each side of its box, in points. */
export const LABEL_PAD = 1;

/**
 * The size of `label` in a box, or null when it does not fit: 0.8 of the passage's type size, smaller to fit the
 * box's height and width (a point clear each side), but never below MIN_LABEL_PT or 0.6 of the type size.
 */
export function labelSize(region: Region, label: Label): number | null {
  const size = Math.min(0.8 * region.fontSize, 0.8 * (region.top - region.bottom), (region.right - region.left - 2 * LABEL_PAD) / LABEL_EMS[label]);
  return size < Math.max(MIN_LABEL_PT, 0.6 * region.fontSize) ? null : size;
}

/** Who a box's text is withheld from: the public only ("members", who can see it), or members too ("private"). */
export type BoxKind = 'members' | 'private';

const CHOICES: Readonly<Record<BoxKind, readonly Label[]>> = { members: ['Members Only', 'Mbrs Only'], private: ['Private'] };

/** The label a box of this kind gets, and its size: the first of its choices that fits, or null for none. */
export function labelFor(region: Region, kind: BoxKind): { text: Label; size: number } | null {
  for (const text of CHOICES[kind]) {
    const size = labelSize(region, text);
    if (size !== null) return { text, size };
  }
  return null;
}
