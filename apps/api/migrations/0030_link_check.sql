-- 0030_link_check.sql: the link gate's answers (EDITOR A3b).
--
-- content_link_check holds, per link of a piece, a reviewer's answer ("it shows the right page":
-- yes or no) and, from L-ITEM on, the machine checker's verdict (ok, confirm, drop). Approve reads
-- the latest answer per URL: a login-walled link needs a reviewer's yes on the version as it stands.
--
--   * A human answer names its version and the version's ready time when it was given
--     (ready_at_seen). Any edit sends the version back to draft and a new "mark ready" sets a new
--     ready time, so earlier answers stop counting by themselves; a change of targets or edition at
--     Approve keeps the ready time, so it keeps the answers.
--   * A trigger holds what the API checks: a human answer is for a READY version, carries its
--     ready time as it stands, and comes from someone who did not edit that version.
--   * A machine verdict names the URL only, never a version: it is about the address.
--   * Append-only twice over, as audit_event (0004, 0007): the app role holds SELECT and INSERT on
--     the named columns only (never id or at, which the database writes), and a trigger refuses
--     UPDATE, DELETE and TRUNCATE for every role, the owner included.
--
-- ADDITIVE. The API before A3b never reads or writes this table, so it runs unchanged on 0030.
--
-- AUDIT-IDX: the audit log gets an index by item (the officer reads look up an item's last change).

CREATE TABLE content_link_check (
  id               bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id          uuid        NOT NULL REFERENCES content_item (id),
  -- Human answers only: the version answered.
  version_id       uuid,
  url              text        NOT NULL CHECK (length(url) BETWEEN 1 AND 2048),
  source           text        NOT NULL CHECK (source IN ('human', 'machine')),
  answer           text        NOT NULL,
  note             text        CHECK (length(note) <= 2000),
  -- The machine's reasons (L-ITEM), a list.
  reasons          jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(reasons) = 'array'),
  -- Human answers only: the version's ready_at when it was answered.
  ready_at_seen    timestamptz,
  -- Human answers only: the hash of the link list the reviewer saw.
  links_sha256     bytea       CHECK (octet_length(links_sha256) = 32),
  by_sub           text        NOT NULL CHECK (by_sub <> ''),
  -- The answerer's nwfl- groups as they were, as audit_event's actor_groups: the history label
  -- ("Webmaster", "Admin") is read from them (content/actor-label.ts).
  by_groups        text[]      NOT NULL DEFAULT '{}',
  -- The office the reviewer acted for (S6).
  acting_office_id uuid        REFERENCES office (id),
  at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_link_check_version_of_item FOREIGN KEY (version_id, item_id) REFERENCES content_version (id, item_id),
  CONSTRAINT content_link_check_human CHECK (
    source <> 'human' OR (answer IN ('yes', 'no') AND version_id IS NOT NULL AND ready_at_seen IS NOT NULL AND links_sha256 IS NOT NULL)),
  CONSTRAINT content_link_check_machine CHECK (
    source <> 'machine' OR (answer IN ('ok', 'confirm', 'drop') AND version_id IS NULL AND ready_at_seen IS NULL AND acting_office_id IS NULL))
);

-- The gate's read: a version's answers by URL, latest last.
CREATE INDEX content_link_check_version ON content_link_check (version_id, url, id);

REVOKE INSERT, UPDATE, DELETE ON content_link_check FROM nwfl;
GRANT INSERT (item_id, version_id, url, source, answer, note, reasons, ready_at_seen, links_sha256, by_sub, by_groups, acting_office_id)
  ON content_link_check TO nwfl;

CREATE FUNCTION content_link_check_append_only() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  -- P0001, as audit_event's: a test tells the trigger from the grant (42501).
  RAISE EXCEPTION 'content_link_check is append-only: % refused', TG_OP;
END
$fn$;

CREATE TRIGGER content_link_check_no_update_or_delete BEFORE UPDATE OR DELETE ON content_link_check
  FOR EACH ROW EXECUTE FUNCTION content_link_check_append_only();

CREATE TRIGGER content_link_check_no_truncate BEFORE TRUNCATE ON content_link_check
  FOR EACH STATEMENT EXECUTE FUNCTION content_link_check_append_only();

-- A human answer: for a ready version, at its ready time as it stands, from someone who did not edit it.
CREATE FUNCTION content_link_check_human_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_status   text;
  v_ready_at timestamptz;
BEGIN
  -- A human answer with no version is the CHECK's to refuse.
  IF NEW.source <> 'human' OR NEW.version_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT status, ready_at INTO v_status, v_ready_at FROM content_version WHERE id = NEW.version_id;
  IF v_status IS DISTINCT FROM 'ready' THEN
    RAISE EXCEPTION 'only a ready version''s links are answered (this one is %)', coalesce(v_status, 'missing');
  END IF;
  IF NEW.ready_at_seen IS DISTINCT FROM v_ready_at THEN
    RAISE EXCEPTION 'the answer is not for the version''s ready time as it stands';
  END IF;
  IF EXISTS (SELECT 1 FROM content_version_editor WHERE version_id = NEW.version_id AND subject = NEW.by_sub) THEN
    RAISE EXCEPTION 'whoever edited this version cannot answer for its links';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER content_link_check_human_guard BEFORE INSERT ON content_link_check
  FOR EACH ROW EXECUTE FUNCTION content_link_check_human_guard();

-- Trigger functions only: nobody calls them (0019's rule, kept explicit).
REVOKE EXECUTE ON FUNCTION content_link_check_append_only(), content_link_check_human_guard() FROM PUBLIC;

-- AUDIT-IDX.
CREATE INDEX audit_event_item ON audit_event (item_id);
