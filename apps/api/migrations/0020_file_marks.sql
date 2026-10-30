-- 0020_file_marks.sql: a content item's passage marked in its stored PDFs (MLOGIN S3).
--
-- 0014 anchors a passage mark in one field of its subject, and the lens (redaction/render.ts)
-- drops an item from every audience that redacts a mark whose quote is not in the version's own
-- text. A document such as a newsletter issue carries its words in its PDFs, not in its text, so
-- its marks could only hide it. A FILE mark is a content item's passage in its stored PDFs:
--
--   * field 'file' is allowed on a content item's mark, and only there;
--   * redaction_mark_anchor records, with each file mark, the item's stored PDFs its quote was
--     found in when it was added. The API reads the text layer of each of the item's originals,
--     as the redaction engine reads a page, and passes the files it found the quote in (a quote
--     found in none is refused there, fail closed). The database cannot read a PDF's text, so it
--     holds what it can: at least one file, each a PDF of a version of that item with its
--     original stored, written with the mark and never changed;
--   * redaction_mark_add refuses field 'file'. redaction_mark_add_file is the one writer of a
--     file mark, with 0014's rule for who may add one (an officer, or a writer of the item) and
--     its audit row (field 'file' and the number of files, never the quote);
--   * the lens never hides an item for a file mark anchored in a file of the version shown, and
--     hides it (fail closed) for one that is not. A file mark's quote is withheld from the item's
--     own text, as any redact mark's is. The PDF output gate is unchanged: every active mark's
--     quote, file marks' included, is withheld from the PDFs given to an audience that redacts its
--     category, and every copy is re-read.
--
-- The app role only reads redaction_mark_anchor. A trigger refuses UPDATE, DELETE and TRUNCATE,
-- and an anchor that is not a stored PDF of its file mark's own item, for every role's writes,
-- the owner's too; the owner can disable or drop the trigger (0019).

ALTER TABLE redaction_mark DROP CONSTRAINT redaction_mark_field_of_subject;
ALTER TABLE redaction_mark ADD CONSTRAINT redaction_mark_field_of_subject CHECK (
  field IS NULL
  OR (content_item_id IS NOT NULL AND field IN ('title', 'summary', 'body', 'on_behalf_of', 'file'))
  OR (series_id IS NOT NULL AND field IN ('title', 'description', 'cadence_label'))
  OR (occurrence_id IS NOT NULL AND field IN ('title', 'detail', 'status_note', 'url')));

CREATE TABLE redaction_mark_anchor (
  tenant_id  text        NOT NULL DEFAULT 'nwflorida' REFERENCES tenant (id),
  mark_id    uuid        NOT NULL REFERENCES redaction_mark (id),
  file_id    uuid        NOT NULL REFERENCES stored_file (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mark_id, file_id)
);
CREATE INDEX redaction_mark_anchor_file ON redaction_mark_anchor (file_id);
REVOKE INSERT, UPDATE, DELETE ON redaction_mark_anchor FROM nwfl;

CREATE FUNCTION redaction_mark_anchor_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'redaction_mark_anchor is append-only: % refused', TG_OP USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM redaction_mark m
                   JOIN content_version v ON v.item_id = m.content_item_id
                   JOIN stored_file f ON f.version_id = v.id
                   JOIN pdf_original o ON o.file_id = f.id
                  WHERE m.id = NEW.mark_id AND m.tenant_id = NEW.tenant_id AND m.field = 'file'
                    AND f.id = NEW.file_id AND f.mime_type = 'application/pdf') THEN
    RAISE EXCEPTION 'a file mark is anchored in a stored PDF of its own item' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER redaction_mark_anchor_guard BEFORE INSERT OR UPDATE OR DELETE ON redaction_mark_anchor
  FOR EACH ROW EXECUTE FUNCTION redaction_mark_anchor_guard();
CREATE TRIGGER redaction_mark_anchor_no_truncate BEFORE TRUNCATE ON redaction_mark_anchor
  FOR EACH STATEMENT EXECUTE FUNCTION redaction_mark_anchor_guard();
COMMENT ON TRIGGER redaction_mark_anchor_guard ON redaction_mark_anchor IS
  'Keeps every anchor as written, each a stored PDF of its file mark''s own item, for every role''s writes, the owner''s too; the owner can disable or drop the trigger (0019).';
COMMENT ON TRIGGER redaction_mark_anchor_no_truncate ON redaction_mark_anchor IS
  'Refuses every role''s TRUNCATE, the owner''s too; the owner can disable or drop the trigger (0019).';

