-- 0031_link_verdicts.sql: the link checker's verdicts (L-ITEM, SPEC-v3 3.4).
--
-- The link checker is a machine client (auth/caller.ts, kind linkcheck) that is handed the addresses
-- of pieces waiting for approval or approved, and records a verdict on each (ok, confirm, drop) in
-- content_link_check, which 0030 made ready for it: a machine row names an item and a URL, never a
-- version, a ready time or an office.
--
--   * The audit log learns the link checker as an actor (linkcheck) and a list of addresses as a
--     subject (link_list): each list handed out is audited as links_read, and each call that records
--     verdicts as link_verdicts, with counts only.
--   * The gate reads an item's latest machine verdict per URL: an index of its own, machine rows only.
--
-- ADDITIVE. The API before L-ITEM never writes either value, so it runs unchanged on 0031.

-- 1. The audit log: 0004's actors, plus the link checker.
ALTER TABLE audit_event DROP CONSTRAINT audit_event_actor_kind_check;
ALTER TABLE audit_event ADD CONSTRAINT audit_event_actor_kind_check
  CHECK (actor_kind IN ('user', 'agent', 'verifier', 'linkcheck', 'system'));

-- 2. The audit log: 0023's subjects, plus a list of addresses.
ALTER TABLE audit_event DROP CONSTRAINT audit_event_subject_kind_check;
ALTER TABLE audit_event ADD CONSTRAINT audit_event_subject_kind_check
  CHECK (subject_kind IN ('content_item', 'content_version', 'stored_file', 'edition',
                          'event_series', 'event_occurrence', 'venue', 'office', 'office_term',
                          'member_account', 'signup_request', 'redaction_policy', 'redaction_change',
                          'redaction_mark', 'redaction_mark_removal', 'approval_rule', 'link_list'));

-- 3. The gate's read of the machine verdicts: an item's, by URL, latest last.
CREATE INDEX content_link_check_machine ON content_link_check (item_id, url, id) WHERE source = 'machine';
