-- 0024_pdf_links.sql: the approved links of a stored PDF (LINKS L2).
--
-- The checker reads an issue's links off-cluster and Ross approves them by their hash; the
-- loaders bring the approved list here (src/load/links.ts). The server never reads a link from a
-- PDF. Three tables:
--
--   * pdf_link, one row per approved link, kept as written: its opaque id (26 lower-case base32
--     characters, minted at random by the checker), its file, page (1-based) and rect, its url
--     (an https URL in canonical form, or mailto:<address>), the url's host (checked against the
--     url here), its kind, whether Ross confirmed it by hand, and the approval it came under.
--   * pdf_link_status, appended to only: a link is active or disabled from the time of its
--     latest status. A status is written at its transaction's ledger stamp, under the ledger lock
--     (as marks are, 0016), so "as of T" reads the link set exactly as the ledger does: the latest
--     status at or before T (ties: the later id).
--   * pdf_copy_link, the links a stored copy holds. The worker writes it with its copy (L3); a
--     row names a ready copy and a link of that copy's own file, never changes, and goes only with
--     its copy (pdf_regen_finish dropping one cascades here).
--
-- Every link or status insert queues its file (pdf_regen_request), as a mark does (0015), so the
-- next copy carries the link, or carries it no longer.
--
-- Writers. The app role reads the three tables and writes none of them:
--   * pdf_links_attach is the one writer of links: for the issue loader alone
--     (system:issue-loader), to a stored PDF of a version it wrote, once per file, 1 to 500 links,
--     each object holding exactly id, page, rect, url, host, kind and confirm. It audits the
--     attach by count, reference and hash, never a URL. Like pdf_original_put (0015) this is a
--     trust, not a wall: the loader runs as the app role, and the database takes the sub the app
--     passes. A loader role of its own would need CREATEROLE, which only fc holds.
--   * pdf_link_disable only ever turns an active link off (LinkCheckService, L5), with a reason
--     code, and audits it. Turning a link back on is a new approval, never this function.
--
-- Left to L3, in 0025_pdf_links_worker.sql (SPEC D5a lists them here; they are the worker's and
-- ship with the worker code that uses them, so 0024 can be applied first):
--   * pdf_copy_put's seventh argument, the kept link ids, writing pdf_copy_link with the copy;
--   * pdf_regen_request_files(uuid[]), for the worker's boot sweep;
--   * a replaced nwfl_worker_grants(): SELECT on pdf_link and pdf_link_status and EXECUTE on the
--     new put and request functions for nwfl_worker. Until then the worker reads none of these
--     tables, and nwfl_worker_grants() is unchanged here.
--
-- Hosts and URLs (the shared links contract, CONTRACT.md, pinned in both parts by
-- test/load/fixtures/links-contract.json): a host is a DNS name in lower-case ASCII, never an IP
-- literal or a dotless name; a web link is https with no userinfo or port; a mail link is one
-- address with no query. The links hash the loaders store binds both files' sha256 (v 2).
--
-- The guards hold for every role's writes, the owner's too; the owner can disable or drop them
-- (0019).

