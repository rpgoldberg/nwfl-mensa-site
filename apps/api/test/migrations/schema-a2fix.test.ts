// A2-FIX: the challenger's findings on the schema, each pinned by a test.
// The workflow moves only along its allowed transitions, everything a decision
// rests on is frozen, history is append-only, and membership inputs are erased
// on every decision. Exercised as the APPLICATION role unless the owner is the
// point of the test.
import type pg from 'pg';
import pgLib from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP, APP_PW, dropDatabase, failure, freshDatabase, live, migrate, MIGRATOR, MIGRATOR_PW, sqlstate, urlFor } from '../helpers/pg.js';

const CHECK_VIOLATION = '23514';
const FK_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';
const INSUFFICIENT_PRIVILEGE = '42501';
const HASH = Buffer.alloc(32, 7);
const OTHER_HASH = Buffer.alloc(32, 9);

describe.skipIf(!live)('schema after A2-FIX', () => {
  let db: string;
  let app: pg.Client;
  let owner: pg.Client;
  let officeId: string;
  let otherOfficeId: string;
  let editionId: string;
  let n = 0;

  const one = async <T>(client: pg.Client, text: string, values: unknown[] = []): Promise<T> => (await client.query(text, values)).rows[0] as T;
  const office = async (slug: string): Promise<string> =>
    (await one<{ id: string }>(app, `INSERT INTO office (slug, title, kind) VALUES ($1, $1, 'elected') RETURNING id`, [slug])).id;
  const newItem = async (): Promise<string> =>
    (await one<{ id: string }>(app, `INSERT INTO content_item (slug, kind, office_id) VALUES ($1, 'article', $2) RETURNING id`, [`fix-${(n += 1)}`, officeId])).id;
  const newVersion = async (itemId?: string): Promise<{ itemId: string; id: string }> => {
    const item = itemId ?? (await newItem());
    const id = (
      await one<{ id: string }>(
        app,
        `INSERT INTO content_version (item_id, n, title, created_by_sub, acting_office_id)
         VALUES ($1, (SELECT coalesce(max(n), 0) + 1 FROM content_version WHERE item_id = $1), 'Title', 'sub-author', $2) RETURNING id`,
        [item, officeId],
      )
    ).id;
    return { itemId: item, id };
  };
  const toReady = (id: string): Promise<unknown> => app.query(`UPDATE content_version SET status = 'ready', content_hash = $2, ready_at = now() WHERE id = $1`, [id, HASH]);
  const toApproved = (id: string): Promise<unknown> =>
    app.query(
      `UPDATE content_version SET status = 'approved', approved_at = now(), approved_by_sub = 'sub-webmaster', approval_kind = 'normal',
         public_ast = '{"blocks": []}' WHERE id = $1`,
      [id],
    );
  const setStatus = (id: string, status: string): Promise<string> => failure(app, `UPDATE content_version SET status = $2 WHERE id = $1`, [id, status]);

  beforeAll(async () => {
    db = await freshDatabase('nwfl_a2fix');
    const run = await migrate(db);
    if (run.code !== 0) throw new Error(`migrate failed: ${run.stderr}`);
    app = new pgLib.Client({ connectionString: urlFor(APP, APP_PW, db) });
    owner = new pgLib.Client({ connectionString: urlFor(MIGRATOR, MIGRATOR_PW, db) });
    await app.connect();
    await owner.connect();
    officeId = await office('publications');
    otherOfficeId = await office('treasurer');
    editionId = (
      await one<{ id: string }>(app, `INSERT INTO edition (slug, title, kind, period_start, period_end) VALUES ('2027-02', 'T', 'regular', '2027-02-01', '2027-03-31') RETURNING id`)
    ).id;
  });

  afterAll(async () => {
    await app?.end();
    await owner?.end();
    if (db !== undefined) await dropDatabase(db);
  });

  describe('version transitions (the blocker)', () => {
    it('refuses approved -> draft, so an approved version can never be reopened, rewritten and re-approved', async () => {
      const { id } = await newVersion();
      await toReady(id);
      await toApproved(id);
      expect(await setStatus(id, 'draft')).toMatch(/cannot go from approved to draft/);
      expect(await setStatus(id, 'ready')).toMatch(/cannot go from approved to ready/);
      expect(await setStatus(id, 'discarded')).toMatch(/cannot go from approved to discarded/);
    });

    it('allows exactly the workflow moves', async () => {
      const a = (await newVersion()).id;
      expect(await setStatus(a, 'ready')).toMatch(/content_version_hash_once_ready/); // ready needs its hash
      await toReady(a);
      expect(await setStatus(a, 'draft')).toBe('ok'); // send back
      await toReady(a);
      await toApproved(a);
      expect(await setStatus(a, 'superseded')).toBe('ok');
      const b = (await newVersion()).id;
      expect(await setStatus(b, 'discarded')).toBe('ok');
      const c = (await newVersion()).id;
      await toReady(c);
      expect(await setStatus(c, 'discarded')).toBe('ok');
    });

    it('lets nothing leave superseded or discarded, and nothing skip ready', async () => {
      const superseded = (await newVersion()).id;
      await toReady(superseded);
      await toApproved(superseded);
      await setStatus(superseded, 'superseded');
      for (const to of ['draft', 'ready', 'approved', 'discarded']) expect(await setStatus(superseded, to), to).toMatch(/cannot go from superseded/);
      const discarded = (await newVersion()).id;
      await setStatus(discarded, 'discarded');
      for (const to of ['draft', 'ready', 'approved', 'superseded']) expect(await setStatus(discarded, to), to).toMatch(/cannot go from discarded/);
      const draft = (await newVersion()).id;
      expect(
        await failure(
          app,
          `UPDATE content_version SET status = 'approved', content_hash = $2, approved_at = now(), approved_by_sub = 'sub-w', approval_kind = 'normal', public_ast = '{"blocks": []}' WHERE id = $1`,
          [draft, HASH],
        ),
      ).toMatch(/cannot go from draft to approved/);
      const ready = (await newVersion()).id;
      await toReady(ready);
      expect(await setStatus(ready, 'superseded')).toMatch(/cannot go from ready to superseded/);
    });

    it('creates every version as a draft, so none starts life approved', async () => {
      const itemId = await newItem();
      expect(
        await failure(
          app,
          `INSERT INTO content_version (item_id, n, title, created_by_sub, acting_office_id, status, content_hash, approved_at, approved_by_sub, approval_kind, public_ast)
           VALUES ($1, 1, 'T', 'sub', $2, 'approved', $3, now(), 'sub-w', 'normal', '{"blocks": []}')`,
          [itemId, officeId, HASH],
        ),
      ).toMatch(/starts as a draft/);
    });
  });

  describe('item transitions', () => {
    const setState = (id: string, state: string, extra = ''): Promise<string> =>
      failure(app, `UPDATE content_item SET state = $2${extra} WHERE id = $1`, [id, state]);

    it('publishes only from ready, withdraws only a published item, and restores a withdrawn one to published', async () => {
      const { itemId, id } = await newVersion();
      expect(await setState(itemId, 'published')).toMatch(/cannot go from draft to published/);
      expect(await setState(itemId, 'withdrawn', ', withdrawn_at = now()')).toMatch(/cannot go from draft to withdrawn/);
      expect(await setState(itemId, 'ready')).toBe('ok');
      expect(await setState(itemId, 'draft')).toBe('ok');
      await setState(itemId, 'ready');
      await toReady(id);
      await toApproved(id);
      expect(await failure(app, `UPDATE content_item SET state = 'published', live_version_id = $2 WHERE id = $1`, [itemId, id])).toBe('ok');
      expect(await setState(itemId, 'draft')).toMatch(/cannot go from published to draft/);
      expect(await setState(itemId, 'ready')).toMatch(/cannot go from published to ready/);
      expect(await setState(itemId, 'withdrawn', ', withdrawn_at = now()')).toBe('ok');
      expect(await setState(itemId, 'draft', ', withdrawn_at = NULL')).toMatch(/cannot go from withdrawn to draft/);
      expect(await setState(itemId, 'published', ', withdrawn_at = NULL')).toBe('ok');
    });

    it('creates every item as a draft', async () => {
      expect(await failure(app, `INSERT INTO content_item (slug, kind, office_id, state) VALUES ('born-published', 'article', $1, 'ready')`, [officeId])).toMatch(
        /starts as a draft/,
      );
    });

    it('points an item only at an APPROVED version as its live one, and keeps a live version from being superseded', async () => {
      const { itemId, id } = await newVersion();
      expect(await sqlstate(app, `UPDATE content_item SET live_version_id = $2 WHERE id = $1`, [itemId, id])).toBe(FK_VIOLATION);
      await toReady(id);
      expect(await sqlstate(app, `UPDATE content_item SET live_version_id = $2 WHERE id = $1`, [itemId, id])).toBe(FK_VIOLATION);
      await toApproved(id);
      expect(await sqlstate(app, `UPDATE content_item SET live_version_id = $2 WHERE id = $1`, [itemId, id])).toBe('ok');
      expect(await sqlstate(app, `UPDATE content_version SET status = 'superseded' WHERE id = $1`, [id])).toBe(FK_VIOLATION);
      // The revision path: approve the next version, repoint live, then supersede the old one.
      const next = (await newVersion(itemId)).id;
      await toReady(next);
      await toApproved(next);
      expect(await sqlstate(app, `UPDATE content_item SET live_version_id = $2 WHERE id = $1`, [itemId, next])).toBe('ok');
      expect(await sqlstate(app, `UPDATE content_version SET status = 'superseded' WHERE id = $1`, [id])).toBe('ok');
    });
  });

  describe('every frozen column', () => {
    // [column, new value] for the authored columns, frozen from ready on.
    const AUTHORED: Array<[string, () => Promise<string> | string]> = [
      ['n', () => '99'],
      ['title', () => `'Changed'`],
      ['visibility', () => `'members'`],
      ['body_src', () => `'x'`],
      ['body_ast', () => `'{"blocks": [1]}'`],
      ['print_as_is', () => 'true'],
      ['created_by_sub', () => `'sub-other'`],
      ['acting_office_id', () => `'${otherOfficeId}'`],
      ['item_id', async () => `'${await newItem()}'`],
    ];
    // The decision columns, frozen once approved.
    const DECIDED: Array<[string, () => string]> = [
      ['content_hash', () => `'\\x${OTHER_HASH.toString('hex')}'`],
      ['target_website', () => 'false'],
      ['target_newsletter', () => 'false'],
      ['target_email', () => 'true'],
      ['edition_id', () => `'${editionId}'`],
      ['ready_at', () => `now() - interval '1 day'`],
      ['approved_at', () => `now() - interval '1 day'`],
      ['approved_by_sub', () => `'sub-other'`],
      ['approval_kind', () => `'self_breakglass'`],
      ['approval_reason', () => `'a reason'`],
      ['public_ast', () => `'{"blocks": [{"type": "redacted"}]}'`],
    ];

    it('freezes each authored column of a ready version', async () => {
      for (const [column, value] of AUTHORED) {
        const { id } = await newVersion();
        await toReady(id);
        expect(await failure(app, `UPDATE content_version SET ${column} = ${await value()} WHERE id = $1`, [id]), column).toMatch(/authored content is frozen/);
      }
    });

    it('freezes a NULL authored column in both directions (IS DISTINCT FROM, not <>)', async () => {
      const { id } = await newVersion();
      await app.query(`UPDATE content_version SET on_behalf_of = 'RVC, Region 10' WHERE id = $1`, [id]);
      await toReady(id);
      expect(await failure(app, `UPDATE content_version SET summary = 'now set' WHERE id = $1`, [id]), 'NULL -> value').toMatch(/frozen/);
      expect(await failure(app, `UPDATE content_version SET on_behalf_of = NULL WHERE id = $1`, [id]), 'value -> NULL').toMatch(/frozen/);
    });

    it('freezes each decision column once approved, and every column once superseded', async () => {
      for (const [column, value] of DECIDED) {
        const { id } = await newVersion();
        await toReady(id);
        await toApproved(id);
        expect(await failure(app, `UPDATE content_version SET ${column} = ${value()} WHERE id = $1`, [id]), column).toMatch(/is frozen/);
      }
      const { id } = await newVersion();
      await toReady(id);
      await toApproved(id);
      await setStatus(id, 'superseded');
      expect(await failure(app, `UPDATE content_version SET title = 'x' WHERE id = $1`, [id])).toMatch(/frozen/);
      expect(await failure(app, `UPDATE content_version SET target_email = true WHERE id = $1`, [id])).toMatch(/frozen/);
    });

    it('still lets the approver change targets and edition on a READY version (logged by the API)', async () => {
      const { id } = await newVersion();
      await toReady(id);
      expect(await failure(app, `UPDATE content_version SET target_email = true, edition_id = $2 WHERE id = $1`, [id, editionId])).toBe('ok');
    });
  });

  describe('trees are JSON objects', () => {
    it('refuses a public tree or a body that is JSON null, a string or an array', async () => {
      const { id } = await newVersion();
      await toReady(id);
      const approve = (ast: string): Promise<string> =>
        sqlstate(app, `UPDATE content_version SET status = 'approved', approved_at = now(), approved_by_sub = 'w', approval_kind = 'normal', public_ast = $2::jsonb WHERE id = $1`, [id, ast]);
      for (const ast of ['null', '"x"', '[]']) expect(await approve(ast), ast).toBe(CHECK_VIOLATION);
      const draft = (await newVersion()).id;
      for (const body of ['null', '"x"', '[]']) expect(await sqlstate(app, `UPDATE content_version SET body_ast = $2::jsonb WHERE id = $1`, [draft, body]), body).toBe(CHECK_VIOLATION);
    });

    it('needs an approval kind to approve', async () => {
      const { id } = await newVersion();
      await toReady(id);
      expect(
        await sqlstate(app, `UPDATE content_version SET status = 'approved', approved_at = now(), approved_by_sub = 'w', public_ast = '{"blocks": []}' WHERE id = $1`, [id]),
      ).toBe(CHECK_VIOLATION);
    });
  });

  describe('history is kept (D-P1, R25)', () => {
    it('makes content_version_editor append-only, and keeps any version that has editors', async () => {
      const { id } = await newVersion();
      await app.query(`INSERT INTO content_version_editor (version_id, subject) VALUES ($1, 'sub-author')`, [id]);
      expect(await sqlstate(app, `INSERT INTO content_version_editor (version_id, subject) VALUES ($1, 'sub-author')`, [id])).toBe(UNIQUE_VIOLATION);
      expect(await sqlstate(app, `UPDATE content_version_editor SET subject = 'sub-nobody' WHERE version_id = $1`, [id])).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await sqlstate(app, `DELETE FROM content_version_editor WHERE version_id = $1`, [id])).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await sqlstate(app, `DELETE FROM content_version WHERE id = $1`, [id])).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await sqlstate(owner, `DELETE FROM content_version WHERE id = $1`, [id])).toBe(FK_VIOLATION);
    });

    it('lets the database number and time each audit event, never the app', async () => {
      const insert = (columns: string, values: string): Promise<string> =>
        sqlstate(
          app,
          `INSERT INTO audit_event (${columns}actor_kind, action, subject_kind, subject_id) OVERRIDING SYSTEM VALUE VALUES (${values}'user', 'save', 'content_item', 'x')`,
        );
      expect(await insert('id, ', '-5, ')).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await insert('at, ', `'2020-01-01T00:00:00Z', `)).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await insert('', '')).toBe('ok');
      expect(await sqlstate(app, `INSERT INTO audit_event (trace_id, actor_kind, action, subject_kind, subject_id) VALUES ('not-a-trace', 'user', 'save', 'content_item', 'x')`)).toBe(
        CHECK_VIOLATION,
      );
    });

    it('keeps a membership number or a last name out of the audit payload under any spelling', async () => {
      const payload = (json: unknown): Promise<string> =>
        sqlstate(app, `INSERT INTO audit_event (actor_kind, action, subject_kind, subject_id, payload) VALUES ('user', 'save', 'content_item', 'x', $1::jsonb)`, [JSON.stringify(json)]);
      for (const key of ['membership_number', 'membershipNumber', 'Membership_Number', 'membership number', 'membershipNo', 'member-number', 'lastName', 'last_name', 'LastName'])
        expect(await payload({ before: [{ [key]: 'x' }] }), key).toBe(CHECK_VIOLATION);
      expect(await payload([])).toBe(CHECK_VIOLATION);
      expect(await payload({ verification: 'verified_local', name_changed: true, membership_status: 'member' })).toBe('ok');
    });
  });

  describe('edges the challenger found', () => {
    it('serves as an edition PDF only a public file of that same edition, and keeps it public', async () => {
      const edition = async (slug: string): Promise<string> =>
        (await one<{ id: string }>(app, `INSERT INTO edition (slug, title, kind, period_start, period_end) VALUES ($1, 'T', 'regular', '2027-01-01', '2027-01-31') RETURNING id`, [slug])).id;
      const [mine, theirs] = [await edition('2027-01'), await edition('2027-01-xtra')];
      const pdf = async (editionOf: string, audience: string, key: string): Promise<string> =>
        (
          await one<{ id: string }>(
            app,
            `INSERT INTO stored_file (edition_id, object_key, filename, mime_type, size_bytes, sha256, audience) VALUES ($1, $2, 'f.pdf', 'application/pdf', 10, $3, $4) RETURNING id`,
            [editionOf, key, HASH, audience],
          )
        ).id;
      const point = (fileId: string): Promise<string> => sqlstate(app, `UPDATE edition SET public_pdf_file_id = $2 WHERE id = $1`, [mine, fileId]);
      expect(await point(await pdf(mine, 'members', 'e/members'))).toBe(FK_VIOLATION);
      expect(await point(await pdf(theirs, 'public', 'e/theirs'))).toBe(FK_VIOLATION);
      const ok = await pdf(mine, 'public', 'e/public');
      expect(await point(ok)).toBe('ok');
      expect(await sqlstate(app, `UPDATE stored_file SET audience = 'members' WHERE id = $1`, [ok])).toBe(FK_VIOLATION);
      expect(await sqlstate(app, `INSERT INTO edition (slug, title, kind, period_start, period_end) VALUES ('Oct 2026', 'T', 'regular', '2026-10-01', '2026-10-31')`)).toBe(CHECK_VIOLATION);
      expect(await sqlstate(app, `INSERT INTO edition_calendar_range (edition_id, starts_on, ends_on) VALUES (gen_random_uuid(), '2027-01-01', '2027-01-31')`)).toBe(FK_VIOLATION);
    });

    it("gives a member's home no city and no link, and every other link https only (R3)", async () => {
      const host = await office('host-office');
      expect(await sqlstate(app, `INSERT INTO venue (kind, name, city, area, host_office_id) VALUES ('member_home', 'H', 'Niceville', 'okaloosa', $1)`, [host])).toBe(CHECK_VIOLATION);
      expect(await sqlstate(app, `INSERT INTO venue (kind, name, url, area, host_office_id) VALUES ('member_home', 'H', 'https://maps.example.org/x', 'okaloosa', $1)`, [host])).toBe(
        CHECK_VIOLATION,
      );
      expect(await sqlstate(app, `INSERT INTO venue (kind, name, area, host_office_id) VALUES ('member_home', 'H', 'okaloosa', $1)`, [host])).toBe('ok');
      expect(await sqlstate(app, `INSERT INTO venue (kind, name, url, area) VALUES ('business', 'B', 'http://plain.example.org', 'bay')`)).toBe(CHECK_VIOLATION);
      expect(await sqlstate(app, `INSERT INTO office (slug, title, kind, role_alias) VALUES ('two-aliases', 'A', 'elected', 'x@nwflorida.us,someone@example.com')`)).toBe(CHECK_VIOLATION);
    });

    it('orders dates and keeps one occurrence per series start', async () => {
      const series = await one<{ id: string }>(
        app,
        `INSERT INTO event_series (slug, title, category, recurrence, starts_on, area) VALUES ('fix-series', 'S', 'lunch', 'FREQ=WEEKLY', '2027-01-01', 'bay') RETURNING id`,
      );
      const at = '2027-03-01T17:00:00Z';
      expect(await sqlstate(app, `INSERT INTO event_occurrence (series_id, starts_at, visibility) VALUES ($1, $2, 'public')`, [series.id, at])).toBe('ok');
      expect(await sqlstate(app, `INSERT INTO event_occurrence (series_id, starts_at, visibility) VALUES ($1, $2, 'public')`, [series.id, at])).toBe(UNIQUE_VIOLATION);
      expect(await sqlstate(app, `INSERT INTO event_occurrence (title, starts_at, ends_at, visibility) VALUES ('T', $1, $1, 'public')`, [at])).toBe(CHECK_VIOLATION);
      expect(await sqlstate(app, `INSERT INTO office_term (office_id, starts_on, ends_on, status) VALUES ($1, '2027-01-02', '2027-01-01', 'vacant')`, [officeId])).toBe(CHECK_VIOLATION);
    });

    it('gives a one-off event an owning office that must exist (0008)', async () => {
      expect(await sqlstate(app, `INSERT INTO event_occurrence (title, starts_at, visibility, owner_office_id) VALUES ('Owned', now(), 'public', $1)`, [officeId])).toBe('ok');
      expect(await sqlstate(app, `INSERT INTO event_occurrence (title, starts_at, visibility, owner_office_id) VALUES ('Orphan', now(), 'public', gen_random_uuid())`)).toBe(FK_VIOLATION);
    });

    it('keeps one sign-up per subject and a plausible email', async () => {
      const signup = (sub: string, email: string): Promise<string> => sqlstate(app, `INSERT INTO signup_request (sub, display_name, email) VALUES ($1, 'P', $2)`, [sub, email]);
      expect(await signup('one-sub', 'p@example.org')).toBe('ok');
      expect(await signup('one-sub', 'p@example.org')).toBe(UNIQUE_VIOLATION);
      expect(await signup('two-sub', 'not an email')).toBe(CHECK_VIOLATION);
    });

    it('lets the app role create no temporary table, so nothing can shadow a real one', async () => {
      expect(await sqlstate(app, 'CREATE TEMP TABLE office (id int)')).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });

  describe('sign-up inputs are erased on every decision (R33)', () => {
    const insert = (sub: string): Promise<{ id: string }> =>
      one<{ id: string }>(app, `INSERT INTO signup_request (sub, display_name, last_name, email, membership_number) VALUES ($1, 'Pat', 'Example', 'pat@example.org', '7654321') RETURNING id`, [sub]);
    const decide = (id: string, decision: string, erase: boolean): Promise<string> =>
      sqlstate(
        app,
        `UPDATE signup_request SET decision = $2, decided_at = now(), decided_by_sub = 'sub-approver'${erase ? ', membership_number = NULL, last_name = NULL' : ''} WHERE id = $1`,
        [id, decision],
      );

    it.each(['approved', 'rejected'])('refuses an officer decision (%s) that keeps the number or the last name', async (decision) => {
      const { id } = await insert(`decided-${decision}`);
      expect(await decide(id, decision, false)).toBe(CHECK_VIOLATION);
      expect(await sqlstate(app, `UPDATE signup_request SET decision = $2, decided_at = now(), decided_by_sub = 's', membership_number = NULL WHERE id = $1`, [id, decision])).toBe(
        CHECK_VIOLATION,
      );
      expect(await decide(id, decision, true)).toBe('ok');
    });

    it('records who decided and when exactly when a decision is made, from a known list', async () => {
      const { id } = await insert('decided-fields');
      expect(await sqlstate(app, `UPDATE signup_request SET decision = 'approved', membership_number = NULL, last_name = NULL WHERE id = $1`, [id])).toBe(CHECK_VIOLATION);
      expect(await sqlstate(app, `UPDATE signup_request SET decided_at = now() WHERE id = $1`, [id])).toBe(CHECK_VIOLATION);
      expect(await decide(id, 'maybe', true)).toBe(CHECK_VIOLATION);
    });
  });
});
