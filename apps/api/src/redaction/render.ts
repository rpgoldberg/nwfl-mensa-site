// ============================================================================
// The per-audience lens (REDACT R2a), as pure functions: what one audience may
// see of an item, given the group's policy (0012) and the item's marks (0014).
// Every read path builds its response from what the lens returns, never from
// the stored text beside it.
//
//   A passage mark withholds its text wherever it appears in the item, matched
//   as whole words after folding (see Matching), when the policy REDACTS its category for
//   this audience. The text becomes "[withheld]": one fixed placeholder, so the
//   length of what was there is not given away.
//   An item is dropped when a passage mark's category is HIDDEN, or when a
//   whole-item mark's category is anything but SHOWN, or when a passage mark
//   this audience redacts no longer matches the item's text anywhere (fail
//   closed, until an officer re-marks it or two officers remove it). An unknown audience,
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

/**
 * An active mark, as the lens needs it: whose it is, its text (null: the whole item), its category,
 * and where its text was found: the content versions, or the event subject, it matches in (lens.ts
 * sets this for every mark it loads; a mark without it is not anchor-checked).
 */
export interface MarkRow {
  subject: string;
  quote: string | null;
  category: string;
  anchoredIn?: ReadonlySet<string>;
}

export const subjectKey = (kind: SubjectKind, id: string): string => `${kind}:${id}`;

/** A venue's category: only a business is a business venue; a home, a virtual room or anything unknown is private. */
export const venueCategory = (kind: string): 'business_venue' | 'private_venue' => (kind === 'business' ? 'business_venue' : 'private_venue');

export interface Lens {
  readonly audience: string;
  /** The policy's action for a structured field's category, fail-closed. */
  action(category: string): Action;
  /**
   * Whether these subjects' item is dropped for this audience. `version` is the content version
   * about to be shown: a passage mark this audience redacts must be found in it, or the item is
   * dropped (fail closed: the text was changed so the mark no longer finds it).
   */
  hidden(subjects: readonly string[], version?: string): boolean;
  /** Whether any mark on these subjects changes what this audience sees. */
  affected(subjects: readonly string[]): boolean;
  text(value: string, subjects: readonly string[]): string;
  tree(tree: Tree, subjects: readonly string[]): Tree;
}

const PLACEHOLDER: Tree = { blocks: [{ type: 'redacted' }] };

// ---------------------------------------------------------------------------
// Matching. Text and quote are both folded before they are compared: percent-
// encodings decoded (twice-encoded too), combining marks kept with their base
// letter, NFKC (full-width and compatibility forms), a full case fold (ß and
// SS alike), and Default_Ignorable_Code_Point characters (soft hyphens, zero-
// width spaces and joiners) removed. Each folded character remembers the span
// of the original it came from, so a match cuts the original text.
//
// A quote matches as whole words: its words in order, separated by any run of
// characters that are not letters, digits or marks (spaces, dots, hyphens, a
// "+" in a link), and never inside a longer word: "Ann" does not match
// "Annual".
// ---------------------------------------------------------------------------

interface Unit {
  text: string;
  start: number;
  end: number;
}

const WORD = '\\p{L}\\p{N}\\p{M}';
const NOT_WORD = new RegExp(`[^${WORD}]+`, 'u');
const HEX = /^[0-9a-f]$/i;
const COMBINING = /^\p{M}/u;
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;
const utf8 = new TextDecoder('utf-8');

/** Runs of %XX decoded as UTF-8; each decoded character spans the whole run. */
function percentDecoded(units: Unit[]): Unit[] {
  const out: Unit[] = [];
  for (let i = 0; i < units.length; ) {
    const bytes: number[] = [];
    let j = i;
    while (units[j]?.text === '%' && HEX.test(units[j + 1]?.text ?? '') && HEX.test(units[j + 2]?.text ?? '')) {
      bytes.push(parseInt(`${(units[j + 1] as Unit).text}${(units[j + 2] as Unit).text}`, 16));
      j += 3;
    }
    if (bytes.length === 0) {
      out.push(units[i] as Unit);
      i += 1;
      continue;
    }
    const span = { start: (units[i] as Unit).start, end: (units[j - 1] as Unit).end };
    for (const ch of utf8.decode(new Uint8Array(bytes))) out.push({ text: ch, ...span });
    i = j;
  }
  return out;
}

