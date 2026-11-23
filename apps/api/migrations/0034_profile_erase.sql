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
--            signup_request_correct_number takes the number (digits only, as at sign-up) and one of
--            three fixed reasons, by its code: typed_wrong (typed wrong at sign-up), card_differs (the
--            member's card shows a different number), new_number (Mensa issued a new number). No free
--            text, so nothing typed can carry a number or a name into the log. The audit row holds
--            who, when and the code (to_state); its note stays empty. A number already on another live
--            sign-up (pending, or approved and not erased) is refused (23505).
--   REMOVAL  When a member's account is removed (an officer's RemoveMember, or the erasure above), the
--            profile (first name, last name, membership number) on every decided sign-up of that
--            person, a reopened earlier one included, is erased in the same statement, by a trigger,
--            whoever makes the change. It stays erased. A person never approved (a rejection, or the
--            removal of a person still waiting, which rejects their sign-up) keeps what was typed, so
--            a mistaken rejection can be judged and reopened; the Admin erases it on request.
--            A member removed before 0034 is erased here, once (section 8).
--   STATS    Each erasure ends by analysing the table again, so pg_stats (which the app role reads)
--            holds no erased value. The dead row versions, the WAL and the backups keep the values
--            until vacuum and pg-nwfl's backup retention remove them.
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

-- 2. (Before fix 1, a free-text reason and its digit check, membership_reason_ok. Gone: the reason is a
--    fixed choice, and no note goes on a membership record, a correction's included: 0004 unchanged.)

-- 3. The audit log: a correction's reason is one of three codes, in to_state, and nothing else.
ALTER TABLE audit_event
  ADD CONSTRAINT audit_event_correction_reason
    CHECK (action <> 'correct_number' OR subject_kind <> 'signup_request'
           OR (to_state IS NOT NULL AND to_state IN ('typed_wrong', 'card_differs', 'new_number') AND from_state IS NULL));

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
  -- REMOVAL: a removed member's profile goes from every decided sign-up of theirs, a reopened one too, only
  -- inside signup_request_erase_profile (a transaction-local marker naming the person): the three typed
  -- fields, all three to nothing, nothing else, and only for a person who was approved and is removed.
  IF current_setting('nwfl.profile_erase', true) = OLD.sub
     AND OLD.decision <> 'pending'
     AND num_nonnulls(NEW.first_name, NEW.last_name, NEW.membership_number) = 0
     AND (to_jsonb(NEW) - ARRAY['first_name', 'last_name', 'membership_number'])
         = (to_jsonb(OLD) - ARRAY['first_name', 'last_name', 'membership_number'])
     AND EXISTS (SELECT 1 FROM member_account a WHERE a.sub = OLD.sub AND a.status = 'removed')
     AND EXISTS (SELECT 1 FROM signup_request s WHERE s.sub = OLD.sub AND s.decision = 'approved') THEN
    RETURN NEW;
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
                        AND e.action = 'correct_number' AND e.at = now() AND e.note IS NULL
                        AND e.to_state IN ('typed_wrong', 'card_differs', 'new_number') AND 'nwfl-admin' = ANY (e.actor_groups)) THEN
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

-- 5. REMOVAL: an account that becomes removed loses the profile on every decided sign-up of the person,
--    in the same statement, whoever removes it, when the person was approved: a member's account. (A
--    rejection also closes its account, but nothing of that person was approved: what it typed stays, so a
--    mistaken rejection can be judged and reopened.) signup_request_erase_profile is the one writer, called
--    by the trigger and by section 8; it is no one's to call directly. The trigger's function runs as the
--    owner, so it may analyse the table and call the writer.
CREATE FUNCTION signup_request_erase_profile(p_sub text) RETURNS integer LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_count integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM member_account a WHERE a.sub = p_sub AND a.status = 'removed')
     OR NOT EXISTS (SELECT 1 FROM signup_request s WHERE s.sub = p_sub AND s.decision = 'approved') THEN
    RETURN 0;
  END IF;
  PERFORM set_config('nwfl.profile_erase', p_sub, true);
  UPDATE signup_request s SET first_name = NULL, last_name = NULL, membership_number = NULL
   WHERE s.sub = p_sub AND s.decision <> 'pending' AND num_nonnulls(s.first_name, s.last_name, s.membership_number) > 0;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  PERFORM set_config('nwfl.profile_erase', '', true);
  RETURN v_count;
