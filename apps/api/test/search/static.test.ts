// ARCHIVE-SEARCH S1 (plan test 8): no SQL the public side runs can name a members table. The tables
// have no audience column, so the only way to read across audiences is to name the other table; the
// names live in one file (src/search/tables.ts) and everything else takes them from there by audience.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { staleItemsSql } from '../../src/search/backfill.js';
import { SEARCH_AUDIENCES, SEARCH_TABLES } from '../../src/search/tables.js';

const SEARCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/search');
const sources = (): Array<{ name: string; text: string }> =>
  readdirSync(SEARCH)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => ({ name, text: readFileSync(path.join(SEARCH, name), 'utf8') }));

describe('search: the public side never names a members table', () => {
  it('has two audiences, and each one\'s tables carry its own name only', () => {
    expect(SEARCH_AUDIENCES).toEqual(['public', 'members']);
    expect(SEARCH_TABLES.public).toEqual({ item: 'search_item_public', page: 'search_page_public' });
    expect(SEARCH_TABLES.members).toEqual({ item: 'search_item_members', page: 'search_page_members' });
  });

  it('names a _members table in src/search only in tables.ts, on the members entry', () => {
    const files = sources();
    expect(files.map((file) => file.name)).toContain('tables.ts');
    for (const { name, text } of files) {
      const lines = text.split('\n').filter((line) => /_members\b/.test(line));
      if (name === 'tables.ts') {
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/^\s*members: \{ item: 'search_item_members', page: 'search_page_members' \},$/);
      } else {
        expect(lines, name).toEqual([]);
      }
    }
  });

  it('never names content_version\'s own search columns (finding F1: they hold unredacted text)', () => {
    for (const { name, text } of sources()) expect(text, name).not.toMatch(/\bsearch_public\b|\bsearch_members\b/);
  });

  it('builds every public statement without a members table, and every members statement without a public one', () => {
    const statements = { public: [staleItemsSql('public')], members: [staleItemsSql('members')] };
    for (const sql of statements.public) {
      expect(sql).toMatch(/\bsearch_item_public\b/);
      expect(sql).not.toMatch(/_members\b/);
      expect(sql).toMatch(/audience = 'public'/);
      expect(sql).not.toMatch(/audience = 'members'/);
    }
    for (const sql of statements.members) {
      expect(sql).toMatch(/\bsearch_item_members\b/);
      expect(sql).not.toMatch(/search_(item|page)_public\b/);
      expect(sql).toMatch(/audience = 'members'/);
      expect(sql).not.toMatch(/audience = 'public'/);
    }
  });
});
