// ============================================================================
// UNTRUSTED-PDF-GATE, the catalog (NEEDS.md "UNTRUSTED-PDF-GATE"): the backstop under the text checks
// in untrusted-pdf.test.ts. Text can be evaded (a new SECURITY DEFINER writer, a table grant, a role
// that joins nwfl, a new owner, a grant built at run time); the catalog cannot. After every migration
// has run on a fresh database, this freezes who can write pdf_original or reach it through a function:
//
//   - the roles with INSERT, UPDATE, DELETE or TRUNCATE on pdf_original (any column counts);
//   - every function whose source names pdf_original, with its owner, whether it runs as its owner
//     (SECURITY DEFINER) and who may execute it;
//   - every SECURITY DEFINER function at all, since one can build its SQL at run time;
//   - the roles that are members of nwfl, directly or through other roles;
//   - the owner of each pdf_original_put.
//
// Superusers and the predefined pg_* roles are left out (a role granted one of those shows up itself).
// A change here is a review: check it against UNTRUSTED-PDF-GATE, then update the frozen value below in
// the same PR. The lift (UNTRUSTED_PDF_READY) does not lift this test.
// ============================================================================
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dropDatabase, freshDatabase, live, migrate, url } from '../helpers/pg.js';

const SEE = 'see NEEDS UNTRUSTED-PDF-GATE';
const ROLES = `SELECT r.oid, r.rolname FROM pg_roles r WHERE NOT r.rolsuper AND r.rolname !~ '^pg_'`;

const QUERIES = {
  writers: `
    SELECT r.rolname::text AS role, array_agg(p.priv ORDER BY p.priv) AS privileges
      FROM (${ROLES}) r CROSS JOIN unnest(ARRAY['DELETE', 'INSERT', 'TRUNCATE', 'UPDATE']) AS p(priv)
     WHERE has_table_privilege(r.oid, 'public.pdf_original', p.priv)
        OR (p.priv IN ('INSERT', 'UPDATE') AND has_any_column_privilege(r.oid, 'public.pdf_original', p.priv))
     GROUP BY r.rolname ORDER BY r.rolname`,
  functions: `
    SELECT p.oid::regprocedure::text AS function, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer,
           ARRAY(SELECT r.rolname::text FROM (${ROLES}) r WHERE has_function_privilege(r.oid, p.oid, 'EXECUTE') ORDER BY r.rolname) AS executors
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND p.prosrc ~ 'pdf_original'
     ORDER BY 1`,
  definers: `
    SELECT p.oid::regprocedure::text AS function, pg_get_userbyid(p.proowner) AS owner,
           ARRAY(SELECT r.rolname::text FROM (${ROLES}) r WHERE has_function_privilege(r.oid, p.oid, 'EXECUTE') ORDER BY r.rolname) AS executors
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND p.prosecdef
     ORDER BY 1`,
  members: `SELECT r.rolname::text AS role FROM (${ROLES}) r WHERE r.rolname <> 'nwfl' AND pg_has_role(r.oid, 'nwfl', 'MEMBER') ORDER BY 1`,
  putOwner: `SELECT p.oid::regprocedure::text AS function, pg_get_userbyid(p.proowner) AS owner FROM pg_proc p WHERE p.proname = 'pdf_original_put' ORDER BY 1`,
} as const;

type Name = keyof typeof QUERIES;