/** The folded form of a run of text, one folded character per entry, each with the original span it came from. */
function fold(value: string): Unit[] {
  let units: Unit[] = [];
  let at = 0;
  for (const ch of value) {
    units.push({ text: ch, start: at, end: at + ch.length });
    at += ch.length;
  }
  for (let pass = 0; pass < 3; pass++) {
    const decoded = percentDecoded(units);
    if (decoded.length === units.length) break;
    units = decoded;
  }
  // A combining mark stays with its base, so NFKC can compose them.
  const clusters: Unit[] = [];
  for (const unit of units) {
    const last = clusters.at(-1);
    if (last !== undefined && COMBINING.test(unit.text)) {
      last.text += unit.text;
      last.end = unit.end;
    } else clusters.push({ ...unit });
  }
  const out: Unit[] = [];
  for (const cluster of clusters) {
    const folded = cluster.text.normalize('NFKC').toUpperCase().toLowerCase().normalize('NFKC').replace(IGNORABLE, '');
    for (const ch of folded) out.push({ text: ch, start: cluster.start, end: cluster.end });
  }
  return out;
}

const foldedText = (value: string): string => fold(value).map((unit) => unit.text).join('');

/** The quote as a pattern over folded text: whole words, any non-word run between them. */
function patternOf(quote: string): RegExp {
  const folded = foldedText(quote);
  const escape = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const words = folded.split(NOT_WORD).filter((word) => word !== '');
  if (words.length === 0) return new RegExp(escape(folded.trim()), 'gu');
  return new RegExp(`(?<![${WORD}])${words.map(escape).join(`[^${WORD}]*`)}(?![${WORD}])`, 'gu');
}

/** Every match of every pattern, as spans of the ORIGINAL text, merged where they touch or overlap, in order. */
function ranges(value: string, patterns: readonly RegExp[]): Array<[number, number]> {
  const units = fold(value);
  const offsets: number[] = [];
  let folded = '';
  for (const unit of units) {
    offsets.push(folded.length);
    folded += unit.text;
  }
  // The unit each folded UTF-16 index belongs to.
  const unitAt = (index: number): Unit => {
    let low = 0;
    let high = offsets.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((offsets[mid] as number) <= index) low = mid;
      else high = mid - 1;
    }
    return units[low] as Unit;
  };
  const found: Array<[number, number]> = [];
  for (const pattern of patterns) {
    for (const match of folded.matchAll(pattern)) {
      if (match[0] === '') continue;
      found.push([unitAt(match.index).start, unitAt(match.index + match[0].length - 1).end]);
    }
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

const matches = (value: string, patterns: readonly RegExp[]): boolean => ranges(value, patterns).length > 0;

/** Whether a quote matches, folded and as whole words, in any of these texts. */
export const quoteMatches = (quote: string, texts: readonly string[]): boolean => {
  const pattern = [patternOf(quote)];
  return texts.some((value) => matches(value, pattern));
};

/** A link whose target carries the text keeps its words but loses the target, at any depth. */
function unwrapLinks(nodes: Inline[], patterns: readonly RegExp[]): Inline[] {
  return nodes.flatMap((node): Inline[] => {
    if (node.type === 'link') {
      const children = unwrapLinks(node.children, patterns);
      return matches(node.href, patterns) ? children : [{ ...node, children }];
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
      out.push(' ', node.href, ' ');
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

/** Every string a tree carries, as one text: what a mark must be found in. */
export function treeText(tree: Tree): string {
  const out: string[] = [];
  tree.blocks.forEach((node) => {
    strings(node, out);
    out.push('\n');
  });
  return out.join('');
}

export function lensFor(audience: string, policy: Policy, marks: readonly MarkRow[]): Lens {
  const actionOf = (category: string): Action => resolveAction(policy, audience, category);
  const of = (subjects: readonly string[]): MarkRow[] => marks.filter((mark) => subjects.includes(mark.subject));
  const patterns = (subjects: readonly string[]): RegExp[] =>
    of(subjects).flatMap((mark) => (mark.quote !== null && actionOf(mark.category) === 'redact' ? [patternOf(mark.quote)] : []));

  return {
    audience,
    action: actionOf,
    hidden: (subjects, version) =>
      of(subjects).some((mark) => {
        const action = actionOf(mark.category);
        if (action === 'hide' || (mark.quote === null && action !== 'show')) return true;
        if (action !== 'redact' || mark.anchoredIn === undefined) return false;
        const scope = mark.subject.startsWith('content_item:') ? version : mark.subject;
        return scope === undefined || !mark.anchoredIn.has(scope);
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
      return matches(treeText(out), list) ? PLACEHOLDER : out;
    },
  };
}