CREATE TABLE pdf_link (
  id                 text             PRIMARY KEY CHECK (id ~ '^[a-z2-7]{26}$'),
  file_id            uuid             NOT NULL REFERENCES stored_file (id),
  page               integer          NOT NULL CHECK (page BETWEEN 1 AND 10000),
  -- [x1, y1, x2, y2] in PDF user space: finite (NaN and the infinities fail BETWEEN), within the
  -- largest page a PDF allows, and not empty.
  rect               double precision[] NOT NULL CHECK (
                       array_ndims(rect) = 1 AND array_lower(rect, 1) = 1 AND cardinality(rect) = 4
                       AND rect[1] BETWEEN -14400 AND 14400 AND rect[2] BETWEEN -14400 AND 14400
                       AND rect[3] BETWEEN -14400 AND 14400 AND rect[4] BETWEEN -14400 AND 14400
                       AND rect[1] < rect[3] AND rect[2] < rect[4]),
  url                text             NOT NULL CHECK (octet_length(url) <= 2048 AND url ~ '^[!-~]+$'),
  -- A DNS name (CONTRACT items 1-2, src/load/links.ts HOST): two labels or more, each 1 to 63
  -- lower-case letters, digits and inner hyphens, the last starting with a letter. So never an IP
  -- literal (v4, v6, decimal, octal or hex), a dotless name such as localhost, a trailing dot or an
  -- empty label.
  host               text             NOT NULL CONSTRAINT pdf_link_host CHECK (length(host) BETWEEN 4 AND 253
                       AND host ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'),
  kind               text             NOT NULL CHECK (kind IN ('web', 'mail')),
  confirm            boolean          NOT NULL,
  approval_reference text             NOT NULL CHECK (approval_reference ~ '^[A-Z][A-Z0-9-]{1,39}$'),
  links_sha256       bytea            NOT NULL CHECK (octet_length(links_sha256) = 32),
  created_by_sub     text             NOT NULL CHECK (created_by_sub <> ''),
  created_at         timestamptz      NOT NULL DEFAULT now(),
  -- A web link is https on exactly its host, a path following; a mail link one address at it, its
  -- domain exactly the host (so in lower case), with no query, fragment or escape (CONTRACT item 3).
  CONSTRAINT pdf_link_web CHECK (kind <> 'web' OR (
    left(url, 8 + length(host)) = 'https://' || host AND substr(url, 9 + length(host), 1) = '/')),
  CONSTRAINT pdf_link_mail CHECK (kind <> 'mail' OR (
    url ~ '^mailto:[^@?#%]+@[^@?#%]+$' AND substr(url, strpos(url, '@') + 1) = host))
);
CREATE INDEX pdf_link_file ON pdf_link (file_id);

CREATE TABLE pdf_link_status (
  id      bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  link_id text        NOT NULL REFERENCES pdf_link (id),
  status  text        NOT NULL CHECK (status IN ('active', 'disabled')),
  reason  text        NOT NULL CHECK (reason ~ '^[a-z][a-z0-9_]{1,39}$'),
  by_sub  text        NOT NULL CHECK (by_sub <> ''),
  at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pdf_link_status_link ON pdf_link_status (link_id, at, id);

CREATE TABLE pdf_copy_link (
  file_id    uuid  NOT NULL,
  input_hash bytea NOT NULL,
  link_id    text  NOT NULL REFERENCES pdf_link (id),
  PRIMARY KEY (file_id, input_hash, link_id),
  FOREIGN KEY (file_id, input_hash) REFERENCES pdf_copy (file_id, input_hash) ON DELETE CASCADE
);
CREATE INDEX pdf_copy_link_link ON pdf_copy_link (link_id);

REVOKE INSERT, UPDATE, DELETE ON pdf_link, pdf_link_status, pdf_copy_link FROM nwfl;
REVOKE ALL ON SEQUENCE pdf_link_status_id_seq FROM nwfl;

CREATE FUNCTION pdf_link_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  RAISE EXCEPTION 'a link is kept as written: % refused', TG_OP USING ERRCODE = '55000';
END
$fn$;
CREATE TRIGGER pdf_link_guard BEFORE UPDATE OR DELETE ON pdf_link FOR EACH ROW EXECUTE FUNCTION pdf_link_guard();
CREATE TRIGGER pdf_link_no_truncate BEFORE TRUNCATE ON pdf_link FOR EACH STATEMENT EXECUTE FUNCTION pdf_link_guard();

CREATE FUNCTION pdf_link_status_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  RAISE EXCEPTION 'pdf_link_status is append-only: % refused', TG_OP USING ERRCODE = '55000';
END
$fn$;
CREATE TRIGGER pdf_link_status_guard BEFORE UPDATE OR DELETE ON pdf_link_status FOR EACH ROW EXECUTE FUNCTION pdf_link_status_guard();
CREATE TRIGGER pdf_link_status_no_truncate BEFORE TRUNCATE ON pdf_link_status FOR EACH STATEMENT EXECUTE FUNCTION pdf_link_status_guard();

-- A row names a ready copy and a link of its own file; it is never changed, and is deleted only
-- once its copy is gone (the foreign key's cascade).
CREATE FUNCTION pdf_copy_link_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM pdf_copy c JOIN pdf_link l ON l.file_id = c.file_id
                    WHERE c.file_id = NEW.file_id AND c.input_hash = NEW.input_hash AND c.status = 'ready' AND l.id = NEW.link_id) THEN
      RAISE EXCEPTION 'a copy holds only a ready copy''s own file''s links' USING ERRCODE = '22023';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM pdf_copy WHERE file_id = OLD.file_id AND input_hash = OLD.input_hash) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'pdf_copy_link changes only with its copy: % refused', TG_OP USING ERRCODE = '55000';
END
$fn$;
CREATE TRIGGER pdf_copy_link_guard BEFORE INSERT OR UPDATE OR DELETE ON pdf_copy_link FOR EACH ROW EXECUTE FUNCTION pdf_copy_link_guard();
CREATE TRIGGER pdf_copy_link_no_truncate BEFORE TRUNCATE ON pdf_copy_link FOR EACH STATEMENT EXECUTE FUNCTION pdf_copy_link_guard();

-- A link is made, and a status written, at its transaction's stamp, under the ledger lock.
CREATE FUNCTION pdf_link_stamp() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF TG_TABLE_NAME = 'pdf_link' THEN
    NEW.created_at := publication_ledger_stamp();
  ELSE
    NEW.at := publication_ledger_stamp();
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER pdf_link_ledger_stamp BEFORE INSERT ON pdf_link FOR EACH ROW EXECUTE FUNCTION pdf_link_stamp();
CREATE TRIGGER pdf_link_status_ledger_stamp BEFORE INSERT ON pdf_link_status FOR EACH ROW EXECUTE FUNCTION pdf_link_stamp();

-- Every link or status insert queues its file, once per statement.
CREATE FUNCTION pdf_link_stale() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  PERFORM pdf_regen_request(ARRAY(SELECT DISTINCT file_id FROM added));
  RETURN NULL;
END
$fn$;
CREATE TRIGGER pdf_link_stale AFTER INSERT ON pdf_link REFERENCING NEW TABLE AS added
  FOR EACH STATEMENT EXECUTE FUNCTION pdf_link_stale();

CREATE FUNCTION pdf_link_status_stale() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  PERFORM pdf_regen_request(ARRAY(SELECT DISTINCT l.file_id FROM added s JOIN pdf_link l ON l.id = s.link_id));
  RETURN NULL;
END
$fn$;
CREATE TRIGGER pdf_link_status_stale AFTER INSERT ON pdf_link_status REFERENCING NEW TABLE AS added
  FOR EACH STATEMENT EXECUTE FUNCTION pdf_link_status_stale();

-- The one writer of links: one file's approved list, as the issue loader, once.
CREATE FUNCTION pdf_links_attach(p_file uuid, p_links jsonb, p_reference text, p_links_sha256 bytea, p_sub text, p_trace text)
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_file stored_file;
  v_n    integer;
BEGIN
  IF coalesce(p_sub, '') <> 'system:issue-loader' THEN
    RAISE EXCEPTION 'only the issue loader attaches links, to a file of a version it wrote' USING ERRCODE = '42501';
  END IF;
  -- Locked, so two attaches to one file cannot both find it without links.
  SELECT * INTO v_file FROM stored_file WHERE id = p_file FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such file' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM content_version WHERE id = v_file.version_id AND created_by_sub = p_sub) THEN
    RAISE EXCEPTION 'only the issue loader attaches links, to a file of a version it wrote' USING ERRCODE = '42501';
  END IF;
  IF v_file.mime_type <> 'application/pdf' OR NOT EXISTS (SELECT 1 FROM pdf_original WHERE file_id = p_file) THEN
    RAISE EXCEPTION 'links are attached only to a stored PDF' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM pdf_link WHERE file_id = p_file) THEN
    RAISE EXCEPTION 'a file''s links are attached once' USING ERRCODE = '55000';
  END IF;
  IF p_reference IS NULL OR p_reference !~ '^[A-Z][A-Z0-9-]{1,39}$' THEN
    RAISE EXCEPTION 'an approval reference is a reply tag' USING ERRCODE = '22023';
  END IF;
  IF octet_length(p_links_sha256) IS DISTINCT FROM 32 THEN
    RAISE EXCEPTION 'the links sha256 is 32 bytes' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_links) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'the links are a list of 1 to 500 objects' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_links) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'the links are a list of 1 to 500 objects' USING ERRCODE = '22023';
  END IF;
  -- Exactly the seven keys, each of its JSON type, so nothing is coerced or dropped on the way in.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_links) AS e(link)
              WHERE CASE WHEN jsonb_typeof(link) <> 'object' THEN true
                         ELSE ARRAY(SELECT k FROM jsonb_object_keys(link) AS k ORDER BY k) <> ARRAY['confirm', 'host', 'id', 'kind', 'page', 'rect', 'url']
                              OR jsonb_typeof(link -> 'id') <> 'string' OR jsonb_typeof(link -> 'page') <> 'number'
                              OR jsonb_typeof(link -> 'url') <> 'string' OR jsonb_typeof(link -> 'host') <> 'string'
                              OR jsonb_typeof(link -> 'kind') <> 'string' OR jsonb_typeof(link -> 'confirm') <> 'boolean'
                              OR jsonb_typeof(link -> 'rect') <> 'array'
                              OR (jsonb_typeof(link -> 'rect') = 'array'
                                  AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(link -> 'rect') = 'array' THEN link -> 'rect' ELSE '[]' END) AS r(n)
                                               WHERE jsonb_typeof(n) <> 'number'))
                    END) THEN
    RAISE EXCEPTION 'each link holds exactly id, page, rect, url, host, kind and confirm' USING ERRCODE = '22023';
  END IF;
  INSERT INTO pdf_link (id, file_id, page, rect, url, host, kind, confirm, approval_reference, links_sha256, created_by_sub)
    SELECT l.id, p_file, l.page, l.rect, l.url, l.host, l.kind, l.confirm, p_reference, p_links_sha256, p_sub
      FROM jsonb_to_recordset(p_links) AS l(id text, page integer, rect double precision[], url text, host text, kind text, confirm boolean);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  INSERT INTO pdf_link_status (link_id, status, reason, by_sub)
    SELECT l.id, 'active', 'attached', p_sub FROM jsonb_to_recordset(p_links) AS l(id text);
  PERFORM redaction_audit(p_sub, '{}', p_trace, 'pdf_links_attach', 'stored_file', p_file::text, NULL, 'attached',
    jsonb_build_object('links', v_n, 'reference', p_reference, 'links_sha256', encode(p_links_sha256, 'hex')));
  RETURN v_n;
