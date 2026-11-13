// MARKUP-DOS: parseMarkup runs synchronously in SaveDraft, PreviewWorkingItem
// and MarkReady, so a slow parse blocks the API's event loop. The old parser
// re-read the rest of a paragraph after every failed "[" or unclosed "*", which
// is exponential; some block shapes were quadratic (regex backtracking) or
// recursed past the stack. Every shape below is synthetic.
//
// Two guards, so CI cannot flake: a counted-steps bound (deterministic: the
// parser's work units per input character) and a generous wall-clock bound.
import { describe, expect, it } from 'vitest';
import { NESTED_TOO_DEEPLY, SPACE, parseMarkup, type MarkupMeter, type MarkupProblem } from './markup.js';
import { MAX_URL_LENGTH } from '../links/urls.js';
import { oracleParse } from '../../test/content/markup-oracle.js';
import { MAX_DEPTH, normalizeTree } from './tree.js';

/** The edit form's cap: 48 KiB as posted, CRLF counted as 2 (apps/web form.ts MARKUP_MAX_BYTES). */
const CAP = 48 * 1024;
/** Work units per character the parser may spend on any input (the worst found by a 3,000-shape search was 6.8). */
const STEPS_PER_CHAR = 16;
/** Generous: the measured worst 48 KiB case is a few milliseconds on a developer box. */
const WALL_MS = 250;

const fill = (unit: string, prefix = '', suffix = ''): string =>
  prefix + unit.repeat(Math.floor((CAP - prefix.length - suffix.length) / unit.length)) + suffix;
const half = (a: string, b: string): string => a.repeat(Math.floor(CAP / 2 / a.length)) + b.repeat(Math.floor(CAP / 2 / b.length));

function timed(src: string): { ms: number; steps: number } {
  const meter: MarkupMeter = { steps: 0 };
  const start = performance.now();
  parseMarkup(src, meter);
  return { ms: performance.now() - start, steps: meter.steps };
}

// Sizes the old parser finishes in about a second, so the red run terminates.
const SCALED: [string, string][] = [
  ['25 "["', '['.repeat(25)],
  ['"*a " x23', '*a '.repeat(23)],
  ['"_a " x23', '_a '.repeat(23)],
  ['"**a " x21', '**a '.repeat(21)],
  ['"[a *" x12', '[a *'.repeat(12)],
];

// The old parser never finishes these (the brief's 32 "[" alone ran past 30 s), or
// overflows the stack on the longest runs.
const INLINE_48K: [string, string][] = [
  ['paragraphs of 30 "["', fill('['.repeat(30) + '\n\n')],
  ['40 "[" then plain text', fill('a', '['.repeat(40))],
  ['paragraphs of "*a " x30', fill('*a '.repeat(30) + '\n\n')],
  ['"["', fill('[')],
  ['"*a "', fill('*a ')],
  ['"_a "', fill('_a ')],
  ['"**a "', fill('**a ')],
  ['"[a *"', fill('[a *')],
  ['mixed "[*_:`"', fill('[*_:`')],
  ['mixed "[*_](:members["', fill('[*_](:members[')],
  ['":members["', fill(':members[')],
  ['":members[*a ["', fill(':members[*a [')],
  ['"[a](" (no closing paren)', fill('[a](')],
  ['"[x](https://" (unclosed hrefs)', fill('[x](https://')],
  ['escaped members markers over "[ ]" pairs', half('\\:members[', '[ ] ')],
  ['members markers over "[ ]" pairs', half(':members[', '[ ] ')],
  ['deeply nested emphasis that closes', half('*x ', 'x* ')],
  ['deeply nested links that close', half('[', '](https://x.example)')],
  ['deeply nested members spans that close', half(':members[', ']')],
  ['"*" runs and underscores', fill('***__ *_a')],
  // The challenger's shape for a climb() that walks one "]" at a time (561 steps/char under that mutant).
  ['members spans over a "[" run, then a "]" run', ':members[x]'.repeat(Math.floor(CAP / 2 / 11)) + '['.repeat(CAP / 4) + ']'.repeat(CAP / 4 - 16)],
  // Spans read inside link targets by failed tries, all reaching one walked tail of "]"s: 217 steps/char
  // if the skip pointers are not compressed.
  ['members spans in link targets over a shared tail', ':members[' + '[*](:members[)'.repeat(1500) + '[ ] '.repeat(7000)],
  ['members spans over "[" then "]" in thirds', ':members['.repeat(Math.floor(CAP / 3 / 9)) + '['.repeat(CAP / 3) + ']'.repeat(CAP / 3 - 32)],
  // EDITOR A3a's pieces (the challenger's table): no rewind, lines found by binary search, a linear
  // trimTrailing, and URL checks on the final reading only.
  ['kept links among failed brackets (the old rewind shape)', fill('[a](https://a.example) [w] w ')],
  ['refused links', fill('[a](http://a.example) ')],
  ['bare refused URLs', fill('https://x ')],
  // The challenger's costliest URL shape: every " www.[" is a bare URL the strict rule reads (R3-N1).
  ['" www.[" (one URL check each)', fill(' www.[')],
  ['URLs with 2,030 trailing ")"', fill(`https://a.example/${')'.repeat(2030)} `)],
  ['overlapping link targets', `[a${']('.repeat(Math.floor((CAP - 3) / 2))})`],
  ['a members span over unbalanced https targets (each one checked)', fill(`${'[](https://a.example/['.repeat(90)}) `, ':members[')],
];

