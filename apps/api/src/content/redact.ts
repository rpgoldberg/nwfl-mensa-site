// ============================================================================
// A content item as one audience may see it (REDACT R2a), shared by the
// published reads (service.ts), the officers' reads (workflow.ts) and the
// newsletter export. The item's text goes through the lens (redaction/
// render.ts); its on-behalf-of name is a member's name (member_name).
// ============================================================================
import { type Lens, WITHHELD, subjectKey } from '../redaction/render.js';

/** Whether the lens drops this item for its audience: a mark that hides it, or a hidden on-behalf-of name. */
export function itemHidden(item: { id: string; on_behalf_of: string | null }, lens: Lens): boolean {
  return lens.hidden([subjectKey('content_item', item.id)]) || (item.on_behalf_of !== null && lens.action('member_name') === 'hide');
}

/** An on-behalf-of name (member_name) as the lens's audience may see it. Call after itemHidden. */
export function bylineFor(value: string | null, subjects: readonly string[], lens: Lens): string {
  if (value === null) return '';
  return lens.action('member_name') === 'show' ? lens.text(value, subjects) : WITHHELD;
}
