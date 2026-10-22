// ============================================================================
// The officers' markup (addendum-publishing section 6), parsed into the body
// tree. It is what the no-JavaScript editor's toolbar writes:
//
//   # Heading / ## Heading          two levels only
//   **bold**  *italic*  _italic_    emphasis opens before a non-space and
//                                   closes after one, so "2 * 3" stays text
//   [text](https://...)             links: https: and mailto: only
//   - item / * item / 1. item       one-paragraph list items
//   > quoted line                   a block quote
//   ![alt text](file:<uuid>)        an uploaded image, alt text required
//   :members[text]                  members-only inline
//   ::: members ... :::             members-only blocks
//   \x                              a literal x
//
// Anything else is plain text: raw HTML is never markup. Something the
// allow-list refuses is reported as a problem, and a version with problems
// cannot be marked ready. A members marker that is never closed is a problem
// AND fails closed: the rest of that paragraph (an inline span) or of the
// document (a block) becomes members-only, so a draft preview never shows it
// to the public by accident.
// ============================================================================
import type { Block, Inline, Tree } from './tree.js';

export interface MarkupProblem {
  line: number;
  message: string;
}

export interface ParsedMarkup {
  tree: Tree;
  problems: MarkupProblem[];
}

const FILE_REF = /^file:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const SAFE_HREF = /^(https:\/\/|mailto:)\S+$/;

interface Style {
  bold: boolean;
  italic: boolean;
}

class InlineParser {
  private i = 0;

  constructor(
    private readonly s: string,
    private readonly line: number,
    private readonly problems: MarkupProblem[],
  ) {}

  /** Parse until `closer` (or the end); returns the nodes and whether the closer was found. */
  parse(style: Style, closer?: string): { nodes: Inline[]; closed: boolean } {
    const nodes: Inline[] = [];
    let text = '';
    const flush = (): void => {
      if (text !== '') nodes.push({ type: 'text', text, bold: style.bold, italic: style.italic });
      text = '';
    };
    const { s } = this;
    while (this.i < s.length) {
      if (closer !== undefined && s.startsWith(closer, this.i) && this.closes(closer)) {
        this.i += closer.length;
        flush();
        return { nodes, closed: true };
      }
      const c = s[this.i] as string;
      if (c === '\\' && this.i + 1 < s.length) {
        text += s[this.i + 1];
        this.i += 2;
        continue;
      }
      if (s.startsWith(':members[', this.i)) {
        flush();
        this.i += ':members['.length;
        const inner = this.parseBracketed(style);
        if (!inner.closed) this.problems.push({ line: this.line, message: 'unclosed :members[' });
        nodes.push({ type: 'members', children: inner.nodes });
        continue;
      }
      if (c === '[') {
        const link = this.tryLink(style);
        if (link !== undefined) {
          flush();
          nodes.push(link);
          continue;
        }
      }
      const marker = s.startsWith('**', this.i) ? '**' : c === '*' || c === '_' ? c : undefined;
      if (marker !== undefined && this.opens(marker)) {
        const start = this.i;
        this.i += marker.length;
        const next = marker === '**' ? { ...style, bold: true } : { ...style, italic: true };
        const inner = this.parse(next, marker);
        if (inner.closed) {
          flush();
          nodes.push(...inner.nodes);
          continue;
        }
        this.i = start;
      }
      text += c;
      this.i += 1;
    }
    flush();
    return { nodes, closed: false };
  }

  private opens(marker: string): boolean {
    const after = this.s[this.i + marker.length];
    return after !== undefined && !/\s/.test(after);
  }

  private closes(marker: string): boolean {
    if (marker === ']') return true;
    const before = this.s[this.i - 1];
    return before !== undefined && !/\s/.test(before);
  }

  /** The contents of `[ ... ]`, counting nested plain brackets. */
  private parseBracketed(style: Style): { nodes: Inline[]; closed: boolean } {
    const nodes: Inline[] = [];
    for (;;) {
      const part = this.parse(style, ']');
      nodes.push(...part.nodes);
      if (!part.closed) return { nodes: merge(nodes), closed: false };
      // A `]` closes the span only if every `[` opened inside it is closed too.
      const opened = countPlain(nodes, '[') - countPlain(nodes, ']');
      if (opened <= 0) return { nodes: merge(nodes), closed: true };
      nodes.push({ type: 'text', text: ']', bold: style.bold, italic: style.italic });
    }
  }

  /** `[text](href)` at the cursor, or undefined (and the cursor unmoved). */
  private tryLink(style: Style): Inline | undefined {
    const start = this.i;
    this.i += 1;
    const label = this.parse(style, ']');
    if (label.closed && this.s[this.i] === '(') {
      const end = this.s.indexOf(')', this.i + 1);
      const href = end === -1 ? '' : this.s.slice(this.i + 1, end);
      if (end !== -1 && !/\s/.test(href)) {
        this.i = end + 1;
        if (SAFE_HREF.test(href)) return { type: 'link', href, children: label.nodes };
        this.problems.push({ line: this.line, message: 'links must be https: or mailto:' });
        return { type: 'text', text: this.s.slice(start, this.i), bold: style.bold, italic: style.italic };
      }
    }
    this.i = start;
    return undefined;
  }
}

