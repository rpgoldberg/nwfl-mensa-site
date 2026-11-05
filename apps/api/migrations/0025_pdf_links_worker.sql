-- 0025_pdf_links_worker.sql: what the PDF worker needs to make copies with links (LINKS L3).
--
-- 0024 left these to the worker code that uses them (its header, "Left to L3"):
--
--   * pdf_copy_put takes a seventh argument, the ids of the links the copy holds (the engine's
--     "kept", which the gate checked against the copy), and writes pdf_copy_link in the same
--     statement as the copy. A refused copy holds none; each id once, at most 500 (a file's
--     links, 0024); pdf_copy_link's own guard (0024) takes only a ready copy's own file's links.
--     A copy already made for these inputs is not put again, nor its links changed. The
--     six-argument put is dropped, so no worker can store a copy without saying what it holds.
--   * pdf_regen_request_files(uuid[]) queues files for the worker's boot sweep
--     (src/pdf/regenerate.ts sweepCopies): every file with a stored original that has no copy for
--     an audience's current input hash (an ENGINE_VERSION bump or a new LINK_ORIGIN changes every
--     hash, and nothing else queues them). At most 10000 files a call; a file with no original is
--     passed over (pdf_regen_request, 0015).
--   * nwfl_worker_grants() (0019's) gains SELECT on the link columns inputsFor reads (pdf_link:
--     id, file_id, page, rect, url, host, created_at; pdf_link_status: id, link_id, status, at;
--     never a link's kind, approval or a status's reason) and EXECUTE on the new put and the
--     sweep's request, for nwfl_worker, revoked from nwfl. Until fc creates the role the app role
--     keeps the regeneration path, as 0017 says.

DROP FUNCTION pdf_copy_put(uuid, uuid, bytea, text, bytea, text);

CREATE FUNCTION pdf_copy_put(p_file uuid, p_claim uuid, p_hash bytea, p_engine text, p_bytes bytea, p_reason text, p_links text[])
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_links text[] := coalesce(p_links, '{}');
BEGIN
  PERFORM pdf_regen_require(p_file, p_claim);
  IF array_ndims(v_links) > 1 OR cardinality(v_links) > 500 THEN
    RAISE EXCEPTION 'a copy holds at most 500 links, as a list' USING ERRCODE = '22023';
  END IF;
  IF array_position(v_links, NULL) IS NOT NULL OR (SELECT count(DISTINCT l) FROM unnest(v_links) AS l) <> cardinality(v_links) THEN
    RAISE EXCEPTION 'a copy holds each link once' USING ERRCODE = '22023';
  END IF;
  IF p_bytes IS NULL AND cardinality(v_links) > 0 THEN
    RAISE EXCEPTION 'a refused copy holds no links' USING ERRCODE = '22023';
  END IF;
  INSERT INTO pdf_copy (file_id, input_hash, engine, status, bytes, reason)
    VALUES (p_file, p_hash, p_engine, CASE WHEN p_bytes IS NULL THEN 'refused' ELSE 'ready' END, p_bytes,
            CASE WHEN p_bytes IS NULL THEN p_reason END)
    ON CONFLICT (file_id, input_hash) DO NOTHING;
  IF FOUND THEN
    INSERT INTO pdf_copy_link (file_id, input_hash, link_id) SELECT p_file, p_hash, l FROM unnest(v_links) AS l;
  END IF;
END
$fn$;

CREATE FUNCTION pdf_regen_request_files(p_files uuid[]) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF cardinality(coalesce(p_files, '{}')) > 10000 THEN
    RAISE EXCEPTION 'at most 10000 files a call' USING ERRCODE = '22023';
  END IF;
  PERFORM pdf_regen_request(coalesce(p_files, '{}'));
END
$fn$;

REVOKE EXECUTE ON FUNCTION pdf_copy_put(uuid, uuid, bytea, text, bytea, text, text[]), pdf_regen_request_files(uuid[]) FROM PUBLIC;
-- The app role runs the job until the worker role exists (0017); nwfl_worker_grants() moves both.
GRANT EXECUTE ON FUNCTION pdf_copy_put(uuid, uuid, bytea, text, bytea, text, text[]), pdf_regen_request_files(uuid[]) TO nwfl;

-- 0019's function, with the link reads, the seven-argument put and the sweep's request.
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
    pdf_regen_request_files(uuid[]) TO nwfl_worker;
  REVOKE EXECUTE ON FUNCTION publication_ledger_record(text, uuid, text, bytea, jsonb, integer) FROM nwfl_worker;
  REVOKE EXECUTE ON FUNCTION pdf_regen_claim(integer), pdf_regen_original(uuid, uuid),
    pdf_copy_put(uuid, uuid, bytea, text, bytea, text, text[]), pdf_regen_finish(uuid, uuid, bytea[]),
    publication_ledger_original(bigint, text, text[], text),
    publication_ledger_record_file(uuid, uuid, text, bytea, jsonb, integer),
    pdf_regen_request_files(uuid[]) FROM nwfl;
  RETURN true;
END
$fn$;

SELECT nwfl_worker_grants();
