-- 0032_search.sql: the archive search index (ARCHIVE-SEARCH S1).
--
-- Four tables, one per audience and kind. None has an audience column, so no WHERE clause can
-- cross audiences: a query for the public names the public tables and can return nothing else.
--
--   search_page_public / search_page_members   a page of the redacted COPY of a PDF that the
--     audience is served (never of an original): the text, and the kept-hyphen forms of the words
--     the line-end rule joined (src/search/text.ts).
--   search_item_public / search_item_members   a news item as the audience is given it: the plain
--     text of the ContentItem the publication ledger hashed, after the lens.
--
-- Officers have no tables: a search by an officer reads what members are given.
--
-- This is NOT content_version.search_public / search_members (0003). Those are derived at approval
-- and hold passages a redaction mark later withholds; nothing here reads them.
--
-- Writers. The app role reads the four tables and writes none; the worker role neither reads nor
-- writes them. Each write goes through a SECURITY DEFINER function that refuses (55000) unless the
-- publication ledger's CURRENT output for the subject and audience is the sha it is given:
--   * search_page_put(file, audience, sha, text_version, pages[], extras[]): the worker's, for a
--     file whose current ledger row says the audience is served a copy, and that the audience may
--     open now (search_file_servable, below: what content/files.ts servableFile serves); else
--     55000. It replaces the audience's rows for the file. Caps: 1 to 300 pages, 64 KiB a page and
--     an extra, 4 MiB in all.
--   * search_item_put(version, audience, sha, title, text): the app's. With a NULL sha (the ledger
--     says the audience is given nothing) or a NULL title (given something with nothing to index: a
--     withdrawn item's stub) it deletes the version's row instead.
-- Like pdf_original_put (0015), each is a trust in its one caller for the TEXT: the database can
-- hold the sha to the ledger, not the words to the sha.
--
-- Freshness, and the two locks that keep a put from landing after its sha has gone stale:
--   * pdf_regen_request (0015; every mark, policy change, link change and new original calls it,
--     in the change's own transaction) now locks its files' stored_file rows, in id order, and
--     deletes both audiences' page rows for them. search_page_put takes the same row lock first.
--     So a put that meets a change waits for it, then finds the ledger moved on and is refused;
--     and a change that meets a put waits for it, then deletes what the put wrote. Only files with
--     a stored original are locked: only they can have a copy, and they are the rows whose
--     pdf_regen entry the function already locked at the same point, so the lock order of every
--     caller is as it was.
--   * Both puts read the ledger's current row FOR SHARE. An append closes that row (an UPDATE), so
--     a put that meets an append waits for it and then no longer finds the row current; and an
--     append that meets a put waits for the put. The worker's own append (a new copy becomes
--     current) takes no file lock, and this is what holds a put against it.
--   * search_page_unservable (a trigger) deletes both audiences' page rows for an item's files when
--     its state or live version changes, for a version's when its visibility changes, and for an
--     edition's when it leaves published, under the same file locks, in the change's transaction.
--   * search_page_put takes the item's row lock (FOR KEY SHARE) before the file's. A withdrawal or a
--     publish locks the item first (FOR UPDATE: workflow.ts loadItem, load.ts findIssue) and the
--     trigger then locks the files, so a put that meets one waits for it on the item, and the two
--     never hold one lock each and wait for the other (40P01).
--   A row still outlives its sha when the ledger moves on WITHOUT pdf_regen_request (the worker
--   finishing a new copy): the read side must return a row only when its sha is the ledger's
--   current output (S3), and the worker replaces the rows after each copy (S2).
--   search_page_put must not be called in a transaction that already holds another file's lock.
--
-- ADDITIVE and forward-only. The API before S1 writes nothing here and runs unchanged on 0032;
-- pdf_regen_request keeps its signature, owner, grants and effect on pdf_regen and pdf_copy.

CREATE TABLE search_page_public (
  file_id       uuid     NOT NULL REFERENCES stored_file (id) ON DELETE CASCADE,
  -- The item of the file's version; NULL for an edition's file.
  item_id       uuid     REFERENCES content_item (id) ON DELETE CASCADE,
  page          integer  NOT NULL CHECK (page BETWEEN 1 AND 300),
  -- The sha256 of the copy the text was read from: the ledger's output when the row was put.
  served_sha256 bytea    NOT NULL CHECK (octet_length(served_sha256) = 32),
  text_version  integer  NOT NULL CHECK (text_version > 0),
  text          text     NOT NULL CHECK (octet_length(text) <= 65536),
  extra         text     NOT NULL CHECK (octet_length(extra) <= 65536),
  tsv           tsvector GENERATED ALWAYS AS (to_tsvector('english', text) || to_tsvector('english', extra)) STORED,
  PRIMARY KEY (file_id, page)
);
CREATE INDEX search_page_public_tsv ON search_page_public USING gin (tsv);

CREATE TABLE search_page_members (
  file_id       uuid     NOT NULL REFERENCES stored_file (id) ON DELETE CASCADE,
  item_id       uuid     REFERENCES content_item (id) ON DELETE CASCADE,
  page          integer  NOT NULL CHECK (page BETWEEN 1 AND 300),
  served_sha256 bytea    NOT NULL CHECK (octet_length(served_sha256) = 32),
  text_version  integer  NOT NULL CHECK (text_version > 0),
  text          text     NOT NULL CHECK (octet_length(text) <= 65536),
  extra         text     NOT NULL CHECK (octet_length(extra) <= 65536),
  tsv           tsvector GENERATED ALWAYS AS (to_tsvector('english', text) || to_tsvector('english', extra)) STORED,
  PRIMARY KEY (file_id, page)
);
CREATE INDEX search_page_members_tsv ON search_page_members USING gin (tsv);

-- One row per item: its live version, as the audience is given it.
CREATE TABLE search_item_public (
  item_id         uuid     PRIMARY KEY REFERENCES content_item (id) ON DELETE CASCADE,
  version_id      uuid     NOT NULL REFERENCES content_version (id) ON DELETE CASCADE,
  -- The ledger's output when the row was put: sha256 of the ContentItem the audience is given.
  rendered_sha256 bytea    NOT NULL CHECK (octet_length(rendered_sha256) = 32),
  title           text     NOT NULL CHECK (octet_length(title) <= 1024),
  -- 128 KiB keeps the tsvector under Postgres's 1 MiB limit whatever the words.
  text            text     NOT NULL CHECK (octet_length(text) <= 131072),
  tsv             tsvector GENERATED ALWAYS AS (to_tsvector('english', title) || to_tsvector('english', text)) STORED
);
CREATE INDEX search_item_public_tsv ON search_item_public USING gin (tsv);
CREATE INDEX search_item_public_version ON search_item_public (version_id);

CREATE TABLE search_item_members (
  item_id         uuid     PRIMARY KEY REFERENCES content_item (id) ON DELETE CASCADE,
  version_id      uuid     NOT NULL REFERENCES content_version (id) ON DELETE CASCADE,
  rendered_sha256 bytea    NOT NULL CHECK (octet_length(rendered_sha256) = 32),
  title           text     NOT NULL CHECK (octet_length(title) <= 1024),
  text            text     NOT NULL CHECK (octet_length(text) <= 131072),
  tsv             tsvector GENERATED ALWAYS AS (to_tsvector('english', title) || to_tsvector('english', text)) STORED
);
CREATE INDEX search_item_members_tsv ON search_item_members USING gin (tsv);
CREATE INDEX search_item_members_version ON search_item_members (version_id);

-- 0000's defaults gave the app role every row privilege: it keeps the read alone.
REVOKE ALL ON search_page_public, search_page_members, search_item_public, search_item_members FROM nwfl;
GRANT SELECT ON search_page_public, search_page_members, search_item_public, search_item_members TO nwfl;

-- servableFile (content/files.ts) as one predicate: whether it gives the audience (public or members) the file now.
-- servableFile answers null when:
--   * the file is not a PDF, or is neither a PDF of the live version of a published item that is not officers-only nor
--     one of a published edition (its SQL);
--   * for an item's PDF, itemHidden (content/redact.ts) holds:
--     - the version is posted on behalf of a member and the audience's member_name action is hide;
--     - lens.hidden (redaction/render.ts lensFor), over the item's active marks (redaction/lens.ts loadLens): a mark
--       whose category the audience hides; a whole-item mark it does not show; a file mark it redacts that is not
--       anchored in a PDF of this version; a passage mark it redacts whose quote is not in this version's texts.
-- An action is resolveAction's (redaction/policy.ts): a missing cell reads as hide (0012's CHECK lets no other action
-- be stored). The last test runs quoteMatches (folding, look-alikes, whole words) and cannot be written here. For it
-- the predicate reads the app's own answer: the ledger's current row for this version and audience, which
-- renderVersion (ledger/ledger.ts) records with no output exactly when itemHidden holds, and which every mark and policy
-- change records again in its own transaction (redaction/marks.ts, redaction/service.ts). No row, or no output: refused.
-- An invoker function with no grant: search_page_put, a definer, calls it as the owner.
CREATE FUNCTION search_file_servable(p_file uuid, p_audience text) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $fn$
  SELECT EXISTS (
    SELECT 1
      FROM stored_file f
      LEFT JOIN content_version v ON v.id = f.version_id
      LEFT JOIN content_item i ON i.live_version_id = v.id AND i.state = 'published' AND v.visibility <> 'officers'
      LEFT JOIN edition e ON e.id = f.edition_id AND e.status = 'published'
     WHERE f.id = p_file AND f.mime_type = 'application/pdf' AND (i.id IS NOT NULL OR e.id IS NOT NULL)
       AND (i.id IS NULL OR (
         NOT (v.on_behalf_of IS NOT NULL
              AND coalesce((SELECT p.action FROM redaction_policy p
                             WHERE p.tenant_id = 'nwflorida' AND p.audience = p_audience AND p.category = 'member_name'), 'hide') = 'hide')
         AND NOT EXISTS (
           SELECT 1
             FROM redaction_mark m
            CROSS JOIN LATERAL (
              SELECT coalesce((SELECT p.action FROM redaction_policy p
                                WHERE p.tenant_id = 'nwflorida' AND p.audience = p_audience AND p.category = m.category), 'hide') AS action) a
            WHERE m.tenant_id = 'nwflorida' AND m.status = 'active' AND m.content_item_id = i.id
              AND (a.action = 'hide'
                   OR (m.quote IS NULL AND a.action <> 'show')
                   OR (m.field = 'file' AND a.action = 'redact'
                       AND NOT EXISTS (SELECT 1 FROM redaction_mark_anchor x JOIN stored_file af ON af.id = x.file_id
                                        WHERE x.tenant_id = 'nwflorida' AND x.mark_id = m.id AND af.version_id = v.id))
                   OR (m.field <> 'file' AND a.action = 'redact'
                       AND NOT EXISTS (SELECT 1 FROM publication_ledger l
                                        WHERE l.tenant_id = 'nwflorida' AND l.subject_kind = 'content_version' AND l.subject_id = v.id
                                          AND l.audience = p_audience AND l.current_to IS NULL AND l.output_sha256 IS NOT NULL)))))))
