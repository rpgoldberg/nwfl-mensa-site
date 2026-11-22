-- 0033_search_worker.sql: what the worker's index job needs beside the page writer (ARCHIVE-SEARCH S2).
--
-- The PDF worker keeps the issue text of the search index (src/search/pages.ts): after each copy it
-- makes, and in a sweep at each start. 0032 gave it search_page_put. The sweep needs two more things,
-- and each is a SECURITY DEFINER function, so the worker still reads no index table and no ledger row:
--
--   * search_page_lacking(text_version): each (file, audience) the publication ledger says is served
--     a COPY now, with no page row of that copy at that text version. File ids and audiences only:
--     no sha, no text. A new TEXT_VERSION (src/search/text.ts) lists every served copy again.
--   * search_page_sweep(): deletes every page row whose served_sha256 is not the ledger's current
--     output for its file and that table's audience, or whose audience is not served a copy at all
--     (the original, nothing, no ledger row). Returns how many. It is rule (b) of the read side made
--     permanent: such a row could not be returned by a search that checks the ledger, and after the
--     sweep it is not there to be returned by one that forgot to.
--
-- The sweep takes the lock pdf_regen_request and search_page_put take (the stored_file row, in id
-- order, for the files it found something to delete in), and only then deletes, deciding again: a
-- change or a put that was in flight has landed by then, and what it left is what is judged. It reads
-- the ledger without a lock; an append that lands during the delete can only make a row it deleted
-- current again, and the next start's search_page_lacking lists that file to be read again. It never
-- keeps a row it should have deleted.
--
-- Each table is named with its own audience's literal, in a statement of its own: no expression
-- chooses a table or an audience.
--
-- ADDITIVE and forward-only: two new functions and their grants. Nothing that ran on 0032 changes.

