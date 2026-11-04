// SOLO-APPROVE (0023): the Admin's switch between two-person and one-approver approval, per scope
// (content, and loosening a public redaction setting), held in the database: who may flip it, the
// flip ledger, the content four-eyes backstop, the redaction functions under each rule, the
// backfill, the freeze, and the lock order. Exercised as the APPLICATION role unless the owner is
// the point of the test. Every name is made up.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pgLib from 'pg';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP, APP_PW, dockerExec, dropDatabase, failure, freshDatabase, live, migrate, MIGRATOR, MIGRATOR_PW, sqlstate, urlFor } from '../helpers/pg.js';

const PRIVILEGE = '42501';
const STATE = '55000';
const CHECK = '23514';
const BAD_VALUE = '22023';
const HASH = Buffer.alloc(32, 7);
const ADMIN = { sub: 'sub-admin', groups: ['nwfl-members', 'nwfl-officers', 'nwfl-admin'] };
const OFFICER = { sub: 'sub-officer', groups: ['nwfl-members', 'nwfl-officers'] };
const OTHER = { sub: 'sub-other', groups: ['nwfl-members', 'nwfl-officers'] };
const SET = `SELECT rule, set_at, changed FROM approval_rule_set($1, $2, $3, $4, $5, $6)`;
/** With the revision the Admin read (the change_id that set the rule; '' while the default). */
const SET_EXPECTING = `SELECT rule, set_at, change_id, changed FROM approval_rule_set($1, $2, $3, $4, $5, NULL, $6)`;
const PROPOSE = `SELECT * FROM redaction_propose('nwflorida', $1, $2, $3, $4, $5, NULL)`;
const APPROVE = `SELECT * FROM redaction_approve($1, $2, $3, NULL)`;
const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

