-- 0029_approve_publish.sql: approving and publishing become two steps (EDITOR A1).
--
-- A version now goes ready -> cleared -> approved. "cleared" is "Approved, ready to publish": a
-- reviewer who did not edit it approved it, and nothing the public or members see has changed.
-- "approved" stays the published status (the live pointer's generated live_status, 0007, and the
-- newest-approved rule, 0010, depend on it). Publishing records who published and when.
--
--   * ready -> approved is gone, so the database itself holds approve-before-publish.
--   * At cleared the version is frozen: its authored content, hash, targets, edition, ready time,
--     approval, public tree and rule, and its files. It may go back to draft (an edit, a send-back or
--     a withdraw voids the approval) or be discarded, and then its approval columns are dropped: a
--     draft, ready or discarded version carries none.
--   * The four-eyes guard (0023) now fires on ready -> cleared. On cleared -> approved it adds: a
--     version approved by its approver's own exception (break-glass, or one approver) is published by
--     someone else; a one-approver approval is published only while the rule is still one approver; a
--     publication is dated when it happens. The issue loader is exempt from the first, and only when
--     it approved and published in one transaction: approved_by_sub = published_by_sub =
--     'system:issue-loader' and approved_at = published_at, now() being fixed for a transaction. A
--     user token naming a system: subject is refused at the gate (auth/caller.ts).
--
-- FORWARD-ONLY. The API, worker and loader images from before 0029 write ready -> approved without
-- the publication columns, which this schema refuses: the migrate Job, the API, the worker and the
-- loader Job's image roll together, and a problem after 0029 is fixed forward with a new release.

-- 1. The status vocabulary, and what each status carries.
ALTER TABLE content_version
  ADD COLUMN published_at timestamptz,
  ADD COLUMN published_by_sub text CHECK (published_by_sub <> '');

-- Every version published so far was published when it was approved, by its approver. The freeze
-- below does not yet list these columns, so the backfill passes 0023's freeze.
UPDATE content_version SET published_at = approved_at, published_by_sub = approved_by_sub WHERE status IN ('approved', 'superseded');

ALTER TABLE content_version
  DROP CONSTRAINT content_version_status_check,
  ADD CONSTRAINT content_version_status_check CHECK (status IN ('draft', 'ready', 'cleared', 'approved', 'superseded', 'discarded')),
  DROP CONSTRAINT content_version_hash_once_ready,
  ADD CONSTRAINT content_version_hash_once_ready CHECK (status NOT IN ('ready', 'cleared', 'approved', 'superseded') OR content_hash IS NOT NULL),
  DROP CONSTRAINT content_version_approval_recorded,
  ADD CONSTRAINT content_version_approval_recorded
    CHECK (status NOT IN ('cleared', 'approved', 'superseded')
           OR (approved_at IS NOT NULL AND approved_by_sub IS NOT NULL AND approval_kind IS NOT NULL AND public_ast IS NOT NULL)),
  DROP CONSTRAINT content_version_approval_rule_recorded,
  ADD CONSTRAINT content_version_approval_rule_recorded CHECK ((status IN ('cleared', 'approved', 'superseded')) = (approval_rule IS NOT NULL)),
  -- An approval voided (cleared -> draft or discarded) leaves nothing of itself behind.
  ADD CONSTRAINT content_version_unapproved_carries_no_approval
    CHECK (status NOT IN ('draft', 'ready', 'discarded')
           OR (approved_at IS NULL AND approved_by_sub IS NULL AND approval_kind IS NULL AND approval_reason IS NULL AND public_ast IS NULL)),
  ADD CONSTRAINT content_version_publication_recorded
    CHECK ((status IN ('approved', 'superseded')) = (published_at IS NOT NULL AND published_by_sub IS NOT NULL)),
  ADD CONSTRAINT content_version_publication_whole CHECK ((published_at IS NULL) = (published_by_sub IS NULL));

