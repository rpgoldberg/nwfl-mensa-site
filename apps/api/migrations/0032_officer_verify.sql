-- 0032_officer_verify.sql: what the membership check reports beyond its outcome (OFFICER-VERIFY).
--
--   * signup_request.first_name_matched: whether the check confirmed the first name the person typed.
--     NULL until the report, and NULL when the report does not say (a check that does not compare first
--     names yet). The site keeps what was TYPED; this is a yes or no about it, never a name.
--   * signup_request.local_group: the local group the check reported. The one value the site keeps from
--     the membership records (Ross, 11-23: "perfectly harmless"); the API compares it with the chapter's
--     own group name (CHAPTER_GROUP_NAME) to tell a chapter member from a guest member.
--   * Both are written with the report only, and only beside an outcome that confirmed the number and
--     the last name (a local or other-group match, or an email mismatch): a check that did not confirm
--     the person says nothing about them (fix round 3, B1). They never change after, with one way round:
--   * signup_request.recheck_requested_at: an approved member whose officer tools wait asked for a fresh
--     check (fix round 3). The check then answers again: a confirming answer replaces the three answers
--     (the outcome, first_name_matched, local_group) and clears this; any other answer clears it and is
--     noted in recheck_outcome, and the earlier answers stand. The decision never changes by it.
--   * Nothing derived is stored: whether the group makes a person a chapter member or a guest is decided
--     each time a standing is read (auth/standing.ts), against CHAPTER_GROUP_NAME, so a missing or wrong
--     setting never fixes anyone as a guest. The API writes all of these only with OFFICER_VERIFY on.
--
-- ADDITIVE. The API before OFFICER-VERIFY never writes these columns, so it runs unchanged on 0032.

-- 1. The report's two new answers, and the fresh check.
ALTER TABLE signup_request
  ADD COLUMN first_name_matched boolean,
  ADD COLUMN local_group text
    CONSTRAINT signup_request_local_group_text CHECK (length(local_group) BETWEEN 1 AND 120 AND local_group !~ '[[:cntrl:]]'),
  ADD COLUMN recheck_requested_at timestamptz,
  ADD COLUMN recheck_outcome text
    CONSTRAINT signup_request_recheck_outcome CHECK (recheck_outcome IN ('not_found', 'error', 'duplicate_claim')),
  ADD CONSTRAINT signup_request_reported_with_check
    CHECK (verification IN ('verified_local', 'verified_other_group', 'email_mismatch') OR (first_name_matched IS NULL AND local_group IS NULL)),
  ADD CONSTRAINT signup_request_recheck_only_approved
    CHECK ((recheck_requested_at IS NULL AND recheck_outcome IS NULL) OR decision = 'approved'),
  ADD CONSTRAINT signup_request_recheck_asked_or_answered CHECK (recheck_requested_at IS NULL OR recheck_outcome IS NULL);

COMMENT ON COLUMN signup_request.first_name_matched IS 'OFFICER-VERIFY: whether the membership check confirmed the typed first name; NULL when it did not say, or did not confirm the person.';
COMMENT ON COLUMN signup_request.local_group IS 'OFFICER-VERIFY: the local group the membership check reported (Ross 11-23); NULL when it did not say, or did not confirm the person.';
COMMENT ON COLUMN signup_request.recheck_requested_at IS 'OFFICER-VERIFY: when the approved member asked for a fresh membership check; NULL once it answered.';
COMMENT ON COLUMN signup_request.recheck_outcome IS 'OFFICER-VERIFY: the outcome of the last fresh check when it did not confirm the member; the earlier answers stand.';

-- 2. The check's answers are written with the report and never after, but by a fresh check that was asked for.
CREATE FUNCTION signup_request_report_final() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF OLD.verification <> 'unchecked' AND OLD.recheck_requested_at IS NULL
     AND (NEW.verification, NEW.first_name_matched, NEW.local_group) IS DISTINCT FROM (OLD.verification, OLD.first_name_matched, OLD.local_group) THEN
    RAISE EXCEPTION 'signup_request %: the report''s answers never change', OLD.id USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER signup_request_report_final BEFORE UPDATE ON signup_request
  FOR EACH ROW EXECUTE FUNCTION signup_request_report_final();