$fn$;
REVOKE EXECUTE ON FUNCTION search_file_servable(uuid, text) FROM PUBLIC;

-- The worker's write: the pages of the copy this audience is served, replacing the file's rows.
CREATE FUNCTION search_page_put(p_file uuid, p_audience text, p_sha bytea, p_text_version integer, p_pages text[], p_extras text[])
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_file   stored_file;
  v_item   uuid;
  v_output bytea;
  v_served text;
  v_count  integer := coalesce(cardinality(p_pages), 0);
BEGIN
  IF p_audience IS NULL OR p_audience NOT IN ('public', 'members') THEN
    RAISE EXCEPTION 'the index is kept for the public and for members' USING ERRCODE = '22023';
  END IF;
  IF p_file IS NULL OR p_sha IS NULL OR p_text_version IS NULL OR p_text_version < 1 THEN
    RAISE EXCEPTION 'a put needs its file, the sha served and the text version' USING ERRCODE = '22023';
  END IF;
  IF v_count < 1 OR v_count > 300 OR array_ndims(p_pages) <> 1
     OR p_extras IS NULL OR array_ndims(p_extras) IS DISTINCT FROM 1 OR cardinality(p_extras) <> v_count THEN
    RAISE EXCEPTION 'a put is 1 to 300 pages, with an extra for each' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_pages, p_extras) AS u(page, extra)
              WHERE u.page IS NULL OR u.extra IS NULL OR octet_length(u.page) > 65536 OR octet_length(u.extra) > 65536)
     OR (SELECT sum(octet_length(u.page)::bigint + octet_length(u.extra)) FROM unnest(p_pages, p_extras) AS u(page, extra)) > 4194304 THEN
    RAISE EXCEPTION 'a page is at most 64 KiB, and a file 4 MiB in all' USING ERRCODE = '22023';
  END IF;
  -- The item's lock first, as a withdrawal or a publish takes it (FOR UPDATE, then the files): a put that meets one
  -- waits here, holding no file. KEY SHARE is what the page row's item_id reference takes on the INSERT below anyway.
  PERFORM 1 FROM content_item i JOIN content_version v ON v.item_id = i.id JOIN stored_file f ON f.version_id = v.id
    WHERE f.id = p_file FOR KEY SHARE OF i;
  -- The lock pdf_regen_request takes: a change to what this file's copies hold waits, or is waited for.
  SELECT * INTO v_file FROM stored_file WHERE id = p_file FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such file' USING ERRCODE = '22023';
  END IF;
  -- FOR SHARE: an append that is closing this row is waited for, and then the row is current no longer.
  SELECT l.output_sha256, l.inputs ->> 'served' INTO v_output, v_served FROM publication_ledger l
    WHERE l.tenant_id = 'nwflorida' AND l.subject_kind = 'stored_file' AND l.subject_id = p_file AND l.audience = p_audience
      AND l.current_to IS NULL
    FOR SHARE;
  IF NOT FOUND OR v_output IS DISTINCT FROM p_sha OR v_served IS DISTINCT FROM 'copy' THEN
    RAISE EXCEPTION 'the ledger does not say this audience is served this copy now' USING ERRCODE = '55000';
  END IF;
  -- What the audience may open now (search_file_servable). Read after the file lock, so a change that stops it either is
  -- seen here or waits for this put and then deletes its rows: search_page_unservable for an item, version or edition;
  -- pdf_regen_request for a mark or a policy change, whose ledger rows the app records in that transaction.
  IF NOT search_file_servable(p_file, p_audience) THEN
    RAISE EXCEPTION 'the audience may not open this file now' USING ERRCODE = '55000';
  END IF;
  SELECT v.item_id INTO v_item FROM content_version v WHERE v.id = v_file.version_id;
  IF p_audience = 'public' THEN
    DELETE FROM search_page_public WHERE file_id = p_file;
    INSERT INTO search_page_public (file_id, item_id, page, served_sha256, text_version, text, extra)
      SELECT p_file, v_item, u.n, p_sha, p_text_version, u.page, u.extra FROM unnest(p_pages, p_extras) WITH ORDINALITY AS u(page, extra, n);
  ELSE
    DELETE FROM search_page_members WHERE file_id = p_file;
    INSERT INTO search_page_members (file_id, item_id, page, served_sha256, text_version, text, extra)
      SELECT p_file, v_item, u.n, p_sha, p_text_version, u.page, u.extra FROM unnest(p_pages, p_extras) WITH ORDINALITY AS u(page, extra, n);
  END IF;
  RETURN v_count;
