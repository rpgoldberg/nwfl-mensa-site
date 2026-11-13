// ============================================================================
// The officers' markup (addendum-publishing section 6), parsed into the body
// tree. It is what the no-JavaScript editor's toolbar writes:
//
//   # Heading / ## Heading          two levels only
//   **bold**  *italic*  _italic_    emphasis opens before a non-space and
//                                   closes after one, so "2 * 3" stays text
//   [text](https://...)             links: https: and mailto: only, by the
//                                   strict URL rule (links/rule.ts)
//   - item / * item / 1. item       one-paragraph list items
//   > quoted line                   a block quote
//   ![alt text](file:<uuid>)        an uploaded image, alt text required
//   :members[text]                  members-only inline
//   ::: members ... :::             members-only blocks
//   \x                              a literal x
//
// Anything else is plain text: raw HTML is never markup. Something the
// allow-list refuses is reported as a problem, and a version with problems
// cannot be marked ready. So is a bare URL in the text that the strict URL
// rule refuses (an http:// one, say): it stays text, and is reported on its
// own line. A members marker that is never closed is a problem
// AND fails closed: the rest of that paragraph (an inline span) or of the
// document (a block) becomes members-only, so a draft preview never shows it
// to the public by accident.
//
// Cost (MARKUP-DOS). The parse runs inside SaveDraft, PreviewWorkingItem and
// MarkReady, so it must never block the event loop. The first version read
// the markup by trial: every "[" tried a link and every "*" tried emphasis,
// and a failed try re-read the rest of the paragraph, which is exponential.
// This version gives the same tree for every input that one finished, in
// O(n log n) time and without recursion on the JavaScript stack:
//
//   1. analyse() walks the text from the END. What the token at position i
//      does (a link, an emphasis span, an escape, a members span, or one plain
//      character) depends only on text to its right, so by the time it reaches
//      i every try the old parser would make from i is already decided. It
//      records where each token ends (`step`) and, for every closer, where a
//      scan from i would stop (`stop`). A members span's end needs a bracket
//      count along a chain of "]"s; jump pointers find it in O(log n).
//   2. visit() replays the old parser's tries in the same order, each position
//      once, only to report unclosed members spans in the order the old parser
//      first found them. (It reported one again on every retry; now it is
//      reported once per marker.)
//   3. build() makes the tree in one pass, with every decision known. Only the
//      final reading counts for URLs (EDITOR A3a): build() checks the links it
//      keeps and the bare URLs in the runs of text it keeps, each once.
//
// Deeply nested input (quotes, members blocks, spans) runs on an explicit
// stack (run()), so it cannot overflow the call stack either. Nesting deeper
// than the stored tree keeps (tree.ts MAX_DEPTH) is a problem, so what saves
// is what preview and publication show.
// ============================================================================
import { type UrlProblem, urlMessage, urlProblem, urlsInText } from '../links/rule.js';
import { MAX_URL_LENGTH } from '../links/urls.js';
import { type Block, type Inline, MAX_DEPTH, type Tree } from './tree.js';

export interface MarkupProblem {
  line: number;
  message: string;
}

export interface ParsedMarkup {
  tree: Tree;
  problems: MarkupProblem[];
}

/** Counts the parser's work units, so a test can bound the work per character without timing it. */
export interface MarkupMeter {
  steps: number;
  /** When given, counts the empty pairs of markers ("__", "****") met, kept as written or dropped. */
  emptyPairs?: number;
  /**
   * For the equivalence test only: drop each empty pair as the old parser did (it read one as an empty
   * span: the text run ends there and nothing is added), so the rest can be compared with it exactly.
   */
  dropEmptyPairs?: boolean;
}

/**
 * A node deeper than tree.ts's MAX_DEPTH is redacted when the tree is read
 * back (preview, approval, publication), so markup that nests that deep is a
 * problem, and SaveDraft refuses it: what saves is what shows. Depth counts
 * as normalizeTree does: a top-level block is 0; a block's inline content,
 * a quote's or members block's blocks, a link's or members span's text, one
 * more each; a list item's paragraph, two more.
 */
export const NESTED_TOO_DEEPLY = 'nested too deeply to show: take some quotes, lists, members blocks, links or members spans out of one another';

const FILE_REF = /^file:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

