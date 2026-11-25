// PROFILE-ERASE (0036), exercised as the APPLICATION role and as the owner.
//   REMOVE   signup_request_erase, the Admin's alone, blanks the display name, the email, the two names
//            and the number of every decided sign-up of a person: approved, rejected, reopened, and one
//            whose account is already removed. The date and the decision stay. No other write erases a
//            row, the owner's included, and an erased row changes no more (a rejected one is still
//            reopened).
//   CORRECT  signup_request_correct_number, the Admin's alone, is the one way a stored number changes.
//            Its audit row holds who, when and the reason as one of three fixed codes, never a number
//            and never a note: no free text is taken, by the function or by the audit table's own CHECK.
//            A number already on another live sign-up (pending, or approved and not erased) is refused.
//   REMOVAL  a member's account that becomes removed loses the profile (first name, last name, number)
//            on every decided sign-up of that person, a reopened earlier one included, in the same
//            statement, and it stays erased. A rejection, or the removal of a person still waiting,
//            keeps what was typed. A member removed before 0036 is erased by 0036 itself.
//   STATS    after an erasure the table is analysed again, so pg_stats, which the app role reads, holds
//            no erased value.
// Every subject and value here is made up.
import type pg from 'pg';
import pgLib from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP, APP_PW, MIGRATOR, MIGRATOR_PW, dockerExec, dropDatabase, freshDatabase, live, migrate, sqlstate, urlFor } from '../helpers/pg.js';

const CHECK_VIOLATION = '23514';
const NOT_IN_PREREQUISITE_STATE = '55000';
const INSUFFICIENT_PRIVILEGE = '42501';
const INVALID_PARAMETER = '22023';
const NO_DATA_FOUND = 'P0002';
const UNIQUE_VIOLATION = '23505';
/** The three fixed reasons for a correction, as stored (0036). */
const REASONS = ['typed_wrong', 'card_differs', 'new_number'];
const NO_PROFILE = { first_name: null, last_name: null, membership_number: null };

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

