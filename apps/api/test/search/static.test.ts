// ARCHIVE-SEARCH S1 (plan test 8): no SQL the public side runs can name a members table. The tables
// have no audience column, so the only way to read across audiences is to name the other table; the
// names live in one file (src/search/tables.ts) and everything else takes them from there by audience.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { staleItemsSql } from '../../src/search/backfill.js';
import { searchSql, snippetSql } from '../../src/search/sql.js';
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
    const statements = { public: [staleItemsSql('public'), searchSql('public')], members: [staleItemsSql('members'), searchSql('members')] };
    // The snippet statement reads the audience's two tables by key and names no ledger row.
    expect(snippetSql('public')).toMatch(/\bsearch_item_public\b/);
    expect(snippetSql('public')).toMatch(/\bsearch_page_public\b/);
    expect(snippetSql('public')).not.toMatch(/_members\b/);
    expect(snippetSql('members')).not.toMatch(/search_(item|page)_public\b/);
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

  // ARCHIVE-SEARCH S3: the read. Its statements are built from the audience alone, a closed set of two; what a visitor
  // typed reaches them only as a bound parameter.
  describe('the search statements', () => {
    it('take the audience and nothing else: no word of a query can be part of their text', () => {
      for (const build of [searchSql, snippetSql]) {
        expect(build.length).toBe(1);
        expect(build('public')).toBe(build('public'));
        // @ts-expect-error an audience outside the two is refused at compile time, and at run time
        expect(() => build("public' OR '1'='1")).toThrow();
        // @ts-expect-error officers have no index
        expect(() => build('officers')).toThrow();
        // A name every object answers to is not an audience either.
        for (const name of ['constructor', '__proto__', 'toString']) expect(() => build(name as 'public'), name).toThrow('no such search audience');
      }
    });

    it('read the query and the rest as parameters, and the query only through websearch_to_tsquery', () => {
      for (const audience of SEARCH_AUDIENCES) {
        const [search, snippet] = [searchSql(audience), snippetSql(audience)];
        expect([...new Set(search.match(/\$\d+/g))].sort()).toEqual(['$1', '$2']);
        expect([...new Set(snippet.match(/\$\d+/g))].sort()).toEqual(['$1', '$2', '$3', '$4']);
        for (const sql of [search, snippet]) {
          expect(sql.match(/\$1/g)).toHaveLength(1);
          expect(sql).toContain("websearch_to_tsquery('english', $1)");
          expect(sql).not.toMatch(/to_tsquery\('english', [^$]/);
          expect(sql).not.toMatch(/\bLIKE\b|\bILIKE\b|SIMILAR TO|~\*?\s/i);
        }
        expect(search).toMatch(/LIMIT \$2$/);
        expect(search).not.toMatch(/OFFSET/);
      }
    });

    it('reads both of an audience\'s tables, and holds every row to the ledger\'s current output for that audience (read rule b)', () => {
      for (const audience of SEARCH_AUDIENCES) {
        const sql = searchSql(audience);
        expect(sql).toContain(SEARCH_TABLES[audience].item);
        expect(sql).toContain(SEARCH_TABLES[audience].page);
        expect(sql).toMatch(/l\.subject_kind = 'stored_file' AND l\.subject_id = p\.file_id[^)]*l\.current_to IS NULL[^)]*l\.output_sha256 = p\.served_sha256[^)]*l\.inputs ->> 'served' = 'copy'/);
        expect(sql).toMatch(/l\.subject_kind = 'content_version' AND l\.subject_id = s\.version_id[^)]*l\.current_to IS NULL[^)]*l\.output_sha256 = s\.rendered_sha256/);
        // Every ledger read names this audience, and no other.
        const named = [...sql.matchAll(/l\.audience = '(\w+)'/g)].map((found) => found[1]);
        expect(named.length).toBeGreaterThanOrEqual(2);
        expect(new Set(named)).toEqual(new Set([audience]));
      }
    });

    it('repeats the served reads\' conditions (read rule c): a live version of a published item that is not officers-only, or a published edition', () => {
      for (const audience of SEARCH_AUDIENCES) {
        const sql = searchSql(audience);
        expect(sql.match(/i\.state = 'published'/g)?.length).toBe(2);
        expect(sql.match(/v\.visibility <> 'officers'/g)?.length).toBe(2);
        expect(sql).toMatch(/i\.live_version_id = v\.id/);
        expect(sql).toMatch(/i\.live_version_id = s\.version_id/);
        expect(sql).toMatch(/e\.status = 'published'/);
        expect(sql).toMatch(/f\.mime_type = 'application\/pdf'/);
        expect(sql).not.toMatch(/\$\d+ OR v\.visibility/);
      }
    });

    it('makes a snippet from the row\'s own text in the audience\'s own table, for the hits it is given and no search of its own', () => {
      for (const audience of SEARCH_AUDIENCES) {
        expect(searchSql(audience)).not.toMatch(/ts_headline|\.text\b/);
        const sql = snippetSql(audience);
        const headlines = sql.match(/ts_headline\('english', [^,]+,/g) ?? [];
        expect(headlines).toHaveLength(2);
        for (const headline of headlines) expect(headline).toMatch(/^ts_headline\('english', translate\((p|s)\.text,$/);
        expect(sql).toMatch(/MaxFragments=2, MinWords=12, MaxWords=30/);
        expect(sql).toMatch(/WHERE p\.file_id = h\.id AND p\.page = h\.page\)/);
        expect(sql).toMatch(/WHERE s\.item_id = h\.id\)/);
        expect(sql).not.toMatch(/@@/);
      }
    });
  });
});