END
$fn$;

CREATE FUNCTION member_account_removed_erases_profile() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF signup_request_erase_profile(NEW.sub) > 0 THEN
    -- STATS: the planner's statistics hold no erased value.
    ANALYZE signup_request;
  END IF;
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
  IF v_count > 0 THEN
    -- STATS: the planner's statistics hold no erased value.
    ANALYZE signup_request;
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
  v_row signup_request;
BEGIN
  IF coalesce(p_sub, '') = '' OR NOT coalesce('nwfl-admin' = ANY (p_groups), false) THEN
    RAISE EXCEPTION 'only the Admin corrects a membership number' USING ERRCODE = '42501';
  END IF;
  IF p_number IS NULL OR p_number !~ '^[0-9]{1,12}$' THEN
    RAISE EXCEPTION 'a membership number is 1 to 12 digits' USING ERRCODE = '22023';
  END IF;
  IF p_reason IS NULL OR p_reason NOT IN ('typed_wrong', 'card_differs', 'new_number') THEN
    RAISE EXCEPTION 'a correction''s reason is one of three codes' USING ERRCODE = '22023';
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
  -- Never onto a number another live sign-up holds: one waiting, or an approved one not erased.
  IF EXISTS (SELECT 1 FROM signup_request s WHERE s.membership_number = p_number AND s.id <> v_row.id
               AND s.decision IN ('pending', 'approved') AND s.erased_at IS NULL) THEN
    RAISE EXCEPTION 'that number is already on another sign-up' USING ERRCODE = 'unique_violation';
  END IF;
  INSERT INTO audit_event (trace_id, actor_kind, actor_sub, actor_groups, action, subject_kind, subject_id, to_state)
    VALUES (p_trace, 'user', p_sub, p_groups, 'correct_number', 'signup_request', v_row.id::text, p_reason);
  PERFORM set_config('nwfl.signup_correct_number', v_row.id::text, true);
  UPDATE signup_request s SET membership_number = p_number WHERE s.id = v_row.id;
  PERFORM set_config('nwfl.signup_correct_number', '', true);
END
$fn$;

-- 8. REMOVAL, for a member removed before 0034: erased once, here, audited by the system by the sign-up's id.
INSERT INTO audit_event (actor_kind, action, subject_kind, subject_id, from_state, to_state)
  SELECT 'system', 'erase_profile', 'signup_request', s.id::text, CASE WHEN s.reopened_at IS NOT NULL THEN 'reopened' ELSE s.decision END, 'profile_erased'
    FROM signup_request s JOIN member_account a ON a.sub = s.sub AND a.status = 'removed'
   WHERE s.decision <> 'pending' AND num_nonnulls(s.first_name, s.last_name, s.membership_number) > 0
     AND EXISTS (SELECT 1 FROM signup_request x WHERE x.sub = s.sub AND x.decision = 'approved')
   ORDER BY s.created_at, s.id;
SELECT signup_request_erase_profile(a.sub) FROM member_account a WHERE a.status = 'removed' ORDER BY a.sub;
ANALYZE signup_request;

REVOKE EXECUTE ON FUNCTION signup_request_erase(uuid, text, text[], text), signup_request_correct_number(uuid, text, text, text, text[], text),
  signup_request_erase_profile(text), member_account_removed_erases_profile() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION signup_request_erase(uuid, text, text[], text), signup_request_correct_number(uuid, text, text, text, text[], text) TO nwfl;
