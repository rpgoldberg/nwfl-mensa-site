-- 0013_redaction_path.sql: the redaction policy changes only through one narrow path (R1 FIX).
--
-- 0012 left the app role INSERT and UPDATE on both tables, so it could set a cell with no change
-- and no audit row, insert an "approved" loosening, rewrite a change, or reopen one. Now:
--
--   * The app role only reads redaction_policy and redaction_change.
--   * Two SECURITY DEFINER functions are the only writers: redaction_propose and
--     redaction_approve. Each takes a transaction-scoped advisory lock on the cell, then the
--     row locks, and writes the change, the cell and the audit rows together. A loosening of the
--     public audience only ever becomes pending; it is applied by a different subject, and only
--     while the cell still holds the change's from_action (a missing cell reads as hide).
--   * A trigger keeps the change history immutable for every role, the owner included: the only
--     update is pending -> applied or superseded, which sets the decision columns and nothing
--     else, and nothing is deleted.
--
-- The functions are owned by the migrator, which owns the tables. A separate NOLOGIN owner would
-- need CREATEROLE, which the migrator does not hold (0000). search_path is pinned, and EXECUTE is
-- the app role's alone. The caller's identity is the subject the API passes from the verified
-- token: the database cannot verify a token, but it does hold the rule that two distinct
-- subjects are needed.

REVOKE INSERT, UPDATE ON redaction_policy FROM nwfl;
REVOKE INSERT, UPDATE ON redaction_change FROM nwfl;

ALTER TABLE redaction_change
  ADD CONSTRAINT redaction_change_decided CHECK ((status = 'pending') = (decided_at IS NULL)),
  ADD CONSTRAINT redaction_change_approved_only_if_applied CHECK (approved_by_sub IS NULL OR status = 'applied');

CREATE FUNCTION redaction_change_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'redaction_change is append-only' USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'pending' OR NEW.status NOT IN ('applied', 'superseded') THEN
    RAISE EXCEPTION 'a redaction change is decided once' USING ERRCODE = '55000';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.audience, NEW.category, NEW.from_action, NEW.to_action, NEW.proposed_by_sub, NEW.proposed_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.audience, OLD.category, OLD.from_action, OLD.to_action, OLD.proposed_by_sub, OLD.proposed_at) THEN
    RAISE EXCEPTION 'a redaction change keeps what was proposed' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER redaction_change_guard BEFORE UPDATE OR DELETE ON redaction_change
  FOR EACH ROW EXECUTE FUNCTION redaction_change_guard();

-- The cell's action now, fail-closed, after taking its locks. Called by the two functions below.
CREATE FUNCTION redaction_lock_cell(p_tenant text, p_audience text, p_category text) RETURNS text
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_action text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('redaction_policy:' || p_tenant || ':' || p_audience || ':' || p_category));
  SELECT action INTO v_action FROM redaction_policy
    WHERE tenant_id = p_tenant AND audience = p_audience AND category = p_category FOR UPDATE;
  RETURN coalesce(v_action, 'hide');
END
$fn$;

CREATE FUNCTION redaction_audit(p_sub text, p_groups text[], p_trace text, p_action text, p_kind text, p_subject text,
                                p_from text, p_to text, p_payload jsonb) RETURNS void
  LANGUAGE sql SET search_path = pg_catalog, public, pg_temp AS $fn$
  INSERT INTO audit_event (trace_id, actor_kind, actor_sub, actor_groups, action, subject_kind, subject_id, from_state, to_state, payload)
  VALUES (p_trace, 'user', p_sub, coalesce(p_groups, '{}'), p_action, p_kind, p_subject, p_from, p_to, p_payload)
$fn$;

-- Applies a decided change to its cell and audits it.
CREATE FUNCTION redaction_set_cell(p_change redaction_change, p_sub text, p_groups text[], p_trace text) RETURNS void
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  INSERT INTO redaction_policy (tenant_id, audience, category, action, updated_by_sub)
    VALUES (p_change.tenant_id, p_change.audience, p_change.category, p_change.to_action, p_sub)
    ON CONFLICT (tenant_id, audience, category)
    DO UPDATE SET action = EXCLUDED.action, updated_by_sub = EXCLUDED.updated_by_sub, updated_at = now();
  PERFORM redaction_audit(p_sub, p_groups, p_trace, 'redaction_set', 'redaction_policy',
    p_change.tenant_id || ':' || p_change.audience || ':' || p_change.category,
    p_change.from_action, p_change.to_action, jsonb_build_object('change_id', p_change.id));