const BLOCK_48K: [string, string][] = [
  ['one line of ">"', fill('>')],
  ['one line of "> "', fill('> ')],
  ['nested "::: members" lines', fill('::: members\n')],
  ['a heading with a long space run before U+2028', fill(' ', '#', 'x\u2028y')],
  ['a list item with a long space run before U+2028', fill(' ', '-', 'x\u2028y')],
  ['a numbered item with a long space run before U+2028', fill(' ', '1.', 'x\u2028y')],
  ['an image line of "](" with no closing paren', fill('](', '![')],
  ['many tiny list items with a marker each', fill('- *a\n')],
  ['quoted lists and fences', fill('> - [*\n> ::: members\n')],
  ['CRLF paragraphs of brackets', fill('[*\r\n')],
  ['one paragraph of refused URL lines (the old per-line attribution shape)', fill('http://x.example\n')],
  ['one paragraph of lines with a refused link each', fill('[a](http://x.example) *\n')],
];

describe('parseMarkup stays fast on adversarial input', () => {
  it.each(SCALED)('scaled: %s', (_label, src) => {
    expect(timed(src).ms).toBeLessThan(50);
  });

  it.each(BLOCK_48K)('48 KiB block: %s', (_label, src) => {
    expect(src.length).toBeLessThanOrEqual(CAP);
    const { ms, steps } = timed(src);
    expect(steps).toBeGreaterThan(0);
    expect(steps).toBeLessThan(STEPS_PER_CHAR * src.length);
    expect(ms).toBeLessThan(WALL_MS);
  });

  it.each(INLINE_48K)('48 KiB inline: %s', (_label, src) => {
    expect(src.length).toBeLessThanOrEqual(CAP);
    const { ms, steps } = timed(src);
    expect(steps).toBeGreaterThan(0);
    expect(steps).toBeLessThan(STEPS_PER_CHAR * src.length);
    expect(ms).toBeLessThan(WALL_MS);
  });

  it('grows linearly: doubling the input at most a little more than doubles the work', () => {
    for (const unit of ['[', '*a ', '[a *', ':members[*a [', '\\:members[[ ] ']) {
      const small = timed(unit.repeat(Math.floor(CAP / 4 / unit.length))).steps;
      const large = timed(unit.repeat(Math.floor(CAP / 2 / unit.length))).steps;
      expect(large / small, unit).toBeLessThan(2.3);
    }
  });
});