END
$fn$;

-- Turns an active link off; false, changing nothing, when it is already off.
CREATE FUNCTION pdf_link_disable(p_link text, p_reason text, p_sub text, p_trace text) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  v_link   pdf_link;
  v_status text;
BEGIN
  IF coalesce(p_sub, '') = '' THEN
    RAISE EXCEPTION 'turning a link off needs who does it' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR p_reason !~ '^[a-z][a-z0-9_]{1,39}$' THEN
    RAISE EXCEPTION 'a reason is a code: lower-case letters, digits and underscores' USING ERRCODE = '22023';
  END IF;
  -- Locked, so two disables of one link append one status.
  SELECT * INTO v_link FROM pdf_link WHERE id = p_link FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such link' USING ERRCODE = '22023';
  END IF;
  SELECT status INTO v_status FROM pdf_link_status WHERE link_id = p_link ORDER BY at DESC, id DESC LIMIT 1;
  IF v_status = 'disabled' THEN
    RETURN false;
  END IF;
  INSERT INTO pdf_link_status (link_id, status, reason, by_sub) VALUES (p_link, 'disabled', p_reason, p_sub);
  PERFORM redaction_audit(p_sub, '{}', p_trace, 'pdf_link_disable', 'stored_file', v_link.file_id::text, 'active', 'disabled',
    jsonb_build_object('link_id', p_link, 'reason', p_reason));
  RETURN true;
