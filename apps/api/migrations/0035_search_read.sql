-- 0035_search_read.sql: when the app last re-recorded a version for an audience, as a ledger stamp (ARCHIVE-SEARCH S3).
--
-- 0032's version_rerecorded holds the last re-record as a value of rerecord_seq, for search_file_servable to set
-- against the last policy change. The search read (src/search/sql.ts) also needs to set it against a passage mark:
-- an active mark, in a category the audience is not shown, made after the version's last re-record for that
-- audience is not in its index row, and the row is not the item as read now. A mark is made at its transaction's
-- ledger stamp (0016 publication_ledger_stamp: set once a transaction, under the ledger's lock, never before the
-- previous transaction's), so the re-record is given the same stamp here.
--
--   * at: the ledger stamp of the transaction that last wrote the row. search_item_put writes it for every version
--     recordSubjects renders, changed or not. A mark made and re-recorded in one transaction has the stamp's value,
--     which is not after it: the row counts. A mark made by SQL with no re-record after it is after it: the row does
--     not count until the app re-records the version.
--   * A trigger sets it on every insert and update, whatever the statement gives: no writer chooses it. An invoker:
--     only the owner writes the table (search_item_put, a definer; 0032 left the app SELECT alone), and the owner may
--     take the stamp, so no new definer is needed (UNTRUSTED-PDF-GATE's catalog is unchanged).
--     Rows standing when this runs are given this migration's stamp. A mark made by SQL before it and not re-recorded
--     since is then not caught by this comparison; the search read's live check (src/search/service.ts) still refuses
--     its row, and the boot backfill (src/search/backfill.ts) re-records every version whose render is not its
--     ledger row's output.
--
-- The app's role keeps SELECT on the table (0032) and no other privilege; it reads this column in the search.
ALTER TABLE version_rerecorded ADD COLUMN at timestamptz;
UPDATE version_rerecorded SET at = publication_ledger_stamp();
ALTER TABLE version_rerecorded ALTER COLUMN at SET NOT NULL;

CREATE FUNCTION version_rerecorded_at() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  NEW.at := publication_ledger_stamp();
  RETURN NEW;
END
$fn$;
REVOKE EXECUTE ON FUNCTION version_rerecorded_at() FROM PUBLIC;
CREATE TRIGGER version_rerecorded_at BEFORE INSERT OR UPDATE ON version_rerecorded
  FOR EACH ROW EXECUTE FUNCTION version_rerecorded_at();