describe('the parser keeps the old rules exactly', () => {
  it('treats as a space exactly the code units /\\s/ matches', () => {
    const differ: number[] = [];
    for (let code = 0; code < 0x10000; code += 1) if ((SPACE[code] === 1) !== /\s/.test(String.fromCharCode(code))) differ.push(code);
    expect(differ).toEqual([]);
  });

  it('keeps a link whose target is exactly MAX_URL_LENGTH long, and refuses one longer (the long-target shortcut)', () => {
    const target = (length: number): string => `https://a.example/${'x'.repeat(length - 18)}`;
    // The oracle tags each members problem with its offset and repeats it on retries; reported once here.
    const oracle = (src: string): unknown => {
      const { tree, problems } = oracleParse(src);
      const seen = new Set<number | undefined>();
      return { tree, problems: problems.filter(({ at }) => at === undefined || (!seen.has(at) && seen.add(at))).map(({ line, message }) => ({ line, message })) };
    };
    for (const src of [`[a](${target(MAX_URL_LENGTH)})`, `:members[[a](${target(MAX_URL_LENGTH)}/[)]`]) {
      expect(parseMarkup(src)).toEqual(oracle(src));
    }
    expect(parseMarkup(`[a](${target(MAX_URL_LENGTH)})`).problems).toEqual([]);
    const over = parseMarkup(`[a](${target(MAX_URL_LENGTH + 1)})`);
    expect(over.tree.blocks[0]).toMatchObject({ children: [{ type: 'text' }] });
    expect(over.problems).toHaveLength(1);
    expect(over.problems[0]?.message).toMatch(/is longer than 2048 characters$/);
    for (const length of [MAX_URL_LENGTH - 1, MAX_URL_LENGTH, MAX_URL_LENGTH + 1]) {
      const src = `:members[[a](${target(length)}[)]`;
      expect(parseMarkup(src)).toEqual(oracle(src));
    }
  });
});

const DEEP = { message: NESTED_TOO_DEEPLY };

describe('deep nesting no longer overflows the stack', () => {
  it('parses 48 KiB of nested quotes, and reports them nested too deeply', () => {
    const { tree, problems } = parseMarkup('>'.repeat(CAP - 1) + 'x');
    let depth = 0;
    let block = tree.blocks[0];
    while (block?.type === 'quote') {
      depth += 1;
      block = block.children[0];
    }
    expect(depth).toBe(CAP - 1);
    expect(block).toEqual({ type: 'paragraph', children: [{ type: 'text', text: 'x', bold: false, italic: false }] });
    expect(problems).toEqual([{ line: 1, ...DEEP }]);
  });

  it('parses thousands of nested members blocks, each reported unclosed, then nested too deeply from the 26th', () => {
    const { tree, problems } = parseMarkup('::: members\n'.repeat(4000) + 'secret');
    expect(problems).toHaveLength(4001);
    expect(problems[0]).toEqual({ line: 4000, message: 'unclosed ::: members block' });
    expect(problems[3999]).toEqual({ line: 1, message: 'unclosed ::: members block' });
    expect(problems[4000]).toEqual({ line: 26, ...DEEP });
    expect(tree.blocks).toHaveLength(1);
  });

  it('parses thousands of nested members spans, and fails closed', () => {
    const { tree, problems } = parseMarkup(':members['.repeat(5000) + 'secret');
    expect(problems).toHaveLength(5001);
    expect(problems.at(-1)).toEqual({ line: 1, ...DEEP });
    const paragraph = tree.blocks[0];
    expect(paragraph?.type === 'paragraph' && paragraph.children[0]?.type).toBe('members');
  });
});