-- 2. The freeze: 0023's body, with cleared among the transitions and frozen, ready -> approved gone,
--    and the publication columns frozen once published.
CREATE OR REPLACE FUNCTION content_version_freeze() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND (OLD.status, NEW.status) NOT IN (
       ('draft', 'ready'), ('draft', 'discarded'),
       ('ready', 'draft'), ('ready', 'cleared'), ('ready', 'discarded'),
       ('cleared', 'approved'), ('cleared', 'draft'), ('cleared', 'discarded'),
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
  -- Cleared: what the reviewer approved stays as approved. Going back to draft or discarded drops
  -- the approval (content_version_unapproved_carries_no_approval), but never changes the rest.
  IF OLD.status = 'cleared' AND (
       (NEW.content_hash, NEW.target_website, NEW.target_newsletter, NEW.target_email, NEW.edition_id, NEW.ready_at)
       IS DISTINCT FROM (OLD.content_hash, OLD.target_website, OLD.target_newsletter, OLD.target_email, OLD.edition_id, OLD.ready_at)
     OR (NEW.status NOT IN ('draft', 'discarded') AND
         (NEW.approved_at, NEW.approved_by_sub, NEW.approval_kind, NEW.approval_reason, NEW.public_ast, NEW.approval_rule)
         IS DISTINCT FROM (OLD.approved_at, OLD.approved_by_sub, OLD.approval_kind, OLD.approval_reason, OLD.public_ast, OLD.approval_rule))) THEN
    RAISE EXCEPTION 'content_version % is cleared: it is frozen until published, or sent back', OLD.id
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF OLD.status IN ('approved', 'superseded', 'discarded') AND (
       NEW.content_hash, NEW.target_website, NEW.target_newsletter, NEW.target_email, NEW.edition_id,
       NEW.ready_at, NEW.approved_at, NEW.approved_by_sub, NEW.approval_kind, NEW.approval_reason,
       NEW.public_ast, NEW.approval_rule, NEW.published_at, NEW.published_by_sub)
     IS DISTINCT FROM (
       OLD.content_hash, OLD.target_website, OLD.target_newsletter, OLD.target_email, OLD.edition_id,
       OLD.ready_at, OLD.approved_at, OLD.approved_by_sub, OLD.approval_kind, OLD.approval_reason,
       OLD.public_ast, OLD.approval_rule, OLD.published_at, OLD.published_by_sub) THEN
    RAISE EXCEPTION 'content_version % is %: it is frozen', OLD.id, OLD.status
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END
$fn$;

-- 3. The four-eyes guard (0023): the rule, editor and single-approver checks on ready -> cleared;
--    the publisher checks on cleared -> approved. Still named to fire before content_version_freeze.
CREATE OR REPLACE FUNCTION content_version_approval_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_rule   text;
  v_editor boolean;
BEGIN
  IF OLD.status = 'ready' AND NEW.status = 'cleared' THEN
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
  ELSIF OLD.status = 'cleared' AND NEW.status = 'approved' THEN
    IF NEW.published_at IS NOT NULL AND NEW.published_at <> now() THEN
      RAISE EXCEPTION 'a publication is dated when it happens' USING ERRCODE = '55000';
    END IF;
    IF NEW.approval_kind IN ('self_breakglass', 'self_single') AND NEW.published_by_sub = NEW.approved_by_sub
       AND NOT (NEW.approved_by_sub = 'system:issue-loader' AND NEW.approved_at = NEW.published_at) THEN
      RAISE EXCEPTION 'a version its approver approved by their own exception is published by someone else' USING ERRCODE = '55000';
    END IF;
    IF NEW.approval_kind = 'self_single' THEN
      v_rule := approval_rule_read('content');
      IF v_rule <> 'one_approver' THEN
        RAISE EXCEPTION 'the approval rule is now %: send it back', v_rule USING ERRCODE = '55000';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

-- 4. Files: a cleared version's files are frozen as an approved one's are (0010, 0011): approval
--    decided what the public may fetch. Their bodies exactly, with cleared, and 0019's search_path.
CREATE OR REPLACE FUNCTION stored_file_frozen_once_approved() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF OLD.version_id IS NOT NULL
     AND (NEW.audience, NEW.version_id) IS DISTINCT FROM (OLD.audience, OLD.version_id)
     AND EXISTS (SELECT 1 FROM content_version WHERE id = OLD.version_id AND status IN ('cleared', 'approved', 'superseded')) THEN
    RAISE EXCEPTION 'stored_file %: its version is approved, so its audience is frozen', OLD.id
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION stored_file_frozen_whole() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  approved_version uuid;
BEGIN
  SELECT v.id INTO approved_version FROM content_version v
  WHERE v.status IN ('cleared', 'approved', 'superseded')
    AND v.id IN (CASE WHEN TG_OP <> 'INSERT' THEN OLD.version_id END, CASE WHEN TG_OP <> 'DELETE' THEN NEW.version_id END)
  LIMIT 1;
  IF approved_version IS NOT NULL THEN
    RAISE EXCEPTION 'stored_file on version %: the version is approved, so its files are frozen', approved_version
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$fn$;
