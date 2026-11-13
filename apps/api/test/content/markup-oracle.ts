// ============================================================================
// THE FROZEN ORACLE: parseMarkup as it is on main at f9bcc90 (EDITOR-A3a merged),
// before the linear rewrite. Copied verbatim except for the lines marked ORACLE:
// a step budget (the old parser backtracks exponentially on some inputs), and
// the position of each "unclosed :members[" problem, the one push a retry can
// repeat (A3a already keeps each URL problem once, by its offset). Never edit
// the parsing logic below.
// ============================================================================
import { type UrlProblem, urlMessage, urlProblem, urlsInText } from '../../src/links/rule.js';
import type { Block, Inline, Tree } from '../../src/content/tree.js';

export class OverBudget extends Error {}
export const BUDGET = 200_000;
const budget = { left: BUDGET };

export interface MarkupProblem {
  line: number;
  message: string;
  /** ORACLE: where an inline problem's marker starts, so a retried push can be told from a second marker. */
  at?: number;
}

interface ParsedMarkup {
  tree: Tree;
  problems: MarkupProblem[];
}

const FILE_REF = /^file:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

interface Style {
  bold: boolean;
  italic: boolean;
}

/** Where a source line starts in the text an InlineParser reads (a paragraph's lines are joined with a space). */
interface LineStart {
  offset: number;
  number: number;
}

class InlineParser {
  private i = 0;
  private readonly line: number;
  /** The refused URLs by where they start, so a stretch the parser reads twice reports each once. */
  private readonly urlProblems = new Map<number, MarkupProblem>();
  /** The runs of text kept so far, by where each starts, with where each character came from. */
  private readonly runs = new Map<number, { text: string; at: number[] }>();
  /** Each link target's check, by where it starts: the same text whenever the parser reads it again. */
  private readonly hrefs = new Map<number, UrlProblem | null>();

  constructor(
    private readonly s: string,
    private readonly starts: LineStart[],
    private readonly problems: MarkupProblem[],
  ) {
    this.line = (starts[0] as LineStart).number;
  }

  private lineAt(offset: number): number {
    let line = this.line;
    for (const start of this.starts) if (start.offset <= offset) line = start.number;
    return line;
  }

  private reportUrl(offset: number, message: string): void {
    this.urlProblems.set(offset, { line: this.lineAt(offset), message });
  }

  /** Going back to `start` to read it again: what was found from there on is found again, or not. */
  private rewind(start: number): void {
    this.i = start;
    for (const offset of this.urlProblems.keys()) if (offset >= start) this.urlProblems.delete(offset);
    for (const offset of this.runs.keys()) if (offset >= start) this.runs.delete(offset);
  }

  /**
   * The refused URLs, in the order they appear: the links' targets, and the bare URLs in the runs of
   * text the parse kept, each run scanned once, after the parse (never again on a re-read).
   */
  urlProblemsFound(): MarkupProblem[] {
    for (const { text, at } of this.runs.values()) {
      for (const { url, index } of urlsInText(text)) {
        const problem = urlProblem(url);
        if (problem !== null) this.reportUrl(at[index] as number, urlMessage('the address', url, problem));
      }
    }
    return [...this.urlProblems].sort(([a], [b]) => a - b).map(([, problem]) => problem);
  }

  /** Parse until `closer` (or the end); returns the nodes and whether the closer was found. */
  parse(style: Style, closer?: string): { nodes: Inline[]; closed: boolean } {
    const nodes: Inline[] = [];
    let text = '';
    let at: number[] = [];
    const flush = (): void => {
      if (text !== '') {
        nodes.push({ type: 'text', text, bold: style.bold, italic: style.italic });
        this.runs.set(at[0] as number, { text, at });
      }
      text = '';
      at = [];
    };
    const { s } = this;
    while (this.i < s.length) {
      // ORACLE: a step budget, so an input the old parser cannot finish is skipped, not waited on.
      if (--budget.left < 0) throw new OverBudget();
      if (closer !== undefined && s.startsWith(closer, this.i) && this.closes(closer)) {
        this.i += closer.length;
        flush();
        return { nodes, closed: true };
      }
      const c = s[this.i] as string;
      if (c === '\\' && this.i + 1 < s.length) {
        text += s[this.i + 1];
        at.push(this.i + 1);
        this.i += 2;
        continue;
      }
      if (s.startsWith(':members[', this.i)) {
        flush();
        const at = this.i; // ORACLE: the occurrence
        this.i += ':members['.length;
        const inner = this.parseBracketed(style);
        if (!inner.closed) this.problems.push({ line: this.line, message: 'unclosed :members[', at });
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
        this.rewind(start);
      }
      text += c;
      at.push(this.i);
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
        const target = this.i + 1;
        const cached = this.hrefs.get(target);
        const problem = cached !== undefined ? cached : urlProblem(href);
        this.hrefs.set(target, problem);
        if (problem !== null) this.reportUrl(this.i + 1, urlMessage('the link', href, problem));
        this.i = end + 1;
        if (problem === null) return { type: 'link', href, children: label.nodes };
        return { type: 'text', text: this.s.slice(start, this.i), bold: style.bold, italic: style.italic };
      }
    }
    this.rewind(start);
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

function inlines(text: string, line: number, problems: MarkupProblem[], starts: LineStart[] = [{ offset: 0, number: line }]): Inline[] {
  const parser = new InlineParser(text, starts, problems);
  const result = parser.parse({ bold: false, italic: false });
  problems.push(...parser.urlProblemsFound());
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
    const starts: LineStart[] = [{ offset: 0, number }];
    let offset = trimmed.length + 1;
    i += 1;
    while (i < lines.length) {
      const next = (lines[i] as Line).text.trim();
      if (next === '' || next.startsWith('#') || next.startsWith('>') || next.startsWith(':::') || LIST_ITEM.test(next) || /^!\[/.test(next)) break;
      paragraph.push(next);
      starts.push({ offset, number: (lines[i] as Line).number });
      offset += next.length + 1;
      i += 1;
    }
    blocks.push({ type: 'paragraph', children: inlines(paragraph.join(' '), number, problems, starts) });
  }
  return { blocks, rest: [], closed: false };
}

export function oracleParse(src: string): ParsedMarkup {
  const problems: MarkupProblem[] = [];
  budget.left = BUDGET;
  const lines = src.replace(/\r\n?/g, '\n').split('\n').map((text, index) => ({ text, number: index + 1 }));
  const { blocks } = parseBlocks(lines, problems, false);
  return { tree: { blocks }, problems };
}
