-- 0011_freeze_fix.sql: the round-2 challenge's findings on files and editions (API-FIX3,
-- fix-forward).

-- 1. The files of an approved version are frozen whole. 0010 froze a file's audience and
--    version, so a public row could still be pointed at a members object (swap object_key),
--    or a members row deleted and inserted again as public. Now no column changes, no row
--    is deleted, and no file is added to or moved onto an approved or superseded version.
CREATE FUNCTION stored_file_frozen_whole() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  approved_version uuid;
BEGIN
  SELECT v.id INTO approved_version FROM content_version v
  WHERE v.status IN ('approved', 'superseded')
    AND v.id IN (CASE WHEN TG_OP <> 'INSERT' THEN OLD.version_id END, CASE WHEN TG_OP <> 'DELETE' THEN NEW.version_id END)
  LIMIT 1;
  IF approved_version IS NOT NULL THEN
    RAISE EXCEPTION 'stored_file on version %: the version is approved, so its files are frozen', approved_version
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$fn$;
CREATE TRIGGER stored_file_frozen_whole BEFORE INSERT OR UPDATE OR DELETE ON stored_file
  FOR EACH ROW EXECUTE FUNCTION stored_file_frozen_whole();

-- 2. An edition's status only moves forward: planning, collecting, drafting, proof,
--    published. Otherwise a frozen edition could be reopened, its pins dropped and the
--    printed issue rewritten.
CREATE FUNCTION edition_status_forward() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  steps text[] := ARRAY['planning', 'collecting', 'drafting', 'proof', 'published'];
BEGIN
  IF array_position(steps, NEW.status) < array_position(steps, OLD.status) THEN
    RAISE EXCEPTION 'edition % only moves forward, not from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER edition_status_forward BEFORE UPDATE OF status ON edition
  FOR EACH ROW EXECUTE FUNCTION edition_status_forward();

-- 3. A frozen edition's pins are what was printed: none added, removed or repointed. The one
--    change allowed is the takedown mark (API-FIX3 ruling: a takedown beats the pin), set once
--    when the item is withdrawn, and never cleared. The freeze pins while the edition is still
--    open, then freezes it, in one transaction.
ALTER TABLE edition_item ADD COLUMN taken_down_at timestamptz;

CREATE FUNCTION edition_item_pins_frozen() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  edition uuid := CASE WHEN TG_OP = 'INSERT' THEN NEW.edition_id ELSE OLD.edition_id END;
BEGIN
  IF EXISTS (SELECT 1 FROM edition e WHERE e.id = edition AND e.status IN ('proof', 'published')) THEN
    IF TG_OP <> 'UPDATE'
       OR (NEW.edition_id, NEW.item_id, NEW.version_id, NEW.pinned_at) IS DISTINCT FROM (OLD.edition_id, OLD.item_id, OLD.version_id, OLD.pinned_at)
       OR OLD.taken_down_at IS NOT NULL
       OR NEW.taken_down_at IS NULL
       OR NEW.taken_down_at <> now() THEN
      RAISE EXCEPTION 'edition %: the edition is frozen, so its pins are frozen but for a takedown', edition
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$fn$;
CREATE TRIGGER edition_item_pins_frozen BEFORE INSERT OR UPDATE OR DELETE ON edition_item
  FOR EACH ROW EXECUTE FUNCTION edition_item_pins_frozen();

-- 4. The sign-up's name and email are what the member typed, not National data: they are
--    kept after the decision, so the approvers' member list can name the account (A5).
--    0005 is applied and checksummed, so the note is recorded here and on the columns.
COMMENT ON COLUMN signup_request.display_name IS 'As the member typed it; kept after the decision, to name the account in the member list (not National data).';
COMMENT ON COLUMN signup_request.email IS 'As the member typed it; kept after the decision, to name the account in the member list (not National data).';
