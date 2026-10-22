// The schema the migrations build, exercised as the APPLICATION role wherever
// the app would act, so every rule is proven through the grants the service
// will actually hold. Each block names the requirement it guards.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP, APP_PW, dropDatabase, failure, freshDatabase, live, migrate, MIGRATOR, MIGRATOR_PW, sqlstate, urlFor } from '../helpers/pg.js';
import pgLib from 'pg';

const CHECK_VIOLATION = '23514';
const FK_VIOLATION = '23503';
const INSUFFICIENT_PRIVILEGE = '42501';
const HASH = Buffer.alloc(32, 7);

describe.skipIf(!live)('schema', () => {
  let db: string;
  let app: pg.Client;
  let owner: pg.Client;

  const one = async <T>(client: pg.Client, text: string, values: unknown[] = []): Promise<T> =>
    (await client.query(text, values)).rows[0] as T;

  const office = async (slug: string): Promise<string> =>
    (await one<{ id: string }>(app, `INSERT INTO office (slug, title, kind) VALUES ($1, $1, 'elected') RETURNING id`, [slug])).id;

  const item = async (slug: string, officeId: string): Promise<string> =>
    (await one<{ id: string }>(app, `INSERT INTO content_item (slug, kind, office_id) VALUES ($1, 'article', $2) RETURNING id`, [slug, officeId])).id;

  const version = async (itemId: string, officeId: string, n = 1): Promise<string> =>
    (
      await one<{ id: string }>(
        app,
        `INSERT INTO content_version (item_id, n, title, created_by_sub, acting_office_id) VALUES ($1, $2, 'A title', 'sub-author', $3) RETURNING id`,
        [itemId, n, officeId],
      )
    ).id;

  beforeAll(async () => {
    db = await freshDatabase('nwfl_schema');
    const run = await migrate(db);
    if (run.code !== 0) throw new Error(`migrate failed: ${run.stderr}`);
    app = new pgLib.Client({ connectionString: urlFor(APP, APP_PW, db) });
    owner = new pgLib.Client({ connectionString: urlFor(MIGRATOR, MIGRATOR_PW, db) });
    await app.connect();
    await owner.connect();
  });

  afterAll(async () => {
    await app?.end();
    await owner?.end();
    if (db !== undefined) await dropDatabase(db);
  });

  describe('two roles: the migrator owns, the app only reads and writes rows', () => {
    it('lets the app role read and write rows in the tables the migrator created', async () => {
      const id = await office('app-crud');
      expect(await sqlstate(app, `UPDATE office SET title = 'Renamed' WHERE id = $1`, [id])).toBe('ok');
      expect(await sqlstate(app, `DELETE FROM office WHERE id = $1`, [id])).toBe('ok');
    });

    it('refuses DDL from the app role', async () => {
      expect(await sqlstate(app, 'CREATE TABLE app_made (id int)')).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it('refuses TRUNCATE from the app role', async () => {
      expect(await sqlstate(app, 'TRUNCATE office')).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it('gives the app role nothing on the migration ledger', async () => {
      expect(await sqlstate(app, 'SELECT * FROM schema_migrations')).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });

  describe('audit_event is append-only (R25, P18)', () => {
    const insertAudit = (client: pg.Client, payload = '{}', subjectKind = 'content_item', note: string | null = null): Promise<string> =>
      sqlstate(
        client,
        `INSERT INTO audit_event (actor_kind, actor_sub, action, subject_kind, subject_id, note, payload)
         VALUES ('user', 'sub-1', 'save', $1, 'x', $2, $3::jsonb)`,
        [subjectKind, note, payload],
      );

    it('lets the app role insert and read', async () => {
      expect(await insertAudit(app)).toBe('ok');
      expect(await sqlstate(app, 'SELECT * FROM audit_event')).toBe('ok');
    });

    it('refuses UPDATE and DELETE from the app role at the grant level', async () => {
      expect(await sqlstate(app, `UPDATE audit_event SET action = 'tampered'`)).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await sqlstate(app, 'DELETE FROM audit_event')).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it('refuses UPDATE, DELETE and TRUNCATE even from the owner, by trigger', async () => {
      expect(await sqlstate(owner, `UPDATE audit_event SET action = 'tampered'`)).toBe('P0001');
      expect(await failure(owner, `UPDATE audit_event SET action = 'tampered'`)).toMatch(/append-only/);
      expect(await failure(owner, 'DELETE FROM audit_event')).toMatch(/append-only/);
      expect(await failure(owner, 'TRUNCATE audit_event')).toMatch(/append-only/);
      expect((await one<{ n: string }>(owner, 'SELECT count(*) AS n FROM audit_event')).n).not.toBe('0');
    });

    it('refuses a payload carrying a membership number at any depth (R33)', async () => {
      expect(await insertAudit(app, '{"membership_number": "123"}')).toBe(CHECK_VIOLATION);
      expect(await insertAudit(app, '{"before": {"row": {"membership_number": null}}}')).toBe(CHECK_VIOLATION);
      expect(await insertAudit(app, '{"rows": [{"membership_number": "1"}]}')).toBe(CHECK_VIOLATION);
      expect(await insertAudit(app, '{"verification": "verified_local"}')).toBe('ok');
    });

    it('refuses a free-text note on a membership record', async () => {
      expect(await insertAudit(app, '{}', 'signup_request', 'looked them up')).toBe(CHECK_VIOLATION);
      expect(await insertAudit(app, '{}', 'member_account', 'note')).toBe(CHECK_VIOLATION);
      expect(await insertAudit(app, '{}', 'content_version', 'Please fix the date')).toBe('ok');
    });
  });

  describe('signup_request: the membership number lives only until the verifier reports (R33)', () => {
    const insert = (values: { number?: string | null; verification?: string; verifiedOn?: string | null; lastName?: string | null }): Promise<string> =>
      sqlstate(
        app,
        `INSERT INTO signup_request (sub, display_name, last_name, email, membership_number, verification, verified_on)
         VALUES (gen_random_uuid()::text, 'Pat Example', $1, 'pat@example.org', $2, $3, $4::date)`,
        [values.lastName === undefined ? 'Example' : values.lastName, values.number ?? null, values.verification ?? 'unchecked', values.verifiedOn ?? null],
      );

    it('accepts an unchecked sign-up with or without a number', async () => {
      expect(await insert({ number: '1234567' })).toBe('ok');
      expect(await insert({ number: null, lastName: null })).toBe('ok');
    });

    it('refuses a number on a row whose verification is not unchecked', async () => {
      for (const verification of ['verified_local', 'verified_other_group', 'not_found', 'error']) {
        expect(await insert({ number: '1234567', verification, verifiedOn: '2026-10-22' }), verification).toBe(CHECK_VIOLATION);
        expect(await insert({ number: null, lastName: null, verification, verifiedOn: '2026-10-22' }), verification).toBe('ok');
      }
    });

    it('states the erasure rule as its own CHECK, not only as a consequence of the last-name rules', async () => {
      // The last-name constraints imply it today; this one must hold even if they change.
      const row = await one<{ def: string } | undefined>(
        app,
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'signup_request_number_erased_once_checked'`,
      );
      expect(row?.def).toBe(`CHECK (((membership_number IS NULL) OR (verification = 'unchecked'::text)))`);
    });

    it('lets the report land only by erasing the number and the last name in the same update', async () => {
      const { id } = await one<{ id: string }>(
        app,
        `INSERT INTO signup_request (sub, display_name, last_name, email, membership_number)
         VALUES ('sub-report', 'Pat', 'Example', 'pat@example.org', '7654321') RETURNING id`,
      );
      expect(await sqlstate(app, `UPDATE signup_request SET verification = 'verified_local', verified_on = current_date WHERE id = $1`, [id])).toBe(CHECK_VIOLATION);
      expect(
        await sqlstate(
          app,
          `UPDATE signup_request SET verification = 'verified_local', verified_on = current_date, membership_number = NULL WHERE id = $1`,
          [id],
        ),
      ).toBe(CHECK_VIOLATION);
      expect(
        await sqlstate(
          app,
          `UPDATE signup_request SET verification = 'verified_local', verified_on = current_date, membership_number = NULL, last_name = NULL WHERE id = $1`,
          [id],
        ),
      ).toBe('ok');
    });

    it('keeps verified_on set exactly when a verification has been reported', async () => {
      expect(await insert({ number: null, lastName: null, verification: 'not_found', verifiedOn: null })).toBe(CHECK_VIOLATION);
      expect(await insert({ number: '1234567', verifiedOn: '2026-10-22' })).toBe(CHECK_VIOLATION);
    });

    it('refuses anything but digits as a number, an unknown verification, and a number without a last name', async () => {
      expect(await insert({ number: '12 34' })).toBe(CHECK_VIOLATION);
      expect(await insert({ number: 'see notes' })).toBe(CHECK_VIOLATION);
      expect(await insert({ verification: 'approved' })).toBe(CHECK_VIOLATION);
      expect(await insert({ number: '1234567', lastName: null })).toBe(CHECK_VIOLATION);
    });
  });

  describe('member_account (R24, R33)', () => {
    const insert = (status: string, extra: { approver?: string; verifiedOn?: string; grantedBy?: string; removedAt?: string } = {}): Promise<string> =>
      sqlstate(
        app,
        `INSERT INTO member_account (sub, status, route, approved_by_sub, approved_at, verified_on, affiliate_granted_by_sub, affiliate_granted_at, removed_at)
         VALUES (gen_random_uuid()::text, $1, 'signup', $2, CASE WHEN $2::text IS NULL THEN NULL ELSE now() END, $3::date,
                 $4, CASE WHEN $4::text IS NULL THEN NULL ELSE now() END, $5::timestamptz)`,
        [status, extra.approver ?? null, extra.verifiedOn ?? null, extra.grantedBy ?? null, extra.removedAt ?? null],
      );

    it('takes exactly the five statuses', async () => {
      expect(await insert('pending')).toBe('ok');
      expect(await insert('member', { approver: 'sub-approver', verifiedOn: '2026-10-22' })).toBe('ok');
      expect(await insert('affiliate', { grantedBy: 'sub-admin' })).toBe('ok');
      expect(await insert('lapsed')).toBe('ok');
      expect(await insert('removed', { removedAt: '2026-10-22T12:00:00Z' })).toBe('ok');
      expect(await insert('verified')).toBe(CHECK_VIOLATION);
    });

    it('sets affiliate only with a recorded admin grant', async () => {
      expect(await insert('affiliate')).toBe(CHECK_VIOLATION);
    });

    it('makes a member only with an approver and a verification date', async () => {
      expect(await insert('member')).toBe(CHECK_VIOLATION);
      expect(await insert('member', { approver: 'sub-approver' })).toBe(CHECK_VIOLATION);
    });

    it('records removed_at exactly when removed', async () => {
      expect(await insert('removed')).toBe(CHECK_VIOLATION);
      expect(await insert('pending', { removedAt: '2026-10-22T12:00:00Z' })).toBe(CHECK_VIOLATION);
    });
  });

  describe('nothing National-sourced has a column (R13, P14)', () => {
    it('has no phone, birthday, Mensaversary or home-address column anywhere', async () => {
      const { rows } = await app.query<{ col: string }>(
        `SELECT table_name || '.' || column_name AS col FROM information_schema.columns
         WHERE table_schema = 'public' AND column_name ~ '(phone|birth|dob|mensaversary|home_address|street)'`,
      );
      expect(rows.map((r) => r.col)).toEqual([]);
    });

    it('gives the membership tables no free-text note or address column', async () => {
      const { rows } = await app.query<{ col: string }>(
        `SELECT table_name || '.' || column_name AS col FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name IN ('member_account', 'signup_request')
           AND column_name ~ '(note|comment|remark|reason|address)'`,
      );
      expect(rows.map((r) => r.col)).toEqual([]);
    });
  });

  describe('roster (R2)', () => {
    it('accepts only role aliases at nwflorida.us', async () => {
      expect(await sqlstate(app, `INSERT INTO office (slug, title, kind, role_alias) VALUES ('treasurer', 'Treasurer', 'elected', 'treasurer@nwflorida.us')`)).toBe('ok');
      expect(await sqlstate(app, `INSERT INTO office (slug, title, kind, role_alias) VALUES ('vp', 'VP', 'elected', 'pat@example.com')`)).toBe(CHECK_VIOLATION);
    });

    it('marks an alias verified only once it exists', async () => {
      expect(await sqlstate(app, `INSERT INTO office (slug, title, kind, role_alias_verified_on) VALUES ('editor', 'Editor', 'appointed', '2026-10-22')`)).toBe(CHECK_VIOLATION);
    });

    it('stores a vacancy as a term with no holder, and a filled term with one', async () => {
      const officeId = await office('membership');
      const term = (status: string, holder: string | null): Promise<string> =>
        sqlstate(app, `INSERT INTO office_term (office_id, holder_display_name, starts_on, status) VALUES ($1, $2, '2026-10-01', $3)`, [officeId, holder, status]);
      expect(await term('vacant', null)).toBe('ok');
      expect(await term('active', 'Pat Example')).toBe('ok');
      expect(await term('vacant', 'Pat Example')).toBe(CHECK_VIOLATION);
      expect(await term('active', null)).toBe(CHECK_VIOLATION);
      expect(await term('emeritus', 'Pat Example')).toBe(CHECK_VIOLATION);
    });
  });

  describe('venues and events (R3)', () => {
    it('never stores a street address for a member home, and needs its host office', async () => {
      const host = await office('vice-president');
      const venue = (kind: string, address: string | null, hostId: string | null): Promise<string> =>
        sqlstate(app, `INSERT INTO venue (kind, name, business_address, area, host_office_id) VALUES ($1, 'V', $2, 'okaloosa', $3)`, [kind, address, hostId]);
      expect(await venue('business', '123 Main St', null)).toBe('ok');
      expect(await venue('member_home', null, host)).toBe('ok');
      expect(await venue('member_home', '1 Home Ln', host)).toBe(CHECK_VIOLATION);
      expect(await venue('member_home', null, null)).toBe(CHECK_VIOLATION);
      expect(await venue('virtual', 'not a place', null)).toBe(CHECK_VIOLATION);
    });

    it('keeps area, category, status and visibility to their vocabularies', async () => {
      expect(await sqlstate(app, `INSERT INTO venue (kind, name, area) VALUES ('business', 'V', 'mobile')`)).toBe(CHECK_VIOLATION);
      const series = await one<{ id: string }>(
        app,
        `INSERT INTO event_series (slug, title, category, recurrence, area, visibility)
         VALUES ('happy-hour', 'Happy Hour', 'happy_hour', 'FREQ=MONTHLY;BYDAY=2FR', 'okaloosa', 'public') RETURNING id`,
      );
      const occurrence = (status: string, visibility: string): Promise<string> =>
        sqlstate(app, `INSERT INTO event_occurrence (series_id, starts_at, status, visibility) VALUES ($1, now() + random() * interval '300 days', $2, $3)`, [series.id, status, visibility]);
      for (const status of ['scheduled', 'tentative', 'cancelled', 'moved']) expect(await occurrence(status, 'members'), status).toBe('ok');
      expect(await occurrence('postponed', 'public')).toBe(CHECK_VIOLATION);
      expect(await occurrence('scheduled', 'officers')).toBe(CHECK_VIOLATION);
      expect(await sqlstate(app, `INSERT INTO event_series (slug, title, category, recurrence, area) VALUES ('x', 'X', 'lunch', 'every wednesday', 'bay')`)).toBe(CHECK_VIOLATION);
    });

    it('needs a title on a one-off event', async () => {
      expect(await sqlstate(app, `INSERT INTO event_occurrence (starts_at, visibility) VALUES (now(), 'public')`)).toBe(CHECK_VIOLATION);
      expect(await sqlstate(app, `INSERT INTO event_occurrence (title, starts_at, visibility) VALUES ('Picnic', now(), 'public')`)).toBe('ok');
    });
  });

  describe('content items and versions (R25, R26, P18)', () => {
    let officeId: string;
    beforeAll(async () => {
      officeId = await office('publications');
    });

    it('never lets an officers-only version target the newsletter or email', async () => {
      const itemId = await item('officers-only', officeId);
      const insert = (newsletter: boolean, email: boolean): Promise<string> =>
        sqlstate(
          app,
          `INSERT INTO content_version (item_id, n, title, created_by_sub, acting_office_id, visibility, target_newsletter, target_email)
           VALUES ($1, $2, 'T', 'sub', $3, 'officers', $4, $5)`,
          [itemId, newsletter ? 1 : email ? 2 : 3, officeId, newsletter, email],
        );
      expect(await insert(true, false)).toBe(CHECK_VIOLATION);
      expect(await insert(false, true)).toBe(CHECK_VIOLATION);
      expect(await insert(false, false)).toBe('ok');
    });

    it('needs a 32-byte content hash once a version is ready', async () => {
      const itemId = await item('hash-rule', officeId);
      const versionId = await version(itemId, officeId);
      expect(await sqlstate(app, `UPDATE content_version SET status = 'ready' WHERE id = $1`, [versionId])).toBe(CHECK_VIOLATION);
      expect(await sqlstate(app, `UPDATE content_version SET status = 'ready', content_hash = $2 WHERE id = $1`, [versionId, Buffer.alloc(16)])).toBe(CHECK_VIOLATION);
      expect(await sqlstate(app, `UPDATE content_version SET status = 'ready', content_hash = $2 WHERE id = $1`, [versionId, HASH])).toBe('ok');
    });

    it('freezes the authored content of a ready version; send back reopens it', async () => {
      const itemId = await item('freeze-rule', officeId);
      const versionId = await version(itemId, officeId);
      await app.query(`UPDATE content_version SET status = 'ready', content_hash = $2 WHERE id = $1`, [versionId, HASH]);
      expect(await failure(app, `UPDATE content_version SET title = 'Changed' WHERE id = $1`, [versionId])).toMatch(/frozen/);
      expect(await failure(app, `UPDATE content_version SET body_src = 'x' WHERE id = $1`, [versionId])).toMatch(/frozen/);
      // The approver may still change targets or edition before approving (logged by the API).
      expect(await sqlstate(app, `UPDATE content_version SET target_email = true WHERE id = $1`, [versionId])).toBe('ok');
      expect(await sqlstate(app, `UPDATE content_version SET status = 'draft' WHERE id = $1`, [versionId])).toBe('ok');
      expect(await sqlstate(app, `UPDATE content_version SET title = 'Changed' WHERE id = $1`, [versionId])).toBe('ok');
    });

    it('approves only with an approver, a time and a public tree, then freezes everything', async () => {
      const itemId = await item('approve-rule', officeId);
      const versionId = await version(itemId, officeId);
      await app.query(`UPDATE content_version SET status = 'ready', content_hash = $2 WHERE id = $1`, [versionId, HASH]);
      expect(await sqlstate(app, `UPDATE content_version SET status = 'approved' WHERE id = $1`, [versionId])).toBe(CHECK_VIOLATION);
      expect(
        await sqlstate(
          app,
          `UPDATE content_version SET status = 'approved', approved_at = now(), approved_by_sub = 'sub-webmaster', approval_kind = 'normal' WHERE id = $1`,
          [versionId],
        ),
      ).toBe(CHECK_VIOLATION);
      expect(
        await sqlstate(
          app,
          `UPDATE content_version SET status = 'approved', approved_at = now(), approved_by_sub = 'sub-webmaster', approval_kind = 'normal',
             public_ast = '{"blocks": []}' WHERE id = $1`,
          [versionId],
        ),
      ).toBe('ok');
      expect(await failure(app, `UPDATE content_version SET target_email = true WHERE id = $1`, [versionId])).toMatch(/frozen/);
      expect(await failure(app, `UPDATE content_version SET public_ast = '{"blocks": [1]}' WHERE id = $1`, [versionId])).toMatch(/frozen/);
      expect(await sqlstate(app, `UPDATE content_version SET status = 'superseded' WHERE id = $1`, [versionId])).toBe('ok');
    });

    it('needs a written reason for a break-glass self-approval', async () => {
      const itemId = await item('breakglass-rule', officeId);
      const versionId = await version(itemId, officeId);
      await app.query(`UPDATE content_version SET status = 'ready', content_hash = $2 WHERE id = $1`, [versionId, HASH]);
      const approve = (reason: string | null): Promise<string> =>
        sqlstate(
          app,
          `UPDATE content_version SET status = 'approved', approved_at = now(), approved_by_sub = 'sub-admin',
             approval_kind = 'self_breakglass', approval_reason = $2, public_ast = '{"blocks": []}' WHERE id = $1`,
          [versionId, reason],
        );
      expect(await approve(null)).toBe(CHECK_VIOLATION);
      expect(await approve('Webmaster away until Monday')).toBe('ok');
    });

    it('points an item only at its own versions, and needs a live version once published', async () => {
      const a = await item('owner-a', officeId);
      const b = await item('owner-b', officeId);
      const versionOfB = await version(b, officeId);
      expect(await sqlstate(app, `UPDATE content_item SET live_version_id = $2 WHERE id = $1`, [a, versionOfB])).toBe(FK_VIOLATION);
      expect(await sqlstate(app, `UPDATE content_item SET working_version_id = $2 WHERE id = $1`, [a, versionOfB])).toBe(FK_VIOLATION);
      expect(await sqlstate(app, `UPDATE content_item SET state = 'published' WHERE id = $1`, [a])).toBe(CHECK_VIOLATION);
      expect(await sqlstate(app, `UPDATE content_item SET state = 'withdrawn' WHERE id = $1`, [a])).toBe(CHECK_VIOLATION);
      expect(await sqlstate(app, `UPDATE content_item SET state = 'withdrawn', withdrawn_at = now() WHERE id = $1`, [a])).toBe('ok');
    });

    it('pins an edition item only to a version of that same item', async () => {
      const edition = await one<{ id: string }>(
        app,
        `INSERT INTO edition (slug, title, kind, period_start, period_end) VALUES ('2026-12', 'December 2026 and January 2027', 'regular', '2026-12-01', '2027-01-31') RETURNING id`,
      );
      const a = await item('pin-a', officeId);
      const b = await item('pin-b', officeId);
      const versionOfA = await version(a, officeId);
      expect(await sqlstate(app, `INSERT INTO edition_item (edition_id, item_id, version_id) VALUES ($1, $2, $3)`, [edition.id, b, versionOfA])).toBe(FK_VIOLATION);
      expect(await sqlstate(app, `INSERT INTO edition_item (edition_id, item_id, version_id) VALUES ($1, $2, $3)`, [edition.id, a, versionOfA])).toBe('ok');
    });
  });

  describe('files with an audience (R11, R26, D-P3)', () => {
    let versionId: string;
    const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    let n = 0;
    const file = (fields: { mime?: string; size?: number; audience?: string; role?: string; copyOf?: string | null }): Promise<string> =>
      sqlstate(
        app,
        `INSERT INTO stored_file (version_id, object_key, filename, mime_type, size_bytes, sha256, audience, role, public_copy_of)
         VALUES ($1, $2, 'f', $3, $4, $5, $6, $7, $8)`,
        [versionId, `k/${(n += 1)}`, fields.mime ?? 'application/pdf', fields.size ?? 1000, HASH, fields.audience ?? 'members', fields.role ?? 'primary', fields.copyOf ?? null],
      );

    beforeAll(async () => {
      const officeId = await office('secretary');
      versionId = await version(await item('with-files', officeId), officeId);
    });

    it('keeps a .docx and every source file officers-only', async () => {
      expect(await file({ mime: DOCX, audience: 'public' })).toBe(CHECK_VIOLATION);
      expect(await file({ mime: DOCX, audience: 'members' })).toBe(CHECK_VIOLATION);
      expect(await file({ mime: DOCX, audience: 'officers', role: 'source' })).toBe('ok');
      expect(await file({ role: 'source', audience: 'members' })).toBe(CHECK_VIOLATION);
    });

    it('pairs a public copy with its original, and makes it public', async () => {
      const original = await one<{ id: string }>(
        app,
        `INSERT INTO stored_file (version_id, object_key, filename, mime_type, size_bytes, sha256, audience)
         VALUES ($1, 'k/original', 'f', 'application/pdf', 10, $2, 'members') RETURNING id`,
        [versionId, HASH],
      );
      expect(await file({ role: 'public_copy', audience: 'public' })).toBe(CHECK_VIOLATION);
      expect(await file({ role: 'public_copy', audience: 'members', copyOf: original.id })).toBe(CHECK_VIOLATION);
      expect(await file({ role: 'primary', audience: 'members', copyOf: original.id })).toBe(CHECK_VIOLATION);
      expect(await file({ role: 'public_copy', audience: 'public', copyOf: original.id })).toBe('ok');
    });

    it('takes PDF, DOCX and images only, up to 10 MiB each', async () => {
      expect(await file({ mime: 'image/png' })).toBe('ok');
      expect(await file({ mime: 'text/html' })).toBe(CHECK_VIOLATION);
      expect(await file({ size: 10 * 1024 * 1024 })).toBe('ok');
      expect(await file({ size: 10 * 1024 * 1024 + 1 })).toBe(CHECK_VIOLATION);
      expect(await file({ audience: 'everyone' })).toBe(CHECK_VIOLATION);
    });

    it('belongs to exactly one owner: a version or an edition', async () => {
      expect(
        await sqlstate(
          app,
          `INSERT INTO stored_file (object_key, filename, mime_type, size_bytes, sha256, audience) VALUES ('k/orphan', 'f', 'application/pdf', 10, $1, 'public')`,
          [HASH],
        ),
      ).toBe(CHECK_VIOLATION);
    });
  });
});
