-- 0019_harden.sql: HARDEN-1, from fc's review of 0010-0018 and its red team on 0017.
--
--   * The worker records through its own function, publication_ledger_record_file, and loses
--     publication_ledger_record. Before, it could append a row for any subject (a content version
--     included) with any output. Now a row it writes is for a stored_file with a PDF original,
--     under its live regeneration lease (pdf_regen_require), and its output is what is stored: the
--     original's sha256 when the inputs say the original is served, the sha256 of the ready copy
--     named by inputs->>'input_hash' when they say a copy is, and nothing otherwise. It does not
--     re-derive the policy decision itself (which audience gets which), which the worker computes.
--     Until fc creates nwfl_worker the app role runs the job, so it holds the new function too;
--     nwfl_worker_grants() moves it to the worker, as it does the regeneration functions.
--   * A row's inputs are at most 8 KiB (as jsonb text), in both record functions: the ledger is
--     kept forever, so a caller must not be able to grow it by megabytes a call. A manifest is a
--     few hundred bytes plus 39 per active mark id, so the cap holds about 190 marks a subject.
--   * No function in schema public is executable by PUBLIC: EXECUTE is revoked on every one, and
--     the migrator's default privileges no longer grant it to functions made later. Re-granted:
--     content_item_check_live_is_newest(uuid) to nwfl, which its invoker triggers (0010) call as
--     the writing role. Trigger functions need no grant (EXECUTE is checked when the trigger is
--     created, not when it fires); everything else nwfl and nwfl_worker call was granted by name.
--   * The fourteen functions of 0001-0011 without a pinned search_path get one.
--   * Correction: the headers of 0004 and 0013-0016 say their guard triggers hold "for every
--     role, the owner included". They hold for every role's writes, the owner's too; but the owner
--     (nwfl_migrator) can ALTER TABLE ... DISABLE TRIGGER or DROP TRIGGER, so against the owner the
--     guarantee is the migration review, not the trigger. Applied files cannot change (migrate.sh
--     exit 4), so the correction is here and on each trigger, as a comment.

ALTER FUNCTION content_version_freeze() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION audit_event_append_only() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION content_item_transition() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION content_version_starts_as_draft() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION content_item_starts_as_draft() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION signup_request_decision_final() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION member_account_signup_erased() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION content_item_check_live_is_newest(uuid) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION content_item_live_is_newest() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION content_version_live_is_newest() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION stored_file_frozen_once_approved() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION stored_file_frozen_whole() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION edition_status_forward() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION edition_item_pins_frozen() SET search_path = pg_catalog, public, pg_temp;

-- 0016's function, with the cap. CREATE OR REPLACE keeps its owner and grants.
CREATE OR REPLACE FUNCTION publication_ledger_record(p_kind text, p_subject uuid, p_audience text, p_output bytea, p_inputs jsonb,
                                                     p_withheld integer) RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_head publication_ledger_head;
  v_cur  publication_ledger;
  v_from timestamptz;
  v_seq  bigint;
  v_hash bytea;
  v_stamp timestamptz;
BEGIN
  IF p_subject IS NULL OR p_inputs IS NULL OR p_withheld IS NULL THEN
    RAISE EXCEPTION 'a ledger row needs its subject, inputs and count' USING ERRCODE = '22023';
  END IF;
  IF octet_length(p_inputs::text) > 8192 THEN
    RAISE EXCEPTION 'a ledger row''s inputs are at most 8 KiB' USING ERRCODE = '22023';
  END IF;
  v_stamp := publication_ledger_stamp();
  SELECT * INTO v_head FROM publication_ledger_head WHERE id FOR UPDATE;
  SELECT * INTO v_cur FROM publication_ledger
    WHERE tenant_id = 'nwflorida' AND subject_kind = p_kind AND subject_id = p_subject AND audience = p_audience AND current_to IS NULL;
  IF FOUND THEN
    IF v_cur.output_sha256 IS NOT DISTINCT FROM p_output AND v_cur.passages_withheld = p_withheld THEN
      RETURN NULL;
    END IF;
  ELSIF p_output IS NULL THEN
    RETURN NULL;
  END IF;
  -- The transaction's stamp, so windows follow the chain; never before the row it closes.
  v_from := greatest(v_stamp, v_cur.current_from);
  v_seq := v_head.seq + 1;
  v_hash := sha256(convert_to(publication_ledger_canonical(v_seq, 'nwflorida', p_kind, p_subject, p_audience, p_output, p_inputs,
                                                           p_withheld, v_from, v_head.row_hash), 'UTF8'));
  IF v_cur.seq IS NOT NULL THEN
    UPDATE publication_ledger SET current_to = v_from WHERE seq = v_cur.seq;
  END IF;
  INSERT INTO publication_ledger (seq, subject_kind, subject_id, audience, output_sha256, inputs, passages_withheld, current_from,
                                  prev_hash, row_hash)
    VALUES (v_seq, p_kind, p_subject, p_audience, p_output, p_inputs, p_withheld, v_from, v_head.row_hash, v_hash);
  UPDATE publication_ledger_head SET seq = v_seq, row_hash = v_hash WHERE id;
  RETURN v_seq;
