// PW2: the body tree and the public filter (R26, addendum-publishing section 4).
// Members-only nodes become a placeholder that carries no text, length, link or
// image; anything the API cannot vouch for is treated as members-only.
import { describe, expect, it } from 'vitest';
import {
  type Tree,
  deriveForApproval,
  filterForPublic,
  normalizeTree,
  plainText,
  referencedFiles,
  toProtoDocument,
} from './tree.js';

const SECRET = 'gate code 4417';
const FILE_A = '7a0d3d4e-1f1b-4c55-9a51-0b8f1c6a2e01';
const FILE_B = '8b1e4e5f-2a2c-4d66-8b62-1c9a2d7b3f12';

const text = (value: string): Record<string, unknown> => ({ type: 'text', text: value });

const sample = {
  blocks: [
    { type: 'heading', level: 1, children: [text('Picnic')] },
    {
      type: 'paragraph',
      children: [
        text('The picnic is at '),
        { type: 'members', children: [text(SECRET), { type: 'link', href: 'https://example.org/map', children: [text('map')] }] },
        text('.'),
      ],
    },
    { type: 'members', children: [{ type: 'paragraph', children: [text('Carpool list')] }, { type: 'image', fileId: FILE_B, alt: 'Pavilion' }] },
    { type: 'image', fileId: FILE_A, alt: 'Flyer' },
    { type: 'list', ordered: false, items: [[{ type: 'paragraph', children: [text('Bring a chair')] }]] },
    { type: 'quote', children: [{ type: 'paragraph', children: [{ ...text('Quoted'), bold: true, italic: true }] }] },
  ],
};

describe('normalizeTree', () => {
  it('keeps every allowed node, rebuilt from its known fields only', () => {
    const tree = normalizeTree({ blocks: [{ type: 'paragraph', children: [{ type: 'text', text: 'x', bold: true, colour: 'red' }], style: 'big' }] });
    expect(tree).toEqual({ blocks: [{ type: 'paragraph', children: [{ type: 'text', text: 'x', bold: true, italic: false }] }] });
  });

  it('keeps members nodes for audiences that may see them', () => {
    const tree = normalizeTree(sample);
    expect(JSON.stringify(tree)).toContain(SECRET);
    expect(tree.blocks[2]?.type).toBe('members');
  });

  it.each([
    ['an unknown block type', { type: 'table', rows: [[SECRET]] }],
    ['a heading of level 3', { type: 'heading', level: 3, children: [text(SECRET)] }],
    ['an image without alt text', { type: 'image', fileId: FILE_A, alt: '' }],
    ['an image with a malformed file id', { type: 'image', fileId: '../etc/passwd', alt: 'x' }],
    ['a paragraph whose children are not a list', { type: 'paragraph', children: SECRET }],
    ['a list whose items are not lists of blocks', { type: 'list', ordered: true, items: [SECRET] }],
    ['a quote without children', { type: 'quote' }],
    ['a members block without children', { type: 'members' }],
    ['a node that is not an object', SECRET],
    ['null', null],
  ])('fails closed on %s: the block becomes a placeholder', (_label, block) => {
    const tree = normalizeTree({ blocks: [block] });
    expect(tree.blocks).toEqual([{ type: 'redacted' }]);
    expect(JSON.stringify(tree)).not.toContain(SECRET);
  });

  it.each([
    ['an unknown inline type', { type: 'footnote', text: SECRET }],
    ['a javascript: link', { type: 'link', href: 'javascript:alert(1)', children: [text(SECRET)] }],
    ['an http: link', { type: 'link', href: 'http://example.org', children: [text(SECRET)] }],
    ['a text node whose text is not a string', { type: 'text', text: 42 }],
    ['a members span without children', { type: 'members' }],
  ])('fails closed on %s: the inline becomes a placeholder', (_label, inline) => {
    const tree = normalizeTree({ blocks: [{ type: 'paragraph', children: [inline] }] });
    expect(tree.blocks).toEqual([{ type: 'paragraph', children: [{ type: 'redacted' }] }]);
  });

  it('accepts https: and mailto: links', () => {
    const tree = normalizeTree({
      blocks: [{ type: 'paragraph', children: [{ type: 'link', href: 'mailto:president@nwflorida.us', children: [text('write')] }] }],
    });
    expect(JSON.stringify(tree)).toContain('mailto:president@nwflorida.us');
  });

  it('turns a root that is not a tree into one placeholder', () => {
    expect(normalizeTree(undefined)).toEqual({ blocks: [{ type: 'redacted' }] });
    expect(normalizeTree({ blocks: 'nope' })).toEqual({ blocks: [{ type: 'redacted' }] });
    expect(normalizeTree([])).toEqual({ blocks: [{ type: 'redacted' }] });
  });

  it('treats a tree nested deeper than the limit as members-only below the limit', () => {
    let block: Record<string, unknown> = { type: 'paragraph', children: [text(SECRET)] };
    for (let depth = 0; depth < 40; depth += 1) block = { type: 'quote', children: [block] };
    const tree = normalizeTree({ blocks: [block] });
    expect(JSON.stringify(filterForPublic(tree))).not.toContain(SECRET);
  });

  it('fails closed on a broken members marker: that block and everything after it become members-only', () => {
    const tree = normalizeTree({
      blocks: [
        { type: 'paragraph', children: [text('Before.')] },
        { type: 'paragraph', children: [text(`Meet at :members[${SECRET}`)] },
        { type: 'paragraph', children: [text('After, still hidden.')] },
      ],
    });
    expect(tree.blocks[0]).toEqual({ type: 'paragraph', children: [{ type: 'text', text: 'Before.', bold: false, italic: false }] });
    expect(tree.blocks[1]?.type).toBe('members');
    const publicText = plainText(filterForPublic(tree));
    expect(publicText).toBe('Before.');
  });

  it('treats a stray ::: fence line as a broken marker too', () => {
    const tree = normalizeTree({ blocks: [{ type: 'paragraph', children: [text(`::: members\n${SECRET}`)] }] });
    expect(JSON.stringify(filterForPublic(tree))).not.toContain(SECRET);
  });
});

