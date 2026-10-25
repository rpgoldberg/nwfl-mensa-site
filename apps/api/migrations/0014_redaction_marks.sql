-- 0014_redaction_marks.sql: passages and whole items marked as personal data (REDACT R2a).
--
-- A mark is on one content item, event series or stored event occurrence. It is either a
-- passage, anchored by its exact text in one field, or the whole item (no field, no text). The
-- API withholds the text wherever it appears in the item, without regard to case or spacing,
-- from every audience whose policy (0012) redacts the mark's category, and drops the item from
-- an audience whose policy hides it (and, for a whole-item mark, from any audience that does not
-- show it). The text is the anchor because events are edited in place and items gain versions:
-- an offset would drift onto the wrong words and leave the marked ones showing.
--
-- Adding a mark tightens and applies at once: any officer, or a person who wrote a version of the
-- item. Removing one loosens, so it is proposed by one officer and approved by a different one,
-- the same path as 0013:
--
--   * The app role only reads redaction_mark and redaction_mark_removal.
--   * Three SECURITY DEFINER functions are the only writers: redaction_mark_add,
--     redaction_mark_propose_removal and redaction_mark_approve_removal. They write the audit
--     rows too, without the marked text.
--   * Triggers keep the history for every role, the owner included: a mark is born active and
--     changes once, to removed, only with an applied removal approved by a second subject; a
--     removal is born pending and changes once, to applied; nothing is deleted.
--
-- The caller's subject and groups are what the API passes from the verified token, as in 0013:
-- the database cannot verify a token, but it does hold that a removal is proposed and approved
-- by two distinct subjects, each passed as an officer (nwfl-officers).

CREATE TABLE redaction_mark (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text        NOT NULL DEFAULT 'nwflorida' REFERENCES tenant (id),
  content_item_id uuid        REFERENCES content_item (id),
  series_id       uuid        REFERENCES event_series (id),
  occurrence_id   uuid        REFERENCES event_occurrence (id),
  -- NULL, with quote, for a whole-item mark.
  field           text,
  quote           text,
  category        text        NOT NULL
                  CHECK (category IN ('member_name', 'member_address', 'member_phone', 'member_email',
                                      'private_venue', 'business_venue', 'officer_contact')),
  status          text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  created_by_sub  text        NOT NULL CHECK (created_by_sub <> ''),
  created_at      timestamptz NOT NULL DEFAULT now(),
  removed_at      timestamptz,
  CONSTRAINT redaction_mark_one_subject CHECK (num_nonnulls(content_item_id, series_id, occurrence_id) = 1),
  CONSTRAINT redaction_mark_passage_or_whole CHECK ((field IS NULL) = (quote IS NULL)),
  CONSTRAINT redaction_mark_field_of_subject CHECK (
    field IS NULL
    OR (content_item_id IS NOT NULL AND field IN ('title', 'summary', 'body', 'on_behalf_of'))
    OR (series_id IS NOT NULL AND field IN ('title', 'description', 'cadence_label'))
    OR (occurrence_id IS NOT NULL AND field IN ('title', 'detail', 'status_note', 'url'))),
  CONSTRAINT redaction_mark_quote_trimmed CHECK (quote IS NULL OR (quote = btrim(quote) AND char_length(quote) BETWEEN 3 AND 500)),
  CONSTRAINT redaction_mark_removed_dated CHECK ((status = 'removed') = (removed_at IS NOT NULL))
);

CREATE INDEX redaction_mark_item ON redaction_mark (content_item_id) WHERE content_item_id IS NOT NULL;
CREATE INDEX redaction_mark_series ON redaction_mark (series_id) WHERE series_id IS NOT NULL;
CREATE INDEX redaction_mark_occurrence ON redaction_mark (occurrence_id) WHERE occurrence_id IS NOT NULL;

