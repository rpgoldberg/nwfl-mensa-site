-- 0016_publication_ledger.sql: proof of what each audience was given (REDACT R-LEDGER).
--
-- publication_ledger has one row each time what an audience is given for a subject changes: a
-- content version's rendering or a PDF file's served bytes. A row holds the sha256 of the exact
-- serialized output (NULL: the audience is given nothing), a manifest of the inputs (version, the
-- original's sha256, the active mark ids, the policy cells, the image action, the engine), the
-- passages withheld, and the window it was current: current_from, and current_to once a later row
-- for the same subject and audience replaces it (the successor's current_from).
--
-- The rows form one hash chain. row_hash is sha256 over a canonical text of the row (every column
-- but current_to, which the successor's current_from proves) and the previous row's hash. The
-- verifier (src/ledger/ledger.ts) rebuilds the text itself, outside the database.
--
--   * The app role only reads the ledger. One SECURITY DEFINER function appends:
--     publication_ledger_record. It locks the single head row FOR UPDATE, so appends are
--     serialized and the chain stays linear under concurrent writers.
--   * One lock for renders and changes. A writer takes the head lock (publication_ledger_lock)
--     BEFORE it renders, and every change that can alter a rendering takes the same lock before it
--     writes: triggers on redaction_mark, redaction_change, redaction_policy, content_item and
--     edition_item. So no such change can commit between a render and its append: a racing change
--     waits, and its own transaction records its own row.
--   * One time per transaction. The first lock in a transaction stamps it (in the head row: the
--     app cannot forge it), never earlier than the last stamp. Its ledger rows open at that stamp,
--     and the same triggers set its marks' created_at and removed_at and its policy changes'
--     decided_at and approved_at to it. So "as of T" reads the history exactly as the ledger does.
--   * A copy no longer kept is made again from the original (it is deterministic, R-LEDGER item
--     4): publication_ledger_original gives an officer the original of a ledger row whose copy is
--     gone, and audits the read. Like the worker path in 0015, the officer's groups are what the
--     API passes: a trust, not a wall.
--   * A trigger keeps every row as written, for every role, the owner included: the only update
--     sets current_to, once; nothing is deleted or truncated.
--   * No reader is logged: the windows are the proof (privacy).
--
-- Also (fc review of 0012-0015): the seven functions there without a pinned search_path get one.

ALTER FUNCTION redaction_action_allowed(text, text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION pdf_original_guard() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION pdf_copy_guard() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION pdf_audience_rank(text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION redaction_rank(text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION redaction_change_guard() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION redaction_mark_removal_guard() SET search_path = pg_catalog, public, pg_temp;

CREATE TABLE publication_ledger (
  seq               bigint      PRIMARY KEY CHECK (seq > 0),
  tenant_id         text        NOT NULL DEFAULT 'nwflorida' REFERENCES tenant (id),
  subject_kind      text        NOT NULL CHECK (subject_kind IN ('content_version', 'stored_file')),
  subject_id        uuid        NOT NULL,
  audience          text        NOT NULL CHECK (audience IN ('public', 'members', 'officers')),
  -- NULL: this audience is given nothing for the subject (hidden, not live, not ready, refused).
  output_sha256     bytea       CHECK (octet_length(output_sha256) = 32),
  inputs            jsonb       NOT NULL CHECK (jsonb_typeof(inputs) = 'object'),
  passages_withheld integer     NOT NULL CHECK (passages_withheld >= 0),
  current_from      timestamptz NOT NULL,
  current_to        timestamptz,
  prev_hash         bytea       NOT NULL CHECK (octet_length(prev_hash) = 32),
  row_hash          bytea       NOT NULL UNIQUE CHECK (octet_length(row_hash) = 32),
  CONSTRAINT publication_ledger_window CHECK (current_to IS NULL OR current_to >= current_from)
);

-- One current row per subject and audience.
CREATE UNIQUE INDEX publication_ledger_current ON publication_ledger (tenant_id, subject_kind, subject_id, audience)
  WHERE current_to IS NULL;
CREATE INDEX publication_ledger_history ON publication_ledger (subject_kind, subject_id, audience, current_from);

-- The chain's head: the last seq and its hash, one row, the lock appends and changes take; and the
-- stamp of the transaction that last took it.
CREATE TABLE publication_ledger_head (
  id         boolean     PRIMARY KEY DEFAULT true CHECK (id),
  seq        bigint      NOT NULL CHECK (seq >= 0),
  row_hash   bytea       NOT NULL CHECK (octet_length(row_hash) = 32),
  stamp_txid bigint,
  stamp      timestamptz NOT NULL DEFAULT '-infinity'
);
INSERT INTO publication_ledger_head (id, seq, row_hash) VALUES (true, 0, decode(repeat('00', 32), 'hex'));

REVOKE ALL ON publication_ledger, publication_ledger_head FROM nwfl;
GRANT SELECT ON publication_ledger, publication_ledger_head TO nwfl;

-- The canonical text a row's hash covers, one field per line. jsonb prints its keys in one order
-- and escapes newlines, so no field can forge a line break.
CREATE FUNCTION publication_ledger_canonical(p_seq bigint, p_tenant text, p_kind text, p_subject uuid, p_audience text,
                                             p_output bytea, p_inputs jsonb, p_withheld integer, p_from timestamptz,
                                             p_prev bytea) RETURNS text
  LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $fn$
  SELECT concat_ws(E'\n', 'nwfl-ledger-v1', p_seq::text, p_tenant, p_kind, p_subject::text, p_audience,
                   coalesce(encode(p_output, 'hex'), '-'), p_inputs::text, p_withheld::text,
                   to_char(p_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), encode(p_prev, 'hex'))
$fn$;

CREATE FUNCTION publication_ledger_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'publication_ledger is append-only' USING ERRCODE = '55000';
  END IF;
  IF OLD.current_to IS NOT NULL OR NEW.current_to IS NULL THEN
    RAISE EXCEPTION 'a ledger row''s window closes once' USING ERRCODE = '55000';
  END IF;
  IF (NEW.seq, NEW.tenant_id, NEW.subject_kind, NEW.subject_id, NEW.audience, NEW.output_sha256, NEW.inputs,
      NEW.passages_withheld, NEW.current_from, NEW.prev_hash, NEW.row_hash)
     IS DISTINCT FROM
     (OLD.seq, OLD.tenant_id, OLD.subject_kind, OLD.subject_id, OLD.audience, OLD.output_sha256, OLD.inputs,
      OLD.passages_withheld, OLD.current_from, OLD.prev_hash, OLD.row_hash) THEN
    RAISE EXCEPTION 'a ledger row is kept as written' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER publication_ledger_guard BEFORE UPDATE OR DELETE ON publication_ledger
  FOR EACH ROW EXECUTE FUNCTION publication_ledger_guard();
CREATE TRIGGER publication_ledger_no_truncate BEFORE TRUNCATE ON publication_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION publication_ledger_guard();

-- Takes the lock for the rest of the transaction and returns the transaction's stamp: set the first
-- time, never before the previous transaction's.
CREATE FUNCTION publication_ledger_stamp() RETURNS timestamptz
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_head publication_ledger_head;
BEGIN
  SELECT * INTO v_head FROM publication_ledger_head WHERE id FOR UPDATE;
  IF v_head.stamp_txid IS DISTINCT FROM txid_current() THEN
    UPDATE publication_ledger_head SET stamp_txid = txid_current(), stamp = greatest(clock_timestamp(), v_head.stamp)
      WHERE id RETURNING * INTO v_head;
  END IF;
  RETURN v_head.stamp;
END
$fn$;

CREATE FUNCTION publication_ledger_lock() RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  PERFORM publication_ledger_stamp();
END
$fn$;

-- A change that can alter what an audience is given takes the lock before it writes.
CREATE FUNCTION publication_ledger_lock_trigger() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  PERFORM publication_ledger_stamp();
  RETURN NULL;
END
$fn$;

CREATE TRIGGER redaction_policy_ledger_lock BEFORE INSERT OR UPDATE OR DELETE ON redaction_policy
  FOR EACH STATEMENT EXECUTE FUNCTION publication_ledger_lock_trigger();
CREATE TRIGGER content_item_ledger_lock BEFORE UPDATE OF state, live_version_id, slug, withdrawn_at ON content_item
  FOR EACH STATEMENT EXECUTE FUNCTION publication_ledger_lock_trigger();
CREATE TRIGGER edition_item_ledger_lock BEFORE INSERT OR UPDATE OR DELETE ON edition_item
  FOR EACH STATEMENT EXECUTE FUNCTION publication_ledger_lock_trigger();

-- A mark is made, and removed, at its transaction's stamp.
CREATE FUNCTION publication_ledger_stamp_mark() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := publication_ledger_stamp();
  ELSIF NEW.status = 'removed' AND OLD.status IS DISTINCT FROM 'removed' THEN
    NEW.removed_at := publication_ledger_stamp();
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER redaction_mark_ledger_stamp BEFORE INSERT OR UPDATE ON redaction_mark
  FOR EACH ROW EXECUTE FUNCTION publication_ledger_stamp_mark();

-- A policy change is decided, and approved, at its transaction's stamp.
CREATE FUNCTION publication_ledger_stamp_change() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF NEW.decided_at IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.decided_at IS NULL) THEN
    NEW.decided_at := publication_ledger_stamp();
  END IF;
  IF NEW.approved_at IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.approved_at IS NULL) THEN
    NEW.approved_at := publication_ledger_stamp();
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER redaction_change_ledger_stamp BEFORE INSERT OR UPDATE ON redaction_change
  FOR EACH ROW EXECUTE FUNCTION publication_ledger_stamp_change();

-- Appends a row when what the audience is given (output or passages withheld) changed, closing the
-- current one; returns its seq, or NULL when nothing changed. A subject never given anything that
-- is still given nothing gets no row.
CREATE FUNCTION publication_ledger_record(p_kind text, p_subject uuid, p_audience text, p_output bytea, p_inputs jsonb,
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

-- The original of a ledger row whose copy is no longer kept, for an officer to make the copy again.
CREATE FUNCTION publication_ledger_original(p_seq bigint, p_sub text, p_groups text[], p_trace text) RETURNS bytea
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_row   publication_ledger;
  v_bytes bytea;
BEGIN
  IF coalesce(p_sub, '') = '' OR NOT coalesce('nwfl-officers' = ANY (p_groups), false) THEN
    RAISE EXCEPTION 'an officer checks the ledger' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_row FROM publication_ledger WHERE seq = p_seq;
  IF NOT FOUND OR v_row.subject_kind <> 'stored_file' OR v_row.inputs ->> 'served' IS DISTINCT FROM 'copy' THEN
    RAISE EXCEPTION 'only a ledger row of a served copy is made again' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM pdf_copy WHERE file_id = v_row.subject_id AND input_hash = decode(v_row.inputs ->> 'input_hash', 'hex')) THEN
    RAISE EXCEPTION 'the copy is still kept: hash it' USING ERRCODE = '55000';
  END IF;
  SELECT bytes INTO v_bytes FROM pdf_original WHERE file_id = v_row.subject_id;
  PERFORM redaction_audit(p_sub, p_groups, p_trace, 'ledger_original_read', 'stored_file', v_row.subject_id::text, NULL, NULL,
    jsonb_build_object('seq', p_seq));
  RETURN v_bytes;
END
$fn$;

REVOKE EXECUTE ON FUNCTION publication_ledger_canonical(bigint, text, text, uuid, text, bytea, jsonb, integer, timestamptz, bytea),
  publication_ledger_guard(), publication_ledger_stamp(), publication_ledger_lock(), publication_ledger_lock_trigger(),
  publication_ledger_stamp_mark(), publication_ledger_stamp_change(),
  publication_ledger_record(text, uuid, text, bytea, jsonb, integer),
  publication_ledger_original(bigint, text, text[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION publication_ledger_lock(), publication_ledger_record(text, uuid, text, bytea, jsonb, integer),
  publication_ledger_original(bigint, text, text[], text) TO nwfl;
