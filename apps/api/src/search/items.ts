// ============================================================================
// ARCHIVE-SEARCH S1: a news item's row in the search index.
//
// The row's text is the plain text of the very ContentItem the publication
// ledger hashed for the audience (ledger.ts renderVersion): the message
// GetPublishedItem returns, after the lens. So a redacted passage and a
// members-only one are not in the public row for the same reason they are not
// in the public read, and the row's sha is the ledger's.
//
// NEVER content_version's own two search columns (finding F1): they are derived
// at approval, before any redaction mark is applied.
//
// The write goes through search_item_put (0032), which refuses unless the
// ledger's current output for the version and audience is the sha given.
// ============================================================================
import type { Block, ContentItem, Inline } from '../gen/nwfl/mensa/v1/content_pb.js';
import type { SearchAudience } from './tables.js';
import { capUtf8, plain } from './text.js';

interface Query {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

/** 0032's caps: a title of at most 1 KiB and a text of at most 128 KiB, so the row's tsvector stays under Postgres's 1 MiB. */
export const MAX_TITLE_BYTES = 1024;
export const MAX_TEXT_BYTES = 131_072;

export interface ItemText {
  title: string;
  text: string;
}

function inlineText(inline: Inline): string {
  switch (inline.kind.case) {
    case 'text':
      return inline.kind.value.text;
    case 'link':
    case 'members':
      return inline.kind.value.inlines.map(inlineText).join('');
    default:
      // A redacted span: a space, so the words either side of it stay two words.
      return ' ';
  }
}

function blockLines(block: Block): string[] {
  switch (block.kind.case) {
    case 'paragraph':
    case 'heading':
      return [block.kind.value.inlines.map(inlineText).join('')];
    case 'list':
      return block.kind.value.items.flatMap((item) => item.blocks.flatMap(blockLines));
    case 'quote':
    case 'members':
      return block.kind.value.blocks.flatMap(blockLines);
    case 'image':
      return [block.kind.value.alt];
    default:
      // A redacted block.
      return [];
  }
}

/**
 * What the index holds for an item as an audience is given it: its title, and its summary and body as plain
 * text, one block a line. Null when there is nothing to search: no item, or a withdrawn item's stub.
 */
export function itemText(item: ContentItem | null | undefined): ItemText | null {
  const version = item?.live;
  if (version === undefined) return null;
  const lines = [version.summary, ...(version.body?.blocks ?? []).flatMap(blockLines)];
  return { title: capUtf8(plain(version.title).replaceAll('\n', ' '), MAX_TITLE_BYTES), text: capUtf8(plain(lines.join('\n')), MAX_TEXT_BYTES) };
}

/** Writes, replaces or deletes the audience's row for the version, as what the ledger just recorded says. */
export async function putItem(db: Query, versionId: string, audience: SearchAudience, rendering: { output: Buffer | null; item?: ContentItem | null }): Promise<void> {
  const indexed = rendering.output === null ? null : itemText(rendering.item);
  await db.query(`SELECT search_item_put($1, $2, $3, $4, $5)`, [versionId, audience, rendering.output, indexed?.title ?? null, indexed?.text ?? null]);
}
