// MARKUP-DOS: the linear parser must give byte-identical output to the old
// backtracking parser (frozen from main f9bcc90, EDITOR-A3a's URL rule, in
// test/content/markup-oracle.ts) on every input the old one finishes. Two
// differences are intended:
//   - the old parser re-pushed "unclosed :members[" each time a retry re-read
//     the marker; the oracle tags that push with its position, and collapsing
//     repeats of the same position gives the expected list;
//   - markup nested deeper than the stored tree keeps (tree.ts MAX_DEPTH) gets
//     one more problem, last: checked here against the oracle's own tree.
// Synthetic inputs only.
import { describe, expect, it } from 'vitest';
import { BUDGET, OverBudget, oracleParse, type MarkupProblem as OracleProblem } from '../../test/content/markup-oracle.js';
import { NESTED_TOO_DEEPLY, parseMarkup, type MarkupProblem } from './markup.js';
import { MAX_DEPTH, type Block, type Inline, type Tree, normalizeTree } from './tree.js';

const FILE = '7a0d3d4e-1f1b-4c55-9a51-0b8f1c6a2e01';

function once(problems: OracleProblem[]): MarkupProblem[] {
  const seen = new Set<string>();
  const out: MarkupProblem[] = [];
  for (const { line, message, at } of problems) {
    if (at !== undefined) {
      const key = `${line}:${at}:${message}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push({ line, message });
  }
  return out;
}

interface Tally {
  compared: number;
  overBudget: number;
  repeatsCollapsed: number;
  tooDeep: number;
}

/** The deepest node of a tree, counted as tree.ts's normalizeTree counts it. */
function deepest(tree: Tree): number {
  let most = -1;
  const inline = (node: Inline, depth: number): void => {
    most = Math.max(most, depth);
    if (node.type === 'link' || node.type === 'members') for (const child of node.children) inline(child, depth + 1);
  };
  const block = (node: Block, depth: number): void => {
    most = Math.max(most, depth);
    if (node.type === 'paragraph' || node.type === 'heading') for (const child of node.children) inline(child, depth + 1);
    if (node.type === 'quote' || node.type === 'members') for (const child of node.children) block(child, depth + 1);
    if (node.type === 'list') for (const item of node.items) for (const child of item) block(child, depth + 2);
  };
  for (const node of tree.blocks) block(node, 0);
  return most;
}

/** Compares one input, or counts it as skipped when the oracle cannot finish it. */
function same(src: string, tally: Tally): void {
  let old;
  try {
    old = oracleParse(src);
  } catch (error) {
    if (error instanceof OverBudget) {
      tally.overBudget += 1;
      return;
    }
    if (error instanceof RangeError) {
      // The old parser recursed past the stack; there is no old output to match.
      tally.overBudget += 1;
      return;
    }
    throw error;
  }
  const problems = once(old.problems);
  if (problems.length !== old.problems.length) tally.repeatsCollapsed += 1;
  if (deepest(old.tree) > MAX_DEPTH) {
    tally.tooDeep += 1;
    problems.push({ line: expect.any(Number) as number, message: NESTED_TOO_DEEPLY });
    expect(parseMarkup(src)).toEqual({ tree: old.tree, problems });
    tally.compared += 1;
    return;
  }
  const expected = JSON.stringify({ tree: old.tree, problems });
  const actual = JSON.stringify(parseMarkup(src));
  if (actual !== expected) expect.soft(actual, JSON.stringify(src)).toBe(expected);
  tally.compared += 1;
}

/** A small seeded generator (mulberry32), so a failure replays exactly. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const INLINE = [
  '*', '**', '_', '[', ']', '(', ')', ':members[', '\\', ' ', 'a', 'https://x.example', 'mailto:m', 'http://h', '](', '\t', '\u2028', '`', ':', '![',
  // The strict URL rule (EDITOR A3a): hosts with and without a dot, www., user info, a port, an IP,
  // a hidden character, mail, and the sentence punctuation a bare URL sheds.
  'http://a.example/p', 'www.a.example', 'https://u:p@a.example', 'https://a.example:8443/', 'https://192.0.2.1/', 'https://intranet/',
  'mailto:e@a.example', 'https://a.example/x\u200by', ').', '",', ']', 'HTTPS://A.example',
];
const BLOCK = ['\n', '\n\n', '\r\n', '\r', '# ', '## ', '### ', '- ', '* ', '1. ', '> ', '>> ', '::: members\n', ':::\n', ' :::  members \n', `![alt](file:${FILE})`, `![](file:${FILE})`, '  ', '#', '-'];

const EXISTING_TABLE = [
  // EDITOR A3a's table (markup.test.ts, "strict URLs at save").
  'First line of the paragraph.\nSee [the map](http://example.org/m) here.',
  '[a](https://user:pw@example.org/) [b](https://192.0.2.1/) [c](https://example.org:8443/) [d](https://intranet/x)',
  '[x](https://192.0.2.1/)',
  '[a](https://Example.ORG/a) [b](mailto:editor@example.org?subject=Hi) https://example.net/ok and www text',
  'Tickets at http://example.org/t.\nOr www.example.net/x, or https://example.org/fine\n\n# See http://example.org/h\n\n- item http://example.org/l\n\n> quoted\n> https://192.0.2.9/q',
  '::: members\nGate code at http://example.org/g\n:::\n\n**http://example.org/b** :members[http://example.org/m]\n\n[http://example.org/label](https://example.org/target)\n\nhttp://example.org/a\\_b',
  '*see http://example.org/a and more',
  '[a [b](http://example.org/inner) c',
  '**a [b](http://example.org/x) _c',
  '[x](https://example.org/a\u200bb)',
  '[http://a.example [b](http://b.example) c](http://c.example) d http://d.example',
  'One line\nand the next.\n\nSecond paragraph.',
  '',
  '# Picnic\n\n## Where',
  `- Chairs\n* Water\n\n1. First\n2. Second\n\n> Quoted\n> on two lines\n\n![The flyer](file:${FILE})`,
  'Open.\n\n::: members\n## Gate\n\nCode 4417\n:::\n\nAfter.',
  '**Bold** and *it* and _also_ and [AML](https://us.mensa.org) or [mail](mailto:president@nwflorida.us).',
  '**see [map](https://example.org/m) and :members[gate *4417*]**',
  'At :members[pavilion [3] via [map](https://example.org)].',
  '\\*not italic\\* <b>raw</b> 2 * 3 and a lone ** pair',
  '[x](http://example.org)',
  '[x](javascript:alert(1))',
  '### Too deep',
  `![](file:${FILE})`,
  '![x](https://example.org/x.png)',
  'Text\n:::',
  'Meet at :members[gate 4417 and more.\n\nNext paragraph.',
  'Open.\n\n::: members\nSecret.\n\nStill secret.',
  `# T\n\n**b** _i_ [l](https://x.example) :members[m]\n\n- a\n\n> q\n\n![alt](file:${FILE})\n\n::: members\nm\n:::`,
];

describe('the linear parser matches the frozen old parser', () => {
  it('on the existing markup test table', () => {
    const tally: Tally = { compared: 0, overBudget: 0, repeatsCollapsed: 0, tooDeep: 0 };
    for (const src of EXISTING_TABLE) same(src, tally);
    expect(tally.compared).toBe(EXISTING_TABLE.length);
  });

  it('on every inline string of up to four tokens', () => {
    const tokens = ['*', '**', '_', '[', ']', '(', ')', ':members[', '\\', ' ', 'a', 'https://x'];
    const tally: Tally = { compared: 0, overBudget: 0, repeatsCollapsed: 0, tooDeep: 0 };
    let level = [''];
    for (let length = 1; length <= 4; length += 1) {
      level = level.flatMap((prefix) => tokens.map((token) => prefix + token));
      for (const src of level) same(src, tally);
    }
    expect(tally.compared + tally.overBudget).toBe(12 + 12 ** 2 + 12 ** 3 + 12 ** 4);
    expect(tally.overBudget).toBe(0);
    if (process.env['MARKUP_DIFF_STATS']) console.info('exhaustive', tally);
  });

  it('on 40,000 seeded random documents, inline and block', () => {
    const next = random(0x6d61726b);
    const pick = (list: string[]): string => list[Math.floor(next() * list.length)] as string;
    const tally: Tally = { compared: 0, overBudget: 0, repeatsCollapsed: 0, tooDeep: 0 };
    for (let n = 0; n < 40_000; n += 1) {
      const count = 1 + Math.floor(next() * 48);
      let src = '';
      for (let k = 0; k < count; k += 1) src += next() < 0.8 ? pick(INLINE) : pick(BLOCK);
      same(src, tally);
    }
    // The generator must reach the shapes that matter: retries that re-pushed
    // a problem, and (rarely) inputs the old parser could not finish.
    expect(tally.compared).toBeGreaterThan(39_000);
    expect(tally.repeatsCollapsed).toBeGreaterThan(100);
    if (process.env['MARKUP_DIFF_STATS']) console.info('random', tally, 'budget', BUDGET);
  });

  it('on 2,500 longer seeded paragraphs heavy in brackets, members spans and links', () => {
    const next = random(0x5b5d);
    const tokens = ['[', ']', ':members[', '\\[', '\\]', 'a', ' ', '](https://x.example)', '](http://h.example)', '(', ')', '*', '_', '**', '[a](mailto:m@a.example)', 'http://b.example ', '\n'];
    const tally: Tally = { compared: 0, overBudget: 0, repeatsCollapsed: 0, tooDeep: 0 };
    for (let n = 0; n < 2_500; n += 1) {
      const count = 40 + Math.floor(next() * 80);
      let src = '';
      for (let k = 0; k < count; k += 1) src += tokens[Math.floor(next() * tokens.length)] as string;
      same(src, tally);
    }
    // About a tenth are too slow for the old parser's budget and are skipped.
    expect(tally.compared).toBeGreaterThan(2_100);
    if (process.env['MARKUP_DIFF_STATS']) console.info('long', tally);
  });

  it('on 600 seeded documents nested 16 to 30 deep: the extra problem exactly when the tree is too deep', () => {
    const next = random(0xdee9);
    const tally: Tally = { compared: 0, overBudget: 0, repeatsCollapsed: 0, tooDeep: 0 };
    for (let n = 0; n < 600; n += 1) {
      const levels = 16 + Math.floor(next() * 15);
      const inline = Math.floor(next() * (levels + 1));
      let text = next() < 0.5 ? 'a http://h.example b' : 'plain words';
      for (let k = 0; k < inline; k += 1) text = next() < 0.5 ? `[${text}](https://x.example)` : `:members[${text}]`;
      let lines = [next() < 0.3 ? `- ${text}` : text];
      for (let k = inline; k < levels; k += 1) lines = next() < 0.5 ? lines.map((line) => `> ${line}`) : ['::: members', ...lines, ':::'];
      const src = lines.join('\n');
      same(src, tally);
      // What saves is what shows: a tree with no depth problem comes back from normalizeTree (preview,
      // approval, publication) unchanged, and one with the problem would lose something there.
      const { tree, problems } = parseMarkup(src);
      const tooDeep = problems.some((problem) => problem.message === NESTED_TOO_DEEPLY);
      if (tooDeep) expect(normalizeTree(tree)).not.toEqual(tree);
      else expect(normalizeTree(tree)).toEqual(tree);
    }
    expect(tally.compared).toBe(600);
    expect(tally.tooDeep).toBeGreaterThan(200);
    expect(tally.tooDeep).toBeLessThan(600);
    if (process.env['MARKUP_DIFF_STATS']) console.info('deep', tally);
  });

  it('reports an unclosed members span once, though the old parser re-read it on a retry', () => {
    expect(oracleParse('*a :members[x').problems).toHaveLength(2);
    expect(parseMarkup('*a :members[x').problems).toEqual([{ line: 1, message: 'unclosed :members[' }]);
  });

  it('still reports two bad links on one line twice', () => {
    expect(parseMarkup('[a](http://x.example) [b](http://y.example)').problems).toEqual([
      { line: 1, message: 'the link "http://x.example" must start with https://, not http://' },
      { line: 1, message: 'the link "http://y.example" must start with https://, not http://' },
    ]);
  });
});
