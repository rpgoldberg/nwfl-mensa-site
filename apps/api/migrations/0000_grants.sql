-- 0000_grants.sql: what lets the two database roles work.
--
--   nwfl_migrator  owns the database and runs scripts/migrate.sh (never a superuser).
--   nwfl           the application role the deployed DSN connects as. Rows only.
--
-- Carried over from fc-coordinator's 0000_grants.sql, whose header explains each choice at
-- length. In short:
--   * It is 0000 because ALTER DEFAULT PRIVILEGES reaches only objects created AFTER it runs,
--     and migrate.sh refuses a back-dated file (exit 6), so it can never be added later.
--   * Default privileges, not "ON ALL TABLES", so every table a later migration adds is covered.
--   * The migrator is not named: with no FOR ROLE the defaults attach to the role running the
--     file, which is the one creating the tables. The app role IS named, because it is the
--     contract with the Deployment; if it does not exist the GRANT fails and psql -1 rolls the
--     whole file back with the ledger clean.
--   * Not granted: CREATE on the schema (no DDL), TRUNCATE (a delete nobody could audit row by
--     row), REFERENCES, TRIGGER. Later files narrow further where a table needs it
--     (audit_event: INSERT and SELECT only).
--   * schema_migrations exists before this file runs (migrate.sh creates the ledger first), so
--     the defaults never reach it and the app role cannot rewrite migration provenance.
--
-- No transaction control here: migrate.sh wraps the file and its ledger row in one psql -1.

-- CONNECT by name through \gexec: the database is called differently in each test fixture.
SELECT format('GRANT CONNECT ON DATABASE %I TO nwfl', current_database())
\gexec

GRANT USAGE ON SCHEMA public TO nwfl;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nwfl;

-- nextval() behind identity columns needs USAGE; currval() and lastval() need SELECT.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO nwfl;
