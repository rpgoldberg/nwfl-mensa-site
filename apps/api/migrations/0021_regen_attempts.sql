-- 0021_regen_attempts.sql: a file's regeneration attempts are counted in pdf_regen (UNTRUSTED-PDF-GATE,
-- fix round 3, S2).
--
-- Retries of an engine or gate that cannot be reached end after MAX_ENGINE_ATTEMPTS (regenerate.ts).
-- The count was kept in the worker's memory, so a worker restart started it again, and a check
-- child of the worker's uid (the in-pod mode) could kill the worker mid-job, which records no
-- failure at all: the file was claimed again after its lease, forever. Now:
--
--   * pdf_regen.attempts counts the claims of a file since it last finished: pdf_regen_claim adds
--     one when it leases the file, before any engine reads it, and returns the count. A run that
--     dies mid-job has already counted;
--   * pdf_regen_finish deletes the row when the copies are current (as 0018) and, when the file was
--     queued again meanwhile, clears the claim and sets the count back to 0: that run finished;
--   * pdf_regen_request leaves the count as it is.
--
-- pdf_regen_claim's result gains a column, so it is dropped and created again with 0015's grants;
-- nwfl_worker_grants() then moves it to the worker role where that exists, as it did. Owner,
-- SECURITY DEFINER and signature are unchanged, so the UNTRUSTED-PDF-GATE catalog is too.

ALTER TABLE pdf_regen ADD COLUMN attempts integer NOT NULL DEFAULT 0 CONSTRAINT pdf_regen_attempts_counted CHECK (attempts >= 0);

DROP FUNCTION pdf_regen_claim(integer);

CREATE FUNCTION pdf_regen_claim(p_lease_seconds integer) RETURNS TABLE (file_id uuid, claim uuid, attempts integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 1 AND 3600 THEN
    RAISE EXCEPTION 'a lease is 1 to 3600 seconds' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    WITH next AS (
      SELECT r.file_id FROM pdf_regen r WHERE r.claimed_until IS NULL OR r.claimed_until < clock_timestamp()
      ORDER BY r.generation LIMIT 1 FOR UPDATE SKIP LOCKED)
    UPDATE pdf_regen r SET claim = gen_random_uuid(), claimed_generation = r.generation,
                           claimed_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
                           attempts = r.attempts + 1
      FROM next WHERE r.file_id = next.file_id
      RETURNING r.file_id, r.claim, r.attempts;
END
$fn$;

REVOKE EXECUTE ON FUNCTION pdf_regen_claim(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pdf_regen_claim(integer) TO nwfl;

CREATE OR REPLACE FUNCTION pdf_regen_finish(p_file uuid, p_claim uuid, p_current bytea[]) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_row pdf_regen;
BEGIN
  SELECT * INTO v_row FROM pdf_regen WHERE file_id = p_file AND claim = p_claim FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_row.generation <> v_row.claimed_generation THEN
    UPDATE pdf_regen SET claim = NULL, claimed_generation = NULL, claimed_until = NULL, attempts = 0 WHERE file_id = p_file;
    RETURN false;
  END IF;
  PERFORM publication_ledger_stamp();
  DELETE FROM pdf_copy c
    WHERE c.file_id = p_file AND NOT (c.input_hash = ANY (coalesce(p_current, '{}')))
      AND (c.status = 'refused' OR NOT EXISTS (
        SELECT 1 FROM publication_ledger l
        WHERE l.subject_kind = 'stored_file' AND l.subject_id = p_file AND l.inputs ->> 'served' = 'copy'
          AND l.inputs ->> 'input_hash' = encode(c.input_hash, 'hex')));
  UPDATE pdf_copy SET stale = NOT (input_hash = ANY (coalesce(p_current, '{}')))
    WHERE file_id = p_file AND stale IS DISTINCT FROM NOT (input_hash = ANY (coalesce(p_current, '{}')));
  DELETE FROM pdf_regen WHERE file_id = p_file;
  RETURN true;
END
$fn$;

SELECT nwfl_worker_grants();