describe('filterForPublic', () => {
  const publicTree = filterForPublic(normalizeTree(sample));
  const serialized = JSON.stringify(publicTree);

  it('replaces every members node, inline or block, with a bare placeholder', () => {
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain('Carpool list');
    expect(publicTree.blocks[1]).toEqual({
      type: 'paragraph',
      children: [
        { type: 'text', text: 'The picnic is at ', bold: false, italic: false },
        { type: 'redacted' },
        { type: 'text', text: '.', bold: false, italic: false },
      ],
    });
    expect(publicTree.blocks[2]).toEqual({ type: 'redacted' });
  });

  it('leaves no link target, image reference or length behind', () => {
    expect(serialized).not.toContain('example.org/map');
    expect(serialized).not.toContain(FILE_B);
    expect(serialized).not.toMatch(/"(length|size|count|chars)"/);
  });

  it('keeps public content untouched', () => {
    expect(serialized).toContain('Picnic');
    expect(serialized).toContain(FILE_A);
    expect(serialized).toContain('Bring a chair');
  });

  it('keeps a public link with its target, filtering inside its text', () => {
    const tree = normalizeTree({
      blocks: [{ type: 'paragraph', children: [{ type: 'link', href: 'https://us.mensa.org', children: [text('AML'), { type: 'members', children: [text(SECRET)] }] }] }],
    });
    expect(filterForPublic(tree).blocks[0]).toEqual({
      type: 'paragraph',
      children: [{ type: 'link', href: 'https://us.mensa.org', children: [{ type: 'text', text: 'AML', bold: false, italic: false }, { type: 'redacted' }] }],
    });
  });

  it('is idempotent, so re-filtering a stored public_ast changes nothing', () => {
    expect(filterForPublic(normalizeTree(publicTree))).toEqual(publicTree);
  });
});

describe('plainText, referencedFiles and deriveForApproval', () => {
  const tree = normalizeTree(sample);

  it('extracts the words, link text and alt text, skipping placeholders', () => {
    expect(plainText(tree)).toContain(SECRET);
    expect(plainText(tree)).toContain('Pavilion');
    expect(plainText(filterForPublic(tree))).not.toContain(SECRET);
    expect(plainText(filterForPublic(tree))).toContain('Flyer');
  });

  it('separates files referenced publicly from files referenced only inside members passages', () => {
    expect(referencedFiles(tree)).toEqual({ all: [FILE_B, FILE_A], publicOnly: [FILE_A], membersOnly: [FILE_B] });
  });

  it('derives the public tree and both search texts of a public item, with title and summary in each', () => {
    const derived = deriveForApproval({ title: 'Summer picnic', summary: 'Saturday at noon', visibility: 'public', body: sample });
    expect(derived.publicAst).toEqual(filterForPublic(tree));
    expect(derived.publicText).toMatch(/^Summer picnic\nSaturday at noon\n/);
    expect(derived.publicText).not.toContain(SECRET);
    expect(derived.membersText).toContain(SECRET);
    expect(derived.membersText).toMatch(/^Summer picnic\nSaturday at noon\n/);
  });

  it('gives a members item a public tree of one placeholder and a public text of its title and summary only', () => {
    const derived = deriveForApproval({ title: 'Dues', summary: 'For members', visibility: 'members', body: { blocks: [{ type: 'paragraph', children: [text(SECRET)] }] } });
    expect(derived.publicAst).toEqual({ blocks: [{ type: 'redacted' }] });
    expect(derived.publicText).toBe('Dues\nFor members');
    expect(derived.membersText).toBe(`Dues\nFor members\n${SECRET}`);
  });

  it('makes an officers item findable by neither index, title included', () => {
    const derived = deriveForApproval({ title: `Memo ${SECRET}`, summary: null, visibility: 'officers', body: { blocks: [] } });
    expect(derived).toEqual({ publicAst: { blocks: [{ type: 'redacted' }] }, publicText: '', membersText: '' });
  });

  it('derives from an empty summary without a stray line', () => {
    expect(deriveForApproval({ title: 'T', summary: null, visibility: 'public', body: { blocks: [] } }).publicText).toBe('T');
  });
});

describe('toProtoDocument', () => {
  it('maps every node kind onto the proto oneofs', () => {
    const doc = toProtoDocument(normalizeTree(sample));
    expect(doc.blocks.map((b) => b.kind.case)).toEqual(['heading', 'paragraph', 'members', 'image', 'list', 'quote']);
    const paragraph = doc.blocks[1]?.kind;
    expect(paragraph?.case === 'paragraph' && paragraph.value.inlines.map((i) => i.kind.case)).toEqual(['text', 'members', 'text']);
  });

  it('maps placeholders to Redacted, at block and inline level', () => {
    const tree: Tree = { blocks: [{ type: 'redacted' }, { type: 'paragraph', children: [{ type: 'redacted' }] }] };
    const doc = toProtoDocument(tree);
    expect(doc.blocks[0]?.kind.case).toBe('redacted');
    const paragraph = doc.blocks[1]?.kind;
    expect(paragraph?.case === 'paragraph' && paragraph.value.inlines[0]?.kind.case).toBe('redacted');
  });
});
