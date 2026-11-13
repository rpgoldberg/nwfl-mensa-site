// E7A-FIX (the E7a real-stack check's S1): a pair of emphasis markers with nothing between them is not
// emphasis; it stays as written, as a lone "**" does. The old parser dropped it silently: "a__b" read
// "ab", and "window.__x = 1" previewed as "window.x = 1". Synthetic text only.
import { describe, expect, it } from 'vitest';
import { parseMarkup } from './markup.js';
import type { Inline } from './tree.js';

const text = (value: string, style: { bold?: boolean; italic?: boolean } = {}): Inline => ({
  type: 'text',
  text: value,
  bold: style.bold ?? false,
  italic: style.italic ?? false,
});
const paragraph = (src: string): Inline[] => {
  const { tree, problems } = parseMarkup(src);
  expect(problems).toEqual([]);
  expect(tree.blocks).toHaveLength(1);
  const block = tree.blocks[0];
  return block?.type === 'paragraph' ? block.children : [];
};

describe('an empty pair of emphasis markers stays as written', () => {
  it.each(['a__b', 'x__y__z', '__init__', 'a****b', 'a**b', 'window.__x = 1', '__ at the start', 'at the end__', 'a___b', 'a__b_c'])(
    'keeps %j as plain text, with no problem',
    (src) => {
      expect(paragraph(src)).toEqual([text(src)]);
    },
  );

  it('keeps pairs at the ends of joined lines (a paragraph reads its lines with a space between)', () => {
    expect(paragraph('a__\n__b')).toEqual([text('a__ __b')]);
  });

  it('keeps a pair inside a members span, a link label, and emphasis', () => {
    expect(paragraph(':members[a__b]')).toEqual([{ type: 'members', children: [text('a__b')] }]);
    expect(paragraph('[__init__](https://example.org/)')).toEqual([{ type: 'link', href: 'https://example.org/', children: [text('__init__')] }]);
    expect(paragraph('**a__b**')).toEqual([text('a__b', { bold: true })]);
    expect(paragraph('*a__b*')).toEqual([text('a__b', { italic: true })]);
  });

  it('keeps a bare URL whole across a pair', () => {
    expect(paragraph('see https://example.org/__init__ now')).toEqual([text('see https://example.org/__init__ now')]);
    const { problems } = parseMarkup('see http://a__b now');
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain('"http://a__b"');
  });

  it('still reads emphasis that holds something', () => {
    expect(paragraph('_a_ and **b**')).toEqual([text('a', { italic: true }), text(' and '), text('b', { bold: true })]);
    // A closer right after text closes the span as before (two spans, joined as one run); only an opener
    // met at once by its closer is a pair.
    expect(paragraph('_a__b_')).toEqual([text('ab', { italic: true })]);
  });
});
