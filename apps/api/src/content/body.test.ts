// The body decision, each layer on its own: the SQL already keeps body_ast
// from public reads, and bodyFor() must hold even if it did not.
import { describe, expect, it } from 'vitest';
import { bodyFor } from './service.js';

const stored = {
  blocks: [{ type: 'paragraph', children: [{ type: 'text', text: 'Open' }, { type: 'members', children: [{ type: 'text', text: 'hidden' }] }] }],
};

describe('bodyFor', () => {
  it('filters a public item for the public, whatever column it was handed', () => {
    expect(JSON.stringify(bodyFor('public', 'public', stored))).not.toContain('hidden');
  });

  it('gives the public one placeholder for a members or officers item, ignoring what it was handed', () => {
    expect(bodyFor('public', 'members', stored)).toEqual({ blocks: [{ type: 'redacted' }] });
    expect(bodyFor('public', 'officers', stored)).toEqual({ blocks: [{ type: 'redacted' }] });
  });

  it('keeps members passages for members and officers', () => {
    expect(JSON.stringify(bodyFor('members', 'public', stored))).toContain('hidden');
    expect(JSON.stringify(bodyFor('officers', 'members', stored))).toContain('hidden');
  });
});