END
$fn$;

CREATE FUNCTION redaction_propose(p_tenant text, p_audience text, p_category text, p_to text,
                                  p_sub text, p_groups text[], p_trace text) RETURNS redaction_change
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_from   text;
  v_change redaction_change;
  v_id     uuid;
BEGIN
  IF coalesce(p_sub, '') = '' THEN
    RAISE EXCEPTION 'a redaction change needs its proposer' USING ERRCODE = '42501';
  END IF;
  v_from := redaction_lock_cell(p_tenant, p_audience, p_category);
  IF p_audience = 'public' AND redaction_rank(p_to) < redaction_rank(v_from) THEN
    IF EXISTS (SELECT 1 FROM redaction_change WHERE tenant_id = p_tenant AND audience = p_audience
                 AND category = p_category AND status = 'pending') THEN
      RAISE EXCEPTION 'a change to this cell is already waiting' USING ERRCODE = '55000';
    END IF;
    INSERT INTO redaction_change (tenant_id, audience, category, from_action, to_action, status, proposed_by_sub)
      VALUES (p_tenant, p_audience, p_category, v_from, p_to, 'pending', p_sub) RETURNING * INTO v_change;
    PERFORM redaction_audit(p_sub, p_groups, p_trace, 'redaction_propose', 'redaction_change', v_change.id::text, v_from, p_to,
      jsonb_build_object('tenant', p_tenant, 'audience', p_audience, 'category', p_category));
    RETURN v_change;
  END IF;
  -- Applies at once, and replaces a loosening still waiting on this cell.
  FOR v_id IN
    UPDATE redaction_change SET status = 'superseded', decided_at = now()
      WHERE tenant_id = p_tenant AND audience = p_audience AND category = p_category AND status = 'pending'
      RETURNING id
  LOOP
    PERFORM redaction_audit(p_sub, p_groups, p_trace, 'redaction_supersede', 'redaction_change', v_id::text, 'pending', 'superseded', '{}');
  END LOOP;
  INSERT INTO redaction_change (tenant_id, audience, category, from_action, to_action, status, proposed_by_sub, decided_at)
    VALUES (p_tenant, p_audience, p_category, v_from, p_to, 'applied', p_sub, now()) RETURNING * INTO v_change;
  PERFORM redaction_set_cell(v_change, p_sub, p_groups, p_trace);
  RETURN v_change;
END
$fn$;

CREATE FUNCTION redaction_approve(p_change_id uuid, p_sub text, p_groups text[], p_trace text) RETURNS redaction_change
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_change redaction_change;
  v_now    text;
BEGIN
  IF coalesce(p_sub, '') = '' THEN
    RAISE EXCEPTION 'a redaction approval needs its approver' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_change FROM redaction_change WHERE id = p_change_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such redaction change' USING ERRCODE = '55000';
  END IF;
  -- The cell first, as a proposal takes it, then the change.
  v_now := redaction_lock_cell(v_change.tenant_id, v_change.audience, v_change.category);
  SELECT * INTO v_change FROM redaction_change WHERE id = p_change_id FOR UPDATE;
  IF v_change.status <> 'pending' THEN
    RAISE EXCEPTION 'this redaction change is not waiting' USING ERRCODE = '55000';
  END IF;
  IF v_change.proposed_by_sub = p_sub THEN
    RAISE EXCEPTION 'a second officer approves a redaction change' USING ERRCODE = '42501';
  END IF;
  IF v_now <> v_change.from_action THEN
    RAISE EXCEPTION 'the cell changed since this was proposed' USING ERRCODE = '55000';
  END IF;
  UPDATE redaction_change SET status = 'applied', approved_by_sub = p_sub, approved_at = now(), decided_at = now()
    WHERE id = p_change_id RETURNING * INTO v_change;
  PERFORM redaction_audit(p_sub, p_groups, p_trace, 'redaction_approve', 'redaction_change', p_change_id::text, 'pending', 'applied', '{}');
  PERFORM redaction_set_cell(v_change, p_sub, p_groups, p_trace);
  RETURN v_change;
END
$fn$;

REVOKE EXECUTE ON FUNCTION redaction_lock_cell(text, text, text), redaction_set_cell(redaction_change, text, text[], text),
  redaction_audit(text, text[], text, text, text, text, text, text, jsonb), redaction_change_guard(),
  redaction_propose(text, text, text, text, text, text[], text), redaction_approve(uuid, text, text[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION redaction_propose(text, text, text, text, text, text[], text), redaction_approve(uuid, text, text[], text) TO nwfl;