describe(`nesting depth: nothing deeper than the stored tree keeps (tree.ts MAX_DEPTH ${MAX_DEPTH}, counted as normalizeTree counts)`, () => {
  const deep = (src: string): MarkupProblem[] => parseMarkup(src).problems.filter((p) => p.message === DEEP.message);
  const links = (k: number): string => `${'['.repeat(k)}a${'](https://x.example)'.repeat(k)}`;
  const spans = (k: number): string => `${':members['.repeat(k)}a${']'.repeat(k)}`;
  const blocks = (k: number): string => '::: members\n'.repeat(k) + 'x\n' + ':::\n'.repeat(k);

  it.each([
    ['23 quotes around a paragraph', '>'.repeat(23) + ' x'],
    ['24 quotes, the last empty', '>'.repeat(24)],
    ['23 members blocks around a paragraph', blocks(23)],
    ['23 nested links', links(23)],
    ['23 nested members spans', spans(23)],
    ['21 quotes around a list', '>'.repeat(21) + ' - x'],
    ['10 quotes around 13 links', '>'.repeat(10) + ' ' + links(13)],
    ['11 members blocks, 6 quotes, a link and 5 spans', blocks(0).replace('x', '>'.repeat(6) + ' [' + spans(5) + '](https://x.example)').replace(/^/, '::: members\n'.repeat(11)) + ':::\n'.repeat(11)],
  ])('allows %s, and normalizeTree keeps it whole', (_label, src) => {
    expect(deep(src)).toEqual([]);
    const { tree } = parseMarkup(src);
    expect(normalizeTree(tree)).toEqual(tree);
  });

  it.each([
    ['24 quotes around a paragraph', '>'.repeat(24) + ' x', 1],
    ['24 members blocks around a paragraph', 'Intro.\n\n' + blocks(24), 27],
    ['24 nested links', links(24), 1],
    ['24 nested members spans', `Intro.\n\n${spans(24)}`, 3],
    ['22 quotes around a list', '>'.repeat(22) + ' - x', 1],
    ['10 quotes around 14 links', '>'.repeat(10) + ' ' + links(14), 1],
    ['an empty members span 24 quotes deep', '>'.repeat(24) + ' :members[]', 1],
  ])('reports %s once, at its first line, and normalizeTree would cut it', (_label, src, line) => {
    expect(deep(src)).toEqual([{ line, ...DEEP }]);
    const { tree } = parseMarkup(src);
    expect(normalizeTree(tree)).not.toEqual(tree);
  });

  it('does not count a refused link: its label is not in the tree', () => {
    const src = `${'['.repeat(30)}a${'](http://x.example)'.repeat(30)}`;
    expect(deep(src)).toEqual([]);
  });

  it('reports the first line that goes too deep, whichever place is reached last', () => {
    // Blocks are read top-down, but a members span's nodes are added after the quote below it is not: both orders.
    expect(deep(['>'.repeat(30) + ' x', '', '>'.repeat(30) + ' y'].join('\n'))).toEqual([{ line: 1, ...DEEP }]);
    expect(deep([spans(30), '', '>'.repeat(30) + ' y'].join('\n'))).toEqual([{ line: 1, ...DEEP }]);
    expect(deep(['Intro.', '', '>'.repeat(30) + ' y', '', spans(30)].join('\n'))).toEqual([{ line: 3, ...DEEP }]);
  });

  it('reports an inline that goes too deep at its own line, not its paragraph\'s first', () => {
    expect(deep(`intro\nmore\n${links(24)}`)).toEqual([{ line: 3, ...DEEP }]);
    expect(deep(`intro\n${'['.repeat(12)}a\n${'['.repeat(12)}b${'](https://x.example)'.repeat(24)}`)).toEqual([{ line: 3, ...DEEP }]);
    expect(deep(`intro\nmore\n${links(24)}\n\n${'>'.repeat(30)} x`)).toEqual([{ line: 3, ...DEEP }]);
    expect(deep(`- one\n- two\n- ${spans(22)}`)).toEqual([{ line: 3, ...DEEP }]);
    // A too-deep text that runs onto the next line is reported where it starts.
    expect(deep(`intro\nmore\n${'['.repeat(24)}a\nb${'](https://x.example)'.repeat(24)}`)).toEqual([{ line: 3, ...DEEP }]);
  });

  it('reports it once for a document nested too deeply in several places', () => {
    expect(deep(['>'.repeat(40) + ' x', '', '>'.repeat(40) + ' y'].join('\n'))).toHaveLength(1);
  });
});
