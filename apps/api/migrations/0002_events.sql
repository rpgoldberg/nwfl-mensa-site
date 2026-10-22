-- 0002_events.sql: venues, recurring series and dated occurrences (R3).
--
-- A member's home is stored as its area and its host office only: the street address is never
-- stored (CHECK below), so no read path can leak one. Visibility is public or members; a
-- members event read without a member token comes back with its details withheld (the API's
-- job, A4a). Events are live on save, outside the approval queue (P19).

CREATE TABLE venue (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind               text        NOT NULL CHECK (kind IN ('business', 'member_home', 'virtual')),
  name               text        NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  business_address   text        CHECK (length(business_address) BETWEEN 1 AND 200),
  city               text        CHECK (length(city) BETWEEN 1 AND 80),
  area               text        NOT NULL
                     CHECK (area IN ('okaloosa', 'walton', 'bay', 'escambia_santa_rosa', 'virtual', 'elsewhere')),
  host_office_id     uuid        REFERENCES office (id),
  url                text        CHECK (url ~ '^https://'),
  accessibility_note text,
  active             boolean     NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT venue_address_only_for_a_business CHECK (kind = 'business' OR business_address IS NULL),
  CONSTRAINT venue_member_home_has_host_office CHECK (kind <> 'member_home' OR host_office_id IS NOT NULL),
  CONSTRAINT venue_member_home_has_no_url CHECK (kind <> 'member_home' OR url IS NULL)
);

CREATE TABLE event_series (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                     text        NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,60}$'),
  title                    text        NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  category                 text        NOT NULL
                           CHECK (category IN ('lunch', 'dinner', 'happy_hour', 'excomm', 'picnic', 'party',
                                               'regional', 'national', 'virtual', 'other')),
  -- An RFC 5545 RRULE, such as FREQ=MONTHLY;BYDAY=2FR. Expanded by the API, not here.
  recurrence               text        NOT NULL
                           CHECK (recurrence ~ '^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;[A-Z]+=[A-Z0-9,+-]+)*$'),
  cadence_label            text,
  default_start            time,
  default_duration_minutes integer     CHECK (default_duration_minutes BETWEEN 1 AND 1440),
  -- NULL: the venue rotates.
  default_venue_id         uuid        REFERENCES venue (id),
  area                     text        NOT NULL
                           CHECK (area IN ('okaloosa', 'walton', 'bay', 'escambia_santa_rosa', 'virtual', 'elsewhere')),
  host_office_id           uuid        REFERENCES office (id),
  description              text,
  visibility               text        NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'members')),
  active                   boolean     NOT NULL DEFAULT true,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE event_occurrence (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL for a one-off event, which then needs its own title.
  series_id   uuid        REFERENCES event_series (id),
  title       text        CHECK (length(title) BETWEEN 1 AND 120),
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz,
  -- NULL while the venue is to be decided.
  venue_id    uuid        REFERENCES venue (id),
  status      text        NOT NULL DEFAULT 'scheduled'
              CHECK (status IN ('scheduled', 'tentative', 'cancelled', 'moved')),
  status_note text,
  detail      text,
  url         text        CHECK (url ~ '^https://'),
  visibility  text        NOT NULL CHECK (visibility IN ('public', 'members')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_occurrence_one_off_has_title CHECK (series_id IS NOT NULL OR title IS NOT NULL),
  CONSTRAINT event_occurrence_ends_after_start CHECK (ends_at IS NULL OR ends_at > starts_at),
  CONSTRAINT event_occurrence_once_per_series_start UNIQUE (series_id, starts_at)
);

CREATE INDEX event_occurrence_starts_at ON event_occurrence (starts_at);
