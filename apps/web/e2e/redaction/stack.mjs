// @ts-check
// The REAL API for the redaction leak test (REDACT R2b), never the stand-in:
// a fresh database in the throwaway Postgres (apps/api/scripts/test-db.sh),
// migrated by the API's own migrate.sh, seeded with random canary strings that
// the redaction policy or a mark withholds from the public, then the API's
// production entrypoint (apps/api/dist/main.js; run `npm run build` in
// apps/api first) with no token client at all, so every call is the public's.
//
// A PDF on a marked item carries a canary of its own and a marked phone
// (REDACT R3c); the stack is ready only once the PDF worker (dist/worker.js,
// as its own role nwfl_worker, W-WORKER) has made its copies, so the crawl
// fetches a redacted copy, never "not ready".
//
// Ready when GET /fixture on STACK_PORT answers: the canaries, the ids the
// test needs and how many times each canary is stored (the positive control:
// a canary that never reached the database would pass vacuously). On SIGTERM
// or SIGINT it stops the API and the worker it started and drops its database. Loopback only; the
// superuser password is read from the environment and never printed.
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import http from 'node:http';
import path from 'node:path';

const url = process.env['NWFL_TEST_DATABASE_URL'];
const container = process.env['NWFL_TEST_PG_CONTAINER'];
if (!url || !container) {
  console.error('redaction stack: start the throwaway Postgres first (apps/api/scripts/test-db.sh start) and export what it prints');
  process.exit(2);
}
const pg = new URL(url);
const apiPort = Number(process.env['API_PORT'] ?? 9101);
const healthPort = Number(process.env['API_HEALTH_PORT'] ?? 9102);
const stackPort = Number(process.env['STACK_PORT'] ?? 9103);
const API_MAIN = path.resolve(import.meta.dirname, '../../../api/dist/main.js');
// The PDF worker (W-WORKER): its own process and database role make the redacted copies.
const API_WORKER = path.resolve(import.meta.dirname, '../../../api/dist/worker.js');

// The roles the API's own test helpers use (apps/api/test/helpers/pg.ts); 0000_grants.sql names nwfl.
const MIGRATOR = { user: 'nwfl_migrator', password: 'migrator-pw' };
const APP = { user: 'nwfl', password: 'app-pw' };
const WORKER = { user: 'nwfl_worker', password: 'worker-pw' };
const db = `nwfl_redact_e2e_${randomBytes(4).toString('hex')}`;

/**
 * @param {string[]} args
 * @param {{ env?: Record<string, string>, input?: string }} [options]
 * @returns {Promise<string>}
 */
function docker(args, { env = {}, input } = {}) {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  return new Promise((resolve, reject) => {
    const child = execFile('docker', ['exec', '-i', ...envArgs, String(container), ...args], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`docker exec ${args[0]} failed: ${stderr || error.message}`));
      else resolve(stdout);
    });
    child.stdin?.end(input ?? '');
  });
}

/** psql inside the container, as the superuser, on stdin. @param {string} database @param {string} sql */
const psql = (database, sql) =>
  docker(['psql', '-h', '127.0.0.1', '-U', decodeURIComponent(pg.username), '-d', database, '-v', 'ON_ERROR_STOP=1', '-q', '-At'], {
    env: { PGPASSWORD: decodeURIComponent(pg.password) },
    input: sql,
  });

/** A SQL string literal. @param {string} s */
const q = (s) => `'${s.replaceAll("'", "''")}'`;
/** A JSON value as a jsonb literal. @param {unknown} v */
const j = (v) => `${q(JSON.stringify(v))}::jsonb`;

const canary = (/** @type {string} */ name) => `${name}${randomBytes(6).toString('hex')}`;
// The canaries: random, so none can already be in the site's code or content.
const hex = randomBytes(6).toString('hex');
const C = {
  // An accented name, in a marked title and in the item's slug (which the API must withhold).
  accentedName: `Zoë Quillfeather${hex}`,
  slugName: `zoe-quillfeather${hex}`,
  phone: canary('phone'),
  reportPhone: canary('reportphone'),
  byline: canary('byline'),
  whole: canary('whole'),
  email: canary('email'),
  occurrenceTitle: canary('occtitle'),
  address: canary('address'),
  detail: canary('detail'),
  eventUrl: canary('eventurl'),
  seriesTitle: canary('seriestitle'),
  seriesSlug: canary('seriesslug'),
  description: canary('description'),
  venueName: canary('venuename'),
  venueUrl: canary('venueurl'),
  homeName: canary('homename'),
  // In the PDF and, so that its mark anchors (a mark found in no field hides the item), in the body.
  pdfName: canary('pdfname'),
};

