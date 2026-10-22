-- 0004_audit.sql: the append-only audit log (R25, P18).
--
-- Append-only twice over: the app role holds INSERT and SELECT only (the UPDATE and DELETE the
-- 0000 defaults gave it are revoked here, and TRUNCATE was never granted), and a trigger refuses
-- UPDATE, DELETE and TRUNCATE for every role, the owner included.
--
-- Bodies never go here (R15). Two CHECKs keep membership data out as well: the payload may not
-- carry a membership_number key at any depth (R33), and a membership record gets no free-text
-- note (R24: the approval screens have none).

CREATE TABLE audit_event (
  id               bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at               timestamptz NOT NULL DEFAULT now(),
  trace_id         text        CHECK (trace_id ~ '^[0-9a-f]{32}$'),
  actor_kind       text        NOT NULL CHECK (actor_kind IN ('user', 'agent', 'verifier', 'system')),
  actor_sub        text,
  -- "Posting as": the office the actor acted for.
  acting_office_id uuid        REFERENCES office (id),
  -- The actor's nwfl- groups as they were at the time.
  actor_groups     text[]      NOT NULL DEFAULT '{}',
  -- create, save, ready, send_back, approve, approve_self, withdraw, restore, targets_changed,
  -- edition_changed, file_added, file_removed, export_read, and the event, roster and
  -- membership actions the handlers add.
  action           text        NOT NULL CHECK (action ~ '^[a-z][a-z_]{1,40}$'),
  subject_kind     text        NOT NULL
                   CHECK (subject_kind IN ('content_item', 'content_version', 'stored_file', 'edition',
                                           'event_series', 'event_occurrence', 'venue', 'office', 'office_term',
                                           'member_account', 'signup_request')),
  subject_id       text        NOT NULL,
  item_id          uuid,
  version_id       uuid,
  content_hash     bytea       CHECK (octet_length(content_hash) = 32),
  from_state       text,
  to_state         text,
  -- A send-back note and the like. Never on a membership record.
  note             text,
  payload          jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT audit_event_no_membership_number
    CHECK (NOT jsonb_path_exists(payload, 'lax $.**.membership_number')),
  CONSTRAINT audit_event_no_note_on_membership
    CHECK (note IS NULL OR subject_kind NOT IN ('member_account', 'signup_request'))
);

CREATE INDEX audit_event_subject ON audit_event (subject_kind, subject_id, at);

REVOKE UPDATE, DELETE ON audit_event FROM nwfl;

CREATE FUNCTION audit_event_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  -- Its own SQLSTATE (P0001), not 42501, so a test can tell the trigger from the grant.
  RAISE EXCEPTION 'audit_event is append-only: % refused', TG_OP;
END
$fn$;

CREATE TRIGGER audit_event_no_update_or_delete BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_event_append_only();

CREATE TRIGGER audit_event_no_truncate BEFORE TRUNCATE ON audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION audit_event_append_only();
