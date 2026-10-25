-- 0015_pdf_store.sql: PDF originals and their redacted copies, in Postgres (REDACT R3b).
--
-- pdf_original holds the bytes of a PDF stored_file, at most 10 MiB (R11), and pdf_copy one
-- redacted copy per distinct input. The API keys each copy by a hash of everything the engine is
-- given: the original's sha256, the marked passages the audience's policy redacts, whether it
-- redacts anything, and the engine's version. Audiences whose inputs are the same share a copy.
-- An audience whose every policy cell is "show" is given the original; one a mark hides from is
-- given nothing.
--
-- A copy is made by a background job, never on a read (the output gate can take seconds). When a
-- policy cell, a mark, or the items an edition prints change, triggers mark the affected copies
-- stale and queue their files in pdf_regen. A read serves only the copy whose hash matches the
-- inputs now; anything else is "not ready", never a stale copy and never the original.
--
-- The app role (as in 0013 and 0014):
--   * may not read an original's bytes (only that it exists), nor write any of these tables;
--   * stores an original only through pdf_original_put: an officer, or the writer of the version
--     the file belongs to, and only bytes whose size and sha256 are the stored_file's;
--   * reads an original only through pdf_original_read, for an audience whose every policy cell
--     shows and which the file is for. The audience is what the API passes from the verified
--     token: the database cannot verify a token, but it does hold the policy rule;
--   * regenerates only through a claim: pdf_regen_claim leases one queued file; with the lease,
--     pdf_regen_original reads its original, pdf_copy_put adds a copy (once per input hash; a
--     second put of the same hash changes nothing) and pdf_regen_finish drops the copies no
--     audience uses any more. If the file was queued again during the run, finish leaves it
--     queued and stale, so a change made mid-run is never lost.
-- For every role, the owner included: an original is never rewritten, and a copy changes only in
-- its stale flag.
--
-- The worker and the server are the same database role, so a claim limits when, not who, may
-- read an original for regeneration; the claim is only taken for a file that is queued.

CREATE TABLE pdf_original (
  file_id       uuid        PRIMARY KEY REFERENCES stored_file (id) ON DELETE CASCADE,
  bytes         bytea       NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 10485760),
  stored_by_sub text        NOT NULL CHECK (stored_by_sub <> ''),
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- Already compressed: do not spend time trying again.
ALTER TABLE pdf_original ALTER COLUMN bytes SET STORAGE EXTERNAL;

REVOKE ALL ON pdf_original FROM nwfl;
GRANT SELECT (file_id, stored_by_sub, created_at) ON pdf_original TO nwfl;

CREATE TABLE pdf_copy (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id    uuid        NOT NULL REFERENCES stored_file (id) ON DELETE CASCADE,
  input_hash bytea       NOT NULL CHECK (octet_length(input_hash) = 32),
  engine     text        NOT NULL CHECK (engine <> ''),
  status     text        NOT NULL CHECK (status IN ('ready', 'refused')),
  -- A copy may be a little larger than its original (the boxes); twice the cap bounds it.
  bytes      bytea       CHECK (octet_length(bytes) BETWEEN 1 AND 20971520),
  -- Why the engine or the gate refused: for officers.
  reason     text        CHECK (reason <> ''),
  stale      boolean     NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pdf_copy_one_per_input UNIQUE (file_id, input_hash),
  CONSTRAINT pdf_copy_ready_has_bytes CHECK ((status = 'ready') = (bytes IS NOT NULL)),
  CONSTRAINT pdf_copy_refused_has_reason CHECK ((status = 'refused') = (reason IS NOT NULL))
);
ALTER TABLE pdf_copy ALTER COLUMN bytes SET STORAGE EXTERNAL;

REVOKE INSERT, UPDATE, DELETE ON pdf_copy FROM nwfl;

CREATE SEQUENCE pdf_regen_generation;
REVOKE ALL ON SEQUENCE pdf_regen_generation FROM nwfl;

-- One row per file waiting to be regenerated. generation is taken from the sequence each time the
-- file is queued; a run records the generation it claimed, so it can tell whether it is current.
CREATE TABLE pdf_regen (
  file_id            uuid        PRIMARY KEY REFERENCES stored_file (id) ON DELETE CASCADE,
  generation         bigint      NOT NULL,
  claim              uuid,
  claimed_generation bigint,
  claimed_until      timestamptz,
  CONSTRAINT pdf_regen_claim_whole CHECK (num_nulls(claim, claimed_generation, claimed_until) IN (0, 3))
);

REVOKE INSERT, UPDATE, DELETE ON pdf_regen FROM nwfl;

CREATE FUNCTION pdf_original_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'an original is kept as stored' USING ERRCODE = '55000';
END
$fn$;

CREATE TRIGGER pdf_original_guard BEFORE UPDATE ON pdf_original FOR EACH ROW EXECUTE FUNCTION pdf_original_guard();

