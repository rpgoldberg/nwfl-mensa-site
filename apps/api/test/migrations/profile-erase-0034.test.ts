// PROFILE-ERASE (0034), exercised as the APPLICATION role and as the owner.
//   REMOVE   signup_request_erase, the Admin's alone, blanks the display name, the email, the two names
//            and the number of every decided sign-up of a person: approved, rejected, reopened, and one
//            whose account is already removed. The date and the decision stay. No other write erases a
//            row, the owner's included, and an erased row changes no more (a rejected one is still
//            reopened).
//   CORRECT  signup_request_correct_number, the Admin's alone, is the one way a stored number changes.
//            Its audit row holds who, when and the reason, never a number: a reason with a digit of any
//            script is refused, by the function and by the audit table's own CHECK.
//   REMOVAL  an account that becomes removed loses the profile on its approved sign-up in the same
//            statement, and it stays erased. A rejection keeps what was typed.
// Every subject and value here is made up.
import type pg from 'pg';
import pgLib from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP, APP_PW, MIGRATOR, MIGRATOR_PW, dropDatabase, freshDatabase, live, migrate, sqlstate, urlFor } from '../helpers/pg.js';

const CHECK_VIOLATION = '23514';
const NOT_IN_PREREQUISITE_STATE = '55000';
const INSUFFICIENT_PRIVILEGE = '42501';
const INVALID_PARAMETER = '22023';
const NO_DATA_FOUND = 'P0002';

const ADMIN = ['nwfl-members', 'nwfl-admin'];
/** Every role that is not the Admin, by the groups its token carries. */
const NOT_ADMIN: [string, string[]][] = [
  ['a membership approver holding the Membership seat', ['nwfl-members', 'nwfl-officers', 'nwfl-office-membership', 'nwfl-membership-approvers']],
  ['the Webmaster', ['nwfl-members', 'nwfl-officers', 'nwfl-office-webmaster', 'nwfl-webmaster']],
  ['an officer', ['nwfl-members', 'nwfl-officers']],
  ['a member', ['nwfl-members']],
  ['a group that only looks like the Admin\'s', ['mensa-nwfl-admin', 'admin', 'nwfl-administrators']],
  ['no group at all', []],
];
const PII = { display_name: null, email: null, first_name: null, last_name: null, membership_number: null };

