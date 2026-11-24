// ARCHIVE-SEARCH S1: the plain text of an item as an audience is given it, block by block.
import { create } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import { type Block, BlockSchema, ContentItemSchema, type Inline, InlineSchema, ItemState } from '../gen/nwfl/mensa/v1/content_pb.js';
import { MAX_TEXT_BYTES, MAX_TITLE_BYTES, itemText, putItem } from './items.js';

const t = (text: string): Inline => create(InlineSchema, { kind: { case: 'text', value: { text } } });
const redacted = (): Inline => create(InlineSchema, { kind: { case: 'redacted', value: {} } });
const p = (...inlines: Inline[]): Block => create(BlockSchema, { kind: { case: 'paragraph', value: { inlines } } });

describe('search/items: itemText', () => {
  it('gives the title, then the summary and every block as a line, with links and members spans read through', () => {
    const item = create(ContentItemSchema, {
      id: 'i',
      live: {
        title: '  Spring­  picnic ',
        summary: 'Come along.',
        body: {
          blocks: [
            create(BlockSchema, { kind: { case: 'heading', value: { level: 1, inlines: [t('Where')] } } }),
            p(t('At the '), create(InlineSchema, { kind: { case: 'link', value: { href: 'https://example.org/park', inlines: [t('park')] } } }), t('.')),
            p(t('Code: '), create(InlineSchema, { kind: { case: 'members', value: { inlines: [t('zephyrine')] } } })),
            create(BlockSchema, { kind: { case: 'list', value: { items: [{ blocks: [p(t('plates'))] }, { blocks: [p(t('cups'))] }] } } }),
            create(BlockSchema, { kind: { case: 'quote', value: { blocks: [p(t('See you there'))] } } }),
            create(BlockSchema, { kind: { case: 'members', value: { blocks: [p(t('Members park inside'))] } } }),
            create(BlockSchema, { kind: { case: 'image', value: { fileId: 'f', alt: 'A picnic table' } } }),
          ],
        },
      },
    });
    expect(itemText(item)).toEqual({
      title: 'Spring picnic',
      text: ['Come along.', 'Where', 'At the park.', 'Code: zephyrine', 'plates', 'cups', 'See you there', 'Members park inside', 'A picnic table'].join('\n'),
    });
    // A link's address is not text.
    expect(itemText(item)!.text).not.toContain('example.org');
  });

  it('leaves a redacted span as a gap between its neighbours, and a redacted block as nothing', () => {
    const item = create(ContentItemSchema, {
      live: { title: 'T', body: { blocks: [p(t('Call'), redacted(), t('today')), create(BlockSchema, { kind: { case: 'redacted', value: {} } }), p(t('Bring a dish'))] } },
    });
    expect(itemText(item)).toEqual({ title: 'T', text: 'Call today\nBring a dish' });
  });

  it('has nothing to index for no item, a withdrawn stub, and takes a version with no body by its summary', () => {
    expect(itemText(null)).toBeNull();
    expect(itemText(undefined)).toBeNull();
    expect(itemText(create(ContentItemSchema, { id: 'i', state: ItemState.WITHDRAWN }))).toBeNull();
    expect(itemText(create(ContentItemSchema, { live: { title: 'T', summary: 'Only this' } }))).toEqual({ title: 'T', text: 'Only this' });
  });

  it('caps the title and the text at the table\'s limits', () => {
    const item = create(ContentItemSchema, { live: { title: 'é'.repeat(600), body: { blocks: [p(t('word '.repeat(40_000)))] } } });
    const made = itemText(item)!;
    expect(Buffer.byteLength(made.title)).toBe(MAX_TITLE_BYTES);
    expect(Buffer.byteLength(made.text)).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    expect(Buffer.byteLength(made.text)).toBeGreaterThan(MAX_TEXT_BYTES - 8);
  });
});

describe('search/items: putItem', () => {
  const calls: unknown[][] = [];
  const db = { query: (_text: string, values?: unknown[]) => Promise.resolve(calls.push(values ?? [])) };

  it('sends the row for an output with an item, and a delete (null title and text) for no output or nothing to index', async () => {
    const sha = Buffer.alloc(32, 1);
    await putItem(db, 'v1', 'public', { output: sha, item: create(ContentItemSchema, { live: { title: 'T', summary: 'S' } }) });
    await putItem(db, 'v1', 'members', { output: null, item: create(ContentItemSchema, { live: { title: 'T', summary: 'S' } }) });
    await putItem(db, 'v1', 'public', { output: sha, item: create(ContentItemSchema, { state: ItemState.WITHDRAWN }) });
    await putItem(db, 'v1', 'public', { output: sha });
    expect(calls).toEqual([
      ['v1', 'public', sha, 'T', 'S'],
      ['v1', 'members', null, null, null],
      ['v1', 'public', sha, null, null],
      ['v1', 'public', sha, null, null],
    ]);
  });
});
