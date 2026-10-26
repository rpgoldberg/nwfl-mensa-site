-- 0018_keep_served_copies.sql: a redacted copy that was ever served is kept (W-WORKER Fix 1).
--
-- 0015's pdf_regen_finish dropped every copy no audience uses any more, so the ledger's as-of check
-- of a past row had to make the copy again from the original (publication_ledger_original), which
-- 0017 takes from the app role. Now finish keeps every ready copy a ledger row records as served
-- (inputs->>'served' = 'copy' with its input_hash): it stays, marked stale, and the as-of check
-- hashes its bytes. A read serves only the copy whose hash is the inputs now, so a kept copy is
-- served again only if the inputs return to exactly what made it.
--
-- Still pruned: a copy no audience uses now that no ledger row records as served (made by a run
-- whose inputs changed before it was recorded), and every refused copy no audience uses (no bytes;
-- its ledger row records nothing to hash).
--
-- Finish takes the ledger lock (publication_ledger_stamp) before it decides, so no render can
-- record a copy between the check and the delete. Signature, owner and grants are unchanged
-- (CREATE OR REPLACE keeps them): the worker still writes only through this function.

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
    UPDATE pdf_regen SET claim = NULL, claimed_generation = NULL, claimed_until = NULL WHERE file_id = p_file;
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
