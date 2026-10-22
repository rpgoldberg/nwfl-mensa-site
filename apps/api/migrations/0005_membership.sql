-- 0005_membership.sql: member accounts and the sign-up queue (R24, R33).
--
-- Only what the member typed is stored, plus the account's state: never a member number past
-- verification, an address, a phone, a birthday or any National status, and no free-text notes.
-- Name and email live in Authentik and arrive in the token; the sign-up row keeps the copy the
-- approver needs until the request is decided.

CREATE TABLE member_account (
  -- The Authentik subject.
  sub                      text        PRIMARY KEY CHECK (length(sub) BETWEEN 1 AND 255),
  status                   text        NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'member', 'affiliate', 'lapsed', 'removed')),
  route                    text        NOT NULL CHECK (route IN ('invite', 'signup', 'admin_grant')),
  -- The approver: an officer, or the verifier's identity for a local-group match.
  approved_by_sub          text,
  approved_at              timestamptz,
  -- The last check against the roster; 13 months without one falls back to public (A5).
  verified_on              date,
  -- Affiliate is member-level reading for an affiliated officer (the RVC). Only an Admin or
  -- Webmaster grant sets it, never a verification.
  affiliate_granted_by_sub text,
  affiliate_granted_at     timestamptz,
  removed_at               timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT member_account_member_was_approved
    CHECK (status <> 'member' OR (approved_by_sub IS NOT NULL AND approved_at IS NOT NULL AND verified_on IS NOT NULL)),
  CONSTRAINT member_account_affiliate_by_grant
    CHECK (status <> 'affiliate' OR (affiliate_granted_by_sub IS NOT NULL AND affiliate_granted_at IS NOT NULL)),
  CONSTRAINT member_account_removed_at CHECK ((status = 'removed') = (removed_at IS NOT NULL))
);

CREATE TABLE signup_request (
  -- The request id the verifier and the approver see.
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  sub               text        NOT NULL UNIQUE CHECK (length(sub) BETWEEN 1 AND 255),
  display_name      text        NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  -- Typed by the member for the verifier's match; erased with the number.
  last_name         text        CHECK (length(last_name) BETWEEN 1 AND 80),
  -- As the member typed it.
  email             text        NOT NULL CHECK (length(email) <= 254 AND email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  -- Typed by the member, never National-sourced. Read only by ListPendingVerifications.
  membership_number text        CHECK (membership_number ~ '^[0-9]{1,12}$'),
  verification      text        NOT NULL DEFAULT 'unchecked'
                    CHECK (verification IN ('unchecked', 'verified_local', 'verified_other_group', 'not_found', 'error')),
  verified_on       date,
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- The verifier's inputs exist only while the row is unchecked: reporting an outcome
  -- must erase them in the same statement.
  CONSTRAINT signup_request_number_erased_once_checked
    CHECK (membership_number IS NULL OR verification = 'unchecked'),
  CONSTRAINT signup_request_last_name_erased_once_checked
    CHECK (last_name IS NULL OR verification = 'unchecked'),
  CONSTRAINT signup_request_number_needs_last_name
    CHECK (membership_number IS NULL OR last_name IS NOT NULL),
  CONSTRAINT signup_request_verified_on
    CHECK ((verification = 'unchecked') = (verified_on IS NULL))
);

-- ListPendingVerifications: oldest first, only rows the verifier can act on.
CREATE INDEX signup_request_pending ON signup_request (created_at)
  WHERE verification = 'unchecked' AND membership_number IS NOT NULL;