describe.skipIf(!live)('schema after PROFILE-ERASE (0034)', () => {
  let db: string;
  let app: pg.Client;
  let owner: pg.Client;

  const one = async <T>(text: string, values: unknown[] = []): Promise<T> => (await app.query(text, values)).rows[0] as T;
  const signup = async (sub: string, number = '1234567'): Promise<string> => {
    const { id } = await one<{ id: string }>(
      `INSERT INTO signup_request (sub, display_name, email, first_name, last_name, membership_number)
       VALUES ($1, 'Pat Example', 'pat@example.org', 'Pat', 'Example', $2) RETURNING id`,
      [sub, number],
    );
    await app.query(`INSERT INTO member_account (sub, status, route) VALUES ($1, 'pending', 'signup') ON CONFLICT (sub) DO NOTHING`, [sub]);
    return id;
  };
  const decide = (id: string, decision: 'approved' | 'rejected') =>
    app.query(`UPDATE signup_request SET decision = $2, decided_at = now(), decided_by_sub = 'officer-1' WHERE id = $1`, [id, decision]);
  const approved = async (sub: string, number = '1234567'): Promise<string> => {
    const id = await signup(sub, number);
    await decide(id, 'approved');
    await app.query(`UPDATE member_account SET status = 'member', approved_by_sub = 'officer-1', approved_at = now(), verified_on = current_date WHERE sub = $1`, [sub]);
    return id;
  };
  const rejected = async (sub: string): Promise<string> => {
    const id = await signup(sub);
    await decide(id, 'rejected');
    await app.query(`UPDATE member_account SET status = 'removed', removed_at = now() WHERE sub = $1`, [sub]);
    return id;
  };
  const reopened = async (sub: string): Promise<string> => {
    const id = await rejected(sub);
    await app.query(`UPDATE signup_request SET reopened_at = now(), reopened_by_sub = 'admin-1' WHERE id = $1`, [id]);
    await app.query(`DELETE FROM member_account WHERE sub = $1`, [sub]);
    return id;
  };
  const remove = (sub: string) => app.query(`UPDATE member_account SET status = 'removed', removed_at = now() WHERE sub = $1`, [sub]);
  const row = (id: string) =>
    one<Record<string, unknown>>(
      `SELECT display_name, email, first_name, last_name, membership_number, decision, decided_by_sub, decided_at IS NOT NULL AS dated, created_at IS NOT NULL AS created,
              erased_at IS NOT NULL AS erased, erased_by_sub FROM signup_request WHERE id = $1`,
      [id],
    );
  const typed = (id: string) => one<Record<string, unknown>>(`SELECT first_name, last_name, membership_number FROM signup_request WHERE id = $1`, [id]);
  const status = async (sub: string) => (await one<{ status: string } | undefined>(`SELECT status FROM member_account WHERE sub = $1`, [sub]))?.status;
  const erase = (id: string, sub = 'admin-1', groups = ADMIN, client = app) => sqlstate(client, `SELECT * FROM signup_request_erase($1, $2, $3, NULL)`, [id, sub, groups]);
  const correct = (id: string, number: string, reason = 'Two digits were swapped at sign-up', sub = 'admin-1', groups = ADMIN) =>
    sqlstate(app, `SELECT signup_request_correct_number($1, $2, $3, $4, $5, NULL)`, [id, number, reason, sub, groups]);
  const audit = async (id: string): Promise<Record<string, unknown>[]> =>
    (await app.query<Record<string, unknown>>(`SELECT action, actor_sub, from_state, to_state, note, payload, at IS NOT NULL AS dated FROM audit_event WHERE subject_id = $1 ORDER BY id`, [id])).rows;
  const ERASED = { ...PII, erased: true, erased_by_sub: 'admin-1', dated: true, created: true, decided_by_sub: 'officer-1' };

  /** Runs fn in a transaction that is always rolled back, so a failed expectation never leaves one open. */
  const rolledBack = async (client: pg.Client, fn: () => Promise<void>): Promise<void> => {
    await client.query('BEGIN');
    try {
      await fn();
    } finally {
      await client.query('ROLLBACK');
    }
  };

  beforeAll(async () => {
    db = await freshDatabase('nwfl_erase0034');
    const run = await migrate(db);
    if (run.code !== 0) throw new Error(`migrate failed: ${run.stderr}`);
    app = new pgLib.Client({ connectionString: urlFor(APP, APP_PW, db) });
    await app.connect();
    owner = new pgLib.Client({ connectionString: urlFor(MIGRATOR, MIGRATOR_PW, db) });
    await owner.connect();
  });

  afterAll(async () => {
    await app?.end();
    await owner?.end();
    if (db !== undefined) await dropDatabase(db);
  });

  describe('REMOVE: the Admin erases a sign-up record', () => {
    it('erases an approved member\'s record, keeps the date and the decision, and ends the account', async () => {
      const id = await approved('e-approved');
      expect(await one(`SELECT * FROM signup_request_erase($1, 'admin-1', $2, NULL)`, [id, ADMIN])).toEqual({ erased: 1, access_ended: true });
      expect(await row(id)).toEqual({ ...ERASED, decision: 'approved' });
      expect(await status('e-approved')).toBe('removed');
      expect(await audit(id)).toEqual([{ action: 'erase', actor_sub: 'admin-1', from_state: 'approved', to_state: 'erased', note: null, payload: {}, dated: true }]);
      expect((await audit('e-approved')).at(-1)).toMatchObject({ action: 'remove', actor_sub: 'admin-1', from_state: 'member', to_state: 'removed', note: null, payload: {} });
    });

    it('erases the record of an account already removed', async () => {
      const id = await approved('e-removed');
      await remove('e-removed');
      expect(await one(`SELECT * FROM signup_request_erase($1, 'admin-1', $2, NULL)`, [id, ADMIN])).toEqual({ erased: 1, access_ended: false });
      expect(await row(id)).toEqual({ ...ERASED, decision: 'approved' });
    });

    it('erases a rejected sign-up', async () => {
      const id = await rejected('e-rejected');
      expect(await erase(id)).toBe('ok');
      expect(await row(id)).toEqual({ ...ERASED, decision: 'rejected' });
      expect((await audit(id))[0]).toMatchObject({ action: 'erase', from_state: 'rejected', to_state: 'erased' });
    });

    it('erases a reopened sign-up, and with it every other decided sign-up of that person', async () => {
      const first = await reopened('e-reopened');
      const second = await approved('e-reopened', '7654321');
      expect(await one(`SELECT * FROM signup_request_erase($1, 'admin-1', $2, NULL)`, [first, ADMIN])).toEqual({ erased: 2, access_ended: true });
      expect(await row(first)).toEqual({ ...ERASED, decision: 'rejected' });
      expect(await row(second)).toEqual({ ...ERASED, decision: 'approved' });
      expect((await audit(first))[0]).toMatchObject({ action: 'erase', from_state: 'reopened', to_state: 'erased' });
    });

    it('writes nothing the second time', async () => {
      const id = await rejected('e-twice');
      expect(await erase(id)).toBe('ok');
      expect(await one(`SELECT * FROM signup_request_erase($1, 'admin-1', $2, NULL)`, [id, ADMIN])).toEqual({ erased: 0, access_ended: false });
      expect(await audit(id)).toHaveLength(1);
    });

    it('refuses a pending sign-up, and a decided one while the person has another pending', async () => {
      const pending = await signup('e-pending');
      expect(await erase(pending)).toBe(NOT_IN_PREREQUISITE_STATE);
      const old = await reopened('e-again');
      await signup('e-again');
      expect(await erase(old)).toBe(NOT_IN_PREREQUISITE_STATE);
      expect(await row(old)).toMatchObject({ display_name: 'Pat Example', erased: false });
    });

    it('refuses a sign-up that does not exist, and the Admin\'s own', async () => {
      expect(await erase('00000000-0000-4000-8000-000000000000')).toBe(NO_DATA_FOUND);
      const own = await approved('admin-1');
      expect(await erase(own)).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await row(own)).toMatchObject({ display_name: 'Pat Example', erased: false });
    });

    it.each(NOT_ADMIN)('refuses %s', async (who, groups) => {
      const id = await rejected(`e-role-${who.replace(/\W/g, '')}`);
      expect(await erase(id, 'someone-1', groups)).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await row(id)).toMatchObject({ display_name: 'Pat Example', email: 'pat@example.org', erased: false });
    });

    it('refuses a caller with no subject, the Admin\'s groups or not', async () => {
      const id = await rejected('e-nosub');
      expect(await erase(id, '', ADMIN)).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await sqlstate(app, `SELECT * FROM signup_request_erase($1, NULL, NULL, NULL)`, [id])).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it('is not PUBLIC\'s to call, nor the worker\'s', async () => {
      const { rows } = await owner.query(
        `SELECT p.proname, has_function_privilege('public', p.oid, 'EXECUTE') AS public, has_function_privilege('nwfl', p.oid, 'EXECUTE') AS app,
                has_function_privilege('nwfl_worker', p.oid, 'EXECUTE') AS worker
         FROM pg_proc p WHERE p.proname IN ('signup_request_erase', 'signup_request_correct_number', 'membership_reason_ok') ORDER BY 1`,
      );
      expect(rows).toEqual([
        { proname: 'membership_reason_ok', public: false, app: false, worker: false },
        { proname: 'signup_request_correct_number', public: false, app: true, worker: false },
        { proname: 'signup_request_erase', public: false, app: true, worker: false },
      ]);
    });

    describe('by no other write', () => {
      const BLANK = `UPDATE signup_request SET display_name = NULL, email = NULL, first_name = NULL, last_name = NULL, membership_number = NULL,
                       erased_at = now(), erased_by_sub = 'admin-1' WHERE id = $1`;

      it.each(['the app role', 'the owner'])('refuses %s blanking a decided row by hand', async (who) => {
        const client = who === 'the owner' ? owner : app;
        const id = await rejected(`e-hand-${who.replace(/\W/g, '')}`);
        expect(await sqlstate(client, BLANK, [id])).toBe(NOT_IN_PREREQUISITE_STATE);
        // The function's marker alone is not enough: the erasure needs its audit row, by the Admin.
        await rolledBack(client, async () => {
          await client.query(`SELECT set_config('nwfl.signup_erase', $1, true)`, [id]);
          expect(await sqlstate(client, BLANK, [id])).toBe(NOT_IN_PREREQUISITE_STATE);
        });
        expect(await row(id)).toMatchObject({ display_name: 'Pat Example', erased: false });
      });

      it('refuses an erasure that changes anything else, or keeps a value back', async () => {
        const id = await rejected('e-partial');
        await rolledBack(app, async () => {
          await app.query(
            `INSERT INTO audit_event (actor_kind, actor_sub, actor_groups, action, subject_kind, subject_id) VALUES ('user', 'admin-1', $2, 'erase', 'signup_request', $1)`,
            [id, ADMIN],
          );
          await app.query(`SELECT set_config('nwfl.signup_erase', $1, true)`, [id]);
          await app.query('SAVEPOINT s');
          expect(await sqlstate(app, `${BLANK.replace('WHERE', `, decision = 'approved' WHERE`)}`, [id])).toBe(NOT_IN_PREREQUISITE_STATE);
          await app.query('ROLLBACK TO s');
          expect(await sqlstate(app, `UPDATE signup_request SET display_name = NULL, email = NULL, erased_at = now(), erased_by_sub = 'admin-1' WHERE id = $1`, [id])).toBe(CHECK_VIOLATION);
        });
      });

      it('refuses a row marked erased without who, and a pending row marked erased', async () => {
        expect(await sqlstate(owner, `INSERT INTO signup_request (sub, erased_at) VALUES ('e-nowho', now())`)).toBe(CHECK_VIOLATION);
        expect(await sqlstate(owner, `INSERT INTO signup_request (sub, erased_at, erased_by_sub) VALUES ('e-pend', now(), 'admin-1')`)).toBe(CHECK_VIOLATION);
        // And a row not erased still needs its name and email.
        expect(await sqlstate(app, `INSERT INTO signup_request (sub, email) VALUES ('e-noname', 'pat@example.org')`)).toBe(CHECK_VIOLATION);
        expect(await sqlstate(app, `INSERT INTO signup_request (sub, display_name) VALUES ('e-noemail', 'Pat Example')`)).toBe(CHECK_VIOLATION);
      });
    });

    describe('an erased row', () => {
      it.each([
        ['a name put back', `display_name = 'Pat Example', email = 'pat@example.org'`],
        ['a first name', `first_name = 'Pat'`],
        ['a number', `membership_number = '1234567'`],
        ['the erasure undone', `erased_at = NULL, erased_by_sub = NULL`],
        ['another eraser', `erased_by_sub = 'admin-2'`],
        ['another decision', `decision = 'approved'`],
        ['another check result', `verification = 'not_found', verified_on = current_date`],
      ])('refuses %s, for the app role and the owner', async (what, set) => {
        const id = await rejected(`e-final-${what.replace(/\W/g, '')}`);
        expect(await erase(id)).toBe('ok');
        for (const client of [app, owner]) expect([NOT_IN_PREREQUISITE_STATE, CHECK_VIOLATION]).toContain(await sqlstate(client, `UPDATE signup_request SET ${set} WHERE id = $1`, [id]));
        expect(await row(id)).toEqual({ ...ERASED, decision: 'rejected' });
      });

      it('is still never deleted', async () => {
        const id = await rejected('e-nodelete');
        expect(await erase(id)).toBe('ok');
        expect(await sqlstate(owner, `DELETE FROM signup_request WHERE id = $1`, [id])).toBe(NOT_IN_PREREQUISITE_STATE);
      });

      it('is still reopened when it was rejected, once, so the person can sign up again', async () => {
        const id = await rejected('e-reopen');
        expect(await erase(id)).toBe('ok');
        expect(await sqlstate(app, `UPDATE signup_request SET reopened_at = now(), reopened_by_sub = 'admin-1' WHERE id = $1`, [id])).toBe('ok');
        expect(await sqlstate(app, `DELETE FROM member_account WHERE sub = 'e-reopen'`)).toBe('ok');
        expect(await sqlstate(app, `UPDATE signup_request SET reopened_at = now() WHERE id = $1`, [id])).toBe(NOT_IN_PREREQUISITE_STATE);
        expect(await row(id)).toEqual({ ...ERASED, decision: 'rejected' });
        await signup('e-reopen', '2223334');
      });
    });
  });

  describe('CORRECT: the Admin corrects a membership number', () => {
    it('changes the number, and audits who, when and the reason, never a number', async () => {
      const id = await approved('c-ok', '1234567');
      expect(await correct(id, '1234576', '  Two digits were swapped at sign-up.  ')).toBe('ok');
      expect(await typed(id)).toEqual({ first_name: 'Pat', last_name: 'Example', membership_number: '1234576' });
      const rows = await audit(id);
      expect(rows).toEqual([{ action: 'correct_number', actor_sub: 'admin-1', from_state: null, to_state: null, note: 'Two digits were swapped at sign-up.', payload: {}, dated: true }]);
      expect(JSON.stringify(rows)).not.toMatch(/1234567|1234576/);
    });

    it.each(NOT_ADMIN)('refuses %s', async (who, groups) => {
      const id = await approved(`c-role-${who.replace(/\W/g, '')}`);
      expect(await correct(id, '7654321', 'A typing slip', 'someone-1', groups)).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await typed(id)).toMatchObject({ membership_number: '1234567' });
    });

    it('refuses a caller with no subject, and the Admin\'s own number', async () => {
      const id = await approved('c-nosub');
      expect(await correct(id, '7654321', 'A typing slip', '')).toBe(INSUFFICIENT_PRIVILEGE);
      const own = await approved('admin-9');
      expect(await correct(own, '7654321', 'A typing slip', 'admin-9')).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await typed(own)).toMatchObject({ membership_number: '1234567' });
    });

    it.each([['letters', '12345a7'], ['thirteen digits', '1234567890123'], ['nothing', ''], ['spaces', '123 4567'], ['a full-width digit', '123456７']])(
      'refuses a number that is %s',
      async (what, number) => {
        const id = await approved(`c-number-${what.replace(/\W/g, '')}`);
        expect(await correct(id, number)).toBe(INVALID_PARAMETER);
        expect(await typed(id)).toMatchObject({ membership_number: '1234567' });
      },
    );

    it('refuses no number at all', async () => {
      const id = await approved('c-null');
      expect(await sqlstate(app, `SELECT signup_request_correct_number($1, NULL, 'A typing slip', 'admin-1', $2, NULL)`, [id, ADMIN])).toBe(INVALID_PARAMETER);
    });

    it.each([
      ['the old number', 'It was 1234567 before'],
      ['the new number', 'Should be 7654321'],
      ['one digit', 'Digit 7 was wrong'],
      ['digits with spaces between', 'It was 1 2 3 4 5 6 7'],
      ['digits with letters between', 'It was 1a2b3c4d5e6f7'],
      ['full-width digits', 'It was １２３４５６７'],
      ['Arabic-Indic digits', 'It was ١٢٣'],
      ['Devanagari digits', 'It was १२'],
      ['circled digits', 'It was ①②③'],
      ['superscript digits', 'It was ¹²³'],
      ['a fraction', 'About ½ of it'],
      ['a control character', 'A typing\u0000slip'],
      ['no words', '...'],
      ['nothing', ''],
      ['only spaces', ' \t\n '],
      ['501 characters', 'a'.repeat(501)],
    ])('refuses a reason with %s, and changes nothing', async (what, reason) => {
      const id = await approved(`c-reason-${what.replace(/\W/g, '')}`);
      // Whatever SQLSTATE the driver gives a NUL, the number is unchanged and nothing is audited.
      expect(await correct(id, '7654321', reason)).not.toBe('ok');
      if (!reason.includes('\u0000')) expect(await correct(id, '7654321', reason)).toBe(INVALID_PARAMETER);
      expect(await typed(id)).toMatchObject({ membership_number: '1234567' });
      expect(await audit(id)).toEqual([]);
    });

    it('takes a reason in words of any script, with punctuation and line breaks, up to 500 characters', async () => {
      const id = await approved('c-words');
      expect(await correct(id, '7654321', 'Café note: the member’s card (seen by the officer) says otherwise.\nChecked — twice!')).toBe('ok');
      expect(await correct(id, '7654322', 'a'.repeat(500))).toBe('ok');
    });

    it('refuses a null reason', async () => {
      const id = await approved('c-nullreason');
      expect(await sqlstate(app, `SELECT signup_request_correct_number($1, '7654321', NULL, 'admin-1', $2, NULL)`, [id, ADMIN])).toBe(INVALID_PARAMETER);
    });

    it('refuses the number already on the profile, and a sign-up that does not exist', async () => {
      const id = await approved('c-same');
      expect(await correct(id, '1234567')).toBe(NOT_IN_PREREQUISITE_STATE);
      expect(await correct('00000000-0000-4000-8000-000000000000', '7654321')).toBe(NO_DATA_FOUND);
    });

    it('refuses a sign-up that is pending, rejected, reopened, removed or erased', async () => {
      const removed = await approved('c-removed');
      await remove('c-removed');
      const erased = await rejected('c-erased');
      expect(await erase(erased)).toBe('ok');
      for (const id of [await signup('c-pending'), await rejected('c-rejected'), await reopened('c-reopened'), removed, erased]) {
        expect(await correct(id, '7654321')).toBe(NOT_IN_PREREQUISITE_STATE);
      }
    });

    describe('by no other write', () => {
      const SET = `UPDATE signup_request SET membership_number = '7654321' WHERE id = $1`;

      it.each(['the app role', 'the owner'])('refuses %s changing a number by hand, in every state', async (who) => {
        const client = who === 'the owner' ? owner : app;
        const tag = who.replace(/\W/g, '');
        for (const id of [await signup(`c-hand-p-${tag}`), await approved(`c-hand-a-${tag}`), await rejected(`c-hand-r-${tag}`), await reopened(`c-hand-o-${tag}`)]) {
          expect(await sqlstate(client, SET, [id])).toBe(NOT_IN_PREREQUISITE_STATE);
          expect(await sqlstate(client, `UPDATE signup_request SET membership_number = NULL WHERE id = $1`, [id])).toBe(NOT_IN_PREREQUISITE_STATE);
          // The function's marker alone is not enough: the change needs its audit row, by the Admin, with a reason.
          await rolledBack(client, async () => {
            await client.query(`SELECT set_config('nwfl.signup_correct_number', $1, true)`, [id]);
            expect(await sqlstate(client, SET, [id])).toBe(NOT_IN_PREREQUISITE_STATE);
          });
          expect(await typed(id)).toMatchObject({ membership_number: '1234567' });
        }
      });

      it('refuses a correction that changes anything else with it', async () => {
        const id = await approved('c-more');
        await rolledBack(app, async () => {
          await app.query(
            `INSERT INTO audit_event (actor_kind, actor_sub, actor_groups, action, subject_kind, subject_id, note) VALUES ('user', 'admin-1', $2, 'correct_number', 'signup_request', $1, 'A typing slip')`,
            [id, ADMIN],
          );
          await app.query(`SELECT set_config('nwfl.signup_correct_number', $1, true)`, [id]);
          expect(await sqlstate(app, `UPDATE signup_request SET membership_number = '7654321', last_name = 'Other' WHERE id = $1`, [id])).toBe(NOT_IN_PREREQUISITE_STATE);
        });
      });
    });

    describe('the audit log', () => {
      const NOTE = `INSERT INTO audit_event (actor_kind, actor_sub, action, subject_kind, subject_id, note) VALUES ('user', 'admin-1', $1, $2, 'x', $3)`;

      it('still takes no note on a membership record, but a correction\'s reason', async () => {
        expect(await sqlstate(app, NOTE, ['approve', 'signup_request', 'a note'])).toBe(CHECK_VIOLATION);
        expect(await sqlstate(app, NOTE, ['remove', 'member_account', 'a note'])).toBe(CHECK_VIOLATION);
        expect(await sqlstate(app, NOTE, ['correct_number', 'member_account', 'a note'])).toBe(CHECK_VIOLATION);
        expect(await sqlstate(app, NOTE, ['correct_number', 'signup_request', 'A typing slip'])).toBe('ok');
      });

      it.each(['Was 1234567', 'Was １２', 'Was ١', '', '...', 'a'.repeat(501)])('refuses a correction\'s reason %j written straight to the log', async (note) => {
        expect(await sqlstate(app, NOTE, ['correct_number', 'signup_request', note])).toBe(CHECK_VIOLATION);
      });

      it('still takes no payload on a membership record', async () => {
        expect(
          await sqlstate(app, `INSERT INTO audit_event (actor_kind, actor_sub, action, subject_kind, subject_id, note, payload) VALUES ('user', 'a', 'correct_number', 'signup_request', 'x', 'A slip', '{"n":"1"}')`),
        ).toBe(CHECK_VIOLATION);
      });
    });
  });

  describe('REMOVAL: a removed account\'s profile', () => {
    it.each(['member', 'lapsed', 'affiliate'])('is erased in the same statement as the removal of a %s', async (from) => {
      const sub = `r-${from}`;
      const id = await approved(sub);
      if (from === 'lapsed') await app.query(`UPDATE member_account SET status = 'lapsed' WHERE sub = $1`, [sub]);
      if (from === 'affiliate') await app.query(`UPDATE member_account SET status = 'affiliate', affiliate_granted_by_sub = 'admin-1', affiliate_granted_at = now() WHERE sub = $1`, [sub]);
      expect(await typed(id)).toEqual({ first_name: 'Pat', last_name: 'Example', membership_number: '1234567' });
      await remove(sub);
      expect(await typed(id)).toEqual({ first_name: null, last_name: null, membership_number: null });
      // The sign-up's own record stays until the person asks: the name and email of the sign-in, the date, the decision.
      expect(await row(id)).toMatchObject({ display_name: 'Pat Example', email: 'pat@example.org', decision: 'approved', dated: true, erased: false });
    });

    it('is erased by the owner\'s removal too, and rolls back with it', async () => {
      const id = await approved('r-owner');
      await rolledBack(owner, async () => {
        await owner.query(`UPDATE member_account SET status = 'removed', removed_at = now() WHERE sub = 'r-owner'`);
        const { rows } = await owner.query(`SELECT first_name, last_name, membership_number FROM signup_request WHERE id = $1`, [id]);
        expect(rows).toEqual([{ first_name: null, last_name: null, membership_number: null }]);
      });
      expect(await typed(id)).toEqual({ first_name: 'Pat', last_name: 'Example', membership_number: '1234567' });
    });

    it.each([
      ['a name', `first_name = 'Pat', last_name = 'Example'`],
      ['one name', `last_name = 'Example'`],
      ['the number', `membership_number = '1234567'`],
    ])('stays erased: %s is not put back, by the app role or the owner', async (what, set) => {
      const sub = `r-stays-${what.replace(/\W/g, '')}`;
      const id = await approved(sub);
      await remove(sub);
      for (const client of [app, owner]) expect([NOT_IN_PREREQUISITE_STATE, CHECK_VIOLATION]).toContain(await sqlstate(client, `UPDATE signup_request SET ${set} WHERE id = $1`, [id]));
      expect(await correct(id, '7654321')).toBe(NOT_IN_PREREQUISITE_STATE);
      expect(await typed(id)).toEqual({ first_name: null, last_name: null, membership_number: null });
    });

    it('is not erased by a rejection, which keeps what was typed for a reopening', async () => {
      const id = await rejected('r-rejected');
      expect(await typed(id)).toEqual({ first_name: 'Pat', last_name: 'Example', membership_number: '1234567' });
    });

    it('is not erased while the account stands: no number goes alone, and a member\'s names still change', async () => {
      const id = await approved('r-live');
      expect(await sqlstate(app, `UPDATE signup_request SET first_name = NULL, last_name = NULL, membership_number = NULL WHERE id = $1`, [id])).toBe(NOT_IN_PREREQUISITE_STATE);
      expect(await sqlstate(app, `UPDATE signup_request SET first_name = 'Patricia', last_name = 'Sample' WHERE id = $1`, [id])).toBe('ok');
      await remove('r-live');
      expect(await typed(id)).toEqual({ first_name: null, last_name: null, membership_number: null });
    });
  });

  describe('the rules from before', () => {
    it('still refuse a decided row another decision, decider or time', async () => {
      const id = await approved('o-decided');
      for (const set of [`decision = 'rejected'`, `decided_by_sub = 'officer-2'`, `decided_at = now() + interval '1 day'`]) {
        expect(await sqlstate(app, `UPDATE signup_request SET ${set} WHERE id = $1`, [id])).toBe(NOT_IN_PREREQUISITE_STATE);
      }
    });

    it('still refuse a pending or rejected sign-up\'s names changing', async () => {
      for (const id of [await signup('o-pending'), await rejected('o-rejected')]) {
        expect(await sqlstate(app, `UPDATE signup_request SET first_name = 'Other' WHERE id = $1`, [id])).toBe(NOT_IN_PREREQUISITE_STATE);
      }
    });

    it('still refuse any change of a reopened row but its erasure', async () => {
      const id = await reopened('o-reopened');
      for (const set of [`display_name = 'Other'`, `email = 'other@example.org'`, `verification = 'not_found', verified_on = current_date`, `reopened_by_sub = 'admin-2'`]) {
        expect(await sqlstate(app, `UPDATE signup_request SET ${set} WHERE id = $1`, [id])).toBe(NOT_IN_PREREQUISITE_STATE);
      }
      expect(await erase(id)).toBe('ok');
    });
  });
});