END
$fn$;

REVOKE EXECUTE ON FUNCTION pdf_link_guard(), pdf_link_status_guard(), pdf_copy_link_guard(), pdf_link_stamp(), pdf_link_stale(),
  pdf_link_status_stale(), pdf_links_attach(uuid, jsonb, text, bytea, text, text), pdf_link_disable(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pdf_links_attach(uuid, jsonb, text, bytea, text, text), pdf_link_disable(text, text, text, text) TO nwfl;

COMMENT ON TRIGGER pdf_link_guard ON pdf_link IS
  'Keeps every link as written for every role''s writes, the owner''s too; the owner can disable or drop the trigger (0019).';
COMMENT ON TRIGGER pdf_link_no_truncate ON pdf_link IS
  'Refuses every role''s TRUNCATE, the owner''s too; the owner can disable or drop the trigger (0019).';
COMMENT ON TRIGGER pdf_link_status_guard ON pdf_link_status IS
  'Keeps the status history for every role''s writes, the owner''s too; the owner can disable or drop the trigger (0019).';
COMMENT ON TRIGGER pdf_link_status_no_truncate ON pdf_link_status IS
  'Refuses every role''s TRUNCATE, the owner''s too; the owner can disable or drop the trigger (0019).';
COMMENT ON TRIGGER pdf_copy_link_guard ON pdf_copy_link IS
  'Keeps a copy''s link list as written until its copy goes, for every role''s writes, the owner''s too; the owner can disable or drop the trigger (0019).';
COMMENT ON TRIGGER pdf_copy_link_no_truncate ON pdf_copy_link IS
  'Refuses every role''s TRUNCATE, the owner''s too; the owner can disable or drop the trigger (0019).';