const ids = {
  president: randomUUID(),
  treasurer: randomUUID(),
  accented: randomUUID(),
  plain: randomUUID(),
  report: randomUUID(),
  whole: randomUUID(),
  hidden: randomUUID(),
  helpers: randomUUID(),
  bistro: randomUUID(),
  room: randomUUID(),
  home: randomUUID(),
  series: randomUUID(),
  games: randomUUID(),
  potluck: randomUUID(),
  online: randomUUID(),
  pdf: randomUUID(),
};
/** What the PDF says besides its canaries: the crawl's sign that it read the copy. */
const PDF_PLAIN = 'Bring a folding chair';

/**
 * A one-page PDF in Helvetica, its page drawn by a Flate-compressed content stream, with a correct
 * cross-reference table. Built by hand: the web app carries no PDF writer.
 * @param {string[]} lines
 */
function linesPdf(lines) {
  const esc = (/** @type {string} */ t) => t.replace(/[\\()]/g, '\\$&');
  const content = deflateSync(Buffer.from(lines.map((line, n) => `BT /F1 12 Tf 72 ${720 - 20 * n} Td (${esc(line)}) Tj ET`).join('\n'), 'latin1'));
  /** @type {Buffer[]} */
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
    Buffer.concat([Buffer.from(`<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`), content, Buffer.from('\nendstream')]),
  ];
  const header = Buffer.from('%PDF-1.7\n');
  const parts = [header];
  /** @type {number[]} */
  const offsets = [];
  let at = header.length;
  objects.forEach((body, i) => {
    offsets.push(at);
    const obj = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')]);
    parts.push(obj);
    at += obj.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`));
  return Buffer.concat(parts);
}

const PDF = linesPdf([`Receipts: call ${C.phone} by Friday.`, `Signed by ${C.pdfName} for the board.`, `${PDF_PLAIN} to the picnic.`]);
const PLAIN_SLUG = 'treasurer-plain-summary';

const para = (/** @type {string[]} */ ...texts) => ({ type: 'paragraph', children: texts.map((text) => ({ type: 'text', text })) });

/**
 * One published item, the way apps/api/test/helpers/content.ts publishes it: a version, ready with
 * its hash, approved with its public tree and search text, then live. A file is attached before
 * the version is approved (an approved version's files are frozen, 0011).
 * @param {{ id: string, slug: string, kind: string, office: string, title: string, summary?: string, body: unknown[], onBehalfOf?: string, daysAgo: number, file?: { id: string, bytes: Buffer } }} i
 */
function item(i) {
  const v = randomUUID();
  const body = { blocks: i.body };
  return `
INSERT INTO content_item (id, slug, kind, office_id) VALUES (${q(i.id)}, ${q(i.slug)}, ${q(i.kind)}, ${q(i.office)});
INSERT INTO content_version (id, item_id, n, title, summary, visibility, body_ast, created_by_sub, acting_office_id, target_newsletter, on_behalf_of)
  VALUES (${q(v)}, ${q(i.id)}, 1, ${q(i.title)}, ${i.summary ? q(i.summary) : 'NULL'}, 'public', ${j(body)}, 'sub-author', ${q(i.office)}, true, ${i.onBehalfOf ? q(i.onBehalfOf) : 'NULL'});
${
  i.file
    ? `INSERT INTO stored_file (id, version_id, object_key, filename, mime_type, size_bytes, sha256, audience)
  VALUES (${q(i.file.id)}, ${q(v)}, ${q(`files/${i.file.id}`)}, 'receipts.pdf', 'application/pdf', ${i.file.bytes.length}, decode(${q(createHash('sha256').update(i.file.bytes).digest('hex'))}, 'hex'), 'public');`
    : ''
}
UPDATE content_version SET status = 'ready', content_hash = sha256(convert_to(${q(JSON.stringify(body))}, 'UTF8')), ready_at = now() WHERE id = ${q(v)};
UPDATE content_version SET status = 'approved', approved_at = now() - interval '${i.daysAgo} days', approved_by_sub = 'sub-webmaster', approval_kind = 'normal',
  public_ast = ${j(body)}, search_public = to_tsvector('english', ${q(i.title)}), search_members = to_tsvector('english', ${q(i.title)}) WHERE id = ${q(v)};
UPDATE content_item SET state = 'ready' WHERE id = ${q(i.id)};
UPDATE content_item SET state = 'published', live_version_id = ${q(v)} WHERE id = ${q(i.id)};`;
}

/** A mark, through the API's own writer (0014), as an officer. @param {string} kind @param {string} subject @param {string | null} field @param {string | null} quote @param {string} category */
const mark = (kind, subject, field, quote, category) =>
  `SELECT 1 FROM redaction_mark_add(${q(kind)}, ${q(subject)}, ${field ? q(field) : 'NULL'}, ${quote ? q(quote) : 'NULL'}, ${q(category)}, 'sub-officer', ARRAY['nwfl-members', 'nwfl-officers'], '0af7651916cd43dd8448eb211c80319c');`;

const SEED = `
BEGIN;
INSERT INTO office (id, slug, title, kind, sort_order, role_alias, role_alias_verified_on) VALUES
  (${q(ids.president)}, 'president', 'President', 'elected', 1, 'president@nwflorida.us', current_date),
  (${q(ids.treasurer)}, 'treasurer', 'Treasurer', 'elected', 4, NULL, NULL);
INSERT INTO office_term (office_id, holder_display_name, starts_on, status) VALUES
  (${q(ids.president)}, 'Alex Sample', '2026-01-01', 'active'),
  (${q(ids.treasurer)}, 'Riley Testcase', '2026-01-01', 'active');
${item({ id: ids.accented, slug: `${C.slugName}-q3`, kind: 'treasurer_summary', office: ids.treasurer, title: `Report by ${C.accentedName}`, body: [para(`Receipts: call ${C.phone} by Friday.`), para(`Signed by ${C.pdfName}.`)], daysAgo: 2, file: { id: ids.pdf, bytes: PDF } })}
${item({ id: ids.plain, slug: PLAIN_SLUG, kind: 'treasurer_summary', office: ids.treasurer, title: 'April to June', body: [para('Closing balance: $2,543.10')], daysAgo: 90 })}
${item({ id: ids.report, slug: 'president-report', kind: 'president_report', office: ids.president, title: 'A busy autumn', onBehalfOf: `${C.byline}, guest writer`, body: [para(`Rides to the picnic: call ${C.reportPhone} any evening.`)], daysAgo: 1 })}
${item({ id: ids.whole, slug: 'remembering-a-friend', kind: 'announcement', office: ids.president, title: 'Remembering a friend', body: [para(`Words by ${C.whole}`)], daysAgo: 1 })}
${item({ id: ids.hidden, slug: 'mailing-list', kind: 'announcement', office: ids.president, title: 'Mailing list', body: [para(`Write to ${C.email} to join.`)], daysAgo: 2 })}
${item({ id: ids.helpers, slug: 'helpers-wanted', kind: 'announcement', office: ids.president, title: 'Helpers wanted', body: [para('The picnic needs two more helpers.')], daysAgo: 3 })}
INSERT INTO venue (id, kind, name, business_address, city, area) VALUES (${q(ids.bistro)}, 'business', 'Sample Bistro', '100 Example Way', 'Destin', 'okaloosa');
INSERT INTO venue (id, kind, name, area, url, host_office_id) VALUES (${q(ids.room)}, 'virtual', ${q(`Room ${C.venueName}`)}, 'virtual', ${q(`https://example.org/${C.venueUrl}`)}, ${q(ids.president)});
INSERT INTO venue (id, kind, name, area, host_office_id) VALUES (${q(ids.home)}, 'member_home', ${q(`The ${C.homeName} home`)}, 'okaloosa', ${q(ids.president)});
INSERT INTO event_series (id, slug, title, category, recurrence, starts_on, default_start, default_duration_minutes, area, host_office_id, description, default_venue_id, cadence_label)
  VALUES (${q(ids.series)}, ${q(C.seriesSlug)}, ${q(`Coffee with ${C.seriesTitle}`)}, 'other', 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU', current_date - 7, '10:00', 60, 'bay', ${q(ids.president)},
          ${q(`Ask for ${C.description} at the door.`)}, ${q(ids.room)}, 'Every day');
INSERT INTO event_occurrence (id, title, starts_at, visibility, venue_id, status, status_note, detail, url, owner_office_id) VALUES
  (${q(ids.games)}, ${q(`Games night with ${C.occurrenceTitle}`)}, date_trunc('day', now()) + interval '2 days 23 hours', 'public', ${q(ids.bistro)}, 'moved',
   ${q(`Meet at ${C.address} instead.`)}, ${q(`Bring ${C.detail} and a snack.`)}, ${q(`https://example.org/${C.eventUrl}`)}, ${q(ids.president)}),
  (${q(ids.potluck)}, 'Potluck', date_trunc('day', now()) + interval '3 days 23 hours', 'public', ${q(ids.home)}, 'scheduled', NULL, NULL, NULL, ${q(ids.president)}),
  (${q(ids.online)}, 'Online chat', date_trunc('day', now()) + interval '4 days 23 hours', 'public', ${q(ids.room)}, 'scheduled', NULL, NULL, NULL, ${q(ids.president)});
${mark('content_item', ids.accented, 'title', C.accentedName, 'member_name')}
${mark('content_item', ids.accented, 'body', C.phone, 'member_phone')}
${mark('content_item', ids.accented, 'body', C.pdfName, 'member_name')}
-- The PDF's original, through the API's own writer (0015), which queues its copies.
SELECT pdf_original_put(${q(ids.pdf)}, decode(${q(PDF.toString('hex'))}, 'hex'), 'sub-officer', ARRAY['nwfl-members', 'nwfl-officers'], NULL);
${mark('content_item', ids.report, 'body', C.reportPhone, 'member_phone')}
${mark('content_item', ids.report, 'on_behalf_of', C.byline, 'member_name')}
${mark('content_item', ids.whole, null, null, 'member_name')}
${mark('content_item', ids.hidden, 'body', C.email, 'member_email')}
${mark('event_occurrence', ids.games, 'title', C.occurrenceTitle, 'member_name')}
${mark('event_occurrence', ids.games, 'status_note', C.address, 'member_address')}
${mark('event_occurrence', ids.games, 'detail', C.detail, 'member_phone')}
${mark('event_occurrence', ids.games, 'url', C.eventUrl, 'member_address')}
${mark('event_series', ids.series, 'title', C.seriesTitle, 'member_name')}
${mark('event_series', ids.series, 'description', C.description, 'member_phone')}
-- A tightening applies at once: the public no longer gets an item with a marked email at all.
SELECT 1 FROM redaction_propose('nwflorida', 'public', 'member_email', 'hide', 'sub-officer', ARRAY['nwfl-members', 'nwfl-officers'], '0af7651916cd43dd8448eb211c80319c');
COMMIT;
`;

/** How many times each canary is stored, anywhere in the seeded tables. */
async function stored() {
  const tables = ['content_item', 'content_version', 'venue', 'event_series', 'event_occurrence', 'redaction_mark'];
  /** @type {Record<string, number>} */
  const out = {};
  for (const [key, value] of Object.entries(C)) {
    const sql = tables.map((t) => `SELECT count(*) FROM ${t} x WHERE position(lower(${q(value)}) in lower(x::text)) > 0`).join(' UNION ALL ');
    const counts = (await psql(db, `SELECT sum(count) FROM (${sql}) s;`)).trim();
    out[key] = Number(counts);
  }
  // The PDF's text is compressed in the file: its canaries are counted in the stored original's bytes, as written.
  const original = (await psql(db, `SELECT encode(bytes, 'hex') FROM pdf_original WHERE file_id = ${q(ids.pdf)};`)).trim();
  if (Buffer.from(original, 'hex').equals(PDF)) for (const key of ['phone', 'pdfName']) out[key] = (out[key] ?? 0) + 1;
  return out;
}

/** @type {import('node:child_process').ChildProcess | undefined} */
let api;
/** @type {import('node:child_process').ChildProcess | undefined} */
let worker;
let stopping = false;

/** SIGTERM to a child this script spawned (by its handle, never by name), then wait up to 5 s. @param {import('node:child_process').ChildProcess | undefined} child */
async function end(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
}

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  await Promise.all([end(worker), end(api)]);
  await psql('postgres', `DROP DATABASE IF EXISTS ${db} WITH (FORCE);`).catch((error) => console.error(String(error)));
  process.exit(code);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());

async function waitReady() {
  for (let tries = 0; tries < 100; tries++) {
    if (api?.exitCode !== null) throw new Error(`the API exited (${api?.exitCode})`);
    const ok = await new Promise((resolve) => {
      http.get(`http://127.0.0.1:${healthPort}/readyz`, (res) => resolve(res.statusCode === 200)).on('error', () => resolve(false));
    });
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('the API never became ready');
}

