// ============================================================================
// What of a text a reader sees. One rule for a reviewer's note (link-gate.ts
// keptNote) and for a configured audience, scope or subject (auth/config.ts):
// a text made only of characters that draw nothing is blank.
// ============================================================================
import { CONTROLS } from '../links/urls.js';

// Something a reader sees: not a mark with no letter under it, a space, a control or format character,
// one that is ignored when shown, a blank braille cell, or one of two symbols that draw nothing (the
// object replacement character and the musical null notehead).
const VISIBLE = /[^\p{M}\p{Z}\p{C}\p{Default_Ignorable_Code_Point}\u2800\ufffc\u{1d159}]/u;

/**
 * A text as kept: the control and format characters (links/urls.ts CONTROL: zero-width, direction
 * overrides, a byte order mark and the like) taken out, then trimmed. Null when nothing a reader sees is
 * left.
 */
export function seenText(given: string): string | null {
  const text = given.replace(CONTROLS, '').trim();
  return VISIBLE.test(text) ? text : null;
}