-- 0014's function, refusing a file mark. CREATE OR REPLACE keeps its owner and grants.
CREATE OR REPLACE FUNCTION redaction_mark_add(p_kind text, p_subject uuid, p_field text, p_quote text, p_category text,
                                              p_sub text, p_groups text[], p_trace text) RETURNS redaction_mark
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_mark redaction_mark;
BEGIN
  IF coalesce(p_sub, '') = '' THEN
    RAISE EXCEPTION 'a redaction mark needs who made it' USING ERRCODE = '42501';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('content_item', 'event_series', 'event_occurrence') THEN
    RAISE EXCEPTION 'a mark is on a content item, a series or an occurrence' USING ERRCODE = '22023';
  END IF;
  IF p_field = 'file' THEN
    RAISE EXCEPTION 'a file mark is added by redaction_mark_add_file, with the files its quote is found in' USING ERRCODE = '22023';
  END IF;
  -- An officer marks anything; anyone else only an item they wrote a version of.
  IF NOT coalesce('nwfl-officers' = ANY (p_groups), false)
     AND NOT (p_kind = 'content_item'
              AND EXISTS (SELECT 1 FROM content_version WHERE item_id = p_subject AND created_by_sub = p_sub)) THEN
    RAISE EXCEPTION 'an officer or the item''s writer marks it' USING ERRCODE = '42501';
  END IF;
  INSERT INTO redaction_mark (content_item_id, series_id, occurrence_id, field, quote, category, created_by_sub)
    VALUES (CASE WHEN p_kind = 'content_item' THEN p_subject END,
            CASE WHEN p_kind = 'event_series' THEN p_subject END,
            CASE WHEN p_kind = 'event_occurrence' THEN p_subject END,
            p_field, p_quote, p_category, p_sub)
    RETURNING * INTO v_mark;
  PERFORM redaction_audit(p_sub, p_groups, p_trace, 'redaction_mark_add', 'redaction_mark', v_mark.id::text, NULL, 'active',
    jsonb_build_object('subject_kind', p_kind, 'subject_id', p_subject, 'field', p_field, 'category', p_category));
  RETURN v_mark;
END
$fn$;

-- A file mark on a content item, with the item's stored PDFs its quote was found in.
CREATE FUNCTION redaction_mark_add_file(p_subject uuid, p_quote text, p_category text, p_files uuid[],
                                        p_sub text, p_groups text[], p_trace text) RETURNS redaction_mark
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_mark  redaction_mark;
  v_files uuid[];
BEGIN
  IF coalesce(p_sub, '') = '' THEN
    RAISE EXCEPTION 'a redaction mark needs who made it' USING ERRCODE = '42501';
  END IF;
  IF NOT coalesce('nwfl-officers' = ANY (p_groups), false)
     AND NOT EXISTS (SELECT 1 FROM content_version WHERE item_id = p_subject AND created_by_sub = p_sub) THEN
    RAISE EXCEPTION 'an officer or the item''s writer marks it' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM content_version v
                   JOIN stored_file f ON f.version_id = v.id
                   JOIN pdf_original o ON o.file_id = f.id
                  WHERE v.item_id = p_subject AND f.mime_type = 'application/pdf') THEN
    RAISE EXCEPTION 'a file mark is on an item with a stored PDF' USING ERRCODE = '22023';
  END IF;
  IF coalesce(cardinality(p_files), 0) = 0 OR array_position(p_files, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'a file mark comes with the files its quote is found in' USING ERRCODE = '22023';
  END IF;
  SELECT array_agg(DISTINCT f ORDER BY f) INTO v_files FROM unnest(p_files) AS f;
  INSERT INTO redaction_mark (content_item_id, field, quote, category, created_by_sub)
    VALUES (p_subject, 'file', p_quote, p_category, p_sub)
    RETURNING * INTO v_mark;
  -- The guard trigger refuses a file that is not a stored PDF of this item.
  INSERT INTO redaction_mark_anchor (tenant_id, mark_id, file_id)
    SELECT v_mark.tenant_id, v_mark.id, f FROM unnest(v_files) AS f;
  PERFORM redaction_audit(p_sub, p_groups, p_trace, 'redaction_mark_add', 'redaction_mark', v_mark.id::text, NULL, 'active',
    jsonb_build_object('subject_kind', 'content_item', 'subject_id', p_subject, 'field', 'file', 'category', p_category,
                       'files', cardinality(v_files)));
  RETURN v_mark;
END
$fn$;
GRANT EXECUTE ON FUNCTION redaction_mark_add_file(uuid, text, text, uuid[], text, text[], text) TO nwfl;