try {
  await psql(
    'postgres',
    `DO $$ BEGIN CREATE ROLE ${MIGRATOR.user} LOGIN PASSWORD ${q(MIGRATOR.password)}; EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $$;
     DO $$ BEGIN CREATE ROLE ${APP.user} LOGIN PASSWORD ${q(APP.password)}; EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $$;
     DO $$ BEGIN CREATE ROLE ${WORKER.user} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 10 PASSWORD ${q(WORKER.password)};
       EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $$;
     CREATE DATABASE ${db} OWNER ${MIGRATOR.user};`,
  );
  await docker(['sh', '/repo/scripts/migrate.sh', '/repo/migrations'], {
    env: { PGHOST: '127.0.0.1', PGUSER: MIGRATOR.user, PGPASSWORD: MIGRATOR.password, PGDATABASE: db },
  });
  // 0017 granted the worker when the role already existed; the explicit call is what fc runs after creating it.
  await docker(['psql', '-h', '127.0.0.1', '-U', MIGRATOR.user, '-d', db, '-v', 'ON_ERROR_STOP=1', '-q', '-At', '-c', 'SELECT nwfl_worker_grants()'], {
    env: { PGPASSWORD: MIGRATOR.password },
  });
  await psql(db, SEED);
  const counts = await stored();

  const dsn = new URL(url);
  dsn.username = APP.user;
  dsn.password = APP.password;
  dsn.pathname = `/${db}`;
  api = spawn(process.execPath, [API_MAIN], {
    env: {
      PATH: process.env['PATH'] ?? '',
      DATABASE_URL: dsn.toString(),
      HOST: '127.0.0.1',
      GRPC_PORT: String(apiPort),
      HEALTH_PORT: String(healthPort),
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  api.once('exit', (code) => {
    if (!stopping) {
      console.error(`redaction stack: the API exited (${code})`);
      void stop(1);
    }
  });
  await waitReady();
  const workerDsn = new URL(dsn);
  workerDsn.username = WORKER.user;
  workerDsn.password = WORKER.password;
  worker = spawn(process.execPath, [API_WORKER], {
    env: { PATH: process.env['PATH'] ?? '', DATABASE_URL: workerDsn.toString(), LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  worker.once('exit', (code) => {
    if (!stopping) {
      console.error(`redaction stack: the PDF worker exited (${code})`);
      void stop(1);
    }
  });
  // The worker makes the PDF's copies; the crawl starts once none is queued and the public's is made.
  for (let tries = 0; ; tries++) {
    const state = (await psql(db, `SELECT (SELECT count(*) FROM pdf_regen) || ' ' || (SELECT count(*) FROM pdf_copy WHERE file_id = ${q(ids.pdf)} AND status = 'ready');`)).trim();
    if (state.startsWith('0 ') && Number(state.split(' ')[1]) > 0) break;
    if (tries >= 120) throw new Error(`the PDF's copies were never made (${state})`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // The original too, so the test can show its PDF check finds the canaries in it.
  const fixture = JSON.stringify({ canaries: C, ids, plainSlug: PLAIN_SLUG, pdfPlain: PDF_PLAIN, pdfOriginal: PDF.toString('base64'), stored: counts });
  http
    .createServer((req, res) => {
      if (req.url !== '/fixture') {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(fixture);
    })
    .listen(stackPort, '127.0.0.1', () => console.log(JSON.stringify({ msg: 'redaction stack ready', db, apiPort, stackPort })));
} catch (error) {
  console.error(`redaction stack: ${error instanceof Error ? error.message : String(error)}`);
  await stop(1);
}
