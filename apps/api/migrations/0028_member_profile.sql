-- 0028_member_profile.sql: PROFILE-ID (Ross, 2026-11-08). What a person typed at sign-up is kept.
--
-- The approvers cannot judge a sign-up without seeing what it typed, and those values belong to the
-- member's profile. This reverses the erasure of 0005, 0007 and 0009 (R33, A5): the membership
-- number, the last name and (new) the first name stay on the sign-up row in every state, pending,
-- checked, approved, rejected and reopened. They are self-typed, never National-sourced. The approved
-- sign-up IS the member's profile: there is no copy anywhere else, so deleting a sign-up deletes them.
--
--   1. The three erasure rules go, and so does the trigger that held an account back from member
--      until its sign-up was erased.
--   2. first_name: as typed, 1 to 80 characters, no control character. Empty on a row from before.
--   3. The decided rule (0009, 0026), plus: the number never changes once stored, in any state and for
--      every role, the owner included (it has no edit path); the two names change only on an approved
--      sign-up, the member's own profile. A pending, rejected or reopened row keeps what was typed.
-- Unchanged: the audit rules (0007, 0009: no number or last name in any audit payload, and no payload
-- at all on a membership record), the verifier's contract and its pending index, and 0026's delete
-- rules.

-- 1. No erasure.
ALTER TABLE signup_request
  DROP CONSTRAINT signup_request_number_erased_once_checked,
  DROP CONSTRAINT signup_request_last_name_erased_once_checked,
  DROP CONSTRAINT signup_request_inputs_erased_on_decision;
DROP TRIGGER member_account_signup_erased ON member_account;
DROP FUNCTION member_account_signup_erased();

-- 2. The first name.
ALTER TABLE signup_request
  ADD COLUMN first_name text CHECK (length(first_name) BETWEEN 1 AND 80 AND first_name !~ '[[:cntrl:]]');

COMMENT ON COLUMN signup_request.first_name IS 'PROFILE-ID: as the member typed it; the member may change it once approved. Shown to the approvers and the owner.';
COMMENT ON COLUMN signup_request.last_name IS 'PROFILE-ID: as the member typed it, kept; the member may change it once approved. Shown to the verifier, the approvers and the owner; never in an audit payload.';
COMMENT ON COLUMN signup_request.membership_number IS 'PROFILE-ID: as the member typed it, digits only, kept and never changed. Shown to the verifier, the approvers and the owner; never in an audit payload or a log.';

-- 3. What may change, and when.
CREATE OR REPLACE FUNCTION signup_request_decision_final() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF OLD.reopened_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'signup_request % is reopened', OLD.id USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NEW.membership_number IS DISTINCT FROM OLD.membership_number THEN
    RAISE EXCEPTION 'signup_request %: a membership number is never changed', OLD.id USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF (NEW.first_name, NEW.last_name) IS DISTINCT FROM (OLD.first_name, OLD.last_name) AND OLD.decision <> 'approved' THEN
    RAISE EXCEPTION 'signup_request %: only an approved sign-up''s names change', OLD.id USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF OLD.decision <> 'pending'
     AND (NEW.decision, NEW.decided_at, NEW.decided_by_sub) IS DISTINCT FROM (OLD.decision, OLD.decided_at, OLD.decided_by_sub) THEN
    RAISE EXCEPTION 'signup_request % is decided', OLD.id USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END
$fn$;
