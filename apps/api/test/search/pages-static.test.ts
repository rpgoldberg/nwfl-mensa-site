// ARCHIVE-SEARCH S2 (plan test 8, for the issue text): nothing the worker's index job runs can cross
// audiences. src/search/pages.ts names no table at all (it calls three functions and passes the
// audience as a value the database checks against the ledger), and each statement of 0034 that
// names one audience's page table names that audience's ledger rows and nothing of the other's.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
/** A source without its comments. */
const code = (source: string): string => source.replace(/^\s*(?:\/\/|--).*$/gm, '');

describe('the index job: no statement crosses audiences', () => {
  it('names no table in src/search/pages.ts: only the three functions the worker is granted', () => {
    const source = code(read('../../src/search/pages.ts'));
    const sql = [...source.matchAll(/`([^`]*)`/g)].map((match) => match[1] as string).filter((text) => /\b(?:SELECT|INSERT|UPDATE|DELETE)\b/.test(text));
    expect(sql).toEqual([
      'SELECT status, bytes FROM pdf_copy WHERE file_id = $1 AND input_hash = $2',
      'SELECT search_page_put($1, $2, $3, $4, $5::text[], $6::text[])',
      'SELECT search_page_sweep() AS n',
      'SELECT file_id, audience FROM search_page_lacking($1)',
    ]);
    expect(source).not.toMatch(/search_(?:page|item)_(?:public|members)/);
    expect(source).not.toMatch(/publication_ledger|search_item_put/);
  });

  it('reads the PDF nowhere in the worker\'s own process: the index job and the worker import no reader', () => {
    for (const file of ['../../src/search/pages.ts', '../../src/pdf/worker.ts', '../../src/pdf/socket-gate.ts', '../../src/pdf/text-protocol.ts']) {
      const source = code(read(file));
      expect(source, file).not.toMatch(/from '(?:\.\.\/pdf|\.)\/(?:gate-text|gate|gate-rules)\.js'/);
      expect(source, file).not.toMatch(/pdfjs|pdf-lib|getTextContent/);
    }
  });

  it('pairs each page table in 0034 with its own audience\'s ledger rows, statement by statement', () => {
    const all = code(read('../../migrations/0034_search_worker.sql'));
    // 0032's writer, restated with one more refusal: checked on its own below.
    const sql = all.slice(0, all.indexOf('CREATE OR REPLACE FUNCTION search_page_put')) + all.slice(all.indexOf('CREATE OR REPLACE FUNCTION nwfl_worker_grants'));
    const statements = sql.split(/\bUNION ALL\b|;/).filter((statement) => /search_page_(?:public|members)\b/.test(statement) && !/\b(?:GRANT|REVOKE)\b/.test(statement));
    expect(statements).toHaveLength(6);
    for (const statement of statements) {
      const tables = new Set([...statement.matchAll(/search_page_(public|members)\b/g)].map((match) => match[1]));
      expect([...tables], statement).toHaveLength(1);
      const [audience] = [...tables] as [string];
      const other = audience === 'public' ? 'members' : 'public';
      expect(statement, statement).toContain(`l.audience = '${audience}'`);
      expect(statement, statement).not.toContain(`'${other}'`);
      expect(statement, statement).toContain(`l.inputs ->> 'served' = 'copy'`);
      expect(statement, statement).toContain('l.current_to IS NULL');
      expect(statement, statement).toMatch(/l\.output_sha256 = p\.served_sha256|p\.served_sha256 = l\.output_sha256/);
    }
    // The two functions (all of the file before the grants are restated, but the servable rule) read nothing else of
    // the index or the content.
    const servable = sql.slice(sql.indexOf('CREATE FUNCTION search_page_servable'), sql.indexOf('CREATE FUNCTION search_page_lacking'));
    const functions = sql.slice(0, sql.indexOf('CREATE OR REPLACE FUNCTION nwfl_worker_grants')).replace(servable, '');
    expect(functions.length).toBeGreaterThan(1000);
    expect(functions).not.toMatch(/search_item_|content_version|content_item|\bedition\b|\bsearch_public\b|\bsearch_members\b|\.text\b|\.extra\b/);
    // S2 challenge M2: each listing and each delete asks the servable rule of the very file it names.
    expect(statements.filter((statement) => /search_page_servable\((?:l\.subject_id|p\.file_id)\)/.test(statement))).toHaveLength(6);
    // The rule reads the item, version and edition state alone: the index, the ledger and no text.
    expect(servable).toMatch(/LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp/);
    expect(servable).not.toMatch(/SECURITY DEFINER|search_page_(?:public|members)|publication_ledger|\btext\b|_ast\b/);
    expect(servable).toContain(`i.state = 'published' AND v.visibility <> 'officers'`);
    expect(servable).toContain(`e.status = 'published'`);
  });

  it('restates 0032\'s search_page_put in 0034 with exactly one more refusal: a file no audience here may open', () => {
    const body = (source: string, head: string): string => {
      const from = source.indexOf(head);
      return source.slice(from, source.indexOf('$fn$;', from) + 5);
    };
    const before = body(read('../../migrations/0032_search.sql'), 'CREATE FUNCTION search_page_put(');
    const after = body(read('../../migrations/0034_search_worker.sql'), 'CREATE OR REPLACE FUNCTION search_page_put(');
    const added = [
      '  -- 0034: and only a file the public or members may open now (search_page_servable).',
      '  IF NOT search_page_servable(p_file) THEN',
      "    RAISE EXCEPTION 'this file is not one the public or members may open now' USING ERRCODE = '55000';",
      '  END IF;',
      '',
    ].join('\n');
    const ledgerCheck = "the ledger does not say this audience is served this copy now' USING ERRCODE = '55000';\n  END IF;\n";
    expect(before).toContain(ledgerCheck);
    expect(after).toBe(before.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION').replace(ledgerCheck, ledgerCheck + added));
  });
});
