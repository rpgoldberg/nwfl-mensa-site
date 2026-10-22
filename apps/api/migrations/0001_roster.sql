-- 0001_roster.sql: offices (seats) and the terms that fill them (R2).
--
-- A seat is a row whether or not anyone holds it; a vacancy is a term with no holder. Holders
-- are display names only: no personal email or phone. Contact goes through the office's role
-- alias at nwflorida.us, shown only once a test message to it has been delivered.

CREATE TABLE office (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                   text        NOT NULL UNIQUE CHECK (slug ~ '^[a-z][a-z0-9-]{1,40}$'),
  title                  text        NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  kind                   text        NOT NULL
                         CHECK (kind IN ('elected', 'appointed', 'ex_officio', 'committee', 'regional_external')),
  sort_order             integer     NOT NULL DEFAULT 0,
  role_alias             text        CHECK (role_alias ~ '^[a-z0-9][a-z0-9.-]*@nwflorida\.us$'),
  role_alias_verified_on date,
  active                 boolean     NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT office_alias_verified_needs_alias CHECK (role_alias_verified_on IS NULL OR role_alias IS NOT NULL)
);

COMMENT ON COLUMN office.slug IS 'The Authentik group for its holders is nwfl-office-<slug>.';
COMMENT ON COLUMN office.role_alias IS 'A role alias at nwflorida.us. Never a personal address.';

CREATE TABLE office_term (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  office_id           uuid        NOT NULL REFERENCES office (id),
  holder_display_name text        CHECK (length(holder_display_name) BETWEEN 1 AND 120),
  starts_on           date        NOT NULL,
  ends_on             date,
  status              text        NOT NULL CHECK (status IN ('active', 'acting', 'vacant')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT office_term_holder_unless_vacant CHECK ((status = 'vacant') = (holder_display_name IS NULL)),
  CONSTRAINT office_term_ends_after_start CHECK (ends_on IS NULL OR ends_on >= starts_on)
);

CREATE INDEX office_term_office ON office_term (office_id, starts_on);