CREATE FUNCTION pdf_copy_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.id, NEW.file_id, NEW.input_hash, NEW.engine, NEW.status, NEW.bytes, NEW.reason, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.file_id, OLD.input_hash, OLD.engine, OLD.status, OLD.bytes, OLD.reason, OLD.created_at) THEN
    RAISE EXCEPTION 'a copy is kept as made' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER pdf_copy_guard BEFORE UPDATE ON pdf_copy FOR EACH ROW EXECUTE FUNCTION pdf_copy_guard();

-- The content items a file's marks come from: its version's item, or the items its edition prints.
CREATE FUNCTION pdf_file_items(p_file uuid) RETURNS SETOF uuid
  LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $fn$
  SELECT v.item_id FROM stored_file f JOIN content_version v ON v.id = f.version_id WHERE f.id = p_file
  UNION
  SELECT ei.item_id FROM stored_file f JOIN edition_item ei ON ei.edition_id = f.edition_id WHERE f.id = p_file
$fn$;

-- Queues these files (those with an original) and marks their copies stale.
CREATE FUNCTION pdf_regen_request(p_files uuid[]) RETURNS void
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  INSERT INTO pdf_regen (file_id, generation)
    SELECT o.file_id, nextval('pdf_regen_generation') FROM pdf_original o WHERE o.file_id = ANY (p_files)
    ON CONFLICT (file_id) DO UPDATE SET generation = EXCLUDED.generation;
  UPDATE pdf_copy SET stale = true WHERE file_id = ANY (p_files) AND NOT stale;
END
$fn$;

CREATE FUNCTION pdf_stale_on_policy() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  PERFORM pdf_regen_request(ARRAY(SELECT file_id FROM pdf_original));
  RETURN NULL;
END
$fn$;

CREATE TRIGGER pdf_stale_on_policy AFTER INSERT OR UPDATE OR DELETE ON redaction_policy
  FOR EACH STATEMENT EXECUTE FUNCTION pdf_stale_on_policy();

-- The files a content item's marks reach: the item's own versions' files and its editions' files.
CREATE FUNCTION pdf_files_of_item(p_item uuid) RETURNS uuid[]
  LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $fn$
  SELECT ARRAY(
    SELECT f.id FROM stored_file f JOIN content_version v ON v.id = f.version_id WHERE v.item_id = p_item
    UNION
    SELECT f.id FROM stored_file f JOIN edition_item ei ON ei.edition_id = f.edition_id WHERE ei.item_id = p_item)
$fn$;

CREATE FUNCTION pdf_stale_on_mark() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  PERFORM pdf_regen_request(pdf_files_of_item(NEW.content_item_id));
  RETURN NULL;
END
$fn$;

CREATE TRIGGER pdf_stale_on_mark AFTER INSERT OR UPDATE ON redaction_mark
  FOR EACH ROW WHEN (NEW.content_item_id IS NOT NULL) EXECUTE FUNCTION pdf_stale_on_mark();

CREATE FUNCTION pdf_stale_on_edition_item() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  PERFORM pdf_regen_request(ARRAY(
    SELECT id FROM stored_file
    WHERE edition_id IN (CASE WHEN TG_OP <> 'INSERT' THEN OLD.edition_id END, CASE WHEN TG_OP <> 'DELETE' THEN NEW.edition_id END)));
  RETURN NULL;
END
$fn$;

CREATE TRIGGER pdf_stale_on_edition_item AFTER INSERT OR UPDATE OR DELETE ON edition_item
  FOR EACH ROW EXECUTE FUNCTION pdf_stale_on_edition_item();

