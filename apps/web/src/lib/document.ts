// An item's body (R11's allow-list, as the API sends it) as HTML, for
// set:html. Every text is escaped here, links are https: or mailto: only.
// A members-only passage is shown according to the view (A14, S5b):
//   public            a placeholder and nothing more: the API already sends the
//                     public a placeholder in its place (R26), and if it ever
//                     sent the passage itself, this would still not show it.
//                     "sign in" is a link only when the page says where.
//   signed-in-public  the same, for a reader the API answered as the public's:
//                     the box says their account has no member access yet.
//   members           the passage, escaped, in a box that says not to forward
//                     it. A redacted node here is something the API withheld
//                     from a member too (a privacy mark): a plain note that a
//                     part is not shown, and nothing about the reader's access.
import type { Block, Document, Inline } from '../gen/nwfl/mensa/v1/content_pb.js';

export const MEMBERS_PASSAGE = 'Members-only passage, sign in to read.';
export const NO_MEMBER_ACCESS = 'Members-only passage. Your account does not have member access yet.';
export const MEMBERS_RULE = "Members only, please don't forward";
/** Where the API withheld a part from a member too. */
export const NOT_SHOWN = 'Part of this text is not shown.';
const MEMBERS_INLINE = '<span class="members-note">(members only)</span>';
const NOT_SHOWN_INLINE = '<span class="members-note">(not shown)</span>';
/** The editor makes nothing near this deep; past it, nothing is rendered. */
const MAX_DEPTH = 16;

export type View = 'public' | 'signed-in-public' | 'members';

interface Options {
  view: View;
  /** Where Sign in is (public view only); none while sign-in is not set up. */
  signIn: string | undefined;
}

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

/** The box where a passage the reader may not read was. */
function placeholder({ view, signIn }: Options): string {
  if (view === 'signed-in-public') return `<p class="members-note">${NO_MEMBER_ACCESS} <a href="/help">Ask for help</a></p>`;
  if (view === 'public' && signIn !== undefined) return `<p class="members-note">Members-only passage, <a href="${escapeHtml(signIn)}">sign in</a> to read.</p>`;
  return `<p class="members-note">${MEMBERS_PASSAGE}</p>`;
}

function inlines(list: readonly Inline[], depth: number, o: Options): string {
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
          const inner = inlines(kind.value.inlines, depth + 1, o);
          const href = safeHref(kind.value.href);
          return href === undefined ? inner : `<a href="${escapeHtml(href)}">${inner}</a>`;
        }
        case 'members':
          return o.view === 'members' ? `${inlines(kind.value.inlines, depth + 1, o)} ${MEMBERS_INLINE}` : MEMBERS_INLINE;
        case 'redacted':
          return o.view === 'members' ? NOT_SHOWN_INLINE : MEMBERS_INLINE;
        default:
          return '';
      }
    })
    .join('');
}

function blocks(list: readonly Block[], level: number, depth: number, o: Options): string {
  if (depth > MAX_DEPTH) return '';
  return list
    .map((block) => {
      const kind = block.kind;
      switch (kind.case) {
        case 'paragraph':
          return `<p>${inlines(kind.value.inlines, depth + 1, o)}</p>`;
        case 'heading': {
          const h = Math.min(level + (kind.value.level === 1 ? 0 : 1), 6);
          return `<h${h}>${inlines(kind.value.inlines, depth + 1, o)}</h${h}>`;
        }
        case 'list': {
          const tag = kind.value.ordered ? 'ol' : 'ul';
          return `<${tag}>${kind.value.items.map((item) => `<li>${blocks(item.blocks, level, depth + 1, o)}</li>`).join('')}</${tag}>`;
        }
        case 'quote':
          return `<blockquote>${blocks(kind.value.blocks, level, depth + 1, o)}</blockquote>`;
        case 'image':
          return `<p class="picture-note">Picture: ${escapeHtml(kind.value.alt)}</p>`;
        case 'members':
          return o.view === 'members'
            ? `<aside class="members-passage" aria-label="Members only"><p class="members-rule">${escapeHtml(MEMBERS_RULE)}</p>${blocks(kind.value.blocks, level, depth + 1, o)}</aside>`
            : placeholder(o);
        case 'redacted':
          return o.view === 'members' ? `<p class="members-note">${NOT_SHOWN}</p>` : placeholder(o);
        default:
          return '';
      }
    })
    .join('');
}

/** The body as HTML; its headings start at `headingLevel` (h3 by default); the public view by default. */
export function documentHtml(
  document: Document | undefined,
  { headingLevel = 3, view = 'public', signIn }: { headingLevel?: number; view?: View; signIn?: string | undefined } = {},
): string {
  return document === undefined ? '' : blocks(document.blocks, headingLevel, 0, { view, signIn });
}

/** The box alone, in place of a whole members item the reader may not read (a teaser, D1): nothing of its body is read. */
export function withheldHtml({ view = 'public', signIn }: { view?: View; signIn?: string | undefined } = {}): string {
  return placeholder({ view, signIn });
}

/**
 * Whether the tree holds a node of the kind; past the depth cap, `beyondCap` for any node at all
 * (what a tree too deep to read counts as).
 */
function holds(document: Document | undefined, wanted: 'redacted' | 'members', beyondCap: boolean): boolean {
  const inBlocks = (list: readonly Block[], depth: number): boolean =>
    depth > MAX_DEPTH ? beyondCap && list.length > 0 : list.some((block) => {
      const kind = block.kind;
      if (kind.case === wanted) return true;
      switch (kind.case) {
        case 'paragraph':
        case 'heading':
          return inInlines(kind.value.inlines, depth + 1);
        case 'list':
          return kind.value.items.some((item) => inBlocks(item.blocks, depth + 1));
        case 'quote':
        case 'members':
          return inBlocks(kind.value.blocks, depth + 1);
        default:
          return false;
      }
    });
  const inInlines = (list: readonly Inline[], depth: number): boolean =>
    depth > MAX_DEPTH ? beyondCap && list.length > 0 : list.some((inline) => {
      const kind = inline.kind;
      if (kind.case === wanted) return true;
      switch (kind.case) {
        case 'link':
        case 'members':
          return inInlines(kind.value.inlines, depth + 1);
        default:
          return false;
      }
    });
  return document !== undefined && inBlocks(document.blocks, 0);
}

/** Whether the API sent any redacted node. Past the depth cap, anything at all counts: a tree too deep to read is read as the public's (fail closed). */
export function hasRedacted(document: Document | undefined): boolean {
  return holds(document, 'redacted', true);
}

/**
 * Whether the API sent any members node: the API sends one only to a caller it reads as a member or an
 * officer, since the public's tree is filtered (filterForPublic in the API) before it leaves (A14). Past
 * the depth cap, nothing counts: a tree too deep to read proves nothing (fail closed).
 */
export function hasMembers(document: Document | undefined): boolean {
  return holds(document, 'members', false);
}
