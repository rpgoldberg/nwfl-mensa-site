// ============================================================================
// The per-audience lens (REDACT R2a), as pure functions: what one audience may
// see of an item, given the group's policy (0012) and the item's marks (0014).
// Every read path builds its response from what the lens returns, never from
// the stored text beside it.
//
//   A passage mark withholds its text wherever it appears in the item, matched
//   without regard to case or spacing, when the policy REDACTS its category for
//   this audience. The text becomes "[withheld]": one fixed placeholder, so the
//   length of what was there is not given away.
//   An item is dropped when a passage mark's category is HIDDEN, or when a
//   whole-item mark's category is anything but SHOWN. An unknown audience,
//   category or action reads as HIDE (policy.ts).
//
// In a body tree the text is matched across emphasis runs and links within a
// block, a link whose target carries the text loses the target, and if the
// text still appears anywhere afterwards (it crossed a block boundary), the
// whole body is withheld.
// ============================================================================
import type { Block, Inline, Tree } from '../content/tree.js';
import { type Action, type Policy, resolveAction } from './policy.js';

export const WITHHELD = '[withheld]';

export type SubjectKind = 'content_item' | 'event_series' | 'event_occurrence';

/** An active mark, as the lens needs it: whose it is, its text (null: the whole item) and its category. */
export interface MarkRow {
  subject: string;
  quote: string | null;
  category: string;
}

export const subjectKey = (kind: SubjectKind, id: string): string => `${kind}:${id}`;

/** A venue's category: only a business is a business venue; a home, a virtual room or anything unknown is private. */
export const venueCategory = (kind: string): 'business_venue' | 'private_venue' => (kind === 'business' ? 'business_venue' : 'private_venue');

export interface Lens {
  readonly audience: string;
  /** The policy's action for a structured field's category, fail-closed. */
  action(category: string): Action;
  /** Whether these subjects' item is dropped for this audience. */
  hidden(subjects: readonly string[]): boolean;
  /** Whether any mark on these subjects changes what this audience sees. */
  affected(subjects: readonly string[]): boolean;
  text(value: string, subjects: readonly string[]): string;
  tree(tree: Tree, subjects: readonly string[]): Tree;
}

const PLACEHOLDER: Tree = { blocks: [{ type: 'redacted' }] };

/** The quote as a pattern: its words literally, any run of spacing between them. */
function patternOf(quote: string): RegExp {
  const words = quote
    .trim()
    .split(/\s+/u)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(words.join('\\s+'), 'giu');
}