CREATE FUNCTION search_page_lacking(p_text_version integer) RETURNS TABLE (file_id uuid, audience text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF p_text_version IS NULL OR p_text_version < 1 THEN
    RAISE EXCEPTION 'the text version is a whole number from 1' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT l.subject_id, l.audience FROM publication_ledger l
      WHERE l.tenant_id = 'nwflorida' AND l.subject_kind = 'stored_file' AND l.audience = 'public' AND l.current_to IS NULL
        AND l.output_sha256 IS NOT NULL AND l.inputs ->> 'served' = 'copy'
        AND EXISTS (SELECT 1 FROM stored_file f WHERE f.id = l.subject_id)
        AND NOT EXISTS (SELECT 1 FROM search_page_public p
                         WHERE p.file_id = l.subject_id AND p.served_sha256 = l.output_sha256 AND p.text_version = p_text_version)
    UNION ALL
    SELECT l.subject_id, l.audience FROM publication_ledger l
      WHERE l.tenant_id = 'nwflorida' AND l.subject_kind = 'stored_file' AND l.audience = 'members' AND l.current_to IS NULL
        AND l.output_sha256 IS NOT NULL AND l.inputs ->> 'served' = 'copy'
        AND EXISTS (SELECT 1 FROM stored_file f WHERE f.id = l.subject_id)
        AND NOT EXISTS (SELECT 1 FROM search_page_members p
                         WHERE p.file_id = l.subject_id AND p.served_sha256 = l.output_sha256 AND p.text_version = p_text_version)
    ORDER BY 1, 2;
END
$fn$;

CREATE FUNCTION search_page_sweep() RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_files uuid[];
  v_rows  integer;
  v_total integer := 0;
BEGIN
  -- The files with a row to delete, as of now.
  SELECT coalesce(array_agg(DISTINCT s.file_id), '{}') INTO v_files FROM (
    SELECT p.file_id FROM search_page_public p
      WHERE NOT EXISTS (SELECT 1 FROM publication_ledger l
                         WHERE l.tenant_id = 'nwflorida' AND l.subject_kind = 'stored_file' AND l.subject_id = p.file_id AND l.audience = 'public'
                           AND l.current_to IS NULL AND l.output_sha256 = p.served_sha256 AND l.inputs ->> 'served' = 'copy')
    UNION ALL
    SELECT p.file_id FROM search_page_members p
      WHERE NOT EXISTS (SELECT 1 FROM publication_ledger l
                         WHERE l.tenant_id = 'nwflorida' AND l.subject_kind = 'stored_file' AND l.subject_id = p.file_id AND l.audience = 'members'
                           AND l.current_to IS NULL AND l.output_sha256 = p.served_sha256 AND l.inputs ->> 'served' = 'copy')
  ) s;
  IF cardinality(v_files) = 0 THEN
    RETURN 0;
  END IF;
  -- The lock pdf_regen_request and search_page_put take, in pdf_regen_request's order.
  PERFORM 1 FROM stored_file f WHERE f.id = ANY (v_files) ORDER BY f.id FOR NO KEY UPDATE OF f;
  -- Decided again, now that nothing else is changing these files' rows.
  DELETE FROM search_page_public p
    WHERE p.file_id = ANY (v_files)
      AND NOT EXISTS (SELECT 1 FROM publication_ledger l
                       WHERE l.tenant_id = 'nwflorida' AND l.subject_kind = 'stored_file' AND l.subject_id = p.file_id AND l.audience = 'public'
                         AND l.current_to IS NULL AND l.output_sha256 = p.served_sha256 AND l.inputs ->> 'served' = 'copy');
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_total := v_total + v_rows;
  DELETE FROM search_page_members p
    WHERE p.file_id = ANY (v_files)
      AND NOT EXISTS (SELECT 1 FROM publication_ledger l
                       WHERE l.tenant_id = 'nwflorida' AND l.subject_kind = 'stored_file' AND l.subject_id = p.file_id AND l.audience = 'members'
                         AND l.current_to IS NULL AND l.output_sha256 = p.served_sha256 AND l.inputs ->> 'served' = 'copy');
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_total + v_rows;
END
$fn$;

REVOKE EXECUTE ON FUNCTION search_page_lacking(integer), search_page_sweep() FROM PUBLIC;
-- The app role runs the regeneration job until the worker role exists (0017); nwfl_worker_grants() moves it.
GRANT EXECUTE ON FUNCTION search_page_lacking(integer), search_page_sweep() TO nwfl;

-- 0032's function, with the sweep's two: the worker's alone once the role exists.
CREATE OR REPLACE FUNCTION nwfl_worker_grants() RETURNS boolean
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
  -- inputsFor's links (LINKS L3): the active ones, as of a time.
  GRANT SELECT (id, file_id, page, rect, url, host, created_at) ON pdf_link TO nwfl_worker;
  GRANT SELECT (id, link_id, status, at) ON pdf_link_status TO nwfl_worker;
  GRANT EXECUTE ON FUNCTION pdf_regen_claim(integer), pdf_regen_original(uuid, uuid),
    pdf_copy_put(uuid, uuid, bytea, text, bytea, text, text[]), pdf_regen_finish(uuid, uuid, bytea[]), pdf_file_items(uuid),
    publication_ledger_lock(), publication_ledger_record_file(uuid, uuid, text, bytea, jsonb, integer),
    pdf_regen_request_files(uuid[]), search_page_put(uuid, text, bytea, integer, text[], text[]),
    search_page_lacking(integer), search_page_sweep() TO nwfl_worker;
  REVOKE EXECUTE ON FUNCTION publication_ledger_record(text, uuid, text, bytea, jsonb, integer),
    search_item_put(uuid, text, bytea, text, text) FROM nwfl_worker;
  REVOKE EXECUTE ON FUNCTION pdf_regen_claim(integer), pdf_regen_original(uuid, uuid),
    pdf_copy_put(uuid, uuid, bytea, text, bytea, text, text[]), pdf_regen_finish(uuid, uuid, bytea[]),
    publication_ledger_original(bigint, text, text[], text),
    publication_ledger_record_file(uuid, uuid, text, bytea, jsonb, integer),
    pdf_regen_request_files(uuid[]), search_page_put(uuid, text, bytea, integer, text[], text[]),
    search_page_lacking(integer), search_page_sweep() FROM nwfl;
  RETURN true;
END
$fn$;

SELECT nwfl_worker_grants();
