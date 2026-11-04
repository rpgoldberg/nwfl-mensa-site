-- 0022_public_shows_names_and_pictures.sql: the public copy shows member names and pictures
-- (REDACT-LOOK, Ross's decision of 2026-11-02).
--
-- Two cells of the 0012 defaults change, for the public audience only:
--
--   * member_name  redact -> show
--   * image        blur   -> show
--
-- Every other cell stays as it is: the public's member phones, e-mails and addresses, private
-- venues and officer contacts stay redacted, and the members' and officers' cells are untouched.
-- member_name acts site-wide, not only on PDF copies: marked names in web text and the
-- on-behalf-of byline now show to the public too, by the same decision.
--
-- The change goes through the history the narrow path writes (0012, 0013), so the as-of policy
-- (lens.ts policyCells) and the publication ledger (0016) still read the past right, and no
-- constraint is touched:
--
--   * each cell is locked as redaction_propose locks it (redaction_lock_cell);
--   * a change still waiting on the cell is superseded, as redaction_propose does;
--   * an applied redaction_change row records the loosening, proposed by the migration and approved
--     on Ross's recorded decision: two distinct subjects, so not_self_approved and
--     public_loosening_approved hold (0012); the 0016 trigger stamps decided_at and approved_at
--     with the ledger's stamp;
--   * the cell is set, which takes the ledger lock and queues every stored original again (0015);
--   * audit_event rows record it as the narrow path's do (redaction_propose, redaction_approve,
--     redaction_set), as the system, with the reason in the note and the payload: redaction_change
--     has no reason column.
--
-- Identities (no person's identifier is written into this immutable file):
--   proposer  system:migration-0022
--   approver  system:decision-ross-2026-11-02
--
-- It refuses, so nothing is applied and the deploy stops for Ross to decide, when:
--   * either cell holds anything but its 0012 default or show (an officer has changed it since);
--   * an active whole-item mark has the category member_name: under show that item would become
--     public at once (store.ts inputsFor, the lens).
-- A cell already at show is left alone, so a cell an officer has loosened since is not changed again.
DO $mig$
DECLARE
  c_proposer constant text := 'system:migration-0022';
  c_approver constant text := 'system:decision-ross-2026-11-02';
  c_note     constant text := 'Ross''s 11-02 decision (REDACT-LOOK): the public copy shows member names and pictures; contacts stay redacted.';
  v_cell     record;
  v_from     text;
  v_whole    bigint;
  v_change   redaction_change;
  v_id       uuid;
  v_payload  jsonb;
BEGIN
  FOR v_cell IN SELECT * FROM (VALUES ('member_name', 'redact'), ('image', 'blur')) AS t (category, expected) LOOP
    v_from := redaction_lock_cell('nwflorida', 'public', v_cell.category);
    CONTINUE WHEN v_from = 'show';
    IF v_from <> v_cell.expected THEN
      RAISE EXCEPTION '0022: the public % cell is %, not the 0012 default %: an officer has changed it since; Ross decides',
        v_cell.category, v_from, v_cell.expected USING ERRCODE = '55000';
    END IF;
    IF v_cell.category = 'member_name' THEN
      SELECT count(*) INTO v_whole FROM redaction_mark
        WHERE tenant_id = 'nwflorida' AND category = 'member_name' AND quote IS NULL AND status = 'active';
      IF v_whole > 0 THEN
        RAISE EXCEPTION '0022: % active whole-item member_name mark(s) would make their items public; Ross decides', v_whole
          USING ERRCODE = '55000';
      END IF;
    END IF;

    FOR v_id IN
      UPDATE redaction_change SET status = 'superseded', decided_at = now()
        WHERE tenant_id = 'nwflorida' AND audience = 'public' AND category = v_cell.category AND status = 'pending'
        RETURNING id
    LOOP
      INSERT INTO audit_event (actor_kind, actor_sub, action, subject_kind, subject_id, from_state, to_state, note, payload)
        VALUES ('system', c_proposer, 'redaction_supersede', 'redaction_change', v_id::text, 'pending', 'superseded', c_note,
                jsonb_build_object('tenant', 'nwflorida', 'audience', 'public', 'category', v_cell.category,
                                   'decision', 'ross-2026-11-02'));
    END LOOP;

    INSERT INTO redaction_change (tenant_id, audience, category, from_action, to_action, status,
                                  proposed_by_sub, approved_by_sub, approved_at, decided_at)
      VALUES ('nwflorida', 'public', v_cell.category, v_from, 'show', 'applied', c_proposer, c_approver, now(), now())
      RETURNING * INTO v_change;
    UPDATE redaction_policy SET action = 'show', updated_by_sub = c_proposer, updated_at = now()
      WHERE tenant_id = 'nwflorida' AND audience = 'public' AND category = v_cell.category;

    v_payload := jsonb_build_object('change_id', v_change.id, 'tenant', 'nwflorida', 'audience', 'public',
                                    'category', v_cell.category, 'decision', 'ross-2026-11-02');
    INSERT INTO audit_event (actor_kind, actor_sub, action, subject_kind, subject_id, from_state, to_state, note, payload) VALUES
      ('system', c_proposer, 'redaction_propose', 'redaction_change', v_change.id::text, v_from, 'show', c_note, v_payload),
      ('system', c_approver, 'redaction_approve', 'redaction_change', v_change.id::text, 'pending', 'applied', c_note, v_payload),
      ('system', c_proposer, 'redaction_set', 'redaction_policy', 'nwflorida:public:' || v_cell.category, v_from, 'show', c_note, v_payload);
  END LOOP;
END
$mig$;
