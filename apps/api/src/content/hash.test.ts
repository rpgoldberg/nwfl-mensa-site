// The content hash (R25, P18): what "mark ready" records and approval is bound
// to. It covers everything the approver judges: the tree, title, summary,
// visibility, targets, edition, print-as-is and the files' own hashes.
import { describe, expect, it } from 'vitest';
import { canonicalJson, contentHash, type HashInput } from './hash.js';

const base: HashInput = {
  title: 'Picnic',
  summary: 'Saturday',
  visibility: 'public',
  body: { blocks: [{ type: 'paragraph', children: [{ type: 'text', text: 'Hi', bold: false, italic: false }] }] },
  targets: { website: true, newsletter: true, email: false },
  editionId: null,
  printAsIs: false,
  fileHashes: [Buffer.alloc(32, 1), Buffer.alloc(32, 2)],
};

describe('canonicalJson', () => {
  it('sorts object keys at every depth and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  });
});

describe('contentHash', () => {
  it('is 32 bytes, stable, and pinned so a change of canonical form is caught', () => {
    const hash = contentHash(base);
    expect(hash).toHaveLength(32);
    expect(contentHash({ ...base })).toEqual(hash);
    expect(hash.toString('hex')).toBe(PINNED);
  });

  it('ignores the order of the file hashes', () => {
    expect(contentHash({ ...base, fileHashes: [...base.fileHashes].reverse() })).toEqual(contentHash(base));
  });

  it.each<[string, Partial<HashInput>]>([
    ['title', { title: 'Picnic!' }],
    ['summary', { summary: null }],
    ['visibility', { visibility: 'members' }],
    ['body', { body: { blocks: [] } }],
    ['targets', { targets: { website: true, newsletter: false, email: false } }],
    ['edition', { editionId: '7a0d3d4e-1f1b-4c55-9a51-0b8f1c6a2e01' }],
    ['print-as-is', { printAsIs: true }],
    ['files', { fileHashes: [Buffer.alloc(32, 1)] }],
  ])('changes with the %s', (_label, change) => {
    expect(contentHash({ ...base, ...change })).not.toEqual(contentHash(base));
  });
});

// Computed independently: Python json.dumps(sort_keys=True, separators=(',', ':')) over the same object.
const PINNED = '547a3d07d994c2704eddbe23dd2650c7ed414c7ddb11c747ea132c4ea60f6d28';
