-- 0032_officer_verify.sql: what the membership check reports beyond its outcome (OFFICER-VERIFY).
--
--   * signup_request.first_name_matched: whether the check confirmed the first name the person typed.
--     NULL until the report, and NULL when the report does not say (a check that does not compare first
--     names yet). The site keeps what was TYPED; this is a yes or no about it, never a name.
--   * signup_request.local_group: the local group the check reported. The one value the site keeps from
--     the membership records (Ross, 11-23: "perfectly harmless"); the API compares it with the chapter's
--     own group name (CHAPTER_GROUP_NAME) to tell a chapter member from a guest member.
--   * Both are written with the report only (an unchecked sign-up has neither) and never change after.
--   * Nothing derived is stored: whether the group makes a person a chapter member or a guest is decided
--     each time a standing is read (auth/standing.ts), against CHAPTER_GROUP_NAME, so a missing or wrong
--     setting never fixes anyone as a guest. The API writes both only with OFFICER_VERIFY on.
--
-- ADDITIVE. The API before OFFICER-VERIFY never writes these columns, so it runs unchanged on 0032.

-- 1. The report's two new answers.
ALTER TABLE signup_request
  ADD COLUMN first_name_matched boolean,
  ADD COLUMN local_group text
    CONSTRAINT signup_request_local_group_text CHECK (length(local_group) BETWEEN 1 AND 120 AND local_group !~ '[[:cntrl:]]'),
  ADD CONSTRAINT signup_request_reported_with_check
    CHECK (verification <> 'unchecked' OR (first_name_matched IS NULL AND local_group IS NULL));

COMMENT ON COLUMN signup_request.first_name_matched IS 'OFFICER-VERIFY: whether the membership check confirmed the typed first name; NULL when it did not say.';
COMMENT ON COLUMN signup_request.local_group IS 'OFFICER-VERIFY: the local group the membership check reported (Ross 11-23); NULL when it did not say.';

-- 2. Written with the report, never after.
CREATE FUNCTION signup_request_report_final() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF OLD.verification <> 'unchecked'
     AND (NEW.first_name_matched, NEW.local_group) IS DISTINCT FROM (OLD.first_name_matched, OLD.local_group) THEN
    RAISE EXCEPTION 'signup_request %: the report''s answers never change', OLD.id USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER signup_request_report_final BEFORE UPDATE ON signup_request
  FOR EACH ROW EXECUTE FUNCTION signup_request_report_final();
