-- 0027_signup_vetting.sql: VET (a). The sign-up vetting that stops someone using another member's
-- name and number. nwfl-verifier, on the home box, matches each sign-up against the offline roster
-- there; the roster never reaches this database. What it reports is stored here, and so is every
-- release of a claim, for it to pull (MembershipVerifierService ListReleasedClaims).
--
--   1. Two more stored outcomes: email_mismatch (number and last name match a local member, the email
--      does not) and duplicate_claim (the verifier's ledger says another sign-up claimed the number).
--      Neither approves nor rejects; reporting still erases the number and the last name (0005).
--   2. A duplicate claim may name the earlier sign-up: an existing one, never itself.
--   3. signup_claim_release: one row per released claim, written by triggers in the same transaction
--      as the rejection, the reopening, or the removal or deletion of an approved sign-up's account.
--      Append-only for every role, the owner included. Its cursor (seq) is taken by one writer at a
--      time, held to commit, so cursors become visible in order and a reader never misses one.
--      Sign-up ids, kinds and times only: never a number, a name or an email.

-- 1. The stored outcome.
ALTER TABLE signup_request DROP CONSTRAINT signup_request_verification_check;
ALTER TABLE signup_request ADD CONSTRAINT signup_request_verification_check
  CHECK (verification IN ('unchecked', 'verified_local', 'verified_other_group', 'not_found', 'error', 'email_mismatch', 'duplicate_claim'));

-- 2. The earlier claim a duplicate names.
ALTER TABLE signup_request
  ADD COLUMN conflicting_request_id uuid REFERENCES signup_request (id),
  ADD CONSTRAINT signup_request_conflict_only_duplicate CHECK (conflicting_request_id IS NULL OR verification = 'duplicate_claim'),
  ADD CONSTRAINT signup_request_conflict_not_self CHECK (conflicting_request_id <> id);

COMMENT ON COLUMN signup_request.conflicting_request_id IS
  'VET: the earlier sign-up the verifier named for a duplicate claim; the approver sees its display name and date.';

-- 3. Released claims.
CREATE SEQUENCE signup_claim_release_seq;
CREATE TABLE signup_claim_release (
  -- The cursor. Taken by the guard below, after the writers' lock, never by the writer.
  seq         bigint      PRIMARY KEY,
  request_id  uuid        NOT NULL REFERENCES signup_request (id),
  kind        text        NOT NULL CHECK (kind IN ('rejected', 'reopened', 'account_deleted')),
  released_at timestamptz NOT NULL DEFAULT now()
);
ALTER SEQUENCE signup_claim_release_seq OWNED BY signup_claim_release.seq;
COMMENT ON TABLE signup_claim_release IS
  'VET: each release of a sign-up''s claim on a number, for the verifier to free in its ledger. Ids and times only.';

-- The app reads it, and writes it only as the triggers do (the guard holds any row to a real release).
REVOKE UPDATE, DELETE ON signup_claim_release FROM nwfl;

-- Every row: one writer at a time from here to commit, so a later cursor is never visible before an
-- earlier one; the cursor and the time are the database's; and the release must be real.
CREATE FUNCTION signup_claim_release_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'signup_claim_release is append-only: % refused', TG_OP USING ERRCODE = '55000';
  END IF;
  -- In parentheses: plpgsql ends an IF condition at the first THEN outside them.
  IF NOT (CASE NEW.kind
    WHEN 'rejected' THEN EXISTS (SELECT 1 FROM signup_request WHERE id = NEW.request_id AND decision = 'rejected')
    WHEN 'reopened' THEN EXISTS (SELECT 1 FROM signup_request WHERE id = NEW.request_id AND reopened_at IS NOT NULL)
    ELSE EXISTS (SELECT 1 FROM signup_request s WHERE s.id = NEW.request_id AND s.decision = 'approved'
                   AND NOT EXISTS (SELECT 1 FROM member_account a WHERE a.sub = s.sub AND a.status <> 'removed'))
  END) THEN
    RAISE EXCEPTION 'sign-up % is not released as %', NEW.request_id, NEW.kind USING ERRCODE = '55000';
  END IF;
  PERFORM pg_advisory_xact_lock('signup_claim_release'::regclass::oid::bigint);
  NEW.seq := nextval('signup_claim_release_seq');
  NEW.released_at := now();
  RETURN NEW;
END
$fn$;
CREATE TRIGGER signup_claim_release_guard BEFORE INSERT OR UPDATE OR DELETE ON signup_claim_release
  FOR EACH ROW EXECUTE FUNCTION signup_claim_release_guard();
CREATE TRIGGER signup_claim_release_no_truncate BEFORE TRUNCATE ON signup_claim_release
  FOR EACH STATEMENT EXECUTE FUNCTION signup_claim_release_guard();
REVOKE EXECUTE ON FUNCTION signup_claim_release_guard() FROM PUBLIC;

-- A sign-up rejected, or reopened.
CREATE FUNCTION signup_request_release_claim() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF OLD.decision <> 'rejected' AND NEW.decision = 'rejected' THEN
    INSERT INTO signup_claim_release (request_id, kind) VALUES (NEW.id, 'rejected');
  END IF;
  IF OLD.reopened_at IS NULL AND NEW.reopened_at IS NOT NULL THEN
    INSERT INTO signup_claim_release (request_id, kind) VALUES (NEW.id, 'reopened');
  END IF;
  RETURN NULL;
END
$fn$;
CREATE TRIGGER signup_request_release_claim AFTER UPDATE ON signup_request
  FOR EACH ROW EXECUTE FUNCTION signup_request_release_claim();
REVOKE EXECUTE ON FUNCTION signup_request_release_claim() FROM PUBLIC;

-- An approved sign-up's account removed or deleted. A pending sign-up is released by its rejection,
-- which RemoveMember and RejectSignup make in the same transaction.
CREATE FUNCTION member_account_release_claim() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD.status = 'removed' OR NEW.status <> 'removed') THEN
    RETURN NULL;
  END IF;
  INSERT INTO signup_claim_release (request_id, kind)
    SELECT id, 'account_deleted' FROM signup_request
     WHERE sub = OLD.sub AND decision = 'approved' AND reopened_at IS NULL
     ORDER BY created_at, id;
  RETURN NULL;
END
$fn$;
CREATE TRIGGER member_account_release_claim AFTER UPDATE OR DELETE ON member_account
  FOR EACH ROW EXECUTE FUNCTION member_account_release_claim();
REVOKE EXECUTE ON FUNCTION member_account_release_claim() FROM PUBLIC;