// ---------------------------------------------------------------------------
// The explicit call stack. A generator yields the generator it wants to call
// and receives its return value; run() keeps the frames in an array.
// ---------------------------------------------------------------------------
type Call<R> = Generator<Call<unknown>, R, unknown>;

function run<R>(root: Call<R>): R {
  const frames: Call<unknown>[] = [root];
  let value: unknown;
  for (;;) {
    const top = frames[frames.length - 1] as Call<unknown>;
    const next = top.next(value);
    if (next.done === true) {
      frames.pop();
      value = next.value;
      if (frames.length === 0) return value as R;
    } else {
      frames.push(next.value);
      value = undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Inline markup.
// ---------------------------------------------------------------------------

/** The code units JavaScript's /\s/ matches (markup-dos.test.ts checks all 65,536). */
export const SPACE = new Uint8Array(0x10000);
for (const code of [0x9, 0xa, 0xb, 0xc, 0xd, 0x20, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) SPACE[code] = 1;
for (let code = 0x2000; code <= 0x200a; code += 1) SPACE[code] = 1;

const NONE = -1;
// Closers: what ends a scan. 0 is the paragraph itself, which only the end closes.
const BRACKET = 1;
const STAR = 2;
const STRONG = 3;
const UNDERSCORE = 4;
const CLOSER_LENGTH = [0, 1, 1, 2, 1];
// What the token at a position is.
const TEXT = 0;
const ESCAPE = 1;
const MEMBERS = 2;
const MEMBERS_UNCLOSED = 3;
const LINK = 4;
const EMPHASIS = 5;
// An opening marker met at once by its closer ("__", "****"): not emphasis, both markers kept as written.
const PAIR = 6;
const MEMBERS_MARK = ':members[';
const PLAIN = /[\\[*_]|:members\[/;

interface Style {
  bold: boolean;
  italic: boolean;
}

/** Where a source line starts in the text an InlineParser reads (a paragraph's lines are joined with a space). */
interface LineStart {
  offset: number;
  number: number;
}

/** The source line of an offset in a joined paragraph: the last line starting at or before it, by binary search. */
function lineOf(starts: LineStart[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((starts[middle] as LineStart).offset <= offset) low = middle;
    else high = middle - 1;
  }
  return (starts[low] as LineStart).number;
}

/** A run of kept text, and where each of its characters came from (an escape drops its backslash). */
interface Run {
  text: string;
  at: number[];
}

interface Scan {
  nodes: Inline[];
  closed: boolean;
}

/** Work arrays, sized to the longest paragraph so far and reused by the next. */
class Arena {
  readonly step: Int32Array;
  readonly kind: Uint8Array;
  readonly stop: Int32Array[];
  readonly sum: Int32Array[];
  readonly spaceBefore: Int32Array;
  readonly bracketBefore: Int32Array;
  readonly nextParen: Int32Array;
  readonly height: Int32Array;
  readonly up: Int32Array;
  readonly jump: Int32Array;
  readonly depth: Int32Array;
  readonly visited: Uint8Array;
  readonly seen: Uint8Array;
  readonly walked: Uint8Array;
  readonly skip: Int32Array;

  constructor(readonly capacity: number) {
    const ints = (): Int32Array => new Int32Array(capacity);
    this.step = ints();
    this.kind = new Uint8Array(capacity);
    // Indexed by closer; closer 0 (the paragraph) never stops a scan, so it has no array.
    this.stop = [new Int32Array(0), ints(), ints(), ints(), ints()];
    this.sum = [new Int32Array(0), ints(), ints(), ints(), ints()];
    this.spaceBefore = ints();
    this.bracketBefore = ints();
    this.nextParen = ints();
    this.height = ints();
    this.up = ints();
    this.jump = ints();
    this.depth = ints();
    this.visited = new Uint8Array(capacity);
    this.seen = new Uint8Array(capacity);
    this.walked = new Uint8Array(capacity);
    this.skip = ints();
  }
}

/** urlProblem's answer for any target over MAX_URL_LENGTH (its first check: the target has no space to trim). */
const TOO_LONG = urlProblem('x'.repeat(MAX_URL_LENGTH + 1));

/** Below any real depth: a frame whose nodes are thrown away (a refused link's label) never counts. */
const DISCARDED = Number.NEGATIVE_INFINITY;

class InlineParser {
  private readonly n: number;
  private readonly line: number;
  private cursor = 0;
  /** Whether a members span is in the text: only then do pass 1's bracket counts matter. */
  private readonly spans: boolean;
  /** Each link target's check, by where the target starts: one call per target, however often it is read. */
  private readonly hrefs = new Map<number, UrlProblem | null>();
  /** The runs of text the final reading keeps, scanned for bare URLs once, after it. */
  private readonly runs: Run[] = [];
  /** The refused URLs by where they start. */
  private readonly urlProblems = new Map<number, MarkupProblem>();

  constructor(
    private readonly s: string,
    private readonly starts: LineStart[],
    private readonly problems: MarkupProblem[],
    private readonly a: Arena,
    private readonly meter: MarkupMeter,
    private readonly depth: number,
    private readonly nestedTooDeeply: (line: number) => void,
  ) {
    this.n = s.length;
    this.line = (starts[0] as LineStart).number;
    this.spans = s.includes(MEMBERS_MARK);
  }

  parse(): Inline[] {
    this.analyse();
    this.a.visited.fill(0, 0, this.n + 1);
    this.a.seen.fill(0, 0, this.n + 1);
    this.a.walked.fill(0, 0, this.n + 1);
    this.visit();
    const nodes = merge(run(this.build({ bold: false, italic: false }, 0, this.depth)).nodes);
    for (const { text, at } of this.runs) {
      for (const { url, index } of urlsInText(text)) {
        this.meter.steps += 1;
        const problem = urlProblem(url);
        if (problem !== null) this.reportUrl(at[index] as number, urlMessage('the address', url, problem));
      }
    }
    // After the unclosed members spans, the refused URLs in the order they appear (EDITOR A3a).
    for (const [, problem] of [...this.urlProblems].sort(([x], [y]) => x - y)) this.problems.push(problem);
    return nodes;
  }

  private reportUrl(offset: number, message: string): void {
    this.urlProblems.set(offset, { line: lineOf(this.starts, offset), message });
  }

  /** The check of the link at i (its target starts after "]("), made once per target. */
  private linkProblem(i: number): UrlProblem | null {
    const target = this.a.stop[BRACKET]![i + 1]! + 2;
    let problem = this.hrefs.get(target);
    if (problem === undefined) {
      const end = this.a.step[i]! - 1;
      // Over the limit, urlProblem's first check refuses it; saying so here keeps a long target O(1).
      problem = end - target > MAX_URL_LENGTH ? TOO_LONG : urlProblem(this.s.slice(target, end));
      this.hrefs.set(target, problem);
    }
    return problem;
  }

  /**
   * The closers a scan stops for at i, one bit each: the old parser's closer
   * check, which runs before anything else. "]" always closes; an emphasis
   * marker closes only after a character that is not a space.
   */
  private closersAt(i: number): number {
    const code = this.s.charCodeAt(i);
    if (code === 0x5d) return 1 << BRACKET;
    if ((code !== 0x2a && code !== 0x5f) || i === 0 || SPACE[this.s.charCodeAt(i - 1)] === 1) return 0;
    if (code === 0x5f) return 1 << UNDERSCORE;
    return this.s.charCodeAt(i + 1) === 0x2a ? (1 << STAR) | (1 << STRONG) : 1 << STAR;
  }

  /** The emphasis marker at i (STRONG wins over STAR), or 0. */
  private markerAt(i: number): number {
    const code = this.s.charCodeAt(i);
    if (code === 0x2a) return this.s.charCodeAt(i + 1) === 0x2a ? STRONG : STAR;
    return code === 0x5f ? UNDERSCORE : 0;
  }

  /** Whether the marker at i opens: the character after it exists and is not a space. */
  private opens(i: number, marker: number): boolean {
    const after = i + CLOSER_LENGTH[marker]!;
    return after < this.n && SPACE[this.s.charCodeAt(after)] === 0;
  }

  /** Pass 1: decide every position, right to left. */
  private analyse(): void {
    const { s, n, a, meter } = this;
    const { step, kind, stop, sum, spaceBefore, bracketBefore, nextParen, height, up, jump, depth } = a;
    spaceBefore[0] = 0;
    bracketBefore[0] = 0;
    for (let i = 0; i < n; i += 1) {
      const code = s.charCodeAt(i);
      spaceBefore[i + 1] = spaceBefore[i]! + SPACE[code]!;
      bracketBefore[i + 1] = bracketBefore[i]! + (code === 0x5b ? 1 : code === 0x5d ? -1 : 0);
    }
    nextParen[n] = NONE;
    for (let c = BRACKET; c <= UNDERSCORE; c += 1) {
      stop[c]![n] = NONE;
      sum[c]![n] = 0;
    }
    const stopB = stop[BRACKET]!;
    const sumB = sum[BRACKET]!;
    for (let i = n - 1; i >= 0; i -= 1) {
      meter.steps += 1;
      const code = s.charCodeAt(i);
      nextParen[i] = code === 0x29 ? i : nextParen[i + 1]!;
      let next = i + 1;
      let what = TEXT;
      let count = code === 0x5b ? 1 : code === 0x5d ? -1 : 0;
      if (code === 0x5c && i + 1 < n) {
        next = i + 2;
        what = ESCAPE;
        const escaped = s.charCodeAt(i + 1);
        count = escaped === 0x5b ? 1 : escaped === 0x5d ? -1 : 0;
      } else if (code === 0x3a && s.startsWith(MEMBERS_MARK, i)) {
        // The span's text runs to the first "]" at which every "[" read as
        // text inside it has been matched; climb() finds that "]".
        const from = i + MEMBERS_MARK.length;
        const first = stopB[from]!;
        const close = first === NONE ? NONE : this.climb(first, sumB[from]! + height[first]!);
        next = close === NONE ? n : close + 1;
        what = close === NONE ? MEMBERS_UNCLOSED : MEMBERS;
        count = 0;
      } else {
        if (code === 0x5b) {
          // [label](href): the label scan stops at a "]", "(" follows, and the
          // href up to the next ")" has no space. The link is a node, or the
          // whole source text when its href is refused.
          const end = stopB[i + 1]!;
          const paren = end === NONE || s.charCodeAt(end + 1) !== 0x28 ? NONE : nextParen[end + 2]!;
          if (paren !== NONE && spaceBefore[paren] === spaceBefore[end + 2]) {
            next = paren + 1;
            what = LINK;
            // A kept link is a node (no plain brackets); a refused one is its source text. The
            // difference matters only to a members span's bracket count, so the target is checked
            // here only when there is a span and the source's brackets do not balance.
            const brackets = bracketBefore[paren + 1]! - bracketBefore[i]!;
            step[i] = next;
            count = brackets !== 0 && this.spans && this.linkProblem(i) !== null ? brackets : 0;
          }
        }
        const marker = what === TEXT ? this.markerAt(i) : 0;
        if (marker !== 0 && this.opens(i, marker)) {
          const from = i + CLOSER_LENGTH[marker]!;
          const end = stop[marker]![from]!;
          if (end === from) {
            // Nothing between them: kept as written, both markers (the closer opens nothing either).
            next = from + CLOSER_LENGTH[marker]!;
            what = PAIR;
          } else if (end !== NONE) {
            next = end + CLOSER_LENGTH[marker]!;
            what = EMPHASIS;
            count = sum[marker]![from]!;
          }
        }
      }
      step[i] = next;
      kind[i] = what;
      const closers = this.closersAt(i);
      for (let c = BRACKET; c <= UNDERSCORE; c += 1) {
        const closes = ((closers >> c) & 1) === 1;
        stop[c]![i] = closes ? i : stop[c]![next]!;
        sum[c]![i] = closes ? 0 : count + sum[c]![next]!;
      }
      if (code === 0x5d) {
        // A "]" that may close a members span. Past it the span goes on to the
        // next "]" a bracket scan stops at (`parent`); the count of open "["
        // changes by `sumB[i + 1] - 1` on the way (the -1 is this "]", kept as
        // text). height[] sums those changes up to the root, so a span opened
        // with `k` unmatched "[" at "]" x closes at the first "]" y above x
        // with height[y] >= height[x] + k. up[] links each "]" to the first
        // higher "]" above it (heights rise along up[]), and jump[] adds skew-
        // binary jump pointers over up[], so climb() takes O(log n) steps.
        const parent = stopB[i + 1]!;
        height[i] = sumB[i + 1]! - 1 + (parent === NONE ? 0 : height[parent]!);
        const higher = parent === NONE ? NONE : this.climb(parent, height[i]! + 1);
        up[i] = higher;
        if (higher === NONE) {
          depth[i] = 0;
          jump[i] = i;
        } else {
          depth[i] = depth[higher]! + 1;
          const far = jump[higher]!;
          jump[i] = depth[higher]! - depth[far]! === depth[far]! - depth[jump[far]!]! ? jump[far]! : higher;
        }
      }
    }
  }

  /** The first "]" at or above `from` (along up[]) whose height reaches `target`, or NONE. */
  private climb(from: number, target: number): number {
    const { height, up, jump } = this.a;
    let at = from;
    while (at !== NONE) {
      this.meter.steps += 1;
      if (height[at]! >= target) return at;
      const far = jump[at]!;
      at = far !== at && height[far]! < target ? far : up[at]!;
    }
    return NONE;
  }

  /**
   * The next "]" of a members span not yet walked, at or after `from`. Two spans can share "]"s: one
   * read inside a link target by a failed try (`:members[[*](:members[)[ ]`) walks them first, and the
   * span around the link reaches them later. The skip pointers are compressed as they are followed,
   * so a run of spans over one walked tail costs it once, not once each (markup-dos.test.ts).
   */
  private unwalked(from: number): number {
    const { walked, skip } = this.a;
    let at = from;
    while (at !== NONE && walked[at] === 1) {
      this.meter.steps += 1;
      at = skip[at]!;
    }
    let path = from;
    while (path !== at) {
      const next = skip[path]!;
      skip[path] = at;
      path = next;
    }
    return at;
  }

  /**
   * Pass 2: the old parser's scans, each (position, closer) once, in its
   * order, reporting a problem the first time a position is read. A scan that
   * reaches a position already read with the same closer stops: the old
   * parser would only repeat itself from there.
   *
   * Each frame of the explicit stack is one scan: its closer, where it is,
   * and the position whose inner scan it waits on. A position is first read
   * once, so the stack is never deeper than the text is long; the arrays are
   * pass 1's sums, which nothing reads after it.
   */
  private visit(): void {
    const { a, n, meter } = this;
    const { kind, step, seen, visited, skip, walked } = a;
    const stopB = a.stop[BRACKET]!;
    const [, closers, at, waiting, cursor] = a.sum as [Int32Array, Int32Array, Int32Array, Int32Array, Int32Array];
    let top = 0;
    closers[0] = 0;
    cursor[0] = 0;
    waiting[0] = NONE;
    const scan = (closer: number, from: number): void => {
      top += 1;
      closers[top] = closer;
      cursor[top] = from;
      waiting[top] = NONE;
      at[top] = NONE;
    };
    while (top >= 0) {
      const done = waiting[top]!;
      if (done !== NONE) {
        // The inner scan of `done` has ended: what the old parser did next.
        const what = kind[done]!;
        if (what === MEMBERS || what === MEMBERS_UNCLOSED) {
          // The span reads on past each "]" its brackets leave open.
          const close = what === MEMBERS ? step[done]! - 1 : n;
          const previous = at[top]!;
          const next = this.unwalked(previous === NONE ? stopB[done + MEMBERS_MARK.length]! : skip[previous]!);
          if (next !== NONE && next < close) {
            walked[next] = 1;
            skip[next] = stopB[next + 1]!;
            at[top] = next;
            scan(BRACKET, next + 1);
            continue;
          }
          if (what === MEMBERS_UNCLOSED) this.problems.push({ line: this.line, message: 'unclosed :members[' });
        }
        waiting[top] = NONE;
        cursor[top] = step[done]!;
      }
      const closer = closers[top]!;
      const bit = 1 << closer;
      let i = cursor[top]!;
      let inner = false;
      while (i < n) {
        meter.steps += 1;
        if ((this.closersAt(i) & bit) !== 0 || (visited[i]! & bit) !== 0) break;
        visited[i] = visited[i]! | bit;
        if (seen[i] === 0) {
          seen[i] = 1;
          const what = kind[i]!;
          const marker = this.markerAt(i);
          inner = true;
          waiting[top] = i;
          at[top] = NONE;
          if (what === MEMBERS || what === MEMBERS_UNCLOSED) scan(BRACKET, i + MEMBERS_MARK.length);
          // Every "[" tried a link, so its label was read even when the try failed.
          else if (this.s.charCodeAt(i) === 0x5b) scan(BRACKET, i + 1);
          // An opening marker's span was read even when it never closed.
          else if (marker !== 0 && this.opens(i, marker)) scan(marker, i + CLOSER_LENGTH[marker]!);
          else inner = false;
          if (inner) break;
          waiting[top] = NONE;
        }
        i = step[i]!;
      }
      if (!inner) top -= 1;
    }
  }

  /**
   * Pass 3: the tree, with every decision known. Mirrors the old parse(),
   * except that an emphasis span is not a call: it is known to close where
   * pass 1 found its closer, so it only changes the style until then, and its
   * nodes go straight into this frame's list (the old parser copied them up a
   * level at a time, O(n^2) for deep nesting).
   */
  private *build(style: Style, closer: number, depth: number): Call<Scan> {
    const { s, n, a } = this;
    const nodes: Inline[] = [];
    const styles: Style[] = [];
    // Where each open emphasis span's closer starts, and where the text resumes after it.
    const closeAt: number[] = [];
    const resumeAt: number[] = [];
    let current = style;
    let text = '';
    let at: number[] = [];
    // `from` is where the node starts in the source: a node too deep is reported at its own line.
    const add = (node: Inline, from: number): void => {
      if (depth > MAX_DEPTH) this.nestedTooDeeply(lineOf(this.starts, from));
      nodes.push(node);
    };
    const flush = (): void => {
      if (text !== '') {
        add({ type: 'text', text, bold: current.bold, italic: current.italic }, at[0]!);
        this.runs.push({ text, at });
      }
      text = '';
      at = [];
    };
    while (this.cursor < n) {
      this.meter.steps += 1;
      const i = this.cursor;
      const spans = closeAt.length;
      if (spans > 0 ? i === closeAt[spans - 1] : (this.closersAt(i) & (1 << closer)) !== 0) {
        this.cursor = spans > 0 ? resumeAt.pop()! : i + CLOSER_LENGTH[closer]!;
        flush();
        if (spans === 0) return { nodes, closed: true };
        closeAt.pop();
        current = styles.pop()!;
        continue;
      }
      const what = a.kind[i]!;
      if (what === ESCAPE) {
        text += s[i + 1]!;
        at.push(i + 1);
        this.cursor += 2;
      } else if (what === MEMBERS || what === MEMBERS_UNCLOSED) {
        flush();
        this.cursor += MEMBERS_MARK.length;
        const children = (yield this.bracketed(current, depth + 1)) as Inline[];
        add({ type: 'members', children }, i);
      } else if (what === LINK) {
        // A kept link is a node; a refused one is its source text, reported. Its label is read either
        // way, as the old parser read it: the URLs in it are checked, and a link inside it too.
        const problem = this.linkProblem(i);
        this.cursor += 1;
        const label = (yield this.build(current, BRACKET, problem === null ? depth + 1 : DISCARDED)) as Scan;
        const end = a.step[i]!;
        const target = a.stop[BRACKET]![i + 1]! + 2;
        const href = s.slice(target, end - 1);
        this.cursor = end;
        flush();
        if (problem === null) {
          add({ type: 'link', href, children: label.nodes }, i);
        } else {
          this.reportUrl(target, urlMessage('the link', href, problem));
          add({ type: 'text', text: s.slice(i, end), bold: current.bold, italic: current.italic }, i);
        }
      } else if (what === PAIR) {
        const end = a.step[i]!;
        if (this.meter.emptyPairs !== undefined) this.meter.emptyPairs += 1;
        if (this.meter.dropEmptyPairs) flush();
        else {
          for (let k = i; k < end; k += 1) at.push(k);
          text += s.slice(i, end);
        }
        this.cursor = end;
      } else if (what === EMPHASIS) {
        const marker = this.markerAt(i);
        flush();
        this.cursor += CLOSER_LENGTH[marker]!;
        closeAt.push(a.step[i]! - CLOSER_LENGTH[marker]!);
        resumeAt.push(a.step[i]!);
        styles.push(current);
        current = marker === STRONG ? { ...current, bold: true } : { ...current, italic: true };
      } else {
        text += s[i]!;
        at.push(i);
        this.cursor += 1;
      }
    }
    flush();
    return { nodes, closed: false };
  }

  /** The contents of `[ ... ]`, counting nested plain brackets. */
  private *bracketed(style: Style, depth: number): Call<Inline[]> {
    const nodes: Inline[] = [];
    let opened = 0;
    for (;;) {
      const part = (yield this.build(style, BRACKET, depth)) as Scan;
      for (const node of part.nodes) nodes.push(node);
      if (!part.closed) return merge(nodes);
      // A `]` closes the span only if every `[` opened inside it is closed too.
      opened += countPlain(part.nodes, '[') - countPlain(part.nodes, ']');
      if (opened <= 0) return merge(nodes);
      nodes.push({ type: 'text', text: ']', bold: style.bold, italic: style.italic });
      opened -= 1;
    }
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

/** The bare URLs a paragraph with no markup reports: one run, scanned once, in order. */
function plainRun(text: string, starts: LineStart[], problems: MarkupProblem[]): void {
  for (const { url, index } of urlsInText(text)) {
    const problem = urlProblem(url);
    if (problem !== null) problems.push({ line: lineOf(starts, index), message: urlMessage('the address', url, problem) });
  }
}

class Context {
  private arena: Arena | undefined;
  /** The first line of the markup nested too deeply, if any. */
  tooDeep: number | undefined;

  constructor(
    readonly problems: MarkupProblem[],
    readonly meter: MarkupMeter,
  ) {}

  /** Notes where the markup nests past MAX_DEPTH; it is reported once, at its first line. */
  readonly nestedTooDeeply = (line: number): void => {
    if (this.tooDeep === undefined || line < this.tooDeep) this.tooDeep = line;
  };

  /** A node at `depth` on `line`: noted when it is deeper than the stored tree keeps. */
  at(depth: number, line: number): void {
    if (depth > MAX_DEPTH) this.nestedTooDeeply(line);
  }

  /** A block's inline content, its nodes at `depth`; a paragraph's lines start where `starts` says. */
  inlines(text: string, depth: number, starts: LineStart[]): Inline[] {
    this.meter.steps += 1;
    // Text with no marker at all is one text node; most paragraphs end here.
    if (!PLAIN.test(text)) {
      if (text === '') return [];
      this.at(depth, (starts[0] as LineStart).number);
      plainRun(text, starts, this.problems);
      return [{ type: 'text', text, bold: false, italic: false }];
    }
    if (this.arena === undefined || this.arena.capacity < text.length + 2) this.arena = new Arena(text.length + 2);
    return new InlineParser(text, starts, this.problems, this.arena, this.meter, depth, this.nestedTooDeeply).parse();
  }
}

const startsAt = (line: number): LineStart[] => [{ offset: 0, number: line }];

// ---------------------------------------------------------------------------
// Blocks.
// ---------------------------------------------------------------------------

interface Line {
  text: string;
  number: number;
}

// The old patterns were /^(#{1,6})\s+(.*)$/ and /^(?:([-*])|(\d+)\.)\s+(.*)$/.
// When `(.*)$` fails (a U+2028 or U+2029 in the text), backtracking into \s+
// cost O(n^2). `(?=(\s+))\2` takes the whole run of spaces at once; giving some
// back could never help, because `.` cannot match the character that failed.
const HEADING = /^(#{1,6})(?=(\s+))\2(.*)$/;
const LIST_ITEM = /^(?:([-*])|(\d+)\.)(?=(\s+))\3(.*)$/;
const LINE_BREAK = /[\n\r\u2028\u2029]/;

/**
 * The old pattern /^!\[(.*)\]\((.*)\)$/ without its O(n^2) backtracking: "!["
 * to start, ")" to end, no line break between (`.` matches none), and the
 * greedy alt runs to the last "](" that leaves room for the closing ")".
 */
function image(trimmed: string): [string, string] | undefined {
  if (!trimmed.startsWith('![') || !trimmed.endsWith(')')) return undefined;
  const split = trimmed.lastIndexOf('](', trimmed.length - 3);
  if (split < 2 || LINE_BREAK.test(trimmed.slice(2, -1))) return undefined;
  return [trimmed.slice(2, split), trimmed.slice(split + 2, -1)];
}

interface Blocks {
  blocks: Block[];
  /** The index after the closing `:::` (or the end). */
  next: number;
  closed: boolean;
}

/** `depth`: these blocks' depth in the tree, as tree.ts counts it. */
function* parseBlocks(context: Context, lines: Line[], from: number, inMembers: boolean, depth: number): Call<Blocks> {
  const { problems } = context;
  const blocks: Block[] = [];
  const add = (block: Block, line: number): void => {
    context.at(depth, line);
    blocks.push(block);
  };
  let i = from;
  while (i < lines.length) {
    context.meter.steps += 1;
    const { text, number } = lines[i] as Line;
    const trimmed = text.trim();
    if (trimmed === '') {
      i += 1;
      continue;
    }
    if (trimmed === ':::') {
      if (inMembers) return { blocks, next: i + 1, closed: true };
      problems.push({ line: number, message: 'closing ::: without an opening ::: members' });
      i += 1;
      continue;
    }
    if (/^:::\s*members$/.test(trimmed)) {
      const inner = (yield parseBlocks(context, lines, i + 1, true, depth + 1)) as Blocks;
      if (!inner.closed) problems.push({ line: number, message: 'unclosed ::: members block' });
      add({ type: 'members', children: inner.blocks }, number);
      i = inner.next;
      continue;
    }
    const heading = HEADING.exec(trimmed);
    if (heading) {
      const level = (heading[1] as string).length;
      if (level > 2) {
        problems.push({ line: number, message: 'only two heading levels (# and ##)' });
        add({ type: 'paragraph', children: context.inlines(heading[3] as string, depth + 1, startsAt(number)) }, number);
      } else {
        add({ type: 'heading', level: level as 1 | 2, children: context.inlines(heading[3] as string, depth + 1, startsAt(number)) }, number);
      }
      i += 1;
      continue;
    }
    const picture = image(trimmed);
    if (picture) {
      const alt = picture[0].trim();
      const file = FILE_REF.exec(picture[1])?.[1];
      if (file === undefined) problems.push({ line: number, message: 'an image must be an uploaded file (file:<id>)' });
      else if (alt === '') problems.push({ line: number, message: 'an image needs alt text' });
      else add({ type: 'image', fileId: file, alt }, number);
      i += 1;
      continue;
    }
    const item = LIST_ITEM.exec(trimmed);
    if (item) {
      const ordered = item[2] !== undefined;
      const items: Block[][] = [];
      while (i < lines.length) {
        context.meter.steps += 1;
        const current = lines[i] as Line;
        const match = LIST_ITEM.exec(current.text.trim());
        if (!match || (match[2] !== undefined) !== ordered) break;
        // An item's paragraph sits two below its list, as tree.ts counts it.
        context.at(depth + 2, current.number);
        items.push([{ type: 'paragraph', children: context.inlines(match[4] as string, depth + 3, startsAt(current.number)) }]);
        i += 1;
      }
      add({ type: 'list', ordered, items }, number);
      continue;
    }
    if (trimmed.startsWith('>')) {
      const quoted: Line[] = [];
      while (i < lines.length && (lines[i] as Line).text.trim().startsWith('>')) {
        context.meter.steps += 1;
        const current = lines[i] as Line;
        quoted.push({ text: current.text.trim().replace(/^>\s?/, ''), number: current.number });
        i += 1;
      }
      add({ type: 'quote', children: ((yield parseBlocks(context, quoted, 0, false, depth + 1)) as Blocks).blocks }, number);
      continue;
    }
    // A paragraph: this line and the following plain lines, joined with a space.
    const paragraph: string[] = [trimmed];
    const starts: LineStart[] = [{ offset: 0, number }];
    let offset = trimmed.length + 1;
    i += 1;
    while (i < lines.length) {
      context.meter.steps += 1;
      const next = (lines[i] as Line).text.trim();
      if (next === '' || next.startsWith('#') || next.startsWith('>') || next.startsWith(':::') || LIST_ITEM.test(next) || /^!\[/.test(next)) break;
      paragraph.push(next);
      starts.push({ offset, number: (lines[i] as Line).number });
      offset += next.length + 1;
      i += 1;
    }
    add({ type: 'paragraph', children: context.inlines(paragraph.join(' '), depth + 1, starts) }, number);
  }
  return { blocks, next: lines.length, closed: false };
}

export function parseMarkup(src: string, meter: MarkupMeter = { steps: 0 }): ParsedMarkup {
  const problems: MarkupProblem[] = [];
  const lines = src.replace(/\r\n?/g, '\n').split('\n').map((text, index) => ({ text, number: index + 1 }));
  const context = new Context(problems, meter);
  const { blocks } = run(parseBlocks(context, lines, 0, false, 0));
  if (context.tooDeep !== undefined) problems.push({ line: context.tooDeep, message: NESTED_TOO_DEEPLY });
  return { tree: { blocks }, problems };
}
