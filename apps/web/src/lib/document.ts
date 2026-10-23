// An item's body (R11's allow-list, as the API sends it) as HTML, for
// set:html. Every text is escaped here, links are https: or mailto: only, and
// a members-only passage is shown as a placeholder and nothing more: the API
// already sends the public a placeholder in its place (R26), and if it ever
// sent the passage itself, this would still not show it.
import type { Block, Document, Inline } from '../gen/nwfl/mensa/v1/content_pb.js';

export const MEMBERS_PASSAGE = 'Members-only passage, sign in to read.';
const MEMBERS_INLINE = '<span class="members-note">(members only)</span>';
/** The editor makes nothing near this deep; past it, nothing is rendered. */
const MAX_DEPTH = 16;

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ENTITIES[c]!);
}

function safeHref(href: string): string | undefined {
  if (href !== href.trim()) return undefined;
  try {
    const url = new URL(href);
    return url.protocol === 'https:' || url.protocol === 'mailto:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function inlines(list: readonly Inline[], depth: number): string {
  if (depth > MAX_DEPTH) return '';
  return list
    .map((inline) => {
      const kind = inline.kind;
      switch (kind.case) {
        case 'text': {
          let html = escapeHtml(kind.value.text);
          if (kind.value.italic) html = `<em>${html}</em>`;
          if (kind.value.bold) html = `<strong>${html}</strong>`;
          return html;
        }
        case 'link': {
          const inner = inlines(kind.value.inlines, depth + 1);
          const href = safeHref(kind.value.href);
          return href === undefined ? inner : `<a href="${escapeHtml(href)}">${inner}</a>`;
        }
        case 'members':
        case 'redacted':
          return MEMBERS_INLINE;
        default:
          return '';
      }
    })
    .join('');
}

function blocks(list: readonly Block[], level: number, depth: number): string {
  if (depth > MAX_DEPTH) return '';
  return list
    .map((block) => {
      const kind = block.kind;
      switch (kind.case) {
        case 'paragraph':
          return `<p>${inlines(kind.value.inlines, depth + 1)}</p>`;
        case 'heading': {
          const h = Math.min(level + (kind.value.level === 1 ? 0 : 1), 6);
          return `<h${h}>${inlines(kind.value.inlines, depth + 1)}</h${h}>`;
        }
        case 'list': {
          const tag = kind.value.ordered ? 'ol' : 'ul';
          return `<${tag}>${kind.value.items.map((item) => `<li>${blocks(item.blocks, level, depth + 1)}</li>`).join('')}</${tag}>`;
        }
        case 'quote':
          return `<blockquote>${blocks(kind.value.blocks, level, depth + 1)}</blockquote>`;
        case 'image':
          return `<p class="picture-note">Picture: ${escapeHtml(kind.value.alt)}</p>`;
        case 'members':
        case 'redacted':
          return `<p class="members-note">${MEMBERS_PASSAGE}</p>`;
        default:
          return '';
      }
    })
    .join('');
}

/** The body as HTML; its headings start at `headingLevel` (h3 by default). */
export function documentHtml(document: Document | undefined, { headingLevel = 3 }: { headingLevel?: number } = {}): string {
  return document === undefined ? '' : blocks(document.blocks, headingLevel, 0);
}
