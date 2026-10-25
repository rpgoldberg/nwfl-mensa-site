// ============================================================================
// A content item as one audience may see it (REDACT R2a), shared by the
// published reads (service.ts), the officers' reads (workflow.ts) and the
// newsletter export. The item's text goes through the lens (redaction/
// render.ts); its on-behalf-of name is a member's name (member_name).
// ============================================================================
import { type Lens, WITHHELD, subjectKey } from '../redaction/render.js';

/**
 * Whether the lens drops this version of the item for its audience: a mark that hides it, a passage
 * mark it no longer carries (fail closed), or a hidden on-behalf-of name.
 */
export function itemHidden(item: { id: string; on_behalf_of: string | null }, version: string, lens: Lens): boolean {
  return lens.hidden([subjectKey('content_item', item.id)], version) || (item.on_behalf_of !== null && lens.action('member_name') === 'hide');
}

/** An on-behalf-of name (member_name) as the lens's audience may see it. Call after itemHidden. */
export function bylineFor(value: string | null, subjects: readonly string[], lens: Lens): string {
  if (value === null) return '';
  return lens.action('member_name') === 'show' ? lens.text(value, subjects) : WITHHELD;
}

/**
 * The slug an audience may see. A slug is written from the title, in ASCII (0003), so it cannot be
 * checked against a mark on an accented name ("José Núñez" in memorial-jose-nunez). Fail closed:
 * an audience with anything withheld from the item, in any field, gets the item's id instead, and
 * is never told the slug in any field.
 */
export function slugFor(item: { id: string; slug: string }, lens: Lens): string {
  return lens.affected([subjectKey('content_item', item.id)]) ? item.id : item.slug;
}
