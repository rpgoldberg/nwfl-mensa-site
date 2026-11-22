-- 0033_search_worker.sql: what the worker's index job needs beside the page writer (ARCHIVE-SEARCH S2).
--
-- The PDF worker keeps the issue text of the search index (src/search/pages.ts): after each copy it
-- makes, and in a sweep at each start. 0032 gave it search_page_put. The sweep needs two more things,
-- and each is a SECURITY DEFINER function, so the worker still reads no index table and no ledger row:
--
--   * search_page_lacking(text_version): each (file, audience) the publication ledger says is served
--     a COPY now, of a file the public or members may open, with no page row of that copy at that
--     text version. File ids and audiences only:
--     no sha, no text. A new TEXT_VERSION (src/search/text.ts) lists every served copy again.
--   * search_page_sweep(): deletes every page row whose served_sha256 is not the ledger's current
--     output for its file and that table's audience, or whose audience is not served a copy at all
--     (the original, nothing, no ledger row), or whose file its audience may not open at all
--     (search_page_servable). Returns how many. It is rule (b) of the read side made
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
-- Only text its audience may open (S2 challenge M2). The ledger records what each audience would be
-- served of a file, not whether the item may be opened at all: an officers-only item, a draft, a
-- withdrawn item and the file of a version no longer live all have ledger rows that say "copy".
-- search_page_servable(file) is content/files.ts servableFile's rule for the public and members, in
-- SQL: a PDF on its item's live version, the item published and the version not officers-only, or a
-- PDF of a published edition. search_page_lacking lists only such files, search_page_sweep deletes the
-- rows of every other, and search_page_put (0032's, with that one check added) refuses them. The
-- worker sweeps after each drain, so a withdrawn or re-scoped item's rows are gone a drain later; a put
-- that read the item just before its change committed is deleted by that same next sweep. The read side
-- (S3) applies the same rule again.
--
-- ADDITIVE and forward-only: three new functions, their grants, and 0032's search_page_put with one
-- more refusal. Nothing else that ran on 0032 changes.

-- Whether the public or members may open the file at all now (content/files.ts servableFile, for an
-- audience other than officers). Called by the three definers below, as their owner: no grant.
CREATE FUNCTION search_page_servable(p_file uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM stored_file f
      WHERE f.id = p_file AND f.mime_type = 'application/pdf'
        AND (EXISTS (SELECT 1 FROM content_item i JOIN content_version v ON v.id = i.live_version_id
                      WHERE v.id = f.version_id AND i.state = 'published' AND v.visibility <> 'officers')
             OR EXISTS (SELECT 1 FROM edition e WHERE e.id = f.edition_id AND e.status = 'published')))
$fn$;
REVOKE EXECUTE ON FUNCTION search_page_servable(uuid) FROM PUBLIC;

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
        AND EXISTS (SELECT 1 FROM stored_file f WHERE f.id = l.subject_id) AND search_page_servable(l.subject_id)
        AND NOT EXISTS (SELECT 1 FROM search_page_public p
                         WHERE p.file_id = l.subject_id AND p.served_sha256 = l.output_sha256 AND p.text_version = p_text_version)
    UNION ALL
    SELECT l.subject_id, l.audience FROM publication_ledger l
      WHERE l.tenant_id = 'nwflorida' AND l.subject_kind = 'stored_file' AND l.audience = 'members' AND l.current_to IS NULL
        AND l.output_sha256 IS NOT NULL AND l.inputs ->> 'served' = 'copy'
        AND EXISTS (SELECT 1 FROM stored_file f WHERE f.id = l.subject_id) AND search_page_servable(l.subject_id)
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
      WHERE NOT search_page_servable(p.file_id) OR NOT EXISTS (SELECT 1 FROM publication_ledger l
                         WHERE l.tenant_id = 'nwflorida' AND l.subject_kind = 'stored_file' AND l.subject_id = p.file_id AND l.audience = 'public'
                           AND l.current_to IS NULL AND l.output_sha256 = p.served_sha256 AND l.inputs ->> 'served' = 'copy')
    UNION ALL
    SELECT p.file_id FROM search_page_members p
      WHERE NOT search_page_servable(p.file_id) OR NOT EXISTS (SELECT 1 FROM publication_ledger l
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
      AND (NOT search_page_servable(p.file_id) OR NOT EXISTS (SELECT 1 FROM publication_ledger l
                       WHERE l.tenant_id = 'nwflorida' AND l.subject_kind = 'stored_file' AND l.subject_id = p.file_id AND l.audience = 'public'
                         AND l.current_to IS NULL AND l.output_sha256 = p.served_sha256 AND l.inputs ->> 'served' = 'copy'));
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_total := v_total + v_rows;
  DELETE FROM search_page_members p
    WHERE p.file_id = ANY (v_files)
      AND (NOT search_page_servable(p.file_id) OR NOT EXISTS (SELECT 1 FROM publication_ledger l
                       WHERE l.tenant_id = 'nwflorida' AND l.subject_kind = 'stored_file' AND l.subject_id = p.file_id AND l.audience = 'members'
                         AND l.current_to IS NULL AND l.output_sha256 = p.served_sha256 AND l.inputs ->> 'served' = 'copy'));
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_total + v_rows;
END
$fn$;

-- 0032's writer, refusing a file no audience here may open. Its owner and grants are kept.
CREATE OR REPLACE FUNCTION search_page_put(p_file uuid, p_audience text, p_sha bytea, p_text_version integer, p_pages text[], p_extras text[])
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_file   stored_file;
  v_item   uuid;
  v_output bytea;
  v_served text;
  v_count  integer := coalesce(cardinality(p_pages), 0);
BEGIN
  IF p_audience IS NULL OR p_audience NOT IN ('public', 'members') THEN
    RAISE EXCEPTION 'the index is kept for the public and for members' USING ERRCODE = '22023';
  END IF;
  IF p_file IS NULL OR p_sha IS NULL OR p_text_version IS NULL OR p_text_version < 1 THEN
    RAISE EXCEPTION 'a put needs its file, the sha served and the text version' USING ERRCODE = '22023';
  END IF;
  IF v_count < 1 OR v_count > 300 OR array_ndims(p_pages) <> 1
     OR p_extras IS NULL OR array_ndims(p_extras) IS DISTINCT FROM 1 OR cardinality(p_extras) <> v_count THEN
    RAISE EXCEPTION 'a put is 1 to 300 pages, with an extra for each' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_pages, p_extras) AS u(page, extra)
              WHERE u.page IS NULL OR u.extra IS NULL OR octet_length(u.page) > 65536 OR octet_length(u.extra) > 65536)
     OR (SELECT sum(octet_length(u.page)::bigint + octet_length(u.extra)) FROM unnest(p_pages, p_extras) AS u(page, extra)) > 4194304 THEN
    RAISE EXCEPTION 'a page is at most 64 KiB, and a file 4 MiB in all' USING ERRCODE = '22023';
  END IF;
  -- The lock pdf_regen_request takes: a change to what this file's copies hold waits, or is waited for.
  SELECT * INTO v_file FROM stored_file WHERE id = p_file FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such file' USING ERRCODE = '22023';
  END IF;
  -- FOR SHARE: an append that is closing this row is waited for, and then the row is current no longer.
  SELECT l.output_sha256, l.inputs ->> 'served' INTO v_output, v_served FROM publication_ledger l
    WHERE l.tenant_id = 'nwflorida' AND l.subject_kind = 'stored_file' AND l.subject_id = p_file AND l.audience = p_audience
      AND l.current_to IS NULL
    FOR SHARE;
  IF NOT FOUND OR v_output IS DISTINCT FROM p_sha OR v_served IS DISTINCT FROM 'copy' THEN
    RAISE EXCEPTION 'the ledger does not say this audience is served this copy now' USING ERRCODE = '55000';
  END IF;
  -- 0033: and only a file the public or members may open now (search_page_servable).
  IF NOT search_page_servable(p_file) THEN
    RAISE EXCEPTION 'this file is not one the public or members may open now' USING ERRCODE = '55000';
  END IF;
  SELECT v.item_id INTO v_item FROM content_version v WHERE v.id = v_file.version_id;
  IF p_audience = 'public' THEN
    DELETE FROM search_page_public WHERE file_id = p_file;
    INSERT INTO search_page_public (file_id, item_id, page, served_sha256, text_version, text, extra)
      SELECT p_file, v_item, u.n, p_sha, p_text_version, u.page, u.extra FROM unnest(p_pages, p_extras) WITH ORDINALITY AS u(page, extra, n);
  ELSE
    DELETE FROM search_page_members WHERE file_id = p_file;
    INSERT INTO search_page_members (file_id, item_id, page, served_sha256, text_version, text, extra)
      SELECT p_file, v_item, u.n, p_sha, p_text_version, u.page, u.extra FROM unnest(p_pages, p_extras) WITH ORDINALITY AS u(page, extra, n);
  END IF;
  RETURN v_count;
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
