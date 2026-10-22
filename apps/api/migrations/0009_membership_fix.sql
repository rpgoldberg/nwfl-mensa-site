-- 0009_membership_fix.sql: the stack challenge's findings on the membership records
-- (STACK-FIX, fix-forward).

-- 1. A membership record's audit row carries no payload at all. A key denylist
--    (audit_event_no_membership_inputs) cannot list every spelling: family_name,
--    surname, mensa_number, member_id, a JSON string holding JSON and name/value
--    pairs all passed it. The note column is already refused here (0004).
ALTER TABLE audit_event ADD CONSTRAINT audit_event_no_payload_on_membership
  CHECK (payload = '{}'::jsonb OR subject_kind NOT IN ('member_account', 'signup_request'));

-- 2. A sign-up decision is final: pending -> approved | rejected once, and a decided
--    row keeps its decision, decider, time and erased inputs. Otherwise a decided row
--    could be reopened with a number stored again, or flip with a new decider.
CREATE FUNCTION signup_request_decision_final() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.decision <> 'pending'
     AND (NEW.decision, NEW.decided_at, NEW.decided_by_sub, NEW.membership_number, NEW.last_name)
         IS DISTINCT FROM (OLD.decision, OLD.decided_at, OLD.decided_by_sub, OLD.membership_number, OLD.last_name) THEN
    RAISE EXCEPTION 'signup_request % is decided', OLD.id USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER signup_request_decision_final BEFORE UPDATE ON signup_request
  FOR EACH ROW EXECUTE FUNCTION signup_request_decision_final();

-- 3. An account becomes a member only once its sign-up no longer holds the verifier's
--    inputs, so approving the account cannot leave the number behind.
CREATE FUNCTION member_account_signup_erased() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.status = 'member' AND EXISTS (
       SELECT 1 FROM signup_request WHERE sub = NEW.sub AND (membership_number IS NOT NULL OR last_name IS NOT NULL)) THEN
    RAISE EXCEPTION 'decide the sign-up (erasing its number) before the account becomes a member'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER member_account_signup_erased BEFORE INSERT OR UPDATE OF status ON member_account
  FOR EACH ROW EXECUTE FUNCTION member_account_signup_erased();

-- 4. A verification date is never in the future: standing counts 13 months from it, so a
--    future date would stretch a member's or an affiliate's standing (STACK-FIX ruling:
--    affiliates lapse like members). current_date only moves forward, so a row that
--    passes now passes on every later check, a restore included.
ALTER TABLE member_account ADD CONSTRAINT member_account_verified_on_not_future
  CHECK (verified_on IS NULL OR verified_on <= current_date);
ALTER TABLE signup_request ADD CONSTRAINT signup_request_verified_on_not_future
  CHECK (verified_on IS NULL OR verified_on <= current_date);
