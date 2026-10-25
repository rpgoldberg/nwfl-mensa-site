-- 0012_redaction_policy.sql: the per-group redaction policy (REDACT R1).
--
-- Nothing before this file is scoped to a group: the schema is this group's alone, and the token
-- carries only nwfl- groups. So the tenant key is minimal: one tenant row, 'nwflorida' (the name
-- National uses for this group's folder), and a tenant_id that defaults to it. No other table
-- gains one, and no caller can choose a tenant.
--
-- A policy cell is audience x category -> action. Text categories are shown, redacted or hidden;
-- an image is shown, blurred or hidden, whole. HIDE is the strictest for both, and the server
-- reads a missing cell as HIDE.
--
-- redaction_change keeps every change. A change that loosens the public audience waits for a
-- second, different officer; two CHECKs hold that here as well as in the handler. Strictness
-- ranks: show 0, redact and blur 1, hide 2 (no category allows both redact and blur).
--
-- The app role may not delete a cell or a change, and only reads the tenant list.

CREATE TABLE tenant (
  id   text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]{1,40}$'),
  name text NOT NULL CHECK (name <> '')
);

INSERT INTO tenant (id, name) VALUES ('nwflorida', 'Northwest Florida Mensa');

REVOKE INSERT, UPDATE, DELETE ON tenant FROM nwfl;

CREATE FUNCTION redaction_action_allowed(category text, action text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT AS $fn$
  SELECT CASE WHEN category = 'image' THEN action IN ('show', 'blur', 'hide') ELSE action IN ('show', 'redact', 'hide') END
$fn$;

CREATE FUNCTION redaction_rank(action text) RETURNS integer
  LANGUAGE sql IMMUTABLE STRICT AS $fn$
  SELECT CASE action WHEN 'show' THEN 0 WHEN 'redact' THEN 1 WHEN 'blur' THEN 1 ELSE 2 END
$fn$;

CREATE TABLE redaction_policy (
  tenant_id      text        NOT NULL DEFAULT 'nwflorida' REFERENCES tenant (id),
  audience       text        NOT NULL CHECK (audience IN ('public', 'members', 'officers')),
  category       text        NOT NULL
                 CHECK (category IN ('member_name', 'member_address', 'member_phone', 'member_email',
                                     'private_venue', 'business_venue', 'officer_contact', 'image')),
  action         text        NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- NULL for the seeded defaults.
  updated_by_sub text,
  PRIMARY KEY (tenant_id, audience, category),
  CONSTRAINT redaction_policy_action_allowed CHECK (redaction_action_allowed(category, action))
);

REVOKE DELETE ON redaction_policy FROM nwfl;

CREATE TABLE redaction_change (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text        NOT NULL DEFAULT 'nwflorida' REFERENCES tenant (id),
  audience        text        NOT NULL CHECK (audience IN ('public', 'members', 'officers')),
  category        text        NOT NULL
                  CHECK (category IN ('member_name', 'member_address', 'member_phone', 'member_email',
                                      'private_venue', 'business_venue', 'officer_contact', 'image')),
  from_action     text        NOT NULL,
  to_action       text        NOT NULL,
  status          text        NOT NULL CHECK (status IN ('pending', 'applied', 'superseded')),
  proposed_by_sub text        NOT NULL CHECK (proposed_by_sub <> ''),
  proposed_at     timestamptz NOT NULL DEFAULT now(),
  approved_by_sub text,
  approved_at     timestamptz,
  decided_at      timestamptz,
  CONSTRAINT redaction_change_actions_allowed
    CHECK (redaction_action_allowed(category, from_action) AND redaction_action_allowed(category, to_action)
           AND from_action <> to_action),
  CONSTRAINT redaction_change_approval_dated CHECK ((approved_by_sub IS NULL) = (approved_at IS NULL)),
  -- Four-eyes: no one approves their own change, and an applied loosening of the public audience
  -- names a second officer.
  CONSTRAINT redaction_change_not_self_approved CHECK (approved_by_sub IS NULL OR approved_by_sub <> proposed_by_sub),
  CONSTRAINT redaction_change_public_loosening_approved
    CHECK (status <> 'applied' OR audience <> 'public' OR redaction_rank(to_action) > redaction_rank(from_action)
           OR approved_by_sub IS NOT NULL)
);

-- One waiting change per cell.
CREATE UNIQUE INDEX redaction_change_one_pending ON redaction_change (tenant_id, audience, category)
  WHERE status = 'pending';

REVOKE DELETE ON redaction_change FROM nwfl;

-- The defaults (D5 b, NL-PII a): the public sees no member's contact details or home venue, sees
-- business venues, and sees photos only blurred. Members see contact details but not a member's
-- home address outside a venue; officers see everything. Office titles are not a category: they
-- always show.
INSERT INTO redaction_policy (audience, category, action) VALUES
  ('public',   'member_name',     'redact'),
  ('public',   'member_address',  'redact'),
  ('public',   'member_phone',    'redact'),
  ('public',   'member_email',    'redact'),
  ('public',   'private_venue',   'redact'),
  ('public',   'business_venue',  'show'),
  ('public',   'officer_contact', 'redact'),
  ('public',   'image',           'blur'),
  ('members',  'member_name',     'show'),
  ('members',  'member_address',  'redact'),
  ('members',  'member_phone',    'show'),
  ('members',  'member_email',    'show'),
  ('members',  'private_venue',   'show'),
  ('members',  'business_venue',  'show'),
  ('members',  'officer_contact', 'show'),
  ('members',  'image',           'show'),
  ('officers', 'member_name',     'show'),
  ('officers', 'member_address',  'show'),
  ('officers', 'member_phone',    'show'),
  ('officers', 'member_email',    'show'),
  ('officers', 'private_venue',   'show'),
  ('officers', 'business_venue',  'show'),
  ('officers', 'officer_contact', 'show'),
  ('officers', 'image',           'show');

-- The audit log learns the two new subjects.
ALTER TABLE audit_event DROP CONSTRAINT audit_event_subject_kind_check;
ALTER TABLE audit_event ADD CONSTRAINT audit_event_subject_kind_check
  CHECK (subject_kind IN ('content_item', 'content_version', 'stored_file', 'edition',
                          'event_series', 'event_occurrence', 'venue', 'office', 'office_term',
                          'member_account', 'signup_request', 'redaction_policy', 'redaction_change'));
