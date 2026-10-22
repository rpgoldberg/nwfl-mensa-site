// The officers' markup (addendum-publishing section 6): what the no-JavaScript
// editor's toolbar writes, parsed on the server into the body tree. Anything
// outside the allow-list is a problem that blocks "mark ready"; a broken
// members marker also makes everything after it members-only (fail closed).
import { describe, expect, it } from 'vitest';
import { parseMarkup } from './markup.js';
import { filterForPublic, normalizeTree, plainText } from './tree.js';

const FILE = '7a0d3d4e-1f1b-4c55-9a51-0b8f1c6a2e01';
const t = (text: string, bold = false, italic = false): Record<string, unknown> => ({ type: 'text', text, bold, italic });
const blocks = (src: string): unknown => parseMarkup(src).tree.blocks;

describe('parseMarkup: blocks', () => {
  it('splits paragraphs on blank lines and joins a paragraph’s lines with a space', () => {
    expect(blocks('One line\nand the next.\n\nSecond paragraph.')).toEqual([
      { type: 'paragraph', children: [t('One line and the next.')] },
      { type: 'paragraph', children: [t('Second paragraph.')] },
    ]);
    expect(parseMarkup('').tree).toEqual({ blocks: [] });
  });

  it('reads two heading levels', () => {
    expect(blocks('# Picnic\n\n## Where')).toEqual([
      { type: 'heading', level: 1, children: [t('Picnic')] },
      { type: 'heading', level: 2, children: [t('Where')] },
    ]);
  });

  it('reads bulleted and numbered lists, a quote and an image', () => {
    expect(blocks(`- Chairs\n* Water\n\n1. First\n2. Second\n\n> Quoted\n> on two lines\n\n![The flyer](file:${FILE})`)).toEqual([
      { type: 'list', ordered: false, items: [[{ type: 'paragraph', children: [t('Chairs')] }], [{ type: 'paragraph', children: [t('Water')] }]] },
      { type: 'list', ordered: true, items: [[{ type: 'paragraph', children: [t('First')] }], [{ type: 'paragraph', children: [t('Second')] }]] },
      { type: 'quote', children: [{ type: 'paragraph', children: [t('Quoted on two lines')] }] },
      { type: 'image', fileId: FILE, alt: 'The flyer' },
    ]);
  });

  it('reads a members block, with blocks inside it', () => {
    expect(blocks('Open.\n\n::: members\n## Gate\n\nCode 4417\n:::\n\nAfter.')).toEqual([
      { type: 'paragraph', children: [t('Open.')] },
      { type: 'members', children: [{ type: 'heading', level: 2, children: [t('Gate')] }, { type: 'paragraph', children: [t('Code 4417')] }] },
      { type: 'paragraph', children: [t('After.')] },
    ]);
  });
});

describe('parseMarkup: inline', () => {
  it('reads bold, italic in both spellings, and links', () => {
    expect(blocks('**Bold** and *it* and _also_ and [AML](https://us.mensa.org) or [mail](mailto:president@nwflorida.us).')).toEqual([
      {
        type: 'paragraph',
        children: [
          t('Bold', true),
          t(' and '),
          t('it', false, true),
          t(' and '),
          t('also', false, true),
          t(' and '),
          { type: 'link', href: 'https://us.mensa.org', children: [t('AML')] },
          t(' or '),
          { type: 'link', href: 'mailto:president@nwflorida.us', children: [t('mail')] },
          t('.'),
        ],
      },
    ]);
  });

  it('carries bold into a link and into a members span', () => {
    expect(blocks('**see [map](https://example.org/m) and :members[gate *4417*]**')).toEqual([
      {
        type: 'paragraph',
        children: [
          t('see ', true),
          { type: 'link', href: 'https://example.org/m', children: [t('map', true)] },
          t(' and ', true),
          { type: 'members', children: [t('gate ', true), t('4417', true, true)] },
        ],
      },
    ]);
  });

  it('reads a members span with brackets and a link inside', () => {
    expect(blocks('At :members[pavilion [3] via [map](https://example.org)].')).toEqual([
      {
        type: 'paragraph',
        children: [
          t('At '),
          { type: 'members', children: [t('pavilion [3] via '), { type: 'link', href: 'https://example.org', children: [t('map')] }] },
          t('.'),
        ],
      },
    ]);
  });

  it('keeps escaped markers, raw HTML and unpaired stars as plain text', () => {
    expect(blocks('\\*not italic\\* <b>raw</b> 2 * 3 and a lone ** pair')).toEqual([
      { type: 'paragraph', children: [t('*not italic* <b>raw</b> 2 * 3 and a lone ** pair')] },
    ]);
  });
});

describe('parseMarkup: problems block "mark ready", and broken markers fail closed', () => {
  it.each([
    ['an http: link', '[x](http://example.org)', /https: or mailto:/],
    ['a javascript: link', '[x](javascript:alert(1))', /https: or mailto:/],
    ['a third heading level', '### Too deep', /two heading levels/],
    ['an image without alt text', `![](file:${FILE})`, /alt text/],
    ['an image that is not an uploaded file', '![x](https://example.org/x.png)', /uploaded file/],
    ['a stray closing fence', 'Text\n:::', /closing ::: without/],
  ])('reports %s', (_label, src, message) => {
    const { problems } = parseMarkup(src);
    expect(problems.map((p) => p.message).join('; ')).toMatch(message);
  });

  it('reports an unclosed members span, and hides the rest of its paragraph', () => {
    const { tree, problems } = parseMarkup('Meet at :members[gate 4417 and more.\n\nNext paragraph.');
    expect(problems).toEqual([{ line: 1, message: 'unclosed :members[' }]);
    expect(plainText(filterForPublic(normalizeTree(tree)))).toBe('Meet at\nNext paragraph.');
  });

  it('reports an unclosed members block, and hides everything after it', () => {
    const { tree, problems } = parseMarkup('Open.\n\n::: members\nSecret.\n\nStill secret.');
    expect(problems).toEqual([{ line: 3, message: 'unclosed ::: members block' }]);
    expect(plainText(filterForPublic(normalizeTree(tree)))).toBe('Open.');
  });

  it('produces a tree the normalizer keeps as is', () => {
    const { tree } = parseMarkup(`# T\n\n**b** _i_ [l](https://x.example) :members[m]\n\n- a\n\n> q\n\n![alt](file:${FILE})\n\n::: members\nm\n:::`);
    expect(normalizeTree(tree)).toEqual(tree);
  });
});
