// ============================================================================
// The body tree and THE public filter (R26, P17, addendum-publishing section 4).
//
// `body_ast` is stored as JSON: { blocks: Block[] }, with exactly the editor's
// allow-list (R11). Three rules hold everywhere below:
//
//   1. Rebuild, never pass through. Every node is reconstructed from its known
//      fields, so a stray field (a colour, a style, a payload) cannot ride along.
//   2. Fail closed. A node the API cannot vouch for (an unknown type, a bad
//      field, a link that is not https: or mailto:, a tree nested too deep) is
//      treated as members-only: it becomes a placeholder. A text node that
//      still holds members-marker syntax means the markup parser met a broken
//      marker; that block and every block after it become members-only.
//   3. The placeholder is bare. `{ type: 'redacted' }` carries no text, no
//      length, no link target and no image reference, so the public cannot
//      even count characters.
//
// filterForPublic() derives `public_ast` at approval; anonymous reads load
// only that column and pass it through the filter again, which is idempotent.
// ============================================================================
import { create } from '@bufbuild/protobuf';
import {
  type Block as ProtoBlock,
  type Document as ProtoDocument,
  type Inline as ProtoInline,
  BlockSchema,
  DocumentSchema,
  InlineSchema,
} from '../gen/nwfl/mensa/v1/content_pb.js';

export interface Redacted {
  type: 'redacted';
}
export type Inline =
  | { type: 'text'; text: string; bold: boolean; italic: boolean }
  | { type: 'link'; href: string; children: Inline[] }
  | { type: 'members'; children: Inline[] }
  | Redacted;
export type Block =
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'heading'; level: 1 | 2; children: Inline[] }
  | { type: 'list'; ordered: boolean; items: Block[][] }
  | { type: 'quote'; children: Block[] }
  | { type: 'image'; fileId: string; alt: string }
  | { type: 'members'; children: Block[] }
  | Redacted;
export interface Tree {
  blocks: Block[];
}

