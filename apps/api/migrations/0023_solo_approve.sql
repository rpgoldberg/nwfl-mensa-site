-- 0023_solo_approve.sql: the Admin's approval switch (SOLO-APPROVE).
--
-- Two settings, one row each in approval_rule, both two_person by default (today's rules):
--   content            two_person: a version is approved by an approver who did not edit it, or
--                      by the Admin's logged break-glass (D-P1). one_approver: an approver (the
--                      Admin or the Webmaster, unchanged) may also approve a version they edited,
--                      recorded as approval_kind 'self_single'.
--   redaction_policy   two_person: a loosening of the public audience waits for a second officer
--                      (0012, 0013). one_approver: it applies at once, approved by its proposer.
-- Ross may answer "content only": that is content one_approver with redaction_policy left
-- two_person, and needs no code change.
--
--   * approval_rule_set, SECURITY DEFINER, is the one writer. It refuses a caller whose groups do
--     not hold nwfl-admin (42501; the API passes the verified token's groups and is the wall, as
--     for 0016's officer check) and a reason that is over-long or says nothing: it needs a letter
--     or a digit, after every kind of space is trimmed (22023, before the no-op test). A flip to
--     the rule already set writes nothing (idempotent). A flip from a setting that has moved since
--     the Admin read it (p_expected: the change_id they saw, '' for the default) is refused
--     (55000), so a stale form sent again cannot undo a later switch. Otherwise it appends one
--     approval_rule_change row (who, groups, when, from, to, reason, trace) and one audit_event row,
--     then points the setting at the change. Both ledger tables are append-only for every role, the
--     owner included; the app role only reads them.
--   * approval_rule_flip_guard refuses every other UPDATE of approval_rule, the owner's too: the
--     setting moves only to a flip that approval_rule_set wrote, with its audit row, in the same
--     call. One approver is never held without when, who and which flip set it (CHECK).
--   * approval_rule_read takes the setting under FOR SHARE (the app role may not lock a table it
--     cannot update), so an approval and a flip serialize: the approval sees the rule committed
--     before it, and a flip waits for the approvals holding the rule.
--   * Content: every approved or superseded version records the rule it was approved under
--     (backfilled two_person: everything approved so far was). A new trigger is the database's
--     first four-eyes check for content: an editor of the version approves it only as
--     self_breakglass, or as self_single under one_approver, and the recorded rule is the one in
--     force (filled in when the writer names none).
--   * Redaction: redaction_propose and redaction_approve read the rule after the cell lock. Under
--     one_approver a public loosening applies at once, its proposer named as approver, and a
--     proposer may approve their own change still waiting; every change records the rule it was
--     decided under, and a trigger holds that to the setting.
--
-- LOCK ORDER (tested, test/migrations/solo-approve-0023.test.ts): the redaction cell lock, or the
-- content item row lock, then approval_rule FOR SHARE, then the publication-ledger head
-- (publication_ledger_stamp). A flip takes the approval_rule row alone, FOR UPDATE, and never the
-- head, so no cycle exists, even on the issue loader's path, which takes the head first (its
-- readyVersion moves the item to ready) and the rule after it.

-- 1. The setting.
CREATE TABLE approval_rule (
  scope      text        PRIMARY KEY CHECK (scope IN ('content', 'redaction_policy')),
  rule       text        NOT NULL CHECK (rule IN ('two_person', 'one_approver')),
  set_at     timestamptz,
  set_by_sub text        CHECK (set_by_sub <> ''),
  -- The flip that set it (approval_rule_change, below); the revision the Admin's form carries.
  change_id  uuid,
  CONSTRAINT approval_rule_set_together CHECK ((set_at IS NULL) = (set_by_sub IS NULL) AND (set_at IS NULL) = (change_id IS NULL)),
  CONSTRAINT approval_rule_one_approver_set CHECK (rule = 'two_person' OR set_at IS NOT NULL)
);

INSERT INTO approval_rule (scope, rule) VALUES ('content', 'two_person'), ('redaction_policy', 'two_person');

REVOKE INSERT, UPDATE, DELETE ON approval_rule FROM nwfl;