function countPlain(nodes: Inline[], char: string): number {
  return nodes.reduce((sum, node) => sum + (node.type === 'text' ? node.text.split(char).length - 1 : 0), 0);
}

/** Adjacent text nodes of the same style become one. */
function merge(nodes: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const node of nodes) {
    const last = out.at(-1);
    if (node.type === 'text' && last?.type === 'text' && last.bold === node.bold && last.italic === node.italic) {
      out[out.length - 1] = { ...last, text: last.text + node.text };
    } else {
      out.push(node);
    }
  }
  return out;
}

function inlines(text: string, line: number, problems: MarkupProblem[]): Inline[] {
  const parser = new InlineParser(text, line, problems);
  const result = parser.parse({ bold: false, italic: false });
  // An unclosed span is reported by the parser; its contents are already a members node.
  return merge(result.nodes);
}

interface Line {
  text: string;
  number: number;
}

const LIST_ITEM = /^(?:([-*])|(\d+)\.)\s+(.*)$/;

function parseBlocks(lines: Line[], problems: MarkupProblem[], inMembers: boolean): { blocks: Block[]; rest: Line[]; closed: boolean } {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const { text, number } = lines[i] as Line;
    const trimmed = text.trim();
    if (trimmed === '') {
      i += 1;
      continue;
    }
    if (trimmed === ':::') {
      if (inMembers) return { blocks, rest: lines.slice(i + 1), closed: true };
      problems.push({ line: number, message: 'closing ::: without an opening ::: members' });
      i += 1;
      continue;
    }
    if (/^:::\s*members$/.test(trimmed)) {
      const inner = parseBlocks(lines.slice(i + 1), problems, true);
      if (!inner.closed) problems.push({ line: number, message: 'unclosed ::: members block' });
      blocks.push({ type: 'members', children: inner.blocks });
      lines = inner.rest;
      i = 0;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const level = (heading[1] as string).length;
      if (level > 2) {
        problems.push({ line: number, message: 'only two heading levels (# and ##)' });
        blocks.push({ type: 'paragraph', children: inlines(heading[2] as string, number, problems) });
      } else {
        blocks.push({ type: 'heading', level: level as 1 | 2, children: inlines(heading[2] as string, number, problems) });
      }
      i += 1;
      continue;
    }
    const image = /^!\[(.*)\]\((.*)\)$/.exec(trimmed);
    if (image) {
      const alt = (image[1] as string).trim();
      const file = FILE_REF.exec(image[2] as string)?.[1];
      if (file === undefined) problems.push({ line: number, message: 'an image must be an uploaded file (file:<id>)' });
      else if (alt === '') problems.push({ line: number, message: 'an image needs alt text' });
      else blocks.push({ type: 'image', fileId: file, alt });
      i += 1;
      continue;
    }
    const item = LIST_ITEM.exec(trimmed);
    if (item) {
      const ordered = item[2] !== undefined;
      const items: Block[][] = [];
      while (i < lines.length) {
        const current = lines[i] as Line;
        const match = LIST_ITEM.exec(current.text.trim());
        if (!match || (match[2] !== undefined) !== ordered) break;
        items.push([{ type: 'paragraph', children: inlines(match[3] as string, current.number, problems) }]);
        i += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }
    if (trimmed.startsWith('>')) {
      const quoted: Line[] = [];
      while (i < lines.length && (lines[i] as Line).text.trim().startsWith('>')) {
        const current = lines[i] as Line;
        quoted.push({ text: current.text.trim().replace(/^>\s?/, ''), number: current.number });
        i += 1;
      }
      blocks.push({ type: 'quote', children: parseBlocks(quoted, problems, false).blocks });
      continue;
    }
    // A paragraph: this line and the following plain lines, joined with a space.
    const paragraph: string[] = [trimmed];
    i += 1;
    while (i < lines.length) {
      const next = (lines[i] as Line).text.trim();
      if (next === '' || next.startsWith('#') || next.startsWith('>') || next.startsWith(':::') || LIST_ITEM.test(next) || /^!\[/.test(next)) break;
      paragraph.push(next);
      i += 1;
    }
    blocks.push({ type: 'paragraph', children: inlines(paragraph.join(' '), number, problems) });
  }
  return { blocks, rest: [], closed: false };
}

export function parseMarkup(src: string): ParsedMarkup {
  const problems: MarkupProblem[] = [];
  const lines = src.replace(/\r\n?/g, '\n').split('\n').map((text, index) => ({ text, number: index + 1 }));
  const { blocks } = parseBlocks(lines, problems, false);
  return { tree: { blocks }, problems };
}