/** FROZEN: today's catalog after 0000-0020, with nwfl_worker present (its grants applied). */
const FROZEN: Record<Name, unknown[]> = {
  writers: [
    { role: 'nwfl_migrator', privileges: ['DELETE', 'INSERT', 'TRUNCATE', 'UPDATE'] },
  ],
  functions: [
    { function: 'nwfl_worker_grants()', owner: 'nwfl_migrator', definer: false, executors: ['nwfl_migrator'] },
    { function: 'pdf_original_put(uuid,bytea,text,text[],text)', owner: 'nwfl_migrator', definer: true, executors: ['nwfl', 'nwfl_migrator'] },
    { function: 'pdf_original_read(uuid,text)', owner: 'nwfl_migrator', definer: true, executors: ['nwfl', 'nwfl_migrator'] },
    { function: 'pdf_regen_original(uuid,uuid)', owner: 'nwfl_migrator', definer: true, executors: ['nwfl_migrator', 'nwfl_worker'] },
    { function: 'pdf_regen_request(uuid[])', owner: 'nwfl_migrator', definer: false, executors: ['nwfl_migrator'] },
    { function: 'pdf_stale_on_policy()', owner: 'nwfl_migrator', definer: true, executors: ['nwfl_migrator'] },
    { function: 'publication_ledger_original(bigint,text,text[],text)', owner: 'nwfl_migrator', definer: true, executors: ['nwfl_migrator'] },
    { function: 'publication_ledger_record_file(uuid,uuid,text,bytea,jsonb,integer)', owner: 'nwfl_migrator', definer: true, executors: ['nwfl_migrator', 'nwfl_worker'] },
    { function: 'redaction_mark_add_file(uuid,text,text,uuid[],text,text[],text)', owner: 'nwfl_migrator', definer: true, executors: ['nwfl', 'nwfl_migrator'] },
    { function: 'redaction_mark_anchor_guard()', owner: 'nwfl_migrator', definer: false, executors: ['nwfl_migrator'] },
  ],
  definers: [
    { function: 'pdf_copy_put(uuid,uuid,bytea,text,bytea,text)', owner: 'nwfl_migrator', executors: ['nwfl_migrator', 'nwfl_worker'] },
    { function: 'pdf_original_put(uuid,bytea,text,text[],text)', owner: 'nwfl_migrator', executors: ['nwfl', 'nwfl_migrator'] },
    { function: 'pdf_original_read(uuid,text)', owner: 'nwfl_migrator', executors: ['nwfl', 'nwfl_migrator'] },
    { function: 'pdf_regen_claim(integer)', owner: 'nwfl_migrator', executors: ['nwfl_migrator', 'nwfl_worker'] },
    { function: 'pdf_regen_finish(uuid,uuid,bytea[])', owner: 'nwfl_migrator', executors: ['nwfl_migrator', 'nwfl_worker'] },
    { function: 'pdf_regen_original(uuid,uuid)', owner: 'nwfl_migrator', executors: ['nwfl_migrator', 'nwfl_worker'] },
    { function: 'pdf_stale_on_edition_item()', owner: 'nwfl_migrator', executors: ['nwfl_migrator'] },
    { function: 'pdf_stale_on_mark()', owner: 'nwfl_migrator', executors: ['nwfl_migrator'] },
    { function: 'pdf_stale_on_policy()', owner: 'nwfl_migrator', executors: ['nwfl_migrator'] },
    { function: 'publication_ledger_lock()', owner: 'nwfl_migrator', executors: ['nwfl', 'nwfl_migrator', 'nwfl_worker'] },
    { function: 'publication_ledger_lock_trigger()', owner: 'nwfl_migrator', executors: ['nwfl_migrator'] },
    { function: 'publication_ledger_original(bigint,text,text[],text)', owner: 'nwfl_migrator', executors: ['nwfl_migrator'] },
    { function: 'publication_ledger_record(text,uuid,text,bytea,jsonb,integer)', owner: 'nwfl_migrator', executors: ['nwfl', 'nwfl_migrator'] },
    { function: 'publication_ledger_record_file(uuid,uuid,text,bytea,jsonb,integer)', owner: 'nwfl_migrator', executors: ['nwfl_migrator', 'nwfl_worker'] },
    { function: 'publication_ledger_stamp()', owner: 'nwfl_migrator', executors: ['nwfl_migrator'] },
    { function: 'publication_ledger_stamp_change()', owner: 'nwfl_migrator', executors: ['nwfl_migrator'] },
    { function: 'publication_ledger_stamp_mark()', owner: 'nwfl_migrator', executors: ['nwfl_migrator'] },
    { function: 'redaction_approve(uuid,text,text[],text)', owner: 'nwfl_migrator', executors: ['nwfl', 'nwfl_migrator'] },
    { function: 'redaction_mark_add(text,uuid,text,text,text,text,text[],text)', owner: 'nwfl_migrator', executors: ['nwfl', 'nwfl_migrator'] },
    { function: 'redaction_mark_add_file(uuid,text,text,uuid[],text,text[],text)', owner: 'nwfl_migrator', executors: ['nwfl', 'nwfl_migrator'] },
    { function: 'redaction_mark_approve_removal(uuid,text,text[],text)', owner: 'nwfl_migrator', executors: ['nwfl', 'nwfl_migrator'] },
    { function: 'redaction_mark_propose_removal(uuid,text,text[],text)', owner: 'nwfl_migrator', executors: ['nwfl', 'nwfl_migrator'] },
    { function: 'redaction_propose(text,text,text,text,text,text[],text)', owner: 'nwfl_migrator', executors: ['nwfl', 'nwfl_migrator'] },
  ],
  members: [],
  putOwner: [
    { function: 'pdf_original_put(uuid,bytea,text,text[],text)', owner: 'nwfl_migrator' },
  ],
};

const WHAT: Record<Name, string> = {
  writers: 'the roles that can write pdf_original',
  functions: 'the functions that name pdf_original (owner, SECURITY DEFINER, executors)',
  definers: 'the SECURITY DEFINER functions (owner, executors)',
  members: 'the members of role nwfl',
  putOwner: 'the owner of pdf_original_put',
};

describe.skipIf(!live)('UNTRUSTED-PDF-GATE catalog', () => {
  let database: string;
  let client: pg.Client;

  beforeAll(async () => {
    database = await freshDatabase('nwfl_gate_catalog');
    const run = await migrate(database);
    if (run.code !== 0) throw new Error(`migrate failed: ${run.stderr}`);
    const target = new URL(url as string);
    target.pathname = `/${database}`;
    client = new pg.Client({ connectionString: target.toString() });
    await client.connect();
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    if (database !== undefined) await dropDatabase(database);
  });

  it('nobody new can write pdf_original or reach it through a function, after every migration', async () => {
    const problems: string[] = [];
    const actual: Partial<Record<Name, unknown[]>> = {};
    for (const name of Object.keys(QUERIES) as Name[]) {
      const rows = (await client.query(QUERIES[name])).rows as unknown[];
      actual[name] = rows;
      if (JSON.stringify(rows) !== JSON.stringify(FROZEN[name])) {
        const now = rows.map((row) => JSON.stringify(row));
        const then = FROZEN[name].map((row) => JSON.stringify(row));
        const added = now.filter((row) => !then.includes(row));
        const removed = then.filter((row) => !now.includes(row));
        problems.push(
          `UNTRUSTED-PDF-GATE: the catalog changed: ${WHAT[name]} gained [${added.join(', ')}] and lost [${removed.join(', ')}]; review it against UNTRUSTED-PDF-GATE, then update FROZEN.${name} at test/gates/untrusted-pdf-catalog.test.ts in the same PR; ${SEE}`,
        );
      }
    }
    if (process.env['DUMP_GATE_CATALOG'] === '1') process.stdout.write(`${JSON.stringify(actual, null, 2)}\n`);
    if (problems.length > 0) throw new Error(problems.join('\n'));
    expect(problems).toEqual([]);
  });
});