-- 2. The flip ledger: one row per applied flip, never rewritten.
CREATE TABLE approval_rule_change (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  scope             text        NOT NULL REFERENCES approval_rule (scope),
  from_rule         text        NOT NULL CHECK (from_rule IN ('two_person', 'one_approver')),
  to_rule           text        NOT NULL CHECK (to_rule IN ('two_person', 'one_approver')),
  -- A letter (any alphabet: the builtin collation's Unicode classes) or a digit; never only spaces,
  -- punctuation or invisible characters.
  reason            text        NOT NULL CHECK (length(reason) <= 2000 AND (reason COLLATE pg_c_utf8) ~ '[[:alnum:]]'),
  changed_by_sub    text        NOT NULL CHECK (changed_by_sub <> ''),
  changed_by_groups text[]      NOT NULL CHECK ('nwfl-admin' = ANY (changed_by_groups)),
  changed_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  trace_id          text        CHECK (trace_id ~ '^[0-9a-f]{32}$'),
  CONSTRAINT approval_rule_change_changes CHECK (from_rule <> to_rule)
);

CREATE INDEX approval_rule_change_by_scope ON approval_rule_change (scope, changed_at);

ALTER TABLE approval_rule ADD CONSTRAINT approval_rule_change_fk FOREIGN KEY (change_id) REFERENCES approval_rule_change (id);

REVOKE INSERT, UPDATE, DELETE ON approval_rule_change FROM nwfl;

CREATE FUNCTION approval_rule_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF TG_TABLE_NAME = 'approval_rule' THEN
    RAISE EXCEPTION 'an approval setting is never removed: % refused', TG_OP USING ERRCODE = '55000';
  END IF;
  RAISE EXCEPTION 'approval_rule_change is append-only: % refused', TG_OP USING ERRCODE = '55000';
END
$fn$;

CREATE TRIGGER approval_rule_guard BEFORE DELETE ON approval_rule
  FOR EACH ROW EXECUTE FUNCTION approval_rule_guard();
CREATE TRIGGER approval_rule_no_truncate BEFORE TRUNCATE ON approval_rule
  FOR EACH STATEMENT EXECUTE FUNCTION approval_rule_guard();
CREATE TRIGGER approval_rule_change_guard BEFORE UPDATE OR DELETE ON approval_rule_change
  FOR EACH ROW EXECUTE FUNCTION approval_rule_guard();
CREATE TRIGGER approval_rule_change_no_truncate BEFORE TRUNCATE ON approval_rule_change
  FOR EACH STATEMENT EXECUTE FUNCTION approval_rule_guard();

COMMENT ON TRIGGER approval_rule_change_guard ON approval_rule_change IS
  'Refuses every role''s UPDATE and DELETE, the owner''s included; the owner can disable or drop it, as for every guard trigger (0019).';

-- The setting moves only to the flip approval_rule_set has just written: its change row (scope,
-- from, to, when, who) and its audit row, named by the transaction-local marker the function sets
-- just before its update and clears just after, so the marker never outlives the call.
CREATE FUNCTION approval_rule_flip_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_change approval_rule_change;
BEGIN
  IF NEW.scope = OLD.scope AND NEW.change_id IS DISTINCT FROM OLD.change_id
     AND NEW.change_id::text = current_setting('nwfl.approval_rule_change', true) THEN
    SELECT * INTO v_change FROM approval_rule_change c WHERE c.id = NEW.change_id;
    IF FOUND AND v_change.scope = NEW.scope AND v_change.from_rule = OLD.rule AND v_change.to_rule = NEW.rule
       AND v_change.changed_at = NEW.set_at AND v_change.changed_by_sub = NEW.set_by_sub
       AND EXISTS (SELECT 1 FROM audit_event e WHERE e.subject_kind = 'approval_rule' AND e.subject_id = NEW.scope
                     AND e.action = 'approval_rule_set' AND e.payload ->> 'change_id' = NEW.change_id::text) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'the approval rule is switched only by approval_rule_set, with its record' USING ERRCODE = '55000';
END
$fn$;

CREATE TRIGGER approval_rule_flip_guard BEFORE UPDATE ON approval_rule
  FOR EACH ROW EXECUTE FUNCTION approval_rule_flip_guard();

COMMENT ON TRIGGER approval_rule_flip_guard ON approval_rule IS
  'Refuses every role''s UPDATE but approval_rule_set''s flip, the owner''s included; the owner can disable or drop it, as for every guard trigger (0019).';

-- 3. The writer and the reader.
CREATE FUNCTION approval_rule_set(p_scope text, p_rule text, p_reason text, p_sub text, p_groups text[], p_trace text,
                                  p_expected text DEFAULT NULL)
  RETURNS TABLE (rule text, set_at timestamptz, change_id uuid, changed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
#variable_conflict use_column
DECLARE
  -- Trimmed of every kind of space (the builtin collation's Unicode class), not btrim's spaces alone.
  v_reason text := regexp_replace(coalesce(p_reason, '') COLLATE pg_c_utf8, '^[[:space:]]+|[[:space:]]+$', '', 'g');
  v_row    approval_rule;
  v_change approval_rule_change;
BEGIN
  IF coalesce(p_sub, '') = '' OR NOT coalesce('nwfl-admin' = ANY (p_groups), false) THEN
    RAISE EXCEPTION 'only the Admin sets the approval rule' USING ERRCODE = '42501';
  END IF;
  IF length(v_reason) > 2000 OR NOT (v_reason COLLATE pg_c_utf8) ~ '[[:alnum:]]' THEN
    RAISE EXCEPTION 'a change of the approval rule needs a reason of 1 to 2000 characters, in words' USING ERRCODE = '22023';
  END IF;
  IF p_rule IS NULL OR p_rule NOT IN ('two_person', 'one_approver') THEN
    RAISE EXCEPTION 'no such approval rule' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_row FROM approval_rule a WHERE a.scope = p_scope FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such approval scope' USING ERRCODE = '22023';
  END IF;
  IF v_row.rule = p_rule THEN
    RETURN QUERY SELECT v_row.rule, v_row.set_at, v_row.change_id, false;
    RETURN;
  END IF;
  IF p_expected IS NOT NULL AND p_expected <> coalesce(v_row.change_id::text, '') THEN
    RAISE EXCEPTION 'the approval rule was switched since it was read: read it again' USING ERRCODE = '55000';
  END IF;
  INSERT INTO approval_rule_change (scope, from_rule, to_rule, reason, changed_by_sub, changed_by_groups, trace_id)
    VALUES (p_scope, v_row.rule, p_rule, v_reason, p_sub, p_groups, p_trace) RETURNING * INTO v_change;
  INSERT INTO audit_event (trace_id, actor_kind, actor_sub, actor_groups, action, subject_kind, subject_id, from_state, to_state, note, payload)
    VALUES (p_trace, 'user', p_sub, p_groups, 'approval_rule_set', 'approval_rule', p_scope, v_row.rule, p_rule, v_reason,
            jsonb_build_object('change_id', v_change.id));
  PERFORM set_config('nwfl.approval_rule_change', v_change.id::text, true);
  UPDATE approval_rule a SET rule = p_rule, set_at = v_change.changed_at, set_by_sub = p_sub, change_id = v_change.id WHERE a.scope = p_scope;
  PERFORM set_config('nwfl.approval_rule_change', '', true);
  RETURN QUERY SELECT p_rule, v_change.changed_at, v_change.id, true;
END
$fn$;

CREATE FUNCTION approval_rule_read(p_scope text) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_rule text;
BEGIN
  SELECT a.rule INTO v_rule FROM approval_rule a WHERE a.scope = p_scope FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such approval scope' USING ERRCODE = '22023';
  END IF;
  RETURN v_rule;
END
$fn$;

REVOKE EXECUTE ON FUNCTION approval_rule_set(text, text, text, text, text[], text, text), approval_rule_read(text), approval_rule_guard(),
  approval_rule_flip_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION approval_rule_set(text, text, text, text, text[], text, text), approval_rule_read(text) TO nwfl;

-- 4. The audit log learns the new subject (0014's list, plus approval_rule).
ALTER TABLE audit_event DROP CONSTRAINT audit_event_subject_kind_check;
ALTER TABLE audit_event ADD CONSTRAINT audit_event_subject_kind_check
  CHECK (subject_kind IN ('content_item', 'content_version', 'stored_file', 'edition',
                          'event_series', 'event_occurrence', 'venue', 'office', 'office_term',
                          'member_account', 'signup_request', 'redaction_policy', 'redaction_change',
                          'redaction_mark', 'redaction_mark_removal', 'approval_rule'));

-- 5. Content: the rule each approval was made under. The backfill runs before the freeze below
--    lists the column, under 0007's freeze, which lets a same-status update through.
ALTER TABLE content_version ADD COLUMN approval_rule text CHECK (approval_rule IN ('two_person', 'one_approver'));

UPDATE content_version SET approval_rule = 'two_person' WHERE status IN ('approved', 'superseded');

ALTER TABLE content_version
  ADD CONSTRAINT content_version_approval_rule_recorded CHECK ((status IN ('approved', 'superseded')) = (approval_rule IS NOT NULL)),
  DROP CONSTRAINT content_version_approval_kind_check,
  ADD CONSTRAINT content_version_approval_kind_check CHECK (approval_kind IN ('normal', 'self_breakglass', 'self_single')),
  ADD CONSTRAINT content_version_self_single_rule CHECK (approval_kind IS DISTINCT FROM 'self_single' OR approval_rule = 'one_approver');

-- 0007's body exactly, plus approval_rule among the columns frozen once decided; 0019's search_path.
CREATE OR REPLACE FUNCTION content_version_freeze() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND (OLD.status, NEW.status) NOT IN (
       ('draft', 'ready'), ('draft', 'discarded'),
       ('ready', 'draft'), ('ready', 'approved'), ('ready', 'discarded'),
       ('approved', 'superseded')) THEN
    RAISE EXCEPTION 'content_version % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF OLD.status <> 'draft' AND (
       NEW.item_id, NEW.n, NEW.title, NEW.summary, NEW.visibility, NEW.body_src, NEW.body_ast,
       NEW.print_as_is, NEW.on_behalf_of, NEW.created_by_sub, NEW.acting_office_id)
     IS DISTINCT FROM (
       OLD.item_id, OLD.n, OLD.title, OLD.summary, OLD.visibility, OLD.body_src, OLD.body_ast,
       OLD.print_as_is, OLD.on_behalf_of, OLD.created_by_sub, OLD.acting_office_id) THEN
    RAISE EXCEPTION 'content_version % is %: its authored content is frozen', OLD.id, OLD.status
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF OLD.status IN ('approved', 'superseded', 'discarded') AND (
       NEW.content_hash, NEW.target_website, NEW.target_newsletter, NEW.target_email, NEW.edition_id,
       NEW.ready_at, NEW.approved_at, NEW.approved_by_sub, NEW.approval_kind, NEW.approval_reason,
       NEW.public_ast, NEW.approval_rule)
     IS DISTINCT FROM (
       OLD.content_hash, OLD.target_website, OLD.target_newsletter, OLD.target_email, OLD.edition_id,
       OLD.ready_at, OLD.approved_at, OLD.approved_by_sub, OLD.approval_kind, OLD.approval_reason,
       OLD.public_ast, OLD.approval_rule) THEN
    RAISE EXCEPTION 'content_version % is %: it is frozen', OLD.id, OLD.status
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END
$fn$;

-- 6. The content four-eyes backstop, new here: until now only the API refused an editor approving
--    their own version. Named to fire before content_version_freeze (triggers fire by name).
CREATE FUNCTION content_version_approval_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_rule   text;
  v_editor boolean;
BEGIN
  IF NEW.status IS DISTINCT FROM 'approved' OR OLD.status IS NOT DISTINCT FROM 'approved' THEN
    RETURN NEW;
  END IF;
  v_rule := approval_rule_read('content');
  IF NEW.approval_rule IS NULL THEN
    NEW.approval_rule := v_rule;
  ELSIF NEW.approval_rule <> v_rule THEN
    RAISE EXCEPTION 'the approval rule is now %: approve again', v_rule USING ERRCODE = '55000';
  END IF;
  v_editor := EXISTS (SELECT 1 FROM content_version_editor e WHERE e.version_id = NEW.id AND e.subject = NEW.approved_by_sub);
  IF v_editor AND coalesce(NEW.approval_kind, '') NOT IN ('self_breakglass', 'self_single') THEN
    RAISE EXCEPTION 'an editor of this version approves it only by break-glass, or while one approver is enough' USING ERRCODE = '55000';
  END IF;
  IF NEW.approval_kind = 'self_single' AND NOT (v_editor AND v_rule = 'one_approver') THEN
    RAISE EXCEPTION 'a single-approver approval is an editor''s own, while one approver is enough' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER content_version_approval_guard BEFORE UPDATE OF status ON content_version
  FOR EACH ROW EXECUTE FUNCTION content_version_approval_guard();

-- 7. Redaction: the rule each change was decided under. Every row so far was decided under
--    two-person; the default fills them without firing a trigger.
ALTER TABLE redaction_change ADD COLUMN approval_rule text NOT NULL DEFAULT 'two_person' CHECK (approval_rule IN ('two_person', 'one_approver'));

ALTER TABLE redaction_change
  DROP CONSTRAINT redaction_change_not_self_approved,
  ADD CONSTRAINT redaction_change_not_self_approved
    CHECK (approved_by_sub IS NULL OR approved_by_sub <> proposed_by_sub OR approval_rule = 'one_approver');

-- 0013's guard, plus: the rule changes only when a waiting change is applied.
CREATE OR REPLACE FUNCTION redaction_change_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'redaction_change is append-only' USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'pending' OR NEW.status NOT IN ('applied', 'superseded') THEN
    RAISE EXCEPTION 'a redaction change is decided once' USING ERRCODE = '55000';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.audience, NEW.category, NEW.from_action, NEW.to_action, NEW.proposed_by_sub, NEW.proposed_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.audience, OLD.category, OLD.from_action, OLD.to_action, OLD.proposed_by_sub, OLD.proposed_at) THEN
    RAISE EXCEPTION 'a redaction change keeps what was proposed' USING ERRCODE = '55000';
  END IF;
  IF NEW.status = 'superseded' AND NEW.approval_rule IS DISTINCT FROM OLD.approval_rule THEN
    RAISE EXCEPTION 'a superseded redaction change keeps its approval rule' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$fn$;

-- A change is decided under the rule in force: its insert, and its approval. Named to fire before
-- redaction_change_ledger_stamp, so the rule is taken before the ledger head (the lock order).
CREATE FUNCTION redaction_change_approval_rule_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_rule text;
BEGIN
  IF TG_OP = 'UPDATE' AND NOT (OLD.status = 'pending' AND NEW.status = 'applied') THEN
    RETURN NEW;
  END IF;
  v_rule := approval_rule_read('redaction_policy');
  IF NEW.approval_rule <> v_rule THEN
    RAISE EXCEPTION 'the approval rule for the redaction policy is %', v_rule USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER redaction_change_approval_rule_guard BEFORE INSERT OR UPDATE ON redaction_change
  FOR EACH ROW EXECUTE FUNCTION redaction_change_approval_rule_guard();

-- 0013's propose, plus the rule: read after the cell lock; under one_approver a public loosening
-- takes the apply-now path, approved by its proposer.
CREATE OR REPLACE FUNCTION redaction_propose(p_tenant text, p_audience text, p_category text, p_to text,
                                             p_sub text, p_groups text[], p_trace text) RETURNS redaction_change
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_from      text;
  v_rule      text;
  v_loosening boolean;
  v_change    redaction_change;
  v_id        uuid;
  v_payload   jsonb;
BEGIN
  IF coalesce(p_sub, '') = '' THEN
    RAISE EXCEPTION 'a redaction change needs its proposer' USING ERRCODE = '42501';
  END IF;
  v_from := redaction_lock_cell(p_tenant, p_audience, p_category);
  v_rule := approval_rule_read('redaction_policy');
  v_loosening := p_audience = 'public' AND redaction_rank(p_to) < redaction_rank(v_from);
  v_payload := jsonb_build_object('tenant', p_tenant, 'audience', p_audience, 'category', p_category);
  IF v_loosening AND v_rule = 'two_person' THEN
    IF EXISTS (SELECT 1 FROM redaction_change WHERE tenant_id = p_tenant AND audience = p_audience
                 AND category = p_category AND status = 'pending') THEN
      RAISE EXCEPTION 'a change to this cell is already waiting' USING ERRCODE = '55000';
    END IF;
    INSERT INTO redaction_change (tenant_id, audience, category, from_action, to_action, status, proposed_by_sub, approval_rule)
      VALUES (p_tenant, p_audience, p_category, v_from, p_to, 'pending', p_sub, v_rule) RETURNING * INTO v_change;
    PERFORM redaction_audit(p_sub, p_groups, p_trace, 'redaction_propose', 'redaction_change', v_change.id::text, v_from, p_to, v_payload);
    RETURN v_change;
  END IF;
  -- Applies at once, and replaces a loosening still waiting on this cell.
  FOR v_id IN
    UPDATE redaction_change SET status = 'superseded', decided_at = now()
      WHERE tenant_id = p_tenant AND audience = p_audience AND category = p_category AND status = 'pending'
      RETURNING id
  LOOP
    PERFORM redaction_audit(p_sub, p_groups, p_trace, 'redaction_supersede', 'redaction_change', v_id::text, 'pending', 'superseded', '{}');
  END LOOP;
  IF v_loosening THEN
    -- One approver: the proposer is the approver, on the record.
    INSERT INTO redaction_change (tenant_id, audience, category, from_action, to_action, status, proposed_by_sub,
                                  approved_by_sub, approved_at, decided_at, approval_rule)
      VALUES (p_tenant, p_audience, p_category, v_from, p_to, 'applied', p_sub, p_sub, now(), now(), v_rule) RETURNING * INTO v_change;
    PERFORM redaction_audit(p_sub, p_groups, p_trace, 'redaction_propose', 'redaction_change', v_change.id::text, v_from, p_to,
      v_payload || jsonb_build_object('rule', v_rule));
    PERFORM redaction_audit(p_sub, p_groups, p_trace, 'redaction_approve', 'redaction_change', v_change.id::text, 'pending', 'applied',
      jsonb_build_object('rule', v_rule));
  ELSE
    INSERT INTO redaction_change (tenant_id, audience, category, from_action, to_action, status, proposed_by_sub, decided_at, approval_rule)
      VALUES (p_tenant, p_audience, p_category, v_from, p_to, 'applied', p_sub, now(), v_rule) RETURNING * INTO v_change;
  END IF;
  PERFORM redaction_set_cell(v_change, p_sub, p_groups, p_trace);
  RETURN v_change;
END
$fn$;

-- 0013's approve, plus the rule: under one_approver the proposer may approve, and the change records
-- the rule it was approved under.
CREATE OR REPLACE FUNCTION redaction_approve(p_change_id uuid, p_sub text, p_groups text[], p_trace text) RETURNS redaction_change
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_change redaction_change;
  v_now    text;
  v_rule   text;
BEGIN
  IF coalesce(p_sub, '') = '' THEN
    RAISE EXCEPTION 'a redaction approval needs its approver' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_change FROM redaction_change WHERE id = p_change_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such redaction change' USING ERRCODE = '55000';
  END IF;
  -- The cell first, as a proposal takes it, then the rule, then the change.
  v_now := redaction_lock_cell(v_change.tenant_id, v_change.audience, v_change.category);
  v_rule := approval_rule_read('redaction_policy');
  SELECT * INTO v_change FROM redaction_change WHERE id = p_change_id FOR UPDATE;
  IF v_change.status <> 'pending' THEN
    RAISE EXCEPTION 'this redaction change is not waiting' USING ERRCODE = '55000';
  END IF;
  IF v_change.proposed_by_sub = p_sub AND v_rule = 'two_person' THEN
    RAISE EXCEPTION 'a second officer approves a redaction change' USING ERRCODE = '42501';
  END IF;
  IF v_now <> v_change.from_action THEN
    RAISE EXCEPTION 'the cell changed since this was proposed' USING ERRCODE = '55000';
  END IF;
  UPDATE redaction_change SET status = 'applied', approved_by_sub = p_sub, approved_at = now(), decided_at = now(), approval_rule = v_rule
    WHERE id = p_change_id RETURNING * INTO v_change;
  PERFORM redaction_audit(p_sub, p_groups, p_trace, 'redaction_approve', 'redaction_change', p_change_id::text, 'pending', 'applied',
    CASE WHEN v_rule = 'one_approver' THEN jsonb_build_object('rule', v_rule) ELSE '{}'::jsonb END);
  PERFORM redaction_set_cell(v_change, p_sub, p_groups, p_trace);
  RETURN v_change;
END
$fn$;

REVOKE EXECUTE ON FUNCTION content_version_approval_guard(), redaction_change_approval_rule_guard() FROM PUBLIC;