CREATE FUNCTION pdf_original_put(p_file uuid, p_bytes bytea, p_sub text, p_groups text[], p_trace text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_file stored_file;
BEGIN
  IF coalesce(p_sub, '') = '' THEN
    RAISE EXCEPTION 'storing a PDF needs who stores it' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_file FROM stored_file WHERE id = p_file;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such file' USING ERRCODE = '22023';
  END IF;
  IF NOT coalesce('nwfl-officers' = ANY (p_groups), false)
     AND NOT EXISTS (SELECT 1 FROM content_version WHERE id = v_file.version_id AND created_by_sub = p_sub) THEN
    RAISE EXCEPTION 'an officer or the version''s writer stores its PDF' USING ERRCODE = '42501';
  END IF;
  IF v_file.mime_type <> 'application/pdf' THEN
    RAISE EXCEPTION 'the file is not a PDF' USING ERRCODE = '22023';
  END IF;
  IF octet_length(p_bytes) > 10485760 THEN
    RAISE EXCEPTION 'a PDF is at most 10 MiB' USING ERRCODE = '22023';
  END IF;
  IF octet_length(p_bytes) <> v_file.size_bytes OR sha256(p_bytes) <> v_file.sha256 THEN
    RAISE EXCEPTION 'the bytes do not match the file''s size and sha256' USING ERRCODE = '22023';
  END IF;
  INSERT INTO pdf_original (file_id, bytes, stored_by_sub) VALUES (p_file, p_bytes, p_sub);
  PERFORM redaction_audit(p_sub, p_groups, p_trace, 'pdf_original_store', 'stored_file', p_file::text, NULL, 'stored',
    jsonb_build_object('size_bytes', v_file.size_bytes));
  PERFORM pdf_regen_request(ARRAY[p_file]);
END
$fn$;

CREATE FUNCTION pdf_audience_rank(p_audience text) RETURNS integer
  LANGUAGE sql IMMUTABLE STRICT AS $fn$
  SELECT CASE p_audience WHEN 'public' THEN 0 WHEN 'members' THEN 1 WHEN 'officers' THEN 2 END
$fn$;

CREATE FUNCTION pdf_original_read(p_file uuid, p_audience text) RETURNS bytea
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_bytes bytea;
BEGIN
  -- Every category's cell, present and "show" (a missing cell reads as hide).
  IF pdf_audience_rank(p_audience) IS NULL
     OR (SELECT count(*) FROM redaction_policy WHERE tenant_id = 'nwflorida' AND audience = p_audience AND action = 'show') <> 8 THEN
    RAISE EXCEPTION 'this audience''s policy does not show everything in an original' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM stored_file WHERE id = p_file AND pdf_audience_rank(audience) > pdf_audience_rank(p_audience)) THEN
    RAISE EXCEPTION 'the file is not for this audience' USING ERRCODE = '42501';
  END IF;
  SELECT bytes INTO v_bytes FROM pdf_original WHERE file_id = p_file;
  RETURN v_bytes;
END
$fn$;

CREATE FUNCTION pdf_regen_claim(p_lease_seconds integer) RETURNS TABLE (file_id uuid, claim uuid)
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
                           claimed_until = clock_timestamp() + make_interval(secs => p_lease_seconds)
      FROM next WHERE r.file_id = next.file_id
      RETURNING r.file_id, r.claim;
END
$fn$;

-- Raises unless this claim on this file is live.
CREATE FUNCTION pdf_regen_require(p_file uuid, p_claim uuid) RETURNS void
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pdf_regen WHERE file_id = p_file AND claim = p_claim AND claimed_until > clock_timestamp()) THEN
    RAISE EXCEPTION 'this regeneration does not hold the file' USING ERRCODE = '42501';
  END IF;
END
$fn$;

CREATE FUNCTION pdf_regen_original(p_file uuid, p_claim uuid) RETURNS bytea
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  PERFORM pdf_regen_require(p_file, p_claim);
  RETURN (SELECT bytes FROM pdf_original WHERE file_id = p_file);
END
$fn$;

CREATE FUNCTION pdf_copy_put(p_file uuid, p_claim uuid, p_hash bytea, p_engine text, p_bytes bytea, p_reason text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  PERFORM pdf_regen_require(p_file, p_claim);
  INSERT INTO pdf_copy (file_id, input_hash, engine, status, bytes, reason)
    VALUES (p_file, p_hash, p_engine, CASE WHEN p_bytes IS NULL THEN 'refused' ELSE 'ready' END, p_bytes,
            CASE WHEN p_bytes IS NULL THEN p_reason END)
    ON CONFLICT (file_id, input_hash) DO NOTHING;
END
$fn$;

-- True when the run was current: the copies no audience uses are dropped, the rest are fresh and
-- the file leaves the queue. False when the claim was lost, or the file was queued again.
CREATE FUNCTION pdf_regen_finish(p_file uuid, p_claim uuid, p_current bytea[]) RETURNS boolean
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
  DELETE FROM pdf_copy WHERE file_id = p_file AND NOT (input_hash = ANY (coalesce(p_current, '{}')));
  UPDATE pdf_copy SET stale = false WHERE file_id = p_file AND stale;
  DELETE FROM pdf_regen WHERE file_id = p_file;
  RETURN true;
END
$fn$;

REVOKE EXECUTE ON FUNCTION pdf_original_guard(), pdf_copy_guard(), pdf_file_items(uuid), pdf_regen_request(uuid[]),
  pdf_stale_on_policy(), pdf_files_of_item(uuid), pdf_stale_on_mark(), pdf_stale_on_edition_item(),
  pdf_original_put(uuid, bytea, text, text[], text), pdf_audience_rank(text), pdf_original_read(uuid, text),
  pdf_regen_claim(integer), pdf_regen_require(uuid, uuid), pdf_regen_original(uuid, uuid),
  pdf_copy_put(uuid, uuid, bytea, text, bytea, text), pdf_regen_finish(uuid, uuid, bytea[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pdf_file_items(uuid), pdf_original_put(uuid, bytea, text, text[], text), pdf_original_read(uuid, text),
  pdf_regen_claim(integer), pdf_regen_original(uuid, uuid), pdf_copy_put(uuid, uuid, bytea, text, bytea, text),
  pdf_regen_finish(uuid, uuid, bytea[]) TO nwfl;