END
$fn$;

-- The app's write: an item's row as the ledger just recorded it, or its removal.
CREATE FUNCTION search_item_put(p_version uuid, p_audience text, p_sha bytea, p_title text, p_text text) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_item   uuid;
  v_output bytea;
BEGIN
  IF p_audience IS NULL OR p_audience NOT IN ('public', 'members') THEN
    RAISE EXCEPTION 'the index is kept for the public and for members' USING ERRCODE = '22023';
  END IF;
  IF p_version IS NULL THEN
    RAISE EXCEPTION 'a put needs its version' USING ERRCODE = '22023';
  END IF;
  -- No current row reads as an output of NULL: the audience is given nothing.
  SELECT l.output_sha256 INTO v_output FROM publication_ledger l
    WHERE l.tenant_id = 'nwflorida' AND l.subject_kind = 'content_version' AND l.subject_id = p_version AND l.audience = p_audience
      AND l.current_to IS NULL
    FOR SHARE;
  IF v_output IS DISTINCT FROM p_sha THEN
    RAISE EXCEPTION 'the ledger does not say this audience is given this output now' USING ERRCODE = '55000';
  END IF;
  IF p_sha IS NULL OR p_title IS NULL THEN
    IF p_audience = 'public' THEN
      DELETE FROM search_item_public WHERE version_id = p_version;
    ELSE
      DELETE FROM search_item_members WHERE version_id = p_version;
    END IF;
    RETURN false;
  END IF;
  IF p_text IS NULL OR octet_length(p_title) > 1024 OR octet_length(p_text) > 131072 THEN
    RAISE EXCEPTION 'a row is a title of at most 1 KiB and a text of at most 128 KiB' USING ERRCODE = '22023';
  END IF;
  SELECT v.item_id INTO v_item FROM content_version v WHERE v.id = p_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such version' USING ERRCODE = '22023';
  END IF;
  IF p_audience = 'public' THEN
    INSERT INTO search_item_public (item_id, version_id, rendered_sha256, title, text) VALUES (v_item, p_version, p_sha, p_title, p_text)
      ON CONFLICT (item_id) DO UPDATE SET version_id = EXCLUDED.version_id, rendered_sha256 = EXCLUDED.rendered_sha256,
                                          title = EXCLUDED.title, text = EXCLUDED.text;
  ELSE
    INSERT INTO search_item_members (item_id, version_id, rendered_sha256, title, text) VALUES (v_item, p_version, p_sha, p_title, p_text)
      ON CONFLICT (item_id) DO UPDATE SET version_id = EXCLUDED.version_id, rendered_sha256 = EXCLUDED.rendered_sha256,
                                          title = EXCLUDED.title, text = EXCLUDED.text;
  END IF;
  RETURN true;