CREATE TABLE redaction_mark_removal (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text        NOT NULL DEFAULT 'nwflorida' REFERENCES tenant (id),
  mark_id         uuid        NOT NULL REFERENCES redaction_mark (id),
  status          text        NOT NULL CHECK (status IN ('pending', 'applied')),
  proposed_by_sub text        NOT NULL CHECK (proposed_by_sub <> ''),
  proposed_at     timestamptz NOT NULL DEFAULT now(),
  approved_by_sub text,
  approved_at     timestamptz,
  CONSTRAINT redaction_mark_removal_approved_iff_applied CHECK ((status = 'applied') = (approved_by_sub IS NOT NULL)),
  CONSTRAINT redaction_mark_removal_approval_dated CHECK ((approved_by_sub IS NULL) = (approved_at IS NULL)),
  -- Four-eyes.
  CONSTRAINT redaction_mark_removal_not_self_approved CHECK (approved_by_sub IS NULL OR approved_by_sub <> proposed_by_sub)
);

-- One waiting removal per mark.
CREATE UNIQUE INDEX redaction_mark_removal_one_pending ON redaction_mark_removal (mark_id) WHERE status = 'pending';

REVOKE INSERT, UPDATE, DELETE ON redaction_mark, redaction_mark_removal FROM nwfl;

CREATE FUNCTION redaction_mark_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'redaction_mark is append-only' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' OR NEW.removed_at IS NOT NULL THEN
      RAISE EXCEPTION 'a redaction mark is added active' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'active' OR NEW.status <> 'removed' THEN
    RAISE EXCEPTION 'a redaction mark is removed once' USING ERRCODE = '55000';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.content_item_id, NEW.series_id, NEW.occurrence_id, NEW.field, NEW.quote, NEW.category,
      NEW.created_by_sub, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.content_item_id, OLD.series_id, OLD.occurrence_id, OLD.field, OLD.quote, OLD.category,
      OLD.created_by_sub, OLD.created_at) THEN
    RAISE EXCEPTION 'a redaction mark keeps what was marked' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM redaction_mark_removal WHERE mark_id = OLD.id AND status = 'applied'
                   AND approved_by_sub IS NOT NULL AND approved_by_sub <> proposed_by_sub) THEN
    RAISE EXCEPTION 'a redaction mark is removed only by an approved removal' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER redaction_mark_guard BEFORE INSERT OR UPDATE OR DELETE ON redaction_mark
  FOR EACH ROW EXECUTE FUNCTION redaction_mark_guard();

CREATE FUNCTION redaction_mark_removal_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'redaction_mark_removal is append-only' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.approved_by_sub IS NOT NULL THEN
      RAISE EXCEPTION 'a mark removal is proposed pending' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'pending' OR NEW.status <> 'applied' THEN
    RAISE EXCEPTION 'a mark removal is decided once' USING ERRCODE = '55000';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.mark_id, NEW.proposed_by_sub, NEW.proposed_at)
     IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.mark_id, OLD.proposed_by_sub, OLD.proposed_at) THEN
    RAISE EXCEPTION 'a mark removal keeps what was proposed' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER redaction_mark_removal_guard BEFORE INSERT OR UPDATE OR DELETE ON redaction_mark_removal
  FOR EACH ROW EXECUTE FUNCTION redaction_mark_removal_guard();

CREATE FUNCTION redaction_mark_require_officer(p_sub text, p_groups text[]) RETURNS void
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF coalesce(p_sub, '') = '' OR NOT coalesce('nwfl-officers' = ANY (p_groups), false) THEN
    RAISE EXCEPTION 'an officer removes a redaction mark' USING ERRCODE = '42501';
  END IF;
END
$fn$;

