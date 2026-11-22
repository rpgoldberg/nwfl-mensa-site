-- 0034_profile_erase.sql: PROFILE-ERASE (Ross, 2026-11-22). Three rules on the sign-up record, which
-- 0028 kept whole in every state with no way to remove it:
--
--   REMOVE   The Admin erases a person's sign-up record when they ask (the privacy page's promise).
--            signup_request_erase blanks the display name, the email, the first name, the last name
--            and the membership number of every decided sign-up of that person (a reopened one too),
--            and marks each erased by whom and when. What stays: the date, the decision, who decided
--            and when, the membership check's outcome, and the account id. An approved member's
--            account is removed with it, so no account is left with no record behind it. A pending
--            sign-up is not erased: it is decided first.
--   CORRECT  The Admin corrects a wrong membership number on an approved member's profile.
--            signup_request_correct_number takes the number (digits only, as at sign-up) and a
--            reason in words. The audit row holds who, when and the reason, and never the old or the
--            new number: a reason is refused if it holds any digit, in any script.
--   REMOVAL  When an account is removed (an officer's RemoveMember, or the erasure above), the
--            profile on its approved sign-up (first name, last name, membership number) is erased in
--            the same statement, by a trigger, whoever makes the change. It stays erased.
--
-- Both functions are SECURITY DEFINER and the one writer of their change. Each refuses a caller
-- whose groups do not hold nwfl-admin (42501; the API passes the verified token's groups and is the
-- wall, as for 0023), and no one's own sign-up. signup_request_decision_final refuses every other
-- change, for every role's writes, the owner's too: the change is let through only inside the
-- function's call (a transaction-local marker naming the row, cleared at once) and only with its
-- audit row, written in the same transaction by the Admin. The owner can disable or drop a trigger,
-- as for every guard trigger (0019).
--
-- Unchanged: a decided row keeps its decision, decider and time; a reopened row never changes again
-- (but to be erased); only an approved sign-up's names change; a sign-up row is never deleted (0026).
-- An erased row changes once more at most: a rejected one can still be reopened, so the person can
-- sign up again.

-- 1. What an erased sign-up holds. The two NOT NULLs go to a CHECK that holds until the erasure.
ALTER TABLE signup_request
  ALTER COLUMN display_name DROP NOT NULL,
  ALTER COLUMN email DROP NOT NULL,
  ADD COLUMN erased_at timestamptz,
  ADD COLUMN erased_by_sub text CHECK (length(erased_by_sub) BETWEEN 1 AND 255),
  ADD CONSTRAINT signup_request_erase_recorded CHECK ((erased_at IS NULL) = (erased_by_sub IS NULL)),
  ADD CONSTRAINT signup_request_erase_only_decided CHECK (erased_at IS NULL OR decision <> 'pending'),
  ADD CONSTRAINT signup_request_erased_holds_nothing
    CHECK (erased_at IS NULL OR num_nonnulls(display_name, email, first_name, last_name, membership_number) = 0),
  ADD CONSTRAINT signup_request_named_until_erased
    CHECK (erased_at IS NOT NULL OR (display_name IS NOT NULL AND email IS NOT NULL));

COMMENT ON COLUMN signup_request.erased_at IS 'PROFILE-ERASE: when the Admin erased this record at the person''s request; the names, the number and the email are then NULL for good.';
COMMENT ON COLUMN signup_request.erased_by_sub IS 'PROFILE-ERASE: the Admin who erased it.';
COMMENT ON COLUMN signup_request.membership_number IS 'As the member typed it, digits only. Changed only by the Admin''s correction (signup_request_correct_number); erased when the account is removed or the record is erased. Never in an audit row or a log.';

-- 2. A reason in words, with no number in it. After compatibility folding (full-width and circled
--    digits become plain ones), every character must be a letter, a punctuation mark or symbol, or a
--    space: a digit of any script is none of those under the builtin Unicode classes, so it is
--    refused whatever is put between the digits. It needs a letter, and is 500 characters at most.
CREATE FUNCTION membership_reason_ok(p_reason text) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT p_reason IS NOT NULL
     AND length(p_reason) BETWEEN 1 AND 500
     AND (normalize(p_reason, NFKC) COLLATE pg_c_utf8) ~ '^[[:alpha:][:punct:][:space:]]+$'
     AND (normalize(p_reason, NFKC) COLLATE pg_c_utf8) ~ '[[:alpha:]]'
$fn$;

-- 3. The audit log: a membership record still gets no payload (0009) and no note (0004), but for
--    the reason of a number correction, which holds no digit.
ALTER TABLE audit_event
  DROP CONSTRAINT audit_event_no_note_on_membership,
  ADD CONSTRAINT audit_event_no_note_on_membership
    CHECK (note IS NULL OR subject_kind NOT IN ('member_account', 'signup_request')
           OR (subject_kind = 'signup_request' AND action = 'correct_number'
               -- membership_reason_ok, written out: a CHECK that called it would need every writer of this table to hold EXECUTE.
               AND length(note) BETWEEN 1 AND 500
               AND (normalize(note, NFKC) COLLATE pg_c_utf8) ~ '^[[:alpha:][:punct:][:space:]]+$'
               AND (normalize(note, NFKC) COLLATE pg_c_utf8) ~ '[[:alpha:]]'));

-- 4. What may change on a sign-up, and when (0009, 0026, 0028, and the three rules above).
CREATE OR REPLACE FUNCTION signup_request_decision_final() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_removed boolean;
BEGIN
  -- REMOVE: only inside signup_request_erase, only a decided row, only the erasure, with its record.
  IF OLD.erased_at IS NULL AND NEW.erased_at IS NOT NULL THEN
    IF current_setting('nwfl.signup_erase', true) IS DISTINCT FROM OLD.id::text
       OR OLD.decision = 'pending'
       OR (to_jsonb(NEW) - ARRAY['display_name', 'email', 'first_name', 'last_name', 'membership_number', 'erased_at', 'erased_by_sub'])
          IS DISTINCT FROM
          (to_jsonb(OLD) - ARRAY['display_name', 'email', 'first_name', 'last_name', 'membership_number', 'erased_at', 'erased_by_sub'])
       OR NOT EXISTS (SELECT 1 FROM audit_event e WHERE e.subject_kind = 'signup_request' AND e.subject_id = OLD.id::text
                        AND e.action = 'erase' AND e.at = now() AND e.actor_sub = NEW.erased_by_sub AND 'nwfl-admin' = ANY (e.actor_groups)) THEN
      RAISE EXCEPTION 'signup_request %: a sign-up is erased only by signup_request_erase, with its record', OLD.id
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    RETURN NEW;
  END IF;
  -- An erased row changes only by being reopened (a rejected one, once: the checks below and 0026).
  IF OLD.erased_at IS NOT NULL
     AND (to_jsonb(NEW) - ARRAY['reopened_at', 'reopened_by_sub']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['reopened_at', 'reopened_by_sub']) THEN
    RAISE EXCEPTION 'signup_request % is erased', OLD.id USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF OLD.reopened_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'signup_request % is reopened', OLD.id USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  v_removed := EXISTS (SELECT 1 FROM member_account a WHERE a.sub = OLD.sub AND a.status = 'removed');
  IF NEW.membership_number IS DISTINCT FROM OLD.membership_number THEN
    IF NEW.membership_number IS NULL THEN
      -- REMOVAL: the profile of a removed account goes whole, never the number alone.
      IF NOT (OLD.decision = 'approved' AND v_removed AND NEW.first_name IS NULL AND NEW.last_name IS NULL) THEN
        RAISE EXCEPTION 'signup_request %: a membership number is never changed', OLD.id USING ERRCODE = 'object_not_in_prerequisite_state';
      END IF;
    ELSIF current_setting('nwfl.signup_correct_number', true) IS DISTINCT FROM OLD.id::text
       -- CORRECT: only inside signup_request_correct_number, only the number, on a profile that has one.
       OR OLD.decision <> 'approved' OR OLD.membership_number IS NULL OR v_removed
       OR (to_jsonb(NEW) - 'membership_number') IS DISTINCT FROM (to_jsonb(OLD) - 'membership_number')
       OR NOT EXISTS (SELECT 1 FROM audit_event e WHERE e.subject_kind = 'signup_request' AND e.subject_id = OLD.id::text
                        AND e.action = 'correct_number' AND e.at = now() AND e.note IS NOT NULL AND 'nwfl-admin' = ANY (e.actor_groups)) THEN
      RAISE EXCEPTION 'signup_request %: a membership number is never changed', OLD.id USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
  END IF;
  IF (NEW.first_name, NEW.last_name) IS DISTINCT FROM (OLD.first_name, OLD.last_name) THEN
    IF OLD.decision <> 'approved' THEN
      RAISE EXCEPTION 'signup_request %: only an approved sign-up''s names change', OLD.id USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    -- REMOVAL: a removed account's profile is erased whole, and stays erased.
    IF v_removed AND num_nonnulls(NEW.first_name, NEW.last_name, NEW.membership_number) > 0 THEN
      RAISE EXCEPTION 'signup_request %: a removed account''s profile stays erased', OLD.id USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
  END IF;
  IF OLD.decision <> 'pending'
     AND (NEW.decision, NEW.decided_at, NEW.decided_by_sub) IS DISTINCT FROM (OLD.decision, OLD.decided_at, OLD.decided_by_sub) THEN
    RAISE EXCEPTION 'signup_request % is decided', OLD.id USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END
$fn$;

COMMENT ON TRIGGER signup_request_decision_final ON signup_request IS
  'Refuses every role''s other changes of a decided, reopened or erased row, the owner''s included; the owner can disable or drop it, as for every guard trigger (0019).';

-- 5. REMOVAL: an account that becomes removed loses the profile on its approved sign-up, in the same
--    statement, whoever removes it. (A rejection also closes its account, but its sign-up is rejected,
--    not approved: what it typed stays, so a mistaken rejection can be judged and reopened.)
CREATE FUNCTION member_account_removed_erases_profile() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  UPDATE signup_request SET first_name = NULL, last_name = NULL, membership_number = NULL
   WHERE sub = NEW.sub AND decision = 'approved' AND num_nonnulls(first_name, last_name, membership_number) > 0;
  RETURN NULL;
END
$fn$;
CREATE TRIGGER member_account_removed_erases_profile AFTER INSERT OR UPDATE ON member_account
  FOR EACH ROW WHEN (NEW.status = 'removed') EXECUTE FUNCTION member_account_removed_erases_profile();

-- 6. REMOVE: the one writer.
CREATE FUNCTION signup_request_erase(p_id uuid, p_sub text, p_groups text[], p_trace text)
  RETURNS TABLE (erased integer, access_ended boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
#variable_conflict use_column
DECLARE
  v_row    signup_request;
  v_each   signup_request;
  v_status text;
  v_count  integer := 0;
  v_ended  boolean := false;
BEGIN
  IF coalesce(p_sub, '') = '' OR NOT coalesce('nwfl-admin' = ANY (p_groups), false) THEN
    RAISE EXCEPTION 'only the Admin erases a sign-up' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_row FROM signup_request s WHERE s.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such sign-up' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_row.sub = p_sub THEN
    RAISE EXCEPTION 'no one erases their own sign-up' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM signup_request s WHERE s.sub = v_row.sub AND s.decision = 'pending') THEN
    RAISE EXCEPTION 'a pending sign-up is decided before the record is erased' USING ERRCODE = '55000';
  END IF;
  FOR v_each IN SELECT * FROM signup_request s WHERE s.sub = v_row.sub AND s.erased_at IS NULL ORDER BY s.created_at, s.id FOR UPDATE LOOP
    INSERT INTO audit_event (trace_id, actor_kind, actor_sub, actor_groups, action, subject_kind, subject_id, from_state, to_state)
      VALUES (p_trace, 'user', p_sub, p_groups, 'erase', 'signup_request', v_each.id::text,
              CASE WHEN v_each.reopened_at IS NOT NULL THEN 'reopened' ELSE v_each.decision END, 'erased');
    PERFORM set_config('nwfl.signup_erase', v_each.id::text, true);
    UPDATE signup_request s SET display_name = NULL, email = NULL, first_name = NULL, last_name = NULL, membership_number = NULL,
           erased_at = now(), erased_by_sub = p_sub
     WHERE s.id = v_each.id;
    PERFORM set_config('nwfl.signup_erase', '', true);
    v_count := v_count + 1;
  END LOOP;
  -- No account is left standing on a record that is gone.
  SELECT a.status INTO v_status FROM member_account a WHERE a.sub = v_row.sub FOR UPDATE;
  IF FOUND AND v_status <> 'removed'
     AND EXISTS (SELECT 1 FROM signup_request s WHERE s.sub = v_row.sub AND s.decision = 'approved') THEN
    UPDATE member_account a SET status = 'removed', removed_at = now(), updated_at = now() WHERE a.sub = v_row.sub;
    INSERT INTO audit_event (trace_id, actor_kind, actor_sub, actor_groups, action, subject_kind, subject_id, from_state, to_state)
      VALUES (p_trace, 'user', p_sub, p_groups, 'remove', 'member_account', v_row.sub, v_status, 'removed');
    v_ended := true;
  END IF;
  RETURN QUERY SELECT v_count, v_ended;
END
$fn$;

-- 7. CORRECT: the one writer. The number is trimmed of nothing here: the API drops typing noise
--    first, as at sign-up, and the column's own CHECK (0005) holds it to 1 to 12 digits.
CREATE FUNCTION signup_request_correct_number(p_id uuid, p_number text, p_reason text, p_sub text, p_groups text[], p_trace text)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_reason text := regexp_replace(coalesce(p_reason, '') COLLATE pg_c_utf8, '^[[:space:]]+|[[:space:]]+$', '', 'g');
  v_row    signup_request;
BEGIN
  IF coalesce(p_sub, '') = '' OR NOT coalesce('nwfl-admin' = ANY (p_groups), false) THEN
    RAISE EXCEPTION 'only the Admin corrects a membership number' USING ERRCODE = '42501';
  END IF;
  IF p_number IS NULL OR p_number !~ '^[0-9]{1,12}$' THEN
    RAISE EXCEPTION 'a membership number is 1 to 12 digits' USING ERRCODE = '22023';
  END IF;
  IF NOT membership_reason_ok(v_reason) THEN
    RAISE EXCEPTION 'a correction needs a reason in words, with no digits' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_row FROM signup_request s WHERE s.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such sign-up' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_row.sub = p_sub THEN
    RAISE EXCEPTION 'no one corrects their own number' USING ERRCODE = '42501';
  END IF;
  IF v_row.decision <> 'approved' OR v_row.membership_number IS NULL
     OR NOT EXISTS (SELECT 1 FROM member_account a WHERE a.sub = v_row.sub AND a.status IN ('member', 'affiliate', 'lapsed')) THEN
    RAISE EXCEPTION 'only an approved member''s number is corrected' USING ERRCODE = '55000';
  END IF;
  IF v_row.membership_number = p_number THEN
    RAISE EXCEPTION 'that is the number already on the profile' USING ERRCODE = '55000';
  END IF;
  INSERT INTO audit_event (trace_id, actor_kind, actor_sub, actor_groups, action, subject_kind, subject_id, note)
    VALUES (p_trace, 'user', p_sub, p_groups, 'correct_number', 'signup_request', v_row.id::text, v_reason);
  PERFORM set_config('nwfl.signup_correct_number', v_row.id::text, true);
  UPDATE signup_request s SET membership_number = p_number WHERE s.id = v_row.id;
  PERFORM set_config('nwfl.signup_correct_number', '', true);
END
$fn$;

REVOKE EXECUTE ON FUNCTION signup_request_erase(uuid, text, text[], text), signup_request_correct_number(uuid, text, text, text, text[], text),
  membership_reason_ok(text), member_account_removed_erases_profile() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION signup_request_erase(uuid, text, text[], text), signup_request_correct_number(uuid, text, text, text, text[], text) TO nwfl;
