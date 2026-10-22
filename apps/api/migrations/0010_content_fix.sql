-- 0010_content_fix.sql: the stack challenge's findings on the content records (STACK-FIX,
-- fix-forward).

-- 1. An item's live version is its NEWEST approved version, checked at commit (approval
--    approves the new version, repoints live and supersedes the old one in one
--    transaction). Without it, a second approved version left the older one live, or
--    live could be pointed back at it: a roll-back nobody approved.
CREATE FUNCTION content_item_check_live_is_newest(item uuid) RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  live uuid;
  newest uuid;
BEGIN
  SELECT live_version_id INTO live FROM content_item WHERE id = item;
  IF live IS NULL THEN
    RETURN;
  END IF;
  SELECT id INTO newest FROM content_version WHERE item_id = item AND status = 'approved' ORDER BY n DESC LIMIT 1;
  IF live IS DISTINCT FROM newest THEN
    RAISE EXCEPTION 'the live version of content_item % is not its newest approved version', item
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END
$fn$;
-- Two trigger functions, as plpgsql resolves NEW.item_id even in a branch not taken.
CREATE FUNCTION content_item_live_is_newest() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM content_item_check_live_is_newest(NEW.id);
  RETURN NULL;
END
$fn$;
CREATE FUNCTION content_version_live_is_newest() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM content_item_check_live_is_newest(NEW.item_id);
  RETURN NULL;
END
$fn$;
CREATE CONSTRAINT TRIGGER content_item_live_is_newest AFTER INSERT OR UPDATE OF live_version_id ON content_item
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION content_item_live_is_newest();
CREATE CONSTRAINT TRIGGER content_version_live_is_newest AFTER INSERT OR UPDATE OF status ON content_version
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION content_version_live_is_newest();

-- 2. A file's audience (and the version it belongs to) is frozen once that version is
--    approved: approval decided what the public may fetch, and a later change of
--    audience would publish a members file without one.
CREATE FUNCTION stored_file_frozen_once_approved() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.version_id IS NOT NULL
     AND (NEW.audience, NEW.version_id) IS DISTINCT FROM (OLD.audience, OLD.version_id)
     AND EXISTS (SELECT 1 FROM content_version WHERE id = OLD.version_id AND status IN ('approved', 'superseded')) THEN
    RAISE EXCEPTION 'stored_file %: its version is approved, so its audience is frozen', OLD.id
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER stored_file_frozen_once_approved BEFORE UPDATE OF audience, version_id ON stored_file
  FOR EACH ROW EXECUTE FUNCTION stored_file_frozen_once_approved();