CREATE FUNCTION redaction_mark_add(p_kind text, p_subject uuid, p_field text, p_quote text, p_category text,
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

CREATE FUNCTION redaction_mark_propose_removal(p_mark uuid, p_sub text, p_groups text[], p_trace text) RETURNS redaction_mark_removal
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_mark    redaction_mark;
  v_removal redaction_mark_removal;
BEGIN
  PERFORM redaction_mark_require_officer(p_sub, p_groups);
  SELECT * INTO v_mark FROM redaction_mark WHERE id = p_mark FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such redaction mark' USING ERRCODE = '55000';
  END IF;
  IF v_mark.status <> 'active' THEN
    RAISE EXCEPTION 'this redaction mark is already removed' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM redaction_mark_removal WHERE mark_id = p_mark AND status = 'pending') THEN
    RAISE EXCEPTION 'a removal of this mark is already waiting' USING ERRCODE = '55000';
  END IF;
  INSERT INTO redaction_mark_removal (tenant_id, mark_id, status, proposed_by_sub)
    VALUES (v_mark.tenant_id, p_mark, 'pending', p_sub) RETURNING * INTO v_removal;
  PERFORM redaction_audit(p_sub, p_groups, p_trace, 'redaction_mark_propose_removal', 'redaction_mark_removal', v_removal.id::text,
    NULL, 'pending', jsonb_build_object('mark_id', p_mark));
  RETURN v_removal;
END
$fn$;

CREATE FUNCTION redaction_mark_approve_removal(p_removal uuid, p_sub text, p_groups text[], p_trace text) RETURNS redaction_mark_removal
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_removal redaction_mark_removal;
BEGIN
  PERFORM redaction_mark_require_officer(p_sub, p_groups);
  SELECT * INTO v_removal FROM redaction_mark_removal WHERE id = p_removal;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such mark removal' USING ERRCODE = '55000';
  END IF;
  -- The mark first, as a proposal takes it, then the removal.
  PERFORM 1 FROM redaction_mark WHERE id = v_removal.mark_id FOR UPDATE;
  SELECT * INTO v_removal FROM redaction_mark_removal WHERE id = p_removal FOR UPDATE;
  IF v_removal.status <> 'pending' THEN
    RAISE EXCEPTION 'this mark removal is not waiting' USING ERRCODE = '55000';
  END IF;
  IF v_removal.proposed_by_sub = p_sub THEN
    RAISE EXCEPTION 'a second officer approves a mark removal' USING ERRCODE = '42501';
  END IF;
  UPDATE redaction_mark_removal SET status = 'applied', approved_by_sub = p_sub, approved_at = now()
    WHERE id = p_removal RETURNING * INTO v_removal;
  UPDATE redaction_mark SET status = 'removed', removed_at = now() WHERE id = v_removal.mark_id;
  PERFORM redaction_audit(p_sub, p_groups, p_trace, 'redaction_mark_approve_removal', 'redaction_mark_removal', p_removal::text,
    'pending', 'applied', jsonb_build_object('mark_id', v_removal.mark_id));
  RETURN v_removal;
END
$fn$;

REVOKE EXECUTE ON FUNCTION redaction_mark_guard(), redaction_mark_removal_guard(), redaction_mark_require_officer(text, text[]),
  redaction_mark_add(text, uuid, text, text, text, text, text[], text),
  redaction_mark_propose_removal(uuid, text, text[], text),
  redaction_mark_approve_removal(uuid, text, text[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION redaction_mark_add(text, uuid, text, text, text, text, text[], text),
  redaction_mark_propose_removal(uuid, text, text[], text),
  redaction_mark_approve_removal(uuid, text, text[], text) TO nwfl;

-- The audit log learns the two new subjects.
ALTER TABLE audit_event DROP CONSTRAINT audit_event_subject_kind_check;
ALTER TABLE audit_event ADD CONSTRAINT audit_event_subject_kind_check
  CHECK (subject_kind IN ('content_item', 'content_version', 'stored_file', 'edition',
                          'event_series', 'event_occurrence', 'venue', 'office', 'office_term',
                          'member_account', 'signup_request', 'redaction_policy', 'redaction_change',
                          'redaction_mark', 'redaction_mark_removal'));
