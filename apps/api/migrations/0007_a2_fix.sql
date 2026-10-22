-- 0007_a2_fix.sql: the A2 challenge (FIX-FIRST), fixed forward.
--
-- Earlier files are not edited: migrate.sh treats an applied file as immutable, so every change
-- lands here. Each block names the finding it closes.

-- 1. THE BLOCKER: the workflow moves only along its transitions (R25, P18). Before this, an
--    approved version could be set back to draft, rewritten and re-approved, keeping its old
--    approver and hash. Versions:
--      draft -> ready (mark ready) | discarded
--      ready -> draft (send back)  | approved | discarded
--      approved -> superseded (a newer version went live)
--    Nothing leaves superseded or discarded, and nothing skips ready. "Superseded" needs a past
--    approval (content_version_approval_recorded), so only an approved version can become one.
--    The freeze itself is unchanged: authored columns from ready on, everything once decided.
CREATE OR REPLACE FUNCTION content_version_freeze() RETURNS trigger LANGUAGE plpgsql AS $fn$
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
       NEW.public_ast)
     IS DISTINCT FROM (
       OLD.content_hash, OLD.target_website, OLD.target_newsletter, OLD.target_email, OLD.edition_id,
       OLD.ready_at, OLD.approved_at, OLD.approved_by_sub, OLD.approval_kind, OLD.approval_reason,
       OLD.public_ast) THEN
    RAISE EXCEPTION 'content_version % is %: it is frozen', OLD.id, OLD.status
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END
$fn$;

-- Items:
--   draft -> ready | ready -> draft | ready -> published (first approval)
--   published -> withdrawn | withdrawn -> published (a restored revision is approved)
-- A published item stays published while its revision is a draft or ready, and a withdrawn
-- one stays withdrawn (410 to the public) until its restored revision is approved.
CREATE FUNCTION content_item_transition() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state AND (OLD.state, NEW.state) NOT IN (
       ('draft', 'ready'), ('ready', 'draft'), ('ready', 'published'),
       ('published', 'withdrawn'), ('withdrawn', 'published')) THEN
    RAISE EXCEPTION 'content_item % cannot go from % to %', OLD.id, OLD.state, NEW.state
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER content_item_transition BEFORE UPDATE ON content_item
  FOR EACH ROW EXECUTE FUNCTION content_item_transition();

-- Nothing is born past the start of its workflow: no version inserted already approved, no
-- item inserted already published.
CREATE FUNCTION content_version_starts_as_draft() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.status <> 'draft' THEN
    RAISE EXCEPTION 'content_version starts as a draft' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE FUNCTION content_item_starts_as_draft() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.state <> 'draft' THEN
    RAISE EXCEPTION 'content_item starts as a draft' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER content_version_starts_as_draft BEFORE INSERT ON content_version
  FOR EACH ROW EXECUTE FUNCTION content_version_starts_as_draft();
CREATE TRIGGER content_item_starts_as_draft BEFORE INSERT ON content_item
  FOR EACH ROW EXECUTE FUNCTION content_item_starts_as_draft();

-- An item's live version is an APPROVED version of that item, so no read path can serve a
-- draft or a ready version; and the live version cannot be superseded until another one has
-- replaced it (the key below blocks the status change while it is referenced).
ALTER TABLE content_version ADD CONSTRAINT content_version_of_item_with_status UNIQUE (id, item_id, status);
ALTER TABLE content_item
  ADD COLUMN live_status text GENERATED ALWAYS AS ('approved') STORED,
  DROP CONSTRAINT content_item_live_version_of_item,
  ADD CONSTRAINT content_item_live_version_is_approved
    FOREIGN KEY (live_version_id, id, live_status) REFERENCES content_version (id, item_id, status);

-- 3. Trees are JSON objects. A JSON null (or a string, or an array) is not a tree, and a reader
--    must never fall back from public_ast to body_ast.
ALTER TABLE content_version
  ADD CONSTRAINT content_version_public_ast_is_a_tree CHECK (public_ast IS NULL OR jsonb_typeof(public_ast) = 'object'),
  ADD CONSTRAINT content_version_body_ast_is_a_tree CHECK (jsonb_typeof(body_ast) = 'object');

-- 4. History the four-eyes check and the print pins rest on: a version is never deleted
--    (discard is a status), and the record of who saved it is append-only. A version with
--    editor rows cannot be deleted even by the owner (the foreign key has no cascade).
REVOKE DELETE ON content_version FROM nwfl;
REVOKE UPDATE, DELETE ON content_version_editor FROM nwfl;

-- 5. The database numbers and times each audit event. With table-level INSERT the app could
--    write OVERRIDING SYSTEM VALUE into id, or back-date `at`. Column grants leave both out.
--    A column added later must be granted here too, deliberately.
REVOKE INSERT ON audit_event FROM nwfl;
GRANT INSERT (trace_id, actor_kind, actor_sub, acting_office_id, actor_groups, action, subject_kind, subject_id,
              item_id, version_id, content_hash, from_state, to_state, note, payload)
  ON audit_event TO nwfl;

-- 6. No membership number and no last name in an audit payload, under any spelling: snake,
--    camel (protobuf JSON's membershipNumber, lastName), spaced or abbreviated.
ALTER TABLE audit_event
  DROP CONSTRAINT audit_event_no_membership_number,
  ADD CONSTRAINT audit_event_no_membership_inputs CHECK (NOT jsonb_path_exists(payload,
    'lax $.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "^(member(ship)?[ _-]?(number|num|no|nr)|last[ _-]?name)$" flag "i")'));

-- 7. An edition's hosted PDF is a PUBLIC file of THAT edition: the composite key below needs
--    the file's id, edition and audience to match, and keeps the file public while it is used.
ALTER TABLE stored_file ADD CONSTRAINT stored_file_of_edition UNIQUE (id, edition_id, audience);
ALTER TABLE edition
  ADD COLUMN public_pdf_audience text GENERATED ALWAYS AS ('public') STORED,
  DROP CONSTRAINT edition_public_pdf,
  ADD CONSTRAINT edition_public_pdf_is_public_of_edition
    FOREIGN KEY (public_pdf_file_id, id, public_pdf_audience) REFERENCES stored_file (id, edition_id, audience);

-- 8. A member's home shows only its area and the host office's role alias (R3): no city.
ALTER TABLE venue ADD CONSTRAINT venue_member_home_has_no_city CHECK (kind <> 'member_home' OR city IS NULL);

-- 9. The verifier's inputs are erased on every decision, not only when the verifier reports:
--    an officer's approval or rejection must NULL the number and the last name in the same
--    statement. decided_at and decided_by_sub are set exactly when a decision is.
ALTER TABLE signup_request
  ADD COLUMN decision text NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending', 'approved', 'rejected')),
  ADD COLUMN decided_at timestamptz,
  ADD COLUMN decided_by_sub text,
  ADD CONSTRAINT signup_request_inputs_erased_on_decision
    CHECK (decision = 'pending' OR (membership_number IS NULL AND last_name IS NULL)),
  ADD CONSTRAINT signup_request_decision_recorded
    CHECK ((decision = 'pending') = (decided_at IS NULL) AND (decision = 'pending') = (decided_by_sub IS NULL));

DROP INDEX signup_request_pending;
CREATE INDEX signup_request_pending ON signup_request (created_at)
  WHERE verification = 'unchecked' AND decision = 'pending' AND membership_number IS NOT NULL;

-- 11. No temporary tables for anyone but the owner: a session's temp table is searched before
--     the real one, so one could shadow `office` for the rest of that session.
SELECT format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database())
\gexec