/** Every match of every pattern, merged where they touch or overlap, in order. */
function ranges(value: string, patterns: readonly RegExp[]): Array<[number, number]> {
  const found: Array<[number, number]> = [];
  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) found.push([match.index, match.index + match[0].length]);
  }
  found.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of found) {
    const last = merged.at(-1);
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function withhold(value: string, patterns: readonly RegExp[]): string {
  let out = '';
  let at = 0;
  for (const [start, end] of ranges(value, patterns)) {
    out += value.slice(at, start) + WITHHELD;
    at = end;
  }
  return out + value.slice(at);
}

/** A link target, decoded where it can be, so an escaped quote is matched too. */
function decoded(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

const matches = (value: string, patterns: readonly RegExp[]): boolean => ranges(value, patterns).length > 0;

/** A link whose target carries the text keeps its words but loses the target, at any depth. */
function unwrapLinks(nodes: Inline[], patterns: readonly RegExp[]): Inline[] {
  return nodes.flatMap((node): Inline[] => {
    if (node.type === 'link') {
      const children = unwrapLinks(node.children, patterns);
      return matches(node.href, patterns) || matches(decoded(node.href), patterns) ? children : [{ ...node, children }];
    }
    if (node.type === 'members') return [{ ...node, children: unwrapLinks(node.children, patterns) }];
    return [node];
  });
}

/** A run of inlines with the marked text cut out across its text nodes. */
function redactInlines(nodes: Inline[], patterns: readonly RegExp[]): Inline[] {
  const unwrapped = unwrapLinks(nodes, patterns);
  // The text leaves, in order: the run is matched as their joined text.
  const leaves: Array<{ text: string }> = [];
  const collect = (list: Inline[]): void =>
    list.forEach((node) => {
      if (node.type === 'text') leaves.push(node);
      else if (node.type === 'link' || node.type === 'members') collect(node.children);
    });
  collect(unwrapped);
  const joined = leaves.map((leaf) => leaf.text).join('');
  const cut = ranges(joined, patterns);
  if (cut.length === 0) return unwrapped;
  // Each leaf keeps its characters outside the cut; a cut's placeholder goes where it starts.
  const replaced = new Map<{ text: string }, string>();
  let offset = 0;
  for (const leaf of leaves) {
    let out = '';
    for (let i = offset; i < offset + leaf.text.length; i++) {
      const inside = cut.find(([from, to]) => i >= from && i < to);
      if (inside === undefined) out += joined[i];
      else if (inside[0] === i) out += WITHHELD;
    }
    offset += leaf.text.length;
    replaced.set(leaf, out);
  }
  const rebuild = (list: Inline[]): Inline[] =>
    list.flatMap((node): Inline[] => {
      if (node.type === 'text') {
        const text = replaced.get(node) as string;
        return text === '' ? [] : [{ ...node, text }];
      }
      if (node.type === 'link' || node.type === 'members') return [{ ...node, children: rebuild(node.children) }];
      return [node];
    });
  return rebuild(unwrapped);
}

function redactBlock(node: Block, patterns: readonly RegExp[]): Block {
  switch (node.type) {
    case 'paragraph':
    case 'heading':
      return { ...node, children: redactInlines(node.children, patterns) };
    case 'list':
      return { ...node, items: node.items.map((item) => item.map((child) => redactBlock(child, patterns))) };
    case 'quote':
    case 'members':
      return { ...node, children: node.children.map((child) => redactBlock(child, patterns)) };
    case 'image':
      return { ...node, alt: withhold(node.alt, patterns) };
    default:
      return node;
  }
}

/** Every string a tree carries, block by block, for the after-check. */
function strings(node: Block | Inline, out: string[]): void {
  switch (node.type) {
    case 'text':
      out.push(node.text);
      return;
    case 'image':
      out.push(' ', node.alt, ' ');
      return;
    case 'link':
      out.push(' ', node.href, ' ', decoded(node.href), ' ');
      node.children.forEach((child) => strings(child, out));
      return;
    case 'list':
      node.items.forEach((item) => item.forEach((child) => strings(child, out)));
      return;
    case 'redacted':
      return;
    default:
      out.push(' ');
      (node.children as Array<Block | Inline>).forEach((child) => strings(child, out));
      out.push(' ');
  }
}

export function lensFor(audience: string, policy: Policy, marks: readonly MarkRow[]): Lens {
  const actionOf = (category: string): Action => resolveAction(policy, audience, category);
  const of = (subjects: readonly string[]): MarkRow[] => marks.filter((mark) => subjects.includes(mark.subject));
  const patterns = (subjects: readonly string[]): RegExp[] =>
    of(subjects).flatMap((mark) => (mark.quote !== null && actionOf(mark.category) === 'redact' ? [patternOf(mark.quote)] : []));

  return {
    audience,
    action: actionOf,
    hidden: (subjects) =>
      of(subjects).some((mark) => {
        const action = actionOf(mark.category);
        return action === 'hide' || (mark.quote === null && action !== 'show');
      }),
    affected: (subjects) => of(subjects).some((mark) => actionOf(mark.category) !== 'show'),
    text: (value, subjects) => {
      const list = patterns(subjects);
      return list.length === 0 ? value : withhold(value, list);
    },
    tree: (tree, subjects) => {
      const list = patterns(subjects);
      if (list.length === 0) return tree;
      const out: Tree = { blocks: tree.blocks.map((node) => redactBlock(node, list)) };
      const left: string[] = [];
      out.blocks.forEach((node) => {
        strings(node, left);
        left.push('\n');
      });
      return matches(left.join(''), list) ? PLACEHOLDER : out;
    },
  };
}
