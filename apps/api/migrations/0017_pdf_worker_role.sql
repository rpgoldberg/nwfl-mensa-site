-- 0017_pdf_worker_role.sql: only the PDF worker's own role reaches original PDF bytes (W-WORKER).
--
-- 0015 left a hole it documented: the worker and the server were one role, and the database takes
-- the groups the app passes on trust, so the app role (or anyone who takes it over) could mark a
-- file as an "officer", claim it with pdf_regen_claim and read its original with
-- pdf_regen_original. 0016's publication_ledger_original was a second such path (an "officer" asks
-- for the original of a ledger row whose copy is gone; the app can make a copy go by changing the
-- policy). Now the job runs as nwfl_worker (src/worker.ts, its own process), which holds:
--   * EXECUTE on the four regeneration functions (claim, original, copy put, finish), on
--     pdf_file_items, and on the two ledger functions the job appends with (lock, record);
--   * SELECT on just the columns the job reads (below), and CONNECT and schema USAGE. Nothing
--     else: no write to any table, no other definer function, no content text, no member data.
-- The app role loses EXECUTE on the four regeneration functions and on publication_ledger_original.
-- It keeps pdf_original_read, which serves an original only to an audience whose every policy cell
-- shows and which the file is for: what that audience is given anyway. An officer's as-of check of
-- a copy that is gone now reports "inputs verified only" (src/ledger/ledger.ts); the ledger
-- function is not granted to the worker either, which never re-makes ledger copies.
--
-- The migrator cannot create roles (no CREATEROLE; fc creates nwfl_worker). So this file grants
-- only if the role exists, through nwfl_worker_grants(), which the migrator may run again at any
-- time. Once fc has created the role, re-running the migration Job applies the grants
-- (scripts/migrate.sh calls the function on every run), as does `SELECT nwfl_worker_grants();`
-- run as nwfl_migrator.
-- Without the role it changes nothing, so the app role keeps running the job (old behaviour), and
-- says so in a NOTICE. Grants are idempotent; the function is owned by the migrator and nobody
-- else may execute it.

CREATE FUNCTION nwfl_worker_grants() RETURNS boolean
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nwfl_worker') THEN
    RAISE NOTICE 'role nwfl_worker does not exist: the app role keeps the regeneration path; run SELECT nwfl_worker_grants() once it exists';
    RETURN false;
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO nwfl_worker', current_database());
  GRANT USAGE ON SCHEMA public TO nwfl_worker;
  -- inputsFor, renderFile and pdf_file_items (an invoker function).
  GRANT SELECT (id, audience, sha256, version_id, edition_id) ON stored_file TO nwfl_worker;
  GRANT SELECT (file_id) ON pdf_original TO nwfl_worker;
  GRANT SELECT (file_id, input_hash, status, bytes) ON pdf_copy TO nwfl_worker;
  GRANT SELECT (tenant_id, audience, category, action) ON redaction_policy TO nwfl_worker;
  GRANT SELECT (id, tenant_id, status, content_item_id, quote, category) ON redaction_mark TO nwfl_worker;
  GRANT SELECT (id, item_id) ON content_version TO nwfl_worker;
  GRANT SELECT (edition_id, item_id) ON edition_item TO nwfl_worker;
  GRANT EXECUTE ON FUNCTION pdf_regen_claim(integer), pdf_regen_original(uuid, uuid),
    pdf_copy_put(uuid, uuid, bytea, text, bytea, text), pdf_regen_finish(uuid, uuid, bytea[]), pdf_file_items(uuid),
    publication_ledger_lock(), publication_ledger_record(text, uuid, text, bytea, jsonb, integer) TO nwfl_worker;
  REVOKE EXECUTE ON FUNCTION pdf_regen_claim(integer), pdf_regen_original(uuid, uuid),
    pdf_copy_put(uuid, uuid, bytea, text, bytea, text), pdf_regen_finish(uuid, uuid, bytea[]),
    publication_ledger_original(bigint, text, text[], text) FROM nwfl;
  RETURN true;
END
$fn$;

REVOKE EXECUTE ON FUNCTION nwfl_worker_grants() FROM PUBLIC;

SELECT nwfl_worker_grants();