END
$fn$;

REVOKE EXECUTE ON FUNCTION search_page_put(uuid, text, bytea, integer, text[], text[]), search_item_put(uuid, text, bytea, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION search_item_put(uuid, text, bytea, text, text) TO nwfl;
-- The app role runs the regeneration job until the worker role exists (0017); nwfl_worker_grants() moves it.
GRANT EXECUTE ON FUNCTION search_page_put(uuid, text, bytea, integer, text[], text[]) TO nwfl;

-- 0015's function, which also locks its files and deletes their page rows, for both audiences, in
-- the caller's transaction. Still an invoker function with no grant: its callers are the definer
-- triggers and functions of 0015, 0024 and 0025, which run as the owner.
CREATE OR REPLACE FUNCTION pdf_regen_request(p_files uuid[]) RETURNS void
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  PERFORM 1 FROM stored_file f
    WHERE f.id = ANY (p_files) AND EXISTS (SELECT 1 FROM pdf_original o WHERE o.file_id = f.id)
    ORDER BY f.id FOR NO KEY UPDATE OF f;
  DELETE FROM search_page_public WHERE file_id = ANY (p_files);
  DELETE FROM search_page_members WHERE file_id = ANY (p_files);
  INSERT INTO pdf_regen (file_id, generation)
    SELECT o.file_id, nextval('pdf_regen_generation') FROM pdf_original o WHERE o.file_id = ANY (p_files)
    ON CONFLICT (file_id) DO UPDATE SET generation = EXCLUDED.generation;
  UPDATE pdf_copy SET stale = true WHERE file_id = ANY (p_files) AND NOT stale;
END
$fn$;

-- A change that can stop an audience opening a file deletes both audiences' page rows for it, in the change's own
-- transaction: an item's state or live version (withdrawn, superseded, back to draft), a version's visibility, an
-- edition leaving published. The live version's visibility and an edition's status are frozen today (0029, 0011);
-- the trigger holds if that changes. It takes the file locks search_page_put takes, in id order, so a put either
-- waits for the change and is then refused, or is waited for and its rows deleted. A definer: the app role, which
-- makes these changes, may not write the page tables.
CREATE FUNCTION search_page_unservable() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_files uuid[];
BEGIN
  IF TG_TABLE_NAME = 'content_item' THEN
    v_files := ARRAY(SELECT f.id FROM stored_file f JOIN content_version v ON v.id = f.version_id WHERE v.item_id = NEW.id);
  ELSIF TG_TABLE_NAME = 'content_version' THEN
    v_files := ARRAY(SELECT f.id FROM stored_file f WHERE f.version_id = NEW.id);
  ELSE
    v_files := ARRAY(SELECT f.id FROM stored_file f WHERE f.edition_id = NEW.id);
  END IF;
  PERFORM 1 FROM stored_file f WHERE f.id = ANY (v_files) ORDER BY f.id FOR NO KEY UPDATE OF f;
  DELETE FROM search_page_public WHERE file_id = ANY (v_files);
  DELETE FROM search_page_members WHERE file_id = ANY (v_files);
  RETURN NULL;
END
$fn$;
REVOKE EXECUTE ON FUNCTION search_page_unservable() FROM PUBLIC;

CREATE TRIGGER content_item_search_pages AFTER UPDATE OF state, live_version_id ON content_item
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state OR OLD.live_version_id IS DISTINCT FROM NEW.live_version_id)
  EXECUTE FUNCTION search_page_unservable();
