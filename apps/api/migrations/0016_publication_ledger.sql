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
--     serialized and the chain stays linear under concurrent writers; publication_ledger_lock
--     takes the same lock first, so a writer renders only after every earlier append committed.
--   * A trigger keeps every row as written, for every role, the owner included: the only update
--     sets current_to, once; nothing is deleted or truncated.
--   * No reader is logged: the windows are the proof (privacy).
--
-- Also (fc review of 0012-0014): the four functions there without a pinned search_path get one.

ALTER FUNCTION redaction_action_allowed(text, text) SET search_path = pg_catalog, public, pg_temp;
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

-- The chain's head: the last seq and its hash, one row, the lock appends take.
CREATE TABLE publication_ledger_head (
  id       boolean PRIMARY KEY DEFAULT true CHECK (id),
  seq      bigint  NOT NULL CHECK (seq >= 0),
  row_hash bytea   NOT NULL CHECK (octet_length(row_hash) = 32)
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

-- Takes the append lock for the rest of the transaction.
CREATE FUNCTION publication_ledger_lock() RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  PERFORM 1 FROM publication_ledger_head WHERE id FOR UPDATE;
END
$fn$;

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
BEGIN
  IF p_subject IS NULL OR p_inputs IS NULL OR p_withheld IS NULL THEN
    RAISE EXCEPTION 'a ledger row needs its subject, inputs and count' USING ERRCODE = '22023';
  END IF;
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
  -- After the lock, so windows follow the chain; never before the row it closes.
  v_from := greatest(clock_timestamp(), v_cur.current_from);
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

REVOKE EXECUTE ON FUNCTION publication_ledger_canonical(bigint, text, text, uuid, text, bytea, jsonb, integer, timestamptz, bytea),
  publication_ledger_guard(), publication_ledger_lock(),
  publication_ledger_record(text, uuid, text, bytea, jsonb, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION publication_ledger_lock(), publication_ledger_record(text, uuid, text, bytea, jsonb, integer) TO nwfl;