describe.skipIf(!live)('0023: SOLO-APPROVE', () => {
  let db: string;
  let app: pg.Client;
  let owner: pg.Client;
  let officeId: string;
  let n = 0;

  const connect = async (user: string, password: string, database = db): Promise<pg.Client> => {
    const client = new pgLib.Client({ connectionString: urlFor(user, password, database) });
    await client.connect();
    return client;
  };
  const one = async <T>(client: pg.Client, text: string, values: unknown[] = []): Promise<T> => (await client.query(text, values)).rows[0] as T;
  const flip = (scope: string, rule: string, reason = 'The Webmaster is away', who = ADMIN, client = app): Promise<{ rule: string; set_at: Date; changed: boolean }> =>
    one(client, SET, [scope, rule, reason, who.sub, who.groups, null]);
  const ruleOf = async (scope: string): Promise<string> => (await one<{ rule: string }>(app, `SELECT rule FROM approval_rule WHERE scope = $1`, [scope])).rule;
  /** The revision an Admin reading the setting now would see: the flip that set it, '' for the default. */
  const revision = async (scope: string): Promise<string> =>
    (await one<{ rev: string }>(app, `SELECT coalesce(change_id::text, '') AS rev FROM approval_rule WHERE scope = $1`, [scope])).rev;
  const count = async (table: string, where = 'true', values: unknown[] = []): Promise<number> =>
    Number((await one<{ n: string }>(owner, `SELECT count(*) AS n FROM ${table} WHERE ${where}`, values)).n);

  /** A ready version of a new item, saved by `editor`. */
  const readyVersion = async (editor = 'sub-author'): Promise<{ itemId: string; id: string }> => {
    const itemId = (await one<{ id: string }>(app, `INSERT INTO content_item (slug, kind, office_id) VALUES ($1, 'article', $2) RETURNING id`, [`solo-${(n += 1)}`, officeId])).id;
    const id = (
      await one<{ id: string }>(app, `INSERT INTO content_version (item_id, n, title, created_by_sub, acting_office_id) VALUES ($1, 1, 'Title', $2, $3) RETURNING id`, [itemId, editor, officeId])
    ).id;
    await app.query(`INSERT INTO content_version_editor (version_id, subject) VALUES ($1, $2)`, [id, editor]);
    await app.query(`UPDATE content_version SET status = 'ready', content_hash = $2, ready_at = now() WHERE id = $1`, [id, HASH]);
    return { itemId, id };
  };
  const approve = (id: string, by: string, kind: string, rule: string | null, reason: string | null = null, client = app): Promise<string> =>
    sqlstate(
      client,
      `UPDATE content_version SET status = 'approved', approved_at = now(), approved_by_sub = $2, approval_kind = $3, approval_reason = $4, approval_rule = $5,
         public_ast = '{"blocks": []}' WHERE id = $1`,
      [id, by, kind, reason, rule],
    );
  const versionRule = async (id: string): Promise<{ approval_rule: string | null; approval_kind: string | null }> =>
    one(app, `SELECT approval_rule, approval_kind FROM content_version WHERE id = $1`, [id]);

  /** Back to two-person on both scopes, whatever a test left. */
  const reset = async (): Promise<void> => {
    await flip('content', 'two_person', 'reset');
    await flip('redaction_policy', 'two_person', 'reset');
  };

  beforeAll(async () => {
    db = await freshDatabase('nwfl_solo');
    const run = await migrate(db);
    if (run.code !== 0) throw new Error(`migrate failed: ${run.stderr}`);
    app = await connect(APP, APP_PW);
    owner = await connect(MIGRATOR, MIGRATOR_PW);
    officeId = (await one<{ id: string }>(app, `INSERT INTO office (slug, title, kind) VALUES ('publications', 'Publications Officer', 'appointed') RETURNING id`)).id;
  }, 60_000);

  afterAll(async () => {
    await Promise.all([app?.end(), owner?.end()]);
    if (db) await dropDatabase(db);
  });

  describe('the setting and its ledger', () => {
    it('starts both scopes at two-person, set by no one', async () => {
      const { rows } = await app.query(`SELECT scope, rule, set_at, set_by_sub, change_id FROM approval_rule ORDER BY scope`);
      expect(rows).toEqual([
        { scope: 'content', rule: 'two_person', set_at: null, set_by_sub: null, change_id: null },
        { scope: 'redaction_policy', rule: 'two_person', set_at: null, set_by_sub: null, change_id: null },
      ]);
    });

    it('lets the app role read both tables and write neither', async () => {
      expect(await sqlstate(app, `SELECT * FROM approval_rule_change`)).toBe('ok');
      for (const text of [
        `UPDATE approval_rule SET rule = 'one_approver' WHERE scope = 'content'`,
        `INSERT INTO approval_rule (scope, rule) VALUES ('content', 'one_approver')`,
        `DELETE FROM approval_rule`,
        `TRUNCATE approval_rule`,
        `INSERT INTO approval_rule_change (scope, from_rule, to_rule, reason, changed_by_sub, changed_by_groups) VALUES ('content', 'two_person', 'one_approver', 'x', 'sub-admin', '{nwfl-admin}')`,
        `UPDATE approval_rule_change SET reason = 'x'`,
        `DELETE FROM approval_rule_change`,
        `TRUNCATE approval_rule_change`,
        `SELECT rule FROM approval_rule WHERE scope = 'content' FOR SHARE`,
      ]) {
        expect(await sqlstate(app, text), text).toBe(PRIVILEGE);
      }
    });

    it('refuses the owner a deleted setting, and any rewrite or deletion of a flip', async () => {
      await flip('content', 'one_approver');
      await reset();
      expect(await sqlstate(owner, `DELETE FROM approval_rule WHERE scope = 'content'`)).toBe(STATE);
      expect(await sqlstate(owner, `TRUNCATE approval_rule CASCADE`)).toBe(STATE);
      expect(await sqlstate(owner, `UPDATE approval_rule_change SET reason = 'rewritten'`)).toBe(STATE);
      expect(await sqlstate(owner, `DELETE FROM approval_rule_change`)).toBe(STATE);
      expect(await sqlstate(owner, `TRUNCATE approval_rule_change CASCADE`)).toBe(STATE);
      // The setting points at its flip, so the flips alone cannot be emptied either.
      expect(await sqlstate(owner, `TRUNCATE approval_rule_change`)).toBe('0A000');
      expect(await count('approval_rule')).toBe(2);
    });

    it('refuses the owner a switch written past approval_rule_set: no flip row, no audit row, or a flip already applied', async () => {
      const before = { changes: await count('approval_rule_change'), audits: await count('audit_event', `action = 'approval_rule_set'`) };
      for (const text of [
        `UPDATE approval_rule SET rule = 'one_approver' WHERE scope = 'content'`,
        `UPDATE approval_rule SET rule = 'one_approver', set_at = now(), set_by_sub = 'sub-owner' WHERE scope = 'content'`,
        `UPDATE approval_rule SET set_at = now(), set_by_sub = 'sub-owner' WHERE scope = 'redaction_policy'`,
        `UPDATE approval_rule SET rule = rule`,
      ]) {
        expect(await sqlstate(owner, text), text).toBe(STATE);
      }
      // A flip row the owner inserts by hand, then points the setting at. Refused without the marker
      // approval_rule_set sets for its own update, then without the audit row, then with another
      // subject or time than the flip's; with all of them it is a flip on the record, which is the
      // point: the setting never moves without a ledger row and an audit row.
      await owner.query('BEGIN');
      try {
        const forged = await one<{ id: string }>(
          owner,
          `INSERT INTO approval_rule_change (scope, from_rule, to_rule, reason, changed_by_sub, changed_by_groups) VALUES ('content', 'two_person', 'one_approver', 'by hand', 'sub-owner', '{nwfl-admin}') RETURNING id`,
        );
        // The flip's own time, to the microsecond (a JS Date keeps milliseconds), or `late` seconds after.
        const point = (sub = 'sub-owner', late = 0): Promise<string> =>
          failure(
            owner,
            `UPDATE approval_rule SET rule = 'one_approver', set_at = (SELECT changed_at FROM approval_rule_change WHERE id = $3) + make_interval(secs => $1), set_by_sub = $2, change_id = $3 WHERE scope = 'content'`,
            [late, sub, forged.id],
          );
        const attempt = async (expected: RegExp | 'ok', ...args: Parameters<typeof point>): Promise<void> => {
          await owner.query('SAVEPOINT s');
          const result = await point(...args);
          if (expected === 'ok') expect(result).toBe('ok');
          else expect(result).toMatch(expected);
          await owner.query('ROLLBACK TO SAVEPOINT s');
        };
        const marker = (value: string): Promise<unknown> => owner.query(`SELECT set_config('nwfl.approval_rule_change', $1, true)`, [value]);
        await attempt(/approval_rule_set/);
        await marker(forged.id);
        await attempt(/approval_rule_set/);
        await owner.query(
          `INSERT INTO audit_event (actor_kind, actor_sub, action, subject_kind, subject_id, payload) VALUES ('user', 'sub-owner', 'approval_rule_set', 'approval_rule', 'content', jsonb_build_object('change_id', $1::text))`,
          [forged.id],
        );
        await marker('');
        await attempt(/approval_rule_set/);
        await marker(forged.id);
        await attempt(/approval_rule_set/, 'sub-someone-else');
        await attempt(/approval_rule_set/, 'sub-owner', 1);
        await attempt('ok');
      } finally {
        await owner.query('ROLLBACK');
      }
      // A real flip, then the owner re-pointing the setting at it, or switching back under it.
      const done = await one<{ set_at: Date; change_id: string }>(app, SET_EXPECTING, ['content', 'one_approver', 'away', ADMIN.sub, ADMIN.groups, await revision('content')]);
      expect(await sqlstate(owner, `UPDATE approval_rule SET rule = 'two_person' WHERE scope = 'content'`)).toBe(STATE);
      expect(await sqlstate(owner, `UPDATE approval_rule SET rule = 'one_approver', set_at = $1, set_by_sub = 'sub-admin', change_id = $2 WHERE scope = 'redaction_policy'`, [done.set_at, done.change_id])).toBe(
        STATE,
      );
      expect(await ruleOf('redaction_policy')).toBe('two_person');
      await reset();
      expect(await count('approval_rule_change')).toBe(before.changes + 2);
      expect(await count('audit_event', `action = 'approval_rule_set'`)).toBe(before.audits + 2);
    });

    it('holds one approver only with when, who and the flip that set it, even with the guard switched off', async () => {
      await flip('content', 'one_approver');
      await reset();
      await owner.query('BEGIN');
      try {
        await owner.query(`ALTER TABLE approval_rule DISABLE TRIGGER approval_rule_flip_guard`);
        for (const text of [
          `UPDATE approval_rule SET rule = 'one_approver', set_at = NULL, set_by_sub = NULL, change_id = NULL WHERE scope = 'content'`,
          `UPDATE approval_rule SET change_id = NULL WHERE scope = 'content'`,
          `UPDATE approval_rule SET set_by_sub = NULL WHERE scope = 'content'`,
          `UPDATE approval_rule SET set_at = NULL, set_by_sub = NULL WHERE scope = 'content'`,
        ]) {
          await owner.query('SAVEPOINT s');
          expect(await sqlstate(owner, text), text).toBe(CHECK);
          await owner.query('ROLLBACK TO SAVEPOINT s');
        }
      } finally {
        await owner.query('ROLLBACK');
      }
    });

    it('refuses a flip row the function would never write', async () => {
      const insert = `INSERT INTO approval_rule_change (scope, from_rule, to_rule, reason, changed_by_sub, changed_by_groups) VALUES ($1, $2, $3, $4, $5, $6)`;
      expect(await sqlstate(owner, insert, ['content', 'two_person', 'two_person', 'same', 'sub-admin', ['nwfl-admin']])).toBe(CHECK);
      expect(await sqlstate(owner, insert, ['content', 'two_person', 'one_approver', '   ', 'sub-admin', ['nwfl-admin']])).toBe(CHECK);
      for (const blank of ['\t\n', '\u200b', '\u00a0', '?!']) expect(await sqlstate(owner, insert, ['content', 'two_person', 'one_approver', blank, 'sub-admin', ['nwfl-admin']]), JSON.stringify(blank)).toBe(CHECK);
      expect(await sqlstate(owner, insert, ['content', 'two_person', 'one_approver', 'x'.repeat(2001), 'sub-admin', ['nwfl-admin']])).toBe(CHECK);
      expect(await sqlstate(owner, insert, ['content', 'two_person', 'one_approver', 'why', '', ['nwfl-admin']])).toBe(CHECK);
      expect(await sqlstate(owner, insert, ['content', 'two_person', 'one_approver', 'why', 'sub-officer', ['nwfl-officers']])).toBe(CHECK);
      expect(await sqlstate(owner, insert, ['members', 'two_person', 'one_approver', 'why', 'sub-admin', ['nwfl-admin']])).not.toBe('ok');
    });
  });

  describe('approval_rule_set', () => {
    it('is the app role\'s alone to call', async () => {
      const { rows } = await owner.query<{ fn: string; app: boolean }>(
        `SELECT p.oid::regprocedure::text AS fn, has_function_privilege('nwfl', p.oid, 'EXECUTE') AS app
         FROM pg_proc p WHERE p.proname IN ('approval_rule_set', 'approval_rule_read') ORDER BY 1`,
      );
      expect(rows).toEqual([
        { fn: 'approval_rule_read(text)', app: true },
        { fn: 'approval_rule_set(text,text,text,text,text[],text,text)', app: true },
      ]);
    });

    it('refuses anyone without nwfl-admin among the groups, and a blank subject, writing nothing', async () => {
      const before = await count('audit_event');
      const changes = await count('approval_rule_change');
      for (const who of [OFFICER, { sub: 'sub-webmaster', groups: ['nwfl-officers', 'nwfl-webmaster'] }, { sub: 'sub-x', groups: ['mensa-nwfl-admin'] }, { sub: '', groups: ['nwfl-admin'] }]) {
        expect(await failure(app, SET, ['content', 'one_approver', 'because', who.sub, who.groups, null]), who.sub).toMatch(/only the Admin/);
        expect(await sqlstate(app, SET, ['content', 'one_approver', 'because', who.sub, who.groups, null])).toBe(PRIVILEGE);
      }
      expect(await sqlstate(app, SET, ['content', 'one_approver', 'because', null, null, null])).toBe(PRIVILEGE);
      expect(await ruleOf('content')).toBe('two_person');
      expect(await count('approval_rule_change')).toBe(changes);
      expect(await count('audit_event')).toBe(before);
    });

    it('refuses a blank or over-long reason, an unknown scope and an unknown rule, even when nothing would change', async () => {
      // Blank includes every kind of space, a line break, a tab, and invisible characters: a reason
      // says something, in at least one letter or digit.
      for (const reason of ['', '   ', null, 'x'.repeat(2001), '\t\n', '\u200b', '\u00a0\u2003', '\ufeff\u2060', '...', '--']) {
        expect(await sqlstate(app, SET, ['content', 'two_person', reason, ADMIN.sub, ADMIN.groups, null]), String(reason)).toBe(BAD_VALUE);
        expect(await sqlstate(app, SET, ['content', 'one_approver', reason, ADMIN.sub, ADMIN.groups, null]), String(reason)).toBe(BAD_VALUE);
      }
      expect(await sqlstate(app, SET, ['members', 'one_approver', 'why', ADMIN.sub, ADMIN.groups, null])).toBe(BAD_VALUE);
      expect(await sqlstate(app, SET, ['content', 'three_person', 'why', ADMIN.sub, ADMIN.groups, null])).toBe(BAD_VALUE);
      expect(await sqlstate(app, SET, ['content', null, 'why', ADMIN.sub, ADMIN.groups, null])).toBe(BAD_VALUE);
      expect(await sqlstate(app, SET, [null, 'one_approver', 'why', ADMIN.sub, ADMIN.groups, null])).toBe(BAD_VALUE);
    });

    it('records each flip once, with who, groups, when, from, to, reason and trace, and an audit row', async () => {
      const changes = await count('approval_rule_change');
      const audits = await count('audit_event', `action = 'approval_rule_set'`);
      const trace = 'a'.repeat(32);
      const done = await one<{ rule: string; set_at: Date; changed: boolean }>(app, SET, ['content', 'one_approver', '  Webmaster away until Monday  ', ADMIN.sub, ADMIN.groups, trace]);
      expect(done).toMatchObject({ rule: 'one_approver', changed: true });
      const change = await one<Record<string, unknown>>(owner, `SELECT * FROM approval_rule_change ORDER BY changed_at DESC, id LIMIT 1`);
      expect(change).toMatchObject({
        scope: 'content',
        from_rule: 'two_person',
        to_rule: 'one_approver',
        reason: 'Webmaster away until Monday',
        changed_by_sub: 'sub-admin',
        changed_by_groups: ADMIN.groups,
        trace_id: trace,
      });
      expect(change['changed_at']).toEqual(done.set_at);
      const setting = await one<{ set_at: Date; set_by_sub: string }>(app, `SELECT set_at, set_by_sub FROM approval_rule WHERE scope = 'content'`);
      expect(setting).toEqual({ set_at: done.set_at, set_by_sub: 'sub-admin' });
      const audit = await one<Record<string, unknown>>(
        owner,
        `SELECT actor_kind, actor_sub, actor_groups, subject_kind, subject_id, from_state, to_state, note, payload, trace_id FROM audit_event WHERE action = 'approval_rule_set' ORDER BY id DESC LIMIT 1`,
      );
      expect(audit).toEqual({
        actor_kind: 'user',
        actor_sub: 'sub-admin',
        actor_groups: ADMIN.groups,
        subject_kind: 'approval_rule',
        subject_id: 'content',
        from_state: 'two_person',
        to_state: 'one_approver',
        note: 'Webmaster away until Monday',
        payload: { change_id: change['id'] },
        trace_id: trace,
      });
      expect(await count('approval_rule_change')).toBe(changes + 1);
      expect(await count('audit_event', `action = 'approval_rule_set'`)).toBe(audits + 1);

      // The same flip again: nothing changes, nothing is written, and the date stays the first one's.
      const again = await flip('content', 'one_approver', 'pressed twice');
      expect(again).toEqual({ rule: 'one_approver', set_at: done.set_at, changed: false });
      expect(await count('approval_rule_change')).toBe(changes + 1);
      expect(await count('audit_event', `action = 'approval_rule_set'`)).toBe(audits + 1);
      // The other scope is its own setting.
      expect(await ruleOf('redaction_policy')).toBe('two_person');
      await reset();
      expect(await ruleOf('content')).toBe('two_person');
    });

    it('takes a reason in any alphabet, or a bare number, and keeps it trimmed of every kind of space', async () => {
      for (const reason of ['\u00c9t\u00e9', '\u0395\u03bb\u03bb\u03ac\u03b4\u03b1', '2', '\u00a0\tWebmaster away\n']) {
        expect(await flip('content', 'one_approver', reason)).toMatchObject({ changed: true });
        await reset();
      }
      const kept = await one<{ reason: string }>(owner, `SELECT reason FROM approval_rule_change WHERE to_rule = 'one_approver' ORDER BY changed_at DESC LIMIT 1`);
      expect(kept.reason).toBe('Webmaster away');
    });

    it('refuses a flip from a rule the Admin no longer sees: the revision they read has moved on', async () => {
      const changes = await count('approval_rule_change');
      // The Admin reads two-person, at the revision in force, and switches to one approver.
      const read = await revision('content');
      const first = await one<{ rule: string; change_id: string; changed: boolean }>(app, SET_EXPECTING, ['content', 'one_approver', 'Webmaster away this week', ADMIN.sub, ADMIN.groups, read]);
      expect(first).toMatchObject({ rule: 'one_approver', changed: true });
      expect(first.change_id).toMatch(/^[0-9a-f-]{36}$/);
      const row = await one<{ change_id: string }>(app, `SELECT change_id FROM approval_rule WHERE scope = 'content'`);
      expect(row.change_id).toBe(first.change_id);
      // Pressed twice: the same rule changes nothing, whatever revision the form carried.
      expect(await one(app, SET_EXPECTING, ['content', 'one_approver', 'Webmaster away this week', ADMIN.sub, ADMIN.groups, read])).toMatchObject({ changed: false, change_id: first.change_id });
      const back = await one<{ change_id: string }>(app, SET_EXPECTING, ['content', 'two_person', 'Webmaster back', ADMIN.sub, ADMIN.groups, first.change_id]);
      // The first form, sent again after the switch back: refused, and nothing written.
      expect(await failure(app, SET_EXPECTING, ['content', 'one_approver', 'Webmaster away this week', ADMIN.sub, ADMIN.groups, read])).toMatch(/switched since/);
      expect(await sqlstate(app, SET_EXPECTING, ['content', 'one_approver', 'Webmaster away this week', ADMIN.sub, ADMIN.groups, ''])).toBe(STATE);
      expect(await sqlstate(app, SET_EXPECTING, ['content', 'one_approver', 'Webmaster away this week', ADMIN.sub, ADMIN.groups, first.change_id])).toBe(STATE);
      expect(await sqlstate(app, SET_EXPECTING, ['content', 'one_approver', 'Webmaster away this week', ADMIN.sub, ADMIN.groups, 'not-a-revision'])).toBe(STATE);
      expect(await ruleOf('content')).toBe('two_person');
      expect(await count('approval_rule_change')).toBe(changes + 2);
      // With the revision now in force, it goes through; with none named, nothing is checked.
      expect(await one(app, SET_EXPECTING, ['content', 'one_approver', 'away again', ADMIN.sub, ADMIN.groups, back.change_id])).toMatchObject({ changed: true });
      expect(await flip('content', 'two_person', 'back again')).toMatchObject({ changed: true });
    });

    it('reads a rule under a share lock, through the one function the app role may call', async () => {
      expect(await one(app, `SELECT approval_rule_read('content') AS rule`)).toEqual({ rule: 'two_person' });
      expect(await sqlstate(app, `SELECT approval_rule_read('members')`)).toBe(BAD_VALUE);
    });

    it('lets the audit log name an approval rule, and still every older subject', async () => {
      const insert = `INSERT INTO audit_event (actor_kind, action, subject_kind, subject_id) VALUES ('system', 'probe', $1, 'x')`;
      for (const kind of ['approval_rule', 'content_version', 'redaction_mark_removal', 'signup_request']) expect(await sqlstate(app, insert, [kind]), kind).toBe('ok');
      expect(await sqlstate(app, insert, ['approval'])).toBe(CHECK);
    });
  });

  describe('content: the four-eyes backstop', () => {
    it('refuses an editor approving their own version as a normal approval, under either rule', async () => {
      const v = await readyVersion('sub-pub');
      expect(await approve(v.id, 'sub-pub', 'normal', 'two_person')).toBe(STATE);
      await flip('content', 'one_approver');
      expect(await approve(v.id, 'sub-pub', 'normal', 'one_approver')).toBe(STATE);
      await reset();
    });

    it('refuses a single-approver self approval under two-person, and by anyone who is not an editor', async () => {
      const v = await readyVersion('sub-pub');
      expect(await approve(v.id, 'sub-pub', 'self_single', 'two_person')).toBe(STATE);
      await flip('content', 'one_approver');
      expect(await approve(v.id, 'sub-webmaster', 'self_single', 'one_approver')).toBe(STATE);
      expect(await approve(v.id, 'sub-pub', 'self_single', 'one_approver')).toBe('ok');
      expect(await versionRule(v.id)).toEqual({ approval_rule: 'one_approver', approval_kind: 'self_single' });
      await reset();
    });

    it('refuses an approval that names a rule other than the one in force', async () => {
      const v = await readyVersion();
      expect(await failure(app, `UPDATE content_version SET status = 'approved', approved_at = now(), approved_by_sub = 'w', approval_kind = 'normal', approval_rule = 'one_approver', public_ast = '{"blocks": []}' WHERE id = $1`, [v.id])).toMatch(
        /approval rule/,
      );
      expect(await approve(v.id, 'sub-webmaster', 'normal', 'one_approver')).toBe(STATE);
      expect(await approve(v.id, 'sub-webmaster', 'normal', 'two_person')).toBe('ok');
    });

    it('records the rule in force when an approval names none', async () => {
      const v = await readyVersion();
      expect(await approve(v.id, 'sub-webmaster', 'normal', null)).toBe('ok');
      expect(await versionRule(v.id)).toEqual({ approval_rule: 'two_person', approval_kind: 'normal' });
      await flip('content', 'one_approver');
      const w = await readyVersion();
      expect(await approve(w.id, 'sub-webmaster', 'normal', null)).toBe('ok');
      expect(await versionRule(w.id)).toEqual({ approval_rule: 'one_approver', approval_kind: 'normal' });
      await reset();
    });

    it('keeps break-glass under both rules, and records the rule in force with it', async () => {
      const v = await readyVersion('sub-admin');
      expect(await approve(v.id, 'sub-admin', 'self_breakglass', 'two_person', 'Webmaster away')).toBe('ok');
      await flip('content', 'one_approver');
      const w = await readyVersion('sub-admin');
      expect(await approve(w.id, 'sub-admin', 'self_breakglass', 'one_approver', 'Webmaster away')).toBe('ok');
      expect(await versionRule(w.id)).toEqual({ approval_rule: 'one_approver', approval_kind: 'self_breakglass' });
      await reset();
    });

    it('holds a rule only on an approved or superseded version, and self_single only with one_approver', async () => {
      const v = await readyVersion();
      expect(await sqlstate(app, `UPDATE content_version SET approval_rule = 'two_person' WHERE id = $1`, [v.id])).toBe(CHECK);
      const draft = await one<{ id: string }>(
        app,
        `INSERT INTO content_version (item_id, n, title, created_by_sub, acting_office_id) VALUES ($1, 2, 'T', 'sub-author', $2) RETURNING id`,
        [v.itemId, officeId],
      );
      expect(await sqlstate(app, `UPDATE content_version SET approval_rule = 'one_approver' WHERE id = $1`, [draft.id])).toBe(CHECK);
      expect(await sqlstate(app, `UPDATE content_version SET approval_kind = 'self_single' WHERE id = $1`, [draft.id])).toBe('ok');
      expect(await sqlstate(app, `UPDATE content_version SET approval_kind = 'self_none' WHERE id = $1`, [draft.id])).toBe(CHECK);
    });

    it('freezes the rule once approved', async () => {
      const v = await readyVersion();
      expect(await approve(v.id, 'sub-webmaster', 'normal', 'two_person')).toBe('ok');
      await flip('content', 'one_approver');
      expect(await sqlstate(app, `UPDATE content_version SET approval_rule = 'one_approver' WHERE id = $1`, [v.id])).toBe(STATE);
      expect(await sqlstate(owner, `UPDATE content_version SET approval_rule = 'one_approver' WHERE id = $1`, [v.id])).toBe(STATE);
      await reset();
    });

    it('replaces the freeze with 0007\'s body plus the rule, keeping the pinned search_path', async () => {
      const { src, config } = await one<{ src: string; config: string[] }>(owner, `SELECT prosrc AS src, proconfig AS config FROM pg_proc WHERE proname = 'content_version_freeze'`);
      expect(config).toEqual(['search_path=pg_catalog, public, pg_temp']);
      const file = readFileSync(path.join(MIGRATIONS, '0007_a2_fix.sql'), 'utf8');
      const body = /CREATE OR REPLACE FUNCTION content_version_freeze\(\) RETURNS trigger LANGUAGE plpgsql AS \$fn\$([\s\S]*?)\$fn\$/.exec(file)?.[1];
      const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();
      expect(body).toBeDefined();
      expect(src).toMatch(/NEW\.approval_rule/);
      expect(squash(src.replace(/,\s*NEW\.approval_rule/, '').replace(/,\s*OLD\.approval_rule/, ''))).toBe(squash(body as string));
    });
  });

  describe('redaction: loosening the public audience', () => {
    const change = (id: string): Promise<Record<string, unknown>> =>
      one(owner, `SELECT status, proposed_by_sub, approved_by_sub, approval_rule FROM redaction_change WHERE id = $1`, [id]);
    const action = async (category: string, audience = 'public'): Promise<string> =>
      (await one<{ action: string }>(app, `SELECT action FROM redaction_policy WHERE audience = $1 AND category = $2`, [audience, category])).action;
    const propose = (category: string, to: string, who = OFFICER): Promise<Record<string, unknown>> => one(app, PROPOSE, ['public', category, to, who.sub, who.groups]);

    it('waits for a second officer under two-person, as before', async () => {
      const pending = await propose('member_phone', 'show');
      expect(pending).toMatchObject({ status: 'pending', approval_rule: 'two_person' });
      expect(await sqlstate(app, APPROVE, [pending['id'], OFFICER.sub, OFFICER.groups])).toBe(PRIVILEGE);
      const applied = await one<Record<string, unknown>>(app, APPROVE, [pending['id'], OTHER.sub, OTHER.groups]);
      expect(applied).toMatchObject({ status: 'applied', approved_by_sub: 'sub-other', approval_rule: 'two_person' });
      expect(await action('member_phone')).toBe('show');
      await one(app, PROPOSE, ['public', 'member_phone', 'hide', OFFICER.sub, OFFICER.groups]);
    });

    it('applies a loosening at once under one-approver, approved by its proposer, and audits propose, approve and set', async () => {
      await flip('redaction_policy', 'one_approver');
      const before = Number((await one<{ id: string }>(owner, `SELECT coalesce(max(id), 0) AS id FROM audit_event`)).id);
      const applied = await propose('member_email', 'show');
      expect(applied).toMatchObject({ status: 'applied', proposed_by_sub: 'sub-officer', approved_by_sub: 'sub-officer', approval_rule: 'one_approver' });
      expect(applied['approved_at']).not.toBeNull();
      expect(await action('member_email')).toBe('show');
      const { rows } = await owner.query<{ action: string; payload: Record<string, unknown> }>(`SELECT action, payload FROM audit_event WHERE id > $1 ORDER BY id`, [before]);
      expect(rows.map((row) => row.action)).toEqual(['redaction_propose', 'redaction_approve', 'redaction_set']);
      expect(rows[1]?.payload).toEqual({ rule: 'one_approver' });
      expect(rows[0]?.payload).toMatchObject({ rule: 'one_approver', audience: 'public', category: 'member_email' });
      await one(app, PROPOSE, ['public', 'member_email', 'hide', OFFICER.sub, OFFICER.groups]);
      await reset();
    });

    it('under one-approver, supersedes a loosening still waiting from two-person', async () => {
      const pending = await propose('member_address', 'show');
      expect(pending['status']).toBe('pending');
      await flip('redaction_policy', 'one_approver');
      const applied = await propose('member_address', 'show', OTHER);
      expect(applied).toMatchObject({ status: 'applied', approved_by_sub: 'sub-other', approval_rule: 'one_approver' });
      expect(await change(String(pending['id']))).toMatchObject({ status: 'superseded', approval_rule: 'two_person' });
      await one(app, PROPOSE, ['public', 'member_address', 'hide', OFFICER.sub, OFFICER.groups]);
      await reset();
    });

    it('lets the proposer approve a loosening that went pending under two-person once one-approver is set (D4)', async () => {
      const pending = await propose('private_venue', 'show');
      await flip('redaction_policy', 'one_approver');
      const applied = await one<Record<string, unknown>>(app, APPROVE, [pending['id'], OFFICER.sub, OFFICER.groups]);
      expect(applied).toMatchObject({ status: 'applied', approved_by_sub: 'sub-officer', approval_rule: 'one_approver' });
      await one(app, PROPOSE, ['public', 'private_venue', 'hide', OFFICER.sub, OFFICER.groups]);
      // A second officer's approval made under one-approver is recorded under it too.
      await reset();
      const second = await propose('private_venue', 'redact');
      await flip('redaction_policy', 'one_approver');
      expect(await one(app, APPROVE, [second['id'], OTHER.sub, OTHER.groups])).toMatchObject({ approved_by_sub: 'sub-other', approval_rule: 'one_approver' });
      await one(app, PROPOSE, ['public', 'private_venue', 'hide', OFFICER.sub, OFFICER.groups]);
      await reset();
    });

    it('is two-person again once switched back: pending, and the proposer refused', async () => {
      await flip('redaction_policy', 'one_approver');
      await reset();
      const pending = await propose('officer_contact', 'show');
      expect(pending).toMatchObject({ status: 'pending', approval_rule: 'two_person' });
      expect(await sqlstate(app, APPROVE, [pending['id'], OFFICER.sub, OFFICER.groups])).toBe(PRIVILEGE);
      await one(app, PROPOSE, ['public', 'officer_contact', 'hide', OFFICER.sub, OFFICER.groups]);
    });

    it('keeps the scopes apart: content one-approver leaves a public loosening two-person', async () => {
      // member_phone, not member_name or image: 0022 (REDACT-LOOK) shows those two to the public.
      await flip('content', 'one_approver');
      const pending = await propose('member_phone', 'show');
      expect(pending).toMatchObject({ status: 'pending', approval_rule: 'two_person' });
      expect(await sqlstate(app, APPROVE, [pending['id'], OFFICER.sub, OFFICER.groups])).toBe(PRIVILEGE);
      await one(app, APPROVE, [pending['id'], OTHER.sub, OTHER.groups]);
      await one(app, PROPOSE, ['public', 'member_phone', 'hide', OFFICER.sub, OFFICER.groups]);
      await reset();
    });

    it('records the rule in force on a change that needs no approval', async () => {
      await flip('redaction_policy', 'one_approver');
      expect(await one(app, PROPOSE, ['members', 'member_phone', 'hide', OFFICER.sub, OFFICER.groups])).toMatchObject({ status: 'applied', approved_by_sub: null, approval_rule: 'one_approver' });
      await reset();
      expect(await one(app, PROPOSE, ['members', 'member_phone', 'show', OFFICER.sub, OFFICER.groups])).toMatchObject({ status: 'applied', approval_rule: 'two_person' });
    });

    it('refuses the owner a self-approved two-person row, a one-approver row while two-person holds, and a rule changed on supersede', async () => {
      const insert = `INSERT INTO redaction_change (audience, category, from_action, to_action, status, proposed_by_sub, approved_by_sub, approved_at, decided_at, approval_rule)
                      VALUES ('public', 'member_phone', 'hide', 'show', 'applied', 'sub-officer', $1, now(), now(), $2)`;
      expect(await sqlstate(owner, insert, ['sub-officer', 'two_person'])).toBe(CHECK);
      expect(await sqlstate(owner, insert, ['sub-officer', 'one_approver'])).toBe(STATE);
      expect(await sqlstate(owner, insert, ['sub-other', 'nobody'])).toBe(STATE);
      const pending = await propose('member_phone', 'show');
      expect(await sqlstate(owner, `UPDATE redaction_change SET status = 'superseded', decided_at = now(), approval_rule = 'one_approver' WHERE id = $1`, [pending['id']])).toBe(STATE);
      expect(await sqlstate(owner, `UPDATE redaction_change SET status = 'applied', decided_at = now(), approved_by_sub = 'sub-other', approved_at = now(), approval_rule = 'one_approver' WHERE id = $1`, [pending['id']])).toBe(STATE);
      await one(app, APPROVE, [pending['id'], OTHER.sub, OTHER.groups]);
      await one(app, PROPOSE, ['public', 'member_phone', 'hide', OFFICER.sub, OFFICER.groups]);
    });
  });

  describe('lock order: the cell or the item, then the rule, then the ledger head', () => {
    let a: pg.Client;
    let b: pg.Client;
    const settled = (promise: Promise<unknown>): { done: () => boolean } => {
      let done = false;
      void promise.then(
        () => (done = true),
        () => (done = true),
      );
      return { done: () => done };
    };
    const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

    beforeAll(async () => {
      a = await connect(APP, APP_PW);
      b = await connect(APP, APP_PW);
      for (const client of [a, b]) await client.query(`SET lock_timeout = '10s'`);
    });
    afterAll(async () => {
      await Promise.all([a?.end(), b?.end()]);
    });

    it('(a) makes an approval waiting on a flip read the flip\'s rule once it commits', async () => {
      await flip('content', 'one_approver');
      const v = await readyVersion('sub-pub');
      await a.query('BEGIN');
      await flip('content', 'two_person', 'back on', ADMIN, a);
      await b.query('BEGIN');
      const read = b.query<{ rule: string }>(`SELECT approval_rule_read('content') AS rule`);
      const waiting = settled(read);
      await pause(300);
      expect(waiting.done()).toBe(false);
      await a.query('COMMIT');
      expect((await read).rows[0]!.rule).toBe('two_person');
      // The editor's own approval as it would be judged now: refused.
      expect(await approve(v.id, 'sub-pub', 'self_single', 'two_person', null, b)).toBe(STATE);
      await b.query('ROLLBACK');
    });

    it('(b) makes a flip wait for an approval holding the rule, and records the rule the approval read', async () => {
      await flip('content', 'one_approver');
      const v = await readyVersion('sub-pub');
      await b.query('BEGIN');
      expect((await b.query<{ rule: string }>(`SELECT approval_rule_read('content') AS rule`)).rows[0]!.rule).toBe('one_approver');
      await a.query('BEGIN');
      const flipping = flip('content', 'two_person', 'back on', ADMIN, a);
      const waiting = settled(flipping);
      await pause(300);
      expect(waiting.done()).toBe(false);
      expect(await approve(v.id, 'sub-pub', 'self_single', 'one_approver', null, b)).toBe('ok');
      await b.query('COMMIT');
      expect((await flipping).changed).toBe(true);
      await a.query('COMMIT');
      expect(await versionRule(v.id)).toEqual({ approval_rule: 'one_approver', approval_kind: 'self_single' });
      expect(await ruleOf('content')).toBe('two_person');
    });

    it('(c) never deadlocks: a writer holding the ledger head, then the rule, against a flip', async () => {
      await b.query('BEGIN');
      await b.query('SELECT publication_ledger_lock()');
      await a.query('BEGIN');
      // The flip takes the rule alone, so it does not wait on the head.
      expect((await flip('content', 'one_approver', 'away', ADMIN, a)).changed).toBe(true);
      const read = b.query<{ rule: string }>(`SELECT approval_rule_read('content') AS rule`);
      await a.query('COMMIT');
      expect((await read).rows[0]!.rule).toBe('one_approver');
      await b.query('COMMIT');
      await reset();
    });

    it('(c) never deadlocks: a redaction proposal holding its cell, the rule and the head, against a flip', async () => {
      await b.query('BEGIN');
      expect((await b.query(PROPOSE, ['public', 'business_venue', 'hide', OFFICER.sub, OFFICER.groups])).rows[0]).toMatchObject({ status: 'applied' });
      await a.query('BEGIN');
      const flipping = flip('redaction_policy', 'one_approver', 'away', ADMIN, a);
      const waiting = settled(flipping);
      await pause(300);
      expect(waiting.done()).toBe(false);
      await b.query('COMMIT');
      expect((await flipping).changed).toBe(true);
      await a.query('COMMIT');
      await one(app, PROPOSE, ['public', 'business_venue', 'show', OFFICER.sub, OFFICER.groups]);
      await reset();
    });
  });

  describe('the backfill', () => {
    let old: string;
    afterAll(async () => {
      if (old) {
        await dockerExec(['sh', '-c', `rm -rf /tmp/${old}-pre`]);
        await dropDatabase(old);
      }
    });

    it('marks every version approved before 0023 as approved under two-person, and nothing else', async () => {
      old = await freshDatabase('nwfl_solo_pre');
      const dir = `/tmp/${old}-pre`;
      // 0023 and every later migration left out, so the copy is the schema just before 0023.
      await dockerExec(['sh', '-c', `rm -rf ${dir} && mkdir -p ${dir} && cp /repo/migrations/*.sql ${dir}/ && for f in ${dir}/*.sql; do n=$(basename "$f"); n=\${n%%_*}; if [ "$n" -ge 23 ]; then rm "$f"; fi; done`]);
      const first = await migrate(old, dir);
      expect(first.code, first.stderr).toBe(0);
      const pre = await connect(APP, APP_PW, old);
      try {
        const office = (await one<{ id: string }>(pre, `INSERT INTO office (slug, title, kind) VALUES ('editor', 'Editor', 'appointed') RETURNING id`)).id;
        const item = (await one<{ id: string }>(pre, `INSERT INTO content_item (slug, kind, office_id) VALUES ('old', 'article', $1) RETURNING id`, [office])).id;
        const ids: string[] = [];
        for (const k of [1, 2, 3]) {
          ids.push((await one<{ id: string }>(pre, `INSERT INTO content_version (item_id, n, title, created_by_sub, acting_office_id) VALUES ($1, $2, 'T', 'sub-author', $3) RETURNING id`, [item, k, office])).id);
        }
        const [superseded, approved, ready] = ids as [string, string, string];
        for (const id of ids) await pre.query(`UPDATE content_version SET status = 'ready', content_hash = $2, ready_at = now() WHERE id = $1`, [id, HASH]);
        const approveOld = (id: string): Promise<unknown> =>
          pre.query(`UPDATE content_version SET status = 'approved', approved_at = now(), approved_by_sub = 'sub-webmaster', approval_kind = 'normal', public_ast = '{"blocks": []}' WHERE id = $1`, [id]);
        await approveOld(superseded);
        await pre.query(`UPDATE content_item SET state = 'ready' WHERE id = $1`, [item]);
        await pre.query(`UPDATE content_item SET state = 'published', live_version_id = $2 WHERE id = $1`, [item, superseded]);
        // As applyApproval does it: approve, repoint live, supersede the old one, in one transaction.
        await pre.query('BEGIN');
        await approveOld(approved);
        await pre.query(`UPDATE content_item SET live_version_id = $2 WHERE id = $1`, [item, approved]);
        await pre.query(`UPDATE content_version SET status = 'superseded' WHERE id = $1`, [superseded]);
        await pre.query('COMMIT');
        await pre.end();
        const second = await migrate(old);
        expect(second.code, second.stderr).toBe(0);
        const after = await connect(APP, APP_PW, old);
        try {
          const { rows } = await after.query<{ id: string; status: string; approval_rule: string | null }>(`SELECT id, status, approval_rule FROM content_version ORDER BY n`);
          expect(rows).toEqual([
            { id: superseded, status: 'superseded', approval_rule: 'two_person' },
            { id: approved, status: 'approved', approval_rule: 'two_person' },
            { id: ready, status: 'ready', approval_rule: null },
          ]);
        } finally {
          await after.end();
        }
      } finally {
        await pre.end().catch(() => undefined);
      }
    });
  });
});