const REDACTED: Redacted = { type: 'redacted' };
const MAX_DEPTH = 24;
const MAX_TEXT = 100_000;
const SAFE_HREF = /^(https:\/\/|mailto:)[^\s]+$/;
const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Directive syntax the markup parser should have consumed (section 6):
// `:members[...]` inline and a `:::` fence line for blocks.
const BROKEN_MARKER = /:members\[|^\s*:::/m;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

function inline(node: unknown, depth: number): Inline {
  if (!isObject(node) || depth > MAX_DEPTH) return REDACTED;
  switch (node['type']) {
    case 'text': {
      const value = node['text'];
      if (typeof value !== 'string' || value.length > MAX_TEXT) return REDACTED;
      return { type: 'text', text: value, bold: node['bold'] === true, italic: node['italic'] === true };
    }
    case 'link': {
      const href = node['href'];
      const children = node['children'];
      if (typeof href !== 'string' || !SAFE_HREF.test(href) || !Array.isArray(children)) return REDACTED;
      return { type: 'link', href, children: children.map((child) => inline(child, depth + 1)) };
    }
    case 'members': {
      const children = node['children'];
      if (!Array.isArray(children)) return REDACTED;
      return { type: 'members', children: children.map((child) => inline(child, depth + 1)) };
    }
    default:
      return REDACTED;
  }
}

function inlines(value: unknown, depth: number): Inline[] | undefined {
  return Array.isArray(value) ? value.map((child) => inline(child, depth + 1)) : undefined;
}

function blocks(value: unknown, depth: number): Block[] | undefined {
  return Array.isArray(value) ? value.map((child) => block(child, depth + 1)) : undefined;
}

function block(node: unknown, depth: number): Block {
  if (!isObject(node) || depth > MAX_DEPTH) return REDACTED;
  switch (node['type']) {
    case 'paragraph': {
      const children = inlines(node['children'], depth);
      return children ? { type: 'paragraph', children } : REDACTED;
    }
    case 'heading': {
      const level = node['level'];
      const children = inlines(node['children'], depth);
      return (level === 1 || level === 2) && children ? { type: 'heading', level, children } : REDACTED;
    }
    case 'list': {
      const items = node['items'];
      if (!Array.isArray(items) || !items.every(Array.isArray)) return REDACTED;
      return { type: 'list', ordered: node['ordered'] === true, items: items.map((item: unknown[]) => item.map((child) => block(child, depth + 2))) };
    }
    case 'quote': {
      const children = blocks(node['children'], depth);
      return children ? { type: 'quote', children } : REDACTED;
    }
    case 'image': {
      const fileId = node['fileId'];
      const alt = node['alt'];
      if (typeof fileId !== 'string' || !FILE_ID.test(fileId) || typeof alt !== 'string' || alt.trim() === '') return REDACTED;
      return { type: 'image', fileId, alt };
    }
    case 'members': {
      const children = blocks(node['children'], depth);
      return children ? { type: 'members', children } : REDACTED;
    }
    default:
      return REDACTED;
  }
}

function hasBrokenMarker(node: Block | Inline): boolean {
  switch (node.type) {
    case 'text':
      return BROKEN_MARKER.test(node.text);
    case 'paragraph':
    case 'heading':
    case 'link':
    case 'quote':
    case 'members':
      return (node.children as Array<Block | Inline>).some(hasBrokenMarker);
    case 'list':
      return node.items.some((item) => item.some(hasBrokenMarker));
    default:
      return false;
  }
}

/** Validate and rebuild a stored tree. Never throws: what it cannot vouch for becomes members-only or a placeholder. */
export function normalizeTree(json: unknown): Tree {
  if (!isObject(json) || !Array.isArray(json['blocks'])) return { blocks: [REDACTED] };
  const rebuilt = json['blocks'].map((child) => block(child, 0));
  const broken = rebuilt.findIndex(hasBrokenMarker);
  if (broken === -1) return { blocks: rebuilt };
  return { blocks: [...rebuilt.slice(0, broken), { type: 'members', children: rebuilt.slice(broken) }] };
}

function publicInline(node: Inline): Inline {
  switch (node.type) {
    case 'text':
      return node;
    case 'link': {
      // A link whose text holds a members passage is members-only whole: its
      // target is what the passage hides (`[:members[Zoom room]](https://...pwd=...)`).
      const children = node.children.map(publicInline);
      return children.some((child) => child.type === 'redacted') ? REDACTED : { ...node, children };
    }
    default:
      return REDACTED;
  }
}

function publicBlock(node: Block): Block {
  switch (node.type) {
    case 'paragraph':
    case 'heading':
      return { ...node, children: node.children.map(publicInline) };
    case 'list':
      return { ...node, items: node.items.map((item) => item.map(publicBlock)) };
    case 'quote':
      return { ...node, children: node.children.map(publicBlock) };
    case 'image':
      return node;
    default:
      return REDACTED;
  }
}

/** The tree as the public may see it. Takes a NORMALIZED tree. */
export function filterForPublic(tree: Tree): Tree {
  return { blocks: tree.blocks.map(publicBlock) };
}

// Every node but a text run is a word boundary: list items, nested blocks,
// links, members passages and placeholders. Adjacent text runs are joined as
// they are, since emphasis can change inside a word.
function words(node: Block | Inline, out: string[]): void {
  if (node.type === 'text') {
    out.push(node.text);
    return;
  }
  out.push(' ');
  switch (node.type) {
    case 'image':
      out.push(node.alt);
      break;
    case 'list':
      node.items.forEach((item) => item.forEach((child) => words(child, out)));
      break;
    case 'redacted':
      break;
    default:
      (node.children as Array<Block | Inline>).forEach((child) => words(child, out));
  }
  out.push(' ');
}

/** The searchable words of a tree, one block per line. Placeholders contribute nothing but a word boundary. */
export function plainText(tree: Tree): string {
  return tree.blocks
    .map((node) => {
      const out: string[] = [];
      words(node, out);
      return out.join('').replace(/\s+/g, ' ').trim();
    })
    .filter((line) => line !== '')
    .join('\n');
}

function images(node: Block | Inline, out: string[]): void {
  switch (node.type) {
    case 'image':
      out.push(node.fileId);
      return;
    case 'list':
      node.items.forEach((item) => item.forEach((child) => images(child, out)));
      return;
    case 'text':
    case 'redacted':
      return;
    default:
      (node.children as Array<Block | Inline>).forEach((child) => images(child, out));
  }
}

/** Image file ids, split by whether any public passage references them (section 4 rule 4). */
export function referencedFiles(tree: Tree): { all: string[]; publicOnly: string[]; membersOnly: string[] } {
  const all: string[] = [];
  const visible: string[] = [];
  tree.blocks.forEach((node) => images(node, all));
  filterForPublic(tree).blocks.forEach((node) => images(node, visible));
  const unique = [...new Set(all)];
  const publicSet = new Set(visible);
  return { all: unique, publicOnly: unique.filter((id) => publicSet.has(id)), membersOnly: unique.filter((id) => !publicSet.has(id)) };
}

export interface Derived {
  /** What an anonymous read loads. A members or officers item has no public body: one placeholder. */
  publicAst: Tree;
  /** Feeds search_public: what the public may see, title and summary included (D-P5). */
  publicText: string;
  /** Feeds search_members: title, summary and the whole tree. */
  membersText: string;
}

/**
 * What approval writes beside the version: public_ast and the text behind both
 * search indexes, by whole-item visibility (addendum-publishing section 3):
 *   public    the filtered tree; the public index holds title, summary and it;
 *   members   one placeholder; the public index holds title and summary only;
 *   officers  one placeholder; neither index holds anything, title included,
 *             as the item is 404 to everyone but officers.
 */
export function deriveForApproval(version: { title: string; summary: string | null; visibility: string; body: unknown }): Derived {
  const tree = normalizeTree(version.body);
  const head = [version.title, version.summary ?? ''].filter((line) => line !== '');
  const join = (body: string): string => [...head, body].filter((line) => line !== '').join('\n');
  if (version.visibility === 'public') {
    const publicAst = filterForPublic(tree);
    return { publicAst, publicText: join(plainText(publicAst)), membersText: join(plainText(tree)) };
  }
  const placeholder: Tree = { blocks: [REDACTED] };
  if (version.visibility === 'members') return { publicAst: placeholder, publicText: join(''), membersText: join(plainText(tree)) };
  return { publicAst: placeholder, publicText: '', membersText: '' };
}

function protoInline(node: Inline): ProtoInline {
  switch (node.type) {
    case 'text':
      return create(InlineSchema, { kind: { case: 'text', value: { text: node.text, bold: node.bold, italic: node.italic } } });
    case 'link':
      return create(InlineSchema, { kind: { case: 'link', value: { href: node.href, inlines: node.children.map(protoInline) } } });
    case 'members':
      return create(InlineSchema, { kind: { case: 'members', value: { inlines: node.children.map(protoInline) } } });
    default:
      return create(InlineSchema, { kind: { case: 'redacted', value: {} } });
  }
}

function protoBlock(node: Block): ProtoBlock {
  switch (node.type) {
    case 'paragraph':
      return create(BlockSchema, { kind: { case: 'paragraph', value: { inlines: node.children.map(protoInline) } } });
    case 'heading':
      return create(BlockSchema, { kind: { case: 'heading', value: { level: node.level, inlines: node.children.map(protoInline) } } });
    case 'list':
      return create(BlockSchema, {
        kind: { case: 'list', value: { ordered: node.ordered, items: node.items.map((item) => ({ blocks: item.map(protoBlock) })) } },
      });
    case 'quote':
      return create(BlockSchema, { kind: { case: 'quote', value: { blocks: node.children.map(protoBlock) } } });
    case 'image':
      return create(BlockSchema, { kind: { case: 'image', value: { fileId: node.fileId, alt: node.alt } } });
    case 'members':
      return create(BlockSchema, { kind: { case: 'members', value: { blocks: node.children.map(protoBlock) } } });
    default:
      return create(BlockSchema, { kind: { case: 'redacted', value: {} } });
  }
}

export function toProtoDocument(tree: Tree): ProtoDocument {
  return create(DocumentSchema, { blocks: tree.blocks.map(protoBlock) });
}
