-- 0003_content.sql: editions, content items and their versions, files with an audience, and
-- the edition pins (R5, R11, R25, R26; addendum-publishing section 2).
--
-- An item belongs to an office, not a person. Each item has numbered versions. A version's
-- authored content freezes when it is marked ready (send back reopens it) and everything
-- freezes once it is approved (trigger below). Approval needs the derived public tree, so an
-- anonymous read never has to fall back to the members tree.

CREATE TABLE edition (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The period, never the printed Vol/No (R5): 2026-10, or 2026-10-xtra(-2).
  slug                text        NOT NULL UNIQUE CHECK (slug ~ '^[0-9]{4}-[0-9]{2}(-xtra(-[0-9]+)?)?$'),
  volume              integer     CHECK (volume > 0),
  issue_number        integer     CHECK (issue_number > 0),
  title               text        NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  kind                text        NOT NULL CHECK (kind IN ('regular', 'xtra')),
  period_start        date        NOT NULL,
  period_end          date        NOT NULL,
  submission_deadline date,
  status              text        NOT NULL DEFAULT 'planning'
                      CHECK (status IN ('planning', 'collecting', 'drafting', 'proof', 'published')),
  -- When the edition moved to proof and its items were pinned in edition_item.
  frozen_at           timestamptz,
  -- The hosted PDF: always the PUBLIC render. Foreign key added below, after stored_file.
  public_pdf_file_id  uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT edition_period_in_order CHECK (period_end >= period_start)
);

-- The calendar grids printed in the issue.
CREATE TABLE edition_calendar_range (
  edition_id uuid NOT NULL REFERENCES edition (id) ON DELETE CASCADE,
  starts_on  date NOT NULL,
  ends_on    date NOT NULL,
  PRIMARY KEY (edition_id, starts_on),
  CONSTRAINT edition_calendar_range_in_order CHECK (ends_on >= starts_on)
);

CREATE TABLE content_item (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug               text        NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,99}$'),
  kind               text        NOT NULL
                     CHECK (kind IN ('article', 'president_report', 'announcement', 'minutes',
                                     'treasurer_summary', 'document', 'page')),
  office_id          uuid        NOT NULL REFERENCES office (id),
  state              text        NOT NULL DEFAULT 'draft'
                     CHECK (state IN ('draft', 'ready', 'published', 'withdrawn')),
  -- What the public and members see. Foreign keys added below, after content_version.
  live_version_id    uuid,
  -- The draft or ready revision, if any.
  working_version_id uuid,
  withdrawn_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_item_withdrawn_at CHECK ((state = 'withdrawn') = (withdrawn_at IS NOT NULL)),
  CONSTRAINT content_item_published_has_live CHECK (state <> 'published' OR live_version_id IS NOT NULL)
);

CREATE TABLE content_version (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id           uuid        NOT NULL REFERENCES content_item (id),
  n                 integer     NOT NULL CHECK (n >= 1),
  status            text        NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'ready', 'approved', 'superseded', 'discarded')),
  -- Title and summary are always public (D-P5).
  title             text        NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  summary           text,
  visibility        text        NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'members', 'officers')),
  body_src          text        NOT NULL DEFAULT '',
  body_ast          jsonb       NOT NULL DEFAULT '{"blocks": []}'::jsonb,
  -- SHA-256 over the canonical tree, title, summary, visibility, targets, edition and file hashes.
  content_hash      bytea       CHECK (octet_length(content_hash) = 32),
  target_website    boolean     NOT NULL DEFAULT true,
  target_newsletter boolean     NOT NULL DEFAULT true,
  target_email      boolean     NOT NULL DEFAULT false,
  edition_id        uuid        REFERENCES edition (id),
  print_as_is       boolean     NOT NULL DEFAULT false,
  -- An external contributor's name and role, when an officer types for them.
  on_behalf_of      text,
  created_by_sub    text        NOT NULL,
  acting_office_id  uuid        NOT NULL REFERENCES office (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  ready_at          timestamptz,
  approved_at       timestamptz,
  approved_by_sub   text,
  approval_kind     text        CHECK (approval_kind IN ('normal', 'self_breakglass')),
  approval_reason   text,
  -- Derived at approval: every members node replaced by a placeholder with no content (R26).
  public_ast        jsonb,
  search_public     tsvector,
  search_members    tsvector,
  CONSTRAINT content_version_number_per_item UNIQUE (item_id, n),
  -- The target of the composite keys that tie a version to its own item.
  CONSTRAINT content_version_of_item UNIQUE (id, item_id),
  CONSTRAINT content_version_officers_not_distributed
    CHECK (visibility <> 'officers' OR (NOT target_newsletter AND NOT target_email)),
  CONSTRAINT content_version_hash_once_ready
    CHECK (status NOT IN ('ready', 'approved', 'superseded') OR content_hash IS NOT NULL),
  CONSTRAINT content_version_approval_recorded
    CHECK (status NOT IN ('approved', 'superseded')
           OR (approved_at IS NOT NULL AND approved_by_sub IS NOT NULL AND approval_kind IS NOT NULL
               AND public_ast IS NOT NULL)),
  CONSTRAINT content_version_breakglass_reason
    CHECK (approval_kind IS DISTINCT FROM 'self_breakglass' OR approval_reason IS NOT NULL)
);

