// The two helpers every write uses: one transaction per call, and one audit
// row per step, carrying the trace id, the actor's groups and nothing else.
import { trace } from '@opentelemetry/api';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordAudit } from '../../src/audit/audit.js';
import type { Caller } from '../../src/auth/caller.js';
import { inTransaction } from '../../src/db/tx.js';
import { startTelemetry, type Telemetry } from '../../src/platform/telemetry.js';
import { APP, APP_PW, dropDatabase, freshDatabase, live, migrate, urlFor, testPool } from '../helpers/pg.js';

const officer: Caller = { kind: 'user', subject: 'sub-officer', groups: ['nwfl-officers', 'nwfl-office-treasurer'], scopes: [], audience: 'officers' };

describe.skipIf(!live)('inTransaction and recordAudit', () => {
  let db: string;
  let pool: pg.Pool;
  let telemetry: Telemetry;

  beforeAll(async () => {
    telemetry = startTelemetry();
    db = await freshDatabase('nwfl_txaudit');
    const run = await migrate(db);
    if (run.code !== 0) throw new Error(run.stderr);
    pool = testPool({ connectionString: urlFor(APP, APP_PW, db), max: 2 });
  });

  afterAll(async () => {
    await pool?.end();
    if (db !== undefined) await dropDatabase(db);
    await telemetry?.shutdown();
  });

  const count = async (slug: string): Promise<number> => Number((await pool.query<{ n: string }>(`SELECT count(*) AS n FROM office WHERE slug = $1`, [slug])).rows[0]?.n);

  it('commits what the callback did and returns its result', async () => {
    const id = await inTransaction(pool, async (client) => (await client.query<{ id: string }>(`INSERT INTO office (slug, title, kind) VALUES ('kept', 'K', 'elected') RETURNING id`)).rows[0]?.id);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await count('kept')).toBe(1);
  });

  it('rolls everything back when the callback throws, and rethrows', async () => {
    await expect(
      inTransaction(pool, async (client) => {
        await client.query(`INSERT INTO office (slug, title, kind) VALUES ('dropped', 'D', 'elected')`);
        throw new Error('refused');
      }),
    ).rejects.toThrow('refused');
    expect(await count('dropped')).toBe(0);
    // The pool still works: the client went back.
    expect(await inTransaction(pool, () => Promise.resolve('ok'))).toBe('ok');
    expect(await inTransaction(pool, () => Promise.resolve('ok again'))).toBe('ok again');
  });

  it('refuses a database without a pool checkout', async () => {
    await expect(inTransaction({ query: () => Promise.resolve({ rows: [] }) }, () => Promise.resolve(1))).rejects.toMatchObject({ code: 13 });
  });

  it('records one audit row with the trace id and the actor groups', async () => {
    await trace.getTracer('test').startActiveSpan('rpc', async (span) => {
      await inTransaction(pool, (client) =>
        recordAudit(client, officer, {
          action: 'save',
          subjectKind: 'content_item',
          subjectId: 'item-1',
          fromState: 'draft',
          toState: 'ready',
          note: 'a note',
          payload: { changed: ['title'] },
        }),
      );
      span.end();
      const { rows } = await pool.query(
        `SELECT trace_id, actor_kind, actor_sub, actor_groups, action, subject_kind, subject_id, from_state, to_state, note, payload FROM audit_event ORDER BY id DESC LIMIT 1`,
      );
      expect(rows[0]).toEqual({
        trace_id: span.spanContext().traceId,
        actor_kind: 'user',
        actor_sub: 'sub-officer',
        actor_groups: ['nwfl-officers', 'nwfl-office-treasurer'],
        action: 'save',
        subject_kind: 'content_item',
        subject_id: 'item-1',
        from_state: 'draft',
        to_state: 'ready',
        note: 'a note',
        payload: { changed: ['title'] },
      });
    });
  });

  it('records no trace id outside a span, and maps machine callers to their kind', async () => {
    const agent: Caller = { kind: 'agent', subject: 'svc', groups: [], scopes: [], audience: 'members' };
    await inTransaction(pool, (client) => recordAudit(client, agent, { action: 'export_read', subjectKind: 'edition', subjectId: 'e-1' }));
    const { rows } = await pool.query(`SELECT trace_id, actor_kind, payload FROM audit_event ORDER BY id DESC LIMIT 1`);
    expect(rows[0]).toEqual({ trace_id: null, actor_kind: 'agent', payload: {} });
  });
});