CREATE TRIGGER content_version_search_pages AFTER UPDATE OF visibility ON content_version
  FOR EACH ROW WHEN (OLD.visibility IS DISTINCT FROM NEW.visibility)
  EXECUTE FUNCTION search_page_unservable();
CREATE TRIGGER edition_search_pages AFTER UPDATE OF status ON edition
  FOR EACH ROW WHEN (OLD.status = 'published' AND NEW.status <> 'published')
  EXECUTE FUNCTION search_page_unservable();

-- 0025's function, with the page writer: the worker's alone once the role exists.
CREATE OR REPLACE FUNCTION nwfl_worker_grants() RETURNS boolean
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nwfl_worker') THEN
    RAISE NOTICE 'role nwfl_worker does not exist: the app role keeps the regeneration path; run SELECT nwfl_worker_grants() once it exists';
    RETURN false;
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO nwfl_worker', current_database());
  GRANT USAGE ON SCHEMA public TO nwfl_worker;
  -- inputsFor, renderFile and pdf_file_items (an invoker function).
  GRANT SELECT (id, audience, sha256, version_id, edition_id) ON stored_file TO nwfl_worker;
  GRANT SELECT (file_id) ON pdf_original TO nwfl_worker;
  GRANT SELECT (file_id, input_hash, status, bytes) ON pdf_copy TO nwfl_worker;
  GRANT SELECT (tenant_id, audience, category, action) ON redaction_policy TO nwfl_worker;
  GRANT SELECT (id, tenant_id, status, content_item_id, quote, category) ON redaction_mark TO nwfl_worker;
  GRANT SELECT (id, item_id) ON content_version TO nwfl_worker;
  GRANT SELECT (edition_id, item_id) ON edition_item TO nwfl_worker;
  -- inputsFor's links (LINKS L3): the active ones, as of a time.
  GRANT SELECT (id, file_id, page, rect, url, host, created_at) ON pdf_link TO nwfl_worker;
  GRANT SELECT (id, link_id, status, at) ON pdf_link_status TO nwfl_worker;
  GRANT EXECUTE ON FUNCTION pdf_regen_claim(integer), pdf_regen_original(uuid, uuid),
    pdf_copy_put(uuid, uuid, bytea, text, bytea, text, text[]), pdf_regen_finish(uuid, uuid, bytea[]), pdf_file_items(uuid),
    publication_ledger_lock(), publication_ledger_record_file(uuid, uuid, text, bytea, jsonb, integer),
    pdf_regen_request_files(uuid[]), search_page_put(uuid, text, bytea, integer, text[], text[]) TO nwfl_worker;
  REVOKE EXECUTE ON FUNCTION publication_ledger_record(text, uuid, text, bytea, jsonb, integer),
    search_item_put(uuid, text, bytea, text, text) FROM nwfl_worker;
  REVOKE EXECUTE ON FUNCTION pdf_regen_claim(integer), pdf_regen_original(uuid, uuid),
    pdf_copy_put(uuid, uuid, bytea, text, bytea, text, text[]), pdf_regen_finish(uuid, uuid, bytea[]),
    publication_ledger_original(bigint, text, text[], text),
    publication_ledger_record_file(uuid, uuid, text, bytea, jsonb, integer),
    pdf_regen_request_files(uuid[]), search_page_put(uuid, text, bytea, integer, text[], text[]) FROM nwfl;
  RETURN true;
END
$fn$;

SELECT nwfl_worker_grants();