describe.skipIf(!live)('schema after PROFILE-ERASE (0036)', () => {
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
  const correct = (id: string, number: string, reason = 'typed_wrong', sub = 'admin-1', groups = ADMIN) =>
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
    db = await freshDatabase('nwfl_erase0036');
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
         FROM pg_proc p WHERE p.proname IN ('signup_request_erase', 'signup_request_correct_number', 'signup_request_erase_profile', 'membership_reason_ok') ORDER BY 1`,
      );
      // The free-text reason's check (membership_reason_ok) is gone with the free text (F5).
      expect(rows).toEqual([
        { proname: 'signup_request_correct_number', public: false, app: true, worker: false },
        { proname: 'signup_request_erase', public: false, app: true, worker: false },
        { proname: 'signup_request_erase_profile', public: false, app: false, worker: false },
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
    it('changes the number, and audits who, when and the reason as its code, never a number and never a note', async () => {
      const id = await approved('c-ok', '1234567');
      expect(await correct(id, '1234576', 'typed_wrong')).toBe('ok');
      expect(await typed(id)).toEqual({ first_name: 'Pat', last_name: 'Example', membership_number: '1234576' });
      const rows = await audit(id);
      expect(rows).toEqual([{ action: 'correct_number', actor_sub: 'admin-1', from_state: null, to_state: 'typed_wrong', note: null, payload: {}, dated: true }]);
      expect(JSON.stringify(rows)).not.toMatch(/1234567|1234576/);
    });

    it('takes each of the three fixed reasons, and keeps it as its code', async () => {
      const id = await approved('c-codes', '8100000');
      let n = 0;
      for (const reason of REASONS) {
        n += 1;
        expect(await correct(id, `810000${n}`, reason), reason).toBe('ok');
      }
      expect((await audit(id)).map((r) => [r.to_state, r.note])).toEqual(REASONS.map((r) => [r, null]));
    });

    it.each(NOT_ADMIN)('refuses %s', async (who, groups) => {
      const id = await approved(`c-role-${who.replace(/\W/g, '')}`);
      expect(await correct(id, '7654321', 'typed_wrong', 'someone-1', groups)).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await typed(id)).toMatchObject({ membership_number: '1234567' });
    });

    it('refuses a caller with no subject, and the Admin\'s own number', async () => {
      const id = await approved('c-nosub');
      expect(await correct(id, '7654321', 'typed_wrong', '')).toBe(INSUFFICIENT_PRIVILEGE);
      const own = await approved('admin-9');
      expect(await correct(own, '7654321', 'typed_wrong', 'admin-9')).toBe(INSUFFICIENT_PRIVILEGE);
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
      expect(await sqlstate(app, `SELECT signup_request_correct_number($1, NULL, 'typed_wrong', 'admin-1', $2, NULL)`, [id, ADMIN])).toBe(INVALID_PARAMETER);
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
      // F5 (challenge P3): no free text at all, so nothing that could carry a number or a name.
      ['a number spelled out', 'Old number was seven six five four three two one'],
      ['CJK numerals', '旧番号は七六五四三二一'],
      ['Roman numerals', 'Number was MMMCCCXXI thousand'],
      ['the member\'s last name', 'Example typed it wrong'],
      ['plain words', 'Two digits were swapped at sign-up'],
      ['a fixed reason\'s words, not its code', 'Typed wrong at sign-up'],
      ['a code in capitals', 'TYPED_WRONG'],
      ['a code with a space before it', ' typed_wrong'],
      ['a code that is not one', 'other'],
    ])('refuses a reason with %s, and changes nothing', async (what, reason) => {
      const id = await approved(`c-reason-${what.replace(/\W/g, '')}`);
      // Whatever SQLSTATE the driver gives a NUL, the number is unchanged and nothing is audited.
      expect(await correct(id, '7654321', reason)).not.toBe('ok');
      if (!reason.includes('\u0000')) expect(await correct(id, '7654321', reason)).toBe(INVALID_PARAMETER);
      expect(await typed(id)).toMatchObject({ membership_number: '1234567' });
      expect(await audit(id)).toEqual([]);
    });

    // Before F5 this test took a reason in words of any script; now no words are taken at all.
    it('refuses a reason in words of any script, with punctuation and line breaks: only the three codes are kept', async () => {
      const id = await approved('c-words');
      expect(await correct(id, '7654321', 'Café note: the member’s card (seen by the officer) says otherwise.\nChecked — twice!')).toBe(INVALID_PARAMETER);
      expect(await correct(id, '7654322', 'a'.repeat(500))).toBe(INVALID_PARAMETER);
      expect(await audit(id)).toEqual([]);
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

    it('refuses a new number already on another live sign-up, pending or approved, and changes nothing (F7)', async () => {
      const id = await approved('c-dup', '3000001');
      await approved('c-dup-held', '3000002');
      await signup('c-dup-waiting', '3000003');
      for (const number of ['3000002', '3000003']) expect(await correct(id, number), number).toBe(UNIQUE_VIOLATION);
      expect(await typed(id)).toMatchObject({ membership_number: '3000001' });
      expect(await audit(id)).toEqual([]);
    });

    it('takes a number held only by a sign-up that is not live: rejected, reopened, erased, or a removed member\'s', async () => {
      const id = await approved('c-free', '3100001');
      const turnedDown = await signup('c-free-rej', '3100002');
      await decide(turnedDown, 'rejected');
      const reopenedOne = await signup('c-free-reo', '3100003');
      await decide(reopenedOne, 'rejected');
      await remove('c-free-reo');
      await app.query(`UPDATE signup_request SET reopened_at = now(), reopened_by_sub = 'admin-1' WHERE id = $1`, [reopenedOne]);
      expect(await erase(await approved('c-free-era', '3100004'))).toBe('ok');
      await approved('c-free-rem', '3100005');
      await remove('c-free-rem');
      for (const number of ['3100002', '3100003', '3100004', '3100005']) expect(await correct(id, number), number).toBe('ok');
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
            `INSERT INTO audit_event (actor_kind, actor_sub, actor_groups, action, subject_kind, subject_id, to_state) VALUES ('user', 'admin-1', $2, 'correct_number', 'signup_request', $1, 'typed_wrong')`,
            [id, ADMIN],
          );
          await app.query(`SELECT set_config('nwfl.signup_correct_number', $1, true)`, [id]);
          expect(await sqlstate(app, `UPDATE signup_request SET membership_number = '7654321', last_name = 'Other' WHERE id = $1`, [id])).toBe(NOT_IN_PREREQUISITE_STATE);
        });
      });
    });

    describe('the audit log', () => {
      const NOTE = `INSERT INTO audit_event (actor_kind, actor_sub, action, subject_kind, subject_id, note) VALUES ('user', 'admin-1', $1, $2, 'x', $3)`;

      // Before F5 a correction's reason was the one note a membership record took; now it takes none.
      it('still takes no note on a membership record, a correction\'s included', async () => {
        expect(await sqlstate(app, NOTE, ['approve', 'signup_request', 'a note'])).toBe(CHECK_VIOLATION);
        expect(await sqlstate(app, NOTE, ['remove', 'member_account', 'a note'])).toBe(CHECK_VIOLATION);
        expect(await sqlstate(app, NOTE, ['correct_number', 'member_account', 'a note'])).toBe(CHECK_VIOLATION);
        expect(await sqlstate(app, NOTE, ['correct_number', 'signup_request', 'A typing slip'])).toBe(CHECK_VIOLATION);
      });

      const CODED = `INSERT INTO audit_event (actor_kind, actor_sub, action, subject_kind, subject_id, to_state) VALUES ('user', 'admin-1', 'correct_number', 'signup_request', 'x', $1)`;

      it.each(REASONS)('takes a correction coded %s written straight to the log', async (code) => {
        expect(await sqlstate(app, CODED, [code])).toBe('ok');
      });

      it.each([null, '', 'other', 'Typed wrong at sign-up', 'TYPED_WRONG', '1234567'])('refuses a correction coded %j written straight to the log', async (code) => {
        expect(await sqlstate(app, CODED, [code])).toBe(CHECK_VIOLATION);
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

    it('is erased from every decided sign-up of the member, a reopened earlier one included, and nothing else on it changes (F2)', async () => {
      const first = await reopened('r-earlier');
      const rest = async (id: string) =>
        (await one<{ rest: unknown }>(`SELECT to_jsonb(s) - ARRAY['first_name', 'last_name', 'membership_number'] AS rest FROM signup_request s WHERE id = $1`, [id])).rest;
      const before = await rest(first);
      const second = await approved('r-earlier', '5100001');
      expect(await typed(first)).toEqual({ first_name: 'Pat', last_name: 'Example', membership_number: '1234567' });
      await remove('r-earlier');
      expect(await typed(first)).toEqual(NO_PROFILE);
      expect(await typed(second)).toEqual(NO_PROFILE);
      expect(await rest(first)).toEqual(before);
      // It stays erased, and the reopened row still takes no other change, for the app role or the owner.
      for (const client of [app, owner]) {
        expect(await sqlstate(client, `UPDATE signup_request SET first_name = 'Pat' WHERE id = $1`, [first])).toBe(NOT_IN_PREREQUISITE_STATE);
        expect(await sqlstate(client, `UPDATE signup_request SET display_name = 'Other' WHERE id = $1`, [first])).toBe(NOT_IN_PREREQUISITE_STATE);
      }
      // The Admin's erasure on request still takes the rest.
      expect(await erase(first)).toBe('ok');
      expect(await row(first)).toEqual({ ...ERASED, decision: 'rejected' });
    });

    it('opens a reopened row to that erasure alone: not while the account stands, not without an approved sign-up, never beyond the three fields', async () => {
      const NULLS = `UPDATE signup_request SET first_name = NULL, last_name = NULL, membership_number = NULL WHERE id = $1`;
      const marked = (client: pg.Client, sub: string, sql: string, id: string) =>
        rolledBack(client, async () => {
          await client.query(`SELECT set_config('nwfl.profile_erase', $1, true)`, [sub]);
          expect(await sqlstate(client, sql, [id])).toBe(NOT_IN_PREREQUISITE_STATE);
        });
      // The account stands: the marker alone opens nothing.
      const standing = await reopened('r-narrow-a');
      await approved('r-narrow-a', '5100002');
      for (const client of [app, owner]) await marked(client, 'r-narrow-a', NULLS, standing);
      // Removed, but never approved (a person removed while still waiting): what was typed stays.
      const waiting = await reopened('r-narrow-b');
      await signup('r-narrow-b', '5100003');
      await remove('r-narrow-b');
      for (const client of [app, owner]) await marked(client, 'r-narrow-b', NULLS, waiting);
      expect(await typed(waiting)).toEqual({ first_name: 'Pat', last_name: 'Example', membership_number: '1234567' });
      // Removed member: still only the three fields, all three, to nothing.
      const gone = await reopened('r-narrow-c');
      await approved('r-narrow-c', '5100004');
      await remove('r-narrow-c');
      for (const client of [app, owner]) await marked(client, 'r-narrow-c', `UPDATE signup_request SET email = 'other@example.org' WHERE id = $1`, gone);
    });

    it('is not erased when a person still waiting is removed: the sign-up is rejected and keeps what was typed (F3)', async () => {
      const id = await signup('r-waiting', '5300001');
      await app.query('BEGIN');
      await remove('r-waiting');
      await decide(id, 'rejected');
      await app.query('COMMIT');
      expect(await typed(id)).toEqual({ first_name: 'Pat', last_name: 'Example', membership_number: '5300001' });
    });

    it('is not erased while the account stands: no number goes alone, and a member\'s names still change', async () => {
      const id = await approved('r-live');
      expect(await sqlstate(app, `UPDATE signup_request SET first_name = NULL, last_name = NULL, membership_number = NULL WHERE id = $1`, [id])).toBe(NOT_IN_PREREQUISITE_STATE);
      expect(await sqlstate(app, `UPDATE signup_request SET first_name = 'Patricia', last_name = 'Sample' WHERE id = $1`, [id])).toBe('ok');
      await remove('r-live');
      expect(await typed(id)).toEqual({ first_name: null, last_name: null, membership_number: null });
    });
  });

  describe('STATS: pg_stats, which the app role reads, keeps no erased value (F4)', () => {
    let statsDb: string;
    let a: pg.Client;
    let o: pg.Client;
    const COLUMNS = ['display_name', 'email', 'first_name', 'last_name', 'membership_number'];
    /** The columns whose statistics, as the app role reads them, still hold a value matching marks. */
    const leaked = async (marks: RegExp): Promise<string[]> =>
      (
        await a.query<{ attname: string; v: string }>(
          `SELECT attname, coalesce(most_common_vals::text, '') || ' ' || coalesce(histogram_bounds::text, '') AS v FROM pg_stats
           WHERE schemaname = 'public' AND tablename = 'signup_request' AND attname = ANY ($1) ORDER BY attname`,
          [COLUMNS],
        )
      ).rows
        .filter((r) => marks.test(r.v))
        .map((r) => r.attname);
    /** Eight approved members, each with its own values under the tag. */
    const eight = async (tag: string, base: number): Promise<{ id: string; sub: string }[]> => {
      const made: { id: string; sub: string }[] = [];
      for (let i = 0; i < 8; i += 1) {
        const sub = `${tag}-${i}`;
        const { id } = (
          await a.query<{ id: string }>(
            `INSERT INTO signup_request (sub, display_name, email, first_name, last_name, membership_number) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [sub, `Pat ${tag}${i}`, `${tag}${i}@example.net`, `${tag}${i}`, `${tag}${i}`, String(base + i)],
          )
        ).rows[0] as { id: string };
        await a.query(`INSERT INTO member_account (sub, status, route) VALUES ($1, 'pending', 'signup')`, [sub]);
        await a.query(`UPDATE signup_request SET decision = 'approved', decided_at = now(), decided_by_sub = 'officer-1' WHERE id = $1`, [id]);
        await a.query(`UPDATE member_account SET status = 'member', approved_by_sub = 'officer-1', approved_at = now(), verified_on = current_date WHERE sub = $1`, [sub]);
        made.push({ id, sub });
      }
      return made;
    };

    beforeAll(async () => {
      statsDb = await freshDatabase('nwfl_erase0036_stats');
      const run = await migrate(statsDb);
      if (run.code !== 0) throw new Error(`migrate failed: ${run.stderr}`);
      a = new pgLib.Client({ connectionString: urlFor(APP, APP_PW, statsDb) });
      await a.connect();
      o = new pgLib.Client({ connectionString: urlFor(MIGRATOR, MIGRATOR_PW, statsDb) });
      await o.connect();
    });

    afterAll(async () => {
      await a?.end();
      await o?.end();
      if (statsDb !== undefined) await dropDatabase(statsDb);
    });

    it('after the Admin\'s erasure', async () => {
      const people = await eight('Statserase', 540000);
      await o.query('ANALYZE signup_request');
      // Not vacuous: the values are there first.
      expect(await leaked(/statserase|54000\d/i)).toEqual(COLUMNS);
      for (const { id } of people) expect(await sqlstate(a, `SELECT * FROM signup_request_erase($1, 'admin-1', $2, NULL)`, [id, ADMIN])).toBe('ok');
      expect(await leaked(/statserase|54000\d/i)).toEqual([]);
    });

    it('after a removal', async () => {
      const people = await eight('Statsremove', 550000);
      await o.query('ANALYZE signup_request');
      expect(await leaked(/statsremove|55000\d/i)).toEqual(COLUMNS);
      for (const { sub } of people) await a.query(`UPDATE member_account SET status = 'removed', removed_at = now() WHERE sub = $1`, [sub]);
      // The sign-in's name and email stay until the person asks; the three typed fields are gone, from the statistics too.
      expect((await leaked(/statsremove|55000\d/i)).filter((c) => ['first_name', 'last_name', 'membership_number'].includes(c))).toEqual([]);
    });
  });

  describe('BACKFILL: a member removed before 0036 is erased by 0036 (builder Q5)', () => {
    let old: string;

    afterAll(async () => {
      if (old) {
        await dockerExec(['sh', '-c', `rm -rf /tmp/${old}-pre`]);
        await dropDatabase(old);
      }
    });

    it('erases the profile on every decided sign-up of a removed member, and nothing else, of no one else', async () => {
      old = await freshDatabase('nwfl_erase0036_pre');
      const dir = `/tmp/${old}-pre`;
      // 0036 and every later migration left out, so the copy is the schema just before 0036.
      await dockerExec(['sh', '-c', `rm -rf ${dir} && mkdir -p ${dir} && cp /repo/migrations/*.sql ${dir}/ && for f in ${dir}/*.sql; do n=$(basename "$f"); n=\${n%%_*}; if [ "$n" -ge 36 ]; then rm "$f"; fi; done`]);
      const first = await migrate(old, dir);
      expect(first.code, first.stderr).toBe(0);
      const pre = new pgLib.Client({ connectionString: urlFor(APP, APP_PW, old) });
      await pre.connect();
      const ids: Record<string, string> = {};
      try {
        const put = async (key: string, sub: string, number: string) => {
          ids[key] = (
            await pre.query<{ id: string }>(
              `INSERT INTO signup_request (sub, display_name, email, first_name, last_name, membership_number) VALUES ($1, 'Pat Backfill', 'backfill@example.org', 'Pat', 'Backfill', $2) RETURNING id`,
              [sub, number],
            )
          ).rows[0]?.id as string;
          await pre.query(`INSERT INTO member_account (sub, status, route) VALUES ($1, 'pending', 'signup') ON CONFLICT (sub) DO NOTHING`, [sub]);
        };
        const decideOld = (key: string, decision: string) =>
          pre.query(`UPDATE signup_request SET decision = $2, decided_at = now(), decided_by_sub = 'officer-1' WHERE id = $1`, [ids[key], decision]);
        const approveOld = async (key: string, sub: string) => {
          await decideOld(key, 'approved');
          await pre.query(`UPDATE member_account SET status = 'member', approved_by_sub = 'officer-1', approved_at = now(), verified_on = current_date WHERE sub = $1`, [sub]);
        };
        const removeOld = (sub: string) => pre.query(`UPDATE member_account SET status = 'removed', removed_at = now() WHERE sub = $1`, [sub]);
        // Removed member, with a reopened earlier sign-up.
        await put('earlier', 'b-gone', '6100001');
        await decideOld('earlier', 'rejected');
        await removeOld('b-gone');
        await pre.query(`UPDATE signup_request SET reopened_at = now(), reopened_by_sub = 'admin-1' WHERE id = $1`, [ids['earlier']]);
        await pre.query(`DELETE FROM member_account WHERE sub = 'b-gone'`);
        await put('gone', 'b-gone', '6100002');
        await approveOld('gone', 'b-gone');
        await removeOld('b-gone');
        // A member still standing, and a rejected person: both keep what was typed.
        await put('standing', 'b-standing', '6100003');
        await approveOld('standing', 'b-standing');
        await put('rejected', 'b-rejected', '6100004');
        await decideOld('rejected', 'rejected');
        await removeOld('b-rejected');
        // Before 0036 the removed member's profile is still held.
        expect((await pre.query(`SELECT count(*)::int AS n FROM signup_request WHERE membership_number IN ('6100001', '6100002')`)).rows[0]).toEqual({ n: 2 });
      } finally {
        await pre.end();
      }
      const ownerPre = new pgLib.Client({ connectionString: urlFor(MIGRATOR, MIGRATOR_PW, old) });
      await ownerPre.connect();
      await ownerPre.query('ANALYZE signup_request');
      await ownerPre.end();
      const second = await migrate(old);
      expect(second.code, second.stderr).toBe(0);
      const after = new pgLib.Client({ connectionString: urlFor(APP, APP_PW, old) });
      await after.connect();
      try {
        const { rows } = await after.query<Record<string, unknown>>(
          `SELECT id, first_name, last_name, membership_number, display_name, email, decision, reopened_at IS NOT NULL AS reopened, erased_at IS NULL AS not_erased FROM signup_request ORDER BY created_at, id`,
        );
        const by = (key: string) => rows.find((r) => r['id'] === ids[key]);
        const KEPT = { display_name: 'Pat Backfill', email: 'backfill@example.org', not_erased: true };
        expect(by('earlier')).toMatchObject({ ...NO_PROFILE, ...KEPT, decision: 'rejected', reopened: true });
        expect(by('gone')).toMatchObject({ ...NO_PROFILE, ...KEPT, decision: 'approved', reopened: false });
        expect(by('standing')).toMatchObject({ first_name: 'Pat', last_name: 'Backfill', membership_number: '6100003', ...KEPT });
        expect(by('rejected')).toMatchObject({ first_name: 'Pat', last_name: 'Backfill', membership_number: '6100004', ...KEPT });
        // Audited by the system, by the sign-up's id alone.
        const audited = (await after.query(`SELECT actor_kind, actor_sub, action, subject_id, from_state, to_state, note, payload FROM audit_event WHERE action = 'erase_profile' ORDER BY from_state`)).rows;
        expect(audited).toEqual([
          { actor_kind: 'system', actor_sub: null, action: 'erase_profile', subject_id: ids['gone'], from_state: 'approved', to_state: 'profile_erased', note: null, payload: {} },
          { actor_kind: 'system', actor_sub: null, action: 'erase_profile', subject_id: ids['earlier'], from_state: 'reopened', to_state: 'profile_erased', note: null, payload: {} },
        ]);
        // And the statistics no longer hold the erased numbers.
        const stats = (await after.query(`SELECT coalesce(most_common_vals::text, '') || ' ' || coalesce(histogram_bounds::text, '') AS v FROM pg_stats WHERE tablename = 'signup_request' AND attname = 'membership_number'`)).rows;
        expect(JSON.stringify(stats)).not.toMatch(/610000[12]/);
      } finally {
        await after.end();
      }
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