END
$fn$;

-- The worker's append: one audience of a file it holds, with the output what is stored.
CREATE FUNCTION publication_ledger_record_file(p_file uuid, p_claim uuid, p_audience text, p_output bytea, p_inputs jsonb,
                                               p_withheld integer) RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_sha    bytea;
  v_served text := p_inputs ->> 'served';
  v_stored boolean;
BEGIN
  IF p_inputs IS NULL OR jsonb_typeof(p_inputs) <> 'object' OR octet_length(p_inputs::text) > 8192 THEN
    RAISE EXCEPTION 'a ledger row''s inputs are an object of at most 8 KiB' USING ERRCODE = '22023';
  END IF;
  PERFORM pdf_regen_require(p_file, p_claim);
  SELECT f.sha256 INTO v_sha FROM stored_file f JOIN pdf_original o ON o.file_id = f.id WHERE f.id = p_file;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'only a stored PDF is recorded here' USING ERRCODE = '22023';
  END IF;
  IF v_served = 'original' THEN
    v_stored := p_output = v_sha;
  ELSIF v_served = 'copy' THEN
    v_stored := EXISTS (
      SELECT 1 FROM pdf_copy c
      WHERE c.file_id = p_file AND c.status = 'ready' AND encode(c.input_hash, 'hex') = p_inputs ->> 'input_hash'
        AND sha256(c.bytes) = p_output);
  ELSE
    v_stored := p_output IS NULL;
  END IF;
  IF v_stored IS NOT TRUE THEN
    RAISE EXCEPTION 'the output is not what is stored for the file' USING ERRCODE = '22023';
  END IF;
  RETURN publication_ledger_record('stored_file', p_file, p_audience, p_output, p_inputs, p_withheld);
END
$fn$;

-- No function is anyone's by default; each role holds what it calls, by name.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT EXECUTE ON FUNCTION content_item_check_live_is_newest(uuid) TO nwfl;
-- The app role runs the job until the worker role exists (0017); nwfl_worker_grants() moves it.
GRANT EXECUTE ON FUNCTION publication_ledger_record_file(uuid, uuid, text, bytea, jsonb, integer) TO nwfl;

-- 0017's function, with the worker's record function in place of publication_ledger_record.
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
  GRANT EXECUTE ON FUNCTION pdf_regen_claim(integer), pdf_regen_original(uuid, uuid),
    pdf_copy_put(uuid, uuid, bytea, text, bytea, text), pdf_regen_finish(uuid, uuid, bytea[]), pdf_file_items(uuid),
    publication_ledger_lock(), publication_ledger_record_file(uuid, uuid, text, bytea, jsonb, integer) TO nwfl_worker;
  REVOKE EXECUTE ON FUNCTION publication_ledger_record(text, uuid, text, bytea, jsonb, integer) FROM nwfl_worker;
  REVOKE EXECUTE ON FUNCTION pdf_regen_claim(integer), pdf_regen_original(uuid, uuid),
    pdf_copy_put(uuid, uuid, bytea, text, bytea, text), pdf_regen_finish(uuid, uuid, bytea[]),
    publication_ledger_original(bigint, text, text[], text),
    publication_ledger_record_file(uuid, uuid, text, bytea, jsonb, integer) FROM nwfl;
  RETURN true;
END
$fn$;

SELECT nwfl_worker_grants();

COMMENT ON TRIGGER audit_event_no_update_or_delete ON audit_event IS
  'Refuses every role''s UPDATE and DELETE, the owner''s too; the owner can disable or drop the trigger (0019).';
COMMENT ON TRIGGER audit_event_no_truncate ON audit_event IS
  'Refuses every role''s TRUNCATE, the owner''s too; the owner can disable or drop the trigger (0019).';
COMMENT ON TRIGGER redaction_change_guard ON redaction_change IS
  'Keeps the change history for every role''s writes, the owner''s too; the owner can disable or drop the trigger (0019).';
COMMENT ON TRIGGER redaction_mark_guard ON redaction_mark IS
  'Keeps the mark history for every role''s writes, the owner''s too; the owner can disable or drop the trigger (0019).';
COMMENT ON TRIGGER pdf_original_guard ON pdf_original IS
  'Keeps an original as stored for every role''s writes, the owner''s too; the owner can disable or drop the trigger (0019).';
COMMENT ON TRIGGER pdf_copy_guard ON pdf_copy IS
  'Keeps a copy as made (but its stale flag) for every role''s writes, the owner''s too; the owner can disable or drop the trigger (0019).';
COMMENT ON TRIGGER publication_ledger_guard ON publication_ledger IS
  'Keeps every ledger row as written (current_to closes once) for every role''s writes, the owner''s too; the owner can disable or drop the trigger (0019).';
COMMENT ON TRIGGER publication_ledger_no_truncate ON publication_ledger IS
  'Refuses every role''s TRUNCATE, the owner''s too; the owner can disable or drop the trigger (0019).';
COMMENT ON TRIGGER redaction_mark_removal_guard ON redaction_mark_removal IS
  'Keeps the removal history for every role''s writes, the owner''s too; the owner can disable or drop the trigger (0019).';