ALTER TABLE content_item
  ADD CONSTRAINT content_item_live_version_of_item
    FOREIGN KEY (live_version_id, id) REFERENCES content_version (id, item_id),
  ADD CONSTRAINT content_item_working_version_of_item
    FOREIGN KEY (working_version_id, id) REFERENCES content_version (id, item_id);

-- A ready version keeps its authored content (targets and edition may still change, logged by
-- the API, before approval). Once approved, superseded or discarded, nothing but the status may
-- change. Raised for the owner too.
CREATE FUNCTION content_version_freeze() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
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

CREATE TRIGGER content_version_freeze BEFORE UPDATE ON content_version
  FOR EACH ROW EXECUTE FUNCTION content_version_freeze();

-- Who saved each version: the four-eyes check refuses an approval by any of them (D-P1).
CREATE TABLE content_version_editor (
  version_id uuid NOT NULL REFERENCES content_version (id),
  subject    text NOT NULL,
  PRIMARY KEY (version_id, subject)
);

CREATE TABLE stored_file (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Exactly one owner: a content version (attachments) or an edition (the issue PDF).
  version_id     uuid        REFERENCES content_version (id),
  edition_id     uuid        REFERENCES edition (id),
  object_key     text        NOT NULL UNIQUE,
  filename       text        NOT NULL CHECK (length(filename) BETWEEN 1 AND 200),
  mime_type      text        NOT NULL
                 CHECK (mime_type IN ('application/pdf',
                                      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                                      'image/jpeg', 'image/png', 'image/webp', 'image/gif')),
  size_bytes     bigint      NOT NULL CHECK (size_bytes > 0),
  sha256         bytea       NOT NULL CHECK (octet_length(sha256) = 32),
  audience       text        NOT NULL CHECK (audience IN ('public', 'members', 'officers')),
  role           text        NOT NULL DEFAULT 'primary' CHECK (role IN ('primary', 'public_copy', 'source')),
  public_copy_of uuid        REFERENCES stored_file (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stored_file_one_owner CHECK (num_nonnulls(version_id, edition_id) = 1),
  -- R11: officer attachments up to 10 MiB each.
  CONSTRAINT stored_file_attachment_size CHECK (version_id IS NULL OR size_bytes <= 10485760),
  -- A Word file carries tracked changes, comments and author metadata: never served publicly.
  CONSTRAINT stored_file_docx_officers_only
    CHECK (mime_type <> 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
           OR audience = 'officers'),
  CONSTRAINT stored_file_source_officers_only CHECK (role <> 'source' OR audience = 'officers'),
  CONSTRAINT stored_file_public_copy_paired CHECK ((role = 'public_copy') = (public_copy_of IS NOT NULL)),
  CONSTRAINT stored_file_public_copy_is_public CHECK (role <> 'public_copy' OR audience = 'public')
);

ALTER TABLE edition
  ADD CONSTRAINT edition_public_pdf FOREIGN KEY (public_pdf_file_id) REFERENCES stored_file (id);

-- Written when an edition moves to proof: the exact version of each item that is printed.
CREATE TABLE edition_item (
  edition_id uuid        NOT NULL REFERENCES edition (id),
  item_id    uuid        NOT NULL REFERENCES content_item (id),
  version_id uuid        NOT NULL,
  pinned_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (edition_id, item_id),
  CONSTRAINT edition_item_version_of_item FOREIGN KEY (version_id, item_id) REFERENCES content_version (id, item_id)
);
