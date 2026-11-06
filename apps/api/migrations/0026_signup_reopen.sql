-- 0026_signup_reopen.sql: REOPEN. The Admin or the Membership Officer reopens a rejected sign-up,
-- so a mistaken rejection can be fixed and the person can sign up again (MembershipService
-- ReopenSignup; who may is the handler's check, src/auth/roles.ts requireSignupReopener).
--
-- Nothing erased comes back and the history stays: the rejected row keeps its decision, decider,
-- time and erased inputs (0009), and is marked reopened by whom and when; audit_event gets the
-- reopening as a row of its own. The account the rejection closed (removed, never approved,
-- granted or checked) is deleted, so the person reads as one who never signed up. No sign-up row
-- is ever deleted (5).

-- 1. Who reopened a rejected sign-up, and when: both or neither, and only on a rejection.
ALTER TABLE signup_request
  ADD COLUMN reopened_at timestamptz,
  ADD COLUMN reopened_by_sub text CHECK (length(reopened_by_sub) BETWEEN 1 AND 255),
  ADD CONSTRAINT signup_request_reopen_recorded CHECK ((reopened_at IS NULL) = (reopened_by_sub IS NULL)),
  ADD CONSTRAINT signup_request_reopen_only_rejected CHECK (reopened_at IS NULL OR decision = 'rejected');

COMMENT ON COLUMN signup_request.reopened_by_sub IS 'REOPEN: the Admin or Membership Officer who reopened this rejected sign-up; the row is then final.';

-- 2. One open sign-up per person: the subject is unique among the rows not reopened, so a reopened
--    one leaves room for exactly one more. The sign-up call's ON CONFLICT names this predicate.
ALTER TABLE signup_request DROP CONSTRAINT signup_request_sub_key;
CREATE UNIQUE INDEX signup_request_one_open_per_sub ON signup_request (sub) WHERE reopened_at IS NULL;

-- 3. 0009's rule and 0019's search_path, plus: a reopened sign-up never changes again, so it is
--    never reopened twice, never un-reopened and never edited. Reopening itself sets only the two
--    new columns, which the decided rule does not list.
CREATE OR REPLACE FUNCTION signup_request_decision_final() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF OLD.reopened_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'signup_request % is reopened', OLD.id USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF OLD.decision <> 'pending'
     AND (NEW.decision, NEW.decided_at, NEW.decided_by_sub, NEW.membership_number, NEW.last_name)
         IS DISTINCT FROM (OLD.decision, OLD.decided_at, OLD.decided_by_sub, OLD.membership_number, OLD.last_name) THEN
    RAISE EXCEPTION 'signup_request % is decided', OLD.id USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END
$fn$;

-- 4. An account row is deleted only as a reopening deletes it: a rejection's closed account
--    (removed, and never approved, granted affiliate standing or checked), whose sign-up was
--    reopened, with no newer sign-up open. Every other account keeps its row.
CREATE FUNCTION member_account_delete_only_reopened() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF OLD.status <> 'removed' OR OLD.verified_on IS NOT NULL OR OLD.approved_by_sub IS NOT NULL OR OLD.affiliate_granted_by_sub IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM signup_request WHERE sub = OLD.sub AND reopened_at IS NOT NULL)
     OR EXISTS (SELECT 1 FROM signup_request WHERE sub = OLD.sub AND reopened_at IS NULL) THEN
    RAISE EXCEPTION 'member_account %: only a rejection''s closed account is deleted, once its sign-up is reopened', OLD.sub
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN OLD;
END
$fn$;
CREATE TRIGGER member_account_delete_only_reopened BEFORE DELETE ON member_account
  FOR EACH ROW EXECUTE FUNCTION member_account_delete_only_reopened();
REVOKE EXECUTE ON FUNCTION member_account_delete_only_reopened() FROM PUBLIC;

-- 5. A sign-up row is never deleted, so the rejection a reopening rests on (and the account delete
--    rule above reads) stays. The app role loses the DELETE that 0000's defaults gave it: no code
--    deletes a sign-up. Defence in depth against a future grant: a trigger refuses deleting a
--    decided row for every role, the owner included. A pending row stays deletable by the owner.
REVOKE DELETE ON signup_request FROM nwfl;
CREATE FUNCTION signup_request_keep_decided() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF OLD.decision <> 'pending' THEN
    RAISE EXCEPTION 'signup_request % is decided and is kept', OLD.id USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN OLD;
END
$fn$;
CREATE TRIGGER signup_request_keep_decided BEFORE DELETE ON signup_request
  FOR EACH ROW EXECUTE FUNCTION signup_request_keep_decided();
REVOKE EXECUTE ON FUNCTION signup_request_keep_decided() FROM PUBLIC;
